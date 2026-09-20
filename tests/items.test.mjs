// Run with: npm test
//
// Carry-items bend the result of a room but never its draw. These tests hold that line: every
// override is recomputable from the same committed nonce, records the roll it replaced, and
// leaves the published weights totalling 10000 bps.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "deeper-items-"));
const game = name => fileURLToPath(new URL(`../game/${name}`, import.meta.url));
await build({
  entryPoints: [game("fairness.ts"), game("rules.ts"), game("items.ts"), game("item-art.ts")],
  bundle: true, format: "esm", platform: "neutral", target: "es2022", outdir: directory, logLevel: "error",
});
const { drawRoom } = await import(join(directory, "fairness.js"));
const { enterRoom, rerollRoom, peekRoom, oddsFor, potFor, tierStep, ropeShare, MAX_DEPTH, ROOMS } =
  await import(join(directory, "rules.js"));
const { ITEMS, CARRY_CAP, canCarry, dropFor, holds, kitFor, slotsUsed, spend, itemFor } =
  await import(join(directory, "items.js"));
const { ITEM_ART } = await import(join(directory, "item-art.js"));
const definition = JSON.parse(await readFile(new URL("../game/game.json", import.meta.url), "utf8"));
const { world, setOf } = await import(new URL("../scripts/items.mjs", import.meta.url).href);

test.after(() => rm(directory, { recursive: true, force: true }));

/** Find a nonce whose room at `depth` resolves naturally to `kind` for the given loadout. */
function seedFor(kind, depth, carried = []) {
  for (let index = 0; index < 20_000; index++) {
    const nonce = `seek-${kind}-${depth}-${index}`;
    if (enterRoom(nonce, 1n, depth, 0, carried).natural === kind) return nonce;
  }
  throw new Error(`no ${kind} at depth ${depth}`);
}

test("a Ward turns the trap it was armed for into an empty room, and is spent either way", () => {
  const nonce = seedFor("trap", 3);
  const bare = enterRoom(nonce, 1n, 3, 2);
  assert.equal(bare.kind, "trap");
  assert.deepEqual(bare.used, []);

  const warded = enterRoom(nonce, 1n, 3, 2, ["ward"], { arm: true });
  assert.equal(warded.natural, "trap", "the committed draw is untouched");
  assert.equal(warded.kind, "empty");
  assert.equal(warded.tier, 2, "surviving a trap does not advance the tier");
  assert.deepEqual(warded.used, ["ward"]);
  assert.equal(warded.draw.hash, bare.draw.hash, "the same room, the same digest");

  const safe = seedFor("loot", 3);
  const wasted = enterRoom(safe, 1n, 3, 2, ["ward"], { arm: true });
  assert.equal(wasted.kind, "loot");
  assert.deepEqual(wasted.used, ["ward"], "a safe room still spends the Ward");

  const unarmed = enterRoom(nonce, 1n, 3, 2, ["ward"]);
  assert.equal(unarmed.kind, "trap", "an unarmed Ward does nothing");
  assert.deepEqual(unarmed.used, []);
});

test("a Divining Rod forces loot and still reports the roll it overrode", () => {
  const nonce = seedFor("trap", 5);
  const forced = enterRoom(nonce, 1n, 5, 1, ["divining-rod"], { force: true });
  assert.equal(forced.natural, "trap");
  assert.equal(forced.kind, "loot");
  assert.equal(forced.tier, 2);
  assert.deepEqual(forced.used, ["divining-rod"]);
  assert.equal(forced.draw.preimage, `${nonce}:1:5`, "the preimage a verifier recomputes is unchanged");
});

test("a Lucky Charm rerolls against a second committed draw that can still be a trap", () => {
  const nonce = seedFor("trap", 4);
  const sprung = enterRoom(nonce, 1n, 4, 1, ["lucky-charm"]);
  assert.equal(sprung.kind, "trap");

  const rerolled = rerollRoom(sprung, nonce, 1n, 1, ["lucky-charm"]);
  assert.equal(rerolled.reroll.preimage, `${nonce}:1:4:reroll`);
  assert.equal(rerolled.reroll.hash, createHash("sha256").update(`${nonce}:1:4:reroll`).digest("hex"));
  assert.notEqual(rerolled.reroll.hash, sprung.draw.hash, "the reroll is not the room roll again");
  assert.deepEqual(rerolled.used, ["lucky-charm"]);
  assert.equal(rerolled.draw.hash, sprung.draw.hash, "the original draw is still on the record");

  // Over many sprung traps the reroll lands on every kind, trap included.
  const kinds = new Set();
  for (let index = 0; index < 2000; index++) {
    const seed = `charm-${index}`;
    const room = enterRoom(seed, 1n, 6, 1, ["lucky-charm"]);
    if (room.kind === "trap") kinds.add(rerollRoom(room, seed, 1n, 1, ["lucky-charm"]).kind);
  }
  assert.deepEqual([...kinds].sort(), ["empty", "loot", "trap"], "a reroll can still bust");
});

test("the Greed Idol shifts trap odds without breaking the 10000 bps total, and doubles the climb", () => {
  const shift = definition.deeper.itemRules.greedTrapShiftBps;
  for (const room of ROOMS) {
    const odds = oddsFor(room.depth, ["greed-idol"]);
    assert.equal(odds.trapBps + odds.lootBps + odds.emptyBps, 10_000, `depth ${room.depth} totals 10000 bps`);
    assert.equal(odds.trapBps, room.trapBps + shift, `depth ${room.depth} trap rises by the published shift`);
    assert.ok(odds.lootBps < room.lootBps && odds.emptyBps < room.emptyBps, "the shift comes out of both");
  }
  assert.equal(tierStep([]), 1);
  assert.equal(tierStep(["greed-idol"]), 2);

  const nonce = seedFor("loot", 2, ["greed-idol"]);
  assert.equal(enterRoom(nonce, 1n, 2, 3, ["greed-idol"]).tier, 5, "loot climbs two rungs");
  assert.equal(enterRoom(nonce, 1n, 2, MAX_DEPTH - 1, ["greed-idol"]).tier, MAX_DEPTH, "and still caps at the ladder");
});

test("a Loot Sack banks one rung higher, and an Escape Rope rescues half the pot", () => {
  const ladder = definition.deeper.potLadder.map(BigInt);
  assert.equal(potFor(0, ["loot-sack"]), 0n, "an empty pack is still worth nothing");
  for (let tier = 1; tier < MAX_DEPTH; tier++) {
    assert.equal(potFor(tier, ["loot-sack"]), ladder[tier], `tier ${tier} pays the next rung`);
  }
  assert.equal(potFor(MAX_DEPTH, ["loot-sack"]), ladder[MAX_DEPTH - 1], "the top rung has nowhere higher to go");
  assert.equal(ropeShare(potFor(4)), potFor(4) / 2n);
  assert.equal(ropeShare(0n), 0n);
});

test("an empty room leaves a curio at the published rate, on tagged draws of its own", () => {
  const chance = definition.deeper.itemRules.dropChanceBps;
  const counts = new Map(ITEMS.map(item => [item.id, 0]));
  let empties = 0, drops = 0;
  for (let index = 0; index < 8000; index++) {
    const nonce = `drop-${index}`;
    const room = enterRoom(nonce, 1n, 4, 1);
    if (room.kind !== "empty") { assert.equal(room.drop, null, "only empty rooms leave anything"); continue; }
    empties++;
    const gate = drawRoom(nonce, 1n, 4, "drop").roll;
    if (gate >= chance) { assert.equal(room.drop, null, "the gate draw decides whether"); continue; }
    drops++;
    assert.ok(counts.has(room.drop), "the drop is a catalogue item");
    counts.set(room.drop, counts.get(room.drop) + 1);
    assert.equal(room.drop, dropFor(drawRoom(nonce, 1n, 4, "drop-item")), "a second draw decides which");
  }
  assert.ok(empties > 700, `saw ${empties} empty rooms`);
  const rate = (drops / empties) * 10_000;
  assert.ok(Math.abs(rate - chance) < 900, `dropped at ${rate.toFixed(0)} bps against a published ${chance}`);
  for (const item of ITEMS) {
    const share = (counts.get(item.id) / drops) * 10_000;
    assert.ok(Math.abs(share - item.dropWeightBps) < 1200,
      `${item.name} dropped at ${share.toFixed(0)} bps against a published ${item.dropWeightBps}`);
  }
});

test("a room an item bent leaves nothing behind, however it ended up empty", () => {
  // A Ward turning a trap aside reaches the same EMPTY as an ordinary one, and must not pay out:
  // the solver prices the Ward against a run where it does not.
  let warded = 0;
  for (let index = 0; index < 4000 && warded < 200; index++) {
    const nonce = `bent-${index}`;
    if (enterRoom(nonce, 1n, 6, 2).natural !== "trap") continue;
    warded++;
    const room = enterRoom(nonce, 1n, 6, 2, ["ward"], { arm: true });
    assert.equal(room.kind, "empty");
    assert.equal(room.drop, null, "a turned-aside trap is not also a find");
  }
  assert.ok(warded > 50, `exercised ${warded} warded traps`);
});

test("the kit that goes down the stairs always fits the carry cap", () => {
  const all = () => 1;
  assert.deepEqual(kitFor(["ward", "lantern"], all), ["ward", "lantern"]);
  assert.deepEqual(kitFor(["greed-idol"], all), ["greed-idol"]);

  // The picker remembers a choice across runs, so a loadout can outlive the stock that made it
  // legal. Re-acquiring the missing piece must not smuggle a third slot down the stairs.
  const stale = ["ward", "greed-idol"];
  assert.deepEqual(kitFor(stale, id => (id === "ward" ? 0 : 1)), ["greed-idol"]);
  assert.deepEqual(kitFor(stale, all), ["ward"], "the Idol no longer fits beside a restored Ward");
  for (const chosen of [stale, ["greed-idol", "ward"], ["ward", "lantern", "lucky-charm"], ITEMS.map(i => i.id)]) {
    assert.ok(slotsUsed(kitFor(chosen, all)) <= CARRY_CAP, `${chosen.join("+")} folds under the cap`);
  }
  assert.deepEqual(kitFor(["ward", "ward"], all), ["ward"], "no duplicates survive the fold");
  assert.deepEqual(kitFor([], all), []);
});

test("a peek reports exactly what entering the room would have resolved to", () => {
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    for (const carried of [[], ["greed-idol"]]) {
      for (let index = 0; index < 60; index++) {
        const nonce = `peek-${depth}-${index}`;
        assert.equal(peekRoom(nonce, 1n, depth, carried), enterRoom(nonce, 1n, depth, 0, carried).natural);
      }
    }
  }
});

test("the carry cap counts slots, so the Greed Idol travels alone", () => {
  assert.equal(CARRY_CAP, 2);
  assert.equal(itemFor("greed-idol").slots, 2);
  assert.equal(slotsUsed(["ward", "lantern"]), 2);
  assert.equal(canCarry(["ward"], "lantern"), true);
  assert.equal(canCarry(["ward", "lantern"], "ward"), false, "no duplicates");
  assert.equal(canCarry(["ward"], "greed-idol"), false, "the Idol needs both slots");
  assert.equal(canCarry(["greed-idol"], "ward"), false, "and leaves none behind");
  assert.equal(canCarry([], "greed-idol"), true);
  for (const item of ITEMS) assert.ok(canCarry([], item.id), `${item.name} fits an empty satchel`);

  assert.deepEqual(spend(["ward", "lantern"], "ward"), ["lantern"]);
  assert.deepEqual(spend(["ward"], "lantern"), ["ward"], "spending what you do not hold changes nothing");
  assert.equal(holds(["ward"], "ward"), true);
});

test("every curio carries a square one-bit mask the SDK's ItemArt can paint", () => {
  assert.deepEqual(Object.keys(ITEM_ART).sort(), ITEMS.map(item => item.id).sort(), "one mask per curio");
  for (const item of ITEMS) {
    const rows = item.art.rows;
    assert.deepEqual(rows, ITEM_ART[item.id], "the catalogue carries the mask ItemArt will read");
    assert.equal(rows.length, 16, `${item.name} is 16 rows tall`);
    for (const [index, row] of rows.entries()) {
      assert.equal(row.length, 16, `${item.name} row ${index} is 16 wide`);
      assert.match(row, /^[.#]{16}$/, `${item.name} row ${index} is ink or bare`);
    }
    // A mask of all ink or no ink renders as a blank square either way.
    const ink = rows.join("").split("").filter(pixel => pixel === "#").length;
    assert.ok(ink > 40 && ink < 216, `${item.name} reads as a silhouette, not a blank (${ink} of 256 lit)`);
  }
  assert.equal(new Set(ITEMS.map(item => item.art.rows.join("\n"))).size, ITEMS.length, "no two curios share a mask");
});

test("the solver prices the rules the game actually plays", () => {
  // scripts/items.mjs restates the mechanics to solve them. Nothing else forces the two statements
  // to agree, so a change to tierStep or the Idol's shift could leave the published prices costing
  // a game nobody plays. Hold them together here rather than trusting the duplication.
  const BPS = 10_000;
  const loadouts = [[], ["greed-idol"], ["loot-sack"], ["ward"], ["ward", "lantern"]];
  for (const carried of loadouts) {
    const seen = world(setOf(carried));
    assert.equal(seen.up(0), tierStep(carried), `${carried.join("+") || "bare"} climbs the same`);
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      const odds = oddsFor(depth, carried);
      for (const [name, solved, played] of [
        ["trap", seen.trap[depth - 1], odds.trapBps],
        ["loot", seen.loot[depth - 1], odds.lootBps],
        ["empty", seen.empty[depth - 1], odds.emptyBps],
      ]) {
        assert.ok(Math.abs(solved * BPS - played) <= 1,
          `depth ${depth} ${name}: solver ${(solved * BPS).toFixed(2)} bps, game ${played} bps`);
      }
    }
    for (let tier = 0; tier <= MAX_DEPTH; tier++) {
      const played = Number(potFor(tier, carried)) / 1e18;
      assert.ok(Math.abs(seen.pot(tier) - played) < 1e-9, `${carried.join("+") || "bare"} tier ${tier} pot`);
    }
  }
});
