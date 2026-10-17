'use strict';

// Pure Cabo game logic. No networking in here; server.js drives it.
// Every public action throws an Error with a human readable message when
// it is not allowed, so the server can relay that message to the player.

const crypto = require('crypto');

const INITIAL_PEEK = 2; // every player looks at their first two cards before play starts

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function cardValue(rank, suit) {
  if (rank === 'K' && suit === 'H') return -1;
  if (rank === 'A') return 1;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return parseInt(rank, 10);
}

function powerOf(rank) {
  switch (rank) {
    case '7': case '8': return 'peekOwn';
    case '9': case '10': return 'peekOther';
    case 'J': return 'blindSwap';
    case 'Q': return 'lookSwap';
    default: return null;
  }
}

const POWER_LABEL = {
  peekOwn: 'look at one of your own cards',
  peekOther: "look at one of an opponent's cards",
  blindSwap: "blind swap one of your cards with an opponent's card",
  lookSwap: "look at one of your cards and one opponent card, then optionally swap them",
};

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: crypto.randomBytes(6).toString('hex'), // opaque, never derived from the card
        rank,
        suit,
        value: cardValue(rank, suit),
        seenBy: [], // player ids that have seen this physical card
      });
    }
  }
  return deck;
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function cardName(card) {
  const suitName = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }[card.suit];
  const rankName = { A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' }[card.rank] || card.rank;
  return `${rankName} of ${suitName}`;
}

function publicCard(card) {
  return { id: card.id, rank: card.rank, suit: card.suit, value: card.value };
}

class Game {
  constructor(players, settings) {
    this.settings = settings;
    this.players = players.map((p) => ({ id: p.id, name: p.name, hand: [], ready: false }));
    this.deck = shuffle(makeDeck());
    this.discard = [];
    this.turn = 0;
    this.phase = 'draw'; // draw | hold | power
    this.held = null; // { card }
    this.power = null; // { type, actorId, stage, rank, myCardId?, theirCardId? }
    this.pendingGive = null; // { from, to }
    this.caboCallerId = null;
    this.status = 'peek'; // peek | playing | finished
    this.log = [];
    this.reveals = []; // outbox, drained by the server: { to, cards, reason, sticky }
    this.result = null;

    for (let i = 0; i < settings.handSize; i++) {
      for (const p of this.players) p.hand.push(this.deck.pop());
    }
    this.discard.push(this.deck.pop());
    this._log(`Cards dealt. ${this.players.length} players, ${settings.handSize} cards each.`);

    for (const p of this.players) {
      const cards = this.initialPeekCards(p.id);
      for (const c of cards) this._markSeen(c, p.id);
      this._reveal(p.id, cards.map((c) => ({ ownerId: p.id, ...publicCard(c) })),
        `Memorize your ${cards.length === 1 ? 'card' : 'cards'}, then press Ready.`, true);
    }
  }

  // ───────────────────────── helpers ─────────────────────────

  initialPeekCards(playerId) {
    return this._player(playerId).hand.slice(0, INITIAL_PEEK).map((c) => c);
  }

  _log(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 80) this.log.shift();
  }

  _reveal(to, cards, reason, sticky = false) {
    this.reveals.push({ to, cards, reason, sticky });
  }

  _markSeen(card, playerId) {
    if (playerId === 'all') {
      card.seenBy = this.players.map((p) => p.id);
    } else if (!card.seenBy.includes(playerId)) {
      card.seenBy.push(playerId);
    }
  }

  _player(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) throw new Error('Unknown player.');
    return p;
  }

  _current() {
    return this.players[this.turn];
  }

  _findCard(ownerId, cardId) {
    const owner = this._player(ownerId);
    const index = owner.hand.findIndex((c) => c.id === cardId);
    if (index === -1) throw new Error('That card is no longer there.');
    return { owner, card: owner.hand[index], index };
  }

  _requireTurn(playerId, phase) {
    if (this.status !== 'playing') throw new Error('The game is not in progress.');
    if (this._current().id !== playerId) throw new Error("It's not your turn.");
    if (this.pendingGive) throw new Error(`Waiting for ${this._player(this.pendingGive.from).name} to give a card.`);
    if (phase && this.phase !== phase) throw new Error("You can't do that right now.");
  }

  _drawFromDeck() {
    if (this.deck.length === 0) {
      if (this.discard.length <= 1) return null;
      const top = this.discard.pop();
      this.deck = shuffle(this.discard);
      this.discard = [top];
      this._log('Draw pile empty. Discard pile reshuffled into a new draw pile.');
    }
    return this.deck.pop();
  }

  _beginPlay() {
    this.status = 'playing';
    this.turn = 0;
    this.phase = 'draw';
    this._log(`Game on. ${this._current().name} goes first.`);
  }

  _checkEmptyHands() {
    const empty = this.players.find((p) => p.hand.length === 0);
    if (empty) {
      this._finish(`${empty.name} has no cards left.`);
      return true;
    }
    return false;
  }

  _endTurn() {
    this.held = null;
    this.power = null;
    if (this._checkEmptyHands()) return;
    const next = (this.turn + 1) % this.players.length;
    if (this.caboCallerId && this.players[next].id === this.caboCallerId) {
      this._finish(`The round is over: ${this.players[next].name} called Cabo.`);
      return;
    }
    this.turn = next;
    this.phase = 'draw';
    this._log(`${this._current().name}'s turn.`);
  }

  _finish(reason) {
    this.status = 'finished';
    this.held = null;
    this.power = null;
    this.pendingGive = null;
    const scores = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      total: p.hand.reduce((s, c) => s + c.value, 0),
      cards: p.hand.map(publicCard),
      calledCabo: p.id === this.caboCallerId,
    }));
    const best = Math.min(...scores.map((s) => s.total));
    const winners = scores.filter((s) => s.total === best).map((s) => s.id);
    this.result = { reason, scores, winners };
    const names = scores.filter((s) => winners.includes(s.id)).map((s) => s.name).join(' and ');
    this._log(`${reason} ${names} ${winners.length > 1 ? 'tie' : 'wins'} with ${best}.`);
  }

  _powerFeasible(type, actor) {
    const opponentsWithCards = this.players.some((p) => p.id !== actor.id && p.hand.length > 0);
    if (type === 'peekOwn') return actor.hand.length > 0;
    if (type === 'peekOther') return opponentsWithCards;
    return actor.hand.length > 0 && opponentsWithCards;
  }

  _afterDiscard(actor, card) {
    this.held = null;
    const type = powerOf(card.rank);
    if (type && this._powerFeasible(type, actor)) {
      this.phase = 'power';
      this.power = { type, actorId: actor.id, stage: 'choose', rank: card.rank };
      this._log(`${actor.name} may use the ${card.rank}: ${POWER_LABEL[type]}.`);
    } else {
      this._endTurn();
    }
  }

  _swapCards(a, b) {
    // a and b are { owner, card, index } from _findCard
    a.owner.hand[a.index] = b.card;
    b.owner.hand[b.index] = a.card;
  }

  // ───────────────────────── actions ─────────────────────────

  ready(playerId) {
    if (this.status !== 'peek') throw new Error('Nothing to get ready for.');
    const p = this._player(playerId);
    p.ready = true;
    if (this.players.every((x) => x.ready)) this._beginPlay();
  }

  callCabo(playerId) {
    this._requireTurn(playerId, 'draw');
    if (this.caboCallerId) throw new Error('Cabo has already been called.');
    this.caboCallerId = playerId;
    this._log(`${this._current().name} calls CABO! Everyone else gets one last turn.`);
    this._endTurn();
  }

  draw(playerId) {
    this._requireTurn(playerId, 'draw');
    const actor = this._current();
    const card = this._drawFromDeck();
    if (!card) {
      this._finish('No cards left to draw.');
      return;
    }
    this._markSeen(card, playerId);
    this.held = { card };
    this._log(`${actor.name} draws a card.`);
    this.phase = 'hold';
  }

  discardHeld(playerId) {
    this._requireTurn(playerId, 'hold');
    const actor = this._current();
    const card = this.held.card;
    this._markSeen(card, 'all');
    this.discard.push(card);
    this._log(`${actor.name} discards the ${cardName(card)}.`);
    this._afterDiscard(actor, card);
  }

  swapHeld(playerId, cardId) {
    this._requireTurn(playerId, 'hold');
    const actor = this._current();
    const { index, card: old } = this._findCard(playerId, cardId);
    actor.hand[index] = this.held.card;
    this._markSeen(old, 'all');
    this.discard.push(old);
    this._log(`${actor.name} swaps the drawn card into their hand and discards the ${cardName(old)}.`);
    this._afterDiscard(actor, old);
  }

  skipPower(playerId) {
    this._requireTurn(playerId, 'power');
    const actor = this._current();
    if (this.power.type === 'lookSwap' && this.power.stage === 'decide') {
      this._log(`${actor.name} keeps their cards as they are.`);
    } else {
      this._log(`${actor.name} skips the ${this.power.rank} power.`);
    }
    this._endTurn();
  }

  usePower(playerId, payload = {}) {
    this._requireTurn(playerId, 'power');
    if (this.power.stage !== 'choose') throw new Error('Decide whether to swap first.');
    const actor = this._current();
    const type = this.power.type;

    if (type === 'peekOwn') {
      const { card } = this._findCard(playerId, payload.cardId);
      this._markSeen(card, playerId);
      this._reveal(playerId, [{ ownerId: playerId, ...publicCard(card) }], 'Your card');
      this._log(`${actor.name} peeks at one of their own cards.`);
      this._endTurn();
      return;
    }

    if (type === 'peekOther') {
      if (payload.playerId === playerId) throw new Error('Pick an opponent\'s card.');
      const { owner, card } = this._findCard(payload.playerId, payload.cardId);
      this._markSeen(card, playerId);
      this._reveal(playerId, [{ ownerId: owner.id, ...publicCard(card) }], `${owner.name}'s card`);
      this._log(`${actor.name} peeks at one of ${owner.name}'s cards.`);
      this._endTurn();
      return;
    }

    if (payload.playerId === playerId) throw new Error('Pick an opponent\'s card.');
    const mine = this._findCard(playerId, payload.myCardId);
    const theirs = this._findCard(payload.playerId, payload.theirCardId);

    if (type === 'blindSwap') {
      if (mine.card.seenBy.includes(playerId)) throw new Error("You've already seen that card of yours, so it can't be blind swapped.");
      if (theirs.card.seenBy.includes(playerId)) throw new Error("You've already seen that card, so it can't be blind swapped.");
      this._swapCards(mine, theirs);
      this._log(`${actor.name} blind swaps a card with ${theirs.owner.name}.`);
      this._endTurn();
      return;
    }

    if (type === 'lookSwap') {
      this._markSeen(mine.card, playerId);
      this._markSeen(theirs.card, playerId);
      this.power.stage = 'decide';
      this.power.myCardId = mine.card.id;
      this.power.theirPlayerId = theirs.owner.id;
      this.power.theirCardId = theirs.card.id;
      this._reveal(playerId, [
        { ownerId: playerId, ...publicCard(mine.card) },
        { ownerId: theirs.owner.id, ...publicCard(theirs.card) },
      ], 'Swap them?');
      this._log(`${actor.name} looks at one of their cards and one of ${theirs.owner.name}'s.`);
      return;
    }

    throw new Error('Unknown power.');
  }

  confirmSwap(playerId, doSwap) {
    this._requireTurn(playerId, 'power');
    if (this.power.type !== 'lookSwap' || this.power.stage !== 'decide') throw new Error('Nothing to confirm.');
    const actor = this._current();
    if (!doSwap) {
      this._log(`${actor.name} keeps their cards as they are.`);
      this._endTurn();
      return;
    }
    const mine = this._findCard(playerId, this.power.myCardId);
    const theirs = this._findCard(this.power.theirPlayerId, this.power.theirCardId);
    this._swapCards(mine, theirs);
    this._log(`${actor.name} swaps a card with ${theirs.owner.name}.`);
    this._endTurn();
  }

  // Anyone may claim that a face-down card matches the top of the discard pile.
  snap(playerId, ownerId, cardId) {
    if (this.status !== 'playing') throw new Error('The game is not in progress.');
    if (this.pendingGive) throw new Error(`Waiting for ${this._player(this.pendingGive.from).name} to give a card.`);
    if (this.discard.length === 0) throw new Error('There is no card to match.');
    const snapper = this._player(playerId);
    const top = this.discard[this.discard.length - 1];
    const { owner, card, index } = this._findCard(ownerId, cardId);

    if (card.rank === top.rank) {
      owner.hand.splice(index, 1);
      this._markSeen(card, 'all');
      this.discard.push(card);
      const whose = owner.id === playerId ? 'their own' : `${owner.name}'s`;
      this._log(`${snapper.name} matches ${whose} ${cardName(card)} with the ${top.rank} on the pile!`);

      // A pending Queen decision involving this card can no longer be completed.
      if (this.power && this.power.stage === 'decide' &&
          (this.power.myCardId === card.id || this.power.theirCardId === card.id)) {
        this._log('The pending swap is cancelled because one of its cards was matched away.');
        this._endTurn();
        if (this.status !== 'playing') return;
      }

      if (owner.id !== playerId && snapper.hand.length > 0) {
        this.pendingGive = { from: playerId, to: owner.id };
        this._log(`${snapper.name} must give ${owner.name} one of their cards.`);
      } else {
        this._checkEmptyHands();
      }
      return;
    }

    // Wrong guess: everyone sees the card, and the snapper draws a penalty card.
    this._markSeen(card, 'all');
    this._reveal('all', [{ ownerId: owner.id, ...publicCard(card) }], `${snapper.name} guessed wrong`);
    const penalty = this._drawFromDeck();
    if (penalty) {
      snapper.hand.push(penalty);
      this._log(`${snapper.name} tried to match ${owner.id === playerId ? 'their own' : owner.name + "'s"} card, but it was the ${cardName(card)}. ${snapper.name} draws a penalty card.`);
    } else {
      this._log(`${snapper.name} tried to match a card, but it was the ${cardName(card)}. No cards left for a penalty.`);
    }
  }

  give(playerId, cardId) {
    if (!this.pendingGive || this.pendingGive.from !== playerId) throw new Error('You have nothing to give.');
    const giver = this._player(playerId);
    const receiver = this._player(this.pendingGive.to);
    const { index, card } = this._findCard(playerId, cardId);
    giver.hand.splice(index, 1);
    receiver.hand.push(card);
    this.pendingGive = null;
    this._log(`${giver.name} gives ${receiver.name} a card.`);
    this._checkEmptyHands();
  }

  // ───────────────────────── views ─────────────────────────

  // What one particular player is allowed to see.
  viewFor(playerId) {
    const finished = this.status === 'finished';
    return {
      status: this.status,
      settings: this.settings,
      initialPeek: Math.min(INITIAL_PEEK, this.settings.handSize),
      phase: this.phase,
      turnPlayerId: this.status === 'playing' ? this._current().id : null,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      discardTop: this.discard.length ? publicCard(this.discard[this.discard.length - 1]) : null,
      held: this.held
        ? (this._current().id === playerId ? { card: publicCard(this.held.card) } : {})
        : null,
      power: this.power ? {
        type: this.power.type,
        actorId: this.power.actorId,
        stage: this.power.stage,
        rank: this.power.rank,
        label: POWER_LABEL[this.power.type],
      } : null,
      pendingGive: this.pendingGive,
      caboCallerId: this.caboCallerId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        cardCount: p.hand.length,
        cards: p.hand.map((c) => {
          const seenByMe = c.seenBy.includes(playerId);
          const out = { id: c.id, seenByMe };
          if (finished) out.known = publicCard(c);
          return out;
        }),
      })),
      log: this.log.slice(-40),
      result: this.result,
    };
  }
}

module.exports = { Game, cardValue, powerOf, makeDeck, shuffle, INITIAL_PEEK };
