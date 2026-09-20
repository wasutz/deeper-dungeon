import { validateWorld, type WorldPoint } from "@rarefriends/friendsdk/world";
import type { GameWorldInteraction } from "@rarefriends/friendsdk/world-view";

/**
 * A cavern ledge on the 576 x 384 ground plane: the torch vendor's stall on the west side,
 * the staircase mouth on the east. The staircase is a hole in the ground rather than a prop,
 * so the SDK's collision keeps the Friend on the rim and the descent stays an explicit choice.
 */
const STAIRCASE: WorldPoint = [404, 208];
const VENDOR: WorldPoint = [168, 180];

export const SURFACE = validateWorld({
  id: "deeper-cavern-ledge",
  name: "Cavern Ledge",
  family: "deeper",
  setting: "Crystal cavern",
  shape: "Organic ledge",
  summary: "A lantern-lit ledge above the shaft, with a torch vendor's stall and the staircase down.",
  variant: "complete",
  geometry: {
    polygons: [[
      [96, 24], [240, 8], [400, 16], [496, 56], [544, 128], [552, 232],
      [504, 312], [392, 360], [232, 372], [120, 344], [48, 280], [24, 184], [40, 96],
    ]],
    holes: [[[368, 180], [440, 180], [440, 236], [368, 236]]],
    depth: 26,
  },
  props: [
    { type: "crate", x: 168, y: 180, scale: 1.2 },
    { type: "bench", x: 112, y: 214, scale: 0.9 },
    { type: "crystal", x: 84, y: 128, scale: 1.15 },
    { type: "crystal", x: 470, y: 164, scale: 0.8 },
    { type: "crystal", x: 318, y: 266, scale: 1.05 },
    { type: "crystal", x: 250, y: 66, scale: 0.75 },
    { type: "rock", x: 340, y: 160, scale: 1 },
    { type: "rock", x: 468, y: 250, scale: 0.9 },
    { type: "rock", x: 214, y: 318, scale: 1.05 },
    { type: "vent", x: 448, y: 108, scale: 0.85 },
  ],
  actors: [],
  signals: [],
  paths: [{ points: [[150, 206], [244, 240], [330, 226], [358, 212]], width: 24 }],
  patches: [
    { x: 96, y: 60, w: 120, h: 68, pattern: "hatch" },
    { x: 404, y: 268, w: 116, h: 64, pattern: "dither" },
    { x: 180, y: 292, w: 128, h: 56, pattern: "dense" },
    { x: 300, y: 92, w: 108, h: 60, pattern: "grid" },
  ],
});

export const SPAWN: WorldPoint = [244, 252];

export const INTERACTIONS: readonly GameWorldInteraction[] = [
  { id: "vendor", label: "Torch Vendor", position: VENDOR, reach: 84, labelOffset: -168 },
  { id: "staircase", label: "Dungeon Entrance", position: STAIRCASE, reach: 92, labelOffset: -64 },
];
