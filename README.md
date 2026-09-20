# Deeper

A push-your-luck dungeon crawler for FriendSDK **v0.1**. Your owned Rare Friend buys a torch on a
cavern ledge, takes the staircase, and clears rooms one at a time. After every safe room there is
one question: **bank the pot, or go deeper.**

All purchases, balances, rewards and outcomes are **simulated**. The SDK runtime supplies wallet
connection, owned-Friend selection, the fresh ownership gate, in-frame confirmations and the
sandboxed 960 × 640 container. This game adds no navigation, headers, footers, About/Store pages
or a separate wallet flow.

## Run it

Node.js 22+ on Linux or Ubuntu/WSL2, plus a browser wallet holding a hardwired Rare Friends
Generations NFT (generation ≥ 1) on Robinhood mainnet (4663).

```sh
git clone https://github.com/wasutz/deeper.git
cd deeper
npm ci
npm run dev
```

Then open **http://localhost:4173**, choose **Connect wallet**, and pick your Friend. The SDK
verifies ownership before play; no RF funding or transaction signature is needed for this
simulated preview.

To play on a phone over your LAN:

```sh
npx friendsdk dev ./game --host 0.0.0.0 --port 4173
```

Open `http://YOUR_COMPUTER_LAN_IP:4173` on the phone, in a browser that has your wallet. Allow the
port through your firewall. The frame keeps its 3:2 ratio, so a phone renders the same document at
roughly 360 × 240 CSS pixels; the layout compacts rather than scrolls.

## Controls

| | Ledge | Dungeon |
|---|---|---|
| Move | WASD / arrow keys, or tap a destination | — |
| Interact | <kbd>E</kbd> near the vendor or stairs, or tap the prompt | — |
| Bank | — | <kbd>B</kbd> or tap **Bank** |
| Descend | — | <kbd>D</kbd> / <kbd>Space</kbd>, or tap **Descend** |
| Run again | — | <kbd>R</kbd> / <kbd>Enter</kbd> |

Sound is off by default; mute, reduced motion, the odds table and the session log live in the
**Menu** chip. Reduced motion is picked up from the OS and resolves rooms instantly. Movement and
every dungeon choice lock while the runtime's `paused` prop is true.

## The loop

1. **Torch Vendor** — one **Torch** costs exactly **1 RF**. It lights one run.
2. **Dungeon Entrance** — the staircase consumes the torch and commits the run.
3. **Rooms 1–10** — each is a Dice draw into **LOOT** (pot climbs a tier), **EMPTY** (safe, pot
   unchanged) or **TRAP** (the run ends and the unbanked pot is lost).
4. After any safe room: **BANK** the pot, or **DESCEND**. Depth caps at 10.
5. Bust or bank, **Run again** restarts in one tap, buying a torch if you have none.

Pot value follows the **loot tier**, not the depth. An empty room takes you deeper without growing
the pot, so depth and pot drift apart — which is what makes the stopping decision interesting
rather than a table lookup.

## Exact rules

- **Consumable:** `Torch`, price `1000000000000000000` base units (**1 RF**; 1 RF = `10n ** 18n`).
- **One torch per run**, consumed at the entrance when the run is committed.
- **Every purchased torch reserves the maximum prize, 25 RF**, for the whole descent. New purchases
  stop when free stake cannot back another maximum prize; already-purchased torches stay usable.
- **Kept caches have no redemption expiry** and always sell for their fixed RF value.
- Maximum prize per run: **25 RF**. Weights total **10 000 bps**.

### Room weights and the pot ladder

| Depth | Trap | Loot | Empty | Pot at that tier |
|---:|---:|---:|---:|---:|
| 1 | 15% | 70% | 15% | 1.10 RF |
| 2 | 18% | 67% | 15% | 1.40 RF |
| 3 | 22% | 63% | 15% | 1.90 RF |
| 4 | 28% | 57% | 15% | 2.80 RF |
| 5 | 35% | 50% | 15% | 4.85 RF |
| 6 | 42% | 43% | 15% | 5.65 RF |
| 7 | 50% | 35% | 15% | 7.00 RF |
| 8 | 58% | 27% | 15% | 9.35 RF |
| 9 | 65% | 20% | 15% | 14.25 RF |
| 10 | 70% | 15% | 15% | 25.00 RF |

The trap column is indexed by **depth**; the pot column by **loot tier**.

### Settlement outcomes (`game.json`)

| # | Outcome | Chance | Reward |
|---:|---|---:|---:|
| 1 | Lost to the dark | 55.34% | 0 RF |
| 2 | Tin Cache | 22.19% | 1.10 RF |
| 3 | Copper Cache | 7.04% | 1.40 RF |
| 4 | Iron Cache | 4.43% | 1.90 RF |
| 5 | Silver Cache | 2.53% | 2.80 RF |
| 6 | Gold Cache | 8.42% | 4.85 RF |
| 7 | Amber Cache | 0.01% | 5.65 RF |
| 8 | Opal Cache | 0.01% | 7.00 RF |
| 9 | Ruby Cache | 0.01% | 9.35 RF |
| 10 | Obsidian Cache | 0.01% | 14.25 RF |
| 11 | Dragon Hoard | 0.01% | 25.00 RF |

Weights are the run-result distribution under the reference (EV-optimal) line, with every tier
floored at 1 bp so all eleven stay representable and redeemable.

## Tuning

```sh
npm run tuning                       # verify the committed game.json
node scripts/tuning.mjs --solve      # re-solve the ladder for the EV target
```

The script solves the optimal policy by backward induction over `(depth, tier)` — necessary because
empty rooms decouple the two axes — then computes the exact run-result distribution and checks it
against `game.json`. Current numbers:

```
optimal-stopping EV        0.9059 RF per run   (house edge 9.41%)
published-table EV         0.9122 RF per run   (house edge 8.78%)
bust chance                55.40%
average payout when banked 2.0311 RF
maximum prize              25 RF
```

The ladder is built against each room's break-even growth, `(1 − empty) / loot`. Up to tier 5 every
step clears break-even by a hair, so descending is correct but only just — that razor edge is the
game. Past tier 5 growth is held below break-even, so the deep rooms pay spectacularly without ever
being the right call. Reaching depth 6 happens in about 4.9% of runs; the 25 RF Dragon Hoard is a
lure, not a plan.

## Provably fair rooms

A 128-bit run nonce is drawn and hashed **before the first room**, and `sha256(nonce)` is shown
immediately. Each room is then a pure function of the commitment:

```
roll  = sha256(nonce + ":" + playId + ":" + depth) → first 8 hex digits as uint32, mod 10000
room  = roll < trapBps                ? TRAP
      : roll < trapBps + lootBps      ? LOOT
      :                                 EMPTY
```

Because the nonce is fixed before any choice, no room result can react to a BANK or DESCEND. The
nonce is revealed when the run ends; **Verify** (in the dungeon, or per run in **This session**)
prints the commitment, the nonce, the play ID and every room's digest and roll, so the whole run
can be recomputed by hand. SHA-256 is implemented in `fairness.ts` rather than taken from WebCrypto
because the sandboxed frame has an opaque origin, where `crypto.subtle` is not guaranteed to exist.
`fairness.test.mjs` holds it to `node:crypto` across block boundaries and multi-byte input, checks
that rolls fill the 10 000 buckets evenly, and drives the real resolver against the published
boundaries.

## Capability gap: the pot and the ledger

**This is the one thing a reviewer should look at first.**

SDK v0.1's chance primitive settles **one fixed reward per consumable**, chosen by its own weighted
draw (`src/game.ts`). There is no action that means *"pay the pot at the depth this player stopped"*,
and credited rewards cannot be clawed back — so a payout that depends on the player's stop-depth is
**not expressible** with the fixed outcome table. Push-your-luck fundamentally needs that.

Rather than fake it, this prototype runs both halves honestly and labels them in-game (the **Why?**
link on every run-over screen opens the same explanation):

- **Real, through the SDK client:** the 1 RF torch purchase (`buy`), the torch burn and run
  commitment (`play`), the 25 RF maximum-prize reserve, the per-run settlement (`settle`) and cache
  redemption (`redeem`). Free-stake backing and reserves behave exactly as the SDK enforces them.
- **Simulated at the game layer:** the banked pot.

The two agree in expectation — 0.9122 RF per torch from the published table against 0.9059 RF from
optimal stopping — so a session's banked total and satchel value converge. Closing the gap needs a
contract action such as `bank(playId, tier)` that settles a committed play at a player-chosen tier
bounded by a committed trap depth. **That is the first item for the on-chain phase.** No transaction
adapter, deployment flow, on-chain action or Solidity is implemented here.

## Checks

```sh
npm ci
npm run typecheck
npm test                 # digest, draws and room boundaries
npm run check:games      # definition, weights, roll boundaries, economy simulation
npx playwright install --with-deps chromium
npm run check:browser    # end-to-end, 1100 px and 360 px
npm run tuning           # the full economy table
```

`scripts/check-browser.mjs` drives the real runner with the SDK's mocked wallet, identity and canonical
sprite fixture at 1100 px and 360 px: connect, select, keyboard and touch movement, vendor purchase,
a committed descent, bank or bust, the `paused` lock, one-tap restart, verification, the satchel,
mute and reduced motion, and that nothing escapes the container or covers a control.

This project vendors the SDK as a package archive, so it needs no SDK checkout and no changes to
the SDK. One unrelated observation from building against a clone of the SDK repo, in case it is
useful upstream: `scripts/check-games.mjs` allow-lists only `dist/`, `src/` and `node_modules/` as
build sources, while `package.json` maps `./world-view.css` and `./frame.css` into `assets/`. A game
developed *inside* the SDK repo under `games/` that imports an SDK stylesheet therefore fails that
script, including a fresh `friendsdk init` copy of `examples/starter`. It does not affect this
submission, which resolves the SDK through `node_modules`.

## Files

| File | What it holds |
|---|---|
| `game/index.tsx` | Surface world, menus, run orchestration, SDK ledger calls |
| `game/descent.tsx` | The dungeon scene: room art, draw reveal, bank/descend prompt |
| `game/sprite.tsx` | Canonical Friend pixels on a canvas, 16 × 16 mask at integer 5× scale |
| `game/world.ts` | The cavern ledge: geometry, the staircase hole, props, interactions |
| `game/rules.ts` | Typed tuning read from `game.json`, room resolution, depth bands |
| `game/fairness.ts` | SHA-256 and the commit-and-reveal room draw |
| `game/game.json` | Torch cost, outcome weights, rewards, room weights, pot ladder, consumable rules |
| `game/style.css` | Cavern palette, descent layout, responsive rules |
| `scripts/tuning.mjs` | Economy solver and verifier |
| `scripts/check-game.mjs` | Definition, weight and roll-boundary validation |
| `scripts/check-browser.mjs` | End-to-end browser check |
| `scripts/fixture.mjs` | The SDK's wallet/RPC fixture, vendored for the browser check |
| `tests/fairness.test.mjs` | Digest, draw and room-boundary tests |
| `vendor/` | `rarefriends-friendsdk-0.1.0.tgz`, packed from upstream `da4828f` |

## Assets

See [NOTICE.md](NOTICE.md). No third-party art. The cavern ledge uses the SDK's own world renderer and prop set
(`@rarefriends/friendsdk/world`) with geometry authored in `world.ts`; the dungeon rooms are inline
SVG generated in `descent.tsx`, with silhouettes seeded from each room's own committed draw. The
Friend's sprites come from the SDK's pinned canonical artwork deployment and are never rotated,
scaled non-integrally, recoloured or replaced. Sound uses the SDK's ten-cue kit
(`@rarefriends/friendsdk/sounds`). The SDK's world view ships a white ground and signal-green
prompts, so `style.css` themes that DOM itself rather than importing
`@rarefriends/friendsdk/world-view.css` — the renderer output and the canonical Friend pixels are
untouched, and the game's build stays clear of the SDK's `assets/` directory.
