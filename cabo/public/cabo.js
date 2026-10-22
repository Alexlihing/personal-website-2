(function () {
  'use strict';

  // ───────────────────────── state ─────────────────────────

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  function randomToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    var s = '';
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  var S = {
    token: store.get('cabo.token') || randomToken(),
    name: store.get('cabo.name') || '',
    code: store.get('cabo.code') || '',
    inviteCode: (new URLSearchParams(location.search).get('code') || '').toUpperCase(),
    screen: 'home',
    connected: false,
    lobby: null,
    me: null,
    game: null,
    reveals: {},          // "ownerId:cardId" → { rank, suit, value, timer }
    peekCards: {},        // opening peek: "ownerId:cardId" → card, shown for 2s when clicked
    sel: { mine: null, theirs: null },
    ws: null,
    retry: 0,
    dealAnim: false,      // animate the deal on the next render
    lastDrawKey: '',
    lastTopId: '',
    lastTurnMine: false,
    banner: '',
    lastSeq: 0,           // newest move already shown
    fx: {},               // slot key → { kind, label, t, timer }: what just happened to that slot
    lastMove: null,
    drag: null,           // { kind, ownerId, cardId, ghost, over, x, y }
    suppressClick: false,
  };
  store.set('cabo.token', S.token);

  var REVEAL_MS = 2000;
  var FX_MS = 4500;        // how long a move stays marked on its cards
  var FX_ANIM_MS = 1400;   // the 3D motion part of it
  var SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };

  // ───────────────────────── websocket ─────────────────────────

  function wsUrl() {
    if (window.CABO_WS_URL) return window.CABO_WS_URL;
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var base = location.pathname.replace(/\/?(index\.html)?$/, '');
    return proto + location.host + base + '/ws';
  }

  function connect() {
    var ws = new WebSocket(wsUrl());
    S.ws = ws;
    ws.onopen = function () {
      S.connected = true;
      S.retry = 0;
      send({ type: 'hello', token: S.token });
      render();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };
    ws.onclose = function () {
      S.connected = false;
      render();
      var delay = Math.min(8000, 1000 * Math.pow(1.6, S.retry++));
      setTimeout(connect, delay);
    };
    ws.onerror = function () { ws.close(); };
  }

  function send(msg) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
    else toast('Not connected yet. Try again in a second.', true);
  }

  function handle(msg) {
    switch (msg.type) {
      case 'hello':
        S.token = msg.token;
        store.set('cabo.token', S.token);
        if (S.code) send({ type: 'rejoin', code: S.code });
        break;
      case 'joined':
        S.code = msg.code;
        S.inviteCode = '';
        store.set('cabo.code', S.code);
        history.replaceState(null, '', location.pathname);
        break;
      case 'left':
        S.code = '';
        store.del('cabo.code');
        S.lobby = null; S.game = null; S.me = null;
        S.screen = 'home';
        clearReveals();
        clearFx();
        if (msg.reason) toast(msg.reason, true);
        render();
        break;
      case 'state':
        applyState(msg);
        break;
      case 'reveal':
        addReveals(msg);
        render();
        break;
      case 'error':
        toast(msg.message, true);
        break;
    }
  }

  function applyState(msg) {
    var prevGame = S.game;
    S.lobby = msg.lobby;
    S.me = msg.me;
    S.game = msg.game;
    S.screen = S.game ? 'game' : 'lobby';
    if (!S.game || (prevGame && prevGame.status === 'peek' && S.game.status !== 'peek')) clearReveals();
    if (S.game && (!prevGame || prevGame.status === 'finished') && S.game.status === 'peek') {
      S.dealAnim = true;
      S.lastDrawKey = ''; S.lastTopId = ''; S.lastTurnMine = false;
      S.lastSeq = 0; S.lastMove = null;
      clearFx();
      cancelDrag();
    }
    if (S.game) {
      var mineNow = S.game.status === 'playing' && S.game.turnPlayerId === S.me && S.game.phase === 'draw';
      S.banner = (mineNow && !S.lastTurnMine) ? 'Your turn' : '';
      S.lastTurnMine = mineNow;
      var myTurn = S.game.turnPlayerId === S.me;
      if (!(myTurn && S.game.phase === 'power')) S.sel = { mine: null, theirs: null };
      if (S.game.status === 'finished') clearReveals();
      noteMoves();
      if (S.drag && !dragStillValid()) cancelDrag();
    }
    render();
  }

  // ───────────────────────── moves → on-card markers ─────────────────────────

  // Each new move marks the slots it touched for a few seconds, with a label
  // saying who did what, so everyone at the table can follow it.
  function noteMoves() {
    var moves = S.game.moves || [];
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      if (m.seq <= S.lastSeq) continue;
      S.lastSeq = m.seq;
      S.lastMove = m;
      var who = m.actorId === S.me ? 'you' : nameOf(m.actorId);
      var label = null;
      if (m.type === 'peek' || m.type === 'look') label = who + ' looked';
      else if (m.type === 'swap') label = 'swapped';
      else if (m.type === 'place') label = who + ' placed';
      else if (m.type === 'match') label = who + ' matched';
      else if (m.type === 'penalty') label = 'penalty';
      else if (m.type === 'give') label = 'from ' + who;
      if (!label) continue;
      m.cards.forEach(function (c) { markFx(slotKey(c), m.type, label); });
    }
  }

  function slotKey(c) {
    return c.cardId ? c.ownerId + ':' + c.cardId : c.ownerId + ':slot:' + c.slot;
  }

  function markFx(key, kind, label) {
    if (S.fx[key] && S.fx[key].timer) clearTimeout(S.fx[key].timer);
    S.fx[key] = {
      kind: kind, label: label, t: Date.now(),
      timer: setTimeout(function () { delete S.fx[key]; render(); }, FX_MS),
    };
  }

  function clearFx() {
    Object.keys(S.fx).forEach(function (k) { if (S.fx[k].timer) clearTimeout(S.fx[k].timer); });
    S.fx = {};
  }

  // ───────────────────────── reveals ─────────────────────────

  function addReveals(msg) {
    if (msg.sticky) {
      // Opening peek: keep the cards face down until the player clicks one.
      msg.cards.forEach(function (c) { S.peekCards[c.ownerId + ':' + c.id] = c; });
      return;
    }
    msg.cards.forEach(showCard);
  }

  function showCard(c) {
    var key = c.ownerId + ':' + c.id;
    if (S.reveals[key] && S.reveals[key].timer) clearTimeout(S.reveals[key].timer);
    S.reveals[key] = {
      rank: c.rank, suit: c.suit, value: c.value,
      timer: setTimeout(function () { delete S.reveals[key]; render(); }, REVEAL_MS),
    };
  }

  function clearReveals() {
    Object.keys(S.reveals).forEach(function (k) { if (S.reveals[k].timer) clearTimeout(S.reveals[k].timer); });
    S.reveals = {};
    S.peekCards = {};
  }

  // ───────────────────────── helpers ─────────────────────────

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(text, isError) {
    var el = document.getElementById('toast');
    el.textContent = text;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  function playerById(id) {
    if (!S.game) return null;
    for (var i = 0; i < S.game.players.length; i++) if (S.game.players[i].id === id) return S.game.players[i];
    return null;
  }
  function nameOf(id) { var p = playerById(id); return p ? p.name : '?'; }
  function lobbyPlayer(id) {
    if (!S.lobby) return null;
    for (var i = 0; i < S.lobby.players.length; i++) if (S.lobby.players[i].id === id) return S.lobby.players[i];
    return null;
  }
  function isHost() { return S.lobby && S.lobby.hostId === S.me; }
  function kbd(k) { return '<kbd>' + k + '</kbd>'; }

  // A two-sided card. Face-up cards show `card`; face-down ones may carry a "seen" mark.
  function cardEl(o) {
    var card = o.card || null;
    var red = card && (card.suit === 'H' || card.suit === 'D');
    var cls = 'card ' + (o.up ? 'up ' : '') + (red ? 'red ' : '') + (o.cls || '');
    var front = '';
    if (card) {
      var sym = SUIT_CHAR[card.suit];
      front = '<span class="face"><span class="idx">' + card.rank + '<small>' + sym + '</small></span>' +
        '<span class="big">' + sym + '</span>' +
        '<span class="val">' + card.value + '</span></span>';
    }
    return '<button type="button" class="' + cls + '" ' + (o.attrs || '') + (o.style ? ' style="' + o.style + '"' : '') + '>' +
      '<span class="inner"><span class="side back"><span class="face">' + (o.seen ? '<span class="seen">seen</span>' : '') + '</span></span>' +
      '<span class="side front">' + front + '</span></span>' + (o.extra || '') + '</button>';
  }

  // Which single-click action a given card currently has for me, if any.
  function cardAction(ownerId, card) {
    var g = S.game;
    if (g && g.status === 'peek') return S.peekCards[ownerId + ':' + card.id] ? 'peekInitial' : null;
    if (!g || g.status !== 'playing') return null;
    if (g.pendingGive) {
      return (g.pendingGive.from === S.me && ownerId === S.me) ? 'give' : null;
    }
    if (g.phase === 'settle' || g.turnPlayerId !== S.me) return null;
    var own = ownerId === S.me;
    if (g.phase === 'hold') return own ? 'swapHeld' : null;
    if (g.phase === 'power' && g.power && g.power.stage === 'choose') {
      var t = g.power.type;
      if (t === 'peekOwn') return own ? 'peek' : null;
      if (t === 'peekOther') return own ? null : 'peek';
      if (t === 'blindSwap' && card.seenByMe) return 'blocked';
      return own ? 'selectMine' : 'selectTheirs';
    }
    return null;
  }

  function canMatch() {
    var g = S.game;
    return g && g.status === 'playing' && g.phase === 'settle' && !g.pendingGive;
  }
  function canDraw() {
    var g = S.game;
    return g && g.status === 'playing' && g.turnPlayerId === S.me && g.phase === 'draw' && !g.pendingGive;
  }
  function canPlay() {
    var g = S.game;
    return g && g.status === 'playing' && g.turnPlayerId === S.me && g.phase === 'hold';
  }
  function canReady() {
    var g = S.game, me = playerById(S.me);
    if (!g || !me || me.ready) return false;
    return g.status === 'peek' || (g.status === 'playing' && g.phase === 'settle' && !g.pendingGive);
  }

  function fxHTML(key) {
    var fx = S.fx[key];
    if (!fx) return { cls: '', badge: '' };
    var fresh = Date.now() - fx.t < FX_ANIM_MS;
    return {
      cls: ' fx fx-' + fx.kind + (fresh ? ' fx-anim' : ''),
      badge: '<span class="fx-badge">' + esc(fx.label) + '</span>',
    };
  }

  function cardHTML(ownerId, card, index, mine) {
    if (!card) {
      var ek = ownerId + ':slot:' + index;
      var efx = fxHTML(ek);
      return '<span class="slot empty' + efx.cls + '" data-owner="' + ownerId + '" data-slot="' + index + '">' + efx.badge + '</span>';
    }
    var key = ownerId + ':' + card.id;
    var action = cardAction(ownerId, card);
    var cls = '';
    var attrs = 'data-owner="' + ownerId + '" data-card="' + card.id + '"';
    if (action && action !== 'blocked') cls += ' clickable';
    if (action === 'blocked') cls += ' blocked';
    if (action) attrs += ' data-action="' + action + '"';
    if (canMatch()) { cls += ' matchable'; attrs += ' data-drag="match"'; }
    if (mine && canPlay()) attrs += ' data-drop="slot"';
    if (S.sel.mine === card.id || (S.sel.theirs && S.sel.theirs.cardId === card.id)) cls += ' selected';
    if (S.drag && S.drag.ownerId === ownerId && S.drag.cardId === card.id) cls += ' drag-src';
    var style = '';
    if (S.dealAnim) { cls += ' deal'; style = '--delay:' + (index * 70) + 'ms'; }

    var fx = fxHTML(key);
    cls += fx.cls;
    var extra = fx.badge + (mine ? '<span class="key">' + (index + 1) + '</span>' : '');

    var face = S.reveals[key] || card.known || null;
    if (face) cls += S.reveals[key] ? ' revealed' : ' known';
    return cardEl({ up: !!face, card: face, cls: cls, attrs: attrs, style: style, seen: !face && card.seenByMe, extra: extra });
  }

  // ───────────────────────── rendering ─────────────────────────

  var app = document.getElementById('app');

  function render() {
    var html = topbarHTML();
    if (S.screen === 'home') html += homeHTML();
    else if (S.screen === 'lobby') html += lobbyHTML();
    else html += gameHTML();
    app.innerHTML = html;
    app.classList.toggle('in-game', S.screen === 'game');
    app.classList.toggle('drag-held', !!(S.drag && S.drag.kind === 'held'));
    app.classList.toggle('drag-match', !!(S.drag && S.drag.kind === 'match'));
    S.dealAnim = false;
    S.banner = '';
  }

  function topbarHTML() {
    var status = S.connected ? 'connected' : 'reconnecting…';
    var mid = '';
    if (S.game && S.game.status === 'playing') {
      var turn = S.game.turnPlayerId === S.me ? 'Your turn' : nameOf(S.game.turnPlayerId) + "'s turn";
      mid = '<span class="status live">' + esc(turn) + (S.game.caboCallerId ? ' · CABO called by ' + esc(nameOf(S.game.caboCallerId)) : '') + '</span>';
    }
    var right = '<span class="status">' + status + '</span>';
    if (S.screen !== 'home') right += '<button class="btn small" data-action="leave">Leave</button>';
    return '<div class="topbar"><div class="brand">Cabo' + (S.code ? '<small>LOBBY ' + esc(S.code) + '</small>' : '') + '</div>' + mid + '<div class="right">' + right + '</div></div>';
  }

  function homeHTML() {
    var nameField = '<div class="field"><label for="name">Your name</label><input id="name" type="text" maxlength="20" placeholder="e.g. Alex" value="' + esc(S.name) + '" autocomplete="off" /></div>';
    if (S.inviteCode) {
      return '<div class="centered"><div class="panel">' +
        '<div class="home-title"><h1>Cabo</h1><p>You\'re invited to lobby</p><div class="code">' + esc(S.inviteCode) + '</div></div>' +
        '<div class="stack">' + nameField +
          '<button class="btn primary" data-action="join">Join lobby</button>' +
          '<div style="text-align:center"><a class="link" href="' + esc(location.pathname) + '">Wrong lobby? Start over</a></div>' +
        '</div></div></div>';
    }
    return '<div class="centered"><div class="panel">' +
        '<div class="home-title"><h1>Cabo</h1><p>Lowest hand wins.</p></div>' +
        '<div class="stack">' + nameField +
          '<button class="btn primary" data-action="create">Create a lobby</button>' +
          '<hr class="divider" />' +
          '<div class="row"><div class="field"><label for="code">Join code</label><input id="code" type="text" maxlength="5" placeholder="ABCDE" autocomplete="off" style="text-transform:uppercase;font-family:var(--font-mono);letter-spacing:0.2em" /></div>' +
          '<button class="btn" data-action="join">Join lobby</button></div>' +
        '</div>' +
      '</div></div>';
  }

  function lobbyHTML() {
    var L = S.lobby;
    var host = isHost();
    var s = L.settings;
    var players = L.players.map(function (p) {
      return '<li><span class="dot' + (p.connected ? ' on' : '') + '"></span><span>' + esc(p.name) + (p.id === S.me ? ' <span class="muted">(you)</span>' : '') + '</span>' +
        (p.id === L.hostId ? '<span class="tag accent">host</span>' : '') +
        '<span class="spacer"></span>' +
        (host && p.id !== S.me ? '<button class="btn small danger" data-action="kick" data-player="' + p.id + '">Remove</button>' : '') +
      '</li>';
    }).join('');
    var peek = Math.min(2, s.handSize);
    return '<div class="centered"><div class="panel" style="max-width:600px">' +
      '<div class="code-display"><div><h2>Join code</h2><div class="code">' + esc(L.code) + '</div></div>' +
        '<button class="btn" data-action="copy">Copy invite link</button></div>' +
      '<h2>Players (' + L.players.length + ')</h2><ul class="player-list">' + players + '</ul>' +
      '<h2>Settings' + (host ? '' : ' <span class="muted">(host only)</span>') + '</h2>' +
      '<div class="settings-grid">' +
        '<div class="field"><label>Cards per player</label><input type="number" min="1" max="8" step="2" data-setting="handSize" value="' + s.handSize + '"' + (host ? '' : ' disabled') + ' /></div>' +
        '<div class="field"><label>You peek at first</label><div class="hint" style="padding:0.55rem 0">bottom row (' + peek + ' card' + (peek === 1 ? '' : 's') + ')</div></div>' +
      '</div>' +
      '<div class="lobby-actions">' +
        '<span class="hint">' + (host ? 'Start when everyone is in.' : 'Waiting for the host to start.') + '</span>' +
        (host ? '<button class="btn primary" data-action="start"' + (L.players.length < 2 ? ' disabled' : '') + '>Start game</button>' : '') +
      '</div>' +
    '</div></div>';
  }

  // Opponents in turn order starting after me.
  function seatedOpponents() {
    var ps = S.game.players;
    var myIdx = 0;
    for (var i = 0; i < ps.length; i++) if (ps[i].id === S.me) myIdx = i;
    var out = [];
    for (var k = 1; k < ps.length; k++) out.push(ps[(myIdx + k) % ps.length]);
    return out;
  }

  function gameHTML() {
    var g = S.game;
    var me = playerById(S.me);
    var html = '<div class="scene">' +
      '<div class="table"><div class="opponents">' + seatedOpponents().map(function (p) { return seatHTML(p); }).join('') + '</div></div>' +
      sideHTML() +
      '<div class="dock">' + actionsHTML() + (me ? seatHTML(me) : '') + '</div>';
    if (S.banner) html += '<div class="banner">' + esc(S.banner) + '</div>';
    if (g.status === 'finished') html += resultsHTML();
    html += '</div>';
    return html;
  }

  function seatHTML(p) {
    var g = S.game;
    var lp = lobbyPlayer(p.id);
    var mine = p.id === S.me;
    var cls = 'seat ' + (mine ? 'me' : 'opp') + (g.turnPlayerId === p.id ? ' turn' : '') + (lp && !lp.connected ? ' offline' : '');
    if (g.pendingGive && g.pendingGive.to === p.id) cls += ' receiving';
    var tags = '';
    if (g.caboCallerId === p.id) tags += '<span class="tag accent">cabo</span>';
    if (g.status === 'peek' || (g.status === 'playing' && g.phase === 'settle')) tags += p.ready ? '<span class="tag ok">ready</span>' : '';
    if (lp && !lp.connected) tags += '<span class="tag">offline</span>';
    return '<div class="' + cls + '">' +
      '<div class="label"><span class="name">' + esc(p.name) + (mine ? ' (you)' : '') + '</span>' + tags +
      '<span class="count">' + p.cardCount + '</span></div>' +
      '<div class="grid">' + p.cards.map(function (c, i) { return cardHTML(p.id, c, i, mine); }).join('') + '</div></div>';
  }

  function ghosts(count, white) {
    var n = Math.min(4, Math.max(0, count - 1));
    var out = '';
    for (var i = n; i >= 1; i--) {
      var rot = white ? ((i * 37) % 11 - 5) : 0;
      out += '<span class="ghost' + (white ? ' white' : '') + '" style="transform:translate(' + (-i * 1.5) + 'px,' + (-i * 1.5) + 'px) rotate(' + rot + 'deg)"></span>';
    }
    return out;
  }

  // The draw pile, the played pile and the drawn card live in a column beside the table.
  function sideHTML() {
    var g = S.game;
    var myTurn = g.turnPlayerId === S.me;
    var draw = canDraw(), play = canPlay();

    var deck = '<div class="stack">' + ghosts(g.deckCount, false) +
      (g.deckCount
        ? cardEl({ up: false, cls: draw ? 'clickable' : '', attrs: draw ? 'data-action="draw" title="Draw (D)"' : 'disabled' })
        : '<div class="empty"></div>') + '</div>';

    var landed = g.discardTop && g.discardTop.id !== S.lastTopId;
    if (g.discardTop) S.lastTopId = g.discardTop.id;
    var playAttrs = (play ? 'data-action="discardHeld" title="Play the drawn card here (space)"' : 'disabled') + ' data-drop="pile"';
    var played = '<div class="stack" data-drop="pile">' + ghosts(g.discardCount, true) +
      (g.discardTop
        ? cardEl({ up: true, card: g.discardTop, cls: (play ? 'clickable' : '') + (landed ? ' land' : ''), attrs: playAttrs })
        : '<div class="empty" ' + playAttrs + '></div>') + '</div>';

    var held = '';
    if (g.held) {
      var drawKey = g.turnPlayerId + ':' + g.deckCount;
      var fresh = drawKey !== S.lastDrawKey;
      S.lastDrawKey = drawKey;
      var heldAttrs = myTurn ? 'data-drag="held" title="Drag onto the pile to play it, or onto one of your cards to swap"' : 'disabled';
      held = cardEl({ up: !!g.held.card, card: g.held.card, cls: (fresh ? 'draw-in' : '') + (myTurn ? ' clickable' : '') + (S.drag && S.drag.kind === 'held' ? ' drag-src' : ''), attrs: heldAttrs });
    } else {
      S.lastDrawKey = '';
      held = '<div class="empty faint"></div>';
    }
    var heldLabel = g.held ? (myTurn ? 'Drawn' : esc(nameOf(g.turnPlayerId)) + ' drew') : 'Drawn';
    var live = g.status === 'playing' && g.phase === 'settle' && !g.pendingGive;

    return '<aside class="side">' +
      '<div class="pile draw' + (draw ? ' active' : '') + '"><span class="plabel">Draw · ' + g.deckCount + '</span>' + deck + '</div>' +
      '<div class="pile played' + (live ? ' live' : '') + (play ? ' target' : '') + '"><span class="plabel">Played · ' + g.discardCount + '</span>' + played + '</div>' +
      '<div class="pile drawn' + (g.held ? ' has' : '') + '"><span class="plabel">' + heldLabel + '</span>' + held + '</div>' +
      '</aside>';
  }

  function actionsHTML() {
    var g = S.game;
    var prompt = '';
    var buttons = [];
    var alert = false;
    var myTurn = g.turnPlayerId === S.me;
    var me = playerById(S.me);
    var notReady = g.players.filter(function (p) { return !p.ready; }).map(function (p) { return p.name; });

    if (g.status === 'peek') {
      if (me && me.ready) {
        prompt = 'Waiting for ' + esc(notReady.join(', ')) + '.';
      } else {
        prompt = 'Click your bottom two cards to peek at them.';
        buttons.push('<button class="btn primary" data-action="ready">Ready ' + kbd('⏎') + '</button>');
      }
    } else if (g.status === 'finished') {
      prompt = esc(g.result.reason);
    } else if (g.pendingGive) {
      if (g.pendingGive.from === S.me) {
        alert = true;
        prompt = 'Give <strong>' + esc(nameOf(g.pendingGive.to)) + '</strong> one of your cards: click it.';
      } else {
        prompt = esc(nameOf(g.pendingGive.from)) + ' is giving ' + esc(nameOf(g.pendingGive.to)) + ' a card.';
      }
    } else if (g.phase === 'settle') {
      if (me && me.ready) {
        prompt = 'Waiting for ' + esc(notReady.join(', ')) + '.';
      } else {
        alert = true;
        prompt = 'Match the <strong>' + esc(g.discardTop.rank) + '</strong>? Drag any card onto the played pile.';
        buttons.push('<button class="btn primary" data-action="ready">Ready ' + kbd('⏎') + '</button>');
      }
    } else if (!myTurn) {
      prompt = esc(nameOf(g.turnPlayerId)) + "'s turn.";
    } else if (g.phase === 'draw') {
      prompt = '<strong>Your turn.</strong> Draw a card.';
      buttons.push('<button class="btn primary" data-action="draw">Draw ' + kbd('D') + '</button>');
      if (!g.caboCallerId) buttons.push('<button class="btn danger" data-action="cabo">Call Cabo ' + kbd('C') + '</button>');
    } else if (g.phase === 'hold') {
      prompt = 'Drag the drawn card onto the <strong>played pile</strong> to play it, or onto <strong>one of your cards</strong> to swap.';
      buttons.push('<button class="btn" data-action="discardHeld">Play it ' + kbd('space') + '</button>');
    } else if (g.phase === 'power') {
      var t = g.power.type;
      if (g.power.stage === 'decide') {
        alert = true;
        prompt = 'Swap those two cards?';
        buttons.push('<button class="btn primary" data-action="confirmSwap" data-swap="1">Swap ' + kbd('Y') + '</button>');
        buttons.push('<button class="btn" data-action="confirmSwap" data-swap="0">Keep ' + kbd('N') + '</button>');
      } else {
        if (t === 'peekOwn') prompt = '<strong>' + esc(g.power.rank) + ':</strong> click one of your cards to look at it.';
        else if (t === 'peekOther') prompt = '<strong>' + esc(g.power.rank) + ':</strong> click an opponent\'s card to look at it.';
        else if (t === 'blindSwap') prompt = '<strong>J:</strong> blind swap. Click one of your unseen cards and one of theirs.';
        else prompt = '<strong>Q:</strong> click one of your cards and one of theirs to look at both.';
        buttons.push('<button class="btn" data-action="skipPower">Skip ' + kbd('S') + '</button>');
      }
    }

    var last = S.lastMove && g.status === 'playing' ? '<div class="lastmove">' + esc(S.lastMove.text) + '</div>' : '';
    return '<div class="actions' + (alert ? ' alert' : '') + '"><div class="prompt">' + prompt + last + '</div><div class="buttons">' + buttons.join('') + '</div></div>';
  }

  function resultsHTML() {
    var r = S.game.result;
    var sorted = r.scores.slice().sort(function (a, b) { return a.total - b.total; });
    var rows = sorted.map(function (s) {
      var win = r.winners.indexOf(s.id) !== -1;
      return '<tr class="' + (win ? 'winner' : '') + '"><td>' + esc(s.name) + (s.calledCabo ? ' <span class="tag accent">cabo</span>' : '') + (win ? ' <span class="tag ok">winner</span>' : '') + '</td>' +
        '<td><div class="hand">' + s.cards.map(function (c) { return cardEl({ up: true, card: c, attrs: 'disabled' }); }).join('') + '</div></td>' +
        '<td class="mono">' + s.total + '</td></tr>';
    }).join('');
    var buttons = isHost()
      ? '<button class="btn primary" data-action="start">Play again</button><button class="btn" data-action="endGame">Back to lobby</button>'
      : '<span class="hint">Waiting for the host to start another game.</span>';
    return '<div class="modal"><div class="results"><h2>Results</h2><p>' + esc(r.reason) + '</p>' +
      '<table><thead><tr><th>Player</th><th>Hand</th><th>Total</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="buttons">' + buttons + '</div></div></div>';
  }

  // ───────────────────────── interactions ─────────────────────────

  function submitSettings() {
    var settings = {};
    var inputs = app.querySelectorAll('[data-setting]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      settings[el.getAttribute('data-setting')] = el.type === 'checkbox' ? el.checked : parseInt(el.value, 10);
    }
    send({ type: 'settings', settings: settings });
  }

  function doCreateOrJoin(kind) {
    var nameEl = document.getElementById('name');
    var name = (nameEl.value || '').trim();
    if (!name) { toast('Enter a name first.', true); nameEl.focus(); return; }
    S.name = name;
    store.set('cabo.name', name);
    if (kind === 'create') {
      send({ type: 'create', name: name });
    } else {
      var codeEl = document.getElementById('code');
      var code = (codeEl ? codeEl.value : S.inviteCode).trim().toUpperCase();
      if (code.length < 4) { toast('Enter the join code.', true); return; }
      send({ type: 'join', code: code, name: name });
    }
  }

  function cardClick(btn) {
    var action = btn.getAttribute('data-action');
    var ownerId = btn.getAttribute('data-owner');
    var cardId = btn.getAttribute('data-card');
    switch (action) {
      case 'peekInitial':
        showCard(S.peekCards[ownerId + ':' + cardId]);
        render();
        break;
      case 'give':
        send({ type: 'give', cardId: cardId });
        break;
      case 'swapHeld':
        send({ type: 'swapHeld', cardId: cardId });
        break;
      case 'peek':
        send({ type: 'usePower', playerId: ownerId, cardId: cardId });
        break;
      case 'selectMine':
        S.sel.mine = (S.sel.mine === cardId) ? null : cardId;
        maybeSendSwap();
        render();
        break;
      case 'selectTheirs':
        S.sel.theirs = (S.sel.theirs && S.sel.theirs.cardId === cardId) ? null : { playerId: ownerId, cardId: cardId };
        maybeSendSwap();
        render();
        break;
      case 'blocked':
        toast("You've already seen that card, so it can't be blind swapped.", true);
        break;
    }
  }

  function maybeSendSwap() {
    if (S.sel.mine && S.sel.theirs) {
      send({ type: 'usePower', myCardId: S.sel.mine, playerId: S.sel.theirs.playerId, theirCardId: S.sel.theirs.cardId });
      S.sel = { mine: null, theirs: null };
    }
  }

  function doAction(action, btn) {
    switch (action) {
      case 'create': case 'join': doCreateOrJoin(action); break;
      case 'leave':
        if (S.game && S.game.status === 'playing' && !confirm('Leave the game? Your seat stays open until the host ends it.')) return;
        send({ type: 'leave' });
        break;
      case 'copy':
        var link = location.origin + location.pathname + '?code=' + S.code;
        if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { toast('Invite link copied.'); }, function () { prompt('Copy this link', link); });
        else prompt('Copy this link', link);
        break;
      case 'kick': send({ type: 'kick', playerId: btn.getAttribute('data-player') }); break;
      case 'start': send({ type: 'start' }); break;
      case 'endGame': send({ type: 'endGame' }); break;
      case 'ready': if (S.game && S.game.status === 'peek') clearReveals(); send({ type: 'ready' }); break;
      case 'draw': send({ type: 'draw' }); break;
      case 'discardHeld': send({ type: 'discardHeld' }); break;
      case 'cabo':
        if (confirm('Call Cabo? Everyone else gets one more turn, then the round ends.')) send({ type: 'cabo' });
        break;
      case 'skipPower': S.sel = { mine: null, theirs: null }; send({ type: 'skipPower' }); break;
      case 'confirmSwap': send({ type: 'confirmSwap', swap: btn.getAttribute('data-swap') === '1' }); break;
    }
  }

  app.addEventListener('click', function (ev) {
    if (S.suppressClick) { S.suppressClick = false; ev.preventDefault(); return; }
    var btn = ev.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    if (btn.hasAttribute('data-owner')) return cardClick(btn);
    doAction(btn.getAttribute('data-action'), btn);
  });

  app.addEventListener('input', function (ev) {
    if (ev.target.id === 'name') S.name = ev.target.value;
  });

  app.addEventListener('change', function (ev) {
    if (ev.target.hasAttribute('data-setting') && isHost()) submitSettings();
  });

  // ───────────────────────── drag & drop ─────────────────────────
  //
  // The drawn card drags onto the played pile (play it) or onto one of my
  // cards (swap). During the match window any card drags onto the played pile.

  var pending = null; // pointerdown that may become a drag

  function dragStillValid() {
    if (!S.drag) return false;
    if (S.drag.kind === 'held') return canPlay();
    return canMatch();
  }

  function dropTargetAt(x, y) {
    var el = document.elementFromPoint(x, y);
    var t = el && el.closest('[data-drop]');
    if (!t) return null;
    var kind = t.getAttribute('data-drop');
    if (S.drag.kind === 'held' && (kind === 'pile' || kind === 'slot')) return t;
    if (S.drag.kind === 'match' && kind === 'pile') return t;
    return null;
  }

  function moveGhost(x, y) {
    var d = S.drag;
    d.ghost.style.transform = 'translate(' + (x - d.ox) + 'px,' + (y - d.oy) + 'px) rotate(' + Math.max(-10, Math.min(10, (x - d.lastX) * 0.6)) + 'deg)';
    d.lastX = x;
  }

  function startDrag(p, ev) {
    var src = p.el;
    var rect = src.getBoundingClientRect();
    var ghost = src.cloneNode(true);
    ghost.className = ghost.className.replace(/\b(clickable|deal|draw-in|land|fx-anim)\b/g, '') + ' drag-ghost';
    ghost.removeAttribute('data-drag'); ghost.removeAttribute('data-drop'); ghost.removeAttribute('data-action');
    ghost.style.width = rect.width + 'px'; ghost.style.height = rect.height + 'px';
    ghost.style.left = rect.left + 'px'; ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);
    S.drag = { kind: p.kind, ownerId: p.ownerId, cardId: p.cardId, ghost: ghost, over: null, ox: p.x - rect.left, oy: p.y - rect.top, lastX: p.x };
    S.drag.ox = p.x - rect.left; S.drag.oy = p.y - rect.top;
    moveGhost(ev.clientX, ev.clientY);
    try { app.setPointerCapture(ev.pointerId); } catch (e) {}
    render();
  }

  function cancelDrag() {
    pending = null;
    if (!S.drag) return;
    if (S.drag.ghost && S.drag.ghost.parentNode) S.drag.ghost.parentNode.removeChild(S.drag.ghost);
    S.drag = null;
    var over = app.querySelector('.over');
    if (over) over.classList.remove('over');
    app.classList.remove('drag-held', 'drag-match');
  }

  function finishDrag(ev) {
    var d = S.drag;
    var target = dropTargetAt(ev.clientX, ev.clientY);
    cancelDrag();
    S.suppressClick = true;
    setTimeout(function () { S.suppressClick = false; }, 300);
    if (!target) { render(); return; }
    var kind = target.getAttribute('data-drop');
    if (d.kind === 'held') {
      if (kind === 'pile') send({ type: 'discardHeld' });
      else send({ type: 'swapHeld', cardId: target.getAttribute('data-card') });
    } else if (d.kind === 'match') {
      send({ type: 'snap', ownerId: d.ownerId, cardId: d.cardId });
    }
    render();
  }

  app.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0 || S.drag) return;
    var el = ev.target.closest('[data-drag]');
    if (!el || el.disabled) return;
    pending = { el: el, kind: el.getAttribute('data-drag'), ownerId: el.getAttribute('data-owner'), cardId: el.getAttribute('data-card'), x: ev.clientX, y: ev.clientY };
  });

  document.addEventListener('pointermove', function (ev) {
    if (pending && !S.drag) {
      if (Math.hypot(ev.clientX - pending.x, ev.clientY - pending.y) < 8) return;
      if (!document.contains(pending.el)) { pending = null; return; }
      startDrag(pending, ev);
      pending = null;
    }
    if (!S.drag) return;
    ev.preventDefault();
    moveGhost(ev.clientX, ev.clientY);
    var target = dropTargetAt(ev.clientX, ev.clientY);
    if (target !== S.drag.over) {
      if (S.drag.over) S.drag.over.classList.remove('over');
      S.drag.over = target;
      if (target) target.classList.add('over');
    }
  }, { passive: false });

  document.addEventListener('pointerup', function (ev) {
    pending = null;
    if (S.drag) finishDrag(ev);
  });
  document.addEventListener('pointercancel', function () { pending = null; if (S.drag) { cancelDrag(); render(); } });

  // ───────────────────────── keyboard ─────────────────────────

  function myCardAt(n) {
    var me = playerById(S.me);
    if (!me) return null;
    var el = app.querySelectorAll('.seat.me .grid > *')[n];
    return el && el.classList.contains('card') && el.hasAttribute('data-action') && !el.disabled ? el : null;
  }

  document.addEventListener('keydown', function (ev) {
    var tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (ev.key !== 'Enter') return;
      if (ev.target.id === 'name') doCreateOrJoin((S.inviteCode || (document.getElementById('code') || {}).value) ? 'join' : 'create');
      if (ev.target.id === 'code') doCreateOrJoin('join');
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (S.screen !== 'game' || !S.game) return;
    var g = S.game, key = ev.key.toLowerCase();
    var handled = true;
    if (key === 'escape') { S.sel = { mine: null, theirs: null }; cancelDrag(); render(); }
    else if (key === 'd') { if (canDraw()) send({ type: 'draw' }); else handled = false; }
    else if (key === ' ' || key === 'p') { if (canPlay()) send({ type: 'discardHeld' }); else handled = false; }
    else if (key === 'enter' || key === 'r') { if (canReady()) doAction('ready'); else handled = false; }
    else if (key === 's') { if (g.status === 'playing' && g.phase === 'power' && g.turnPlayerId === S.me) doAction('skipPower'); else handled = false; }
    else if (key === 'y' || key === 'n') {
      if (g.status === 'playing' && g.phase === 'power' && g.power && g.power.stage === 'decide' && g.turnPlayerId === S.me) send({ type: 'confirmSwap', swap: key === 'y' });
      else handled = false;
    }
    else if (key === 'c') { if (canDraw() && !g.caboCallerId) doAction('cabo'); else handled = false; }
    else if (key >= '1' && key <= '9') { var el = myCardAt(parseInt(key, 10) - 1); if (el) cardClick(el); else handled = false; }
    else handled = false;
    if (handled) ev.preventDefault();
  });

  window.addEventListener('blur', function () { if (S.drag) { cancelDrag(); render(); } });

  render();
  connect();
})();
