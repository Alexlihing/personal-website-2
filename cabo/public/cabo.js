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
    logOpen: window.innerWidth > 900,
    ws: null,
    retry: 0,
    prevUp: {},           // face-up card keys at the last render, for flip animations
    dealAnim: false,      // animate the deal on the next render
    lastDrawKey: '',
    lastTopId: '',
    lastTurnMine: false,
    banner: '',
  };
  store.set('cabo.token', S.token);

  var REVEAL_MS = 2000;
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
      S.prevUp = {};
      S.lastDrawKey = ''; S.lastTopId = ''; S.lastTurnMine = false;
    }
    if (S.game) {
      var mineNow = S.game.status === 'playing' && S.game.turnPlayerId === S.me && S.game.phase === 'draw';
      S.banner = (mineNow && !S.lastTurnMine) ? 'Your turn' : '';
      S.lastTurnMine = mineNow;
      var myTurn = S.game.turnPlayerId === S.me;
      if (!(myTurn && S.game.phase === 'power')) S.sel = { mine: null, theirs: null };
      if (S.game.status === 'finished') clearReveals();
    }
    render();
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
  function cardLabel(card) { return card.rank + SUIT_CHAR[card.suit]; }

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
      '<span class="side front">' + front + '</span></span></button>';
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

  var nowUp = {};
  function cardHTML(ownerId, card, index) {
    var key = ownerId + ':' + card.id;
    var action = cardAction(ownerId, card);
    var cls = '';
    var attrs = 'data-owner="' + ownerId + '" data-card="' + card.id + '"';
    if (action && action !== 'blocked') cls += ' clickable';
    if (action === 'blocked') cls += ' blocked';
    if (action) attrs += ' data-action="' + action + '"';
    if (canMatch()) cls += ' matchable';
    if (S.sel.mine === card.id || (S.sel.theirs && S.sel.theirs.cardId === card.id)) cls += ' selected';
    var style = '';
    if (S.dealAnim) { cls += ' deal'; style = '--delay:' + (index * 70) + 'ms'; }

    var face = S.reveals[key] || card.known || null;
    if (face) { nowUp[key] = true; cls += S.reveals[key] ? ' revealed' : ' known'; }
    return cardEl({ up: !!face, card: face, cls: cls, attrs: attrs, style: style, seen: !face && card.seenByMe });
  }

  // ───────────────────────── rendering ─────────────────────────

  var app = document.getElementById('app');

  function render() {
    var html = topbarHTML();
    if (S.screen === 'home') html += homeHTML();
    else if (S.screen === 'lobby') html += lobbyHTML();
    else html += gameHTML();
    nowUp = {};
    app.innerHTML = html;
    app.classList.toggle('in-game', S.screen === 'game');
    var log = document.getElementById('log');
    if (log) log.scrollTop = log.scrollHeight;
    layoutScene();
    S.prevUp = nowUp;
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
    if (S.screen === 'game') right += '<button class="btn small' + (S.logOpen ? ' active' : '') + '" data-action="toggleLog">Log</button>';
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

  // Opponents in turn order starting after me, seated clockwise around the table.
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
    var opps = seatedOpponents();
    var n = g.players.length;

    var html = '<div class="scene three-d" id="scene">' + dustHTML() + '<div class="table3d" id="table3d">';
    for (var d = 6; d >= 1; d--) html += '<div class="edge" style="--d:' + d + '"></div>';
    html += '<div class="felt" id="felt"></div><div class="emblem">CABO</div>';
    opps.forEach(function (p, i) {
      var angle = 90 + 360 * (i + 1) / n; // degrees, 90 = my seat at the bottom
      html += seatHTML(p, angle);
    });
    html += centerHTML() + '</div>';
    if (S.banner) html += '<div class="banner">' + esc(S.banner) + '</div>';
    if (S.logOpen) {
      html += '<div class="log-panel"><h2>Log</h2><div class="log" id="log">' +
        g.log.map(function (e) { return '<div class="entry">' + esc(e.text) + '</div>'; }).join('') + '</div></div>';
    }
    html += '<div class="dock">' + actionsHTML() + (me ? seatHTML(me, 90) : '') + '</div>';
    if (g.status === 'finished') html += resultsHTML();
    html += '</div>';
    return html;
  }

  function dustHTML() {
    var out = '<div class="dust">';
    for (var i = 0; i < 18; i++) {
      var seed = (i * 9301 + 49297) % 233280 / 233280;
      var seed2 = (i * 7919 + 104729) % 233280 / 233280;
      out += '<i style="left:' + (5 + seed * 90) + '%;top:' + (10 + seed2 * 75) + '%;--dur:' + (12 + seed * 14) + 's;--delay:-' + (seed2 * 20) + 's;--dx:' + ((seed - 0.5) * 120) + 'px;--dy:' + (-60 - seed2 * 120) + 'px"></i>';
    }
    return out + '</div>';
  }

  function seatHTML(p, angle) {
    var g = S.game;
    var lp = lobbyPlayer(p.id);
    var mine = p.id === S.me;
    var rot = Math.round(angle - 90);
    var cls = 'seat ' + (mine ? 'me' : 'opp') + (g.turnPlayerId === p.id ? ' turn' : '') + (lp && !lp.connected ? ' offline' : '');
    var tags = '';
    if (g.caboCallerId === p.id) tags += '<span class="tag accent">cabo</span>';
    if (g.status === 'peek' || (g.status === 'playing' && g.phase === 'settle')) tags += p.ready ? '<span class="tag ok">ready</span>' : '';
    if (lp && !lp.connected) tags += '<span class="tag">offline</span>';
    return '<div class="' + cls + '" data-angle="' + angle + '" style="--rot:' + rot + 'deg">' +
      '<div class="label"><span class="name">' + esc(p.name) + (mine ? ' (you)' : '') + '</span>' + tags +
      '<span class="count">' + p.cardCount + '</span></div>' +
      '<div class="grid">' + p.cards.map(function (c, i) { return cardHTML(p.id, c, i); }).join('') + '</div></div>';
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

  function centerHTML() {
    var g = S.game;
    var myTurn = g.turnPlayerId === S.me;
    var canDraw = g.status === 'playing' && myTurn && g.phase === 'draw' && !g.pendingGive;
    var canPlay = g.status === 'playing' && myTurn && g.phase === 'hold';

    var deck = '<div class="stack">' + ghosts(g.deckCount, false) +
      cardEl({ up: false, cls: canDraw ? 'clickable' : '', attrs: canDraw ? 'data-action="draw" title="Draw"' : 'disabled' }) + '</div>';

    var playAttrs = canPlay ? 'data-action="discardHeld" title="Play the drawn card here"' : 'disabled';
    var landed = g.discardTop && g.discardTop.id !== S.lastTopId;
    if (g.discardTop) S.lastTopId = g.discardTop.id;
    var played = '<div class="stack">' + ghosts(g.discardCount, true) +
      (g.discardTop
        ? cardEl({ up: true, card: g.discardTop, cls: (canPlay ? 'clickable drop' : '') + (landed ? ' land' : ''), attrs: playAttrs })
        : '<div class="empty' + (canPlay ? ' clickable drop' : '') + '" ' + playAttrs + '></div>') + '</div>';

    var held = '';
    if (g.held) {
      var drawKey = g.turnPlayerId + ':' + g.deckCount;
      var fresh = drawKey !== S.lastDrawKey;
      S.lastDrawKey = drawKey;
      held = '<div class="pile"><span class="plabel">' + (myTurn ? 'Drawn' : esc(nameOf(g.turnPlayerId)) + ' drew') + '</span>' +
        cardEl({ up: !!g.held.card, card: g.held.card, cls: fresh ? 'draw-in' : '', attrs: 'disabled' }) + '</div>';
    } else {
      S.lastDrawKey = '';
    }
    var live = g.status === 'playing' && g.phase === 'settle';
    return '<div class="center">' +
      '<div class="pile"><span class="plabel">Draw · ' + g.deckCount + '</span>' + deck + '</div>' +
      '<div class="pile' + (live ? ' live' : '') + '"><span class="plabel">Played · ' + g.discardCount + '</span>' + played + '</div>' +
      held + '</div>';
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
        prompt = 'Peek at your bottom row.';
        buttons.push('<button class="btn primary" data-action="ready">Ready</button>');
      }
    } else if (g.status === 'finished') {
      prompt = esc(g.result.reason);
    } else if (g.pendingGive) {
      if (g.pendingGive.from === S.me) {
        alert = true;
        prompt = 'Give <strong>' + esc(nameOf(g.pendingGive.to)) + '</strong> a card.';
      } else {
        prompt = esc(nameOf(g.pendingGive.from)) + ' is giving ' + esc(nameOf(g.pendingGive.to)) + ' a card.';
      }
    } else if (g.phase === 'settle') {
      if (me && me.ready) {
        prompt = 'Waiting for ' + esc(notReady.join(', ')) + '.';
      } else {
        alert = true;
        prompt = 'Match the <strong>' + esc(g.discardTop.rank) + '</strong>?';
        buttons.push('<button class="btn primary" data-action="ready">Ready</button>');
      }
    } else if (!myTurn) {
      prompt = esc(nameOf(g.turnPlayerId)) + "'s turn.";
    } else if (g.phase === 'draw') {
      prompt = '<strong>Your turn.</strong>';
      buttons.push('<button class="btn primary" data-action="draw">Draw</button>');
      if (!g.caboCallerId) buttons.push('<button class="btn danger" data-action="cabo">Call Cabo</button>');
    } else if (g.phase === 'hold') {
      prompt = 'Play it or swap it.';
    } else if (g.phase === 'power') {
      var t = g.power.type;
      if (g.power.stage === 'decide') {
        alert = true;
        prompt = 'Swap?';
        buttons.push('<button class="btn primary" data-action="confirmSwap" data-swap="1">Swap</button>');
        buttons.push('<button class="btn" data-action="confirmSwap" data-swap="0">Keep</button>');
      } else {
        if (t === 'peekOwn') prompt = 'Peek at one of your cards.';
        else if (t === 'peekOther') prompt = "Peek at an opponent's card.";
        else if (t === 'blindSwap') prompt = 'Blind swap.';
        else prompt = 'Look and swap.';
        buttons.push('<button class="btn" data-action="skipPower">Skip</button>');
      }
    }

    return '<div class="actions' + (alert ? ' alert' : '') + '"><div class="prompt">' + prompt + '</div><div class="buttons">' + buttons.join('') + '</div></div>';
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

  // Place opponents evenly around the table. I sit at the bottom (90°); the
  // rest are spread around the remaining arc and rotated to face their seat.
  function layoutScene() {
    var scene = document.getElementById('scene');
    if (!scene) return;
    var box = document.getElementById('table3d') || scene;
    var W = box.clientWidth, H = box.clientHeight;
    var dock = scene.querySelector('.dock');
    var dockH = dock ? dock.offsetHeight * 1.15 : 0;
    var cx = W / 2, cy = H * 0.45;
    var rx = W * 0.40, ry = Math.max(120, (H - dockH) * 0.46);

    var plates = scene.querySelectorAll('.felt, .edge, .emblem');
    for (var k = 0; k < plates.length; k++) {
      var el = plates[k];
      if (!el.classList.contains('emblem')) {
        el.style.width = (rx * 2.6) + 'px';
        el.style.height = (ry * 2.9) + 'px';
      }
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
    }

    var seats = scene.querySelectorAll('.seat.opp');
    for (var i = 0; i < seats.length; i++) {
      var seat = seats[i];
      var a = parseFloat(seat.getAttribute('data-angle')) * Math.PI / 180;
      var x = cx + rx * Math.cos(a);
      var y = cy + ry * Math.sin(a);
      var r = Math.max(seat.offsetWidth, seat.offsetHeight) / 2;
      var topPad = scene.classList.contains('three-d') ? 40 : 8; // keep seats inside the far rim
      x = Math.min(Math.max(x, r + 8), W - r - 8);
      y = Math.min(Math.max(y, r + topPad), H - dockH - r - 8);
      seat.style.left = x + 'px';
      seat.style.top = y + 'px';
      // Keep the name tag clear of the cards whatever the seat's rotation.
      var label = seat.querySelector('.label');
      if (label) {
        var rot = parseFloat(seat.getAttribute('data-angle')) - 90;
        var rad = rot * Math.PI / 180;
        var reach = Math.abs(Math.sin(rad)) * label.offsetWidth / 2 + Math.abs(Math.cos(rad)) * label.offsetHeight / 2;
        label.style.top = -(reach + 12) + 'px';
      }
    }
  }

  window.addEventListener('resize', layoutScene);

  // The table leans a few degrees toward the mouse.
  app.addEventListener('mousemove', function (ev) {
    var t = document.getElementById('table3d');
    if (!t) return;
    var r = app.getBoundingClientRect();
    var px = (ev.clientX - r.left) / r.width - 0.5;
    var py = (ev.clientY - r.top) / r.height - 0.5;
    t.style.setProperty('--tx', (px * 7).toFixed(2) + 'deg');
    t.style.setProperty('--ty', (-py * 5).toFixed(2) + 'deg');
  });
  app.addEventListener('mouseleave', function () {
    var t = document.getElementById('table3d');
    if (t) { t.style.setProperty('--tx', '0deg'); t.style.setProperty('--ty', '0deg'); }
  });

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

  app.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    if (btn.hasAttribute('data-owner')) return cardClick(btn);
    var action = btn.getAttribute('data-action');
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
      case 'toggleLog': S.logOpen = !S.logOpen; render(); break;
    }
  });

  // Double-click (or double-tap) any card during the match window to claim it matches the pile.
  app.addEventListener('dblclick', function (ev) {
    var card = ev.target.closest('.card[data-owner]');
    if (!card || !canMatch()) return;
    ev.preventDefault();
    send({ type: 'snap', ownerId: card.getAttribute('data-owner'), cardId: card.getAttribute('data-card') });
  });

  app.addEventListener('input', function (ev) {
    if (ev.target.id === 'name') S.name = ev.target.value;
  });

  app.addEventListener('change', function (ev) {
    if (ev.target.hasAttribute('data-setting') && isHost()) submitSettings();
  });

  app.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    if (ev.target.id === 'name') doCreateOrJoin((S.inviteCode || (document.getElementById('code') || {}).value) ? 'join' : 'create');
    if (ev.target.id === 'code') doCreateOrJoin('join');
  });

  render();
  connect();
})();
