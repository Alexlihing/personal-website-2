'use strict';

// Cabo lobby + WebSocket server.
//
//   GET  /secret-cabo        → the game client (public/)
//   WS   /secret-cabo/ws     → lobby and game messages
//   GET  /*                  → the rest of the personal website (parent folder)
//
// Run with `npm start`. PORT and SERVE_SITE can be set in the environment.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SERVE_SITE = process.env.SERVE_SITE !== 'false';
const SITE_DIR = path.resolve(__dirname, '..');
const LOBBY_IDLE_MS = 2 * 60 * 60 * 1000; // delete lobbies nobody has touched in 2h
const LOBBY_DISCONNECT_GRACE_MS = 60 * 1000; // drop disconnected players from a waiting lobby after 60s

const DEFAULT_SETTINGS = { handSize: 4 };

// ───────────────────────── http ─────────────────────────

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.use('/secret-cabo', (req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// Serve the page at /secret-cabo with or without a trailing slash and never
// redirect: proxies in front of this server (Netlify) strip the slash.
app.get('/secret-cabo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/secret-cabo', express.static(path.join(__dirname, 'public'), { redirect: false }));

if (SERVE_SITE) {
  // Never expose this folder (server source, node_modules) through the site.
  app.use('/cabo', (req, res) => res.status(404).end());
  app.use(express.static(SITE_DIR, { extensions: ['html'] }));
}

const server = http.createServer(app);

// ───────────────────────── lobbies ─────────────────────────

const lobbies = new Map(); // code → lobby

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  } while (lobbies.has(code));
  return code;
}

function cleanName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!name) throw new Error('Enter a name first.');
  return name;
}

function cleanSettings(raw, base) {
  const s = { ...base };
  if (raw && typeof raw === 'object' && raw.handSize !== undefined) s.handSize = parseInt(raw.handSize, 10);
  if (!Number.isInteger(s.handSize) || s.handSize < 1 || s.handSize > 8) throw new Error('Hand size must be between 1 and 8.');
  return s;
}

function lobbyView(lobby) {
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    settings: lobby.settings,
    inGame: !!lobby.game,
    players: lobby.players.map((p) => ({ id: p.id, name: p.name, connected: p.sockets.size > 0 })),
  };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(lobby) {
  lobby.lastActive = Date.now();
  const base = lobbyView(lobby);
  for (const p of lobby.players) {
    const msg = { type: 'state', lobby: base, me: p.id, game: lobby.game ? lobby.game.viewFor(p.id) : null };
    for (const ws of p.sockets) send(ws, msg);
  }
}

function flushReveals(lobby) {
  if (!lobby.game) return;
  const reveals = lobby.game.reveals.splice(0);
  for (const r of reveals) {
    const targets = r.to === 'all' ? lobby.players : lobby.players.filter((p) => p.id === r.to);
    for (const p of targets) {
      for (const ws of p.sockets) send(ws, { type: 'reveal', cards: r.cards, reason: r.reason, sticky: r.sticky });
    }
  }
}

function pruneLobby(lobby) {
  if (lobby.game) return;
  const now = Date.now();
  lobby.players = lobby.players.filter((p) => p.sockets.size > 0 || now - p.disconnectedAt < LOBBY_DISCONNECT_GRACE_MS);
  if (lobby.players.length === 0) {
    lobbies.delete(lobby.code);
    return;
  }
  if (!lobby.players.some((p) => p.id === lobby.hostId)) {
    lobby.hostId = lobby.players[0].id;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const lobby of [...lobbies.values()]) {
    const anyoneConnected = lobby.players.some((p) => p.sockets.size > 0);
    if (!anyoneConnected && now - lobby.lastActive > LOBBY_IDLE_MS) {
      lobbies.delete(lobby.code);
      continue;
    }
    const before = lobby.players.length;
    pruneLobby(lobby);
    if (lobbies.has(lobby.code) && lobby.players.length !== before) broadcast(lobby);
  }
}, 15 * 1000).unref();

// ───────────────────────── websocket ─────────────────────────

const wss = new WebSocketServer({ server, path: '/secret-cabo/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Per-connection session: which lobby/player this socket speaks for.
  const session = { token: null, lobby: null, player: null };

  function attach(lobby, player) {
    session.lobby = lobby;
    session.player = player;
    player.sockets.add(ws);
    player.disconnectedAt = null;
  }

  function detach() {
    const { lobby, player } = session;
    if (!lobby || !player) return;
    player.sockets.delete(ws);
    if (player.sockets.size === 0) player.disconnectedAt = Date.now();
    session.lobby = null;
    session.player = null;
    if (lobbies.has(lobby.code)) broadcast(lobby);
  }

  function requireLobby() {
    if (!session.lobby || !session.player) throw new Error('You are not in a lobby.');
    if (!lobbies.has(session.lobby.code)) throw new Error('That lobby no longer exists.');
    return session;
  }

  function requireHost() {
    const s = requireLobby();
    if (s.lobby.hostId !== s.player.id) throw new Error('Only the host can do that.');
    return s;
  }

  function requireGame() {
    const s = requireLobby();
    if (!s.lobby.game) throw new Error('No game in progress.');
    return s;
  }

  const handlers = {
    hello({ token }) {
      session.token = typeof token === 'string' && token.length >= 8 ? token.slice(0, 64) : crypto.randomBytes(16).toString('hex');
      send(ws, { type: 'hello', token: session.token });
    },

    create({ name, settings }) {
      if (session.lobby) detach();
      const lobby = {
        code: newCode(),
        hostId: null,
        settings: cleanSettings(settings, DEFAULT_SETTINGS),
        players: [],
        game: null,
        lastActive: Date.now(),
      };
      const player = { id: crypto.randomBytes(4).toString('hex'), token: session.token, name: cleanName(name), sockets: new Set(), disconnectedAt: null };
      lobby.players.push(player);
      lobby.hostId = player.id;
      lobbies.set(lobby.code, lobby);
      attach(lobby, player);
      send(ws, { type: 'joined', code: lobby.code });
      broadcast(lobby);
    },

    join({ code, name }) {
      const lobby = lobbies.get(String(code || '').trim().toUpperCase());
      if (!lobby) throw new Error('No lobby with that code.');
      if (session.lobby && session.lobby !== lobby) detach();
      let player = lobby.players.find((p) => p.token === session.token);
      if (!player) {
        if (lobby.game) throw new Error('That lobby is mid-game. Ask the host to end the game, then join.');
        player = { id: crypto.randomBytes(4).toString('hex'), token: session.token, name: cleanName(name), sockets: new Set(), disconnectedAt: null };
        lobby.players.push(player);
      } else if (name && !lobby.game) {
        player.name = cleanName(name);
      }
      attach(lobby, player);
      send(ws, { type: 'joined', code: lobby.code });
      broadcast(lobby);
    },

    // Reconnect after a refresh: only succeeds if the token still has a seat.
    rejoin({ code }) {
      const lobby = lobbies.get(String(code || '').trim().toUpperCase());
      const player = lobby && lobby.players.find((p) => p.token === session.token);
      if (!lobby || !player) {
        send(ws, { type: 'left' });
        return;
      }
      attach(lobby, player);
      send(ws, { type: 'joined', code: lobby.code });
      broadcast(lobby);
      // Re-send the initial peek if the player is still in that phase.
      if (lobby.game && lobby.game.status === 'peek') {
        const gp = lobby.game.players.find((p) => p.id === player.id);
        if (gp && !gp.ready) {
          const cards = lobby.game.initialPeekCards(player.id).map((c) => ({ ownerId: player.id, id: c.id, rank: c.rank, suit: c.suit, value: c.value }));
          if (cards.length) send(ws, { type: 'reveal', cards, reason: 'Memorize your cards, then press Ready.', sticky: true });
        }
      }
    },

    leave() {
      const { lobby, player } = session;
      if (!lobby) return;
      player.sockets.delete(ws);
      session.lobby = null;
      session.player = null;
      if (!lobby.game) {
        lobby.players = lobby.players.filter((p) => p !== player);
        pruneLobby(lobby);
      } else if (player.sockets.size === 0) {
        player.disconnectedAt = Date.now();
      }
      send(ws, { type: 'left' });
      if (lobbies.has(lobby.code)) broadcast(lobby);
    },

    settings({ settings }) {
      const { lobby } = requireHost();
      if (lobby.game) throw new Error('Settings can only be changed between games.');
      lobby.settings = cleanSettings(settings, lobby.settings);
      broadcast(lobby);
    },

    kick({ playerId }) {
      const { lobby, player } = requireHost();
      if (lobby.game) throw new Error('Players can only be removed between games.');
      const target = lobby.players.find((p) => p.id === playerId);
      if (!target || target === player) throw new Error('Pick another player to remove.');
      lobby.players = lobby.players.filter((p) => p !== target);
      for (const s of target.sockets) send(s, { type: 'left', reason: 'The host removed you from the lobby.' });
      target.sockets.clear();
      broadcast(lobby);
    },

    start() {
      const { lobby } = requireHost();
      if (lobby.game && lobby.game.status !== 'finished') throw new Error('A game is already in progress.');
      lobby.game = null;
      pruneLobby(lobby);
      if (lobby.players.length < 2) throw new Error('You need at least 2 players.');
      if (lobby.settings.handSize * lobby.players.length > 46) {
        throw new Error('Not enough cards in the deck for that many players with that hand size.');
      }
      lobby.game = new Game(lobby.players, lobby.settings);
      broadcast(lobby);
      flushReveals(lobby);
    },

    // Host ends a running game (e.g. somebody left) or starts a rematch.
    endGame() {
      const { lobby } = requireHost();
      if (!lobby.game) throw new Error('No game in progress.');
      lobby.game = null;
      pruneLobby(lobby);
      broadcast(lobby);
    },

    // ── in-game actions, forwarded to the Game ──
    ready() { const { lobby, player } = requireGame(); lobby.game.ready(player.id); },
    cabo() { const { lobby, player } = requireGame(); lobby.game.callCabo(player.id); },
    draw() { const { lobby, player } = requireGame(); lobby.game.draw(player.id); },
    discardHeld() { const { lobby, player } = requireGame(); lobby.game.discardHeld(player.id); },
    swapHeld({ cardId }) { const { lobby, player } = requireGame(); lobby.game.swapHeld(player.id, cardId); },
    usePower(payload) { const { lobby, player } = requireGame(); lobby.game.usePower(player.id, payload); },
    skipPower() { const { lobby, player } = requireGame(); lobby.game.skipPower(player.id); },
    confirmSwap({ swap }) { const { lobby, player } = requireGame(); lobby.game.confirmSwap(player.id, !!swap); },
    snap({ ownerId, cardId }) { const { lobby, player } = requireGame(); lobby.game.snap(player.id, ownerId, cardId); },
    give({ cardId }) { const { lobby, player } = requireGame(); lobby.game.give(player.id, cardId); },
  };

  const GAME_ACTIONS = new Set(['ready', 'cabo', 'draw', 'discardHeld', 'swapHeld', 'usePower', 'skipPower', 'confirmSwap', 'snap', 'give']);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    const handler = handlers[msg.type];
    if (!handler) return send(ws, { type: 'error', message: 'Unknown action.' });
    if (msg.type !== 'hello' && !session.token) return send(ws, { type: 'error', message: 'Say hello first.' });
    try {
      handler(msg);
      if (GAME_ACTIONS.has(msg.type) && session.lobby) {
        broadcast(session.lobby);
        flushReveals(session.lobby);
      }
    } catch (err) {
      send(ws, { type: 'error', message: err.message || 'Something went wrong.' });
    }
  });

  ws.on('close', detach);
  ws.on('error', () => {});
});

// Drop dead sockets so disconnects are noticed even without a clean close.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Cabo server listening on http://localhost:${PORT}/secret-cabo`);
  if (SERVE_SITE) console.log(`Also serving the website from ${SITE_DIR}`);
});
