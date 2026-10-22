# Cabo

A private, real-time Cabo card game for playing with friends. It lives at
`/secret-cabo` and is not linked from anywhere on the site, so only people who
know the URL (and a lobby's join code) can get in. The page also sends
`noindex` headers so search engines ignore it.

## Layout

```
cabo/
├── server.js        Express + WebSocket server (lobbies, join codes, reconnects)
├── game.js          Pure game rules, no networking
├── public/          The browser client served at /secret-cabo
│   ├── index.html
│   ├── cabo.css
│   └── cabo.js
└── test/            `npm test` – rules tests + an end-to-end server smoke test
```

Nothing outside this folder is touched. The server also serves the rest of the
site (the parent folder) so one process can host `alex-li.com` and
`alex-li.com/secret-cabo` together.

## Run locally

```
cd cabo
npm install
npm start          # http://localhost:3000/secret-cabo
npm test
```

Open the URL in two browser windows (or send the lobby's invite link to a
friend on the same network) to try it.

Environment variables:

| Variable     | Default | Meaning                                                   |
|--------------|---------|-----------------------------------------------------------|
| `PORT`       | `3000`  | Port to listen on                                         |
| `SERVE_SITE` | `true`  | Set to `false` to serve only `/secret-cabo`, not the site |

## Deploying

The game needs a long-running Node process (WebSockets), so it cannot run on a
static host such as GitHub Pages. The simplest setup:

1. Deploy this repo to a Node host (Render, Railway, Fly.io, a VPS, ...) with
   root directory `cabo`, build command `npm install`, start command
   `npm start`. The host provides `PORT`.
2. Point `alex-li.com` at that deployment. The whole site is served from it,
   with the game at `https://alex-li.com/secret-cabo`.

If you would rather keep the site where it is, deploy only the server (with
`SERVE_SITE=false`) and share its URL, e.g. `https://cabo.alex-li.com/secret-cabo`.
To serve the page from one host and the WebSocket from another, set
`window.CABO_WS_URL = 'wss://your-server/secret-cabo/ws'` in a script tag before
`cabo.js` in `public/index.html`.

Lobbies live in memory. Restarting the server clears them, and the free tiers
of some hosts sleep after inactivity, which does the same.

## Rules as implemented

- Standard 52-card deck, cryptographically shuffled each game. Ace = 1,
  2–10 = face value, J/Q/K = 10, King of hearts = −1. Lowest total wins.
- Each player is dealt the lobby's hand size (default 4, the only lobby
  setting), laid out two cards per row, and peeks at their bottom row before
  the first turn. The played pile starts empty.
- Hands are fixed slots. A card that leaves a hand (matched or given away)
  leaves an empty slot behind; a card that arrives fills the first empty slot.
  Nothing shuffles around, so you can keep track of what sits where.
- On your turn: draw from the deck, then drag the drawn card onto the played
  pile to play it, or onto one of your cards to swap (the swapped-out card is
  what you play). **The card that lands on the played pile is the card you
  played**, so a swapped-out 7 triggers a peek just like a played 7.
- Every card is used exactly once: the played pile is never reshuffled. When
  the draw pile runs out, the game ends after that turn's match window.
- Powers (all optional): 7/8 peek at one of your cards, 9/10 peek at an
  opponent's card, J blind swap (the server refuses any card you have ever
  seen, tracked per physical card even after it moves), Q look at one of yours
  and one of theirs, then swap or keep.
- After every play there is a match window: anyone may drag any face-down
  card they believe matches the rank on top of the pile onto the played pile. Correct and
  it's yours: the card is gone. Correct and it's someone else's: it's gone and
  you give them one of your cards. Wrong: nothing is revealed and you draw a
  penalty card. The next player draws once every player has pressed Ready.
- The game ends when a player has no cards, or one full round after someone
  calls Cabo (calling Cabo uses your turn).
- Peeked cards are shown for 2 seconds, then hidden again. Remembering them is
  part of the game.
- Every move is shown on the cards it touched, for everyone: a label such as
  "Bob looked", "Bob placed", "Cat matched", "from Cat" or "penalty" sits on
  the slot for a few seconds, with a short animation. There is no text log;
  the prompt bar shows the latest move in one line.
- Layout: opponents sit across the top of the table, you sit at the bottom,
  and the draw pile, played pile and drawn card live in a column on the right
  (below the table on phones).

## Controls

| Key            | Action                                               |
|----------------|------------------------------------------------------|
| `D`            | Draw                                                 |
| `Space` / `P`  | Play the drawn card                                  |
| `1`–`9`        | Your card in that slot (swap, peek, select, or give) |
| `Enter` / `R`  | Ready                                                |
| `S`            | Skip the power                                       |
| `Y` / `N`      | Swap / keep after a Queen look                       |
| `C`            | Call Cabo                                            |
| `Esc`          | Clear a selection or cancel a drag                   |

Dragging works with a mouse or a finger. Clicking still works where it is
unambiguous (a card to swap or peek, the played pile to play the drawn card).
- Refreshing the page or dropping the connection keeps your seat; the browser
  remembers the lobby and rejoins automatically. Opening an invite link shows
  only a name prompt with the join code filled in.
