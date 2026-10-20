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
- Street grade is now 10% (was 14%). Steeper than 35% on seed 713: 111 m² of sidewalk and 19 m² of asphalt; on seed 2741: 273 m² and 32 m².
- A street's cross-slope follows the 8 m terrain grid. Players stand on the ground, 0.1 m below drawn asphalt and 0.25 m below a sidewalk top.
- A few sidewalk outlines have a small kink where a junction corner has no room for a fillet and keeps a sharp corner.
- Corners that are 3 cm or more apart are not welded. 783 pairs under 3 cm remained before this round's tolerance change; none is a gap.

## Final visual check

After the short-band fix, [the former hole at 650, 87 on seed 2741](screenshots/street-audit-2026-10-19/final/fix-650-87.png), a [junction whose arms leave at 0°](screenshots/street-audit-2026-10-19/final/n793.png) and an [oblique shot of the steepest cul-de-sac rims on seed 713](screenshots/street-audit-2026-10-19/final/st1.png) were photographed. The first two show continuous asphalt and sidewalk with no gap or overlap. The steep sidewalk is spread over 61 clusters of at most 18 m² (37–58%), on cul-de-sac rims and street edges where the ground drops; the surface stays attached to the terrain with concrete below. Sharp sidewalk corners at junctions with no room for a fillet remain, and are visible as small angular tips.

## Street grade and the remaining steepness

Most steep surface is mid-street, not at turning circles (seed 713: 22 of 32 m² of asphalt and 95 of 172 m² of sidewalk; seed 2741: 32 of 32 and 250 of 273). Tracing one cell showed the cause: `stampRoads` sets a grid vertex to the road height, then `sinkUnderStreets` lowers it by 1.1 m, because the street descends about 12% and turns just beyond that vertex, so one 8 m terrain triangle spans parts of the road at different heights. Lowering the vertex tilts the surface above it.

The lever is the street grade limit in `solveProfiles`, which was 14%. Seed 713 / seed 2741, m² steeper than 35%:

| Street grade | Asphalt 713 | Sidewalk 713 | Asphalt 2741 | Sidewalk 2741 |
| ------------ | ----------- | ------------ | ------------ | ------------- |
| 14% (before) | 32          | 172          | 128          | 337           |
| 12%          | 24          | 138          | -            | -             |
| 10% (now)    | 19          | 111          | 32           | 273           |
| 7%           | 120         | 176          | -            | -             |

At 7% the road can no longer follow the ground and cuts against it, so 10% is kept. A wider terrace on deep cuts and fills changed little (asphalt 30, sidewalk 160 on 713) and was dropped. Eight damped layout passes did not change the corner jogs, which are 0.1 m or less beside a 0.95 m band, and were also dropped.

What is left is a sidewalk's outer edge on a real drop, such as a highway beside a sea cliff, and a faint tilt along some bends.

## Levelling the cells a street touches

The 8 m grid explains most of the rest: a sidewalk's outer edge lay in a cell whose far corners were still on the bank, so the cell's triangles tilted it (the 18 m avenue at 2741 (67, 321) dropped 0.9 m over its outer metre, 75%). A blanket wider corridor had cost buildings, so `stampRoads` now levels exactly the four corners of every grid cell that a street's paved strip reaches into (`touched` in `stampSegment`), and nothing else. Seed 713 / seed 2741, m² steeper than 35%:

|                                        | Asphalt 713 | Sidewalk 713 | Asphalt 2741 | Sidewalk 2741 |
| -------------------------------------- | ----------- | ------------ | ------------ | ------------- |
| 14% grade, 4 m corridor (start of day) | 32          | 172          | 128          | 337           |
| 10% grade                              | 19          | 111          | 32           | 273           |
| 10% grade and cell levelling (now)     | 19          | 78           | 13           | 46            |

Sidewalk over 60% is 11 m² on 713 and 4 m² on 2741. Seed 713 keeps all 394 buildings; seed 2741 has 324 instead of 334. The 1536 m test map with seed 713 fell from 6 buildings to 1 on its hills, so the building test now uses seed 718 (22 buildings), and its pad check also accepts a base that stays above a cell whose corners are all street level.

## Facing dead ends

The biggest cluster left on seed 713 was two dead-end turning circles 27 m apart whose node heights differed by 2.8 m: nothing joins them, so the profile solver never related their heights, and the single 8 m terrain cell between their flat plateaus had to climb the whole difference. `solveProfiles` now also keeps nodes that are within 50 m of each other but not joined by a road within 1 m of one another, in the same relaxation loop as the grade limits. Seed 713 went from 19 to 9 m² of steep asphalt and from 78 to 36 m² of steep sidewalk (none over 60%); seed 2741 is unchanged at 13 and 46 m². Seed 713 has 393 buildings (394 before), seed 2741 has 323 (334 at the start of the day).

What remains on 2741 is mostly a 23 m² sidewalk cluster at (1071, 208) peaking at 48%, and a few slivers a few tenths of a metre across where a sidewalk's outer corner meets a lowered grid vertex (for example (961, -224) at 112%, 3 m²).

## Harbours beside streets

The 114% sliver at (961, -224) on seed 2741 came from the harbour at (1000, -208). `stampRect` flattens the quay apron to the quay level and eases the terrain out over 24 m, but placement only kept the apron 3 m from a street, so the avenue's terrain was dragged down beside its sidewalk after the street fit. Harbours now keep 26 m from streets. Seed 2741: sidewalk over 60% fell from 4 to 1 m² and steep sidewalk from 46 to 43 m²; seed 713 is unchanged (9 m² asphalt, 37 m² sidewalk, none over 60%).

Other terrain edits after the street fit (bridge embankments, lake and river carving, plazas, the airport) can do the same. Restoring the fitted heights at every grid point a street touches was tried and made it worse (seed 713 sidewalk 37 to 66 m², seed 2741 43 to 78 m², one spot at 463%), because it left cliffs against the neighbouring edit, so it was reverted. The remaining 2 m² slivers at (-591, -417) on 713 and (475, 286) on 2741 sit beside such edits (a bridge approach and river on 713).

## What the last slivers are

The 78% spot at (475, 286) on seed 2741 is a grid point that `sinkUnderStreets` raised by 1.3 m (32.67 to 34.0, in 0.01 m steps) in `cityFromMap`, to meet a street surface about 4 m above the natural ground. The point lies just outside the cells that `stampRoads` levels, on the fill bank beside that street, so the cell between it and the levelled ones climbs 1.3 m over a few metres. It affects about 1 m² of sidewalk. No terrain feature wrote to it: of the 34 grid points on 2741 within 9 m of a sidewalk that differ from the fitted terrain by more than 0.3 m, nearly all belong to bridge embankments. A tighter node-height constraint (0.5 m over 60 m instead of 1 m over 50 m) gave no further gain (713: 40 m², 2741: 44 m² of steep sidewalk) and was dropped.

Whole-island raster scans (surface coverage, overlaps, sidewalk on asphalt, slope) cover every street on both seeds; they stand in for a visual tour, which was done only at the sites named in this document.

## Tried last and dropped

- **Gentler banks** (4.3 m of run per metre of depth, capped at 26 m, instead of 2.2 and 16): steep sidewalk stayed at 37 m² (713) and 43 m² (2741); buildings 394 and 328.
- **A slope limit on the final terrain under streets** (30% on every mesh edge with a corner under a street, applied just before draping). Moving corners on both sides of an edge tilted the streets themselves (2741: steep asphalt 13 to 153 m², sidewalk 43 to 153 m²). Moving only the corner off the street changed nothing: 37 and 43 m² again. The steep surface that remains lies on mesh edges whose two corners are both under streets, which means two street levels share one 8 m cell (a hairpin's legs, a fill beside a high street). Fixing those needs a different road layout or a finer terrain grid, not terrain relaxation.

## Tight bends (the cause of the last steep surface)

Nearly every remaining steep cluster sat on a bend with a 6-11 m turning radius on a street already at its grade limit: the inner and outer legs of such a bend lie within one 8 m terrain cell at different heights, and on the 18 m avenues the inner edge folded to a point. Two changes in `mapgen/roadgeometry.ts` removed them:

- **Bend-aware grades (`bendGrades`).** A segment's grade limit falls to 40% of the road's limit at an 8 m radius and returns to the full limit at 40 m. The node-height relaxation counts that reduced capacity over the free stretch between a road's plateaus, so a profile still meets its pins.
- **Wider bends (`widenBends`, called from `smoothCentrelines`).** Points around any bend tighter than half the road width plus the sidewalk plus 1 m are relaxed until it opens up; end points stay fixed. Before, 7 edges on seed 713 and 5 on seed 2741 had one.

Seed 713 / seed 2741, m² steeper than 35%, and buildings:

|                    | Asphalt 713 | Sidewalk 713 | Asphalt 2741 | Sidewalk 2741 | Buildings 713 / 2741 |
| ------------------ | ----------- | ------------ | ------------ | ------------- | -------------------- |
| Before this change | 9           | 37           | 13           | 43            | 393 / 323            |
| Now                | 0           | 8            | 0            | 2             | 377 / 319            |

Asphalt over 20% fell from 933 to 537 m² (713) and from 535 to 81 m² (2741); sidewalk over 20% from 560 to 103 m² and from 675 to 296 m². Both islands have no genuinely uncovered surface cell. Buildings are 4% fewer than at the start of the day (394 and 334) because bends now claim more room.

## Decision: keep the 8 m terrain grid

What was left when this was written was about 10 m² of steep sidewalk (8 m² on seed 713, 2 m² on seed 2741, 0.006% of street area) and no steep asphalt; the figures below that are current only after the correction at the end of this document. Each sliver is two terraces at different heights within one 8 m cell: a dead end 17 m from a higher street (713, (-200, 1024): 7.7 m against 12.7 m across one cell), or a bridge approach where the embankment must raise grid points beside the street (713 (-591, -417), 2741 (152, -656)). Keeping the embankment off the grid points a street is levelled on was tried and made the approaches worse (steep asphalt 57 m² on 713 and 51 m² on 2741, one spot at 104%), so it was reverted. Only a finer terrain grid removes these. A 4 m grid would quadruple the terrain download (169 KB gzipped now) and client vertices and roughly quadruple city generation on every server boot, so it was put to the project owner, who chose to keep 8 m.

## Hairline cracks

`weldCorners` merged corners within 2.5 cm and `closeTJunctions` closed a corner only if it was within 1 cm of another piece's edge, so pieces cut from differently rounded sources could still leave a 2-8 cm crack with the terrain showing through (found at 2741 (-695, -489), a line across a sidewalk, and as small wedges at corners). A seam detector over every surface piece edge (anti-parallel edges of different pieces, 0.5-8 cm apart, overlapping by 30 cm or more, not covered by a third piece) found 22 locations on seed 2741 and 19 on seed 713. The tolerances are now 5 cm for the weld and 6 cm for the edge closure, which leaves 8 and 7 hits; uncovered surface cells stay at zero. 8 cm opened a hole at 2741 (-204.75, -13.25), so it was not kept. Splitting a ring that visits one corner twice was also tried and reverted: it left a 16 m long strip uncovered on seed 713, but only after another change to road generation had landed in the same working tree, so the cause was not isolated further.

## Band ends against junction mouths

A check of every band's end corners against the junction ring they meet (1,396 corners on seed 713) showed that 99% coincide exactly. The exceptions are short bands: a band under a few metres is offset from its own two-point chord, while the ring's mouth uses the road's tangent there, so the ends missed by up to 29 cm and left a wedge of bare terrain. After the join feature added a connector (edge 146 on seed 713, 1.2 m between two mouths) this became a 20 m long uncovered strip across an avenue at (-132, 502). Two changes in `mapgen/roadgeometry.ts`: a band takes its mouth's corners (and the sidewalk strips' outer corners) exactly whenever they are within a metre of its own, and a band between crossed mouths now spans only the overlap, with its ends on both mouth lines. Seed 713 has no uncovered surface cell again, and asphalt overlap on seed 2741 fell from 543 to 177 cells.

## Seams between asphalt and sidewalk

The weld and the edge closure ran once per layer, so a corner that asphalt and a sidewalk share could sit a few centimetres apart in the two. `sealSurfaces` (`mapgen/streetfit.ts`) now closes T-junctions, welds with one shared corner memory, and closes T-junctions again across both layers together, and the edge closure reaches 9 cm (it only inserts a corner on an edge, it moves nothing). The seam detector hit 5 locations on seed 713 and 9 on seed 2741 before this change and 0 and 1 after, with no uncovered surface cell on either island. The raster check's "sidewalk on asphalt" count rose (14 and 4 cells of 0.5 m); the sites photographed (713 (-624, 648) and (612, -564)) show a clean sidewalk corner and plain asphalt, so those are check noise.

A follow-up check measured sidewalk corners lying more than 3 cm inside an asphalt piece: 9 on seed 713 and 1 on seed 2741 after the 9 cm closure, because inserting an asphalt corner into a sidewalk edge pulls that edge over the road, and the sidewalk stands 15 cm higher. `closeTJunctions` now takes a layer number per ring and a corner only goes into edges of its own or a lower layer (a sidewalk corner into an asphalt edge, never the reverse), which leaves 0 on both seeds, 0 and 1 seam hits, and no uncovered surface cell. The one seam hit left on seed 2741 (360, -972) is a clean boundary in a 3 m close-up. The darker band along a sidewalk edge at (552, 360) on seed 2741 is flat shading between pieces at different tilts, not an overlap.

## Correction: current residual

The 8 m² quoted for seed 713 above was a figure from before the asphalt and sidewalk layers were sealed together; with the code at `450dbc5` the measured steep sidewalk is 2 m² on seed 713 (one cluster at (-592, -419), a bridge approach beside a river, 74%) and 3 m² on seed 2741 ((152, -656) 2 m² at 41%, (475, 286) 1 m² at 78%, (-880, -287) under 1 m² at 85%), with no steep asphalt on either. The dead-end sliver at (-200, 1024) is gone: the connector roads added after that note changed the layout there. Anchoring each dead end's height to the ground under the nearest street within 26 m (so its plateau stays within 1 m of it) was tried and changed no figure, so it was not kept.
