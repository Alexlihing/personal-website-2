'use strict';
// Spawns the server on a spare port and plays through lobby → game → rejoin → match → back to lobby.
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 4000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, SERVE_SITE: 'false' }, stdio: ['ignore', 'pipe', 'inherit'] });

function client(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/secret-cabo/ws`);
  const c = { ws, state: null, code: null, reveals: [], errors: [], msgs: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    c.msgs.push(m);
    if (m.type === 'state') c.state = m;
    if (m.type === 'joined') c.code = m.code;
    if (m.type === 'reveal') c.reveals.push(m);
    if (m.type === 'error') c.errors.push(m.message);
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = (pred, ms = 3000) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() { if (pred(c)) return res(); if (Date.now() - t0 > ms) return rej(new Error('timed out waiting for: ' + pred.toString() + '\n  last moves: ' + JSON.stringify(c.state && c.state.game && c.state.game.moves.slice(-2).map((m) => m.text)) + ' errors: ' + JSON.stringify(c.errors))); setTimeout(poll, 15); })();
  });
  return new Promise((res, rej) => { ws.on('open', () => { c.send({ type: 'hello', token }); res(c); }); ws.on('error', rej); });
}

(async () => {
  await new Promise((res) => server.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }));
  const a = await client('smoke-token-ann'), b = await client('smoke-token-bob');
  a.send({ type: 'create', name: 'Ann' });
  await a.wait((c) => c.code);
  b.send({ type: 'join', code: a.code.toLowerCase(), name: 'Bob' });
  await b.wait((c) => c.state && c.state.lobby.players.length === 2);

  b.send({ type: 'start' });
  await b.wait((c) => c.errors.length === 1);
  assert.match(b.errors[0], /host/);
  b.errors.length = 0; // that error was expected

  a.send({ type: 'settings', settings: { handSize: 3 } });
  await b.wait((c) => c.state.lobby.settings.handSize === 3);

  a.send({ type: 'start' });
  await a.wait((c) => c.reveals.length === 1 && c.state.game && c.state.game.status === 'peek');
  assert.equal(a.reveals[0].cards.length, 2);
  assert.ok(b.state.game.players[0].cards.every((c) => !c.known), 'Bob cannot see Ann\'s cards');

  a.send({ type: 'ready' }); b.send({ type: 'ready' });
  await a.wait((c) => c.state.game.status === 'playing');

  // The starting player is random: whoever it is plays, the other one watches and reconnects.
  const annFirst = a.state.game.turnPlayerId === a.state.me;
  const actor = annFirst ? a : b;
  let watcher = annFirst ? b : a;
  const watcherToken = annFirst ? 'smoke-token-bob' : 'smoke-token-ann';
  const watcherIdx = annFirst ? 1 : 0;
  const actorIdx = annFirst ? 0 : 1;

  actor.send({ type: 'draw' });
  await actor.wait((c) => c.state.game.phase === 'hold');
  assert.ok(actor.state.game.held.card.rank);
  assert.equal(watcher.state.game.held.card, undefined, 'held card hidden from others');
  actor.send({ type: 'discardHeld' });
  await actor.wait((c) => c.state.game.phase !== 'hold');
  if (actor.state.game.phase === 'power') { actor.send({ type: 'skipPower' }); await actor.wait((c) => c.state.game.phase === 'settle'); }
  assert.equal(actor.state.game.phase, 'settle');
  assert.equal(actor.state.game.turnPlayerId, actor.state.me, 'turn waits for everyone to be ready');

  // The watcher drops and comes back on a new socket with the same token, mid settle window.
  watcher.ws.close();
  await actor.wait((c) => !c.state.lobby.players[watcherIdx].connected);
  const w2 = await client(watcherToken);
  await w2.wait((c) => c.msgs.some((m) => m.type === 'hello'));
  w2.send({ type: 'rejoin', code: a.code });
  await w2.wait((c) => c.state && c.state.game);
  assert.equal(w2.state.me, actor.state.lobby.players[watcherIdx].id);
  assert.ok(actor.state.lobby.players[watcherIdx].connected);
  assert.equal(w2.state.game.phase, 'settle');
  watcher = w2;

  // The watcher attempts a match on the actor's first card.
  const target = w2.state.game.players[actorIdx].cards[0];
  const before = w2.state.game.players[actorIdx].cardCount;
  const revealsBefore = actor.reveals.length;
  w2.send({ type: 'snap', ownerId: actor.state.me, cardId: target.id });
  await w2.wait((c) => c.state.game.moves.some((m) => m.type === 'match' || m.type === 'penalty'));
  const g = w2.state.game;
  if (g.pendingGive) {
    assert.equal(g.players[actorIdx].cardCount, before - 1);
    w2.send({ type: 'give', cardId: g.players[watcherIdx].cards[0].id });
    await w2.wait((c) => !c.state.game.pendingGive);
    assert.equal(w2.state.game.players[actorIdx].cardCount, before);
  } else {
    assert.equal(g.players[watcherIdx].cardCount, 4, 'penalty card drawn');
    assert.equal(actor.reveals.length, revealsBefore, 'wrong guess reveals nothing');
  }

  actor.send({ type: 'ready' }); w2.send({ type: 'ready' });
  await actor.wait((c) => c.state.game.phase === 'draw');
  assert.equal(actor.state.game.turnPlayerId, w2.state.me);

  (annFirst ? a : w2).send({ type: 'endGame' }); // Ann is the host; use her live socket
  await watcher.wait((c) => c.state.game === null);
  assert.equal(watcher.state.lobby.players.length, 2);
  assert.deepEqual(actor.errors, []);
  assert.deepEqual(watcher.errors, []);

  console.log('server smoke test ok');
  actor.ws.close(); watcher.ws.close();
  server.kill();
})().catch((e) => { console.error('SMOKE FAIL', e); server.kill(); process.exit(1); });
