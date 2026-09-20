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
import { buildGame, createGameServer } from "@rarefriends/friendsdk/build";
import { installFixture, assertBounds } from "./fixture.mjs";

const source = await readFile(new URL("../node_modules/@rarefriends/friendsdk/examples/fishing/sample-sprites.ts", import.meta.url), "utf8");
const section = source.split('"7730": decodeGenerationSprites')[1].split("]),")[0];
const frames = [...section.matchAll(/0x[0-9a-f]+n/g)].map(([word]) => BigInt(word.slice(0, -1)));
assert.equal(frames.length, 64, "The browser check uses all 64 canonical sample frames");

let artworkReads = 0;
function artworkCall(call) {
  artworkReads++;
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
    if (document.querySelector(".rf-game-frame,nav,header.site,footer.site")) problems.push("Game contains application scaffolding");
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
    const fixture = await installFixture(page, origin, { artworkCall });
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
    // A sign out of reach is `disabled` and taken out of the hit test so the tap can reach the
    // canvas, which is exactly what a real tap does -- so the click is forced, and lands on the
    // canvas at the sign's own coordinates where the game hit-tests it by rect.
    const walkOver = name => child.getByRole("button", { name }).click({ force: true });
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

    // The hit area is the sign itself and nothing wider: ground inside an interaction's reach is
    // still plain floor, so tapping it walks there and opens nothing.
    await walk([196, 179]);
    await page.waitForTimeout(900);
    assert.equal(await child.getByRole("button", { name: "Close Torch Vendor", exact: true }).count(), 0,
      "Ground beside the stall is walkable floor, not a hit target");
    assert.equal(await child.getByRole("button", { name: /^Torch Vendor/ }).isDisabled(), false,
      "though that walk did arrive in reach of it");

    // Hovering a sign has to be driven by the same hit test the tap uses: an out-of-reach sign is
    // taken out of pointer events, so `:hover` never fires on it.
    if (width > 500) {
      const far = child.getByRole("button", { name: /^Dungeon Entrance/ });
      const box = await far.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await far.getAttribute("data-hovered"), "", "A sign out of reach still lights up under the cursor");
      await page.mouse.move(box.x + box.width / 2, box.y - 80);
      assert.equal(await far.getAttribute("data-hovered"), null, "and goes out again when the cursor leaves it");
    }

    // Torch vendor: buy one simulated torch.
    await child.getByRole("button", { name: /^Torch Vendor/ }).click();
    await button("Buy a torch · 1 RF").click();
    await confirm();
    await child.getByText("One simulated torch added.", { exact: true }).waitFor();
    await gameBounds(child);
    await button("Close Torch Vendor").click();
    assert.match(await child.locator(".deeper-hud").textContent(), /19 RF/);

    // Taking the controls back abandons a queued walk: the menu must not open behind the player.
    // Aimed at the staircase from the vendor's stall, so the Friend is still crossing the ledge.
    assert.equal(await child.getByRole("button", { name: /^Dungeon Entrance/ }).isDisabled(), true,
      "The staircase is out of reach from the stall");
    await walkOver(/^Dungeon Entrance/);
    await child.locator(".deeper-world[data-approaching='staircase']").waitFor();
    await child.locator(".rf-world-view canvas").press("ArrowUp");
    assert.equal(await child.locator(".deeper-world[data-approaching]").count(), 0, "Steering by hand drops the approach");
    await page.waitForTimeout(1500);
    assert.equal(await child.getByRole("button", { name: "Close Dungeon Entrance", exact: true }).count(), 0,
      "An abandoned approach never opens its menu");

    // Staircase: tapping its sign from across the ledge walks the Friend over and opens it on
    // arrival, with no second tap once he gets there. Then light the torch and commit the run.
    await walkOver(/^Dungeon Entrance/);
    await child.getByRole("button", { name: "Close Dungeon Entrance", exact: true }).waitFor();
    // Arrival means standing at the stairs, not touching the edge of their 92-unit reach.
    const at = await child.locator(".rf-world-view canvas")
      .evaluate(node => [Number(node.dataset.x), Number(node.dataset.y)]);
    const short = Math.hypot(at[0] - 404, at[1] - 208);
    assert.ok(short < 45, `The menu waited for the Friend to arrive, not to enter reach (opened ${short.toFixed(1)} away)`);
    // The Friend's pixels are already in hand by the time the stairs are taken, so the dungeon
    // must not go back to the chain for them: a read here is a blank canvas for as long as the
    // round trip takes, on the one transition the player is watching.
    const readsBeforeDescent = artworkReads;
    await button("Light a torch and descend").click();
    await confirm();
    await child.locator(".deeper-descent").waitFor();
    await gameBounds(child);
    assert.equal(await child.locator(".deeper-sprite").count(), 1, "The selected Friend stands in the dungeon");
    assert.equal(artworkReads, readsBeforeDescent, "Entering the dungeon re-reads no artwork");
    assert.equal(await child.locator(".deeper-sprite").getAttribute("aria-label"), `Rare Friend #7730`,
      "and the Friend is drawn on the first frame of the dungeon, not after a fetch");

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

    // Curios: bought with banked pot, carried into a run, spent by it.
    const purse = async () => Number((await child.locator(".deeper-hud").textContent()).match(/Banked([\d.]+) RF/)?.[1] ?? 0);
    // Whether the Friend is on the rim already or across the ledge, the sign is the same target:
    // in reach it opens on its own click, out of reach it walks him over and opens on arrival.
    const enterDungeon = async () => {
      await walkOver(/^Dungeon Entrance/);
      await child.getByRole("button", { name: "Close Dungeon Entrance", exact: true }).waitFor();
      await gameBounds(child);
    };
    // Bank whatever a run offers as soon as it offers anything; the curio shelf needs a purse.
    for (let attempt = 0; attempt < 5 && await purse() < 0.54; attempt++) {
      await enterDungeon();
      await child.getByRole("button", { name: /and descend/ }).click();
      await confirmIfAsked();
      await confirmIfAsked();
      await child.locator(".deeper-descent").waitFor();
      for (let step = 0; step < 12; step++) {
        if (await child.locator(".deeper-outcome").count()) break;
        const bank = child.getByRole("button", { name: /^Bank / });
        if (await bank.isEnabled().catch(() => false)) { await bank.click(); break; }
        const sprung = child.getByRole("button", { name: "Take the dark", exact: true });
        if (await sprung.count()) { await sprung.click(); break; }
        await child.getByRole("button", { name: /^Descend/ }).click();
        await runSettled();
      }
      await child.locator(".deeper-outcome").waitFor();
      await child.getByRole("button", { name: "Back to the ledge", exact: true }).click();
      await worldReady();
    }
    assert.ok(await purse() >= 0.54, `Banking fills a purse to spend on curios (${await purse()} RF)`);

    await enterDungeon();
    await child.getByRole("button", { name: /^Curio shelf/ }).click();
    const shelf = child.locator(".deeper-item").filter({ has: child.getByRole("button", { name: "Buy", exact: true }) });
    assert.equal(await shelf.count(), 7, "Every curio is listed with a derived price");
    assert.match(await child.locator(".rf-frame-menu").textContent(), /expected pot it adds to a run/);
    await gameBounds(child);
    await shelf.filter({ hasText: "Divining Rod" }).getByRole("button", { name: "Buy", exact: true }).click();
    await child.getByText("Divining Rod added to the satchel.", { exact: true }).waitFor();
    await button("Close Curio shelf").click();
    await worldReady();

    // The loadout picker is the carry cap made visible: the Idol alone fills both slots.
    await enterDungeon();
    const pick = name => child.locator("label.deeper-item").filter({ hasText: name });
    await pick("Divining Rod").locator("input").check();
    const slotLine = await child.locator(".deeper-loadout-head").textContent();
    assert.match(slotLine, /Carry\s*1 of 2 slots/);
    // The cap is what every published price rests on, so assert the header can never claim more.
    const filled = Number(slotLine.match(/(\d+) of (\d+) slots/)[1]);
    assert.ok(filled <= 2, `the picker offered ${filled} of 2 slots`);
    assert.equal(await child.locator(".deeper-slots i[data-filled]").count(), filled, "the pips match the count");
    await child.getByRole("button", { name: /and descend/ }).click();
    await confirmIfAsked();
    await confirmIfAsked();
    await child.locator(".deeper-descent").waitFor();
    assert.match(await child.locator(".deeper-carried").textContent(), /Divining Rod/, "The kit rides along into the run");

    // Forcing loot overrides the result, never the draw: both are on the record.
    await child.getByRole("button", { name: "Divining Rod — force loot", exact: true }).click();
    await runSettled();
    await gameBounds(child);
    assert.equal(await child.locator(".deeper-carried").count(), 0, "A spent charge leaves the satchel bar");
    assert.match(await child.locator(".deeper-ribbon li[data-kind='loot']").first().getAttribute("data-kind"), /loot/);
    await child.getByRole("button", { name: "Verify", exact: true }).first().click();
    const bent = await child.locator(".rf-frame-menu").textContent();
    assert.match(bent, /Drew/, "The Verify panel prints what the roll drew and what resolved");
    assert.match(bent, /Divining Rod/, "and which curio overrode it");
    await gameBounds(child);
    await button("Close Verify this run").click();
    await child.getByRole("button", { name: /^Bank |^Descend/ }).first().click();
    await runSettled();
    await child.getByRole("button", { name: "Back to the ledge", exact: true }).click().catch(() => undefined);
    await worldReady();

    // Fair play: the statistical half over the session, and the per-run proof it drills into.
    await child.getByRole("button", { name: /^Best depth/ }).click();
    const fair = await child.locator(".rf-frame-menu").textContent();
    assert.match(fair, /Best depth/);
    assert.match(fair, /chi-square is \d+\.\d+ on two degrees of freedom/, "The session calibration is reported");
    assert.match(fair, /trap/, "Draws are tallied against what the weights expected");
    await gameBounds(child);

    // Drilling into one run offers the command that rechecks it without the game's own digest.
    await child.getByRole("button", { name: "Verify", exact: true }).first().click();
    const command = await child.locator(".rf-frame-menu").textContent();
    assert.match(command, /npm run verify -- --nonce [0-9a-f]+ --play \d+ --commitment [0-9a-f]{64}/,
      "The panel prints a runnable independent verification command");
    await gameBounds(child);
    await button("Back to fair play").click();
    assert.match(await child.locator(".rf-frame-menu").textContent(), /Best depth/, "and returns to the session view");
    await button("Close Fair play").click();
    await child.getByRole("button", { name: /^Menu/ }).click();
    const motion = child.getByLabel("Reduce motion");
    assert.equal(await motion.isChecked(), true, "Reduced motion is honoured from the OS preference");
    // Turning motion back on has to reach the stylesheet and not only the timings. The reveal
    // below runs with the OS preference still set to reduce, so it moves at all only if this
    // toggle -- not the media query -- is what the animations are keyed off.
    await motion.uncheck();
    assert.equal(await child.locator(".deeper-game[data-motion='full']").count(), 1,
      "The motion toggle drives the stylesheet over the OS preference");
    const sound = child.getByLabel("Sound");
    assert.equal(await sound.isChecked(), true, "Sound is on by default");
    await sound.uncheck();
    assert.equal(await sound.isChecked(), false, "The sound toggle reports its own state");
    await sound.check();
    assert.equal(await sound.isChecked(), true);
    await button("Room odds").click();
    const odds = await child.locator(".rf-frame-menu").textContent();
    assert.match(odds, /9\.4% edge/, "The stopping problem is priced");
    assert.match(odds, /5\.65% edge/, "and so is the game as played, curio drops included");
    await gameBounds(child);
    await button("Close Room odds").click();

    // Everything above ran with motion reduced; the reveal itself only exists once it is turned
    // back on, which the settings toggle did above with the OS preference left as it was. The
    // sweep is handed the roll the room is about to be read at, so the mark it leaves behind has
    // nowhere to jump to -- a rest position that disagrees with the roll warps across the bar the
    // moment the room opens.
    await enterDungeon();
    await child.getByRole("button", { name: /and descend/ }).click();
    await confirmIfAsked();
    await confirmIfAsked();
    await child.locator(".deeper-descent").waitFor();
    await child.getByRole("button", { name: /^Descend/ }).click();
    const sweptTo = await child.locator(".deeper-range-rail[data-rolling]")
      .evaluate(rail => rail.style.getPropertyValue("--at"));
    assert.match(sweptTo, /^\d+(\.\d+)?%$/, "The sweep is given a place on the bar to settle onto");
    // A keyframe the browser cannot resolve is dropped in silence, leaving a mark that is already
    // sitting on the answer. Sample the travel rather than trust the rule.
    const travel = await child.locator(".deeper-range-rail[data-rolling]").evaluate(async rail => {
      const samples = [];
      for (let tick = 0; tick < 20; tick++) {
        samples.push(new DOMMatrixReadOnly(getComputedStyle(rail).transform).m41);
        await new Promise(next => setTimeout(next, 50));
      }
      return samples;
    });
    assert.ok(Math.max(...travel) - Math.min(...travel) > 40, "The mark sweeps the bar before it settles");
    await runSettled();
    assert.equal(
      await child.locator(".deeper-range-rail").first().evaluate(rail => rail.style.getPropertyValue("--at")),
      sweptTo, "The revealed mark stands where the sweep came to rest");
    await gameBounds(child);

    await assertBounds(page);
    await page.screenshot({ path: join(tmpdir(), `friendsdk-deeper-${width}.png`) });
    assert.deepEqual([...errors, ...fixture.errors], [], "No uncaught page errors or blocked fixture requests");
    await context.close();
    console.log(`PASS Deeper ${width}px: canonical artwork, keyboard/touch, walk-over interaction, vendor purchase, committed descent, bank/bust, run again, verification, satchel, curio shelf and loadout, an overridden room, session calibration and the independent verify command, mute/reduced motion, container bounds.`);
  }
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await build?.close();
  await rm(directory, { recursive: true, force: true });
}
