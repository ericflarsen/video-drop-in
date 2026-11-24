(() => {
  const view = document.body.dataset.view;
  const titleEl = document.querySelector('#title');
  const introEl = document.querySelector('#intro');
  const statusEl = document.querySelector('#status');
  const showStatus = text => { statusEl.textContent = text; };
  const readCookie = name => {
    const match = document.cookie.split('; ').find(item => item.startsWith(name + '='));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
  };

  // ---------- Screens that are not part of a call ----------
  const NOTICES = {
    setup: ['Almost ready', 'Set a family passphrase in the Video Drop In app settings in Home Assistant, then reload this page.'],
    nolink: ['This link isn’t working', 'Ask your family for your call link, then paste it here.']
  };
  if (NOTICES[view]) {
    document.body.classList.add(view === 'nolink' ? 'mom' : 'caller');
    [titleEl.textContent, introEl.textContent] = NOTICES[view];
    showStatus('');
    if (view === 'nolink') {
      // Works inside the Home Screen app too, which has no address bar.
      const form = document.querySelector('#linkForm');
      form.hidden = false;
      form.addEventListener('submit', event => {
        event.preventDefault();
        const text = form.link.value.trim();
        const match = text.match(/\/mom\/([A-Za-z0-9_-]+)/) || text.match(/^([A-Za-z0-9_-]{16,})$/);
        if (!match) return showStatus('That doesn’t look like a call link. Paste the whole link.');
        location.href = '/mom/' + match[1];
      });
    }
    return;
  }
  if (view === 'login') {
    document.body.classList.add('caller');
    document.querySelector('#login').hidden = false;
    titleEl.textContent = 'Call Mom';
    introEl.textContent = 'Sign in with the family passphrase.';
    showStatus('');
    const form = document.querySelector('#loginForm');
    const submit = document.querySelector('#loginSubmit');
    document.querySelector('#loginName').value = readCookie('vdi_name');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      showStatus('Checking…');
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({name: form.name.value, passphrase: form.passphrase.value})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Sign-in failed.');
        location.reload();
      } catch (error) {
        showStatus(error.message);
        form.passphrase.value = '';
        submit.disabled = false;
      }
    });
    return;
  }

  // ---------- Shared call plumbing ----------
  const role = view === 'tv' ? 'tv' : view === 'mom' ? 'mom' : 'caller';
  const caller = role === 'caller';
  const tv = role === 'tv';
  const mom = role === 'mom';
  const room = document.body.dataset.room || '';
  const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''));
  const myId = tv ? 'tv' : randomId();  // each Mom page has its own id too
  const ICE = {iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};
  const MAX_CALLERS = 4;

  document.querySelector(caller ? '#caller' : mom ? '#mom' : '#receiver').hidden = false;
  document.body.classList.add(role);

  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(Object.assign({room, peer: role, id: myId}, body))
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || ('Request failed (' + response.status + ').'));
      error.data = data;
      throw error;
    }
    return data;
  }
  async function getJSON(path) {
    const response = await fetch(path, {cache: 'no-store'});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || ('Request failed (' + response.status + ').'));
    return data;
  }
  const send = (to, message) => post('/api/send', {to, message});

  function joinNames(names) {
    if (names.length <= 1) return names[0] || 'Your family';
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  // One RTCPeerConnection per other page, keyed by page id ('tv', 'mom', or a caller's id).
  const peers = new Map();
  function newPeer(key, name, onTrack) {
    closePeer(key);
    const pc = new RTCPeerConnection(ICE);
    const entry = {key, name, pc, pending: [], stream: new MediaStream()};
    pc.onicecandidate = event => {
      if (event.candidate) send(key, {type: 'ice', candidate: event.candidate}).catch(() => {});
    };
    pc.ontrack = event => {
      if (!entry.stream.getTracks().includes(event.track)) entry.stream.addTrack(event.track);
      if (onTrack) onTrack(entry);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') showStatus('Could not connect to ' + (name || 'someone') + '.');
    };
    peers.set(key, entry);
    return entry;
  }
  function closePeer(key) {
    const entry = peers.get(key);
    if (!entry) return;
    try { entry.pc.close(); } catch (_) {}
    peers.delete(key);
    removeTile(key);
  }
  function closeAllPeers() {
    for (const key of Array.from(peers.keys())) closePeer(key);
  }
  async function addIce(key, candidate) {
    const entry = peers.get(key);
    if (!entry) return;
    if (!entry.pc.remoteDescription) entry.pending.push(candidate);
    else await entry.pc.addIceCandidate(candidate).catch(() => {});
  }
  async function flushIce(entry) {
    for (const candidate of entry.pending.splice(0)) await entry.pc.addIceCandidate(candidate).catch(() => {});
  }

  let pollTimer = null;
  let pollBusy = false;
  async function poll() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const data = await getJSON('/api/poll?room=' + encodeURIComponent(room) + '&peer=' + role + '&id=' + encodeURIComponent(myId));
      if (data.gone) return onGone();
      for (const message of data.messages || []) {
        try { await handle(message); } catch (error) { console.warn('message', message.type, error); }
      }
    } catch (error) {
      showStatus(mom ? 'Trying to reconnect…' : 'Connection issue: ' + error.message);
    } finally {
      pollBusy = false;
    }
  }
  // Each check schedules the next, so a page can slow down when nothing is happening.
  // Family and TV pages always check every 0.4 s; Mom's page sets its own pace below.
  let polling = false;
  let pollDelay = () => 400;
  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = polling ? setTimeout(runPoll, delay) : null;
  }
  async function runPoll() {
    await poll();
    schedulePoll(pollDelay());
  }
  function startPolling() {
    if (polling) return;
    polling = true;
    runPoll();
  }
  function stopPolling() {
    polling = false;
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  function pollNow() {
    if (!polling) return;
    clearTimeout(pollTimer);
    runPoll();
  }

  // ---------- Video tiles (family page and TV) ----------
  const tilesEl = document.querySelector(tv ? '#tvTiles' : '#tiles');
  function tileFor(key, name) {
    let tile = tilesEl && tilesEl.querySelector('[data-key="' + CSS.escape(key) + '"]');
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.key = key;
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      const label = document.createElement('span');
      label.className = 'tile-name';
      const off = document.createElement('span');
      off.className = 'tile-off';
      off.textContent = 'Camera off';
      tile.append(video, off, label);
      tilesEl.append(tile);
    }
    tile.querySelector('.tile-name').textContent = name || '';
    return tile;
  }
  function removeTile(key) {
    const tile = tilesEl && tilesEl.querySelector('[data-key="' + CSS.escape(key) + '"]');
    if (tile) {
      tile.querySelector('video').srcObject = null;
      tile.remove();
    }
    layout();
  }
  function showStream(entry, onBlocked) {
    const tile = tileFor(entry.key, entry.name);
    const video = tile.querySelector('video');
    if (video.srcObject !== entry.stream) video.srcObject = entry.stream;
    video.play().catch(() => onBlocked && onBlocked());
    layout();
  }
  function layout() {
    if (!tilesEl) return;
    const tiles = Array.from(tilesEl.children);
    const count = tiles.length;
    tilesEl.dataset.count = String(count);
    if (tv) {
      // 1-3 side by side, 4 as 2x2, 5-6 as 3x2.
      const cols = count <= 3 ? Math.max(count, 1) : Math.ceil(count / 2);
      tilesEl.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
      tilesEl.style.gridTemplateRows = count <= 3 ? '1fr' : 'repeat(2, minmax(0, 1fr))';
      return;
    }
    // Family page: Mom's tile is largest while her camera is on.
    const momTile = tilesEl.querySelector('[data-key="mom"]');
    const momBig = Boolean(momTile && momVideoOn);
    if (momTile) momTile.classList.toggle('camera-off', !momVideoOn);
    tiles.forEach(tile => { tile.style.gridColumn = ''; tile.style.gridRow = ''; });
    if (momBig && count > 1) {
      const others = count - 1;
      tilesEl.style.gridTemplateColumns = 'repeat(' + others + ', minmax(0, 1fr))';
      tilesEl.style.gridTemplateRows = '3fr 1fr';
      momTile.style.gridColumn = '1 / -1';
      momTile.style.gridRow = '1';
    } else {
      const cols = count <= 2 ? Math.max(count, 1) : 2;
      tilesEl.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
      tilesEl.style.gridTemplateRows = count <= 2 ? '1fr' : 'repeat(2, minmax(0, 1fr))';
    }
    document.querySelector('#caller .stage').classList.toggle('has-tiles', count > 0);
  }
  let momVideoOn = false;

  // ---------- Draggable self-view (family page) ----------
  const preview = document.querySelector('#preview');
  const previewPanel = document.querySelector('#previewPanel');
  function setupPreviewPanel(panel, video) {
    if (!panel || !video) return;
    const handle = panel.querySelector('.preview-bar');
    const button = panel.querySelector('.preview-minimize');
    let drag = null;
    button.addEventListener('click', () => {
      const minimized = panel.classList.toggle('minimized');
      video.hidden = minimized;
      button.textContent = minimized ? '+' : '−';
      button.setAttribute('aria-label', minimized ? 'Show your camera' : 'Hide your camera');
    });
    handle.addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = {x: event.clientX, y: event.clientY, left: rect.left, top: rect.top};
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.right = 'auto';
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!drag) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = Math.max(0, Math.min(window.innerWidth - rect.width, drag.left + event.clientX - drag.x)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - rect.height, drag.top + event.clientY - drag.y)) + 'px';
    });
    const stop = event => {
      drag = null;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  // =====================================================================
  // Family caller page
  // =====================================================================
  let handle = async () => {};
  let onGone = () => {};

  if (caller) {
    setupPreviewPanel(previewPanel, preview);
    const startBtn = document.querySelector('#startCall');
    const startLabel = startBtn.querySelector('.label');
    const hangupBtn = document.querySelector('#hangup');
    const tvHint = document.querySelector('#tvHint');
    const nameEl = document.querySelector('#callerName');
    let stream = null;
    let inCall = false;
    let busy = false;
    let roster = [];
    let callState = {active: false, callers: []};
    let statePoll = null;

    nameEl.textContent = readCookie('vdi_name') || 'family';
    document.querySelector('#changeName').addEventListener('click', async () => {
      const name = window.prompt('Your name, so Mom knows who’s calling:', readCookie('vdi_name'));
      if (name === null) return;
      try {
        await post('/api/name', {name});
        nameEl.textContent = readCookie('vdi_name') || 'family';
      } catch (error) {
        showStatus(error.message);
      }
    });

    const others = () => roster.filter(item => item.id !== myId);
    function renderIdle() {
      if (inCall) return;
      const names = callState.callers.map(item => item.name);
      const full = callState.callers.length >= MAX_CALLERS;
      if (callState.active && names.length) {
        titleEl.textContent = joinNames(names) + (names.length > 1 ? ' are' : ' is') + ' on a call with Mom';
        startLabel.textContent = full ? 'The call is full' : 'Join the call';
        startBtn.disabled = full || busy;
        tvHint.hidden = true;
        showStatus(full ? 'Up to ' + MAX_CALLERS + ' family members can be on a call.' : 'Joining won’t wake the TV again.');
      } else {
        titleEl.textContent = 'Call Mom';
        startLabel.textContent = 'Call Mom on the TV';
        startBtn.disabled = busy;
        tvHint.hidden = false;
        showStatus('Ready to call.');
      }
    }
    async function refreshState() {
      try {
        callState = await getJSON('/api/state');
        renderIdle();
      } catch (_) {}
    }
    function watchState(on) {
      clearInterval(statePoll);
      statePoll = on ? setInterval(refreshState, 2500) : null;
      if (on) refreshState();
    }
    function renderInCall() {
      const names = others().map(item => item.name);
      const momOn = peers.has('mom');
      titleEl.textContent = 'On the call';
      const parts = [];
      if (momOn) parts.push('Mom');
      parts.push(...names);
      showStatus(parts.length ? 'With ' + joinNames(parts) + '.' + (momOn ? '' : ' Mom can answer from her phone.') : 'You’re on Mom’s TV. Waiting for Mom to answer on her phone.');
    }

    // Lower each video as the call grows so phones and the Fire TV keep up.
    function applyQuality() {
      const n = Math.max(1, roster.length);
      const [scale, bitrate] = n === 1 ? [1, 1500000] : n <= 3 ? [1.5, 900000] : [2, 600000];
      for (const entry of peers.values()) {
        for (const sender of entry.pc.getSenders()) {
          if (!sender.track || sender.track.kind !== 'video') continue;
          const params = sender.getParameters();
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          params.encodings[0].scaleResolutionDownBy = scale;
          params.encodings[0].maxBitrate = bitrate;
          sender.setParameters(params).catch(() => {});
        }
      }
    }

    function showRemote(entry) { showStream(entry); }

    async function offerTo(key, name) {
      const entry = newPeer(key, name, key === 'tv' ? null : showRemote);
      stream.getTracks().forEach(track => entry.pc.addTrack(track, stream));
      await entry.pc.setLocalDescription(await entry.pc.createOffer());
      await send(key, {type: 'offer', description: entry.pc.localDescription});
    }

    async function requestStart() {
      try {
        return await post('/api/start', {});
      } catch (error) {
        if (!(error.data && error.data.quiet)) throw error;
        if (!window.confirm(error.message + ' Wake the TV anyway?')) throw new Error('Call not started. It’s quiet hours.');
        return post('/api/start', {urgent: true});
      }
    }

    async function enterCall() {
      if (busy || inCall) return;
      const joining = callState.active && callState.callers.length > 0;
      if (!joining && !window.confirm('This turns on Mom’s TV. Call now?')) return;
      busy = true;
      startBtn.disabled = true;
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera and microphone need a trusted HTTPS connection.');
        }
        showStatus('Turning on your camera…');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 24, max: 30}}
        });
        preview.srcObject = stream;
        preview.hidden = previewPanel.classList.contains('minimized');
        previewPanel.hidden = false;
        showStatus(joining ? 'Joining…' : 'Waking the TV…');
        const result = joining ? await post('/api/join', {}) : await requestStart();
        roster = result.callers;
        inCall = true;
        watchState(false);
        document.body.classList.add('in-call');
        startPolling();
        await offerTo('tv', 'TV');
        for (const other of others()) await offerTo(other.id, other.name);
        applyQuality();
        renderInCall();
      } catch (error) {
        await leaveLocal();
        showStatus(error.message);
      } finally {
        busy = false;
        if (!inCall) renderIdle();
      }
    }

    async function leaveLocal() {
      inCall = false;
      stopPolling();
      closeAllPeers();
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = null;
      roster = [];
      momVideoOn = false;
      preview.srcObject = null;
      previewPanel.hidden = true;
      document.body.classList.remove('in-call');
      layout();
      watchState(true);
    }

    onGone = async () => {
      await leaveLocal();
      showStatus('You were disconnected from the call.');
    };

    handle = async message => {
      const from = message.from;
      if (message.type === 'roster') {
        roster = message.callers;
        const ids = new Set(roster.map(item => item.id));
        for (const key of Array.from(peers.keys())) {
          if (key !== 'tv' && key !== 'mom' && !ids.has(key)) closePeer(key);
        }
        for (const item of roster) {
          const entry = peers.get(item.id);
          if (entry) { entry.name = item.name; tileFor(item.id, item.name); }
        }
        applyQuality();
        renderInCall();
      } else if (message.type === 'offer' && from === 'mom') {
        const entry = newPeer('mom', 'Mom', showRemote);
        await entry.pc.setRemoteDescription(message.description);
        await flushIce(entry);
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        await send('mom', {type: 'answer', description: entry.pc.localDescription});
        tileFor('mom', 'Mom');
        layout();
        renderInCall();
      } else if (message.type === 'offer') {
        // A newer caller is connecting to us.
        const entry = newPeer(from, message.fromName, showRemote);
        stream.getTracks().forEach(track => entry.pc.addTrack(track, stream));
        await entry.pc.setRemoteDescription(message.description);
        await flushIce(entry);
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        await send(from, {type: 'answer', description: entry.pc.localDescription});
        applyQuality();
      } else if (message.type === 'answer') {
        const entry = peers.get(from);
        if (!entry) return;
        await entry.pc.setRemoteDescription(message.description);
        await flushIce(entry);
      } else if (message.type === 'ice') {
        await addIce(from, message.candidate);
      } else if (message.type === 'media' && from === 'mom') {
        momVideoOn = Boolean(message.video);
        layout();
      } else if (message.type === 'left') {
        closePeer(from);
        renderInCall();
      } else if (message.type === 'hangup' && from === 'mom') {
        closePeer('mom');
        momVideoOn = false;
        layout();
        renderInCall();
      }
    };

    startBtn.addEventListener('click', enterCall);
    hangupBtn.addEventListener('click', async () => {
      try { await post('/api/leave', {}); } catch (_) {}
      await leaveLocal();
      showStatus('You left the call.');
    });
    window.addEventListener('pagehide', () => {
      if (inCall) navigator.sendBeacon('/api/leave', new Blob([JSON.stringify({room, peer: role, id: myId})], {type: 'application/json'}));
    });
    layout();
    watchState(true);
  }

  // =====================================================================
  // Mom's phone page
  // =====================================================================
  if (mom) {
    const momPreview = document.querySelector('#momPreview');
    const answerBtn = document.querySelector('#momAnswer');
    const hangupBtn = document.querySelector('#momHangup');
    const actions = document.querySelector('#momActions');
    let stream = null;
    let cameraOn = false;
    let micOn = false;
    let answered = false;
    let roster = [];

    let alertsOn = false;
    const STATES = {
      waiting: ['No call right now', 'Keep this page open. When your family calls, a green Answer button appears here.'],
      waitingAlerts: ['No call right now', 'Your phone will ring when your family calls. Tap the alert to answer.'],
      incoming: ['Your family is calling', 'They are on your TV. Turn on your camera and microphone if you like, then tap Answer.'],
      incall: ['You’re on the call', 'Your family can see and hear you while your camera and microphone are on.']
    };
    function setState(state) {
      document.body.dataset.momState = state;
      [titleEl.textContent, introEl.textContent] = STATES[state === 'waiting' && alertsOn ? 'waitingAlerts' : state];
      const names = joinNames(roster.map(item => item.name));
      if (state === 'incoming' && roster.length) titleEl.textContent = names + (roster.length > 1 ? ' are' : ' is') + ' calling';
      if (state === 'incall' && roster.length) titleEl.textContent = 'You’re talking with ' + names;
      actions.hidden = state === 'waiting';
      answerBtn.hidden = state !== 'incoming';
      hangupBtn.hidden = state !== 'incall';
    }

    function updateSwitches() {
      for (const [id, on] of [['#momCamera', cameraOn], ['#momMic', micOn]]) {
        const button = document.querySelector(id);
        button.setAttribute('aria-pressed', String(on));
        button.querySelector('.switch-state').textContent = on ? 'On' : 'Off';
      }
    }
    function broadcastMedia() {
      for (const key of peers.keys()) send(key, {type: 'media', video: cameraOn, audio: micOn}).catch(() => {});
    }
    async function setTrackEverywhere(kind, track) {
      for (const entry of peers.values()) {
        const transceiver = entry.transceivers && entry.transceivers[kind];
        if (transceiver) await transceiver.sender.replaceTrack(track).catch(() => {});
      }
    }
    async function turnOn(kind) {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone need HTTPS.');
      const isVideo = kind === 'video';
      const captured = await navigator.mediaDevices.getUserMedia(isVideo
        ? {audio: false, video: {width: {ideal: 1280}, height: {ideal: 720}}}
        : {audio: {echoCancellation: {ideal: true}, noiseSuppression: {ideal: true}, autoGainControl: {ideal: true}}, video: false});
      const track = captured.getTracks()[0];
      if (!stream) stream = new MediaStream();
      stream.addTrack(track);
      if (isVideo) {
        momPreview.srcObject = stream;
        momPreview.hidden = false;
      }
      await setTrackEverywhere(kind, track);
    }
    async function turnOff(kind) {
      await setTrackEverywhere(kind, null);
      const track = stream && stream.getTracks().find(item => item.kind === kind);
      if (track) { stream.removeTrack(track); track.stop(); }
      if (kind === 'video') {
        momPreview.srcObject = null;
        momPreview.hidden = true;
      }
    }
    async function toggle(kind) {
      const isVideo = kind === 'video';
      const next = !(isVideo ? cameraOn : micOn);
      try {
        if (next) await turnOn(kind); else await turnOff(kind);
        if (isVideo) cameraOn = next; else micOn = next;
        updateSwitches();
        broadcastMedia();
      } catch (error) {
        showStatus(error.name === 'NotAllowedError' ? 'Allow camera or microphone access in your browser settings.' : error.message);
      }
    }

    async function offerTo(item) {
      const entry = newPeer(item.id, item.name, null);
      entry.transceivers = {};
      for (const kind of ['audio', 'video']) {
        const transceiver = entry.pc.addTransceiver(kind, {direction: 'sendonly'});
        const track = stream && stream.getTracks().find(t => t.kind === kind);
        if (track) await transceiver.sender.replaceTrack(track);
        entry.transceivers[kind] = transceiver;
      }
      await entry.pc.setLocalDescription(await entry.pc.createOffer());
      await send(item.id, {type: 'offer', description: entry.pc.localDescription});
      await send(item.id, {type: 'media', video: cameraOn, audio: micOn});
    }

    function endCall(text) {
      closeAllPeers();
      answered = false;
      showStatus(text || '');
    }

    async function applyRoster(list) {
      roster = list;
      if (roster.length && document.visibilityState === 'visible') clearCallAlerts();
      if (!roster.length) {
        if (answered) endCall('Call ended.');
        setState('waiting');
        return;
      }
      if (!answered) return setState('incoming');
      const ids = new Set(roster.map(item => item.id));
      for (const key of Array.from(peers.keys())) if (!ids.has(key)) closePeer(key);
      for (const item of roster) if (!peers.has(item.id)) await offerTo(item).catch(() => {});
      setState('incall');
    }

    handle = async message => {
      const from = message.from;
      if (message.type === 'roster') {
        await applyRoster(message.callers);
      } else if (message.type === 'answer') {
        const entry = peers.get(from);
        if (!entry) return;
        await entry.pc.setRemoteDescription(message.description);
        await flushIce(entry);
        showStatus('Connected');
      } else if (message.type === 'ice') {
        await addIce(from, message.candidate);
      } else if (message.type === 'left') {
        closePeer(from);
      } else if (message.type === 'hangup') {
        endCall('Call ended.');
        await applyRoster([]);
      } else if (message.type === 'taken') {
        // Mom answered on her other device.
        endCall('You answered on another device.');
        await stopMedia();
        setState(roster.length ? 'incoming' : 'waiting');
      }
    };
    async function stopMedia() {
      if (cameraOn) await toggle('video');
      if (micOn) await toggle('audio');
    }

    answerBtn.addEventListener('click', async () => {
      if (answered || !roster.length) return;
      answered = true;
      answerBtn.disabled = true;
      clearCallAlerts();
      showStatus('Connecting…');
      try {
        for (const item of roster) await offerTo(item);
        setState('incall');
      } catch (error) {
        endCall(error.message);
        setState('incoming');
      } finally {
        answerBtn.disabled = false;
      }
    });
    hangupBtn.addEventListener('click', async () => {
      for (const key of peers.keys()) await send(key, {type: 'hangup'}).catch(() => {});
      endCall('You hung up.');
      await stopMedia();
      setState(roster.length ? 'incoming' : 'waiting');
    });
    document.querySelector('#momCamera').addEventListener('click', () => toggle('video'));
    document.querySelector('#momMic').addEventListener('click', () => toggle('audio'));

    // ---------- Call alerts: ring the phone even when this app is closed ----------
    const alertsBox = document.querySelector('#momAlerts');
    const alertsBtn = document.querySelector('#momAlertsOn');
    const alertsHint = document.querySelector('#momAlertsHint');
    const keyBytes = key => {
      const b64 = (key + '='.repeat((4 - key.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
      return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    };
    const sameBytes = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
    function showAlerts(button, hint) {
      alertsBox.hidden = !button && !hint;
      alertsBtn.hidden = !button;
      alertsHint.textContent = hint || '';
    }
    function clearCallAlerts() {
      if (!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.getRegistration().then(reg => reg && reg.getNotifications({tag: 'call'}))
        .then(list => (list || []).forEach(item => item.close())).catch(() => {});
    }
    async function subscribeAlerts(key) {
      const reg = await navigator.serviceWorker.ready;
      const appKey = keyBytes(key);
      let sub = await reg.pushManager.getSubscription();
      const oldKey = sub && sub.options && sub.options.applicationServerKey;
      if (sub && oldKey && !sameBytes(new Uint8Array(oldKey), appKey)) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: appKey});
      await post('/api/push/subscribe', {subscription: sub.toJSON()});
    }
    function alertsReady() {
      alertsOn = true;
      showAlerts(false, '');
      if (document.body.dataset.momState === 'waiting') setState('waiting');
    }
    async function setupAlerts() {
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        // iPhones only allow alerts for pages added to the Home Screen.
        if (ios && !installed) showAlerts(false, 'To have your phone ring when family calls, tap the Share button, then “Add to Home Screen”, and open Mom’s Call from there.');
        return;
      }
      let key;
      try {
        await navigator.serviceWorker.register('/sw.js');
        key = (await getJSON('/api/push/key')).key;
      } catch (_) { return; }
      if (!key) return;
      if (Notification.permission === 'granted') {
        try { await subscribeAlerts(key); alertsReady(); } catch (_) { showAlerts(true, ''); }
      } else if (Notification.permission === 'denied') {
        showAlerts(false, 'Call alerts are blocked. Turn on notifications for Mom’s Call in your phone’s Settings.');
      } else {
        showAlerts(true, '');
      }
      alertsBtn.addEventListener('click', async () => {
        alertsBtn.disabled = true;
        try {
          // Must be the first thing after the tap, or iPhones ignore it.
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') {
            showAlerts(permission === 'default', permission === 'denied' ? 'Call alerts are blocked. Turn on notifications for Mom’s Call in your phone’s Settings.' : '');
            return;
          }
          await subscribeAlerts(key);
          alertsReady();
        } catch (error) {
          showAlerts(true, 'Could not turn on call alerts: ' + error.message);
        } finally {
          alertsBtn.disabled = false;
        }
      });
    }
    // ---------- How often to check for messages ----------
    // Push rings her when the app is closed; checking only matters while it's open.
    pollDelay = () => {
      if (answered) {
        // Connecting trades a burst of setup notes; once connected, little else arrives.
        const settling = Array.from(peers.values()).some(entry => entry.pc.connectionState !== 'connected');
        return settling || !peers.size ? 400 : 1500;
      }
      if (document.visibilityState === 'hidden') stopPolling();  // e.g. a call ended while her screen was off
      if (roster.length) return 1000;  // a call is ringing: notice hang-ups and joiners quickly
      return 5000;                     // nobody calling
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        clearCallAlerts();
        startPolling();  // checks right away
        pollNow();
      } else if (!answered) {
        stopPolling();   // hidden and not on a call: push covers her
      }
    });
    if ('serviceWorker' in navigator) {
      // A call alert just arrived: check now instead of waiting up to 5 seconds.
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'call') pollNow();
      });
      if (navigator.serviceWorker.startMessages) navigator.serviceWorker.startMessages();
    }
    clearCallAlerts();
    setupAlerts();

    setState('waiting');
    showStatus('');
    updateSwitches();
    getJSON('/api/state').then(data => applyRoster(data.active ? data.callers : [])).catch(() => {});
    if (document.visibilityState === 'visible') startPolling();
  }

  // =====================================================================
  // Fire TV receiver
  // =====================================================================
  if (tv) {
    const fullscreen = document.querySelector('#enterFullscreen');
    const enableAudio = document.querySelector('#enableAudio');
    const toast = document.querySelector('#toast');
    let audioCtx = null;
    let known = new Set();
    let toastTimer = null;
    titleEl.textContent = 'Connecting your call…';
    introEl.textContent = 'Your family is connecting to the TV.';
    showStatus('');

    function chime() {
      if (!audioCtx) return;
      const now = audioCtx.currentTime;
      [660, 880].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + i * 0.18);
        gain.gain.linearRampToValueAtTime(0.12, now + i * 0.18 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.18 + 0.5);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + i * 0.18);
        osc.stop(now + i * 0.18 + 0.55);
      });
    }
    function announce(text) {
      toast.textContent = text;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
    }
    async function unblock() {
      try {
        await post('/api/play-tv', {});
        enableAudio.hidden = true;
      } catch (_) {
        enableAudio.hidden = false;
      }
    }

    handle = async message => {
      const from = message.from;
      if (message.type === 'offer') {
        const entry = newPeer(from, message.fromName, item => showStream(item, unblock));
        await entry.pc.setRemoteDescription(message.description);
        await flushIce(entry);
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        await send(from, {type: 'answer', description: entry.pc.localDescription});
      } else if (message.type === 'ice') {
        await addIce(from, message.candidate);
      } else if (message.type === 'roster') {
        const ids = new Set(message.callers.map(item => item.id));
        const added = message.callers.filter(item => !known.has(item.id));
        if (known.size && added.length) {
          chime();
          announce(joinNames(added.map(item => item.name)) + ' joined');
        }
        known = ids;
        for (const key of Array.from(peers.keys())) if (!ids.has(key)) closePeer(key);
        for (const item of message.callers) {
          const entry = peers.get(item.id);
          if (entry) { entry.name = item.name; tileFor(item.id, item.name); }
        }
      } else if (message.type === 'left') {
        closePeer(from);
      } else if (message.type === 'hangup') {
        closeAllPeers();
        known = new Set();
        announce('Call ended');
      }
    };

    fullscreen.addEventListener('click', async () => {
      try { await document.documentElement.requestFullscreen(); } catch (_) {}
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
      fullscreen.hidden = true;
      document.body.classList.add('theater');
      for (const video of document.querySelectorAll('#tvTiles video')) video.play().catch(() => {});
    });
    enableAudio.addEventListener('click', () => {
      for (const video of document.querySelectorAll('#tvTiles video')) video.play().catch(() => {});
    });
    startPolling();
  }
})();
