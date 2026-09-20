# Asset notices

No third-party artwork, audio or fonts are bundled in this submission.

| Asset | Source | Notes |
|---|---|---|
| Cavern ledge terrain and props | `@rarefriends/friendsdk/world` | The SDK's own renderer and prop set. The scene geometry in `game/world.ts` is original to this game. |
| Dungeon room art | Original | Inline SVG generated in `game/descent.tsx`; silhouettes are seeded from each room's committed draw. |
| Rare Friend sprites | SDK pinned canonical artwork deployment, read through `@rarefriends/friendsdk/sprites` | Never rotated, non-integrally scaled, recoloured or replaced. |
| Sound cues | `@rarefriends/friendsdk/sounds` | The SDK's ten-cue kit; see the SDK's own `SOUND_KIT.md` and `NOTICE.md`. |
| Sample sprite frames used by the browser check | `@rarefriends/friendsdk` (`examples/fishing/sample-sprites.ts`) | Read from `node_modules` at check time; test fixture only, never shipped to players. |
| `scripts/fixture.mjs` | Copied verbatim from the SDK's `scripts/check-runtime-browser.mjs` (v0.1.0, upstream `da4828f`) | Automated wallet/RPC fixture so this project can run the SDK's own browser check without an SDK checkout. |

The SDK itself is installed from <https://github.com/spokesz/friendsdk>, pinned to commit
`da4828f`.

Typefaces are the platform monospace stack (`ui-monospace`); nothing is downloaded at runtime.
