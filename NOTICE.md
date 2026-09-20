# Asset notices

No third-party artwork, audio or fonts are bundled in this submission.

| Asset | Source | Notes |
|---|---|---|
| Cavern ledge terrain and props | `@rarefriends/friendsdk/world` | The SDK's own renderer and prop set. The scene geometry in `game/world.ts` is original to this game. |
| Dungeon room art | Original | Inline SVG generated in `game/descent.tsx`; silhouettes are seeded from each room's committed draw. |
| Curio icons | Original | Hand-authored one-bit 16 x 16 masks in `game/item-art.ts`, painted by the SDK's own `ItemArt`. |
| Rare Friend sprites | SDK pinned canonical artwork deployment, read through `@rarefriends/friendsdk/sprites` | Never rotated, non-integrally scaled, recoloured or replaced. |
| Sound cues | `@rarefriends/friendsdk/sounds` | The SDK's ten-cue kit; see the SDK's own `SOUND_KIT.md` and `NOTICE.md`. |
| Sample sprite frames used by the browser check | `@rarefriends/friendsdk` (`examples/fishing/sample-sprites.ts`) | Read from `node_modules` at check time; test fixture only, never shipped to players. |
| `scripts/fixture.mjs` | Copied from the SDK's `scripts/browser-fixture.mjs` (v0.1.2, upstream `762d6f5`, Apache-2.0) | Automated wallet/RPC fixture so this project can run the SDK's own browser check without an SDK checkout. Its `assertBounds` is this project's own, holding the frame to 3:2. |

The SDK itself is installed from its published release archive
[`rarefriends-friendsdk-0.1.2.tgz`](https://github.com/spokesz/friendsdk/releases/tag/v0.1.2)
(FriendSDK v0.1.2, upstream `762d6f5`). Its source is Apache-2.0; SDK-supplied Rare Friends artwork
may be used, modified and distributed under the SDK's own `NOTICE.md`, which v0.1.2 broadened to
cover finished and commercial projects.

Typefaces are the platform monospace stack (`ui-monospace`); nothing is downloaded at runtime.
