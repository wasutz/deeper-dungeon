"use client";

import { useEffect, useMemo, type CSSProperties } from "react";
import { formatGameAmount, ItemArt, Keycap } from "@rarefriends/friendsdk/ui";
import { FriendSprite } from "./sprite.js";
import {
  BAND_NAMES, bandFor, MAX_DEPTH, oddsFor, potFor, ropeShare, tierStep,
  type Room, type RoomKind, type RoomOdds,
} from "./rules.js";
import { holds, itemFor, type Carried } from "./items.js";

const rf = (value: bigint) => `${formatGameAmount(value, 18)} RF`;

/** Deterministic jitter so a room's silhouette is derived from its own committed draw. */
function noise(seed: number) {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function RoomArt({ depth, seed }: { depth: number; seed: number }) {
  const band = bandFor(depth);
  const shapes = useMemo(() => {
    const random = noise(seed * 977 + depth);
    return {
      teeth: Array.from({ length: 13 }, (_, index) => {
        const x = 24 + index * 76 + random() * 26;
        return { x, width: 16 + random() * 20, drop: 22 + random() * 62 };
      }),
      rubble: Array.from({ length: 9 }, () => ({ x: random() * 940, width: 26 + random() * 58, height: 6 + random() * 14 })),
      motes: Array.from({ length: 16 }, () => ({ x: random() * 960, y: 30 + random() * 230, size: 1 + random() * 2.6, delay: random() * 4 })),
      cracks: Array.from({ length: 5 }, () => ({ x: 60 + random() * 840, y: 196 + random() * 70, run: 40 + random() * 120, lean: random() * 40 - 20 })),
    };
  }, [depth, seed]);

  return <svg className="deeper-art" viewBox="0 0 960 340" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect width="960" height="340" fill="var(--deep-void)" />
    <path d="M0 340V116l150-46 160 26 170-44 168 40 154-28 158 42v234z" fill="var(--deep-wall)" />
    <path d="M110 300V170l90-34 128 20 132-34 130 32 118-22 92 26v142z" fill="var(--deep-back)" />
    {/* The way down: a darker arch behind the Friend, wider as the shaft opens up. */}
    <path d={`M${420 - depth * 5} 300v-84a${60 + depth * 4} ${70 + depth * 3} 0 0 1 ${120 + depth * 10} 0v84z`} fill="var(--deep-arch)" />
    {shapes.teeth.map((tooth, index) =>
      <path key={index} d={`M${tooth.x} 0h${tooth.width}l${-tooth.width / 2} ${tooth.drop}z`} fill="var(--deep-rock)" />)}
    {shapes.rubble.map((rock, index) =>
      <rect key={index} x={rock.x} y={300 - rock.height} width={rock.width} height={rock.height} rx="3" fill="var(--deep-rock)" />)}
    <rect y="300" width="960" height="40" fill="var(--deep-floor)" />

    {band === 0 && shapes.teeth.slice(0, 8).map((tooth, index) =>
      <path key={index} d={`M${tooth.x + 4} ${tooth.drop - 4}q6 26 -2 44`} stroke="var(--deep-accent)" strokeWidth="3" fill="none" strokeLinecap="round" />)}
    {band === 1 && shapes.cracks.map((crack, index) =>
      <path key={index} d={`M${crack.x} ${crack.y}l${crack.lean} ${-crack.run * 0.5}l${crack.lean * 0.6} ${-crack.run * 0.4}`}
        stroke="var(--deep-accent)" strokeWidth="2.5" fill="none" strokeLinecap="round" />)}
    {band === 2 && shapes.cracks.map((crack, index) =>
      <path key={index} d={`M${crack.x} 300l${crack.lean} ${-crack.run}l${crack.lean * 0.5} ${-crack.run * 0.4}`}
        stroke="var(--deep-accent)" strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.85" />)}
    {band === 3 && shapes.motes.map((mote, index) =>
      <circle key={index} className="deeper-mote" cx={mote.x} cy={mote.y} r={mote.size} fill="var(--deep-accent)"
        style={{ animationDelay: `${mote.delay}s` }} />)}
  </svg>;
}

/**
 * Where the committed roll landed inside this room's weight ranges, as this loadout sees them.
 * A null roll is the room being entered: the draw is already sealed but not yet read, so the mark
 * sweeps under CSS instead of standing anywhere, and the bar stays out of the accessibility tree
 * rather than naming a position it does not know.
 */
/**
 * Embers thrown off the sweeping mark. Fixed rather than random: the scatter wants to look
 * unplanned, not to be re-rolled on every render of a bar that is already animating.
 */
const SPARKS = [
  { x: -13, y: -11, size: 3.5, hue: 38, delay: 0, life: 620 },
  { x: 11, y: -14, size: 2.5, hue: 12, delay: 90, life: 540 },
  { x: -8, y: 13, size: 3, hue: 275, delay: 160, life: 700 },
  { x: 14, y: 9, size: 2, hue: 200, delay: 240, life: 500 },
  { x: -17, y: 3, size: 2.5, hue: 52, delay: 310, life: 660 },
  { x: 17, y: -4, size: 3.5, hue: 320, delay: 80, life: 580 },
  { x: -5, y: -17, size: 2, hue: 165, delay: 400, life: 620 },
  { x: 6, y: 16, size: 3, hue: 38, delay: 460, life: 540 },
  { x: -21, y: -6, size: 2, hue: 275, delay: 200, life: 720 },
  { x: 21, y: 6, size: 2.5, hue: 12, delay: 350, life: 600 },
  { x: 2, y: -21, size: 2.5, hue: 200, delay: 520, life: 680 },
  { x: -2, y: 20, size: 2, hue: 52, delay: 130, life: 560 },
] as const;

function DrawBar({ odds, roll }: { odds: RoomOdds; roll: number | null }) {
  const rolling = roll === null;
  return <div className="deeper-range" role={rolling ? undefined : "img"} aria-hidden={rolling || undefined}
    aria-label={rolling ? undefined
      : `Roll ${roll} of 10000. Trap below ${odds.trapBps}, loot below ${odds.trapBps + odds.lootBps}, otherwise empty.`}>
    {/* The track clips its own segments; the mark rides above it so its glow and embers are not
        cut off at the 14px the bar itself is tall. */}
    <div className="deeper-range-track">
      <span className="deeper-range-trap" style={{ width: `${odds.trapBps / 100}%` }}>trap</span>
      <span className="deeper-range-loot" style={{ width: `${odds.lootBps / 100}%` }}>loot</span>
      <span className="deeper-range-empty" style={{ width: `${odds.emptyBps / 100}%` }}>empty</span>
    </div>
    {rolling
      ? <i className="deeper-range-mark" data-rolling="">
        {SPARKS.map((spark, index) => <b key={index} style={{
          "--x": `${spark.x}px`, "--y": `${spark.y}px`, "--size": `${spark.size}px`,
          "--hue": spark.hue, "--delay": `${spark.delay}ms`, "--life": `${spark.life}ms`,
        } as CSSProperties} />)}
      </i>
      : <i className="deeper-range-mark" style={{ left: `${roll / 100}%` }} />}
  </div>;
}

/**
 * How long a room takes to open. The sweep across the draw bar is paced off the same number, so it
 * lives with the animation rather than with the timer in the host that waits it out.
 */
export const ROOM_REVEAL_MS = 1500;

export type DescentPhase = "choice" | "entering" | "sprung" | "settling" | "unsettled" | "busted" | "banked";
export type Settlement = Readonly<{ name: string; reward: bigint }>;

export type DescentProps = {
  friendId: bigint;
  depth: number;
  tier: number;
  rooms: readonly Room[];
  phase: DescentPhase;
  pot: bigint;
  carried: Carried;
  peeked: RoomKind | null;
  found: readonly Room[];
  paused: boolean;
  busy: boolean;
  reducedMotion: boolean;
  bestDepth: number;
  settlement: Settlement | null;
  onDescend: (intent?: { arm?: boolean; force?: boolean }) => void;
  onPeek: () => void;
  onBank: () => void;
  onRope: () => void;
  onCharm: () => void;
  onAccept: () => void;
  onVerify: () => void;
  onLedger: () => void;
  onRetrySettle: () => void;
  onAgain: () => void;
  onLeave: () => void;
};

const VERDICT: Record<RoomKind, string> = { trap: "TRAP", loot: "LOOT", empty: "EMPTY" };

export function Descent({ friendId, depth, tier, rooms, phase, pot, carried, peeked, found, paused, busy,
  reducedMotion, bestDepth, settlement, onDescend, onPeek, onBank, onRope, onCharm, onAccept,
  onVerify, onLedger, onRetrySettle, onAgain, onLeave }: DescentProps) {
  const last = rooms[rooms.length - 1] ?? null;
  // A curio is spent by the room it was taken into whether or not it changed anything, so what it
  // was spent on and what it overrode are two different claims. Only the second may say "overridden".
  const spent = last?.used.map(id => itemFor(id).name).join(" and ") ?? "";
  const atFloor = depth >= MAX_DEPTH;
  const nextDepth = Math.min(depth + 1, MAX_DEPTH);
  const next = oddsFor(nextDepth, carried);
  const nextPot = potFor(Math.min(tier + tierStep(carried), MAX_DEPTH), carried);
  const over = phase === "busted" || phase === "banked";
  const canAct = phase === "choice" && !paused && !busy;
  const canReact = phase === "sprung" && !paused && !busy;

  // Accelerators are for the descent itself. Anything focusable already has its own keyboard
  // behaviour -- Space must press the focused button, not descend past it.
  useEffect(() => {
    if (paused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as Element | null)?.closest?.("button, a, input, select, textarea, [role='dialog']")) return;
      const key = event.key.toLowerCase();
      if (over && (key === "r" || key === "enter")) { event.preventDefault(); onAgain(); return; }
      if (!canAct) return;
      if (key === "b" && tier > 0) { event.preventDefault(); onBank(); }
      if ((key === "d" || key === " ") && !atFloor) { event.preventDefault(); onDescend(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paused, over, canAct, atFloor, tier, onAgain, onBank, onDescend]);

  // Carried kit hangs in the chamber rather than above it: a row of its own would take the space
  // the Friend stands in, and torchlight is where you would look for what you brought.
  const satchel = carried.length > 0 && <ul className="deeper-carried" aria-label="Carried items">
    {carried.map(id => {
      const item = itemFor(id);
      const passive = id === "greed-idol" || id === "loot-sack";
      return <li key={id} data-passive={passive || undefined} title={item.summary}>
        <ItemArt item={item} />
        <span><strong>{item.name}</strong>{passive && <small>All run</small>}</span>
      </li>;
    })}
  </ul>;

  return <section className="deeper-descent" data-band={bandFor(depth)} data-phase={phase}
    data-risk={phase === "choice" && !atFloor ? Math.min(4, Math.floor(next.trapBps / 1500)) : 0}
    style={{ "--reveal": `${ROOM_REVEAL_MS}ms` } as CSSProperties}
    aria-label="Dungeon descent" aria-busy={busy}>

    <div className="deeper-descent-bar">
      <span className="deeper-stat"><small>Depth</small><strong>{depth} <i>/ {MAX_DEPTH}</i></strong></span>
      <span className="deeper-stat deeper-stat-wide"><small>{BAND_NAMES[bandFor(depth)]}</small>
        <strong className="deeper-pot" key={pot.toString()}>{rf(pot)}</strong></span>
      <span className="deeper-stat"><small>Best run</small><strong>{bestDepth || "—"}</strong></span>
    </div>

    <div className="deeper-chamber">
      <RoomArt depth={Math.max(1, depth)} seed={last?.draw.roll ?? 0} />
      <div className="deeper-torch" style={{ "--burn": `${100 - depth * 7}%` } as CSSProperties} />
      {satchel}
      <FriendSprite friendId={friendId} facing="down" walking={phase === "entering"} reducedMotion={reducedMotion} />
      {phase === "entering" && <p className="deeper-entering">Entering room {depth + 1}…</p>}
      {last && phase !== "entering" && <p className={`deeper-verdict deeper-verdict-${last.kind}`} aria-hidden="true">
        {VERDICT[last.kind]}
        <small>{last.kind === "trap" ? "The dark keeps the pot."
          : last.kind === "loot" ? `Pot is now ${rf(potFor(last.tier, carried))}.`
            : last.drop ? `Nothing here but a ${itemFor(last.drop).name} in the rubble.` : "Nothing here. The pot holds."}</small>
      </p>}
      {/* One region that outlives its own content: a live region mounted with its text already
          in place is not reliably announced. */}
      <p className="deeper-announce" role="status">
        {phase === "entering" ? `Entering room ${depth + 1}.`
          : last ? `Room ${last.depth}: ${last.kind}. ${last.kind === "trap" ? "The run is over."
            : last.kind === "loot" ? `The pot is now ${rf(potFor(last.tier, carried))}.`
              : last.drop ? `The pot holds. You found a ${itemFor(last.drop).name}.` : "The pot holds."}` : ""}
      </p>
    </div>

    <ol className="deeper-ribbon" aria-label="Rooms cleared">
      {Array.from({ length: MAX_DEPTH }, (_, index) => {
        const room = rooms[index];
        return <li key={index} data-kind={room?.kind ?? "unknown"} data-current={index + 1 === depth || undefined}
          data-bent={room && room.used.length > 0 ? "" : undefined}>
          <span aria-hidden="true">{index + 1}</span>
          <small className="deeper-visually-hidden">Room {index + 1}: {room?.kind ?? "not entered"}</small>
        </li>;
      })}
    </ol>

    {/* The room being entered takes the same slot the room just read leaves behind, so the mark
        lands in place rather than the block appearing under the player mid-reveal. */}
    {phase === "entering" ? <div className="deeper-draw">
      <span className="deeper-draw-head">Dice draw · room {nextDepth}</span>
      <DrawBar odds={oddsFor(nextDepth, carried)} roll={null} />
      <span className="deeper-draw-foot">
        <span className="deeper-draw-hash">Sealed draw · revealing…</span>
      </span>
    </div> : last && <div className="deeper-draw">
      <span className="deeper-draw-head">Dice draw · room {last.depth}</span>
      <DrawBar odds={oddsFor(last.depth, carried)} roll={(last.reroll ?? last.draw).roll} />
      <span className="deeper-draw-foot">
        <span className="deeper-draw-hash">
          <b>{(last.reroll ?? last.draw).roll}</b> / 10000 · sha256 {(last.reroll ?? last.draw).hash.slice(0, 8)}…
          {last.used.length > 0 && (last.kind === last.natural
            ? <em> · {spent} spent, the draw stood</em>
            : <em> · {VERDICT[last.natural].toLowerCase()} overridden by {spent}</em>)}
        </span>
        <button type="button" className="deeper-link" onClick={onVerify}>Verify</button>
      </span>
    </div>}

    <div className="deeper-choice">
      {phase === "sprung" ? <>
        <p className="deeper-outcome deeper-outcome-bust">A trap at depth {depth}. You still have something to spend.</p>
        <div className="deeper-buttons">
          {holds(carried, "escape-rope") && <button type="button" className="deeper-primary" disabled={!canReact} onClick={onRope}>
            Escape Rope — leave with {rf(ropeShare(pot))}
          </button>}
          {holds(carried, "lucky-charm") && <button type="button" className="deeper-primary" disabled={!canReact} onClick={onCharm}>
            Lucky Charm — reroll this room
          </button>}
          <button type="button" disabled={!canReact} onClick={onAccept}>Take the dark</button>
        </div>
      </> : phase === "settling" ? <>
        <p className="deeper-settling" role="status">Settling the torch with the ledger…</p>
      </> : phase === "unsettled" ? <>
        <p className="deeper-settling deeper-settling-failed" role="alert">The run is over, but its torch is still open
          on the ledger. Settle it before starting another — the maximum prize stays reserved until you do.</p>
        <div className="deeper-buttons">
          <button type="button" className="deeper-primary" disabled={paused || busy} onClick={onRetrySettle}>Settle this torch</button>
          <button type="button" disabled={paused || busy} onClick={onLeave}>Back to the ledge</button>
        </div>
      </> : over ? <>
        <p className={`deeper-outcome deeper-outcome-${phase === "banked" ? "bank" : "bust"}`}>
          {phase === "banked" ? `Banked ${rf(pot)} from depth ${depth}.` : `Lost to the dark at depth ${depth}.`}
        </p>
        {found.length > 0 && <p className="deeper-found">Carried out of the dark:{" "}
          <b>{found.map(room => itemFor(room.drop!).name).join(", ")}</b>. Ready for the next run.</p>}
        {settlement && <p className="deeper-ledger">Simulated payout. The v0.1 ledger settled the torch separately
          as <b>{settlement.name}</b> · {rf(settlement.reward)}.
          <button type="button" className="deeper-link" onClick={onLedger}>Why?</button></p>}
        <div className="deeper-buttons">
          <button type="button" className="deeper-primary" disabled={paused || busy} onClick={onAgain}>Run again <Keycap>R</Keycap></button>
          <button type="button" disabled={paused || busy} onClick={onLeave}>Back to the ledge</button>
        </div>
      </> : <>
        <p className="deeper-odds">
          {atFloor ? "The dungeon floor. There is nowhere deeper to go."
            : peeked ? <>The Lantern shows room {nextDepth}: <b className={`deeper-peek-${peeked}`}>{VERDICT[peeked]}</b>.
              {peeked === "loot" ? ` Loot takes the pot to ${rf(nextPot)}.` : peeked === "trap" ? " Walk in and it ends you." : " Nothing down there but the depth."}</>
            : <>Room {nextDepth} is a <b>{next.trapBps / 100}%</b> trap. Loot takes the pot to <b>{rf(nextPot)}</b>.</>}
        </p>
        <div className="deeper-buttons">
          <button type="button" className="deeper-bank" disabled={!canAct || tier === 0} onClick={onBank}>
            {tier === 0 ? "Nothing to bank yet" : <>Bank {rf(pot)} <Keycap>B</Keycap></>}
          </button>
          {!atFloor && <button type="button" className="deeper-descend" disabled={!canAct} onClick={() => onDescend()}>
            {tier === 0 && depth === 0 ? "Descend" : "Descend — risk it"} <Keycap>D</Keycap>
          </button>}
          {/* Ten empty rooms leaves nothing to bank and nowhere to go; the torch still needs closing out. */}
          {atFloor && tier === 0 && <button type="button" disabled={paused || busy} onClick={onLeave}>
            Back to the ledge
          </button>}
        </div>
        {!atFloor && <div className="deeper-buttons deeper-buttons-items">
          {holds(carried, "lantern") && !peeked && <button type="button" disabled={!canAct} onClick={onPeek}>
            Lantern — read room {nextDepth}
          </button>}
          {holds(carried, "ward") && <button type="button" disabled={!canAct} onClick={() => onDescend({ arm: true })}>
            Arm the Ward and descend
          </button>}
          {holds(carried, "divining-rod") && <button type="button" disabled={!canAct} onClick={() => onDescend({ force: true })}>
            Divining Rod — force loot
          </button>}
        </div>}
      </>}
    </div>
  </section>;
}
