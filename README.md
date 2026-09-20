# Deeper

A push-your-luck dungeon crawler for FriendSDK **v0.1**. Your owned Rare Friend buys a torch on a
cavern ledge, takes the staircase, and clears rooms one at a time. After every safe room there is
one question: **bank the pot, or go deeper.**

All purchases, balances, rewards and outcomes are **simulated**. The SDK runtime supplies wallet
connection, owned-Friend selection, the fresh ownership gate, in-frame confirmations and the
sandboxed 960 × 640 container. This game adds no navigation, headers, footers, About/Store pages
or a separate wallet flow.

## Run it

Node.js 22+ and git on Linux or Ubuntu/WSL2, plus a browser wallet holding a hardwired Rare
Friends Generations NFT (generation ≥ 1) on Robinhood mainnet (4663). `npm ci` clones the SDK from
its repository and builds it, so the first install needs network access.

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
| Spend a curio | — | tap it in the quieter second row |
| Run again | — | <kbd>R</kbd> / <kbd>Enter</kbd> |

Sound is off by default; mute, reduced motion, the odds table and the session log live in the
**Menu** chip. Reduced motion is picked up from the OS and resolves rooms instantly. Movement and
every dungeon choice lock while the runtime's `paused` prop is true.

## The loop

1. **Torch Vendor** — one **Torch** costs exactly **1 RF**. It lights one run.
2. **Curio shelf** — spend banked pot on up to **2 slots** of carry-items for the next descent.
3. **Dungeon Entrance** — pick the loadout; the staircase consumes the torch and commits the run.
4. **Rooms 1–10** — each is a committed draw into **LOOT** (pot climbs a tier), **EMPTY** (safe, pot
   unchanged, and one time in five it leaves a curio in the rubble) or **TRAP** (the run ends and the
   unbanked pot is lost).
5. After any safe room: **BANK** the pot, or **DESCEND**. Depth caps at 10.
6. Bust or bank, **Run again** restarts in one tap with the same kit where the satchel still has it.

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
- **A loadout is spent by the run it goes into**, used or not — which is exactly what its price buys.

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

## Carry-items

Seven curios, bought at the vendor with **banked pot** or found in **empty rooms**, carried two
slots at a time. Every price is solved, not chosen:

```sh
npm run items            # price the catalogue and print what each curio does to a run
```

An item is worth the expected pot it adds to a single descent, priced at `gain / baseline` — the
same RF-per-RF rate the 1 RF torch charges. `scripts/check-game.mjs` asserts the published prices
against the solver, so they cannot drift from the numbers that justify them.

| Curio | Slots | Price | Adds | Effect |
|---|---|---|---|---|
| Ward | 1 | 0.27 RF | +0.2518 | Armed before a room; that room's trap passes like an empty. Spent either way. |
| Lantern | 1 | 0.27 RF | +0.2511 | Reveals the next room's committed result before you choose. |
| Escape Rope | 1 | 0.42 RF | +0.3962 | Reactive: on a revealed trap, leave with **half** the pot. |
| Loot Sack | 1 | 0.52 RF | +0.4894 | Banking pays one rung higher than the tier you stopped on. |
| Divining Rod | 1 | 0.52 RF | +0.4908 | Overrides the next room's draw: loot, guaranteed. |
| Greed Idol | **2** | 0.92 RF | +0.8677 | Loot advances **two** tiers; every room's trap chance +10 points. |
| Lucky Charm | 1 | 1.14 RF | +1.0735 | Reactive: on a revealed trap, reroll the room against a second committed draw. |

### What the solver decided, not the designer

- **A flat pot multiplier is inert.** Value is linear in pot scale, so "+50% loot value" changes no
  decision; only its trap penalty bites, which makes optimal play *more* timid. The first Greed Idol
  cut bust from 55% to 29% and capped the ceiling at 1.65 RF. Advancing two tiers per loot rewards
  the descent itself: bust rises to 82%, the spread goes 1.39 → 5.37, and the 25 RF Dragon Hoard
  becomes reachable — the only curio that opens the top of the ladder.
- **A half-bank hedge is mathematically dead.** "Bank half, descend with the rest" is worth
  `P/2 + max(P,W)/2` where `P` is banking and `W` is descending — a midpoint of two options can
  never beat the better one. Solved over every reachable state its gain is exactly 0.000000000, and
  strictly negative wherever descending is correct. It is a variance dial, not an item, so it is not
  in the catalogue.
- **The Greed Idol has to travel alone.** Paired with a protective curio it priced at more than
  double the sum of its parts — Idol + Lucky Charm reached 5.54× baseline, because the protection
  banks the upside while capping the downside. Giving it both carry slots removes the pair outright.

### Drops cost house edge, and the rate is the price

A curio is worth **0.4458 RF** — about half a run's entire expected pot. So a drop is never a small
gift, and the rate it falls at is spent directly out of the house edge:

| Empty rooms that drop | Pot-layer EV | House edge | One curio every |
|---|---|---|---|
| 0% | 0.9059 RF | 9.41% | never |
| 10% | 0.9249 RF | 7.51% | 24 runs |
| **20%** (shipped) | **0.9435 RF** | **5.65%** | **12 runs** |
| 50% | 0.9969 RF | 0.31% | 5 runs |
| 100% | 1.0812 RF | **−8.12%** | 2 runs |

There is no rate that is both frequent and free. Dropping from *every* empty room — the obvious
first design — is a faucet worth 0.175 RF a run that hands the player an 8% edge over the house.
`dropChanceBps` in `game.json` is the dial; `check:games` fails if it is ever tuned far enough to
give the pot layer away.

Two consequences follow the solver rather than taste:

- **A curio's worth and its price define each other** — an empty room is worth more than the pot it
  preserves because it also leaves a curio, and what that curio is worth is what curios cost. Prices
  are a fixed point, settled in nine passes. Leaving drops out priced the Ward and the Greed Idol
  against a game neither is played in: one manufactures empty rooms, the other destroys them.
- **A room a curio bent leaves nothing behind.** A Ward that turns a trap aside got you past it; it
  did not also find you treasure. Crediting a drop there would put value in the Ward its price never
  charged for.

### Overlaps left in

Curios interact, and the solver prices each standalone, so some pairs are better than their parts
and some are worse. Both are published rather than tuned away:

- **Divining Rod + Lucky Charm** is superadditive by 21% and returns **+0.23 RF** over its price —
  the strongest legal loadout at 3.00× baseline, and the build worth finding.
- **Escape Rope + Lantern** is 15% *sub*additive: a rope caps what a trap costs you, so
  foreknowledge of one is worth less. The Lantern still adds 0.154 RF beside a rope, against 0.251
  standalone — 39% less, not nothing.

Both move simulated pot only; the ledger's own settlement draw is untouched.

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
being the right call. A player following that line never enters room 6 at all — the reach column
above reads 0.00% from depth 6 down, and tiers 6-10 carry the 1 bp floor the weights give them so
they stay representable. One who ignores it and descends every room clears room 6 about 14.8% of the
time (25.4% are still alive to enter it). Either way the 25 RF Dragon Hoard is a lure, not a plan.

## Provably fair rooms

A 128-bit run nonce is drawn and hashed **before the first room**, and `sha256(nonce)` is shown
immediately. Each room is then a pure function of the commitment:

```
roll  = sha256(nonce + ":" + playId + ":" + depth) → first 8 hex digits as uint32, mod 10000
room  = roll < trapBps                ? TRAP
      : roll < trapBps + lootBps      ? LOOT
      :                                 EMPTY
```

A curio never touches that draw. It can override what a roll *resolves to* — a Ward passing a trap
off as an empty, a Divining Rod forcing loot — and the Verify panel prints both columns, what the
roll drew and what the room became, with the curio that moved it. Two derived draws hang off the
same nonce under their own tags, so each stays independently recomputable and none can collide with
the room roll:

```
reroll      = sha256(nonce + ":" + playId + ":" + depth + ":reroll")       a Lucky Charm's second chance
drop        = sha256(nonce + ":" + playId + ":" + depth + ":drop")        whether an empty room leaves a curio
drop-item   = sha256(nonce + ":" + playId + ":" + depth + ":drop-item")   which curio it leaves
```

The Verify panel prints all of them once the run is over, so the two draws that hand out curios are
checkable by hand like every other.

### Checking it without taking the game's word

Everything the Verify panel shows was computed by the game, with the game's own SHA-256. That is a
weak kind of proof, so there is a second one that shares no code with it:

```sh
npm run verify -- --nonce 0314… --play 7 --commitment 1185… --carried greed-idol
```

`scripts/verify.mjs` imports nothing from `game/`. The digest comes from `node:crypto` rather than
`fairness.ts`, and the room boundaries are read straight out of `game.json` rather than `rules.ts`,
so when it reproduces the run the agreement is evidence rather than a tautology. It re-derives every
room and every tagged draw hanging off it — including the `reroll-drop` pair a Lucky Charm's reroll
makes when it lands on an empty room — and checks `sha256(nonce)` against the commitment you were
shown before room 1, exiting non-zero and printing no rooms at all if they disagree. It refuses
malformed input rather than printing a confident table for a mistyped command. The **Fair play** panel prints the exact command for the
run you are looking at.

What that proves: every room was a pure function of `(nonce, playId, depth)`, fixed before your
first choice, so no result could react to a bank-or-descend decision. What it does not prove: that
the nonce was drawn fairly. In this preview your own browser draws it, so there is no house on the
other side — running the same scheme against a contract is what turns this from a demonstration into
a trust guarantee.

### The other half: does the table match itself?

A commitment proves one run was dealt before it was played. It says nothing about whether the
published weights are the weights actually being used. The **Fair play** panel answers that over a
whole session: it tallies every room draw against what `game.json` expected of it and reports
Pearson's chi-square on two degrees of freedom, with the p=0.01 band at 9.21. A table that lied
would drift away from its own numbers there, and a player can watch it fail to.

It counts the **natural** result of each draw, not the resolved one — a curio overrides what a roll
means, never the roll, so the overridden rooms still belong in the calibration. A Lantern's peek is
tallied when it is drawn rather than when the room is entered: a peek that talks you out of
descending would otherwise drop its own draw, and a draw included only when the player liked the
look of it is exactly the bias a goodness-of-fit test cannot survive.

Three honest limits, stated in the panel as well as here:

- **It cannot catch a dishonest operator, because there isn't one.** Same caveat as the verifier:
  the draws and the weights both come out of the bundle running in your browser. This catches a bug
  in `rules.ts` drifting from the published table — not a house, which does not exist until this
  runs against a contract.
- **The bands are approximate.** Every draw comes from its own depth's weights rather than one
  shared distribution, so the statistic is Poisson-binomial rather than multinomial. The
  heterogeneity makes it *conservative* — it errs towards calling an honest table honest.
- **Watching continuously is not the same as one reading.** The panel recomputes after every room,
  and a statistic you can check at any moment crosses a band more often than its fixed-sample
  false-alarm rate suggests.

The small-sample guard is the minimum expected cell count reaching 5, not a total draw count —
`empty` is a flat 1500 bps at every depth, so it is always the cell that gets there last.

The Greed Idol shifts the boundaries rather than the roll: +10 points of trap taken out of loot and
empty in proportion, so the three still total 10 000 bps at every depth and the published bands stay
checkable.

Because the nonce is fixed before any choice, no room result can react to a BANK or DESCEND. The
nonce is **withheld while the run is live** — a player holding it could hash the rooms below and
stop one room short of every trap — and revealed with the result. **Verify** (in the dungeon, or per
run in **This session**) prints the commitment, the play ID and every resolved room's digest and
roll at any time, and adds the nonce once the run is over, so the whole run can be recomputed by
hand. The fold is `uint32 mod 10000`, which leaves 7296 buckets holding one extra preimage: a
published 15.00% band is really 15.0000094%. Rejection sampling would remove that, at the cost of a
retry loop a verifier has to replay by hand. SHA-256 is implemented in `fairness.ts` rather than taken from WebCrypto
because the sandboxed frame has an opaque origin, where `crypto.subtle` is not guaranteed to exist.
`fairness.test.mjs` holds it to `node:crypto` across block boundaries and multi-byte input, holds
40 000 committed draws to a chi-square bound over ten equal bands, and drives the real resolver
against the published boundaries.

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
- **Simulated at the game layer:** the banked pot, and the curios it buys. SDK v0.1 has one
  consumable and `buy` is its only RF debit, so a curio cannot be a second thing the ledger sells;
  pricing them in banked pot keeps the whole item economy inside the layer that is already labelled
  as simulated rather than opening a second gap.

The two agree in expectation — 0.9122 RF per torch from the published table against 0.9059 RF from
optimal stopping — but they are separate draws, so a session's banked total and satchel value
differ by however the variance falls. Closing the gap needs a
contract action such as `bank(playId, tier)` that settles a committed play at a player-chosen tier
bounded by a committed trap depth. **That is the first item for the on-chain phase.** No transaction
adapter, deployment flow, on-chain action or Solidity is implemented here.

## Checks

```sh
npm ci
npm run typecheck
npm test                 # digest, draws, room boundaries, curio effects, the verifier
npm run check:games      # definition, weights, roll boundaries, economy and item prices
npx playwright install --with-deps chromium
npm run check:browser    # end-to-end, 1100 px and 360 px
npm run tuning           # the full economy table
npm run items            # curio prices, pair overlaps and the strongest legal loadout
npm run verify -- --nonce <hex> --play <id> [--commitment <hex>] [--carried greed-idol]
```

`scripts/check-browser.mjs` drives the real runner with the SDK's mocked wallet, identity and canonical
sprite fixture at 1100 px and 360 px: connect, select, keyboard and touch movement, vendor purchase,
a committed descent, bank or bust, the `paused` lock, one-tap restart, verification, the satchel,
the curio shelf and loadout picker, a room overridden by a Divining Rod, mute and reduced motion,
and that nothing escapes the container or covers a control.

The SDK is consumed straight from <https://github.com/spokesz/friendsdk>, pinned to commit
`da4828f`, and needs no changes to the SDK. Upstream keeps `dist/` out of version control and
defines no `prepare` script, which is the one lifecycle npm runs for a git dependency, so
`scripts/build-sdk.mjs` builds the package in place on `postinstall` using the SDK's own
devDependencies. One unrelated observation from building against a clone of the SDK repo, in case
it is useful upstream: `scripts/check-games.mjs` allow-lists only `dist/`, `src/` and `node_modules/` as
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
| `game/rules.ts` | Typed tuning read from `game.json`, room resolution, item effects, depth bands |
| `game/items.ts` | The curio catalogue, carry-slot rules and empty-room drops |
| `game/item-art.ts` | One-bit 16 × 16 masks, one per curio |
| `game/fairness.ts` | SHA-256 and the commit-and-reveal room draw |
| `game/game.json` | Torch cost, outcome weights, rewards, room weights, pot ladder, consumable rules |
| `game/style.css` | Cavern palette, descent layout, responsive rules |
| `scripts/tuning.mjs` | Economy solver and verifier |
| `scripts/items.mjs` | Carry-item solver: prices, pair overlaps, drop weights |
| `scripts/verify.mjs` | Independent run verification: `node:crypto`, imports nothing from `game/` |
| `scripts/check-game.mjs` | Definition, weight and roll-boundary validation |
| `scripts/check-browser.mjs` | End-to-end browser check |
| `scripts/fixture.mjs` | The SDK's wallet/RPC fixture, vendored for the browser check |
| `scripts/build-sdk.mjs` | Builds the git-installed SDK on `postinstall` |
| `tests/fairness.test.mjs` | Digest, draw and room-boundary tests |
| `tests/items.test.mjs` | Curio effects, tagged reroll and drop draws, carry-slot rules |
| `tests/verify.test.mjs` | Holds the independent verifier to the shipped resolver |

## Assets

See [NOTICE.md](NOTICE.md). No third-party art. The cavern ledge uses the SDK's own world renderer and prop set
(`@rarefriends/friendsdk/world`) with geometry authored in `world.ts`; the dungeon rooms are inline
SVG generated in `descent.tsx`, with silhouettes seeded from each room's own committed draw. The
curio icons are hand-authored one-bit 16 × 16 masks in `item-art.ts` — the same register as the
Friend's canonical sprites — painted by the SDK's own `ItemArt` in `currentColor`, so a selected
row lights its icon without a second asset. The
Friend's sprites come from the SDK's pinned canonical artwork deployment and are never rotated,
scaled non-integrally, recoloured or replaced. Sound uses the SDK's ten-cue kit
(`@rarefriends/friendsdk/sounds`). The SDK's world view ships a white ground and signal-green
prompts, and `game-frame.css` ships a light `#eee` menu panel, so `style.css` themes both DOM trees
itself rather than importing `@rarefriends/friendsdk/world-view.css` — the renderer output and the
canonical Friend pixels are untouched, and the game's build stays clear of the SDK's `assets/`
directory. The menu body is re-laid as a flex column with one gap so every panel keeps the same
rhythm; the SDK spaces only paragraphs, which leaves anything else flush against the control below
it. Each menu's primary action goes in `GameMenu`'s pinned `footer` rather than the scrolling body,
so a long loadout list cannot bury it.
