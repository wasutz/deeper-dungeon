import definition from "./game.json" with { type: "json" };
import { drawRoom, type RoomDraw } from "./fairness.js";

const tuning = definition.deeper;

const POT_LADDER: readonly bigint[] = tuning.potLadder.map(BigInt);

export const MAX_DEPTH = tuning.maxDepth;
export const ROOMS = tuning.rooms;
export const FAIRNESS = tuning.fairness;
export const LEDGER_NOTE = tuning.ledgerNote;

export type RoomKind = "loot" | "empty" | "trap";
export type Room = Readonly<{ depth: number; kind: RoomKind; tier: number; draw: RoomDraw }>;

/** Pot for a loot tier. Tier 0 is an empty pack; tier N is the Nth cache on the ladder. */
export const potFor = (tier: number): bigint => (tier <= 0 ? 0n : POT_LADDER[Math.min(tier, MAX_DEPTH) - 1]);

/** Resolve one room from its committed draw. Boundaries match game.json's roomOrder. */
export function enterRoom(nonce: string, playId: bigint, depth: number, tier: number): Room {
  const draw = drawRoom(nonce, playId, depth);
  const room = ROOMS[depth - 1];
  const kind: RoomKind = draw.roll < room.trapBps ? "trap"
    : draw.roll < room.trapBps + room.lootBps ? "loot" : "empty";
  return { depth, kind, tier: kind === "loot" ? Math.min(tier + 1, MAX_DEPTH) : tier, draw };
}

/** Four bands of cavern, so the art and the dread both escalate with depth. */
export const bandFor = (depth: number) => depth <= 2 ? 0 : depth <= 5 ? 1 : depth <= 8 ? 2 : 3;
export const BAND_NAMES = ["Mossy shafts", "Boneworks", "Emberdeep", "The Hollow"] as const;
