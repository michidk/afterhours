# Terrain colour, 19 October 2026

The ground was three flat bands by height: sand, green, and rock above 90 m. The Craftstead game (`../craftstead`) paints its ground differently. A muted olive base colour is broken up by large, soft organic patches of slightly different greens, scattered patches of bare mud, lighter accent patches, grey stone on rocky ground, and a pale shoreline. Its textures are 8 x 8 tile images laid over the base at about 40% opacity, chosen per block by a hash of the block's position. Ours is a 3D heightmap with one set of vertex colours, so the same look is built from per-vertex colours instead of images (`client/world/terrain-colour.ts`).

## What the colour depends on

- **Patches.** Smooth value noise at three scales drives the grass: a broad lush/dry drift (110 and 45 m), lighter accent patches (30 m), and bare mud patches (36 m). Mud only appears on level ground away from the beach. Ground close to the water is lusher.
- **Beach.** Wet sand, sand and grass blend by height above the waterline, as before.
- **Rock.** Ground steeper than about 0.8 (rise over run) turns grey-brown, and everything above 90 m. The threshold is high so the road banks, which the 8 m grid renders as steep steps, stay green.
- **Palette.** Grass is a warmer, lighter olive than before (`0.50, 0.64, 0.38` lush to `0.66, 0.70, 0.44` dry).

Colours blend across the triangles, so every patch edge is a gradient. A unit test checks that the colours are deterministic and in range, that neighbouring vertices differ by under 0.12, that level grass has many distinct colours, and that beaches are sand and steep ridges are grey. The colours are baked into `data/city-meshes.msgpack` with the rest of the static geometry.

## Photos

The photos are rendered offline from the baked meshes with flat sun shading and a tinted sea, on the same island layout.

| Site            | Before                                                                   | After                                                                   |
| --------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Downtown        | [View](screenshots/terrain-colour-2026-10-19/before/downtown.png)        | [View](screenshots/terrain-colour-2026-10-19/after/downtown.png)        |
| West coast      | [View](screenshots/terrain-colour-2026-10-19/before/west-coast.png)      | [View](screenshots/terrain-colour-2026-10-19/after/west-coast.png)      |
| South spit      | [View](screenshots/terrain-colour-2026-10-19/before/south-spit.png)      | [View](screenshots/terrain-colour-2026-10-19/after/south-spit.png)      |
| Hill and towers | [View](screenshots/terrain-colour-2026-10-19/before/hill-and-towers.png) | [View](screenshots/terrain-colour-2026-10-19/after/hill-and-towers.png) |
| Coastal road    | [View](screenshots/terrain-colour-2026-10-19/before/coastal-road.png)    | [View](screenshots/terrain-colour-2026-10-19/after/coastal-road.png)    |
| Ridge           | [View](screenshots/terrain-colour-2026-10-19/before/ridge.png)           | [View](screenshots/terrain-colour-2026-10-19/after/ridge.png)           |

## Not done

- **Texture detail.** Craftstead's blobs have crisp organic outlines and little grass tufts and flowers. Vertex colours at 8 m spacing can only give soft gradients. Crisp edges and tufts need a terrain texture sampled in the shader, which means a new material role in the baked mesh format and in the loader.
- **Water.** Craftstead's water is a flat soft blue (`#6f9fb7`) with a thin tinted edge. The sea here still uses the existing wave shader and its turquoise.
- **Trees and props.** Their colours were not changed, so some trees look darker than the new ground.
