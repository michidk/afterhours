# Street geometry audit, 19 October 2026

Seed 713 streets were photographed from above and at an angle, before and after the fixes below. The photos are rendered offline from the baked vertex buffers that the game streams (`scripts/street-photos.ts`, sites in [sites.json](screenshots/street-audit-2026-10-19/sites.json)). They use flat sun shading, with no shadows, sea or dynamic entities. The shared browser could not stream and render the whole map fast enough for a full review.

## Defects found

- **Cracks and fins in sloped streets.** Bands, kerb-side sidewalks and solid lines were cut into pieces up to 16 m long. Ear clipping split those sloped pieces into long chord triangles that cut across the height profile. That left near-vertical fins, wedges at junction mouths and half-buried crosswalks. The racetrack used the same 9-sample pieces. Before the fix, 904 asphalt and 3,095 sidewalk triangles sloped more than 25 %.
- **Streets floating over falling ground.** The street fit only lowered the 8 m terrain grid. Where the ground fell away beside a street, the street edge stood up to 3.95 m above it. A 1.2 m curb skirt covered only part of that drop, and bare asphalt edges had no skirt.

## Fixes

- Sloped strips are now one quad per centreline step (`scripts/mapgen-city.ts`, racetrack in `scripts/mapgen-features.ts`). Every polygon with more than four corners is now flat to within 0.11 m. Steep triangles fell to 63 (asphalt) and 198 (sidewalk), mostly on hairpins whose inner edge collapses to one point.
- The street fit also raises the free grid corners beside a street, so the ground lies at most 0.35 m below the surface (`mapgen/streetfit.ts`). Sinking still wins: no terrain rises through a street. Street vertices standing more than 1 m above the ground fell from 778 to 275, and the worst gap from 3.95 m to 2.26 m.
- Every exposed street edge now stands on a concrete wall that reaches 0.4 m below the lowest ground along it (`client/models/surface.ts`). Edges shared by two street polygons get no wall.

The city artifact grew from 2.5 MB to 2.8 MB, and the baked meshes from 21.1 MB to 22.0 MB.

## Photos

| Site                | Before                                                                    | After                                                                    |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Junction mouth, top | [View](screenshots/street-audit-2026-10-19/before/junction-mouth-top.png) | [View](screenshots/street-audit-2026-10-19/after/junction-mouth-top.png) |
| Two junctions, top  | [View](screenshots/street-audit-2026-10-19/before/junction-pair-top.png)  | [View](screenshots/street-audit-2026-10-19/after/junction-pair-top.png)  |
| Hillside, oblique   | [View](screenshots/street-audit-2026-10-19/before/hillside-oblique.png)   | [View](screenshots/street-audit-2026-10-19/after/hillside-oblique.png)   |
| Embankment, oblique | [View](screenshots/street-audit-2026-10-19/before/embankment-oblique.png) | [View](screenshots/street-audit-2026-10-19/after/embankment-oblique.png) |
| Junction, oblique   | [View](screenshots/street-audit-2026-10-19/before/junction-oblique.png)   | [View](screenshots/street-audit-2026-10-19/after/junction-oblique.png)   |
| Beach lane, oblique | [View](screenshots/street-audit-2026-10-19/before/beach-lane-oblique.png) | [View](screenshots/street-audit-2026-10-19/after/beach-lane-oblique.png) |
| Racetrack, oblique  | [View](screenshots/street-audit-2026-10-19/before/racetrack-oblique.png)  | [View](screenshots/street-audit-2026-10-19/after/racetrack-oblique.png)  |
| Downtown, top       | [View](screenshots/street-audit-2026-10-19/before/downtown-top.png)       | [View](screenshots/street-audit-2026-10-19/after/downtown-top.png)       |

Retake them with `npx tsx scripts/street-photos.ts data/city-meshes.msgpack docs/screenshots/street-audit-2026-10-19/sites.json <out-dir>`.

## Remaining

Hairpins tighter than their road's half-width still look faceted: the inner edge meets at one point and the fan of quads around it tilts. Fixing that needs a minimum curve radius when roads are laid out. Physics still follows the terrain, so a player at a street edge can stand up to 0.35 m below the drawn surface, more where the 275 remaining high vertices are.
