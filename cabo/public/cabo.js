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
    screen: 'home',
    connected: false,
    lobby: null,
    me: null,
    game: null,
    reveals: {},          // "ownerId:cardId" → { rank, suit, value, timer }
    revealNote: '',
    sel: { mine: null, theirs: null },
    snapMode: false,
    ws: null,
    retry: 0,
  };
  store.set('cabo.token', S.token);

  var REVEAL_MS = 10000;
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
    if (S.game) {
      // Drop selections / snap mode when they no longer make sense.
      var myTurn = S.game.turnPlayerId === S.me;
      if (!(myTurn && S.game.phase === 'power')) S.sel = { mine: null, theirs: null };
      if (S.game.status !== 'playing') S.snapMode = false;
      if (S.game.status === 'finished') clearReveals();
    }
    render();
  }

  // ───────────────────────── reveals ─────────────────────────

  function addReveals(msg) {
    S.revealNote = msg.reason || '';
    msg.cards.forEach(function (c) {
      var key = c.ownerId + ':' + c.id;
      if (S.reveals[key] && S.reveals[key].timer) clearTimeout(S.reveals[key].timer);
      var entry = { rank: c.rank, suit: c.suit, value: c.value, timer: null };
      if (!msg.sticky) {
        entry.timer = setTimeout(function () { delete S.reveals[key]; render(); }, REVEAL_MS);
      }
      S.reveals[key] = entry;
    });
  }

  function clearReveals() {
    Object.keys(S.reveals).forEach(function (k) { if (S.reveals[k].timer) clearTimeout(S.reveals[k].timer); });
    S.reveals = {};
    S.revealNote = '';
  }

  function hasReveals() { return Object.keys(S.reveals).length > 0; }

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

  function rankLabel(rank) { return rank; }

  function cardFaceHTML(card, extraCls, attrs) {
    var red = card.suit === 'H' || card.suit === 'D';
    return '<button type="button" class="card ' + (red ? 'red ' : '') + (extraCls || '') + '" ' + (attrs || '') + '>' +
      '<span class="rank">' + rankLabel(card.rank) + '</span><span class="suit">' + SUIT_CHAR[card.suit] + '</span>' +
      '<span class="val">' + card.value + '</span></button>';
  }

  function cardBackHTML(extraCls, attrs, peekMark) {
    return '<button type="button" class="card down ' + (extraCls || '') + '" ' + (attrs || '') + '>' +
      (peekMark ? '<span class="peek">seen</span>' : '') + '</button>';
  }

  // Which click action a given card currently has for me, if any.
  function cardAction(ownerId, card) {
    var g = S.game;
    if (!g || g.status !== 'playing') return null;
    if (S.snapMode) return 'snap';
    if (g.pendingGive) {
      return (g.pendingGive.from === S.me && ownerId === S.me) ? 'give' : null;
    }
    if (g.turnPlayerId !== S.me) return null;
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

  function cardHTML(ownerId, card) {
    var key = ownerId + ':' + card.id;
    var action = cardAction(ownerId, card);
    var cls = '';
    var attrs = 'data-owner="' + ownerId + '" data-card="' + card.id + '"';
    if (action && action !== 'blocked') cls += ' clickable';
    if (action === 'blocked') cls += ' blocked';
    if (action) attrs += ' data-action="' + action + '"';
    if (S.snapMode) cls += ' snap-target';
    if (S.sel.mine === card.id || (S.sel.theirs && S.sel.theirs.cardId === card.id)) cls += ' selected';

    var reveal = S.reveals[key];
    if (reveal) return cardFaceHTML(reveal, cls + ' revealed', attrs);
    if (card.known) return cardFaceHTML(card.known, cls + ' known', attrs);
    return cardBackHTML(cls, attrs, card.seenByMe);
  }

  // ───────────────────────── rendering ─────────────────────────

  var app = document.getElementById('app');

  function render() {
    var html = topbarHTML();
    if (S.screen === 'home') html += homeHTML();
    else if (S.screen === 'lobby') html += lobbyHTML();
    else html += gameHTML();
    app.innerHTML = html;
    var log = document.getElementById('log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function topbarHTML() {
    var status = S.connected ? 'connected' : 'reconnecting…';
    var mid = '';
    if (S.game && S.game.status === 'playing') {
      var turn = S.game.turnPlayerId === S.me ? 'Your turn' : nameOf(S.game.turnPlayerId) + "'s turn";
      mid = '<span class="status live">' + esc(turn) + (S.game.caboCallerId ? ' · CABO called by ' + esc(nameOf(S.game.caboCallerId)) : '') + '</span>';
    }
    var right = S.screen === 'home'
      ? '<span class="status">' + status + '</span>'
      : '<span class="status">' + status + '</span> <button class="btn small" data-action="leave">Leave</button>';
    return '<div class="topbar"><div class="brand">Cabo' + (S.code ? '<small>LOBBY ' + esc(S.code) + '</small>' : '') + '</div>' + mid + '<div>' + right + '</div></div>';
  }

  function homeHTML() {
    var params = new URLSearchParams(location.search);
    var prefill = (params.get('code') || '').toUpperCase();
    return '<div class="centered"><div>' +
      '<div class="panel">' +
        '<div class="home-title"><h1>Cabo</h1><p>Lowest hand wins.</p></div>' +
        '<div class="stack">' +
          '<div class="field"><label for="name">Your name</label><input id="name" type="text" maxlength="20" placeholder="e.g. Alex" value="' + esc(S.name) + '" /></div>' +
          '<button class="btn primary" data-action="create">Create a lobby</button>' +
          '<hr class="divider" />' +
          '<div class="row"><div class="field"><label for="code">Join code</label><input id="code" type="text" maxlength="5" placeholder="ABCDE" style="text-transform:uppercase;font-family:var(--font-mono);letter-spacing:0.2em" value="' + esc(prefill) + '" /></div>' +
          '<button class="btn" data-action="join">Join lobby</button></div>' +
        '</div>' +
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
    var dis = host ? '' : ' disabled';
    return '<div class="centered"><div class="panel" style="max-width:600px">' +
      '<div class="code-display"><div><h2>Join code</h2><div class="code">' + esc(L.code) + '</div></div>' +
        '<button class="btn" data-action="copy">Copy invite link</button></div>' +
      '<h2>Players (' + L.players.length + ')</h2><ul class="player-list">' + players + '</ul>' +
      '<h2>Settings' + (host ? '' : ' <span class="muted">(host only)</span>') + '</h2>' +
      '<div class="settings-grid">' +
        '<div class="field"><label>Cards per player</label><input type="number" min="1" max="8" data-setting="handSize" value="' + s.handSize + '"' + dis + ' /></div>' +
        '<div class="field"><label>You peek at first</label><div class="hint" style="padding:0.55rem 0">' + Math.min(2, s.handSize) + ' card' + (Math.min(2, s.handSize) === 1 ? '' : 's') + '</div></div>' +
      '</div>' +
      '<div class="lobby-actions">' +
        '<span class="hint">' + (host ? 'Start when everyone is in.' : 'Waiting for the host to start.') + '</span>' +
        (host ? '<button class="btn primary" data-action="start"' + (L.players.length < 2 ? ' disabled' : '') + '>Start game</button>' : '') +
      '</div>' +
    '</div></div>';
  }

  function gameHTML() {
    var g = S.game;
    var opponents = g.players.filter(function (p) { return p.id !== S.me; });
    var me = playerById(S.me);

    var html = '<div class="table"><div class="felt">';
    html += '<div class="seats">' + opponents.map(seatHTML).join('') + '</div>';
    html += centerHTML();
    if (g.status === 'finished') html += resultsHTML();
    html += actionsHTML();
    if (me) html += '<div class="my-area">' + seatHTML(me) + '</div>';
    html += '</div>';
    html += '<aside class="side"><h2>Log</h2><div class="log" id="log">' +
      g.log.map(function (e) { return '<div class="entry">' + esc(e.text) + '</div>'; }).join('') + '</div></aside>';
    html += '</div>';
    return html;
  }

  function seatHTML(p) {
    var g = S.game;
    var lp = lobbyPlayer(p.id);
    var cls = 'seat' + (p.id === S.me ? ' me' : '') + (g.turnPlayerId === p.id ? ' turn' : '') + (lp && !lp.connected ? ' offline' : '');
    var tags = '';
    if (g.caboCallerId === p.id) tags += '<span class="tag accent">cabo</span>';
    if (g.status === 'peek') tags += '<span class="tag">' + (p.ready ? 'ready' : 'looking') + '</span>';
    if (lp && !lp.connected) tags += '<span class="tag">offline</span>';
    return '<div class="' + cls + '"><div class="seat-head"><span class="name">' + esc(p.name) + (p.id === S.me ? ' (you)' : '') + '</span>' + tags +
      '<span class="count">' + p.cardCount + ' card' + (p.cardCount === 1 ? '' : 's') + '</span></div>' +
      '<div class="hand">' + p.cards.map(function (c) { return cardHTML(p.id, c); }).join('') + '</div></div>';
  }

  function centerHTML() {
    var g = S.game;
    var myTurn = g.turnPlayerId === S.me;
    var canDraw = g.status === 'playing' && myTurn && g.phase === 'draw' && !g.pendingGive;
    var deck = canDraw
      ? cardBackHTML('clickable', 'data-action="draw" title="Draw"')
      : cardBackHTML('', 'disabled');
    var discard = g.discardTop ? cardFaceHTML(g.discardTop, '', 'disabled') : '<div class="empty"></div>';
    var held = '';
    if (g.held) {
      held = '<div class="pile"><span class="label">' + (myTurn ? 'Drawn' : nameOf(g.turnPlayerId) + ' holds') + '</span>' +
        (g.held.card ? cardFaceHTML(g.held.card, 'big', 'disabled') : cardBackHTML('big', 'disabled')) + '</div>';
    }
    return '<div class="center">' +
      '<div class="pile"><span class="label">Draw · ' + g.deckCount + '</span>' + deck + '</div>' +
      '<div class="pile"><span class="label">Discard · ' + g.discardCount + '</span>' + discard + '</div>' +
      held + '</div>';
  }

  function actionsHTML() {
    var g = S.game;
    var prompt = '';
    var buttons = [];
    var alert = false;
    var myTurn = g.turnPlayerId === S.me;
    var me = playerById(S.me);

    if (hasReveals() && g.status !== 'peek') {
      buttons.push('<button class="btn small" data-action="hideReveals">Hide revealed cards</button>');
    }

    if (g.status === 'peek') {
      var waiting = g.players.filter(function (p) { return !p.ready; }).map(function (p) { return p.name; });
      if (me && me.ready) {
        prompt = 'Waiting for ' + esc(waiting.join(', ')) + ' to finish looking.';
      } else {
        prompt = 'Memorize your highlighted card' + (g.initialPeek > 1 ? 's' : '') + ', then press Ready.';
        buttons.push('<button class="btn primary" data-action="ready">Ready</button>');
      }
    } else if (g.status === 'finished') {
      prompt = esc(g.result.reason);
      if (isHost()) {
        buttons.push('<button class="btn primary" data-action="start">Play again</button>');
        buttons.push('<button class="btn" data-action="endGame">Back to lobby</button>');
      } else {
        prompt += ' Waiting for the host to start another game.';
      }
    } else if (S.snapMode) {
      alert = true;
      prompt = 'Click any face-down card you think is a <strong>' + esc(g.discardTop.rank) + '</strong>. Wrong guesses cost a penalty card.';
      buttons.push('<button class="btn" data-action="snapMode">Cancel</button>');
    } else if (g.pendingGive) {
      if (g.pendingGive.from === S.me) {
        alert = true;
        prompt = 'You matched <strong>' + esc(nameOf(g.pendingGive.to)) + '</strong>\'s card. Click one of your cards to give them.';
      } else {
        prompt = 'Waiting for ' + esc(nameOf(g.pendingGive.from)) + ' to give ' + esc(nameOf(g.pendingGive.to)) + ' a card.';
      }
    } else if (!myTurn) {
      var who = esc(nameOf(g.turnPlayerId));
      if (g.phase === 'draw') prompt = who + ' is drawing…';
      else if (g.phase === 'hold') prompt = who + ' is deciding what to do with the drawn card…';
      else prompt = who + ' may use the ' + esc(g.power.rank) + ' power…';
    } else if (g.phase === 'draw') {
      prompt = '<strong>Your turn.</strong> Draw a card' + (g.caboCallerId ? '. This is your last turn.' : ', or call Cabo.');
      buttons.push('<button class="btn primary" data-action="draw">Draw</button>');
      if (!g.caboCallerId) buttons.push('<button class="btn danger" data-action="cabo">Call Cabo</button>');
    } else if (g.phase === 'hold') {
      prompt = 'You drew a <strong>' + esc(g.held.card.rank + SUIT_CHAR[g.held.card.suit]) + '</strong>. Discard it, or click one of your cards to replace.';
      buttons.push('<button class="btn primary" data-action="discardHeld">Discard it</button>');
    } else if (g.phase === 'power') {
      var t = g.power.type;
      if (g.power.stage === 'decide') {
        alert = true;
        prompt = 'Both cards are revealed to you. Swap them?';
        buttons.push('<button class="btn primary" data-action="confirmSwap" data-swap="1">Swap</button>');
        buttons.push('<button class="btn" data-action="confirmSwap" data-swap="0">Keep</button>');
      } else {
        prompt = '<strong>' + esc(g.power.rank) + ' power:</strong> ' + esc(g.power.label) + '. ';
        if (t === 'peekOwn') prompt += 'Click one of your cards.';
        else if (t === 'peekOther') prompt += 'Click an opponent\'s card.';
        else {
          prompt += (S.sel.mine ? 'Now pick an opponent\'s card.' : 'Pick one of your cards and one opponent card.');
          if (t === 'blindSwap') prompt += ' Faded cards are ones you have already seen.';
        }
        buttons.push('<button class="btn" data-action="skipPower">Skip</button>');
      }
    }

    if (g.status === 'playing' && !S.snapMode && !g.pendingGive && g.discardTop) {
      buttons.push('<button class="btn" data-action="snapMode" title="Claim a face-down card matches the discard pile">Match the ' + esc(g.discardTop.rank) + '</button>');
    }

    var note = (S.revealNote && hasReveals() && g.status !== 'peek') ? ' <span class="muted">(' + esc(S.revealNote) + ')</span>' : '';
    return '<div class="actions' + (alert ? ' alert' : '') + '"><div class="prompt">' + prompt + note + '</div><div class="buttons">' + buttons.join('') + '</div></div>';
  }

  function resultsHTML() {
    var r = S.game.result;
    var sorted = r.scores.slice().sort(function (a, b) { return a.total - b.total; });
    var rows = sorted.map(function (s) {
      var win = r.winners.indexOf(s.id) !== -1;
      return '<tr class="' + (win ? 'winner' : '') + '"><td>' + esc(s.name) + (s.calledCabo ? ' <span class="tag accent">cabo</span>' : '') + (win ? ' <span class="tag">winner</span>' : '') + '</td>' +
        '<td><div class="hand">' + s.cards.map(function (c) { return cardFaceHTML(c, '', 'disabled'); }).join('') + '</div></td>' +
        '<td class="mono">' + s.total + '</td></tr>';
    }).join('');
    return '<div class="results"><h2>Results</h2><table><thead><tr><th>Player</th><th>Hand</th><th>Total</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
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
      var code = (document.getElementById('code').value || '').trim().toUpperCase();
      if (code.length < 4) { toast('Enter the join code.', true); return; }
      send({ type: 'join', code: code, name: name });
    }
  }

  function cardClick(btn) {
    var action = btn.getAttribute('data-action');
    var ownerId = btn.getAttribute('data-owner');
    var cardId = btn.getAttribute('data-card');
    var g = S.game;
    switch (action) {
      case 'snap':
        S.snapMode = false;
        send({ type: 'snap', ownerId: ownerId, cardId: cardId });
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
    if (btn.classList.contains('card')) return cardClick(btn);
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
      case 'ready': clearReveals(); send({ type: 'ready' }); break;
      case 'draw': send({ type: 'draw' }); break;
      case 'discardHeld': send({ type: 'discardHeld' }); break;
      case 'cabo':
        if (confirm('Call Cabo? Everyone else gets one more turn, then the round ends.')) send({ type: 'cabo' });
        break;
      case 'skipPower': S.sel = { mine: null, theirs: null }; send({ type: 'skipPower' }); break;
      case 'confirmSwap': send({ type: 'confirmSwap', swap: btn.getAttribute('data-swap') === '1' }); break;
      case 'snapMode': S.snapMode = !S.snapMode; render(); break;
      case 'hideReveals': clearReveals(); render(); break;
    }
  });

  app.addEventListener('input', function (ev) {
    if (ev.target.id === 'name') S.name = ev.target.value;
  });

  app.addEventListener('change', function (ev) {
    if (ev.target.hasAttribute('data-setting') && isHost()) submitSettings();
  });

  app.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    if (ev.target.id === 'name') doCreateOrJoin(document.getElementById('code').value.trim() ? 'join' : 'create');
    if (ev.target.id === 'code') doCreateOrJoin('join');
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && S.snapMode) { S.snapMode = false; render(); }
  });

  render();
  connect();
})();
