(() => {
  const params = new URLSearchParams(location.search);
  const role = location.pathname === '/tv' ? 'tv' : location.pathname === '/mom' ? 'mom' : 'caller';
  const room = params.get('room') || document.body.dataset.room;
  const caller = role === 'caller';
  const tv = role === 'tv';
  const mom = role === 'mom';
  const peerConfig = {iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};
  const status = document.querySelector('#status');
  const showStatus = text => { status.textContent = text; };

  document.querySelector(caller ? '#caller' : mom ? '#mom' : '#receiver').hidden = false;
  document.querySelector('#title').textContent = caller ? 'Video Drop In' : mom ? 'A call for Mom' : 'Connecting your call…';
  document.querySelector('#intro').textContent = caller
    ? 'Call the TV. Mom can join from her phone page.'
    : mom ? ''
    : 'Your family is connecting to the TV receiver.';
  if (mom) document.querySelector('#intro').hidden = true;
  showStatus(caller ? 'Ready' : mom ? 'Ready' : 'Receiver is listening for your call.');

  let pc = null;
  let momPc = null;
  let stream = null;
  let pollTimer = null;
  let startingCall = false;
  let connectingMom = false;
  let momJoinPending = false;
  let activeTarget = 'tv';
  let pendingOffer = null;
  let momReady = false;
  let momCameraOn = false;
  let momMicOn = false;
  const pendingIce = [];
  const pendingMomIce = [];
  const remote = document.querySelector('#remote');
  const preview = document.querySelector('#preview');
  const callerRemote = document.querySelector('#callerRemote');
  const momRemote = document.querySelector('#momRemote');
  const momPreview = document.querySelector('#momPreview');

  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
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
      const response = await fetch('/api/poll?room=' + encodeURIComponent(room) + '&peer=' + role, {cache: 'no-store'});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || ('Request failed (' + response.status + ').'));
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

  async function makePeer(channel = 'tv') {
    let connection = caller && channel === 'mom' ? momPc : pc;
    if (connection) return connection;
    connection = new RTCPeerConnection(peerConfig);
    if (caller && channel === 'mom') momPc = connection;
    else pc = connection;

    connection.onicecandidate = event => {
      if (event.candidate) {
        send(caller ? channel : 'caller', {type: 'ice', channel, candidate: event.candidate})
          .catch(error => showStatus(error.message));
      }
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed') showStatus('Call connection failed.');
    };
    connection.ontrack = event => {
      const target = tv ? remote : mom ? momRemote : callerRemote;
      if (event.streams[0]) {
        target.srcObject = event.streams[0];
      } else {
        const targetStream = target.srcObject || new MediaStream();
        if (!targetStream.getTracks().includes(event.track)) targetStream.addTrack(event.track);
        target.srcObject = targetStream;
      }
      target.hidden = false;
      target.play().then(() => {
        if (tv) showStatus('Connected on the TV');
        else if (mom) showStatus('Connected');
        else if (channel === 'mom') showStatus('Mom is connected');
      }).catch(async () => {
        if (tv) {
          try {
            await post('/api/play-tv', {});
            document.querySelector('#enableAudio').hidden = true;
            showStatus('Connected on the TV');
          } catch (_) {
            document.querySelector('#enableAudio').hidden = false;
            showStatus('Tap Enable sound on the TV.');
          }
        } else {
          showStatus('Connected');
        }
      });
    };
    return connection;
  }

  async function handle(message) {
    if (message.type === 'join' && caller) {
      await connectMomToCall();
    } else if (message.type === 'ready' && mom) {
      momReady = true;
      document.querySelector('#momIncoming').hidden = false;
      document.querySelector('#momActions').hidden = false;
      document.querySelector('#momAnswer').hidden = false;
      showStatus('Incoming call');
    } else if (message.type === 'offer' && caller && message.channel === 'mom') {
      const peer = momPc || await makePeer('mom');
      await peer.setRemoteDescription(message.description);
      for (const item of pendingMomIce.splice(0)) await peer.addIceCandidate(item);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await send('mom', {type: 'answer', channel: 'mom', description: peer.localDescription});
      showStatus('Mom is connecting');
    } else if (message.type === 'offer' && tv) {
      const channel = message.channel || 'tv';
      const peer = await makePeer(channel);
      await peer.setRemoteDescription(message.description);
      for (const item of pendingIce.splice(0)) await peer.addIceCandidate(item);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await send('caller', {type: 'answer', channel, description: peer.localDescription});
      showStatus('Connecting…');
    } else if (message.type === 'answer' && caller) {
      const channel = message.channel || 'tv';
      const peer = channel === 'mom' ? momPc : pc;
      const candidates = channel === 'mom' ? pendingMomIce : pendingIce;
      if (!peer) return;
      await peer.setRemoteDescription(message.description);
      for (const item of candidates.splice(0)) await peer.addIceCandidate(item);
      showStatus(channel === 'mom' ? 'Mom is connected' : 'Connected on the TV');
    } else if (message.type === 'answer' && mom && pc) {
      await pc.setRemoteDescription(message.description);
      for (const item of pendingIce.splice(0)) await pc.addIceCandidate(item);
      showStatus('Connected');
    } else if (message.type === 'ice') {
      const channel = message.channel || (tv ? 'tv' : mom ? 'mom' : 'tv');
      const peer = caller ? (channel === 'mom' ? momPc : pc) : pc;
      const candidates = caller && channel === 'mom' ? pendingMomIce : pendingIce;
      if (!peer || !peer.remoteDescription) candidates.push(message.candidate);
      else await peer.addIceCandidate(message.candidate);
    } else if (message.type === 'hangup' && caller && message.channel === 'mom') {
      if (momPc) momPc.close();
      momPc = null;
      pendingMomIce.length = 0;
      showStatus('Mom left the call');
    } else if (message.type === 'hangup') {
      cleanup();
      showStatus('Call ended.');
    }
  }

  function updateMomMediaButtons() {
    const camera = document.querySelector('#momCamera');
    const microphone = document.querySelector('#momMic');
    camera.setAttribute('aria-pressed', String(momCameraOn));
    camera.textContent = momCameraOn ? 'Turn camera off' : 'Turn camera on';
    microphone.setAttribute('aria-pressed', String(momMicOn));
    microphone.textContent = momMicOn ? 'Mute mic' : 'Turn mic on';
  }

  async function acquireMomTrack(kind) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera and microphone need HTTPS.');
    }
    const isVideo = kind === 'video';
    const captured = await navigator.mediaDevices.getUserMedia(isVideo
      ? {audio: false, video: {width: {ideal: 1280}, height: {ideal: 720}}}
      : {audio: true, video: false});
    const track = captured.getTracks()[0];
    if (!stream) stream = new MediaStream();
    stream.addTrack(track);
    if (isVideo) {
      momPreview.srcObject = stream;
      momPreview.hidden = false;
    }
    if (pc) {
      const transceiver = pc.getTransceivers().find(item => item.receiver.track.kind === kind);
      if (!transceiver) throw new Error('This call cannot add that media track.');
      await transceiver.sender.replaceTrack(track);
    }
    return track;
  }

  async function toggleMomMedia(kind) {
    const isVideo = kind === 'video';
    const next = !(isVideo ? momCameraOn : momMicOn);
    const existingTrack = stream && stream.getTracks().find(track => track.kind === kind);
    if (!next) {
      if (existingTrack) existingTrack.enabled = false;
      if (isVideo) {
        momCameraOn = false;
        momPreview.hidden = true;
      } else {
        momMicOn = false;
      }
      updateMomMediaButtons();
      return;
    }
    try {
      const track = existingTrack || await acquireMomTrack(kind);
      track.enabled = true;
      if (isVideo) {
        momCameraOn = true;
        momPreview.srcObject = stream;
        momPreview.hidden = false;
      } else {
        momMicOn = true;
      }
      updateMomMediaButtons();
    } catch (error) {
      showStatus(error.name === 'NotAllowedError'
        ? 'Allow camera or microphone access in your iPhone settings.'
        : error.message);
    }
  }

  function cleanup(keepIncomingCall = false) {
    if (caller && pollTimer) clearInterval(pollTimer);
    if (caller) pollTimer = null;
    if (pc) pc.close();
    if (momPc) momPc.close();
    pc = null;
    momPc = null;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    connectingMom = false;
    momJoinPending = false;
    if (!keepIncomingCall) {
      pendingOffer = null;
      pendingIce.length = 0;
      pendingMomIce.length = 0;
    }
    for (const video of [remote, preview, callerRemote, momRemote, momPreview]) {
      if (video) {
        video.srcObject = null;
        if (video !== remote) video.hidden = true;
      }
    }
    document.querySelector('#hangup').disabled = true;
    if (caller) {
      document.querySelector('#startCall').disabled = false;
    }
    if (mom) {
      document.querySelector('#momIncoming').hidden = !keepIncomingCall;
      document.querySelector('#momActions').hidden = !keepIncomingCall;
      document.querySelector('#momAnswer').disabled = false;
      document.querySelector('#momAnswer').hidden = false;
      document.querySelector('#momHangup').hidden = true;
      if (!keepIncomingCall) {
        momReady = false;
        momCameraOn = false;
        momMicOn = false;
      }
      updateMomMediaButtons();
    }
  }

  async function connectMomToCall() {
    if (activeTarget !== 'tv') return;
    if (startingCall || !pc) {
      momJoinPending = true;
      return;
    }
    if (connectingMom) return;
    connectingMom = true;
    momJoinPending = false;
    try {
      if (momPc) momPc.close();
      momPc = null;
      pendingMomIce.length = 0;
      const peer = await makePeer('mom');
      peer.addTransceiver('audio', {direction: 'recvonly'});
      peer.addTransceiver('video', {direction: 'recvonly'});
      await send('mom', {type: 'ready', channel: 'mom'});
      showStatus('Mom can join from her phone page');
    } catch (error) {
      showStatus('Could not connect Mom’s page: ' + error.message);
    } finally {
      connectingMom = false;
      if (momJoinPending) connectMomToCall();
    }
  }

  async function shareMomLink() {
    if (location.protocol !== 'https:') {
      showStatus('Open the public HTTPS page before sharing Mom’s call link.');
      return;
    }
    const url = new URL('/mom', location.href).href;
    try {
      if (navigator.share) {
        await navigator.share({title: 'Video call', text: 'Tap here to join a video call with me.', url});
        showStatus('Call link shared.');
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        showStatus('Mom’s call link copied. Paste it into a text message.');
      } else {
        window.prompt('Copy this call link and text it to Mom:', url);
      }
    } catch (error) {
      if (error.name !== 'AbortError') showStatus('Could not share the link: ' + error.message);
    }
  }

  if (caller) {
    async function startCall() {
      if (startingCall || pc) return;
      startingCall = true;
      activeTarget = 'tv';
      document.querySelector('#startCall').disabled = true;
      try {
        showStatus('Waking the TV…');
        await prepareTV();
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera and microphone need a trusted HTTPS connection.');
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 24, max: 30}}
        });
        preview.srcObject = stream;
        preview.hidden = false;
        const peer = await makePeer('tv');
        stream.getTracks().forEach(track => peer.addTrack(track, stream));
        startPolling();
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await send('tv', {type: 'offer', channel: 'tv', description: peer.localDescription});
        document.querySelector('#hangup').disabled = false;
        showStatus('Calling the TV');
      } catch (error) {
        cleanup();
        showStatus(error.message);
      } finally {
        startingCall = false;
        if (momJoinPending) connectMomToCall();
      }
    }

    document.querySelector('#startCall').addEventListener('click', () => startCall(true));
    document.querySelector('#shareMomLink').addEventListener('click', shareMomLink);
    document.querySelector('#hangup').addEventListener('click', async () => {
      try { await send('tv', {type: 'hangup', channel: 'tv'}); } catch (_) {}
      if (momPc) {
        try { await send('mom', {type: 'hangup', channel: 'mom'}); } catch (_) {}
      }
      cleanup();
      showStatus('Call ended.');
    });
  } else if (mom) {
    send('caller', {type: 'join'}).then(startPolling).catch(startPolling);
    document.querySelector('#momAnswer').addEventListener('click', async () => {
      const button = document.querySelector('#momAnswer');
      if (!momReady || startingCall) return;
      startingCall = true;
      button.disabled = true;
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera and microphone need a trusted HTTPS connection.');
        }
        showStatus('Connecting…');
        if (momCameraOn && !(stream && stream.getVideoTracks().length)) await acquireMomTrack('video');
        if (momMicOn && !(stream && stream.getAudioTracks().length)) await acquireMomTrack('audio');
        if (!stream) stream = new MediaStream();
        const peer = await makePeer('mom');
        for (const kind of ['audio', 'video']) {
          const transceiver = peer.addTransceiver(kind, {direction: 'sendonly'});
          const track = stream.getTracks().find(item => item.kind === kind);
          if (track) await transceiver.sender.replaceTrack(track);
        }
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await send('caller', {type: 'offer', channel: 'mom', description: peer.localDescription});
        document.querySelector('#momIncoming').hidden = true;
        document.querySelector('#momActions').hidden = false;
        document.querySelector('#momAnswer').hidden = true;
        document.querySelector('#momHangup').hidden = false;
        document.querySelector('#momHangup').disabled = false;
        showStatus('Connecting…');
      } catch (error) {
        cleanup(true);
        showStatus(error.message);
      } finally {
        startingCall = false;
        button.disabled = false;
      }
    });

    document.querySelector('#momCamera').addEventListener('click', () => toggleMomMedia('video'));
    document.querySelector('#momMic').addEventListener('click', () => toggleMomMedia('audio'));
    document.querySelector('#momHangup').addEventListener('click', async () => {
      try { await send('caller', {type: 'hangup', channel: 'mom'}); } catch (_) {}
      cleanup();
      showStatus('Call ended.');
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

  window.addEventListener('beforeunload', () => {
    cleanup();
    if (pollTimer) clearInterval(pollTimer);
  });
})();
