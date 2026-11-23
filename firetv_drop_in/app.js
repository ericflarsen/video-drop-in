(() => {
  const params = new URLSearchParams(location.search);
  const role = location.pathname === '/tv' ? 'tv' : 'caller';
  const room = params.get('room') || document.body.dataset.room;
  const status = document.querySelector('#status');
  const showStatus = text => { status.textContent = text; };
  const caller = role === 'caller';
  document.querySelector(caller ? '#caller' : '#receiver').hidden = false;
  document.querySelector('#title').textContent = caller ? 'Video Drop In' : 'Connecting your call…';
  showStatus(caller ? 'Ready. Choose Drop in or wake the TV receiver first.' : 'Receiver is listening for your call.');

  let pc = null;
  let stream = null;
  let pollTimer = null;
  let startingCall = false;
  const pendingIce = [];
  const remote = document.querySelector('#remote');
  const preview = document.querySelector('#preview');

  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(Object.assign({room}, body))
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || ('Request failed (' + response.status + ').'));
    return data;
  }

  async function prepareTV() {
    await post('/api/prepare-tv', {});
  }

  async function send(to, message) {
    await post('/api/send', {to, message});
  }

  async function poll() {
    try {
      const peer = caller ? 'caller' : 'tv';
      const url = '/api/poll?room=' + encodeURIComponent(room) + '&peer=' + peer;
      const response = await fetch(url, {cache: 'no-store'});
      const data = await response.json();
      for (const message of data.messages || []) await handle(message);
    } catch (error) {
      showStatus('Signaling issue: ' + error.message);
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, 350);
    poll();
  }

  async function makePeer() {
    if (pc) return pc;
    pc = new RTCPeerConnection({iceServers: []});
    pc.onicecandidate = event => {
      if (event.candidate) send(caller ? 'tv' : 'caller', {type: 'ice', candidate: event.candidate}).catch(error => showStatus(error.message));
    };
    pc.onconnectionstatechange = () => showStatus('Call connection: ' + pc.connectionState);
    pc.ontrack = event => {
      if (caller) return;
      remote.srcObject = event.streams[0] || new MediaStream([event.track]);
      remote.play().then(() => showStatus('Connected. Live caller video and sound are playing on the TV.')).catch(async () => {
        try {
          await post('/api/play-tv', {});
          document.querySelector('#enableAudio').hidden = true;
          showStatus('Connected. Live caller video is playing on the TV.');
        } catch (_) {
          document.querySelector('#enableAudio').hidden = false;
          showStatus('Connected. Select Enable sound if playback is blocked.');
        }
      });
    };
    return pc;
  }

  async function handle(message) {
    if (message.type === 'offer' && !caller) {
      const peer = await makePeer();
      await peer.setRemoteDescription(message.description);
      for (const item of pendingIce.splice(0)) await peer.addIceCandidate(item);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await send('caller', {type: 'answer', description: peer.localDescription});
      showStatus('Answer sent. Connecting the call…');
    } else if (message.type === 'answer' && caller && pc) {
      await pc.setRemoteDescription(message.description);
      for (const item of pendingIce.splice(0)) await pc.addIceCandidate(item);
      showStatus('Answer received. Connecting the call…');
    } else if (message.type === 'ice') {
      if (!pc || !pc.remoteDescription) pendingIce.push(message.candidate);
      else await pc.addIceCandidate(message.candidate);
    } else if (message.type === 'hangup') {
      cleanup();
      showStatus('Call ended.');
    }
  }

  function cleanup() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (pc) pc.close();
    pc = null;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    if (remote) remote.srcObject = null;
    if (preview) { preview.srcObject = null; preview.hidden = true; }
    document.querySelector('#hangup').disabled = true;
    if (caller) {
      document.querySelector('#startCall').disabled = false;
      document.querySelector('#startVideoOnly').disabled = false;
    }
  }

  if (caller) {
    async function startCall(withAudio) {
      if (startingCall || pc) return;
      startingCall = true;
      document.querySelector('#startCall').disabled = true;
      document.querySelector('#startVideoOnly').disabled = true;
      try {
        showStatus('Waking the TV and opening its receiver…');
        await prepareTV();
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('The TV is ready. Camera and microphone need trusted HTTPS when this page is opened from a LAN address.');
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: withAudio,
          video: {width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 24, max: 30}}
        });
        preview.srcObject = stream;
        preview.hidden = false;
        const peer = await makePeer();
        stream.getTracks().forEach(track => peer.addTrack(track, stream));
        startPolling();
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await send('tv', {type: 'offer', description: peer.localDescription});
        document.querySelector('#hangup').disabled = false;
        showStatus('Call sent. Connecting to the TV…');
      } catch (error) {
        cleanup();
        showStatus(error.message);
      } finally {
        startingCall = false;
      }
    }
    document.querySelector('#startCall').addEventListener('click', () => startCall(true));
    document.querySelector('#startVideoOnly').addEventListener('click', () => startCall(false));
    document.querySelector('#wakeTv').addEventListener('click', async () => {
      const button = document.querySelector('#wakeTv');
      button.disabled = true;
      showStatus('Waking the TV and opening Silk…');
      try {
        await prepareTV();
        showStatus('The TV is awake and the Silk receiver is open.');
      } catch (error) {
        showStatus(error.message);
      } finally {
        button.disabled = false;
      }
    });
    document.querySelector('#hangup').addEventListener('click', async () => {
      try { await send('tv', {type: 'hangup'}); } catch (_) {}
      cleanup();
      showStatus('Call ended. The TV receiver remains open.');
    });
  } else {
    startPolling();
    const fullscreen = document.querySelector('#enterFullscreen');
    fullscreen.addEventListener('click', async () => {
      try { await document.documentElement.requestFullscreen(); } catch (_) {}
      fullscreen.hidden = true;
      document.body.classList.add('theater');
    });
    document.querySelector('#enableAudio').addEventListener('click', () => remote.play().catch(() => {}));
  }
  window.addEventListener('beforeunload', cleanup);
})();
