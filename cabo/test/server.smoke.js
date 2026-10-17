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
    (function poll() { if (pred(c)) return res(); if (Date.now() - t0 > ms) return rej(new Error('timed out')); setTimeout(poll, 15); })();
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

  a.send({ type: 'settings', settings: { handSize: 3 } });
  await b.wait((c) => c.state.lobby.settings.handSize === 3);

  a.send({ type: 'start' });
  await a.wait((c) => c.reveals.length === 1 && c.state.game && c.state.game.status === 'peek');
  assert.equal(a.reveals[0].cards.length, 2);
  assert.ok(b.state.game.players[0].cards.every((c) => !c.known), 'Bob cannot see Ann\'s cards');

  a.send({ type: 'ready' }); b.send({ type: 'ready' });
  await a.wait((c) => c.state.game.status === 'playing');
  a.send({ type: 'draw' });
  await a.wait((c) => c.state.game.phase === 'hold');
  assert.ok(a.state.game.held.card.rank);
  assert.equal(b.state.game.held.card, undefined, 'held card hidden from others');
  a.send({ type: 'discardHeld' });
  await a.wait((c) => c.state.game.phase !== 'hold');
  if (a.state.game.phase === 'power') { a.send({ type: 'skipPower' }); await a.wait((c) => c.state.game.phase === 'draw'); }
  assert.equal(a.state.game.turnPlayerId, b.state.me);

  // Bob drops and comes back on a new socket with the same token.
  b.ws.close();
  await a.wait((c) => !c.state.lobby.players[1].connected);
  const b2 = await client('smoke-token-bob');
  await b2.wait((c) => c.msgs.some((m) => m.type === 'hello'));
  b2.send({ type: 'rejoin', code: a.code });
  await b2.wait((c) => c.state && c.state.game);
  assert.equal(b2.state.me, a.state.lobby.players[1].id);
  assert.ok(a.state.lobby.players[1].connected);

  // Bob attempts a match on Ann's first card.
  const target = b2.state.game.players[0].cards[0];
  const before = b2.state.game.players[0].cardCount;
  b2.send({ type: 'snap', ownerId: a.state.me, cardId: target.id });
  await b2.wait((c) => c.state.game.log.some((e) => /match/.test(e.text)));
  const g = b2.state.game;
  if (g.pendingGive) {
    assert.equal(g.players[0].cardCount, before - 1);
    b2.send({ type: 'give', cardId: g.players[1].cards[0].id });
    await b2.wait((c) => !c.state.game.pendingGive);
    assert.equal(b2.state.game.players[0].cardCount, before);
  } else {
    assert.equal(g.players[1].cardCount, 4, 'penalty card drawn');
    assert.ok(a.reveals.some((r) => r.cards[0].id === target.id), 'wrong guess revealed to everyone');
  }

  a.send({ type: 'endGame' });
  await b2.wait((c) => c.state.game === null);
  assert.equal(b2.state.lobby.players.length, 2);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b2.errors, []);

  console.log('server smoke test ok');
  a.ws.close(); b2.ws.close();
  server.kill();
})().catch((e) => { console.error('SMOKE FAIL', e); server.kill(); process.exit(1); });
