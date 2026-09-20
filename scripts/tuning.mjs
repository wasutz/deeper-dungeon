#!/usr/bin/env node
// Verifies the Deeper tuning table: optimal-stopping EV, survival odds, average payout,
// and the run-result distribution that game.json publishes as its outcome weights.
//
//   npm run tuning                      verify the committed game.json
//   node scripts/tuning.mjs --solve     re-solve the ladder for the EV target
//
// scripts/check-game.mjs imports `verify` from here so the published weights can never drift
// from the simulation without a check failing.
//
// A run is a walk over (depth, tier). Depth drives the trap odds; tier drives the pot.
// An EMPTY room advances depth without advancing tier, so depth and pot are not the
// same axis and the optimal policy has to be solved, not read off a single column.

import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const here = new URL("./", import.meta.url);
const game = JSON.parse(await readFile(new URL("../game/game.json", here), "utf8"));
const { maxDepth, rooms, potLadder } = game.deeper;
const RF = 10n ** 18n;
const EV_TARGET = 0.9;
const BPS = 10_000;

const trap = rooms.map(room => room.trapBps / BPS);
const loot = rooms.map(room => room.lootBps / BPS);
const empty = rooms.map(room => room.emptyBps / BPS);
const ladder = potLadder.map(value => Number(BigInt(value)) / Number(RF));
const pot = tier => (tier === 0 ? 0 : ladder[tier - 1]);

/** Backward induction over (depth, tier). Returns the optimal policy and its value. */
function solve(values) {
  const worth = tier => (tier === 0 ? 0 : values[tier - 1]);
  const value = Array.from({ length: maxDepth + 1 }, () => new Array(maxDepth + 1).fill(0));
  const descend = Array.from({ length: maxDepth + 1 }, () => new Array(maxDepth + 1).fill(false));
  for (let tier = 0; tier <= maxDepth; tier++) value[maxDepth][tier] = worth(tier);
  for (let depth = maxDepth - 1; depth >= 0; depth--) {
    for (let tier = 0; tier <= depth; tier++) {
      const next = loot[depth] * value[depth + 1][tier + 1] + empty[depth] * value[depth + 1][tier];
      descend[depth][tier] = next > worth(tier);
      value[depth][tier] = Math.max(worth(tier), next);
    }
  }
  return { value, descend, ev: value[0][0] };
}

/** Exact forward distribution of run results under a policy. */
function distribution(descend) {
  const mass = Array.from({ length: maxDepth + 1 }, () => new Array(maxDepth + 1).fill(0));
  mass[0][0] = 1;
  const banked = new Array(maxDepth + 1).fill(0);
  const bustedAt = new Array(maxDepth + 1).fill(0);
  const bankedAt = new Array(maxDepth + 1).fill(0);
  let reached = new Array(maxDepth + 1).fill(0);
  reached[0] = 1;
  for (let depth = 0; depth <= maxDepth; depth++) {
    for (let tier = 0; tier <= depth; tier++) {
      const here = mass[depth][tier];
      if (here === 0) continue;
      if (depth === maxDepth || !descend[depth][tier]) { banked[tier] += here; bankedAt[depth] += here; continue; }
      bustedAt[depth + 1] += here * trap[depth];
      mass[depth + 1][tier + 1] += here * loot[depth];
      mass[depth + 1][tier] += here * empty[depth];
      reached[depth + 1] += here * (loot[depth] + empty[depth]);
    }
  }
  const bust = bustedAt.reduce((sum, value) => sum + value, 0);
  return { banked, bust, bustedAt, bankedAt, reached };
}

/** Publishable weights: every tier stays representable, so each is floored at 1 bp. */
function weights(banked, bust) {
  const raw = banked.slice(1).map(value => Math.max(1, Math.round(value * BPS)));
  const lost = BPS - raw.reduce((sum, value) => sum + value, 0);
  if (lost < 1) throw new Error("Bust weight underflowed; the reference line is too safe.");
  return { lost, tiers: raw, lostExact: bust };
}

function report(values, label, quiet = false) {
  const { descend, ev } = solve(values);
  const { banked, bust, bustedAt, bankedAt, reached } = distribution(descend);
  const { lost, tiers } = weights(banked, bust);
  const tableEv = (lost * 0 + tiers.reduce((sum, bps, index) => sum + bps * values[index], 0)) / BPS;

  const say = quiet ? () => {} : console.log;
  say(`\n${label}`);
  say(`  optimal-stopping EV        ${ev.toFixed(4)} RF per run   (house edge ${((1 - ev) * 100).toFixed(2)}%)`);
  say(`  published-table EV         ${tableEv.toFixed(4)} RF per run   (house edge ${((1 - tableEv) * 100).toFixed(2)}%)`);
  say(`  bust chance                ${(bust * 100).toFixed(2)}%`);
  say(`  average payout when banked ${(ev / (1 - bust)).toFixed(4)} RF`);
  say(`  maximum prize              ${values[maxDepth - 1]} RF`);

  // Stopping is not monotone in tier: each tier faces its own climb to the next one, so a
  // larger pot can be worth pushing while a smaller one is not.
  say("\n  depth  trap%   reach%   bust here%  bank here%  reference line banks at tier");
  for (let depth = 1; depth <= maxDepth; depth++) {
    const banks = descend[depth].flatMap((value, tier) => tier <= depth && !value ? [tier] : []);
    const line = depth === maxDepth ? "any (dungeon floor)" : banks.length ? banks.join(", ") : "none — always descend";
    say(`  ${String(depth).padStart(5)}  ${(trap[depth - 1] * 100).toFixed(0).padStart(4)}%  ${(reached[depth] * 100).toFixed(2).padStart(6)}%  ${(bustedAt[depth] * 100).toFixed(2).padStart(9)}%  ${(bankedAt[depth] * 100).toFixed(2).padStart(9)}%  ${line}`);
  }

  say("\n  tier   pot RF   P(run ends here)   published bps");
  say(`  lost     0.00           ${(bust * 100).toFixed(2)}%            ${lost}`);
  for (let tier = 1; tier <= maxDepth; tier++) {
    say(`  ${String(tier).padStart(4)}  ${values[tier - 1].toFixed(2).padStart(7)}           ${(banked[tier] * 100).toFixed(2).padStart(5)}%            ${tiers[tier - 1]}`);
  }
  return { ev, lost, tiers, tableEv };
}

// A constant ratio cannot hold a player's interest past the shallow rooms: trap odds rise
// with depth, so the pot has to accelerate to keep the next room worth entering. The ladder
// is therefore built step by step against the break-even growth for each room.
//
//   descending from tier t is worth it  <=>  loot * V(t+1) + empty * V(t) > V(t)
//   break-even growth                    =  (1 - empty) / loot
//
// Below the target tier each step clears break-even by `margin`, so descending is correct but
// only just — that razor edge is the game. Above it, growth is held at `tail` of break-even,
// so the deep rooms pay spectacularly without ever being the right call.
function shapeLadder(target, margin, tail) {
  const values = [1];
  for (let tier = 1; tier < maxDepth; tier++) {
    const breakEven = (1 - empty[tier]) / loot[tier];
    const growth = tier < target ? 1 + (breakEven - 1) * (1 + margin) : 1 + (breakEven - 1) * tail;
    values.push(values[tier - 1] * growth);
  }
  return values;
}

/** Scale is free: it moves EV linearly and leaves the optimal policy untouched. */
function fitLadder(target, margin, top) {
  let low = 0, high = 1;
  for (let step = 0; step < 60; step++) {
    const tail = (low + high) / 2;
    const shape = shapeLadder(target, margin, tail);
    const scaled = shape.map(value => value * (EV_TARGET / solve(shape).ev));
    if (scaled[maxDepth - 1] < top) low = tail; else high = tail;
  }
  const shape = shapeLadder(target, margin, (low + high) / 2);
  const scale = EV_TARGET / solve(shape).ev;
  return { tail: (low + high) / 2, values: shape.map(value => Math.round(value * scale * 100) / 100) };
}

const entryPoint = process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href;

if (entryPoint && process.argv.includes("--solve")) {
  const top = ladder[maxDepth - 1];
  const target = Number(process.argv[process.argv.indexOf("--target") + 1]) || 6;
  const margin = Number(process.argv[process.argv.indexOf("--margin") + 1]) || 0.04;
  const { tail, values } = fitLadder(target, margin, top);
  console.log(`Target tier ${target}, margin ${margin}, tail ${tail.toFixed(4)}, cap ${top} RF.`);
  console.log(`potLadder: ${JSON.stringify(values.map(value => (BigInt(Math.round(value * 100)) * RF / 100n).toString()))}`);
  report(values, "Solved ladder");
}

/** Re-derive everything from the tuning block and hold game.json to it. */
export function verify({ quiet = false } = {}) {
  const result = report(ladder, `Committed game.json — ${game.name}`, quiet);
  const published = game.outcomes.map(outcome => outcome.chanceBps);
  const expected = [result.lost, ...result.tiers];
  const problems = [];
  if (published.length !== expected.length || published.some((bps, index) => bps !== expected[index])) {
    problems.push(`game.json weights ${JSON.stringify(published)} do not match the simulated ${JSON.stringify(expected)}`);
  }
  if (published.reduce((sum, bps) => sum + bps, 0) !== BPS) problems.push("weights do not total 10000 bps");
  const rewards = game.outcomes.map(outcome => outcome.reward);
  const ladderUnits = ["0", ...potLadder];
  if (rewards.some((reward, index) => reward !== ladderUnits[index])) problems.push("outcome rewards do not match potLadder");
  for (const [index, room] of rooms.entries()) {
    if (room.trapBps + room.lootBps + room.emptyBps !== BPS) problems.push(`depth ${index + 1} room weights do not total 10000 bps`);
  }
  if (Math.abs(result.ev - EV_TARGET) > 0.05) {
    problems.push(`optimal-stopping EV ${result.ev.toFixed(4)} is outside 0.85-0.95 RF`);
  }
  return { ...result, problems };
}

if (entryPoint && !process.argv.includes("--solve")) {
  const { problems } = verify();
  console.log("");
  if (problems.length) { for (const problem of problems) console.error(`FAIL: ${problem}`); process.exitCode = 1; }
  else console.log("OK: game.json matches the simulation and hits the EV target.");
}
