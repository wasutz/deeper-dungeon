// Run with: npm test
//
// scripts/verify.mjs exists so a player does not have to take the game's word for a run. That is
// only worth anything if it agrees with the game -- and only evidence if it gets there
// independently, which it does: node:crypto instead of game/fairness.ts, game.json read directly
// instead of game/rules.ts. These tests drive the real script and hold it to the real resolver.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/verify.mjs", import.meta.url));

const directory = await mkdtemp(join(tmpdir(), "deeper-verify-"));
const game = name => fileURLToPath(new URL(`../game/${name}`, import.meta.url));
await build({
  entryPoints: [game("fairness.ts"), game("rules.ts"), game("items.ts")],
  bundle: true, format: "esm", platform: "neutral", target: "es2022", outdir: directory, logLevel: "error",
});
const { dropTags, enterRoom, rerollRoom, oddsFor, MAX_DEPTH } = await import(join(directory, "rules.js"));
const { drawRoom } = await import(join(directory, "fairness.js"));
const { ITEM_RULES, dropFor, itemFor } = await import(join(directory, "items.js"));
test.after(() => rm(directory, { recursive: true, force: true }));

const verify = async args => (await run(process.execPath, [script, ...args])).stdout;
const ROOM = /^\s+(\d+)\s+(\d+)\s+(\d+) \/ (\d+)\s+(trap|loot|empty)\s+([0-9a-f]+)…/;
const REROLL = /rerolls to\s+(\d+) → (\w+)\s+:reroll ([0-9a-f]+)…/;
const DROP = /drop gate\s+(\d+) < (\d+)\? (yes|no)\s*(?:→ (.+?))?\s+:(reroll-)?drop ([0-9a-f]+)…/;

/** Every line the verifier prints, attached to the room it belongs to. */
function parse(output) {
  const rooms = [];
  for (const line of output.split("\n")) {
    const room = ROOM.exec(line);
    if (room) {
      rooms.push({ depth: +room[1], roll: +room[2], trap: +room[3], upper: +room[4], kind: room[5], hash: room[6] });
      continue;
    }
    const current = rooms[rooms.length - 1];
    if (!current) continue;
    const reroll = REROLL.exec(line);
    if (reroll) { current.reroll = { roll: +reroll[1], kind: reroll[2], hash: reroll[3] }; continue; }
    const drop = DROP.exec(line);
    if (drop) {
      const record = { roll: +drop[1], gate: +drop[2], left: drop[3] === "yes", item: drop[4] ?? null, hash: drop[6] };
      if (drop[5]) current.rerollDrop = record; else current.drop = record;
    }
  }
  return rooms;
}

test("the verifier reproduces every room the game resolves, bare and under a Greed Idol", async () => {
  for (const carried of [[], ["greed-idol"]]) {
    for (const [nonce, play] of [["deadbeef", "1"], ["03142536475869", "7"], ["a".repeat(32), "42"]]) {
      const args = ["--nonce", nonce, "--play", play, ...(carried.length ? ["--carried", carried.join(",")] : [])];
      const rows = parse(await verify(args));
      assert.equal(rows.length, MAX_DEPTH, `${nonce} produced a row per room`);
      for (const row of rows) {
        const played = enterRoom(nonce, BigInt(play), row.depth, 0, carried);
        const odds = oddsFor(row.depth, carried);
        assert.equal(row.roll, played.draw.roll, `depth ${row.depth} roll`);
        assert.equal(row.hash, played.draw.hash.slice(0, row.hash.length), `depth ${row.depth} digest`);
        // The game's own natural result, not the one a curio may have overridden.
        assert.equal(row.kind, played.natural, `depth ${row.depth} result under ${carried.join("+") || "no curio"}`);
        // The boundaries it read the roll against, not merely that they are inside the roll space.
        assert.equal(row.trap, odds.trapBps, `depth ${row.depth} trap boundary`);
        assert.equal(row.upper, odds.trapBps + odds.lootBps, `depth ${row.depth} loot boundary`);

        // The duplicated logic most likely to drift is the drop gate and the weight walk behind it,
        // so hold both to the game rather than only the room rows.
        if (row.kind === "empty") {
          assert.ok(row.drop, `depth ${row.depth} prints its drop gate`);
          assert.equal(row.drop.left, played.drop !== null, `depth ${row.depth} agrees on whether a curio is left`);
          if (played.drop) assert.equal(row.drop.item, itemFor(played.drop).name, `depth ${row.depth} leaves the same curio`);
          else assert.equal(row.drop.item, null);
        } else {
          assert.equal(row.drop, undefined, `depth ${row.depth} is not empty and prints no drop`);
        }

        if (row.kind === "trap") {
          const rolled = rerollRoom(played, nonce, BigInt(play), 0, carried);
          assert.ok(row.reroll, `depth ${row.depth} prints its reroll`);
          assert.equal(row.reroll.roll, rolled.reroll.roll, `depth ${row.depth} reroll roll`);
          assert.equal(row.reroll.kind, rolled.kind, `depth ${row.depth} reroll result`);
          assert.equal(row.reroll.hash, rolled.reroll.hash.slice(0, row.reroll.hash.length), `depth ${row.depth} reroll digest`);
          // A reroll that lands empty draws its own drop pair under the reroll- prefix.
          if (rolled.kind === "empty") {
            assert.ok(row.rerollDrop, `depth ${row.depth} prints the reroll's drop gate`);
            assert.equal(row.rerollDrop.left, rolled.drop !== null, `depth ${row.depth} agrees on the reroll's drop`);
            if (rolled.drop) assert.equal(row.rerollDrop.item, itemFor(rolled.drop).name);
          } else {
            assert.equal(row.rerollDrop, undefined, "a reroll that is not empty leaves nothing");
          }
        } else {
          assert.equal(row.reroll, undefined, `depth ${row.depth} is not a trap and prints no reroll`);
        }
      }
    }
  }
});

test("a drop is printed under the tag it was drawn with, bare or after a reroll", async () => {
  // The Verify panel recomputes the drop pair from the nonce to print it, so it has to pick the
  // same tags the draw used. A rerolled room's drop hangs off the reroll: assume the bare tags and
  // the panel prints a digest and a roll from a draw that did not leave the curio beside them, and
  // contradicts the verifier it tells the reader to run.
  const play = 1n;
  const bare = [];
  const rerolled = [];
  for (let index = 0; index < 20_000 && (bare.length < 2 || rerolled.length < 2); index++) {
    const nonce = index.toString(16).padStart(16, "0");
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      const room = enterRoom(nonce, play, depth, 0);
      if (room.drop && bare.length < 2) { bare.push({ nonce, depth, room, prefix: "" }); break; }
      if (room.natural !== "trap" || rerolled.length >= 2) continue;
      const after = rerollRoom(room, nonce, play, 0, ["lucky-charm"]);
      if (after.drop) { rerolled.push({ nonce, depth, room: after, prefix: "reroll-" }); break; }
    }
  }
  assert.equal(bare.length, 2, "found rooms that left a curio on their first draw");
  assert.equal(rerolled.length, 2, "found rooms that left a curio after a Lucky Charm reroll");

  for (const { nonce, depth, room, prefix } of [...bare, ...rerolled]) {
    const tags = dropTags(room);
    assert.deepEqual(tags, { gate: `${prefix}drop`, pick: `${prefix}drop-item` }, `depth ${depth} tags`);

    const gate = drawRoom(nonce, play, depth, tags.gate);
    const pick = drawRoom(nonce, play, depth, tags.pick);
    assert.ok(gate.roll < ITEM_RULES.dropChanceBps,
      `depth ${depth} prints a gate roll that actually opened the gate`);
    assert.equal(dropFor(pick), room.drop, `depth ${depth} prints the pick that named the curio it left`);

    // The verifier derives the same two draws from node:crypto, so agreeing with it is the check.
    const row = parse(await verify(["--nonce", nonce, "--play", String(play)])).find(one => one.depth === depth);
    const printed = prefix ? row.rerollDrop : row.drop;
    assert.equal(printed.roll, gate.roll, `depth ${depth} gate roll matches the verifier`);
    assert.equal(printed.hash, gate.hash.slice(0, printed.hash.length), `depth ${depth} gate digest matches the verifier`);
    assert.equal(printed.item, itemFor(room.drop).name, `depth ${depth} curio matches the verifier`);
  }
});

test("the verifier checks the commitment and refuses a nonce that does not match it", async () => {
  const nonce = "0123456789abcdef";
  const real = createHash("sha256").update(nonce).digest("hex");
  const good = await verify(["--nonce", nonce, "--play", "3", "--commitment", real]);
  assert.match(good, /MATCH — the nonce was fixed before the first room/);

  const wrong = createHash("sha256").update("someone else's run").digest("hex");
  await assert.rejects(
    () => verify(["--nonce", nonce, "--play", "3", "--commitment", wrong]),
    error => {
      assert.match(error.stdout, /MISMATCH/);
      assert.equal(error.code, 1, "a failed verification exits non-zero");
      return true;
    },
  );
});

test("the verifier refuses input it cannot verify rather than printing something plausible", async () => {
  // A verifier that prints a confident table for junk is worse than none: the reader concludes the
  // game cheated rather than that they mistyped the command they pasted.
  const refuses = async (args, pattern) => {
    await assert.rejects(() => verify(args), error => {
      assert.equal(error.code, 1, `${args.join(" ")} exits non-zero`);
      assert.match(error.stderr, pattern);
      assert.doesNotMatch(error.stdout ?? "", /sha256\(nonce\)/, "and prints no verification at all");
      return true;
    });
  };
  for (const args of [[], ["--nonce", "deadbeef"], ["--play", "1"]]) await refuses(args, /Usage: npm run verify/);

  // A value that looks like another flag is a missing value, not a nonce.
  await refuses(["--nonce", "--play", "7"], /--nonce needs a value/);
  await refuses(["--nonce", "deadbeef", "--commitment"], /--commitment needs a value/);

  await refuses(["--nonce", "nothex", "--play", "1"], /even number of hex digits/);
  await refuses(["--nonce", "abc", "--play", "1"], /even number of hex digits/);
  await refuses(["--nonce", "deadbeef", "--play", "not-a-number"], /whole number/);
  await refuses(["--nonce", "deadbeef", "--play", "1", "--commitment", "tooshort"], /64 hex digits/);
  await refuses(["--nonce", "deadbeef", "--play", "1", "--carried", "sword-of-truth"], /Unknown curio/);
});

test("a commitment mismatch prints no rooms at all", async () => {
  const wrong = createHash("sha256").update("someone else's run").digest("hex");
  await assert.rejects(
    () => verify(["--nonce", "deadbeef", "--play", "1", "--commitment", wrong]),
    error => {
      assert.match(error.stdout, /MISMATCH/);
      assert.equal(parse(error.stdout).length, 0,
        "rooms derived from a nonce that provably is not this run's are exactly the plausible-looking output to withhold");
      return true;
    });
});
