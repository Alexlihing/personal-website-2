'use strict';
const assert = require('assert');
const { Game, cardValue, makeDeck, shuffle } = require('../game');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}
const throwsMsg = (fn, re) => assert.throws(fn, (e) => re.test(e.message) || (() => { throw new Error('unexpected: ' + e.message); })());

const P = [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Cat' }];
const SETTINGS = { handSize: 4, firstTurn: 0 };
const mk = (s = {}) => new Game(P, { ...SETTINGS, ...s });
const cur = (g) => g.players[g.turn];
const readyAll = (g) => g.players.forEach((p) => g.ready(p.id));
const top = (g) => g.discard[g.discard.length - 1];
const count = (p) => p.hand.filter(Boolean).length;
const total = (p) => p.hand.filter(Boolean).reduce((s, c) => s + c.value, 0);
const lastMove = (g) => g.moves[g.moves.length - 1];

// Take a card matching pred out of wherever it is (deck or a hand). A hand slot
// is refilled from the deck so hand sizes stay the same.
function pull(g, pred) {
  const i = g.deck.findIndex(pred);
  if (i >= 0) return g.deck.splice(i, 1)[0];
  for (const p of g.players) {
    const j = p.hand.findIndex((c) => c && pred(c));
    if (j >= 0) { const c = p.hand[j]; p.hand[j] = g.deck.shift(); return c; }
  }
  throw new Error('no such card anywhere');
}
// Force a specific card to be the next draw.
function rig(g, rank) { const c = pull(g, (x) => x.rank === rank); g.deck.push(c); return c; }
// Put a card of the same rank as the top of the played pile into a hand slot.
function plantMatch(g, playerIdx, slot) {
  const c = pull(g, (x) => x.rank === top(g).rank);
  g.players[playerIdx].hand[slot] = c;
  return c;
}
// Current player draws and plays the drawn card, skipping any power. Ends in the settle window.
function playThrough(g) {
  const id = cur(g).id;
  g.draw(id); g.discardHeld(id);
  if (g.phase === 'power') g.skipPower(id);
  assert.equal(g.phase, 'settle');
}

test('card values', () => {
  assert.equal(cardValue('A', 'S'), 1);
  assert.equal(cardValue('10', 'D'), 10);
  assert.equal(cardValue('J', 'C'), 10);
  assert.equal(cardValue('K', 'S'), 10);
  assert.equal(cardValue('K', 'H'), -1);
});

test('deck is 52 unique cards with opaque ids, shuffled', () => {
  const d = makeDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d.map((c) => c.rank + c.suit)).size, 52);
  assert.equal(new Set(d.map((c) => c.id)).size, 52);
  const a = shuffle(makeDeck()).map((c) => c.rank + c.suit).join();
  const b = shuffle(makeDeck()).map((c) => c.rank + c.suit).join();
  assert.notEqual(a, b);
});

test('deal: no starting card on the pile, bottom row peeked, ready gate', () => {
  const g = mk();
  assert.equal(g.status, 'peek');
  g.players.forEach((p) => assert.equal(p.hand.length, 4));
  assert.equal(g.deck.length, 52 - 12);
  assert.equal(g.discard.length, 0);
  assert.equal(g.reveals.length, 3);
  assert.equal(g.reveals[0].cards.length, 2);
  g.players.forEach((p) => {
    assert.deepEqual(p.hand[0].seenBy, []);
    assert.deepEqual(p.hand[1].seenBy, []);
    assert.deepEqual(p.hand[2].seenBy, [p.id]);
    assert.deepEqual(p.hand[3].seenBy, [p.id]);
  });
  assert.deepEqual(g.initialPeekCards('a'), g.players[0].hand.slice(2));
  throwsMsg(() => g.draw('a'), /not in progress/);
  g.ready('a'); g.ready('b');
  assert.equal(g.status, 'peek');
  g.ready('c');
  assert.equal(g.status, 'playing');
  assert.equal(cur(g).id, 'a');
});

test('starting player is random', () => {
  const seen = new Set();
  for (let i = 0; i < 60 && seen.size < 3; i++) {
    const g = new Game(P, { handSize: 4 }); readyAll(g);
    seen.add(cur(g).id);
  }
  assert.equal(seen.size, 3);
});

test('initial peek is two cards, capped by hand size', () => {
  assert.equal(mk().viewFor('a').initialPeek, 2);
  const g1 = mk({ handSize: 1 });
  assert.equal(g1.viewFor('a').initialPeek, 1);
  assert.equal(g1.reveals[0].cards.length, 1);
});

test('view hides other cards and the held card', () => {
  const g = mk(); readyAll(g);
  g.draw('a');
  const va = g.viewFor('a'), vb = g.viewFor('b');
  assert.ok(va.held.card.rank);
  assert.deepEqual(vb.held, {});
  vb.players.forEach((p) => p.cards.forEach((c) => { assert.equal(c.known, undefined); assert.equal(c.rank, undefined); }));
  assert.equal(va.players[0].cards[3].seenByMe, true);
  assert.equal(va.players[0].cards[0].seenByMe, false);
  assert.equal(vb.players[0].cards[3].seenByMe, false);
});

test('turn order enforced; draw then play or swap; then a settle window', () => {
  const g = mk(); readyAll(g);
  throwsMsg(() => g.draw('b'), /not your turn/);
  throwsMsg(() => g.discardHeld('a'), /can't do that/);
  g.draw('a');
  throwsMsg(() => g.draw('a'), /can't do that/);
  const held = g.held.card;
  const old = g.players[0].hand[0];
  g.swapHeld('a', old.id);
  assert.equal(g.players[0].hand[0], held);
  assert.equal(top(g), old);
  assert.equal(old.seenBy.length, 3, 'played card is public');
  assert.ok(held.seenBy.includes('a'));
  if (g.phase === 'power') g.skipPower('a');
  assert.equal(g.phase, 'settle');
  assert.equal(cur(g).id, 'a', 'turn does not advance until everyone is ready');
  throwsMsg(() => g.draw('b'), /not your turn/);
  g.ready('a'); g.ready('b');
  assert.equal(g.phase, 'settle');
  g.ready('c');
  assert.equal(g.phase, 'draw');
  assert.equal(cur(g).id, 'b');
  throwsMsg(() => g.ready('a'), /Nothing to get ready/);
});

test('7 peeks own card and marks it seen; power is optional', () => {
  const g = mk(); readyAll(g);
  rig(g, '7');
  g.draw('a'); g.discardHeld('a');
  assert.equal(g.phase, 'power'); assert.equal(g.power.type, 'peekOwn');
  throwsMsg(() => g.usePower('a', { playerId: 'b', cardId: g.players[1].hand[0].id }), /no longer there/);
  g.reveals.length = 0;
  const c = g.players[0].hand[0];
  g.usePower('a', { cardId: c.id });
  assert.ok(c.seenBy.includes('a'));
  assert.equal(g.reveals[0].to, 'a');
  assert.equal(g.reveals[0].cards[0].rank, c.rank);
  assert.equal(g.phase, 'settle');
  readyAll(g);
  assert.equal(cur(g).id, 'b');

  rig(g, '8');
  g.draw('b'); g.discardHeld('b');
  g.skipPower('b');
  readyAll(g);
  assert.equal(cur(g).id, 'c');
});

test('replacing a card plays the replaced card (its power triggers)', () => {
  const g = mk(); readyAll(g);
  const nine = pull(g, (c) => c.rank === '9');
  g.players[0].hand[0] = nine;
  g.draw('a');
  g.swapHeld('a', nine.id);
  assert.equal(g.phase, 'power'); assert.equal(g.power.type, 'peekOther');
  throwsMsg(() => g.usePower('a', { playerId: 'a', cardId: g.players[0].hand[1].id }), /opponent/);
  const target = g.players[1].hand[1];
  g.usePower('a', { playerId: 'b', cardId: target.id });
  assert.ok(target.seenBy.includes('a'));
  assert.equal(g.phase, 'settle');
});

test('Jack blind swap refuses cards the actor has seen', () => {
  const g = mk(); readyAll(g);
  rig(g, 'J');
  g.draw('a'); g.discardHeld('a');
  assert.equal(g.power.type, 'blindSwap');
  const seenMine = g.players[0].hand[3];
  const unseenMine = g.players[0].hand[0];
  const theirs = g.players[1].hand[0];
  throwsMsg(() => g.usePower('a', { myCardId: seenMine.id, playerId: 'b', theirCardId: theirs.id }), /already seen/);
  theirs.seenBy.push('a');
  throwsMsg(() => g.usePower('a', { myCardId: unseenMine.id, playerId: 'b', theirCardId: theirs.id }), /already seen/);
  const theirs2 = g.players[1].hand[1];
  g.usePower('a', { myCardId: unseenMine.id, playerId: 'b', theirCardId: theirs2.id });
  assert.equal(g.players[0].hand[0], theirs2);
  assert.equal(g.players[1].hand[1], unseenMine);
  readyAll(g);
  assert.equal(cur(g).id, 'b');
});

test('knowledge travels with the physical card across swaps', () => {
  const g = mk(); readyAll(g);
  rig(g, 'J');
  g.draw('a'); g.discardHeld('a');
  const mine = g.players[0].hand[0];
  const theirs = g.players[1].hand[3]; // Bob has seen this one
  assert.ok(theirs.seenBy.includes('b'));
  g.usePower('a', { myCardId: mine.id, playerId: 'b', theirCardId: theirs.id });
  assert.ok(g.players[0].hand[0].seenBy.includes('b'));
  assert.ok(!g.players[0].hand[0].seenBy.includes('a'));
});

test('Queen reveals both then optionally swaps', () => {
  const g = mk(); readyAll(g);
  rig(g, 'Q');
  g.draw('a'); g.discardHeld('a');
  assert.equal(g.power.type, 'lookSwap');
  const mine = g.players[0].hand[0], theirs = g.players[2].hand[1];
  g.reveals.length = 0;
  g.usePower('a', { myCardId: mine.id, playerId: 'c', theirCardId: theirs.id });
  assert.equal(g.power.stage, 'decide');
  assert.equal(g.reveals[0].cards.length, 2);
  assert.ok(theirs.seenBy.includes('a'));
  throwsMsg(() => g.usePower('a', { myCardId: mine.id, playerId: 'c', theirCardId: theirs.id }), /Decide/);
  g.confirmSwap('a', true);
  assert.equal(g.players[0].hand[0], theirs);
  assert.equal(g.players[2].hand[1], mine);
  readyAll(g);
  assert.equal(cur(g).id, 'b');

  rig(g, 'Q');
  g.draw('b'); g.discardHeld('b');
  const m2 = g.players[1].hand[0], t2 = g.players[0].hand[1];
  g.usePower('b', { myCardId: m2.id, playerId: 'a', theirCardId: t2.id });
  g.skipPower('b');
  assert.equal(g.players[1].hand[0], m2);
  readyAll(g);
  assert.equal(cur(g).id, 'c');
});

test('matching is only allowed in the settle window', () => {
  const g = mk(); readyAll(g);
  throwsMsg(() => g.snap('b', 'b', g.players[1].hand[0].id), /right after a card is played/);
  g.draw('a');
  throwsMsg(() => g.snap('b', 'b', g.players[1].hand[0].id), /right after a card is played/);
});

test('matching: own card leaves the hand; wrong guess stays hidden and costs a penalty card', () => {
  const g = mk(); readyAll(g);
  playThrough(g);
  const match = plantMatch(g, 1, 2);
  const wrongCard = g.players[2].hand.find((c) => c.rank !== top(g).rank);
  const deckBefore = g.deck.length;
  const revealsBefore = g.reveals.length;
  const seenBefore = wrongCard.seenBy.slice();

  g.snap('c', 'c', wrongCard.id);
  assert.equal(count(g.players[2]), 5);
  assert.equal(g.deck.length, deckBefore - 1);
  assert.equal(lastMove(g).type, 'penalty');
  assert.deepEqual(lastMove(g).cards, [{ ownerId: 'c', cardId: g.players[2].hand[4].id }]);
  assert.deepEqual(wrongCard.seenBy, seenBefore, 'wrong guess reveals nothing');
  assert.equal(g.reveals.length, revealsBefore);
  assert.match(g.log[g.log.length - 1].text, /guessed wrong/);

  // a wrong guess on an opponent's card is just as silent
  const annCard = g.players[0].hand.find((c) => c.rank !== top(g).rank);
  g.snap('b', 'a', annCard.id);
  assert.equal(g.reveals.length, revealsBefore);
  assert.equal(count(g.players[1]), 5);

  g.ready('a');
  g.snap('b', 'b', match.id);
  assert.equal(count(g.players[1]), 4);
  assert.equal(g.players[1].hand[2], null, 'the matched card leaves its slot empty');
  assert.equal(g.players[1].hand.length, 5, 'other cards keep their slots');
  assert.deepEqual(lastMove(g), { ...lastMove(g), type: 'match', actorId: 'b', cards: [{ ownerId: 'b', slot: 2 }] });
  assert.equal(top(g), match);
  assert.equal(g.pendingGive, null);
  assert.ok(g.players.every((p) => !p.ready), 'a successful match resets readiness');
});

test("matching someone else's card gives them one of yours; ready waits for the give", () => {
  const g = mk(); readyAll(g);
  playThrough(g);
  const match = plantMatch(g, 1, 2);
  g.snap('c', 'b', match.id);
  assert.deepEqual(g.pendingGive, { from: 'c', to: 'b' });
  throwsMsg(() => g.ready('a'), /Waiting for Cat/);
  throwsMsg(() => g.give('a', g.players[0].hand[0].id), /nothing to give/);
  const gift = g.players[2].hand[3]; // bottom row, so Cat has seen it
  g.give('c', gift.id);
  assert.equal(g.pendingGive, null);
  assert.equal(count(g.players[2]), 3);
  assert.equal(g.players[2].hand[3], null, 'giving a card leaves the slot empty');
  assert.equal(count(g.players[1]), 4);
  assert.equal(g.players[1].hand[2], gift, 'the received card fills the empty slot');
  assert.ok(gift.seenBy.includes('c'));
  assert.deepEqual(lastMove(g).cards, [{ ownerId: 'b', cardId: gift.id }]);
  readyAll(g);
  assert.equal(cur(g).id, 'b');
  g.draw('b');
});

test('game ends when a player runs out of cards', () => {
  const g = mk({ handSize: 1 }); readyAll(g);
  playThrough(g);
  const match = plantMatch(g, 1, 0);
  g.snap('b', 'b', match.id);
  assert.equal(g.status, 'finished');
  assert.deepEqual(g.result.winners, ['b']);
  assert.equal(g.result.scores[1].total, 0);
  assert.equal(g.result.scores[1].cards.length, 0);
});

test('cabo gives everyone else one turn, then ends', () => {
  const g = mk(); readyAll(g);
  playThrough(g); readyAll(g);
  g.callCabo('b');
  assert.equal(g.caboCallerId, 'b');
  assert.equal(cur(g).id, 'c');
  throwsMsg(() => g.callCabo('c'), /already been called/);
  playThrough(g); readyAll(g);
  assert.equal(cur(g).id, 'a');
  playThrough(g);
  assert.equal(g.status, 'playing', 'last play still gets a settle window');
  readyAll(g);
  assert.equal(g.status, 'finished');
  const expected = g.players.map(total);
  assert.deepEqual(g.result.scores.map((s) => s.total), expected);
  const min = Math.min(...expected);
  assert.deepEqual(g.result.winners, g.players.filter((p, i) => expected[i] === min).map((p) => p.id));
  assert.ok(g.viewFor('b').players[0].cards.every((c) => c.known));
});

test('every card is used once: the game ends when the draw pile runs out', () => {
  const g = mk(); readyAll(g);
  g.deck.splice(0, g.deck.length - 1); // one card left
  playThrough(g);
  assert.equal(g.deck.length, 0);
  assert.equal(g.status, 'playing', 'the last card still gets its settle window');
  readyAll(g);
  assert.equal(g.status, 'finished');
  assert.match(g.result.reason, /draw pile is empty/);

  const h = mk(); readyAll(h);
  h.deck.length = 0;
  h.draw('a');
  assert.equal(h.status, 'finished');
});

test('a wrong match with an empty deck costs nothing', () => {
  const g = mk(); readyAll(g);
  g.deck.splice(0, g.deck.length - 1);
  playThrough(g);
  const wrong = g.players[1].hand.find((c) => c.rank !== top(g).rank);
  g.snap('b', 'b', wrong.id);
  assert.equal(count(g.players[1]), 4);
  assert.equal(lastMove(g).type, 'penalty');
  assert.deepEqual(lastMove(g).cards, []);
});

test('move feed names the slots a power touched', () => {
  const g = mk(); readyAll(g);
  rig(g, 'Q');
  g.draw('a');
  assert.equal(lastMove(g).type, 'draw');
  g.discardHeld('a');
  assert.equal(lastMove(g).type, 'play');
  const mine = g.players[0].hand[0], theirs = g.players[1].hand[1];
  g.usePower('a', { myCardId: mine.id, playerId: 'b', theirCardId: theirs.id });
  assert.equal(lastMove(g).type, 'look');
  assert.deepEqual(lastMove(g).cards, [{ ownerId: 'a', cardId: mine.id }, { ownerId: 'b', cardId: theirs.id }]);
  g.confirmSwap('a', true);
  assert.equal(lastMove(g).type, 'swap');
  assert.deepEqual(lastMove(g).cards, [{ ownerId: 'a', cardId: theirs.id }, { ownerId: 'b', cardId: mine.id }], 'slots as they are after the swap');
  const view = g.viewFor('c');
  assert.equal(view.log, undefined);
  assert.equal(view.moves[view.moves.length - 1].seq, g.seq);
  assert.ok(view.moves.every((m, i, arr) => i === 0 || m.seq > arr[i - 1].seq));

  readyAll(g);
  g.draw('b');
  const slot = g.players[1].hand[3];
  const held = g.held.card;
  g.swapHeld('b', slot.id);
  assert.equal(lastMove(g).type, 'place');
  assert.deepEqual(lastMove(g).cards, [{ ownerId: 'b', cardId: held.id }]);
  assert.equal(g.players[1].hand[3], held, 'the drawn card takes the exact slot');
});

test('power is skipped automatically when it cannot be used', () => {
  const g = new Game(P.slice(0, 2), { handSize: 1, firstTurn: 0 });
  readyAll(g);
  g.players[1].hand = [];
  rig(g, '9');
  g.draw('a'); g.discardHeld('a');
  assert.equal(g.power, null);
  assert.equal(g.phase, 'settle');
  readyAll(g);
  assert.equal(g.status, 'finished');
});

console.log(`\n${passed} passed`);
