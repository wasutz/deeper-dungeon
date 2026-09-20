import definition from "./game.json" with { type: "json" };
import { drawRoom, type RoomDraw } from "./fairness.js";
import { dropFor, holds, ITEM_RULES, spend, type Carried, type ItemId } from "./items.js";

const tuning = definition.deeper;

const POT_LADDER: readonly bigint[] = tuning.potLadder.map(BigInt);
const BPS = 10_000;

export const MAX_DEPTH = tuning.maxDepth;
export const ROOMS = tuning.rooms;
export const FAIRNESS = tuning.fairness;
export const LEDGER_NOTE = tuning.ledgerNote;

export type RoomKind = "loot" | "empty" | "trap";
export type RoomOdds = Readonly<{ depth: number; trapBps: number; lootBps: number; emptyBps: number }>;

/** How the player intends to spend a charge on the room they are about to enter. */
export type Intent = Readonly<{ arm?: boolean; force?: boolean }>;

export type Room = Readonly<{
  depth: number; kind: RoomKind; tier: number; draw: RoomDraw;
  /** What the committed draw said before any item bent it. Equal to `kind` on an untouched room. */
  natural: RoomKind;
  used: readonly ItemId[];
  reroll: RoomDraw | null;
  drop: ItemId | null;
}>;

/**
 * Room weights as this loadout sees them. Only the Greed Idol moves them: its trap shift comes out
 * of loot and empty in proportion.
 *
 * Empty takes whatever is left rather than being rounded on its own. Rounding both shares
 * independently totals 10000 bps only by arithmetic luck — it holds at the committed shift and
 * breaks at more than half of the other values it could be tuned to.
 */
export function oddsFor(depth: number, carried: Carried): RoomOdds {
  const room = ROOMS[depth - 1];
  if (!holds(carried, "greed-idol")) return room;
  const shift = ITEM_RULES.greedTrapShiftBps;
  const spare = room.lootBps + room.emptyBps;
  const trapBps = room.trapBps + shift;
  const lootBps = room.lootBps - Math.round((room.lootBps / spare) * shift);
  return { depth: room.depth, trapBps, lootBps, emptyBps: BPS - trapBps - lootBps };
}

/** Tiers gained per loot room. The Greed Idol is the only way to climb two at a time. */
export const tierStep = (carried: Carried) => (holds(carried, "greed-idol") ? 2 : 1);

/** Pot for a loot tier. Tier 0 is an empty pack; the Loot Sack pays one rung higher. */
export function potFor(tier: number, carried: Carried = []): bigint {
  if (tier <= 0) return 0n;
  const rung = holds(carried, "loot-sack") ? tier + 1 : tier;
  return POT_LADDER[Math.min(rung, POT_LADDER.length) - 1];
}

/** What an Escape Rope rescues from a sprung trap. */
export const ropeShare = (pot: bigint) => (pot * BigInt(ITEM_RULES.ropeShareBps)) / BigInt(BPS);

/**
 * What an empty room leaves behind, on two tagged draws of its own: one decides whether, one
 * decides which. Only a room that drew EMPTY and stayed EMPTY yields anything — a Ward that turns
 * a trap aside got you past it, and paying it a curio too would put value in the Ward that its
 * price never charged for.
 */
function dropFrom(
  nonce: string, playId: bigint, depth: number, kind: RoomKind, natural: RoomKind, prefix: string,
): ItemId | null {
  if (kind !== "empty" || natural !== "empty") return null;
  const gate = drawRoom(nonce, playId, depth, `${prefix}drop`);
  if (gate.roll >= ITEM_RULES.dropChanceBps) return null;
  return dropFor(drawRoom(nonce, playId, depth, `${prefix}drop-item`));
}

const classify = (roll: number, odds: RoomOdds): RoomKind =>
  roll < odds.trapBps ? "trap" : roll < odds.trapBps + odds.lootBps ? "loot" : "empty";

/** The committed result of the room below, without entering it. The Lantern buys this. */
export function peekRoom(nonce: string, playId: bigint, depth: number, carried: Carried): RoomKind {
  return classify(drawRoom(nonce, playId, depth).roll, oddsFor(depth, carried));
}

/**
 * Resolve one room from its committed draw. Items may override the result, never the draw: the
 * roll and its preimage are recorded either way so the Verify panel can show what was replaced.
 */
export function enterRoom(
  nonce: string, playId: bigint, depth: number, tier: number,
  carried: Carried = [], intent: Intent = {},
): Room {
  const draw = drawRoom(nonce, playId, depth);
  const natural = classify(draw.roll, oddsFor(depth, carried));
  const used: ItemId[] = [];

  let kind = natural;
  if (intent.force && holds(carried, "divining-rod")) { kind = "loot"; used.push("divining-rod"); }
  else if (intent.arm && holds(carried, "ward")) {
    used.push("ward");
    if (natural === "trap") kind = "empty";
  }

  const drop = dropFrom(nonce, playId, depth, kind, natural, "");
  const step = tierStep(carried);
  return {
    depth, kind, draw, natural, used, reroll: null, drop,
    tier: kind === "loot" ? Math.min(tier + step, MAX_DEPTH) : tier,
  };
}

/**
 * Spend a Lucky Charm on a sprung trap. The reroll is its own committed draw at the same depth,
 * so it is recomputable from the same nonce and cannot be the room roll again.
 */
export function rerollRoom(room: Room, nonce: string, playId: bigint, tier: number, carried: Carried): Room {
  const reroll = drawRoom(nonce, playId, room.depth, "reroll");
  const kind = classify(reroll.roll, oddsFor(room.depth, carried));
  const after = spend(carried, "lucky-charm");
  return {
    ...room, kind, reroll, used: [...room.used, "lucky-charm"],
    drop: dropFrom(nonce, playId, room.depth, kind, kind, "reroll-"),
    tier: kind === "loot" ? Math.min(tier + tierStep(after), MAX_DEPTH) : tier,
  };
}

/** Four bands of cavern, so the art and the dread both escalate with depth. */
export const bandFor = (depth: number) => depth <= 2 ? 0 : depth <= 5 ? 1 : depth <= 8 ? 2 : 3;
export const BAND_NAMES = ["Mossy shafts", "Boneworks", "Emberdeep", "The Hollow"] as const;
