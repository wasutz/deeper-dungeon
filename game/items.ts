import definition from "./game.json" with { type: "json" };
import type { RoomDraw } from "./fairness.js";
import { ITEM_ART } from "./item-art.js";

const tuning = definition.deeper;

export type ItemId =
  | "ward" | "escape-rope" | "lantern" | "divining-rod" | "greed-idol" | "loot-sack" | "lucky-charm";

export type Item = Readonly<{
  id: ItemId; name: string; category: string; effect: string; summary: string;
  price: bigint; slots: number; dropWeightBps: number;
  /** Shaped as the SDK's `GameItem` so its own `ItemArt` can render the mask. */
  art: Readonly<{ rows: readonly string[] }>;
}>;

export const ITEMS: readonly Item[] = tuning.items.map(item => ({
  id: item.id as ItemId,
  name: item.name,
  category: item.category,
  effect: item.effect,
  summary: item.summary,
  price: BigInt(item.price18),
  slots: item.slots,
  dropWeightBps: item.dropWeightBps,
  art: { rows: ITEM_ART[item.id as ItemId] },
}));

export const ITEM_RULES = tuning.itemRules;
export const CARRY_CAP = tuning.itemRules.carryCap;

const BY_ID = new Map(ITEMS.map(item => [item.id, item]));
export const itemFor = (id: ItemId): Item => BY_ID.get(id)!;

/** What the player is still holding. Spent charges leave; the two run-long items never do. */
export type Carried = readonly ItemId[];

export const holds = (carried: Carried, id: ItemId) => carried.includes(id);
export const spend = (carried: Carried, id: ItemId): Carried => {
  const index = carried.indexOf(id);
  return index < 0 ? carried : [...carried.slice(0, index), ...carried.slice(index + 1)];
};

export const slotsUsed = (carried: Carried) =>
  carried.reduce((total, id) => total + itemFor(id).slots, 0);

/** A loadout is legal while it fits the cap and holds no duplicates. */
export const canCarry = (carried: Carried, id: ItemId) =>
  !holds(carried, id) && slotsUsed(carried) + itemFor(id).slots <= CARRY_CAP;

/**
 * What actually goes down the stairs. The picker remembers a choice across runs, so by the time a
 * run starts the satchel may no longer hold part of it — and a choice made while a slot looked
 * free can stop fitting once the missing piece is replaced. Folding under the cap here, rather
 * than filtering, keeps that from ever putting three slots of curio into a two-slot run.
 */
export const kitFor = (chosen: Carried, inStock: (id: ItemId) => number): Carried =>
  chosen.reduce<ItemId[]>((kit, id) => (inStock(id) > 0 && canCarry(kit, id) ? [...kit, id] : kit), []);

/**
 * Which item an empty room yields. The weights are inversely proportional to price, so a drop is
 * worth the same whichever item it is; the draw is the room's own committed one, tagged so it
 * cannot collide with the roll that made the room empty in the first place.
 */
export function dropFor(draw: RoomDraw): ItemId {
  let boundary = 0;
  for (const item of ITEMS) {
    boundary += item.dropWeightBps;
    if (draw.roll < boundary) return item.id;
  }
  return ITEMS[ITEMS.length - 1].id;
}
