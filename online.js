/* online.js — adds an "Online 1v1" mode to the Tetris page.
   Load it AFTER the main <script>:   <script src="online.js"></script>  (right before </body>) */
(function () {
  'use strict';

  // Wait until every classic <script> on the page has executed, so it works wherever the tag is placed.
  function start() {
    if (typeof COLORS === 'undefined' || typeof TetrisEngine === 'undefined') {
      console.error('online.js: the main game script was not found. Load online.js as a plain <script> (not type="module") in the same HTML page.');
      return;
    }
    boot();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  function boot() {

  // ============ CONFIG: your Cloudflare tunnel URL ============
  const API = 'https://restoration-basketball-prescribed-jpeg.trycloudflare.com';
  // ============================================================

  const LS_URL = 'tetris_online_url';
  const STAT_KEYS = ['score', 'combo', 'b2bCount', 'surgeCharge', 'piecesPlaced',
    'totalAttackSent', 'totalGarbageCanceled', 'totalGarbageCleared', 'lastActionText', 'linesCleared'];
  const LETTERS = {};
  Object.keys(COLORS).forEach(k => (LETTERS[COLORS[k]] = k));

  const isOnline = () => modeSelect.value === 'online';

  // ---------- seeded RNG so both players get the same piece sequence ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  TetrisEngine.prototype.fillBag = function () {
    const pieces = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
    const rnd = this.rng || Math.random;
    for (let i = pieces.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
    }
    this.nextQueue.push(...pieces);
  };

  // ---------- UI ----------
  const style = document.createElement('style');
  style.textContent = `
    #online-container { gap: 8px; flex-wrap: wrap; justify-content: center; }
    #server-url { width: 250px; }
    #room-code { width: 84px; text-transform: uppercase; letter-spacing: 2px; text-align: center; }
    #online-status { font-size: .8rem; font-weight: 700; color: var(--gold-color); }
    #online-status.err { color: #ff5c5c; }
    .online-tag { position: absolute; top: -11px; left: 18px; padding: 1px 10px; font-size: .65rem;
      font-weight: 800; letter-spacing: 1px; background: var(--accent-color); color: #fff; border-radius: 8px; z-index: 3; }
  `;
  document.head.appendChild(style);

  const box = document.createElement('div');
  box.id = 'online-container';
  box.className = 'input-group hidden';
  box.innerHTML = `
    <label for="server-url">Server:</label>
    <input type="text" id="server-url" spellcheck="false" placeholder="https://xxxx.trycloudflare.com">
    <label for="room-code">Room:</label>
    <input type="text" id="room-code" maxlength="6" placeholder="CODE" spellcheck="false" autocomplete="off">
    <button id="create-room-btn">Create</button>
    <button id="join-room-btn">Join</button>
    <button id="leave-room-btn">Leave</button>
    <span id="online-status">Not connected</span>`;
  document.querySelector('.controls-panel').insertBefore(box, startBtn);

  const urlInput = document.getElementById('server-url');
  const roomInput = document.getElementById('room-code');
  const statusEl = document.getElementById('online-status');
  try { urlInput.value = localStorage.getItem(LS_URL) || API; } catch { urlInput.value = API; }

  const tags = ['YOU', 'OPPONENT'].map((txt, i) => {
    const t = document.createElement('div');
    t.className = 'online-tag hidden';
    t.textContent = txt;
    (i === 0 ? document.querySelector('.board-container') : botContainer).appendChild(t);
    return t;
  });

  function setStatus(text, isErr) {
    statusEl.textContent = text;
    statusEl.classList.toggle('err', !!isErr);
  }

  // ---------- board encoding ----------
  function encodeGrid(grid) {
    let s = '';
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        const v = grid[r][c];
        s += v ? (LETTERS[v] || 'G') : '.';
      }
    return s;
  }
  function decodeGrid(s) {
    const g = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const ch = s[r * COLS + c];
        row.push(ch && ch !== '.' ? (COLORS[ch] || COLORS.G) : 0);
      }
      g.push(row);
    }
    return g;
  }

  // The opponent board is a view-only engine. Garbage the local player "adds" to it
  // (done by the unmodified lockPiece logic) is intercepted here and sent over the network.
  function installGarbageHook(viewer) {
    let pending = 0;
    Object.defineProperty(viewer, 'garbagePending', {
      configurable: true,
      get() { return pending; },
      set(v) {
        if (v > pending) Online.send({ type: 'garbage', lines: v - pending });
        pending = v;
      }
    });
    viewer.setRemotePending = v => { pending = v; };
  }

  // ---------- network ----------
  function toWsUrl(u) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return null;
    if (/^https:\/\//i.test(u)) return 'wss://' + u.slice(8);
    if (/^http:\/\//i.test(u)) return 'ws://' + u.slice(7);
    if (/^wss?:\/\//i.test(u)) return u;
    return (/^(localhost|127\.|192\.168\.|10\.)/.test(u) ? 'ws://' : 'wss://') + u;
  }

  const Online = {
    ws: null, room: null, peers: 0, inMatch: false, readySent: false, lastSnap: '', connecting: false,

    connect() {
      return new Promise((resolve, reject) => {
        if (this.ws && this.ws.readyState === 1) return resolve();
        if (this.connecting) return reject(new Error('Still connecting…'));
        const base = toWsUrl(urlInput.value);
        if (!base) return reject(new Error('Enter the server URL'));
        try { localStorage.setItem(LS_URL, urlInput.value.trim()); } catch {}
        setStatus('Connecting…');
        let ws;
        try { ws = new WebSocket(base + '/ws'); } catch (e) { return reject(new Error('Invalid server URL')); }
        this.connecting = true;
        this.ws = ws;
        ws.onopen = () => { this.connecting = false; resolve(); };
        ws.onerror = () => { this.connecting = false; reject(new Error('Could not reach server')); };
        ws.onmessage = ev => this.onMessage(ev.data);
        ws.onclose = () => this.onClose(ws);
      });
    },

    send(obj) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    },

    leave() {
      const ws = this.ws;
      this.ws = null; this.room = null; this.peers = 0; this.inMatch = false; this.readySent = false;
      if (ws) { try { ws.close(); } catch {} }
    },

    ready() {
      if (!this.ws || !this.room) return setStatus('Create or join a room first', true);
      if (this.peers < 2) return setStatus('Waiting for an opponent to join…');
      if (this.inMatch || this.readySent) return;
      this.readySent = true;
      this.send({ type: 'ready' });
      setStatus('Ready — waiting for opponent…');
      if (!overlay.classList.contains('hidden')) document.getElementById('overlay-sub').textContent = 'Waiting for opponent…';
    },

    snapshot() {
      const p = player, cp = p.currentPiece;
      return {
        type: 'state',
        g: encodeGrid(p.grid),
        p: cp ? { t: cp.type, x: cp.x, y: cp.y, r: cp.rotation } : null,
        h: p.holdPieceType,
        n: p.nextQueue.slice(0, 5),
        s: Object.assign(Object.fromEntries(STAT_KEYS.map(k => [k, p[k]])), { garbagePending: p.garbagePending })
      };
    },

    pushSnapshot(force) {
      if (!player) return;
      const snap = JSON.stringify(this.snapshot());
      if (!force && snap === this.lastSnap) return;
      this.lastSnap = snap;
      this.send(snap);
    },

    onMessage(raw) {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      switch (m.type) {
        case 'room':
          this.room = m.code; this.peers = m.players; this.readySent = false;
          roomInput.value = m.code;
          if (!this.inMatch) enterOnlineIdle();
          setStatus(this.peers < 2 ? `Room ${m.code} — waiting for opponent…` : `Room ${m.code} — opponent here. Press Start Game`);
          break;
        case 'peer_joined':
          this.peers = 2;
          setStatus(`Room ${this.room} — opponent joined. Press Start Game`);
          break;
        case 'peer_ready':
          if (!this.readySent) setStatus('Opponent is ready — press Start Game');
          break;
        case 'peer_left':
          this.peers = 1; this.readySent = false;
          if (this.inMatch && !gameOver) {
            gameOver = true;
            if (player) player.resetLockDelay();
            showResult('YOU WIN!', true, 'Opponent disconnected');
          }
          setStatus(`Room ${this.room} — opponent left`);
          break;
        case 'start':
          if (isOnline()) startOnlineMatch(m.seed);
          break;
        case 'state':
          applyRemoteState(m);
          break;
        case 'garbage':
          if (this.inMatch && player && !gameOver) {
            player.garbagePending += Math.min(40, m.lines | 0);
            player.updateGarbageUI();
          }
          break;
        case 'dead':
          if (this.inMatch && !gameOver) {
            gameOver = true;
            player.resetLockDelay();
            showResult('YOU WIN!', true, 'Opponent topped out');
          }
          break;
        case 'error':
          setStatus(m.message, true);
          break;
      }
    },

    onClose(ws) {
      if (this.ws !== ws) return;
      this.ws = null; this.room = null; this.peers = 0; this.connecting = false; this.readySent = false;
      if (this.inMatch && !gameOver) {
        gameOver = true;
        showResult('CONNECTION LOST', false, 'Lost connection to the server');
      }
      this.inMatch = false;
      setStatus('Disconnected', true);
    }
  };

  // ---------- match flow ----------
  function enterOnlineIdle() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (player) player.resetLockDelay();
    if (bot) bot.resetLockDelay();
    isCountingDown = false; gameStarted = false; gameOver = false; isPaused = false;
    sprintTimerActive = false; Online.inMatch = false;
    overlay.classList.add('hidden');
    countdownOverlay.classList.add('hidden');
    player = new TetrisEngine('player-canvas', 'player-hold', 'player-next', 'player-garbage-fill', false);
    bot = new TetrisEngine('bot-canvas', 'bot-hold', 'bot-next', 'bot-garbage-fill', true);
    installGarbageHook(bot);
    player.draw(player.ctx);
    bot.draw(bot.ctx);
  }

  function startOnlineMatch(seed) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (player) player.resetLockDelay();
    if (bot) bot.resetLockDelay();
    overlay.classList.add('hidden');
    countdownOverlay.classList.add('hidden');
    updateCachedSettings();

    gameStarted = true; gameOver = false; isPaused = false;
    sprintTimerActive = false; matchStartTime = 0;
    keyState.left.pressed = keyState.right.pressed = keyState.softDrop.pressed = false;

    player = new TetrisEngine('player-canvas', 'player-hold', 'player-next', 'player-garbage-fill', false);
    bot = new TetrisEngine('bot-canvas', 'bot-hold', 'bot-next', 'bot-garbage-fill', true);
    player.rng = mulberry32(seed >>> 0);
    player.reset(true); // re-deal from the shared seed
    installGarbageHook(bot);

    Online.inMatch = true; Online.readySent = false; Online.lastSnap = '';
    setStatus(`Room ${Online.room} — match in progress`);
    updateModeVisibility();

    const prevDelay = cachedSettings.sprintDelay;
    cachedSettings.sprintDelay = 3;
    startCountdownSequence();
    cachedSettings.sprintDelay = prevDelay;
  }

  function applyRemoteState(m) {
    if (!Online.inMatch || !bot) return;
    if (typeof m.g !== 'string' || m.g.length !== ROWS * COLS) return;
    bot.grid = decodeGrid(m.g);
    const p = m.p;
    if (p && 'IJLOSTZ'.includes(p.t) && p.r >= 0 && p.r < 4) {
      bot.currentPiece = {
        type: p.t, matrix: ROTATED_SHAPES[p.t][p.r], color: COLORS[p.t],
        x: p.x | 0, y: p.y | 0, rotation: p.r
      };
    } else {
      bot.currentPiece = null;
    }
    bot.holdPieceType = m.h || null;
    bot.nextQueue = Array.isArray(m.n) ? m.n.filter(t => 'IJLOSTZ'.includes(t)).slice(0, 5) : [];
    const s = m.s || {};
    STAT_KEYS.forEach(k => { if (s[k] !== undefined) bot[k] = s[k]; });
    bot.setRemotePending(s.garbagePending | 0);
    bot.updateHoldUI();
    bot.updateNextUI();
    bot.updateGarbageUI();
    bot.updateStats(matchStartTime ? (performance.now() - matchStartTime) / 1000 : 0.001);
    bot.draw(bot.ctx);
  }

  function showResult(title, win, sub) {
    Online.inMatch = false; Online.readySent = false;
    const t = document.getElementById('overlay-title');
    t.textContent = title;
    t.className = win ? 'win' : '';
    document.getElementById('overlay-sub').textContent = sub;
    overlayRestartBtn.textContent = 'Rematch';
    overlay.classList.remove('hidden');
    setStatus(Online.room ? `Room ${Online.room} — match over` : 'Match over');
  }

  setInterval(() => {
    if (Online.inMatch && gameStarted && !gameOver && player) Online.pushSnapshot(false);
  }, 50);

  // ---------- hook into the existing game ----------
  const _updateCachedSettings = updateCachedSettings;
  updateCachedSettings = function () {
    _updateCachedSettings();
    // Online play reuses the 'vs' garbage/attack rules of the base game
    if (modeSelect.value === 'online') cachedSettings.mode = 'vs';
  };

  const _updateModeVisibility = updateModeVisibility;
  updateModeVisibility = function () {
    _updateModeVisibility();
    const on = isOnline();
    box.classList.toggle('hidden', !on);
    tags.forEach(t => t.classList.toggle('hidden', !on));
    if (on) botContainer.classList.remove('hidden');
  };

  const _processBotTurn = processBotTurn;
  processBotTurn = function () {
    if (isOnline()) return; // the right-hand board is the remote player, not an AI
    return _processBotTurn.apply(this, arguments);
  };

  const _togglePause = togglePause;
  togglePause = function () {
    if (isOnline()) return; // no pausing a live match
    return _togglePause();
  };

  const _handleGameOver = handleGameOver;
  handleGameOver = function (loser) {
    if (!isOnline()) return _handleGameOver(loser);
    if (gameOver || !Online.inMatch || loser !== player) return;
    gameOver = true;
    player.resetLockDelay();
    Online.pushSnapshot(true);
    Online.send({ type: 'dead' });
    showResult('YOU LOSE', false, 'You topped out');
  };

  const _initGame = initGame;
  initGame = function () {
    if (!isOnline()) return _initGame.apply(this, arguments);
    if (Online.room) Online.ready();
    else { enterOnlineIdle(); setStatus('Create or join a room to play'); }
  };

  // Start / Restart / Rematch / Pause buttons act on the online flow while in online mode
  document.addEventListener('click', e => {
    if (!isOnline()) return;
    const b = e.target.closest && e.target.closest('button');
    if (!b) return;
    if (b === startBtn || b === restartBtn || b === overlayRestartBtn) {
      e.stopPropagation(); e.preventDefault();
      Online.ready();
    } else if (b === pauseBtn) {
      e.stopPropagation(); e.preventDefault();
    }
  }, true);

  // Typing in the server/room boxes must not trigger game hotkeys (R, P, C, ...)
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text'))) e.stopPropagation();
  }, true);

  // ---------- room buttons ----------
  async function createRoom() {
    try { await Online.connect(); Online.send({ type: 'create' }); }
    catch (e) { setStatus(e.message, true); }
  }
  async function joinRoom() {
    const code = roomInput.value.trim().toUpperCase();
    if (!code) return setStatus('Enter a room code', true);
    try { await Online.connect(); Online.send({ type: 'join', code }); }
    catch (e) { setStatus(e.message, true); }
  }
  document.getElementById('create-room-btn').addEventListener('click', createRoom);
  document.getElementById('join-room-btn').addEventListener('click', joinRoom);
  document.getElementById('leave-room-btn').addEventListener('click', () => {
    Online.leave();
    roomInput.value = '';
    enterOnlineIdle();
    setStatus('Left the room');
  });
  roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

  // ---------- add the mode to the dropdown ----------
  if (!modeSelect.querySelector('option[value="online"]')) {
    modeSelect.insertBefore(new Option('Online 1v1', 'online'), modeSelect.options[2]);
  }
  try {
    if (localStorage.getItem('tetris_vs_mode') === 'online') modeSelect.value = 'online';
    else if (!modeSelect.value) modeSelect.value = 'vs';
  } catch {}

  let lastMode = modeSelect.value;
  modeSelect.addEventListener('change', () => {
    const now = modeSelect.value;
    if (now === 'online' && lastMode !== 'online') {
      enterOnlineIdle();
      setStatus(Online.room ? `Room ${Online.room}` : 'Create or join a room to play');
    } else if (lastMode === 'online' && now !== 'online') {
      Online.leave();
      overlayRestartBtn.textContent = 'Play Again';
      initGame();
    }
    lastMode = now;
  });

  updateCachedSettings();
  updateModeVisibility();
  if (isOnline()) setStatus('Create or join a room to play');

  } // end boot
})();
