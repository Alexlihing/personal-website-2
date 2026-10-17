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
  setting) and peeks at their first two cards before the first turn.
- On your turn: draw from the deck, then discard the drawn card or swap it
  with one of yours. **The card that lands on the discard pile is the card you
  played**, so a swapped-out 7 triggers a peek just like a discarded 7.
- Powers (all optional): 7/8 peek at one of your cards, 9/10 peek at an
  opponent's card, J blind swap (the server refuses any card you have ever
  seen, tracked per physical card even after it moves), Q look at one of yours
  and one of theirs, then swap or keep.
- Matching: at any time, anyone may claim a face-down card matches the rank on
  top of the discard pile. Correct and it's yours: the card is gone. Correct
  and it's someone else's: it's gone and you give them one of your cards.
  Wrong: everyone sees the card and you draw a penalty card.
- The game ends when a player has no cards, or one full round after someone
  calls Cabo (calling Cabo uses your turn).
- Peeked cards are shown for 10 seconds, then hidden again. Remembering them is
  part of the game.
- Refreshing the page or dropping the connection keeps your seat; the browser
  remembers the lobby and rejoins automatically.
