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
const SETTINGS = { handSize: 4 };
const mk = (s = {}) => new Game(P, { ...SETTINGS, ...s });
const cur = (g) => g.players[g.turn];
const other = (g, id) => g.players.find((p) => p.id !== id);
const unseen = (hand, pid) => hand.find((c) => !c.seenBy.includes(pid));
const readyAll = (g) => g.players.forEach((p) => g.ready(p.id));

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
  assert.ok(d.every((c) => !/[AJQK0-9][SHDC]/.test(c.id) || c.id.length === 12));
  const a = shuffle(makeDeck()).map((c) => c.rank + c.suit).join();
  const b = shuffle(makeDeck()).map((c) => c.rank + c.suit).join();
  assert.notEqual(a, b);
});

test('deal, initial peek, ready gate', () => {
  const g = mk();
  assert.equal(g.status, 'peek');
  g.players.forEach((p) => assert.equal(p.hand.length, 4));
  assert.equal(g.deck.length, 52 - 12 - 1);
  assert.equal(g.discard.length, 1);
  assert.equal(g.reveals.length, 3);
  assert.equal(g.reveals[0].cards.length, 2);
  // first two cards are seen by their owner only
  g.players.forEach((p) => {
    assert.deepEqual(p.hand[0].seenBy, [p.id]);
    assert.deepEqual(p.hand[2].seenBy, []);
  });
  throwsMsg(() => g.draw('a'), /not in progress/);
  g.ready('a'); g.ready('b');
  assert.equal(g.status, 'peek');
  g.ready('c');
  assert.equal(g.status, 'playing');
  assert.equal(cur(g).id, 'a');
});

test('view hides other cards and the held card', () => {
  const g = mk(); readyAll(g);
  g.draw('a');
  const va = g.viewFor('a'), vb = g.viewFor('b');
  assert.ok(va.held.card.rank);
  assert.deepEqual(vb.held, {});
  vb.players.forEach((p) => p.cards.forEach((c) => { assert.equal(c.known, undefined); assert.equal(c.rank, undefined); }));
  assert.equal(va.players[0].cards[0].seenByMe, true);
  assert.equal(va.players[0].cards[2].seenByMe, false);
  assert.equal(vb.players[0].cards[0].seenByMe, false);
});

test('initial peek is always two cards, capped by hand size', () => {
  const g = mk();
  assert.equal(g.viewFor('a').initialPeek, 2);
  const g1 = mk({ handSize: 1 });
  assert.equal(g1.viewFor('a').initialPeek, 1);
  assert.equal(g1.reveals[0].cards.length, 1);
});

test('turn order enforced; draw then discard or swap', () => {
  const g = mk(); readyAll(g);
  throwsMsg(() => g.draw('b'), /not your turn/);
  throwsMsg(() => g.discardHeld('a'), /can't do that/);
  g.draw('a');
  throwsMsg(() => g.draw('a'), /can't do that/);
  const held = g.held.card;
  const old = g.players[0].hand[3];
  g.swapHeld('a', old.id);
  assert.equal(g.players[0].hand[3], held);
  assert.equal(g.discard[g.discard.length - 1], old);
  assert.equal(old.seenBy.length, 3, 'discarded card is public');
  assert.ok(held.seenBy.includes('a'));
});

// Take a card matching pred out of wherever it is (deck or a hand). A hand slot
// is refilled from the deck so hand sizes stay the same.
function pull(g, pred) {
  const i = g.deck.findIndex(pred);
  if (i >= 0) return g.deck.splice(i, 1)[0];
  for (const p of g.players) {
    const j = p.hand.findIndex(pred);
    if (j >= 0) { const c = p.hand[j]; p.hand[j] = g.deck.shift(); return c; }
  }
  throw new Error('no such card anywhere');
}

// Force a specific card to be the next draw.
function rig(g, rank) {
  const c = pull(g, (x) => x.rank === rank);
  g.deck.push(c);
  return c;
}

// Put a card of the same rank as the discard top into a hand slot.
function plantMatch(g, playerIdx, slot) {
  const top = g.discard[g.discard.length - 1];
  const c = pull(g, (x) => x.rank === top.rank);
  g.players[playerIdx].hand[slot] = c;
  return c;
}

test('7 peeks own card and marks it seen; power is optional', () => {
  const g = mk(); readyAll(g);
  rig(g, '7');
  g.draw('a'); g.discardHeld('a');
  assert.equal(g.phase, 'power'); assert.equal(g.power.type, 'peekOwn');
  throwsMsg(() => g.usePower('a', { playerId: 'b', cardId: g.players[1].hand[0].id }), /no longer there/);
  g.reveals.length = 0;
  const c = g.players[0].hand[3];
  g.usePower('a', { cardId: c.id });
  assert.ok(c.seenBy.includes('a'));
  assert.equal(g.reveals[0].to, 'a');
  assert.equal(g.reveals[0].cards[0].rank, c.rank);
  assert.equal(cur(g).id, 'b');

  rig(g, '8');
  g.draw('b'); g.discardHeld('b');
  g.skipPower('b');
  assert.equal(cur(g).id, 'c');
});

test('replacing a card plays the replaced card (its power triggers)', () => {
  const g = mk(); readyAll(g);
  // make Ann's 4th card a 9 so the swap-out triggers peekOther
  const nine = pull(g, (c) => c.rank === '9');
  g.players[0].hand[3] = nine;
  g.draw('a');
  g.swapHeld('a', nine.id);
  assert.equal(g.phase, 'power'); assert.equal(g.power.type, 'peekOther');
  throwsMsg(() => g.usePower('a', { playerId: 'a', cardId: g.players[0].hand[0].id }), /opponent/);
  const target = g.players[1].hand[1];
  g.usePower('a', { playerId: 'b', cardId: target.id });
  assert.ok(target.seenBy.includes('a'));
});

test('Jack blind swap refuses cards the actor has seen', () => {
  const g = mk(); readyAll(g);
  rig(g, 'J');
  g.draw('a'); g.discardHeld('a');
  assert.equal(g.power.type, 'blindSwap');
  const seenMine = g.players[0].hand[0];
  const unseenMine = g.players[0].hand[2];
  const theirs = g.players[1].hand[2];
  throwsMsg(() => g.usePower('a', { myCardId: seenMine.id, playerId: 'b', theirCardId: theirs.id }), /already seen/);
  // peeked opponent card is also blocked
  theirs.seenBy.push('a');
  throwsMsg(() => g.usePower('a', { myCardId: unseenMine.id, playerId: 'b', theirCardId: theirs.id }), /already seen/);
  const theirs2 = g.players[1].hand[3];
  g.usePower('a', { myCardId: unseenMine.id, playerId: 'b', theirCardId: theirs2.id });
  assert.equal(g.players[0].hand[2], theirs2);
  assert.equal(g.players[1].hand[3], unseenMine);
  assert.equal(cur(g).id, 'b');
});

test('knowledge travels with the physical card across swaps', () => {
  const g = mk(); readyAll(g);
  rig(g, 'J');
  g.draw('a'); g.discardHeld('a');
  const mine = g.players[0].hand[2];
  const theirs = g.players[1].hand[1]; // Bob has seen this one
  assert.ok(theirs.seenBy.includes('b'));
  g.usePower('a', { myCardId: mine.id, playerId: 'b', theirCardId: theirs.id });
  // Bob still "knows" the card now sitting in Ann's hand; Ann does not.
  assert.ok(g.players[0].hand[2].seenBy.includes('b'));
  assert.ok(!g.players[0].hand[2].seenBy.includes('a'));
});

test('Queen reveals both then optionally swaps', () => {
  const g = mk(); readyAll(g);
  rig(g, 'Q');
  g.draw('a'); g.discardHeld('a');
  assert.equal(g.power.type, 'lookSwap');
  const mine = g.players[0].hand[0], theirs = g.players[2].hand[3];
  g.reveals.length = 0;
  g.usePower('a', { myCardId: mine.id, playerId: 'c', theirCardId: theirs.id });
  assert.equal(g.power.stage, 'decide');
  assert.equal(g.reveals[0].cards.length, 2);
  assert.ok(theirs.seenBy.includes('a'));
  throwsMsg(() => g.usePower('a', { myCardId: mine.id, playerId: 'c', theirCardId: theirs.id }), /Decide/);
  g.confirmSwap('a', true);
  assert.equal(g.players[0].hand[0], theirs);
  assert.equal(g.players[2].hand[3], mine);
  assert.equal(cur(g).id, 'b');

  // keep path
  rig(g, 'Q');
  g.draw('b'); g.discardHeld('b');
  const m2 = g.players[1].hand[0], t2 = g.players[0].hand[1];
  g.usePower('b', { myCardId: m2.id, playerId: 'a', theirCardId: t2.id });
  g.skipPower('b');
  assert.equal(g.players[1].hand[0], m2);
  assert.equal(cur(g).id, 'c');
});

test('matching: own card leaves the hand; wrong guess reveals and penalises', () => {
  const g = mk(); readyAll(g);
  const top = g.discard[g.discard.length - 1];
  // give Bob a card of the same rank as the top, and Cat a different one
  const match = plantMatch(g, 1, 2);
  const wrongCard = g.players[2].hand.find((c) => c.rank !== top.rank);
  const deckBefore = g.deck.length;

  g.snap('c', 'c', wrongCard.id); // Cat guesses wrong on her own card
  assert.equal(g.players[2].hand.length, 5);
  assert.equal(g.deck.length, deckBefore - 1);
  assert.equal(wrongCard.seenBy.length, 3);
  assert.equal(g.reveals[g.reveals.length - 1].to, 'all');

  g.snap('b', 'b', match.id); // Bob matches his own
  assert.equal(g.players[1].hand.length, 3);
  assert.equal(g.discard[g.discard.length - 1], match);
  assert.equal(g.pendingGive, null);
});

test("matching someone else's card gives them one of yours; actions wait for the give", () => {
  const g = mk(); readyAll(g);
  const match = plantMatch(g, 1, 2);

  g.snap('c', 'b', match.id);
  assert.deepEqual(g.pendingGive, { from: 'c', to: 'b' });
  throwsMsg(() => g.draw('a'), /Waiting for Cat/);
  throwsMsg(() => g.give('a', g.players[0].hand[0].id), /nothing to give/);
  const gift = g.players[2].hand[1];
  g.give('c', gift.id);
  assert.equal(g.pendingGive, null);
  assert.equal(g.players[2].hand.length, 3);
  assert.equal(g.players[1].hand.length, 4);
  assert.equal(g.players[1].hand[3], gift);
  assert.ok(gift.seenBy.includes('c'));
  g.draw('a');
});

test('game ends when a player runs out of cards', () => {
  const g = mk({ handSize: 1 }); readyAll(g);
  const match = plantMatch(g, 0, 0);
  g.snap('a', 'a', match.id);
  assert.equal(g.status, 'finished');
  assert.ok(g.result.winners.includes('a'));
  assert.equal(g.result.scores[0].total, 0);
  assert.equal(g.result.scores[0].cards.length, 0);
});

test('cabo gives everyone else one turn, then ends', () => {
  const g = mk(); readyAll(g);
  g.draw('a'); if (g.phase === 'hold') g.discardHeld('a'); if (g.phase === 'power') g.skipPower('a');
  g.callCabo('b');
  assert.equal(g.caboCallerId, 'b');
  assert.equal(cur(g).id, 'c');
  throwsMsg(() => g.callCabo('c'), /already been called/);
  g.draw('c'); g.discardHeld('c'); if (g.phase === 'power') g.skipPower('c');
  assert.equal(cur(g).id, 'a');
  g.draw('a'); g.discardHeld('a'); if (g.phase === 'power') g.skipPower('a');
  assert.equal(g.status, 'finished');
  const expected = g.players.map((p) => p.hand.reduce((s, c) => s + c.value, 0));
  assert.deepEqual(g.result.scores.map((s) => s.total), expected);
  const min = Math.min(...expected);
  assert.deepEqual(g.result.winners, g.players.filter((p, i) => expected[i] === min).map((p) => p.id));
  const v = g.viewFor('b');
  assert.ok(v.players[0].cards.every((c) => c.known));
});

test('draw pile reshuffles from the discard pile when empty', () => {
  const g = mk(); readyAll(g);
  g.discard.push(...g.deck.splice(0));
  assert.equal(g.deck.length, 0);
  const top = g.discard[g.discard.length - 1];
  g.draw('a');
  assert.ok(g.held.card);
  assert.equal(g.discard.length, 1);
  assert.equal(g.discard[0], top);
  assert.equal(g.deck.length, 52 - 12 - 1 - 1);
});

test('power is skipped automatically when it cannot be used', () => {
  const g = new Game(P.slice(0, 2), { handSize: 1 });
  readyAll(g);
  // Bob has no cards: a 9 (peek other) cannot be used by Ann
  g.players[1].hand = [];
  rig(g, '9');
  g.draw('a'); g.discardHeld('a');
  assert.equal(g.status, 'finished');
});

console.log(`\n${passed} passed`);
