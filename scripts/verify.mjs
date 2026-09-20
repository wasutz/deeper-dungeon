#!/usr/bin/env node
// Recomputes a Deeper run from its revealed nonce, independently of the game.
//
//   npm run verify -- --nonce <hex> --play <id> [--commitment <hex>] [--carried greed-idol]
//
// Nothing here imports the game. The digest comes from node:crypto rather than the SHA-256 in
// game/fairness.ts, and the room boundaries are read straight out of game.json rather than
// game/rules.ts, so agreeing with what the game showed you is evidence rather than a tautology.
//
// What this proves: every room was a pure function of (nonce, playId, depth), and the nonce hashes
// to the commitment you were shown before room 1. So no room result could have reacted to a BANK
// or DESCEND choice -- the dungeon was dealt before you played it.
//
// What it does not prove: that the nonce itself was drawn fairly. In this preview your own browser
// draws it, so there is no house on the other side; the same scheme against a contract is what
// turns this into a trust guarantee rather than a demonstration.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const game = JSON.parse(await readFile(new URL("../game/game.json", import.meta.url), "utf8"));
const { maxDepth: MAX_DEPTH, rooms: ROOMS, potLadder, items: ITEMS, itemRules } = game.deeper;
const BPS = 10_000;

const sha256 = value => createHash("sha256").update(value).digest("hex");
const draw = (nonce, playId, depth, tag) => {
  const preimage = tag ? `${nonce}:${playId}:${depth}:${tag}` : `${nonce}:${playId}:${depth}`;
  const hash = sha256(preimage);
  return { preimage, hash, roll: Number(BigInt(`0x${hash.slice(0, 8)}`) % BigInt(BPS)) };
};

const die = message => {
  console.error(`${message}\n`);
  console.error("Usage: npm run verify -- --nonce <hex> --play <id> [--commitment <hex>] [--carried a,b]");
  console.error("The game's Fair play panel prints the whole command for a finished run.");
  process.exit(1);
};

/**
 * A verifier that accepts junk and prints a confident table is worse than no verifier: the reader
 * concludes the game cheated rather than that they mistyped. Every input is checked, and a value
 * that looks like another flag is a missing value, not a nonce.
 */
const flag = name => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) die(`--${name} needs a value.`);
  return value;
};

const nonce = flag("nonce");
const play = flag("play");
const commitment = flag("commitment");
const carried = (flag("carried") ?? "").split(",").filter(Boolean);

if (!nonce || !play) die("Both --nonce and --play are required.");
if (!/^(?:[0-9a-f]{2})+$/i.test(nonce)) die(`--nonce must be an even number of hex digits, got "${nonce}".`);
if (!/^\d+$/.test(play)) die(`--play must be a whole number, got "${play}".`);
if (commitment && !/^[0-9a-f]{64}$/i.test(commitment)) die("--commitment must be 64 hex digits.");
const unknown = carried.filter(id => !ITEMS.some(item => item.id === id));
if (unknown.length) die(`Unknown curio: ${unknown.join(", ")}. Expected some of ${ITEMS.map(i => i.id).join(", ")}.`);

// Only the Greed Idol moves the boundaries a roll is read against; the rest change what a result
// resolves to, which is the player's own record, not something recomputable from the nonce.
const greedy = carried.includes("greed-idol");
const inert = carried.filter(id => id !== "greed-idol");

const oddsFor = depth => {
  const room = ROOMS[depth - 1];
  if (!greedy) return room;
  const shift = itemRules.greedTrapShiftBps;
  const spare = room.lootBps + room.emptyBps;
  const trapBps = room.trapBps + shift;
  const lootBps = room.lootBps - Math.round((room.lootBps / spare) * shift);
  return { trapBps, lootBps, emptyBps: BPS - trapBps - lootBps };
};
const classify = (roll, odds) =>
  roll < odds.trapBps ? "trap" : roll < odds.trapBps + odds.lootBps ? "loot" : "empty";
const curioFor = roll => {
  let boundary = 0;
  for (const item of ITEMS) { boundary += item.dropWeightBps; if (roll < boundary) return item.name; }
  return ITEMS[ITEMS.length - 1].name;
};

/** The pair of draws an empty room makes: one decides whether it leaves a curio, one decides which. */
const dropLine = (depth, prefix, lead) => {
  const gate = draw(nonce, play, depth, `${prefix}drop`);
  const left = gate.roll < itemRules.dropChanceBps;
  const which = left ? ` → ${curioFor(draw(nonce, play, depth, `${prefix}drop-item`).roll)}` : "";
  return `${lead} drop gate ${String(gate.roll).padStart(4)} < ${itemRules.dropChanceBps}? ${left ? "yes" : "no "}${which}`
    + `   :${prefix}drop ${gate.hash.slice(0, 16)}…`;
};

console.log(`\nDeeper — independent verification (node:crypto, ${ITEMS.length} curios published)`);
console.log(`nonce   ${nonce}`);
console.log(`play    ${play}`);
console.log(`carried ${carried.length ? carried.join(", ") : "nothing"}`);
if (inert.length) {
  console.log(`        (only the Greed Idol changes a boundary; ${inert.join(", ")} changed what a`);
  console.log(`         result resolved to, which is your record of the run, not a draw)`);
}

const computed = sha256(nonce);
console.log(`\ncommitment  sha256(nonce) = ${computed}`);
if (commitment) {
  console.log(`            shown before room 1 = ${commitment}`);
  if (computed.toLowerCase() !== commitment.toLowerCase()) {
    console.log("            MISMATCH — this nonce does not belong to that commitment.");
    console.log("\nNo rooms printed: they would be derived from a nonce that provably is not this run's.\n");
    process.exit(1);
  }
  console.log("            MATCH — the nonce was fixed before the first room.");
} else {
  console.log("            (pass --commitment to check it against what the game showed you)");
}

console.log("\n depth  roll / 10000   trap below / loot below   drew    sha256(nonce:play:depth)");
for (let depth = 1; depth <= MAX_DEPTH; depth++) {
  const odds = oddsFor(depth);
  const room = draw(nonce, play, depth);
  const kind = classify(room.roll, odds);
  const bounds = `${String(odds.trapBps).padStart(4)} / ${String(odds.trapBps + odds.lootBps).padStart(4)}`;
  console.log(`  ${String(depth).padStart(4)}  ${String(room.roll).padStart(12)}   ${bounds.padStart(23)}   ${kind.padEnd(6)}  ${room.hash.slice(0, 24)}…`);

  if (kind === "trap") {
    const reroll = draw(nonce, play, depth, "reroll");
    const after = classify(reroll.roll, odds);
    console.log(`        ├ a Lucky Charm here rerolls to ${String(reroll.roll).padStart(4)} → ${after}   :reroll ${reroll.hash.slice(0, 16)}…`);
    if (after === "empty") console.log(dropLine(depth, "reroll-", "        └ and then"));
  }
  if (kind === "empty") console.log(dropLine(depth, "", "        └"));
}

console.log(`
The "drew" column is what the roll itself said, before any curio changed what it resolved to: a Ward
turns a trap aside, a Divining Rod forces loot. Those are your choices, recorded in the game's own
Verify panel; the rolls above are what neither of you could change. A drop line is what that room
leaves if it stayed empty -- a Divining Rod that overrode it hands you nothing.

Every row is a pure function of (nonce, play, depth). Compare them against what the game showed you:
the rooms were committed before you chose to bank or descend.
Pot by loot tier: ${potLadder.map(v => Number(BigInt(v) / 10n ** 16n) / 100).join(", ")} RF.
`);
