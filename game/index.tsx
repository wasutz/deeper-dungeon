"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameWorld, type GameWorldInteraction } from "@rarefriends/friendsdk/world-view";
import { isWorldWalkable, project, type WorldPoint } from "@rarefriends/friendsdk/world";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount, ItemArt, Keycap } from "@rarefriends/friendsdk/ui";
import { maximumPrize, type GameSnapshot } from "@rarefriends/friendsdk/game";
import { createFriendSoundKit, type FriendSoundCue, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import { createRunNonce, drawRoom, sha256Hex } from "./fairness.js";
import {
  dropTags, enterRoom, FAIRNESS, LEDGER_NOTE, MAX_DEPTH, oddsFor, peekRoom, potFor, rerollRoom, ropeShare,
  ROOMS, tierStep, type Intent, type Room, type RoomKind,
} from "./rules.js";
import {
  canCarry, CARRY_CAP, holds, ITEM_RULES, ITEMS, itemFor, kitFor, slotsUsed, spend,
  type Carried, type ItemId,
} from "./items.js";
import { INTERACTIONS, SPAWN, SURFACE } from "./world.js";
import { Descent, ROOM_REVEAL_MS, type DescentPhase } from "./descent.js";
import { prefetchFriendSprites } from "./sprite.js";
// No SDK stylesheet imports. The runner already supplies frame.css and runtime.css to this
// document, and the cavern palette replaces world-view.css and ui.css wholesale rather than
// loading them to override nearly every rule -- see the world-view block in style.css.
import "./style.css";

const rf = (value: bigint) => `${formatGameAmount(value, 18)} RF`;

type Menu = "vendor" | "entrance" | "satchel" | "settings" | "odds" | "proof" | "ledger" | "items" | null;

/** Which menu an interaction opens, whether it was reached on foot or walked to from across the ledge. */
const MENU_FOR: Readonly<Record<string, Menu>> = { vendor: "vendor", staircase: "entrance" };

/**
 * GameWorld draws its 960 x 640 canvas translated by a view origin of its own, and walks the Friend
 * to wherever a pointer lands on it. Both are private to the SDK, so they are restated here: the
 * world-to-screen conversion below has to invert the SDK's own exactly, or a prompt would send the
 * Friend somewhere other than the thing it names. `WALK_RADIUS` is the movement navigator's default
 * clearance -- a destination it cannot route to moves nobody.
 */
const VIEW = { x: 320, y: 330, width: 960, height: 640 };
const WALK_RADIUS = 7;
const DEFAULT_REACH = 72;
/** Close enough to count as standing there, against a position the canvas rounds to 0.01. */
const ARRIVED = 2;
/** No movement for this long after a sign was tapped means the walk never started at all. */
const STALLED_MS = 700;
/** The SDK's own movement keys, lowercased the way a `keydown` handler compares them. */
const WALK_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

const reachOf = (item: GameWorldInteraction) => item.reach ?? DEFAULT_REACH;
const apart = (from: WorldPoint, to: WorldPoint) => Math.hypot(from[0] - to[0], from[1] - to[1]);

/**
 * Where walking over to something actually puts the Friend. Neither interaction stands on open
 * ground -- the vendor's stall is a solid crate and the staircase is a hole -- so the destination
 * is the nearest spot the navigator will accept that still counts as being there. Searched once,
 * off a fixed world, rather than per click.
 */
const standFor = (item: GameWorldInteraction): WorldPoint => {
  if (isWorldWalkable(SURFACE, item.position, WALK_RADIUS)) return item.position;
  for (let radius = 8; radius <= reachOf(item); radius += 8) {
    for (let step = 0; step < 24; step++) {
      const angle = step / 24 * 2 * Math.PI;
      const stand: WorldPoint = [
        item.position[0] + radius * Math.cos(angle), item.position[1] + radius * Math.sin(angle),
      ];
      if (isWorldWalkable(SURFACE, stand, WALK_RADIUS)) return stand;
    }
  }
  return item.position;
};
const STANDS: ReadonlyMap<string, WorldPoint> = new Map(INTERACTIONS.map(item => [item.id, standFor(item)]));

/**
 * Which interaction's prompt a tap landed on, by its box rather than by being the tap's target: a
 * prompt out of reach is `disabled`, and the cavern stylesheet takes it out of the hit test so the
 * tap can reach the canvas underneath. The SDK renders one prompt per interaction, in order.
 */
const promptsIn = (root: HTMLElement) => {
  const prompts = [...root.querySelectorAll<HTMLElement>(".rf-world-prompt")];
  return prompts.length === INTERACTIONS.length ? prompts : [];
};

const promptAt = (root: HTMLElement, x: number, y: number) => {
  const index = promptsIn(root).findIndex(node => {
    const box = node.getBoundingClientRect();
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  });
  return index < 0 ? null : INTERACTIONS[index];
};

/**
 * Light up the sign under the cursor. `:hover` cannot do this: the same `pointer-events: none` that
 * lets a tap through to the canvas also keeps an out-of-reach sign from ever matching it. The
 * attribute is set on the SDK's own element rather than passed to it, since GameWorld renders the
 * prompts itself -- it owns `disabled` and the label, and leaves a foreign `data-` attribute alone.
 * Marked straight onto the DOM rather than held in state so that moving the mouse across the ledge
 * does not re-render the game on every frame of it.
 */
const markHover = (root: HTMLElement, target: GameWorldInteraction | null) => {
  for (const [index, node] of promptsIn(root).entries()) {
    node.toggleAttribute("data-hovered", INTERACTIONS[index] === target);
  }
};

/**
 * Send the Friend to a point. GameWorld keeps its mover private and offers no handle for it, so the
 * way in is the pointer surface it already listens on: this replays, at the exact client
 * coordinates the destination projects to, the tap the player would have had to make by hand. The
 * arithmetic is the inverse of the SDK's own screen-to-world step, so the Friend lands where the
 * prompt promised rather than near it.
 */
const walkTo = (canvas: HTMLCanvasElement, box: DOMRect, point: WorldPoint) => {
  const [x, y] = project(point[0], point[1]);
  canvas.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    clientX: box.left + (x - VIEW.x) * box.width / VIEW.width,
    clientY: box.top + (y - VIEW.y) * box.height / VIEW.height,
  }));
};

type Run = Readonly<{
  playId: bigint; nonce: string; commitment: string; rooms: readonly Room[];
  depth: number; tier: number; carried: Carried;
}>;
type Stock = Readonly<Partial<Record<ItemId, number>>>;
type Settlement = Readonly<{ name: string; reward: bigint }>;
type RunRecord = Readonly<{
  number: number; depth: number; tier: number; pot: bigint; banked: boolean; settlement: Settlement | null;
  playId: bigint; nonce: string; commitment: string; rooms: readonly Room[]; carried: Carried;
}>;
/**
 * What the Verify panel is allowed to show. A run in progress has no `nonce`: publishing it
 * before the last room would let the player hash the rooms ahead and stop one room short of
 * every trap, which is the whole game.
 */
type Proof = Readonly<{
  commitment: string; nonce: string | null; playId: bigint; rooms: readonly Room[]; carried: Carried;
}>;
/**
 * A proof whose run is over. Nothing that needs the nonce may take a plain `Proof`: publishing one
 * mid-run would let the player hash the rooms below and stop one short of every trap, which is the
 * whole game. Narrowing the field is not enough -- the object has to carry the guarantee.
 */
type Revealed = Proof & Readonly<{ nonce: string }>;
const revealed = (proof: Proof | null): Revealed | null =>
  proof && proof.nonce !== null ? { ...proof, nonce: proof.nonce } : null;
type Totals = Readonly<{ runs: number; banked: bigint; bestDepth: number; bestPot: bigint }>;
const NO_TOTALS: Totals = { runs: 0, banked: 0n, bestDepth: 0, bestPot: 0n };

/**
 * Every room draw this session, against what the published weights expected of it. The commitment
 * proves one run was dealt before it was played; this is the other half of the same question,
 * answered over a whole session -- a table that lied would drift away from its own numbers here.
 */
type Tally = Readonly<{ seen: Record<RoomKind, number>; expected: Record<RoomKind, number> }>;
const NO_TALLY: Tally = { seen: { trap: 0, loot: 0, empty: 0 }, expected: { trap: 0, loot: 0, empty: 0 } };

const observed = (tally: Tally, depth: number, carried: Carried, kind: RoomKind): Tally => {
  const odds = oddsFor(depth, carried);
  return {
    seen: { ...tally.seen, [kind]: tally.seen[kind] + 1 },
    expected: {
      trap: tally.expected.trap + odds.trapBps / 10_000,
      loot: tally.expected.loot + odds.lootBps / 10_000,
      empty: tally.expected.empty + odds.emptyBps / 10_000,
    },
  };
};

/** Pearson's chi-square over the three room kinds. Two degrees of freedom. */
const chiSquare = (tally: Tally) => (["trap", "loot", "empty"] as const)
  .reduce((total, kind) => total + (tally.expected[kind] === 0 ? 0
    : (tally.seen[kind] - tally.expected[kind]) ** 2 / tally.expected[kind]), 0);

const held = (stock: Stock, id: ItemId) => stock[id] ?? 0;
const restock = (stock: Stock, id: ItemId, by: number): Stock => ({ ...stock, [id]: held(stock, id) + by });

export default function Deeper({ friendId, client, paused }: GameComponentProps) {
  const definition = client.definition;
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [backed, setBacked] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [phase, setPhase] = useState<DescentPhase>("choice");
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [history, setHistory] = useState<readonly RunRecord[]>([]);
  const [totals, setTotals] = useState<Totals>(NO_TOTALS);
  const [unsettled, setUnsettled] = useState<Readonly<{ run: Run; banked: boolean; pot: bigint }> | null>(null);
  const [verifying, setVerifying] = useState<Proof | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [muted, setMuted] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [stock, setStock] = useState<Stock>({});
  const [loadout, setLoadout] = useState<Carried>([]);
  const [purse, setPurse] = useState(0n);
  const [peeked, setPeeked] = useState<Readonly<{ depth: number; kind: RoomKind }> | null>(null);
  /** The roll of the room being entered, so its reveal can sweep onto the answer it is holding. */
  const [sealedRoll, setSealedRoll] = useState<number | null>(null);
  const [tally, setTally] = useState<Tally>(NO_TALLY);
  /** The interaction the Friend is currently walking over to, and will open on arrival. */
  const [approaching, setApproaching] = useState<string | null>(null);

  const world = useRef<HTMLDivElement>(null);
  const replaying = useRef(false);
  const motionChosen = useRef(false);
  const sound = useRef<FriendSoundKit | null>(null);
  /** Survives a Friend switch, which builds a new kit: a player who muted stays muted. */
  const mutePreference = useRef(false);
  const locked = useRef(false);
  const epoch = useRef(0);
  const runCount = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const version = ++epoch.current;
    sound.current = createFriendSoundKit({ muted: mutePreference.current });
    // Read the artwork now, while the Friend is still on the surface, so the dungeon has it.
    prefetchFriendSprites(friendId);
    setSnapshot(null); setBacked(false); setMenu(null); setRun(null); setPhase("choice"); setSettlement(null); setUnsettled(null);
    setHistory([]); setTotals(NO_TOTALS); setVerifying(null); setError(""); setMessage(""); setBusy(false);
    setStock({}); setLoadout([]); setPurse(0n); setPeeked(null); setSealedRoll(null); setTally(NO_TALLY);
    locked.current = false;
    runCount.current = 0;
    motionChosen.current = false;
    void client.read().then(value => { if (version === epoch.current) setSnapshot(value); }).catch(cause => {
      if (version === epoch.current) setError(cause instanceof Error ? cause.message : "Could not load the dungeon ledger.");
    });
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { if (!motionChosen.current) setReducedMotion(preference.matches); };
    update();
    preference.addEventListener("change", update);
    return () => {
      epoch.current++;
      if (timer.current) clearTimeout(timer.current);
      sound.current?.dispose();
      sound.current = null;
      preference.removeEventListener("change", update);
    };
  }, [client, friendId]);

  // Backing is the SDK's own rule about free stake and reserves; ask it rather than restating it.
  useEffect(() => {
    if (!snapshot) return;
    const version = epoch.current;
    void client.canBuy(1n)
      .then(value => { if (version === epoch.current) setBacked(value); })
      .catch(() => { if (version === epoch.current) setBacked(false); });
  }, [client, snapshot]);

  // A held descent must not resolve while the runtime has the game paused behind a menu.
  useEffect(() => {
    if (!paused || !timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setSealedRoll(null);
    setPhase(current => current === "entering" ? "choice" : current);
  }, [paused]);

  /**
   * `unlock()` is asynchronous and `play()` is silent until it resolves, so a cue fired in the
   * same tick as the gesture that first unlocks audio would be lost. Every cue goes through here.
   */
  const playCue = useCallback((name: FriendSoundCue) => {
    const kit = sound.current;
    if (!kit) return;
    void kit.unlock().then(ready => { if (ready && sound.current === kit) kit.play(name); });
  }, []);

  /**
   * One simulated action at a time. `work` receives `isCurrent` because a Friend switch can land
   * mid-await: any state it writes after that belongs to a session that no longer exists.
   */
  const act = useCallback(async (work: (isCurrent: () => boolean) => Promise<void>, cue?: FriendSoundCue) => {
    if (locked.current || paused) return false;
    const version = epoch.current;
    locked.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      await work(() => version === epoch.current);
      const value = await client.read();
      if (version === epoch.current) { setSnapshot(value); if (cue) playCue(cue); }
      return true;
    } catch (cause) {
      if (version === epoch.current) setError(cause instanceof Error ? cause.message : "The simulated action failed.");
      return false;
    } finally {
      if (version === epoch.current) { locked.current = false; setBusy(false); }
    }
  }, [client, paused, playCue]);

  const openMenu = useCallback((next: Menu) => {
    if (!busy && !paused) { setMenu(next); setError(""); setMessage(""); }
  }, [busy, paused]);

  /**
   * Walking over to something is a standing intention, so it only holds while the ledge is the
   * thing the player is looking at. A runtime pause, an open menu or a descent all drop it rather
   * than opening, minutes later, a menu the player has long since moved on from.
   */
  const approachHeld = !paused && run === null && menu === null;
  useEffect(() => { if (!approachHeld) setApproaching(null); }, [approachHeld]);

  /**
   * A tap on a prompt that is still out of reach walks the Friend over to it and remembers what he
   * was sent to, so the arrival can open it. The target is the prompt's own box and nothing wider:
   * the ground around an interaction stays plain walkable floor.
   */
  const onWorldPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // The walk below is itself a pointerdown on the canvas, and it bubbles straight back through here.
    if (replaying.current) return;
    // A prompt within reach is a live button and opens on its own click.
    if ((event.target as Element | null)?.closest?.("button")) return;
    const canvas = event.currentTarget.querySelector<HTMLCanvasElement>(".rf-world-view canvas");
    const box = canvas?.getBoundingClientRect();
    if (!canvas || !box?.width || !box.height) return;
    const target = promptAt(event.currentTarget, event.clientX, event.clientY);
    // Anywhere else is the player walking somewhere of their own choosing, which is them changing
    // their mind about the approach as much as reaching for the keys would be.
    if (!target) { setApproaching(null); return; }
    replaying.current = true;
    try { walkTo(canvas, box, STANDS.get(target.id)!); } finally { replaying.current = false; }
    setApproaching(target.id);
  }, []);

  /** Hovering is a mouse idea; a finger is already on the thing it means to press. */
  const trackHover = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    markHover(event.currentTarget, promptAt(event.currentTarget, event.clientX, event.clientY));
  }, []);

  // A menu opening takes the world inert from under the cursor, which leaves no pointer event
  // behind to clear the sign the player was hovering when they clicked it.
  useEffect(() => {
    if (!approachHeld && world.current) markHover(world.current, null);
  }, [approachHeld]);

  /**
   * Watch for the arrival, reading the position the canvas publishes every frame.
   *
   * Arriving means standing at the destination, not merely being close enough for the prompt to
   * light up: reach is a generous radius, and opening on the edge of it pops the menu while the
   * Friend is still visibly out on the ledge walking. The navigator ends a route exactly on the
   * point it was given, so this is a tight test against that point rather than a loose one against
   * the interaction.
   */
  useEffect(() => {
    const item = INTERACTIONS.find(entry => entry.id === approaching);
    const canvas = world.current?.querySelector<HTMLCanvasElement>(".rf-world-view canvas");
    const target = item && MENU_FOR[item.id];
    if (!item || !canvas || !target) return;
    const stand = STANDS.get(item.id)!;
    let frame = 0, moving = performance.now(), previous: WorldPoint | null = null;
    const check = (now: number) => {
      const position: WorldPoint = [Number(canvas.dataset.x), Number(canvas.dataset.y)];
      if (position.every(Number.isFinite)) {
        if (apart(position, stand) <= ARRIVED) { setApproaching(null); openMenu(target); return; }
        if (previous && apart(position, previous) > 0.01) moving = now;
        previous = position;
        // Nothing is coming: the route was refused, so there is no arrival to wait for.
        if (now - moving > STALLED_MS) { setApproaching(null); return; }
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [approaching, openMenu]);

  /**
   * A loadout is spent by the run it is carried into, used or not. That is what the solver prices:
   * an item is worth the expected pot it adds to *one* descent, so letting an unused Ward come
   * back would make it worth more than it cost.
   */
  const beginRun = useCallback((playId: bigint, carried: Carried) => {
    const nonce = createRunNonce();
    setStock(current => carried.reduce((rest, id) => restock(rest, id, -1), current));
    setRun({ playId, nonce, commitment: sha256Hex(nonce), rooms: [], depth: 0, tier: 0, carried });
    setPhase("choice");
    setSettlement(null);
    setPeeked(null);
    setMenu(null);
  }, []);

  /**
   * Close the SDK play for a finished run and record what the ledger paid for the torch. The
   * outcome screen waits for the settlement: a run announced as banked while its play is still
   * pending would leave the maximum prize reserved with nothing to release it.
   */
  const finishRun = useCallback(async (finished: Run, banked: boolean, pot: bigint) => {
    const version = epoch.current;
    // What went in, not what is left: the record should show the kit, and charges have been spent.
    const carriedInto = [...finished.carried, ...finished.rooms.flatMap(room => room.used)];
    setPhase("settling");
    const settledOk = await act(async isCurrent => {
      const settled = await client.settle(finished.playId);
      if (!isCurrent()) return;
      const outcome = settled.outcomeId === null ? null : definition.outcomes[settled.outcomeId - 1];
      const result: Settlement | null = outcome ? { name: outcome.name, reward: outcome.reward } : null;
      setSettlement(result);
      // Numbered here rather than inside the updater: React may call an updater more than once,
      // and a run number that counts re-renders is a run number that skips.
      const number = ++runCount.current;
      setHistory(previous => [{
        number, depth: finished.depth, tier: finished.tier, pot, banked,
        settlement: result, playId: finished.playId, nonce: finished.nonce, commitment: finished.commitment,
        rooms: finished.rooms, carried: carriedInto,
      }, ...previous].slice(0, 20));
      setPurse(previous => previous + pot);
      setTotals(previous => ({
        runs: previous.runs + 1, banked: previous.banked + pot,
        bestDepth: Math.max(previous.bestDepth, finished.depth),
        bestPot: pot > previous.bestPot ? pot : previous.bestPot,
      }));
    }, banked ? "reward" : "impact");
    if (version !== epoch.current) return;
    if (settledOk) { setUnsettled(null); setPhase(banked ? "banked" : "busted"); }
    else { setUnsettled({ run: finished, banked, pot }); setPhase("unsettled"); }
  }, [act, client, definition]);

  const retrySettle = useCallback(() => {
    if (unsettled) void finishRun(unsettled.run, unsettled.banked, unsettled.pot);
  }, [unsettled, finishRun]);

  /** A room the player is still holding an answer to is a decision, not an ending. */
  const canAnswerTrap = (carried: Carried) => holds(carried, "escape-rope") || holds(carried, "lucky-charm");

  const settleRoom = useCallback((next: Run, room: Room) => {
    if (room.drop) setStock(current => restock(current, room.drop!, 1));
    if (room.kind === "trap") {
      if (canAnswerTrap(next.carried)) { playCue("impact"); setPhase("sprung"); return; }
      void finishRun(next, false, 0n);
      return;
    }
    playCue(room.kind === "loot" ? (room.depth >= 6 ? "reveal-rare" : "reveal-common") : "action-ready");
    setPhase("choice");
  }, [finishRun, playCue]);

  const descend = useCallback((intent: Intent = {}) => {
    if (!run || phase !== "choice" || busy || paused || run.depth >= MAX_DEPTH) return;
    setPhase("entering");
    playCue("anticipation");
    // Drawn here rather than when the reveal is over. The room is a pure function of a nonce that
    // was committed before the run began, so reading it early cannot change it -- and the reveal
    // needs the answer in hand to come to rest on it instead of jumping there afterwards.
    const drawn = enterRoom(run.nonce, run.playId, run.depth + 1, run.tier, run.carried, intent);
    // A Lantern changes no result, but it was spent on this room and the record should say so.
    const room = peeked?.depth === drawn.depth
      ? { ...drawn, used: ["lantern" as ItemId, ...drawn.used] } : drawn;
    // The peek is cleared by the room that consumes it, not by the attempt to enter one. A pause
    // rewinds a held descent to the choice, and a read the player already paid a Lantern for has
    // to survive that -- otherwise the charge is gone, the room is unentered, and its committed
    // draw gets counted a second time when the descent is made again.
    const resolve = () => {
      timer.current = null;
      const carried = room.used.reduce<Carried>((rest, id) => spend(rest, id), run.carried);
      if (!peeked || peeked.depth !== room.depth) {
        setTally(current => observed(current, room.depth, run.carried, room.natural));
      }
      const next: Run = { ...run, rooms: [...run.rooms, room], depth: room.depth, tier: room.tier, carried };
      setPeeked(null);
      setSealedRoll(null);
      setRun(next);
      settleRoom(next, room);
    };
    if (reducedMotion) resolve();
    else {
      setSealedRoll(room.draw.roll);
      timer.current = setTimeout(resolve, ROOM_REVEAL_MS);
    }
  }, [run, phase, busy, paused, reducedMotion, peeked, settleRoom, playCue]);

  const peek = useCallback(() => {
    // The floor guard is the same one `descend` keeps: clamping instead would re-read the room
    // already entered, spending the Lantern on it and counting its draw twice.
    if (!run || phase !== "choice" || busy || paused || run.depth >= MAX_DEPTH || !holds(run.carried, "lantern")) return;
    const depth = run.depth + 1;
    const kind = peekRoom(run.nonce, run.playId, depth, run.carried);
    // Counted here rather than on entry. A peek that talks you out of descending would otherwise
    // drop its own draw from the tally, and a draw included only when the player liked the look of
    // it is exactly the bias a goodness-of-fit test cannot survive.
    setTally(current => observed(current, depth, run.carried, kind));
    setPeeked({ depth, kind });
    setRun({ ...run, carried: spend(run.carried, "lantern") });
    playCue("action-ready");
  }, [run, phase, busy, paused, playCue]);

  const bank = useCallback(() => {
    if (!run || phase !== "choice" || busy || paused || run.tier === 0) return;
    void finishRun(run, true, potFor(run.tier, run.carried));
  }, [run, phase, busy, paused, finishRun]);

  // The three answers to a sprung trap. Only the reroll can leave the run still going.
  const useRope = useCallback(() => {
    if (!run || phase !== "sprung" || busy || paused || !holds(run.carried, "escape-rope")) return;
    const rescued = ropeShare(potFor(run.tier, run.carried));
    const sprung = run.rooms[run.rooms.length - 1];
    const next: Run = {
      ...run,
      rooms: [...run.rooms.slice(0, -1), { ...sprung, used: [...sprung.used, "escape-rope"] }],
      carried: spend(run.carried, "escape-rope"),
    };
    setRun(next);
    void finishRun(next, true, rescued);
  }, [run, phase, busy, paused, finishRun]);

  const useCharm = useCallback(() => {
    if (!run || phase !== "sprung" || busy || paused || !holds(run.carried, "lucky-charm")) return;
    const sprung = run.rooms[run.rooms.length - 1];
    const carried = spend(run.carried, "lucky-charm");
    // A sprung trap left the tier untouched, so the reroll resolves against the tier still standing.
    const room = rerollRoom(sprung, run.nonce, run.playId, run.tier, run.carried);
    // `kind` is the reroll's own natural result: nothing overrides a reroll. Give one an override
    // and this needs its own `natural` alongside, or the tally starts counting bent results.
    setTally(current => observed(current, room.depth, run.carried, room.kind));
    const next: Run = { ...run, rooms: [...run.rooms.slice(0, -1), room], tier: room.tier, carried };
    setRun(next);
    settleRoom(next, room);
  }, [run, phase, busy, paused, settleRoom]);

  const acceptTrap = useCallback(() => {
    if (!run || phase !== "sprung" || busy || paused) return;
    void finishRun(run, false, 0n);
  }, [run, phase, busy, paused, finishRun]);

  const startRun = useCallback((carried: Carried) => void act(async isCurrent => {
    const current = await client.read();
    if (current.consumables === 0n) await client.buy(1n);
    const [play] = await client.play(1n);
    if (isCurrent()) beginRun(play.id, carried);
  }, "action-start"), [act, client, beginRun]);

  /** Items are bought with banked pot, the currency the game already simulates. */
  const buyItem = useCallback((id: ItemId) => {
    const item = itemFor(id);
    if (busy || paused || purse < item.price) return;
    setPurse(previous => previous - item.price);
    setStock(current => restock(current, id, 1));
    playCue("purchase");
    setMessage(`${item.name} added to the satchel.`);
  }, [busy, paused, purse, playCue]);

  const setSoundOn = useCallback((on: boolean) => {
    mutePreference.current = !on;
    setMuted(!on);
    sound.current?.setMuted(!on);
    if (on) void sound.current?.unlock();
  }, []);

  const leaveDungeon = () => {
    setRun(null); setPhase("choice"); setSettlement(null); setUnsettled(null); setVerifying(null); setMenu(null);
    setPeeked(null);
  };

  /** Run again with the same kit where the satchel still has it, rather than sending the player back up. */
  const repeatRun = () => startRun(kitFor(loadout, id => held(stock, id)));

  const closeMenu = () => { setMenu(null); setVerifying(null); };

  if (!snapshot) {
    return <div className="deeper-loading" role={error ? "alert" : "status"}>
      <p>{error || "Lighting the cavern…"}</p>
      {error && <button type="button" disabled={busy || paused} onClick={() => void act(async () => {})}>Retry</button>}
    </div>;
  }
  if (snapshot.friendId !== friendId) return <p className="deeper-loading" role="alert">This dungeon session does not match the selected Friend.</p>;

  const maxPrize = maximumPrize(definition);
  const found = run ? run.rooms.filter(room => room.drop !== null) : [];
  const owned = ITEMS.filter(item => held(stock, item.id) > 0);
  // The picker remembers what the player chose; the satchel decides what can actually go down, so
  // a kit survives a run that spent it and re-arms itself once a drop replaces the missing piece.
  const kit = kitFor(loadout, id => held(stock, id));
  const slots = slotsUsed(kit);
  const affordable = snapshot.rfBalance >= definition.price;
  const canBuy = affordable && backed;
  const pending = snapshot.plays.find(play => play.outcomeId === null);
  const caches = snapshot.inventory.reduce((total, amount) => total + amount, 0n);
  const inDungeon = run !== null;
  const worldPaused = paused || inDungeon || menu !== null;

  const feedback = <p className="deeper-feedback" role={error ? "alert" : "status"}>
    {error || message || (busy ? "Waiting for the runtime confirmation…" : "Simulated RF, simulated outcomes.")}
  </p>;

  // The first four columns are indexed by depth and the last by loot tier; the table lines them
  // up only because both axes run 1-10, so the caption has to say which is which.
  const oddsTable = <table className="deeper-table">
    <caption>Trap, loot and empty are indexed by <b>depth</b>. The pot column is indexed by <b>loot tier</b>.</caption>
    <thead><tr><th>Room / tier</th><th>Trap</th><th>Loot</th><th>Empty</th><th>Pot at that tier</th></tr></thead>
    <tbody>{ROOMS.map(room => <tr key={room.depth}>
      <td>{room.depth}</td><td>{room.trapBps / 100}%</td><td>{room.lootBps / 100}%</td><td>{room.emptyBps / 100}%</td>
      <td>{rf(potFor(room.depth))}</td>
    </tr>)}</tbody>
  </table>;

  const runOver = phase === "busted" || phase === "banked";
  const draws = tally.seen.trap + tally.seen.loot + tally.seen.empty;
  const chi = chiSquare(tally);
  const shown = revealed(verifying);
  // Chi-square wants every expected cell at 5 or more, not merely a large total. Empty is a flat
  // 1500 bps at every depth, so it is always the cell that gets there last.
  const readable = Math.min(tally.expected.trap, tally.expected.loot, tally.expected.empty) >= 5;
  // Only the Greed Idol changes the boundaries a roll is read against, so it is the only thing the
  // independent verifier needs told about the loadout.
  const verifyCommand = (proof: Revealed) => [
    "npm run verify --", `--nonce ${proof.nonce}`, `--play ${proof.playId}`,
    `--commitment ${proof.commitment}`,
    ...(proof.carried.includes("greed-idol") ? ["--carried greed-idol"] : []),
  ].join(" ");
  const proofOf = (source: Run | RunRecord, revealed: boolean): Proof => ({
    commitment: source.commitment, nonce: revealed ? source.nonce : null,
    playId: source.playId, rooms: source.rooms, carried: source.carried,
  });

  return <section className="deeper-game" aria-label={definition.name} aria-busy={busy}>
    {/* Steering by hand is the player changing their mind: the walk they queued stops being what
        they want the moment they take the controls back. */}
    <div className="deeper-world" ref={world} inert={worldPaused || undefined} onPointerDown={onWorldPointer}
      data-approaching={approaching ?? undefined}
      onPointerMove={trackHover} onPointerLeave={event => markHover(event.currentTarget, null)}
      onKeyDown={event => { if (WALK_KEYS.has(event.key.toLowerCase())) setApproaching(null); }}>
      <GameWorld world={SURFACE} spawn={SPAWN} interactions={INTERACTIONS} friendId={friendId}
        paused={worldPaused} reducedMotion={reducedMotion}
        onInteract={id => { const target = MENU_FOR[id]; if (target) openMenu(target); }} />
      <div className="deeper-hud">
        <span className="deeper-chip"><small>Preview RF</small><strong>{rf(snapshot.rfBalance)}</strong></span>
        <span className="deeper-chip"><small>Torches</small><strong>{snapshot.consumables.toString()}</strong></span>
        <span className="deeper-chip"><small>Banked</small><strong>{rf(purse)}</strong></span>
        <button type="button" className="deeper-chip" onClick={() => openMenu("satchel")}>
          <small>Satchel</small><strong>{caches.toString()}{owned.length > 0 && ` · ${owned.reduce((total, item) => total + held(stock, item.id), 0)}`}</strong>
        </button>
        <button type="button" className="deeper-chip" onClick={() => openMenu("proof")}>
          <small>Best depth</small><strong>{totals.bestDepth || "—"}</strong>
        </button>
        <button type="button" className="deeper-chip" onClick={() => openMenu("settings")}><small>Menu</small><strong>⚙</strong></button>
      </div>
      <p className="deeper-hint">
        <span className="deeper-desktop">WASD / arrows to walk · tap a spot to move · tap a sign to walk over and open it · <Keycap>E</Keycap> once you are there</span>
        <span className="deeper-mobile">Tap to walk · tap a sign to walk over and open it</span>
      </p>
    </div>

    {run && <Descent friendId={friendId} depth={run.depth} tier={run.tier} rooms={run.rooms} phase={phase}
      pot={potFor(run.tier, run.carried)} carried={run.carried} peeked={peeked?.kind ?? null}
      sealedRoll={sealedRoll} found={found}
      paused={paused || menu !== null} busy={busy} reducedMotion={reducedMotion}
      bestDepth={totals.bestDepth} settlement={runOver ? settlement : null}
      onDescend={descend} onPeek={peek} onBank={bank}
      onRope={useRope} onCharm={useCharm} onAccept={acceptTrap}
      onVerify={() => { if (!busy && !paused) { setVerifying(proofOf(run, runOver)); openMenu("proof"); } }}
      onLedger={() => openMenu("ledger")} onRetrySettle={retrySettle}
      onAgain={repeatRun} onLeave={leaveDungeon} />}

    {menu && <GameMenu
      footer={menu === "entrance"
        ? (pending && !run
          ? <button type="button" className="rf-frame-primary" disabled={busy || paused}
            onClick={() => void act(() => client.settle(pending.id).then(() => undefined), "action-ready")
              .then(ok => ok && setMessage("The abandoned torch was settled to the ledger."))}>
            Close out the abandoned run
          </button>
          : <button type="button" className="rf-frame-primary" disabled={busy || paused || (snapshot.consumables === 0n && !canBuy)}
            onClick={() => startRun(kit)}>
            {snapshot.consumables > 0n ? "Light a torch and descend" : `Buy a torch and descend · ${rf(definition.price)}`}
          </button>)
        : undefined}
      title={menu === "vendor" ? "Torch Vendor" : menu === "entrance" ? "Dungeon Entrance" : menu === "satchel" ? "Satchel"
        : menu === "odds" ? "Room odds" : menu === "proof" ? (verifying ? "Verify this run" : "Fair play")
        : menu === "ledger" ? "Pot and ledger" : menu === "items" ? "Curio shelf" : "Menu"}
      onClose={busy ? undefined : closeMenu}>

      {menu === "vendor" ? <>
        <p>One <b>Torch</b> costs {rf(definition.price)} and lights exactly one run. Buying it reserves the maximum
          prize of {rf(maxPrize)}; the stairs then burn it to commit the run.</p>
        <button type="button" className="rf-frame-primary" disabled={!canBuy || busy || paused}
          onClick={() => void act(() => client.buy(1n), "purchase").then(ok => ok && setMessage("One simulated torch added."))}>
          Buy a torch · {rf(definition.price)}
        </button>
        {!canBuy && <p role="alert">{!affordable ? "Not enough simulated RF. Redeem a cache from your satchel."
          : "Purchases are paused until the dungeon has free backing for another maximum prize."}</p>}
        <p>You are carrying <b>{snapshot.consumables.toString()}</b> torches and <b>{caches.toString()}</b> caches.</p>
        <button type="button" onClick={() => openMenu("items")}>Curios · {rf(purse)} banked</button>
        <button type="button" onClick={() => openMenu("satchel")}>Sell caches</button>
        <button type="button" onClick={() => openMenu("odds")}>Room odds</button>
      </> : menu === "entrance" ? <>
        <p>The staircase drops ten rooms. Each room is a committed draw: <b>loot</b> grows the pot, <b>empty</b> costs
          you nothing but the depth, <b>trap</b> ends the run and the dark keeps everything unbanked.</p>
        <p>Bank after any safe room to keep the pot. The deepest cache is {rf(maxPrize)}.</p>
        {pending && !run && <p role="alert">A torch is still burning from an interrupted run. Close it out before starting another.</p>}
        {!pending && <div className="deeper-loadout">
          <p className="deeper-loadout-head">
            <span>Carry</span>
            <span className="deeper-slots" role="img" aria-label={`${slots} of ${CARRY_CAP} slots filled`}>
              {Array.from({ length: CARRY_CAP }, (_, index) => <i key={index} data-filled={index < slots || undefined} />)}
            </span>
            <span>{slots} of {CARRY_CAP} slots</span>
          </p>
          {owned.length === 0
            ? <p className="deeper-note">The satchel holds no curios. Empty rooms leave one behind, and the
              vendor sells them for banked pot.</p>
            : <>
              {owned.map(item => {
                const carried = kit.includes(item.id);
                return <label key={item.id} className="deeper-item" data-on={carried || undefined}>
                  <input type="checkbox" checked={carried} disabled={busy || paused || (!carried && !canCarry(kit, item.id))}
                    onChange={() => setLoadout(current => carried ? current.filter(id => id !== item.id) : [...current, item.id])} />
                  <ItemArt item={item} />
                  <span><strong>{item.name}</strong>
                    <small>{item.summary}</small>
                    <small className="deeper-meta">{item.slots === 2 ? "Both slots" : "1 slot"} · {held(stock, item.id)} in the satchel</small></span>
                </label>;
              })}
              <p className="deeper-note">A loadout is spent by the run it goes into, used or not.</p>
            </>}
        </div>}
        <button type="button" onClick={() => openMenu("items")}>Curio shelf · {rf(purse)} banked</button>
        <button type="button" onClick={() => openMenu("odds")}>Room odds</button>
      </> : menu === "satchel" ? <>
        <p>Caches are what the ledger settles each torch into. They keep their fixed RF value with no expiry.</p>
        {definition.outcomes.map((outcome, index) => <div className="deeper-item" key={outcome.name}>
          <span><strong>{outcome.name}</strong><small>{snapshot.inventory[index].toString()} held · {rf(outcome.reward)} · {outcome.chanceBps / 100}%</small></span>
          <button type="button" disabled={busy || paused || snapshot.inventory[index] === 0n || outcome.reward === 0n}
            onClick={() => void act(() => client.redeem(index + 1, 1n), "reward")}>Sell one</button>
        </div>)}
        {owned.length > 0 && <>
          <p>Curios are carried into a run, not sold. Each is spent by the descent it goes on.</p>
          {owned.map(item => <div className="deeper-item deeper-offer" key={item.id}>
            <ItemArt item={item} />
            <span><strong>{item.name}</strong>
              <small>{item.effect}</small>
              <small className="deeper-meta">{item.category} · {held(stock, item.id)} in the satchel</small></span>
          </div>)}
        </>}
      </> : menu === "items" ? <>
        <p>Curios are bought with <b>banked pot</b>, the RF this game simulates at the run layer — the ledger has
          one consumable, so a curio cannot be a second thing it sells. You have <b>{rf(purse)}</b> banked.</p>
        {ITEMS.map(item => <div className="deeper-item deeper-offer" key={item.id}>
          <ItemArt item={item} />
          <span>
            <strong>{item.name} <b className="deeper-price">{rf(item.price)}</b></strong>
            <small>{item.effect}</small>
            <small className="deeper-meta">{item.category} · {item.slots === 2 ? "both slots" : "1 slot"} · {held(stock, item.id)} in the satchel</small>
          </span>
          <button type="button" disabled={busy || paused || purse < item.price} onClick={() => buyItem(item.id)}>Buy</button>
        </div>)}
        <p className="deeper-note">{ITEM_RULES.pricing}</p>
        <p className="deeper-note">{ITEM_RULES.note}</p>
      </> : menu === "odds" ? <>
        {oddsTable}
        <p>Pot tier follows <b>loot</b> rooms, not depth: an empty room takes you deeper without growing the pot.</p>
        <p>Optimal stopping banks <b>0.906 RF</b> of simulated pot per {rf(definition.price)} torch — a 9.4% edge — and
          runs bust 55.4% of the time. The cache the ledger actually settles each torch into is worth <b>0.912 RF</b> on
          average, an 8.8% edge.</p>
        <p>Both price the bank-or-descend decision on its own. Counting the curio an empty room leaves one time in
          five, the pot layer as it is actually played returns <b>0.944 RF</b> a torch — a <b>5.65% edge</b>, the one
          to judge the game by.</p>
      </> : menu === "proof" && verifying ? <>
        <p>{FAIRNESS.note}</p>
        <p className="deeper-note"><code>{FAIRNESS.roomDraw}</code></p>
        <p className="deeper-note"><code>{FAIRNESS.roomOrder}</code></p>
        <dl className="deeper-proof">
          <dt>Commitment</dt><dd>sha256(nonce) = {verifying.commitment}</dd>
          <dt>Nonce</dt><dd>{verifying.nonce ?? "Held until the run ends — publishing it now would reveal every room below you."}</dd>
          <dt>Play ID</dt><dd>{verifying.playId.toString()}</dd>
        </dl>
        <table className="deeper-table">
          <thead><tr><th>Room</th><th>sha256(nonce:playId:depth)</th><th>Roll</th><th>Drew</th><th>Resolved</th></tr></thead>
          <tbody>{verifying.rooms.map(room => <tr key={room.depth}>
            <td>{room.depth}</td><td className="deeper-hash">{room.draw.hash.slice(0, 16)}…</td>
            <td>{room.draw.roll}</td><td>{room.natural}</td>
            <td>{room.kind}{room.used.length > 0 && <small> · {room.used.map(id => itemFor(id).name).join(" + ")}</small>}</td>
          </tr>)}</tbody>
        </table>
        {verifying.rooms.some(room => room.reroll) && <>
          <p>A Lucky Charm reroll is its own committed draw at the same depth, so it recomputes from the same nonce.</p>
          <table className="deeper-table">
            <thead><tr><th>Room</th><th>sha256(nonce:playId:depth:reroll)</th><th>Roll</th><th>Result</th></tr></thead>
            <tbody>{verifying.rooms.filter(room => room.reroll).map(room => <tr key={room.depth}>
              <td>{room.depth}</td><td className="deeper-hash">{room.reroll!.hash.slice(0, 16)}…</td>
              <td>{room.reroll!.roll}</td><td>{room.kind}</td>
            </tr>)}</tbody>
          </table>
        </>}
        {verifying.rooms.some(room => room.drop) && <>
          <p>What an empty room leaves is two more draws off the same nonce: one decides whether,
            one decides which. A room that got there on a Lucky Charm draws its pair off that reroll, under
            the <code>reroll-</code> tags.</p>
          <table className="deeper-table">
            <thead><tr><th>Room</th><th>sha256(…:gate tag)</th><th>Roll</th><th>sha256(…:pick tag)</th><th>Left behind</th></tr></thead>
            <tbody>{verifying.rooms.filter(room => room.drop).map(room => {
              const tags = dropTags(room);
              const gate = shown && drawRoom(shown.nonce, shown.playId, room.depth, tags.gate);
              const pick = shown && drawRoom(shown.nonce, shown.playId, room.depth, tags.pick);
              return <tr key={room.depth}>
                <td>{room.depth}<small> · {tags.gate}</small></td>
                <td className="deeper-hash">{gate ? `${gate.hash.slice(0, 12)}…` : "held"}</td>
                <td>{gate ? `${gate.roll} < ${ITEM_RULES.dropChanceBps}` : "—"}</td>
                <td className="deeper-hash">{pick ? `${pick.hash.slice(0, 12)}…` : "held"}</td>
                <td>{itemFor(room.drop!).name}</td>
              </tr>;
            })}</tbody>
          </table>
        </>}
        {verifying.carried.length > 0 && <p className="deeper-note">Carried: {verifying.carried.map(id => itemFor(id).name).join(", ")}.
          A curio can override what a roll resolves to; it never changes the roll, and both are printed above.</p>}
        {shown && <>
          <p>Everything above was computed by this game. To check it without taking its word, recompute the run from
            the revealed nonce with <code>node:crypto</code> instead:</p>
          <p className="deeper-note"><code>{verifyCommand(shown)}</code></p>
          <button type="button" onClick={() => {
            void navigator.clipboard?.writeText(verifyCommand(shown))
              .then(() => setMessage("Verification command copied."))
              .catch(() => setMessage("Could not reach the clipboard — the command is printed above."));
          }}>Copy the command</button>
        </>}
        <button type="button" onClick={() => setVerifying(null)}>Back to fair play</button>
      </> : menu === "proof" ? <>
        <p>Two ways to check this game is dealing straight. Per run, the commitment proves the rooms were fixed
          before you chose anything. Across the session, the draws themselves should match the weights the table
          publishes — a rigged table drifts away from its own numbers here.</p>

        {draws === 0 ? <p className="deeper-note">No rooms entered yet. The calibration fills in as you play.</p> : <>
          <table className="deeper-table">
            <caption>Every committed draw this session — rooms and Lucky Charm rerolls — against what the
              published weights expected of it.</caption>
            <thead><tr><th>Result</th><th>Expected</th><th>Seen</th><th>Difference</th></tr></thead>
            <tbody>{(["trap", "loot", "empty"] as const).map(kind => <tr key={kind}>
              <td>{kind}</td>
              <td>{tally.expected[kind].toFixed(1)}</td>
              <td>{tally.seen[kind]}</td>
              <td>{(tally.seen[kind] - tally.expected[kind] >= 0 ? "+" : "") + (tally.seen[kind] - tally.expected[kind]).toFixed(1)}</td>
            </tr>)}</tbody>
          </table>
          <p>Over <b>{draws}</b> draws, chi-square is <b>{chi.toFixed(2)}</b> on two degrees of freedom.{" "}
            {!readable ? "Too few draws to read yet — the smallest expected count has to reach 5 before the number means anything."
              : chi < 9.21 ? "That sits inside the p=0.01 band of 9.21, which is what an honest table looks like."
                : chi < 13.82 ? "That is outside the p=0.01 band of 9.21 but inside p=0.001. Unusual, not yet suspicious."
                  : "That is outside even the p=0.001 band of 13.82 — worth a second look at the rooms themselves."}</p>
          <p className="deeper-note">Read it loosely. Every draw comes from its own depth's weights rather than one
            shared distribution, so the bands above are an approximation — a conservative one, which errs towards
            calling an honest table honest. And because this recomputes after every room, watching it long enough
            will cross a band more often than a single reading at a fixed count would suggest.</p>
        </>}

        <p>Best depth <b>{totals.bestDepth || "—"}</b> · best bank <b>{rf(totals.bestPot)}</b> · banked this
          session <b>{rf(totals.banked)}</b> over {totals.runs} runs.</p>
        {history.length === 0 ? <p>No runs yet. Buy a torch and take the stairs.</p> : <table className="deeper-table">
          {totals.runs > history.length && <caption>The last {history.length} of {totals.runs} runs.</caption>}
          <thead><tr><th>Run</th><th>Depth</th><th>Result</th><th>Ledger settled</th><th /></tr></thead>
          <tbody>{history.map(record => <tr key={record.number}>
            <td>{record.number}</td><td>{record.depth}</td>
            <td>{record.banked ? rf(record.pot) : "busted"}</td>
            <td>{record.settlement ? `${record.settlement.name} · ${rf(record.settlement.reward)}` : "—"}</td>
            <td><button type="button" className="deeper-link"
              onClick={() => setVerifying(proofOf(record, true))}>Verify</button></td>
          </tr>)}</tbody>
        </table>}
      </> : menu === "ledger" ? <>
        <p>The run is the game: rooms come from a committed draw made in the frame, and banking locks the pot in at
          the tier you stopped on. Nothing credits that pot to your balance — the RF you get back comes from the
          cache below.</p>
        <p>The v0.1 SDK settles one <b>fixed</b> reward per torch, chosen by its own weighted draw. It has no action
          that says &ldquo;pay the pot at the depth this player stopped&rdquo;, so a payout that depends on your
          stop-depth cannot be expressed on-chain yet.</p>
        <p>So this prototype runs both, honestly and side by side. Real through the SDK client: the {rf(definition.price)} torch
          purchase, the torch burn, the {rf(maxPrize)} prize reserve, the per-run settlement and cache redemption.
          Simulated at the game layer: the banked pot.</p>
        <p>They agree in expectation — the published table pays <b>0.912 RF</b> per torch and optimal stopping banks
          <b>0.906 RF</b> — but they are separate draws, so over a session your banked total and your satchel will
          differ by however the variance falls. Closing the gap needs a contract action such
          as <code>bank(playId, tier)</code>; that is the first item for the on-chain phase.</p>
      </> : menu === "settings" ? <>
        <label><input type="checkbox" checked={!muted}
          onChange={event => setSoundOn(event.target.checked)} /> Sound</label>
        <label><input type="checkbox" checked={reducedMotion}
          onChange={event => { motionChosen.current = true; setReducedMotion(event.target.checked); }} /> Reduce motion</label>
        <button type="button" onClick={() => openMenu("odds")}>Room odds</button>
        <button type="button" onClick={() => openMenu("proof")}>Fair play</button>
        <p>All balances, purchases and rewards are simulated. Reloading resets the preview. Wallet connection and
          ownership verification belong to the SDK runtime.</p>
        <button type="button" onClick={() => openMenu("ledger")}>Pot and ledger</button>
        <p className="deeper-note">{LEDGER_NOTE}</p>
      </> : null}
      {feedback}
    </GameMenu>}
  </section>;
}
