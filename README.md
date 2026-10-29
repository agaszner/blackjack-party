# Blackjack Party 🂡

Play blackjack online with your friends, right in the browser. One person creates a party, shares the code or link, and up to 7 players take on the dealer together.

No server or account needed: it's a static site (works on GitHub Pages). The host's browser runs the table and friends connect to it peer-to-peer over WebRTC ([PeerJS](https://peerjs.com)).

## How to play

1. Open the site, enter your name and click **Create party**.
2. Choose the table settings, then **Open the table**.
3. Click **Copy invite link** and send it to your friends, or just tell them the 5-letter party code.
4. Everyone places a bet. The cards are dealt as soon as everybody is ready (the host can also press **Deal now**).

Keyboard shortcuts on your turn: **H** hit, **S** stand, **D** double, **P** split, **R** surrender.

## Table settings

| Setting | Default |
|---|---|
| Starting chips | 1000 |
| Decks in the shoe | 6 (1, 2, 4, 6 or 8) |
| Min / max bet | 10 / 500 |
| Max players | 7 |
| Reshuffle point (cut card) | 75% of the shoe |
| Turn timer | 30 s (players who run out of time stand) |
| Blackjack pays | 3 to 2 (or 6 to 5) |
| Dealer hits soft 17 | Off (dealer stands on all 17s) |
| Double after split | On |
| Insurance | On |
| Late surrender | Off |
| Hit split aces / re-split aces | Off |
| Rebuys when broke | On |

The host can also choose **Be the dealer**, which runs the table without taking a seat.

## Rules (classic Las Vegas blackjack)

- Each player gets two cards face up. The dealer gets one card up and one hole card.
- Cards 2–10 count face value, J/Q/K count 10, and an Ace counts 1 or 11.
- A natural blackjack (Ace + 10-value card in your first two cards) pays 3 to 2.
- If the dealer shows an Ace, players may take **insurance** for half their bet, which pays 2 to 1.
- If the dealer shows an Ace or a 10, they **peek** for blackjack. A dealer blackjack ends the round at once: players lose, except player blackjacks, which push.
- **Hit** to take a card, **stand** to stop, **double** to double your bet and take exactly one card, **split** a pair into two hands (up to 4 hands), **surrender** to give up half your bet (if enabled).
- Split aces get one card each, and 21 after a split counts as 21, not blackjack.
- The dealer draws to 16 and stands on 17 (or hits soft 17 if that setting is on).
- Wins pay 1 to 1. Ties push (you get your bet back).

## Good to know

- **Keep the host's tab open.** The table lives in the host's browser. If the host reloads, the table is restored from local storage and friends reconnect automatically.
- Players who disconnect stand automatically and can rejoin with the same link to get their seat and chips back.
- Connections go through the free PeerJS cloud signalling server, which uses public STUN only. On a few very strict networks (some corporate or school Wi-Fi), the direct connection may fail.
- Play money only.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, then select `main` and `/ (root)`. Click **Save**.
4. After a minute, your site is live at `https://<your-username>.github.io/<repo-name>/`.

## Development

```bash
npm test          # rules engine tests (Node 18+)
npm start         # serve locally on http://localhost:8080
```

To test multiplayer without internet, add `?transport=local` to the URL and open several tabs in the same browser.

Code layout:

- `js/engine.js` — the rules engine (shoe, betting, insurance, peek, splits, dealer, payouts)
- `js/host.js` — runs on the host: applies player actions, turn timers, dealer animation, saving
- `js/net.js` — PeerJS and local BroadcastChannel transports
- `js/app.js` — the user interface
