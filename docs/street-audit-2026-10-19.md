# Street geometry audit, 19 October 2026

Seed 713 streets were photographed from above and at an angle, before (the artifact at the start of the day) and after the fixes below. The photos are rendered offline from the baked vertex buffers that the game streams (`scripts/street-photos.ts`, sites in [sites.json](screenshots/street-audit-2026-10-19/sites.json)). They use flat sun shading, with no shadows, sea or dynamic entities. The shared browser could not stream and render the whole map fast enough for a full review.

## Defects found

- **Cracks and fins in sloped streets.** Bands, kerb-side sidewalks and solid lines were cut into pieces up to 16 m long. Ear clipping split those sloped pieces into long chord triangles that cut across the height profile. That left near-vertical fins, wedges at junction mouths and half-buried crosswalks. The racetrack used the same 9-sample pieces. Before the fix, 904 asphalt and 3,095 sidewalk triangles sloped more than 25 %.
- **Streets floating over falling ground.** The street fit only lowered the 8 m terrain grid. Where the ground fell away beside a street, the street edge stood up to 3.95 m above it. A 1.2 m curb skirt covered only part of that drop, and bare asphalt edges had no skirt.

## Fixes

- Sloped strips are now one quad per centreline step (`scripts/mapgen-city.ts`, racetrack in `scripts/mapgen-features.ts`). Every polygon with more than four corners is now flat to within 0.11 m. Steep triangles fell to 63 (asphalt) and 198 (sidewalk), mostly on hairpins whose inner edge collapses to one point.
- The street fit also raises the free grid corners beside a street, so the ground lies at most 0.35 m below the surface (`mapgen/streetfit.ts`). Sinking still wins: no terrain rises through a street. Street vertices standing more than 1 m above the ground fell from 778 to 275, and the worst gap from 3.95 m to 2.26 m.
- Every exposed street edge now stands on a concrete wall that reaches 0.4 m below the lowest ground along it (`client/models/surface.ts`). Edges shared by two street polygons get no wall.

### Follow-up: streets draped on the terrain

Physics follows the terrain, so after the first pass a player at a street edge could still stand up to 0.35 m below the drawn surface. Hairpins tighter than their road's half-width also looked faceted, because the inner edge met at one point. Street generation now drapes the network's asphalt, sidewalks and markings onto the finished terrain (`drapeOnTerrain` in `mapgen/streetfit.ts`). Each polygon is cut along the terrain mesh's triangles. Coplanar pieces within a triangle are merged, and every corner takes the terrain height. The street fit still shapes the grid to each street's profile first, so draped streets keep their grades.

- Every street-network corner, and every interior sample, lies within 1 cm of the terrain. The few corners off the terrain are all in plazas, quays, airfields and the racetrack, which keep their own levels.
- There are no height steps between pieces and no T-junctions in the sidewalks. A corner on another piece's edge is added to that edge. Of 26 asphalt T-junctions, 24 are in the airport's own tiles, compared with 39 asphalt and 157 sidewalk T-junctions before. Paved area matches the undraped streets to within 2 m² of 628,000 m².
- People and vehicles now move on the drawn surface. Asphalt is drawn 0.1 m above the ground and sidewalks a 0.15 m kerb higher, the same everywhere. The hairpin fans are gone.
- The concrete walls remain for curb faces and for feature surfaces.

The city artifact grew from 2.5 MB to 4.2 MB over both passes, and the baked meshes from 21.1 MB to 26.9 MB.

### Follow-up: sidewalks across roads, and hairline cracks

A sweep of the whole island (16 overview tiles, then 24 random street sites and 36 junctions) found two more defects.

- **Sidewalks lying on asphalt.** At acute merges, the sidewalk strips of a side street ran across the main road, and junctions had sidewalk stubs poking into the asphalt. 463 half-metre cells of sidewalk lay on asphalt at the start of the day. While draping, asphalt is now cut out of the sidewalks (the `avoid` argument of `drapeOnTerrain`), and small shards left stranded by the cut are dropped. The count is now 0. A first version of the cut skipped some asphalt triangles because of a separating-axis test that treated a repeated corner as a separating line. A unit test caught that.
- **Hairline cracks in asphalt.** Pieces cut from differently rounded source polygons met a centimetre apart. Corners within 1.5 cm of each other are now welded, and centimetre rounding is the same for every piece. A raster check for gaps then found 2 uncovered half-metre cells citywide, both in the acute merges and neither visible when zoomed to 8 m.

### Follow-up: junction mouths and crosswalks

The stop hook for this audit pointed out that the previous round still listed visible defects. Three of them are now fixed.

- **Bent zebra stripes.** Where two roads leave a junction within 40 degrees of each other, each band's crosswalk cut through its neighbour's. Those arms now get no crosswalk (`SPLIT` in `mapgen/roadgeometry.ts`). A unit test covers both a right-angle junction and a near-coincident pair.
- **Kinks and jogs in sidewalk outlines.** Junction corners were laid out along each road's first 8 m, so a road that was still curving at its mouth missed the corner lines by up to 0.8 m and left a sideways step. Junctions are now laid out four times, each time taking every arm's direction towards where its mouth ended up. Mouths missing their corner line by more than 0.4 m fell from 78 to 7 of 756.
- **Steep sidewalks.** The terrain raise now also acts where less than 30% of a sample's weight sits on free grid corners (down to 15%). Sidewalk area steeper than 35% fell from 570 m² to 395 m² (over 60%: 40 m² to 9 m²); steep asphalt rose from 37 m² to 55 m².

### Follow-up: corridor width, T-junctions

After the coast work the street scans were repeated on the new layout and a fresh sample of 30 sites (18 junctions, 12 mid-road) was photographed.

- **Steep sidewalks.** The flat road corridor reached only 0.25 m past the sidewalk, so on the 8 m terrain grid the nearest outside grid point was already on the bank and the sidewalk tilted with it. The corridor now reaches 4 m past the sidewalk (`stampRoads`). Sidewalk area steeper than 35% fell from 462 m² to 172 m² of 144,636 m² (0.12%), and over 60% from 18 m² to 2 m². A wider corridor (+6 m) cut it further to 133 m² but left the small test map with one building and the seed 932 city without a town hall lot, so it was not kept. The town hall search now relaxes its 5 m unevenness limit to 8 and then 12 m only if no level lot is left; the lot is levelled afterwards anyway.
- **T-junctions.** Corners lying on another piece's edge, and corners 1.5 to 2.5 cm apart, are now closed on the final layers, which include the airport tiles and other feature surfaces that are not draped. Asphalt T-junctions fell from 28 to 0, and sidewalk ones from 4 to 0.
- **Coverage.** There are 0 uncovered half-metre cells, 0 sidewalk cells on asphalt and 0 height steps between pieces.

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
| Hairpin, top        | [View](screenshots/street-audit-2026-10-19/before/hairpin-top.png)        | [View](screenshots/street-audit-2026-10-19/after/hairpin-top.png)        |
| Hairpin, oblique    | [View](screenshots/street-audit-2026-10-19/before/hairpin-oblique.png)    | [View](screenshots/street-audit-2026-10-19/after/hairpin-oblique.png)    |
| Y-merge, top        | [View](screenshots/street-audit-2026-10-19/before/merge-top.png)          | [View](screenshots/street-audit-2026-10-19/after/merge-top.png)          |
| Junction stub, top  | [View](screenshots/street-audit-2026-10-19/before/junction-stub-top.png)  | [View](screenshots/street-audit-2026-10-19/after/junction-stub-top.png)  |

Retake them with `npx tsx scripts/street-photos.ts data/city-meshes.msgpack docs/screenshots/street-audit-2026-10-19/sites.json <out-dir>`.

## Remaining

- A street shorter than its two junction mouths plus a metre was drawn as a straight chord from its midpoint to the far mouth, which left a wedge uncovered beside the junction ring (seed 2741, near 650.75, 87). A band under a metre long now stays between its mouths. Seeds 713 and 2741 have no uncovered surface cell left that is wider than a raster shrink margin.
- 172 m² of sidewalk (0.12%) is still steeper than 35%, where the ground drops sharply beside a street, and 32 m² of asphalt.
- A street's cross-slope follows the 8 m terrain grid. Players stand on the ground, 0.1 m below drawn asphalt and 0.25 m below a sidewalk top.
- A few sidewalk outlines have a small kink where a junction corner has no room for a fillet and keeps a sharp corner.
- Corners that are 3 cm or more apart are not welded. 783 pairs under 3 cm remained before this round's tolerance change; none is a gap.
