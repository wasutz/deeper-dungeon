#!/usr/bin/env node
// Prices Deeper's carry-items from the same backward induction that shapes the pot ladder.
//
//   npm run items            price the committed catalogue and print what each item does to a run
//
// scripts/check-game.mjs imports `priceItems` so a published price can never drift from the
// solver that justifies it.
//
// An item is worth the expected value it adds to a run. A torch buys 0.9059 RF of expected pot
// for 1 RF, so an item that adds `gain` is priced at `gain / baselineEV` -- the same RF-per-RF
// rate the torch already charges, rather than a number chosen to feel right.
//
// The state is (depth, tier, held). `held` is a set, because items interact: a Lantern is worth
// nothing next to an Escape Rope, and a Divining Rod is worth more next to a Lucky Charm. Only
// a full lattice prices that honestly, so the solver carries the set rather than one flag.

import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const game = JSON.parse(await readFile(new URL("../game/game.json", import.meta.url), "utf8"));
const { maxDepth: D, rooms, potLadder, items: CATALOGUE, itemRules } = game.deeper;
const RF = 10n ** 18n;
const BPS = 10_000;

const CARRY_CAP = itemRules.carryCap;
const ladder = potLadder.map(value => Number(BigInt(value)) / Number(RF));

export const IDS = CATALOGUE.map(item => item.id);
const BIT = Object.fromEntries(IDS.map((id, index) => [id, 1 << index]));
export const setOf = ids => ids.reduce((set, id) => set | BIT[id], 0);
const ALL = (1 << IDS.length) - 1;
const SLOTS = Object.fromEntries(CATALOGUE.map(item => [item.id, item.slots]));
const size = set => IDS.reduce((total, id) => total + ((set & BIT[id]) ? SLOTS[id] : 0), 0);
const has = (set, id) => (set & BIT[id]) !== 0;
const without = (set, id) => set & ~BIT[id];

/**
 * Room weights and the pot ladder as a given loadout sees them.
 *
 * The Greed Idol is the only item that touches either. A flat pot multiplier would have been
 * inert -- value is linear in pot scale, so it changes no decision and only the trap shift would
 * bite, which makes optimal play *more* timid. Advancing two tiers per loot instead rewards the
 * descent itself, which is what the item is for.
 */
export function world(set) {
  const greed = has(set, "greed-idol");
  const shift = greed ? itemRules.greedTrapShiftBps / BPS : 0;
  const trap = [], loot = [], empty = [];
  for (const room of rooms) {
    const spare = (room.lootBps + room.emptyBps) / BPS;
    const drain = spare === 0 ? 0 : shift / spare;
    trap.push(room.trapBps / BPS + shift);
    loot.push((room.lootBps / BPS) * (1 - drain));
    empty.push((room.emptyBps / BPS) * (1 - drain));
  }
  const step = greed ? 2 : 1;
  const bonus = has(set, "loot-sack") ? 1 : 0;
  return {
    trap, loot, empty,
    up: tier => Math.min(tier + step, D),
    pot: tier => (tier === 0 ? 0 : ladder[Math.min(tier + bonus, D) - 1]),
  };
}

/**
 * V[depth][tier][held]. Sets only ever shrink as charges are spent, and every transition steps
 * one room deeper, so a single descending pass over depth resolves every dependency.
 */
export function solve(drop = 0) {
  const V = Array.from({ length: D + 1 }, () =>
    Array.from({ length: D + 1 }, () => new Array(ALL + 1).fill(0)));
  const legal = [];
  for (let set = 0; set <= ALL; set++) if (size(set) <= CARRY_CAP) legal.push(set);

  for (const set of legal) {
    const { pot } = world(set);
    for (let tier = 0; tier <= D; tier++) V[D][tier][set] = pot(tier);
  }

  for (let depth = D - 1; depth >= 0; depth--) for (const set of legal) {
    const { trap, loot, empty, up, pot } = world(set);
    const [tr, lo, em] = [trap[depth], loot[depth], empty[depth]];
    const at = (tier, held) => V[depth + 1][tier][held];

    for (let tier = 0; tier <= D; tier++) {
      const bank = pot(tier);

      // What a revealed trap is worth. Both reactive items answer it without being committed
      // in advance, which is exactly why they cost more than the Ward.
      let sprung = 0;
      if (has(set, "escape-rope")) sprung = Math.max(sprung, bank * itemRules.ropeShareBps / BPS);
      if (has(set, "lucky-charm")) {
        const after = without(set, "lucky-charm");
        // The reroll is a room like any other, so a rope still in hand answers a second trap.
        const again = has(after, "escape-rope") ? bank * itemRules.ropeShareBps / BPS : 0;
        sprung = Math.max(sprung, tr * again + lo * at(up(tier), after) + em * (at(tier, after) + drop));
      }
      const descend = tr * sprung + lo * at(up(tier), set) + em * (at(tier, set) + drop);

      let best = Math.max(bank, descend);

      // Armed in advance and spent either way, so a safe room wastes it.
      if (has(set, "ward")) {
        const after = without(set, "ward");
        // Spent either way, and the trap it turns aside leaves nothing behind.
        best = Math.max(best, lo * at(up(tier), after) + tr * at(tier, after) + em * (at(tier, after) + drop));
      }
      if (has(set, "divining-rod")) best = Math.max(best, at(up(tier), without(set, "divining-rod")));

      // The Lantern buys the choice itself: see the committed room, then act on what it says.
      if (has(set, "lantern")) {
        const after = without(set, "lantern");
        const known = kind => {
          if (kind === "loot") return Math.max(bank, at(up(tier), after));
          if (kind === "empty") return Math.max(bank, at(tier, after) + drop);
          let value = bank;
          if (has(after, "escape-rope")) value = Math.max(value, bank * itemRules.ropeShareBps / BPS);
          if (has(after, "lucky-charm")) {
            const spent = without(after, "lucky-charm");
            value = Math.max(value, lo * at(up(tier), spent) + em * at(tier, spent));
          }
          if (has(after, "ward")) value = Math.max(value, at(tier, without(after, "ward")));
          if (has(after, "divining-rod")) value = Math.max(value, at(up(tier), without(after, "divining-rod")));
          return value;
        };
        best = Math.max(best, tr * known("trap") + lo * known("loot") + em * known("empty"));
      }

      V[depth][tier][set] = best;
    }
  }
  return V;
}

/**
 * Standalone gain per item, and the price that keeps the torch's RF-per-RF rate.
 *
 * Prices and the worth of a drop define each other: an empty room is worth more than the pot it
 * preserves because it also leaves a curio, and what that curio is worth is what curios cost.
 * Solved as a fixed point rather than left out -- ignoring it prices the Ward and the Greed Idol
 * against a game neither of them is played in, since one manufactures empty rooms and the other
 * destroys them. It settles in a few passes: a drop moves the baseline by under a fifth.
 */
export function priceItems() {
  const chance = itemRules.dropChanceBps / BPS;
  let drop = 0;
  let settled;
  for (let pass = 0; pass < 64; pass++) {
    const V = solve(drop * chance);
    const baseline = V[0][0][0];
    const priced = CATALOGUE.map(item => {
      const gain = V[0][0][BIT[item.id]] - baseline;
      return { ...item, gain, price: gain / baseline };
    });
    const weights = dropWeights(priced);
    const next = priced.reduce((total, item, index) => total + (weights[index] / BPS) * item.price, 0);
    settled = { baseline, priced, V, drop, chance, passes: pass + 1 };
    if (Math.abs(next - drop) < 1e-12) break;
    drop = next;
  }
  return settled;
}

/** Round to whole hundredths of an RF so a published price stays a readable decimal string. */
export const toBaseUnits = value => (BigInt(Math.round(value * 100)) * RF / 100n).toString();

const entryPoint = process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href;

/**
 * Drop weights are inversely proportional to price, so a drop is worth the same whichever item
 * it is and the cheap items are the ones you see most. Largest remainder keeps the total at
 * exactly 10000 bps.
 */
export function dropWeights(priced) {
  const shares = priced.map(item => 1 / item.price);
  const total = shares.reduce((sum, share) => sum + share, 0);
  const exact = shares.map(share => (share / total) * BPS);
  const floors = exact.map(Math.floor);
  const order = exact.map((value, index) => [value - floors[index], index])
    .sort((a, b) => b[0] - a[0]);
  let spare = BPS - floors.reduce((sum, value) => sum + value, 0);
  for (const [, index] of order) { if (spare-- <= 0) break; floors[index]++; }
  return floors;
}

if (entryPoint && process.argv.includes("--write")) {
  const { priced } = priceItems();
  const weights = dropWeights(priced);
  const source = JSON.parse(await readFile(new URL("../game/game.json", import.meta.url), "utf8"));
  source.deeper.items = source.deeper.items.map((item, index) => ({
    ...item,
    price18: toBaseUnits(priced[index].price),
    dropWeightBps: weights[index],
  }));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(new URL("../game/game.json", import.meta.url), `${JSON.stringify(source, null, 2)}\n`);
  console.log("Wrote derived prices and drop weights into game/game.json.");
}

if (entryPoint && !process.argv.includes("--write")) {
  const { baseline, priced, V, drop, chance, passes } = priceItems();
  console.log(`\nBaseline run, no items: ${baseline.toFixed(4)} RF expected pot.`);
  console.log(`Carry cap: ${CARRY_CAP} items per run.`);
  console.log(`A curio is worth ${drop.toFixed(4)} RF and an empty room leaves one ${(chance * 100).toFixed(0)}% of the time.`);
  console.log(`House edge on the pot layer: ${((1 - baseline) * 100).toFixed(2)}%. Prices settled in ${passes} passes.\n`);
  console.log("  item             gain RF   price RF   published   with it");
  for (const item of priced) {
    const published = Number(BigInt(item.price18) * 10000n / RF) / 10000;
    const flag = Math.abs(published - Math.round(item.price * 100) / 100) < 1e-9 ? " " : "!";
    console.log(`  ${item.name.padEnd(14)} ${item.gain.toFixed(4).padStart(9)} ${item.price.toFixed(4).padStart(10)} ${published.toFixed(2).padStart(11)} ${flag}  ${(baseline + item.gain).toFixed(4)} RF/run`);
  }

  console.log("\n  legal pair                        together   apart   overlap    cost   edge");
  for (let i = 0; i < IDS.length; i++) for (let j = i + 1; j < IDS.length; j++) {
    const [a, b] = [IDS[i], IDS[j]];
    if (size(BIT[a] | BIT[b]) > CARRY_CAP) continue;
    const together = V[0][0][BIT[a] | BIT[b]] - baseline;
    const apart = (V[0][0][BIT[a]] - baseline) + (V[0][0][BIT[b]] - baseline);
    const cost = (priced[i].gain + priced[j].gain) / baseline;
    const label = `${CATALOGUE[i].name} + ${CATALOGUE[j].name}`;
    console.log(`  ${label.padEnd(33)} ${together.toFixed(4).padStart(8)} ${apart.toFixed(4).padStart(8)} ${((together / apart - 1) * 100).toFixed(0).padStart(7)}% ${cost.toFixed(4).padStart(7)} ${(together - cost).toFixed(4).padStart(7)}`);
  }

  let bestSet = 0;
  for (let set = 0; set <= ALL; set++) if (size(set) <= CARRY_CAP && V[0][0][set] > V[0][0][bestSet]) bestSet = set;
  const kit = IDS.filter(id => has(bestSet, id)).map(id => CATALOGUE.find(item => item.id === id).name);
  console.log(`\n  Strongest legal loadout: ${kit.join(" + ")} -> ${V[0][0][bestSet].toFixed(4)} RF/run (${(V[0][0][bestSet] / baseline).toFixed(2)}x baseline).`);
}
