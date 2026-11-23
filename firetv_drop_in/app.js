(() => {
  const params = new URLSearchParams(location.search);
  const role = location.pathname === '/tv' ? 'tv' : location.pathname === '/mom' ? 'mom' : 'caller';
  const room = params.get('room') || document.body.dataset.room;
  const caller = role === 'caller';
  const tv = role === 'tv';
  const mom = role === 'mom';
  const status = document.querySelector('#status');
  const showStatus = text => { status.textContent = text; };

  document.querySelector(caller ? '#caller' : mom ? '#mom' : '#receiver').hidden = false;
  document.querySelector('#title').textContent = caller ? 'Video Drop In' : mom ? 'A call for Mom' : 'Connecting your call…';
  document.querySelector('#intro').textContent = caller
    ? 'Start a call with your family. Camera and microphone access begin only when you choose to call or answer.'
    : mom ? 'Use this page when family sends you a call link.'
    : 'Your family is connecting to the TV receiver.';
  showStatus(caller ? 'Ready. Choose a call action.' : mom ? 'Waiting for a family call…' : 'Receiver is listening for your call.');

  let pc = null;
  let stream = null;
  let pollTimer = null;
  let startingCall = false;
  let activeTarget = 'tv';
  let pendingOffer = null;
  let momCameraOn = true;
  let momMicOn = true;
  const pendingIce = [];
  const remote = document.querySelector('#remote');
  const preview = document.querySelector('#preview');
  const callerRemote = document.querySelector('#callerRemote');
  const momRemote = document.querySelector('#momRemote');
  const momPreview = document.querySelector('#momPreview');

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

  async function makePeer() {
    if (pc) return pc;
    pc = new RTCPeerConnection({iceServers: []});
    pc.onicecandidate = event => {
      if (event.candidate) send(caller ? activeTarget : 'caller', {type: 'ice', candidate: event.candidate}).catch(error => showStatus(error.message));
    };
    pc.onconnectionstatechange = () => {
      if (pc) showStatus('Call connection: ' + pc.connectionState);
    };
    pc.ontrack = event => {
      const target = tv ? remote : mom ? momRemote : callerRemote;
      target.srcObject = event.streams[0] || new MediaStream([event.track]);
      target.hidden = false;
      target.play().then(() => {
        if (tv) showStatus('Connected. Live caller video and sound are playing on the TV.');
        else if (mom) showStatus('Connected. You can turn your camera or microphone off at any time.');
        else showStatus('Connected. Live video and sound are playing.');
      }).catch(async () => {
        if (tv) {
          try {
            await post('/api/play-tv', {});
            document.querySelector('#enableAudio').hidden = true;
            showStatus('Connected. Live caller video is playing on the TV.');
          } catch (_) {
            document.querySelector('#enableAudio').hidden = false;
            showStatus('Connected. Select Enable sound if playback is blocked.');
          }
        } else {
          showStatus('Connected. Tap the video if sound does not start automatically.');
        }
      });
    };
    return pc;
  }

  async function handle(message) {
    if (message.type === 'offer' && mom) {
      if (pc || pendingOffer) return;
      pendingOffer = message.description;
      document.querySelector('#momIncoming').hidden = false;
      document.querySelector('#momControls').hidden = false;
      showStatus('Incoming call. Tap Answer when you are ready.');
    } else if (message.type === 'offer' && tv) {
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

  function updateMomMediaButtons() {
    const camera = document.querySelector('#momCamera');
    const microphone = document.querySelector('#momMic');
    camera.setAttribute('aria-pressed', String(momCameraOn));
    camera.textContent = momCameraOn ? 'Turn camera off' : 'Turn camera on';
    microphone.setAttribute('aria-pressed', String(momMicOn));
    microphone.textContent = momMicOn ? 'Mute microphone' : 'Unmute microphone';
  }

  async function toggleMomMedia(kind) {
    const isVideo = kind === 'video';
    const current = isVideo ? momCameraOn : momMicOn;
    const next = !current;
    const existingTrack = stream && stream.getTracks().find(track => track.kind === kind);
    if (!next) {
      if (existingTrack) existingTrack.enabled = false;
      if (isVideo) momCameraOn = false;
      else momMicOn = false;
      updateMomMediaButtons();
      return;
    }
    if (!pc) {
      if (isVideo) momCameraOn = true;
      else momMicOn = true;
      updateMomMediaButtons();
      return;
    }
    if (existingTrack) {
      existingTrack.enabled = true;
      if (isVideo) momCameraOn = true;
      else momMicOn = true;
      updateMomMediaButtons();
      return;
    }
    try {
      const captured = await navigator.mediaDevices.getUserMedia(isVideo
        ? {audio: false, video: {width: {ideal: 1280}, height: {ideal: 720}}}
        : {audio: true, video: false});
      const track = captured.getTracks()[0];
      const transceiver = pc.getTransceivers().find(item => item.receiver.track.kind === kind);
      if (!transceiver) throw new Error('This call cannot add that media track.');
      await transceiver.sender.replaceTrack(track);
      if (!stream) stream = new MediaStream();
      stream.addTrack(track);
      if (isVideo) {
        momCameraOn = true;
        momPreview.srcObject = stream;
        momPreview.hidden = false;
      } else {
        momMicOn = true;
      }
      updateMomMediaButtons();
    } catch (error) {
      showStatus('Could not turn on ' + (isVideo ? 'the camera: ' : 'the microphone: ') + error.message);
    }
  }

  function cleanup(keepIncomingCall = false) {
    if (caller && pollTimer) clearInterval(pollTimer);
    if (caller) pollTimer = null;
    if (pc) pc.close();
    pc = null;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    if (!keepIncomingCall) {
      pendingOffer = null;
      pendingIce.length = 0;
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
      document.querySelector('#startVideoOnly').disabled = false;
      document.querySelector('#callMom').disabled = false;
    }
    if (mom) {
      document.querySelector('#momIncoming').hidden = !keepIncomingCall;
      document.querySelector('#momControls').hidden = !keepIncomingCall;
      document.querySelector('#momAnswer').disabled = false;
      document.querySelector('#momAnswer').hidden = false;
      document.querySelector('#momHangup').hidden = true;
      if (!keepIncomingCall) {
        momCameraOn = true;
        momMicOn = true;
      }
      updateMomMediaButtons();
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
    async function startCall(withAudio, target) {
      if (startingCall || pc) return;
      startingCall = true;
      activeTarget = target;
      document.querySelector('#startCall').disabled = true;
      document.querySelector('#startVideoOnly').disabled = true;
      document.querySelector('#callMom').disabled = true;
      try {
        if (target === 'tv') {
          showStatus('Waking the TV and opening its receiver…');
          await prepareTV();
        } else {
          showStatus('Starting your call with Mom…');
        }
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera and microphone need a trusted HTTPS connection.');
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
        await send(target, {type: 'offer', description: peer.localDescription});
        document.querySelector('#hangup').disabled = false;
        showStatus(target === 'tv' ? 'Call sent. Connecting to the TV…' : 'Call sent. Waiting for Mom to answer…');
      } catch (error) {
        cleanup();
        showStatus(error.message);
      } finally {
        startingCall = false;
      }
    }

    document.querySelector('#startCall').addEventListener('click', () => startCall(true, 'tv'));
    document.querySelector('#startVideoOnly').addEventListener('click', () => startCall(false, 'tv'));
    document.querySelector('#callMom').addEventListener('click', () => startCall(true, 'mom'));
    document.querySelector('#shareMomLink').addEventListener('click', shareMomLink);
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
      try { await send(activeTarget, {type: 'hangup'}); } catch (_) {}
      cleanup();
      showStatus('Call ended.');
    });
  } else if (mom) {
    startPolling();
    document.querySelector('#momAnswer').addEventListener('click', async () => {
      const button = document.querySelector('#momAnswer');
      if (!pendingOffer || startingCall) return;
      startingCall = true;
      button.disabled = true;
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera and microphone need a trusted HTTPS connection.');
        }
        showStatus('Preparing your answer. Allow the camera and microphone you selected.');
        stream = momCameraOn || momMicOn
          ? await navigator.mediaDevices.getUserMedia({
              audio: momMicOn,
              video: momCameraOn ? {width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 24, max: 30}} : false
            })
          : new MediaStream();
        if (stream.getVideoTracks().length) {
          momPreview.srcObject = stream;
          momPreview.hidden = false;
        }
        const peer = await makePeer();
        await peer.setRemoteDescription(pendingOffer);
        for (const transceiver of peer.getTransceivers()) {
          if (transceiver.receiver.track.kind === 'audio' || transceiver.receiver.track.kind === 'video') {
            transceiver.direction = 'sendrecv';
          }
        }
        for (const item of pendingIce.splice(0)) await peer.addIceCandidate(item);
        for (const transceiver of peer.getTransceivers()) {
          const track = stream.getTracks().find(item => item.kind === transceiver.receiver.track.kind);
          if (track) await transceiver.sender.replaceTrack(track);
        }
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await send('caller', {type: 'answer', description: peer.localDescription});
        document.querySelector('#momIncoming').hidden = true;
        document.querySelector('#momControls').hidden = false;
        document.querySelector('#momAnswer').hidden = true;
        document.querySelector('#momHangup').hidden = false;
        document.querySelector('#momHangup').disabled = false;
        showStatus('Connecting. Use the large buttons to control your camera and microphone.');
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
      try { await send('caller', {type: 'hangup'}); } catch (_) {}
      cleanup();
      showStatus('Call ended. This page is ready for another call.');
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
