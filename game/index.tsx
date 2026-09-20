"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameWorld } from "@rarefriends/friendsdk/world-view";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount, Keycap } from "@rarefriends/friendsdk/ui";
import { maximumPrize, type GameSnapshot } from "@rarefriends/friendsdk/game";
import { createFriendSoundKit, type FriendSoundCue, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import { createRunNonce, sha256Hex } from "./fairness.js";
import { enterRoom, FAIRNESS, LEDGER_NOTE, MAX_DEPTH, potFor, ROOMS, type Room } from "./rules.js";
import { INTERACTIONS, SPAWN, SURFACE } from "./world.js";
import { Descent, type DescentPhase } from "./descent.js";
// No SDK stylesheet imports. The runner already supplies frame.css and runtime.css to this
// document, and the cavern palette replaces world-view.css and ui.css wholesale rather than
// loading them to override nearly every rule -- see the world-view block in style.css.
import "./style.css";

const rf = (value: bigint) => `${formatGameAmount(value, 18)} RF`;
const ROOM_REVEAL_MS = 760;

type Menu = "vendor" | "entrance" | "satchel" | "settings" | "odds" | "verify" | "runs" | "ledger" | null;

type Run = Readonly<{ playId: bigint; nonce: string; commitment: string; rooms: readonly Room[]; depth: number; tier: number }>;
type Settlement = Readonly<{ name: string; reward: bigint }>;
type RunRecord = Readonly<{
  number: number; depth: number; tier: number; pot: bigint; banked: boolean;
  settlement: Settlement | null; playId: bigint; nonce: string; rooms: readonly Room[];
}>;

export default function Deeper({ friendId, client, paused }: GameComponentProps) {
  const definition = client.definition;
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [phase, setPhase] = useState<DescentPhase>("choice");
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [history, setHistory] = useState<readonly RunRecord[]>([]);
  const [verifying, setVerifying] = useState<RunRecord | Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [muted, setMuted] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);

  const sound = useRef<FriendSoundKit | null>(null);
  const locked = useRef(false);
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const version = ++epoch.current;
    sound.current = createFriendSoundKit({ muted: true });
    setSnapshot(null); setMenu(null); setRun(null); setPhase("choice"); setSettlement(null);
    setHistory([]); setVerifying(null); setError(""); setMessage(""); setBusy(false); setMuted(true);
    locked.current = false;
    void client.read().then(value => { if (version === epoch.current) setSnapshot(value); }).catch(cause => {
      if (version === epoch.current) setError(cause instanceof Error ? cause.message : "Could not load the dungeon ledger.");
    });
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
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

  // A held descent must not resolve while the runtime has the game paused behind a menu.
  useEffect(() => {
    if (!paused || !timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setPhase(current => current === "entering" ? "choice" : current);
  }, [paused]);

  const act = useCallback(async (work: () => Promise<void>, cue?: FriendSoundCue) => {
    if (locked.current || paused) return false;
    const version = epoch.current;
    locked.current = true;
    setBusy(true); setError(""); setMessage("");
    void sound.current?.unlock();
    try {
      await work();
      const value = await client.read();
      if (version === epoch.current) { setSnapshot(value); if (cue) sound.current?.play(cue); }
      return true;
    } catch (cause) {
      if (version === epoch.current) setError(cause instanceof Error ? cause.message : "The simulated action failed.");
      return false;
    } finally {
      if (version === epoch.current) { locked.current = false; setBusy(false); }
    }
  }, [client, paused]);

  const openMenu = (next: Menu) => { if (!busy && !paused) { setMenu(next); setError(""); setMessage(""); } };

  const beginRun = useCallback((playId: bigint) => {
    const nonce = createRunNonce();
    setRun({ playId, nonce, commitment: sha256Hex(nonce), rooms: [], depth: 0, tier: 0 });
    setPhase("choice");
    setSettlement(null);
    setMenu(null);
  }, []);

  /** Close the SDK play for a finished run and record what the ledger paid for the torch. */
  const finishRun = useCallback(async (finished: Run, banked: boolean) => {
    const pot = banked ? potFor(finished.tier) : 0n;
    setPhase(banked ? "banked" : "busted");
    await act(async () => {
      const settled = await client.settle(finished.playId);
      const outcome = settled.outcomeId === null ? null : definition.outcomes[settled.outcomeId - 1];
      const result: Settlement | null = outcome ? { name: outcome.name, reward: outcome.reward } : null;
      setSettlement(result);
      setHistory(previous => [{
        number: previous.length + 1, depth: finished.depth, tier: finished.tier, pot, banked,
        settlement: result, playId: finished.playId, nonce: finished.nonce, rooms: finished.rooms,
      }, ...previous].slice(0, 20));
    }, banked ? "reward" : "impact");
  }, [act, client, definition]);

  const descend = useCallback(() => {
    if (!run || phase !== "choice" || busy || paused || run.depth >= MAX_DEPTH) return;
    setPhase("entering");
    void sound.current?.unlock();
    sound.current?.play("anticipation");
    const resolve = () => {
      timer.current = null;
      const room = enterRoom(run.nonce, run.playId, run.depth + 1, run.tier);
      const next: Run = { ...run, rooms: [...run.rooms, room], depth: room.depth, tier: room.tier };
      setRun(next);
      if (room.kind === "trap") { void finishRun(next, false); return; }
      sound.current?.play(room.kind === "loot" ? (room.depth >= 6 ? "reveal-rare" : "reveal-common") : "action-ready");
      setPhase("choice");
    };
    if (reducedMotion) resolve();
    else timer.current = setTimeout(resolve, ROOM_REVEAL_MS);
  }, [run, phase, busy, paused, reducedMotion, finishRun]);

  const bank = useCallback(() => {
    if (!run || phase !== "choice" || busy || paused || run.tier === 0) return;
    void finishRun(run, true);
  }, [run, phase, busy, paused, finishRun]);

  const startRun = useCallback(() => void act(async () => {
    const current = await client.read();
    if (current.consumables === 0n) await client.buy(1n);
    const [play] = await client.play(1n);
    beginRun(play.id);
  }, "action-start"), [act, client, beginRun]);

  const leaveDungeon = () => { setRun(null); setPhase("choice"); setSettlement(null); setMenu(null); };

  if (!snapshot) {
    return <div className="deeper-loading" role={error ? "alert" : "status"}>
      <p>{error || "Lighting the cavern…"}</p>
      {error && <button type="button" disabled={busy || paused} onClick={() => void act(async () => {})}>Retry</button>}
    </div>;
  }
  if (snapshot.friendId !== friendId) return <p className="deeper-loading" role="alert">This dungeon session does not match the selected Friend.</p>;

  const maxPrize = maximumPrize(definition);
  const affordable = snapshot.rfBalance >= definition.price;
  const backed = snapshot.freeStake >= maxPrize && snapshot.freeStake + definition.price >= maxPrize;
  const canBuy = affordable && backed;
  const pending = snapshot.plays.find(play => play.outcomeId === null);
  const caches = snapshot.inventory.reduce((total, amount) => total + amount, 0n);
  const bestDepth = history.reduce((best, record) => Math.max(best, record.depth), 0);
  const bestPot = history.reduce((best, record) => record.pot > best ? record.pot : best, 0n);
  const bankedTotal = history.reduce((total, record) => total + record.pot, 0n);
  const inDungeon = run !== null;
  const worldPaused = paused || inDungeon || menu !== null;

  const feedback = <p className="deeper-feedback" role={error ? "alert" : "status"}>
    {error || message || (busy ? "Waiting for the runtime confirmation…" : "Simulated RF, simulated outcomes.")}
  </p>;

  const oddsTable = <table className="deeper-table">
    <thead><tr><th>Room</th><th>Trap</th><th>Loot</th><th>Empty</th><th>Pot at that tier</th></tr></thead>
    <tbody>{ROOMS.map(room => <tr key={room.depth}>
      <td>{room.depth}</td><td>{room.trapBps / 100}%</td><td>{room.lootBps / 100}%</td><td>{room.emptyBps / 100}%</td>
      <td>{rf(potFor(room.depth))}</td>
    </tr>)}</tbody>
  </table>;

  const verifyTarget = verifying ?? run;

  return <section className="deeper-game" aria-label={definition.name} aria-busy={busy}>
    <div className="deeper-world" inert={worldPaused || undefined}>
      <GameWorld world={SURFACE} spawn={SPAWN} interactions={INTERACTIONS} friendId={friendId}
        paused={worldPaused} reducedMotion={reducedMotion}
        onInteract={id => openMenu(id === "vendor" ? "vendor" : "entrance")} />
      <div className="deeper-hud">
        <span className="deeper-chip"><small>Preview RF</small><strong>{rf(snapshot.rfBalance)}</strong></span>
        <span className="deeper-chip"><small>Torches</small><strong>{snapshot.consumables.toString()}</strong></span>
        <button type="button" className="deeper-chip" onClick={() => openMenu("satchel")}>
          <small>Satchel</small><strong>{caches.toString()}</strong>
        </button>
        <button type="button" className="deeper-chip" onClick={() => openMenu("runs")}>
          <small>Best depth</small><strong>{bestDepth || "—"}</strong>
        </button>
        <button type="button" className="deeper-chip" onClick={() => openMenu("settings")}><small>Menu</small><strong>⚙</strong></button>
      </div>
      <p className="deeper-hint">
        <span className="deeper-desktop">WASD / arrows to walk · tap a spot to move · <Keycap>E</Keycap> at the vendor or the stairs</span>
        <span className="deeper-mobile">Tap to walk · tap a prompt to interact</span>
      </p>
    </div>

    {run && <Descent friendId={friendId} depth={run.depth} tier={run.tier} rooms={run.rooms} phase={phase}
      pot={potFor(run.tier)} paused={paused} busy={busy} reducedMotion={reducedMotion} bestDepth={bestDepth}
      settlement={phase === "busted" || phase === "banked" ? settlement : null}
      onDescend={descend} onBank={bank} onVerify={() => { setVerifying(run); openMenu("verify"); }}
      onLedger={() => openMenu("ledger")}
      onAgain={startRun} onLeave={leaveDungeon} />}

    {menu && <GameMenu
      title={menu === "vendor" ? "Torch Vendor" : menu === "entrance" ? "Dungeon Entrance" : menu === "satchel" ? "Satchel"
        : menu === "odds" ? "Room odds" : menu === "verify" ? "Verify this run" : menu === "runs" ? "This session"
        : menu === "ledger" ? "Pot and ledger" : "Menu"}
      onClose={busy ? undefined : () => setMenu(null)}>

      {menu === "vendor" ? <>
        <p>One <b>Torch</b> costs {rf(definition.price)} and lights exactly one run. It is consumed at the stairs and
          reserves the maximum prize of {rf(maxPrize)} for the whole descent.</p>
        <button type="button" className="rf-frame-primary" disabled={!canBuy || busy || paused}
          onClick={() => void act(() => client.buy(1n), "purchase").then(ok => ok && setMessage("One simulated torch added."))}>
          Buy a torch · {rf(definition.price)}
        </button>
        {!canBuy && <p role="alert">{!affordable ? "Not enough simulated RF. Redeem a cache from your satchel."
          : "Purchases are paused until the dungeon has free backing for another maximum prize."}</p>}
        <p>You are carrying <b>{snapshot.consumables.toString()}</b> torches and <b>{caches.toString()}</b> caches.</p>
        <button type="button" onClick={() => openMenu("satchel")}>Sell caches</button>
        <button type="button" onClick={() => openMenu("odds")}>Room odds</button>
      </> : menu === "entrance" ? <>
        <p>The staircase drops ten rooms. Each room is a Dice draw: <b>loot</b> grows the pot, <b>empty</b> costs you
          nothing but the depth, <b>trap</b> ends the run and the dark keeps everything unbanked.</p>
        <p>Bank after any safe room to keep the pot. The deepest cache is {rf(maxPrize)}.</p>
        {pending && !run && <p role="alert">A torch is still burning from an interrupted run. Close it out before starting another.</p>}
        {pending && !run
          ? <button type="button" className="rf-frame-primary" disabled={busy || paused}
            onClick={() => void act(() => client.settle(pending.id).then(() => undefined), "action-ready")
              .then(ok => ok && setMessage("The abandoned torch was settled to the ledger."))}>
            Close out the abandoned run
          </button>
          : <button type="button" className="rf-frame-primary" disabled={busy || paused || (snapshot.consumables === 0n && !canBuy)}
            onClick={startRun}>
            {snapshot.consumables > 0n ? "Light a torch and descend" : `Buy a torch and descend · ${rf(definition.price)}`}
          </button>}
        <button type="button" onClick={() => openMenu("odds")}>Room odds</button>
      </> : menu === "satchel" ? <>
        <p>Caches are what the ledger settles each torch into. They keep their fixed RF value with no expiry.</p>
        {definition.outcomes.map((outcome, index) => <div className="deeper-item" key={outcome.name}>
          <span><strong>{outcome.name}</strong><small>{snapshot.inventory[index].toString()} held · {rf(outcome.reward)} · {outcome.chanceBps / 100}%</small></span>
          <button type="button" disabled={busy || paused || snapshot.inventory[index] === 0n || outcome.reward === 0n}
            onClick={() => void act(() => client.redeem(index + 1, 1n), "reward")}>Sell one</button>
        </div>)}
      </> : menu === "odds" ? <>
        {oddsTable}
        <p>Pot tier follows <b>loot</b> rooms, not depth: an empty room takes you deeper without growing the pot.</p>
        <p>Optimal stopping pays <b>0.906 RF</b> per {rf(definition.price)} torch — a 9.4% house edge. Runs bust 55.4% of the time.</p>
      </> : menu === "verify" && verifyTarget ? <>
        <p>{FAIRNESS.note}</p>
        <p className="deeper-note"><code>{FAIRNESS.roomDraw}</code></p>
        <p className="deeper-note"><code>{FAIRNESS.roomOrder}</code></p>
        <dl className="deeper-proof">
          <dt>Commitment</dt><dd>sha256(nonce) = {"commitment" in verifyTarget ? verifyTarget.commitment : sha256Hex(verifyTarget.nonce)}</dd>
          <dt>Nonce</dt><dd>{verifyTarget.nonce}</dd>
          <dt>Play ID</dt><dd>{verifyTarget.playId.toString()}</dd>
        </dl>
        <table className="deeper-table">
          <thead><tr><th>Room</th><th>sha256(nonce:playId:depth)</th><th>Roll</th><th>Result</th></tr></thead>
          <tbody>{verifyTarget.rooms.map(room => <tr key={room.depth}>
            <td>{room.depth}</td><td className="deeper-hash">{room.draw.hash.slice(0, 16)}…</td>
            <td>{room.draw.roll}</td><td>{room.kind}</td>
          </tr>)}</tbody>
        </table>
      </> : menu === "runs" ? <>
        <p>Best depth <b>{bestDepth || "—"}</b> · best bank <b>{rf(bestPot)}</b> · banked this session <b>{rf(bankedTotal)}</b> over {history.length} runs.</p>
        {history.length === 0 ? <p>No runs yet. Buy a torch and take the stairs.</p> : <table className="deeper-table">
          <thead><tr><th>Run</th><th>Depth</th><th>Result</th><th>Ledger settled</th><th /></tr></thead>
          <tbody>{history.map(record => <tr key={record.number}>
            <td>{record.number}</td><td>{record.depth}</td>
            <td>{record.banked ? rf(record.pot) : "busted"}</td>
            <td>{record.settlement ? `${record.settlement.name} · ${rf(record.settlement.reward)}` : "—"}</td>
            <td><button type="button" className="deeper-link" onClick={() => { setVerifying(record); setMenu("verify"); }}>Verify</button></td>
          </tr>)}</tbody>
        </table>}
      </> : menu === "ledger" ? <>
        <p>The run is the game: rooms come from a committed Dice draw and the pot is yours the moment you bank.</p>
        <p>The v0.1 SDK settles one <b>fixed</b> reward per torch, chosen by its own weighted draw. It has no action
          that says &ldquo;pay the pot at the depth this player stopped&rdquo;, so a payout that depends on your
          stop-depth cannot be expressed on-chain yet.</p>
        <p>So this prototype runs both, honestly and side by side. Real through the SDK client: the {rf(definition.price)} torch
          purchase, the torch burn, the {rf(maxPrize)} prize reserve, the per-run settlement and cache redemption.
          Simulated at the game layer: the banked pot.</p>
        <p>They agree in expectation — the published table pays <b>0.912 RF</b> per torch and optimal stopping banks
          <b>0.906 RF</b> — so a session&rsquo;s banked total and satchel value converge. Closing the gap needs a
          contract action such as <code>bank(playId, tier)</code>; that is the first item for the on-chain phase.</p>
      </> : menu === "settings" ? <>
        <button type="button" aria-pressed={!muted} onClick={() => {
          const next = !muted;
          setMuted(next);
          sound.current?.setMuted(next);
          if (!next) void sound.current?.unlock();
        }}>{muted ? "Sound off" : "Sound on"}</button>
        <label><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} /> Reduce motion</label>
        <button type="button" onClick={() => openMenu("odds")}>Room odds</button>
        <button type="button" onClick={() => openMenu("runs")}>This session</button>
        <p>All balances, purchases and rewards are simulated. Reloading resets the preview. Wallet connection and
          ownership verification belong to the SDK runtime.</p>
        <button type="button" onClick={() => openMenu("ledger")}>Pot and ledger</button>
        <p className="deeper-note">{LEDGER_NOTE}</p>
      </> : null}
      {feedback}
    </GameMenu>}
  </section>;
}
