# City generation research and design

Research notes behind the multi-stage map generator in `mapgen/` and the explorer app
in `explorer/`. The pipeline order is terrain → hydrology → settlement site → road
network → road geometry and terrain shaping → blocks and lots → buildings → parks,
vegetation and street fixtures. Each stage only consumes the outputs of earlier ones
and is deterministic from the seed, so a stage can be rewritten without reshuffling
the others.

## 1. Terrain heightmap

**Sources.** Red Blob Games "Terrain from noise"; Quilez domain warping; Minecraft 1.18
spline composition (continentalness, erosion, peaks/valleys); Beyer 2015 and Sebastian
Lague droplet erosion; O'Leary "Generating fantasy maps"; Charack and Doran & Parberry
coastline shaping.

**Techniques adopted.**

- Simplex fBm with per-stage seeded permutation tables. The island mask is evaluated on
  domain-warped coordinates with angular lobes so coasts form bays and headlands rather
  than concentric blobs.
- Minecraft-style composition: an **erosion** field marks flat lowland (urban plateau
  at 6–26 m) versus hilly land; a **ridged** peaks/valleys field only contributes where
  the land is hilly. Hills reach ~170 m across a 3 km island.
- Sea level is the height **quantile** that yields the requested land fraction (44 %),
  then shifted to zero. This keeps every seed roughly the same size.
- Thermal erosion (talus angle) then particle hydraulic erosion (Lague defaults with a
  higher sediment capacity so valley floors flatten). Droplets stop at the sea.
- Only the largest landmass survives; islets become shallow water.
- Coast pass: gentle shores (< 9 % slope) become beaches with a sea shelf, steep shores
  stay cliffs.

**Pitfalls recorded.** Masking every octave gives a circular coast; mask only the
low-frequency shape. Erosion before the mask carves channels off the map edge. Plateau
clamps with zero slope kill drainage, so a residual slope is always kept.

## 2. Hydrology

**Sources.** Barnes, Lehman & Mulla 2014 priority-flood; Barnes flat resolution; Azgaar
river systems and confluences; Scott Turner's meander notes; Génevaux 2013; Felzenszwalb
& Huttenlocher distance transform.

**Techniques adopted.**

- **Priority-flood with epsilon** seeded from sea cells only, so every land cell has a
  strictly descending path to the sea. Fill depth > 2.5 m over ≥ 14 cells becomes a
  lake; shallower fills just correct the DEM.
- **D8 flow direction** and accumulation in height order with index tie-breaks for
  determinism. River cells are those above 1.1 % of the land cell count.
- Rivers are traced from sources downstream; the trunk is traced first so tributaries
  stop at the confluence. Width follows hydraulic geometry (∝ √flux, 4–30 m).
- Channels are **carved** with a parabolic cross-section and a monotone bed (each step
  at least 3 cm lower), then the DEM is filled again so later stages see valid drainage.
- Exact Euclidean distance transforms to water and to the coast feed every later stage
  (setbacks, bridges, desirability, vegetation moisture).

## 3. Settlement site and zoning

**Sources.** Burgess concentric, Hoyt sector and Harris–Ullman multiple-nuclei models;
Lechner 2003 agent-based land use; Weber 2009.

A **desirability** raster multiplies flatness, low elevation, closeness to water (but
≥ 14 m away), closeness to the coast, distance from the map edge and noise. The city
centre is the maximum of desirability integrated over a ~220 m radius, which lands the
core on a flat coastal plain beside the main river mouth. Zoning is a function of
distance to the centre, road class on the block boundary and slope: core → commercial →
residential → suburb, with industrial on flat land away from the centre and park for
blocks that are too small, too steep or on the floodplain.

## 4. Road network

**Sources.** Parish & Müller 2001; Barrett "L-systems considered harmful"; t-mw/citygen
constants; Chen et al. 2008 tensor fields and ProbableTrain's TypeScript map generator;
Kelly & McCabe Citygen; Galin 2010/2011 anisotropic least-cost roads and hierarchical
merging; Watabou's Voronoi towns.

**Comparison.**

| Technique            | Terrain/water               | Hierarchy         | Style control    | Graph quality              |
| -------------------- | --------------------------- | ----------------- | ---------------- | -------------------------- |
| Parish–Müller growth | via local constraints       | highway/street    | pattern maps     | needs snap rules + cleanup |
| Tensor streamlines   | boundary + contour fields   | by separation     | excellent blends | clean ~90° junctions       |
| Citygen sampling     | even-elevation strategy     | primary/secondary | per cell         | good snapping              |
| Galin least-cost A*  | best: grade, water, bridges | 3 levels, merge   | density only     | smooth, no duplicates      |
| Voronoi (Watabou)    | none                        | flat              | organic only     | clean by construction      |

**Hybrid adopted.**

1. **Arterials** (highway/avenue) are routed with grid A* over an anisotropic cost:
   `1 + 8·(grade/maxGrade)² + water/bridge terms + pull toward desirable land +
penalty near existing arterials`. A 16-direction neighbourhood mask avoids the
   8-connectivity zig-zag. Max grade 6 % for highways, 9 % for avenues. Water cells
   are only crossable as bridges up to a maximum span, with a strong per-metre cost so
   bridges concentrate at a few sites. Each new route is merged into existing arterials
   when it comes within a threshold (Galin 2011), which prevents parallel duplicates.
2. Anchors: the centre, secondary nuclei on the best remaining desirable patches, coast
   points and a ring; the connection set is a relative-neighbourhood graph under the
   routed cost so the result is radials plus a ring rather than a Delaunay mess.
3. **Streets** are hyperstreamlines of a tensor field: a grid basis at the core, a
   radial basis around the centre, arterial polylines and the coast/rivers as boundary
   fields (streets run parallel to them), and a contour field weighted by slope so
   hills get terraces. Organic districts add rotational noise. Major streets are traced
   first with a large separation; minor streets fill in with a smaller one. Tracing
   stops at water, steep slopes (> 15 %), existing roads within the test distance and
   the desirability threshold.
4. **Snapping** follows t-mw/citygen priority: true intersection → endpoint snap →
   body snap, one winning action, minimum intersection angle 28°.
5. **Cleanup** order: snap endpoints to nodes, snap to edge bodies, planar split (bridges
   exempt), remove short edges, prune short dangling stubs, cap node degree, keep the
   largest component, simplify degree-2 chains.

## 5. Road geometry and terrain conformance

**Sources.** StreetGen (arXiv 1801.05741); Darwiche & Nyström junction thesis; Cities:
Skylines node/segment split; EasyRoads3D and Unreal landscape spline terrain controls;
Bohemia Terrain Processor road integration; three-roads; Catlike Coding splines;
Sebastian Lague Path-Creator; Babylon ribbons.

**Technique adopted: explicit junction polygons with fillets.** Centrelines are first
simplified (Douglas–Peucker) and splined (centripetal Catmull–Rom, 4 m samples, end
tangents along the end chords) so curves are smooth and arms enter junctions straight.
At each node the incident arms are sorted by departing angle. For each adjacent pair
the left edge line of one road meets the right edge line of the next at a corner; the
corner is replaced by a circular curb fillet (radius by road class, tangent length
capped) and both arms are trimmed back to their tangent points, so bands and the
junction ring share edges exactly. Straight-through pairs at T-junctions keep a
continuous outer edge, acute pairs get a clamped bevel, dead ends get a turning circle,
and gentle degree-2 bends are left to the band mitres. The graph cleanup merges
junction nodes closer than 1.3 road widths (capping the merged degree at four) and
prunes arms meeting under 34°. Sidewalk pieces (band strips, fillet corners, outer
edges) and markings (double yellow centre lines on four-lane roads, dashed lane lines,
edge lines, zebra crossings with stop lines on the incoming half at junction arms) are
generated as polygons once and drawn by both the 2D map and the 3D view, where
sidewalks are raised slabs with curb faces.

**Terrain conformance.** The longitudinal profile is sampled every few metres, low-pass
filtered, grade-limited from both ends (balanced cut and fill) and pinned at nodes so
every arm of a junction shares one height. Cross-slope is zero. The corridor is
**stamped** into the heightmap with three bands (flat, smoothstep bank whose width
grows with cut/fill depth, untouched), accumulating weighted targets so overlapping
roads near junctions do not fight. Spans with fill above a threshold or over water
become bridges and are not stamped except at their abutments. The shaped heightmap is
what later stages and, eventually, the game should use.

## 6. Blocks, lots and buildings

**Sources.** cp-algorithms planar faces; Shapely polygonize; ProbableTrain
`polygon_finder`; Parish & Müller lot subdivision; Vanegas et al. 2012 parcels; Citygen
concave subdivision; Shamus Young and Martin Evans on footprints.

- **Faces** come from a half-edge walk: outgoing edges sorted by angle with a cross
  product comparator; walk "next counter-clockwise edge after the reversed incoming
  edge"; drop the outer face by sign of area. Dangling edges appear twice in a ring and
  are removed as spikes.
- Blocks are **inset** by half road width plus sidewalk per edge; blocks under 150 m²
  or over 400 m long axis become verges or countryside.
- **Lots** use recursive oriented-bounding-box splits perpendicular to the longest axis
  at 0.5 ± jitter, stopping below a zone-dependent area, rejecting slivers and lots
  without street frontage (retry on the other axis, else merge).
- **Footprints** are street-aligned rectangles inside the setback polygon with a
  zone-dependent coverage; height = base(zone) × f(distance to centre) × lognormal
  noise; a few landmark towers in the core. Lots steeper than 25 % are terraced onto a
  flat pad, steeper than 40 % become woodland.

## 7. Vegetation and fixtures

**Sources.** Bridson Poisson disc; Niese et al. "Procedural urban forestry"; WorldBrush;
Unreal City Sample PCG.

Variable-radius Poisson-disc sampling with suitability from slope, moisture (distance
to water), distance to roads and buildings, and land use; species by elevation and
moisture (palms on sand, oaks on lowland, pines on upper slopes). Street trees sit on
the sidewalk offset with a per-street spacing; lamps every 30–45 m staggered per side,
skipping the junction approaches; signals where two arterials meet.

## 8. Integration plan for the game

The new pipeline lives outside `shared/` until it replaces the v4 artifact. Integration
steps, in order:

1. Artifact version 5 with the shaped heightmap at 8 m, polyline roads with heights and
   bridge flags, junction polygons, building pads, parks and trees.
2. Server collision and navigation consume polylines (lane centres) instead of straight
   segments; terrain sampling switches to the finer grid.
3. Client road meshes become ribbons plus junction fans built from the same polygons,
   batched per chunk, with markings as separate strips.
4. The current seed-713 tests move to fixtures generated by the new pipeline.
