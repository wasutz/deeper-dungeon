// Browser check for Deeper: the real public runner with the SDK's mocked wallet, identity and
// canonical sprite fixture.
//
//   npm run check:browser
//
// It plays a full loop at desktop and phone widths: connect, select the owned Friend, walk with
// keyboard and touch, buy a torch, descend, bank or bust, run again, verify the commitment,
// sell a cache, and confirm nothing escapes the 960 x 640 container.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { FAMILIES_REGISTRY_ABI, GENERATION_SPRITE_MANIFEST } from "@rarefriends/friendsdk/sprites";
import { project } from "@rarefriends/friendsdk/world";
import { buildGame, createGameServer } from "../node_modules/@rarefriends/friendsdk/scripts/dev-game.mjs";
import { installFixture, assertBounds } from "./fixture.mjs";

const source = await readFile(new URL("../node_modules/@rarefriends/friendsdk/examples/fishing/sample-sprites.ts", import.meta.url), "utf8");
const section = source.split('"7730": decodeGenerationSprites')[1].split("]),")[0];
const frames = [...section.matchAll(/0x[0-9a-f]+n/g)].map(([word]) => BigInt(word.slice(0, -1)));
assert.equal(frames.length, 64, "The browser check uses all 64 canonical sample frames");

function artworkCall(call) {
  assert.equal(call.to.toLowerCase(), GENERATION_SPRITE_MANIFEST.registry.toLowerCase());
  const { functionName, args } = decodeFunctionData({ abi: FAMILIES_REGISTRY_ABI, data: call.data });
  let result;
  if (functionName === "familyOf") { assert.equal(args[0], 7730n); result = 5; }
  else if (functionName === "seedOf") { assert.equal(args[0], 7730n); result = 7730; }
  else if (functionName === "frames") { assert.deepEqual(args, [5, 7730]); result = frames; }
  else throw new Error(`Unexpected artwork read ${functionName}`);
  return encodeFunctionResult({ abi: FAMILIES_REGISTRY_ABI, functionName, result });
}

/** The pause flag crosses the frame bridge asynchronously, so poll rather than read once. */
async function settle(read, expected, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (value === expected) return;
  } while (Date.now() < deadline);
  assert.equal(value, expected, message);
}

async function gameBounds(child) {
  assert.deepEqual(await child.locator("body").evaluate(() => {
    const bounds = document.body.getBoundingClientRect(), problems = [];
    if (document.querySelector(".rf-game-frame,nav,header.site,footer")) problems.push("Game contains application scaffolding");
    for (const node of document.querySelectorAll(".rf-frame-menu,.rf-world-prompt,.deeper-hud,.deeper-descent,.deeper-choice")) {
      const box = node.getBoundingClientRect();
      if (box.left < -1 || box.right > bounds.right + 1 || box.top < -1 || box.bottom > bounds.bottom + 1) {
        problems.push(`Outside viewport: ${node.className}`);
      }
    }
    const canvas = document.querySelector(".rf-world-view canvas")?.getBoundingClientRect();
    if (canvas && Math.abs(canvas.width / canvas.height - 1.5) > 0.01) problems.push("World projection stretched");
    return problems;
  }), []);
}

const directory = await mkdtemp(join(tmpdir(), "friendsdk-deeper-browser-"));
let build, server, browser;
try {
  build = await buildGame(fileURLToPath(new URL("../game", import.meta.url)), { outdir: join(directory, "dist") });
  server = createGameServer(build.outdir);
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });

  for (const width of [1100, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500, reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await installFixture(page, origin, { artworkCall });
    // Pin the run nonce so the committed room sequence is identical on every run of this check.
    await page.addInitScript(() => {
      const random = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = array => array instanceof Uint8Array && array.length === 16
        ? (array.set(Uint8Array.from({ length: 16 }, (_, index) => index * 17 + 3)), array)
        : random(array);
    });

    const child = page.frameLocator("iframe");
    const button = name => child.getByRole("button", { name, exact: true });
    // A resolved room hands off to the SDK settlement before the run is called over, so wait for
    // the descent to come back to a choice or to show its outcome rather than for the verdict.
    const runSettled = () => child.locator(".deeper-descent[data-phase='choice'], .deeper-outcome").first().waitFor();
    const confirm = () => page.getByRole("button", { name: "Confirm preview", exact: true }).click();
    // Each SDK mutation is authorised separately, so a one-tap restart that also buys a torch
    // raises two in-frame confirmations.
    const confirmIfAsked = async () => {
      const prompt = page.getByRole("button", { name: "Confirm preview", exact: true });
      try { await prompt.waitFor({ timeout: 4000 }); } catch { return false; }
      await prompt.click();
      return true;
    };
    const worldReady = () => child.locator("canvas[data-x]").waitFor();
    const walk = async point => {
      const canvas = child.locator(".rf-world-view canvas"), box = await canvas.boundingBox(), [x, y] = project(...point);
      const position = { x: (x - 320) / 960 * box.width, y: (y - 330) / 640 * box.height };
      if (width < 500) await canvas.tap({ position }); else await canvas.click({ position });
    };

    await page.goto(origin);
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    await page.getByRole("button", { name: /^Friend #7730\b/ }).click();
    await worldReady();
    await assertBounds(page);
    await gameBounds(child);

    const canvas = child.locator(".rf-world-view canvas");
    const before = await canvas.getAttribute("data-x");
    await canvas.focus();
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(140);
    await page.keyboard.up("ArrowRight");
    assert.notEqual(await canvas.getAttribute("data-x"), before, "The canonical owned Friend walks with the keyboard");
    if (width < 500) {
      const beforeTouch = await canvas.getAttribute("data-x");
      await walk([220, 260]);
      await page.waitForTimeout(320);
      assert.notEqual(await canvas.getAttribute("data-x"), beforeTouch, "Tap movement works inside the scaled container");
    }

    // Torch vendor: walk to the stall, buy one simulated torch.
    await walk([196, 179]);
    await child.getByRole("button", { name: /^Torch Vendor/ }).click();
    await button("Buy a torch · 1 RF").click();
    await confirm();
    await child.getByText("One simulated torch added.", { exact: true }).waitFor();
    await gameBounds(child);
    await button("Close Torch Vendor").click();
    assert.match(await child.locator(".deeper-hud").textContent(), /19 RF/);

    // Staircase: light the torch and commit the run.
    await walk([452, 205]);
    await child.getByRole("button", { name: /^Dungeon Entrance/ }).click();
    await button("Light a torch and descend").click();
    await confirm();
    await child.locator(".deeper-descent").waitFor();
    await gameBounds(child);
    assert.equal(await child.locator(".deeper-sprite").count(), 1, "The selected Friend stands in the dungeon");

    // A runtime menu sets `paused`: descent choices must lock and held movement must stop.
    const descendIsDisabled = async () => child.getByRole("button", { name: /^Descend/ }).isDisabled();
    await page.getByRole("button", { name: "Open Friend wallet", exact: true }).click();
    await settle(descendIsDisabled, true, "Descending locks while the runtime menu holds the game paused");
    await page.getByRole("button", { name: "Close Friend wallet", exact: true }).click();
    await settle(descendIsDisabled, false, "Descending unlocks when the runtime menu closes");

    // Mid-run the Verify panel must prove the commitment without handing over the nonce: with it
    // a player could hash the rooms below and stop one room short of every trap.
    await child.getByRole("button", { name: /^Descend/ }).click();
    await runSettled();
    if (await child.locator(".deeper-outcome").count() === 0) {
      await child.getByRole("button", { name: "Verify", exact: true }).first().click();
      const held = await child.locator(".deeper-proof").textContent();
      assert.match(held, /sha256\(nonce\) = [0-9a-f]{64}/, "The commitment is shown while the run is live");
      assert.doesNotMatch(held, /03142536/, "The nonce stays held until the run ends");
      await button("Close Verify this run").click();
    }

    // Push until the run ends, banking once a pot exists and depth 4 is reached.
    let depth = 1;
    for (let step = 0; step < 12; step++) {
      if (await child.locator(".deeper-outcome").count()) break;
      const tier = Number(await child.locator(".deeper-ribbon li[data-kind='loot']").count());
      if (tier > 0 && depth >= 4) {
        await child.getByRole("button", { name: /^Bank / }).click();
        break;
      }
      await child.getByRole("button", { name: /^Descend/ }).click();
      await runSettled();
      depth = Number((await child.locator(".deeper-descent-bar").textContent()).match(/Depth(\d+)/)?.[1] ?? depth + 1);
      await gameBounds(child);
      if (depth === 2) await page.screenshot({ path: join(tmpdir(), `friendsdk-deeper-descent-${width}.png`) });
    }
    // Banking and busting both wait on the SDK settlement before the run is called over.
    await child.locator(".deeper-outcome").waitFor();
    const outcome = await child.locator(".deeper-outcome").textContent();
    assert.match(outcome, /Lost to the dark at depth \d+\.|Banked .* from depth \d+\./, "A run ends banked or busted");
    await child.locator(".deeper-ledger").waitFor();
    await page.screenshot({ path: join(tmpdir(), `friendsdk-deeper-over-${width}.png`) });
    assert.match(await child.locator(".deeper-ledger").textContent(), /Simulated payout\. The v0\.1 ledger settled the torch separately/);
    await child.getByRole("button", { name: "Why?", exact: true }).click();
    assert.match(await child.locator(".rf-frame-menu").textContent(), /bank\(playId, tier\)/);
    await gameBounds(child);
    await button("Close Pot and ledger").click();
    assert.equal(await child.locator(".deeper-ribbon li[data-kind='unknown']").count() < 10, true, "Rooms were recorded");

    // The committed nonce and every room draw are reproducible from the Verify panel.
    // A grid item that overflows its track paints over the rows below it; assert the
    // descent's controls stay hittable rather than trusting the layout to behave.
    assert.deepEqual(await child.locator(".deeper-descent").evaluate(node => {
      const problems = [], root = node.getBoundingClientRect();
      for (const control of node.querySelectorAll("button")) {
        const box = control.getBoundingClientRect();
        if (box.bottom > root.bottom + 1 || box.width === 0) { problems.push(`Clipped control: ${control.textContent}`); continue; }
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        if (!control.contains(top)) problems.push(`Covered control: ${control.textContent}`);
      }
      return problems;
    }), [], "Every descent control is hittable");
    await child.getByRole("button", { name: "Verify", exact: true }).first().click();
    const proof = await child.locator(".deeper-proof").textContent();
    assert.match(proof, /sha256\(nonce\) = [0-9a-f]{64}/);
    assert.match(proof, /Nonce03142536/, "The pinned fixture nonce is revealed");
    await gameBounds(child);
    await button("Close Verify this run").click();

    // One tap restarts the loop, buying a torch when none is left.
    await child.getByRole("button", { name: /^Run again/ }).click();
    assert.equal(await confirmIfAsked(), true, "Restarting buys a torch under its own confirmation");
    assert.equal(await confirmIfAsked(), true, "Burning that torch is confirmed separately");
    await child.locator(".deeper-descent[data-phase='choice']").waitFor();
    assert.equal(await child.locator(".deeper-outcome").count(), 0, "Run again starts a fresh descent");
    await child.getByRole("button", { name: "Back to the ledge", exact: true }).count();

    // Abandoning mid-run leaves a burning torch the entrance can close out.
    await child.getByRole("button", { name: /^Descend/ }).click();
    await runSettled();
    if (await child.locator(".deeper-outcome").count() === 0) {
      await child.getByRole("button", { name: /^Bank |^Descend/ }).first().click();
      await runSettled();
    }
    await child.getByRole("button", { name: "Back to the ledge", exact: true }).click().catch(() => undefined);

    await button("Close Dungeon Entrance").click().catch(() => undefined);
    await worldReady();

    // Satchel: caches are the ledger's settled rewards and redeem at a fixed price.
    await child.getByRole("button", { name: /^Satchel/ }).click();
    await gameBounds(child);
    const sellable = child.locator(".deeper-item").filter({ has: child.getByRole("button", { name: "Sell one", exact: true }) });
    assert.equal(await sellable.count(), 11, "Every cache tier is listed");
    await button("Close Satchel").click();

    // Session history and accessibility controls.
    await child.getByRole("button", { name: /^Best depth/ }).click();
    assert.match(await child.locator(".rf-frame-menu").textContent(), /Best depth/);
    await gameBounds(child);
    await button("Close This session").click();
    await child.getByRole("button", { name: /^Menu/ }).click();
    assert.equal(await child.getByLabel("Reduce motion").isChecked(), true, "Reduced motion is honoured from the OS preference");
    const sound = button("Sound");
    assert.equal(await sound.getAttribute("aria-pressed"), "false", "Sound starts muted");
    await sound.click();
    await child.locator("button[aria-pressed='true']", { hasText: "Sound" }).waitFor();
    await sound.click();
    assert.equal(await sound.getAttribute("aria-pressed"), "false", "The sound toggle reports its own state");
    await button("Room odds").click();
    assert.match(await child.locator(".rf-frame-menu").textContent(), /9\.4% edge/);
    await gameBounds(child);
    await button("Close Room odds").click();

    await assertBounds(page);
    await page.screenshot({ path: join(tmpdir(), `friendsdk-deeper-${width}.png`) });
    assert.deepEqual(errors, [], "No uncaught page errors");
    await context.close();
    console.log(`PASS Deeper ${width}px: canonical artwork, keyboard/touch, vendor purchase, committed descent, bank/bust, run again, verification, satchel, mute/reduced motion, container bounds.`);
  }
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await build?.close();
  await rm(directory, { recursive: true, force: true });
}
