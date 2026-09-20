// Run with: npm test
//
// The room draws are the game's only source of randomness, so the digest behind them is held to
// node:crypto, and the roll-to-room mapping is held to the boundaries game.json publishes.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The game's modules are TypeScript and import game.json, so compile them to a temporary
// directory the way the SDK runner does rather than duplicating the rules in the test.
const directory = await mkdtemp(join(tmpdir(), "deeper-fairness-"));
// fileURLToPath, not URL.pathname: a repository path containing a space arrives percent-encoded
// and esbuild cannot resolve it.
const game = name => fileURLToPath(new URL(`../game/${name}`, import.meta.url));
await build({
  entryPoints: [game("fairness.ts"), game("rules.ts")],
  bundle: true, format: "esm", platform: "neutral", target: "es2022", outdir: directory, logLevel: "error",
});
const { sha256Hex, drawRoom } = await import(join(directory, "fairness.js"));
const { enterRoom, ROOMS, MAX_DEPTH, potFor } = await import(join(directory, "rules.js"));
const definition = JSON.parse(await readFile(new URL("../game/game.json", import.meta.url), "utf8"));

test.after(() => rm(directory, { recursive: true, force: true }));

test("sha256Hex matches node:crypto across block boundaries and multi-byte input", () => {
  const vectors = ["", "abc", "deeper", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64),
    "a".repeat(65), "a".repeat(200), "é€𝄞 cavern", randomBytes(300).toString("hex")];
  for (const value of vectors) {
    assert.equal(sha256Hex(value), createHash("sha256").update(value).digest("hex"), `digest for ${value.length} bytes`);
  }
});

test("a room draw is a pure function of the commitment, the play and the depth", () => {
  const first = drawRoom("abc123", 7n, 3);
  assert.deepEqual(drawRoom("abc123", 7n, 3), first, "the same inputs always give the same room");
  assert.equal(first.preimage, "abc123:7:3");
  assert.equal(first.hash, createHash("sha256").update("abc123:7:3").digest("hex"));
  assert.notEqual(drawRoom("abc123", 8n, 3).roll, undefined);
  for (const other of [drawRoom("abc124", 7n, 3), drawRoom("abc123", 8n, 3), drawRoom("abc123", 7n, 4)]) {
    assert.notEqual(other.hash, first.hash, "changing any input changes the draw");
  }
});

// The inputs are fixed, so this is a pinned measurement rather than a sampled one: chi-square
// over ten equal bands of 40 000 draws. Nine degrees of freedom put the p=0.001 tail at 27.9,
// so a real skew in the digest or the fold fails here while the committed seeds cannot drift.
test("rolls fill the contract's 10000 buckets evenly", () => {
  const deciles = new Array(10).fill(0);
  const samples = 40_000;
  for (let index = 0; index < samples; index++) {
    const { roll } = drawRoom(`seed-${index}`, 1n, 1);
    assert.ok(Number.isInteger(roll) && roll >= 0 && roll < 10_000, "rolls stay inside the bucket space");
    deciles[Math.floor(roll / 1000)]++;
  }
  const expected = samples / 10;
  const chiSquare = deciles.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
  assert.ok(chiSquare < 27.9, `decile chi-square ${chiSquare.toFixed(2)} exceeds the p=0.001 bound of 27.9`);
});

test("enterRoom classifies every draw by the weights game.json publishes", () => {
  for (const room of ROOMS) {
    assert.equal(room.trapBps + room.lootBps + room.emptyBps, 10_000, `depth ${room.depth} totals 10000 bps`);
  }
  // Drive the real resolver over many committed draws and check each against the published
  // boundaries, including the first and last roll of every band that actually comes up.
  const seen = new Map();
  for (let index = 0; index < 4000; index++) {
    const nonce = `boundary-${index}`;
    for (const room of ROOMS) {
      const resolved = enterRoom(nonce, 1n, room.depth, 0);
      const { roll } = resolved.draw;
      const expected = roll < room.trapBps ? "trap" : roll < room.trapBps + room.lootBps ? "loot" : "empty";
      assert.equal(resolved.kind, expected, `depth ${room.depth} roll ${roll} resolved as ${resolved.kind}`);
      seen.set(`${room.depth}:${resolved.kind}`, (seen.get(`${room.depth}:${resolved.kind}`) ?? 0) + 1);
    }
  }
  for (const room of ROOMS) {
    for (const kind of ["trap", "loot", "empty"]) {
      assert.ok(seen.get(`${room.depth}:${kind}`) > 0, `depth ${room.depth} produced at least one ${kind}`);
    }
  }
});

test("clearing a room advances the tier only on loot, and the tier caps at the ladder", () => {
  let tier = 0;
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const room = enterRoom("fixed-nonce", 1n, depth, tier);
    assert.equal(room.depth, depth);
    if (room.kind === "loot") assert.equal(room.tier, tier + 1, "loot advances one tier");
    else assert.equal(room.tier, tier, "empty and trap leave the tier alone");
    assert.ok(room.tier <= MAX_DEPTH, "the tier never exceeds the ladder");
    if (room.kind === "trap") break;
    tier = room.tier;
  }
  assert.equal(potFor(0), 0n, "an empty pack is worth nothing");
  assert.equal(potFor(MAX_DEPTH), BigInt(definition.outcomes.at(-1).reward), "the deepest tier is the maximum prize");
  assert.equal(potFor(MAX_DEPTH + 5), potFor(MAX_DEPTH), "the pot is clamped to the ladder");
});
