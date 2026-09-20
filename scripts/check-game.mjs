// Validates game/game.json against the SDK's parser and against this game's own economy
// simulation, so the published weights cannot drift from the numbers the README quotes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseChanceGame, expectedReward, maximumPrize, outcomeForRoll, RF } from "@rarefriends/friendsdk/game";
import { verify } from "./tuning.mjs";

const source = JSON.parse(await readFile(new URL("../game/game.json", import.meta.url), "utf8"));
const game = parseChanceGame(source);

assert.equal(game.consumable, "Torch");
assert.equal(game.price, RF, "a torch costs exactly 1 RF");
assert.equal(maximumPrize(game), 25n * RF, "the maximum prize a torch reserves is 25 RF");
assert.equal(game.outcomes.length, source.deeper.maxDepth + 1, "one bust outcome plus one cache per pot tier");
assert.equal(game.outcomes.reduce((sum, outcome) => sum + outcome.chanceBps, 0), 10_000);
assert.equal(game.outcomes[0].reward, 0n, "the first outcome is the busted run");

// Every tier must stay redeemable, so no weight may round away to zero.
for (const outcome of game.outcomes) assert.ok(outcome.chanceBps >= 1, `${outcome.name} keeps a non-zero weight`);

// Rewards are the pot ladder, in order, with the bust outcome at zero.
const ladder = ["0", ...source.deeper.potLadder].map(BigInt);
assert.deepEqual(game.outcomes.map(outcome => outcome.reward), ladder, "outcome rewards are the pot ladder");
for (let index = 1; index < ladder.length; index++) {
  assert.ok(ladder[index] > ladder[index - 1], "the pot ladder climbs at every tier");
}

// Roll boundaries land on the outcome the weights promise, including the first and last bucket.
let boundary = 0;
for (const [index, outcome] of game.outcomes.entries()) {
  assert.equal(outcomeForRoll(game, boundary), index + 1, `${outcome.name} owns roll ${boundary}`);
  boundary += outcome.chanceBps;
  assert.equal(outcomeForRoll(game, boundary - 1), index + 1, `${outcome.name} owns roll ${boundary - 1}`);
}
assert.equal(boundary, 10_000);

const reward = expectedReward(game);
assert.ok(reward > 850n * RF / 1000n && reward < 950n * RF / 1000n, `expected reward ${reward} sits in the 0.85-0.95 RF band`);

const economy = verify({ quiet: true });
assert.deepEqual(economy.problems, [], "the committed table matches the economy simulation");

console.log(`PASS Deeper definition: 1 RF torch, ${maximumPrize(game) / RF} RF maximum prize, ` +
  `${(Number(reward) / Number(RF)).toFixed(4)} RF expected per torch, ` +
  `${economy.ev.toFixed(4)} RF under optimal stopping (${((1 - economy.ev) * 100).toFixed(2)}% house edge).`);
