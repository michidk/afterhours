# Native road-stage parity

`crates/mapgen/src/graph.rs` and `roads.rs` translate the complete algorithms in
`mapgen/graph.ts` and `roads.ts`. Road geometry and street fitting are separate
ports. The parity boundary here is the return from `generateRoads`, before
smoothing, densification, junction layout or profiles mutate the graph.

The port preserves the A* heap's equal-key behavior, direction order, f32 stores
in the cost and tensor grids, stable sort ties, FIFO seed proposals, insertion
order of adjacency sets, rejected insertions' side effects, cleanup pass order,
chain compaction and face traversal order. Internal hash tables are used only
for keyed lookups or membership checks, never to choose output order.

The road stages also require corrected shared foundation operations. Field
samples and slopes promote f32 reads before subtraction. Blur uses the original
sliding sum in f64 and rounds on array writes. The distance transform retains
its intermediate f32 stores and arithmetic grouping. Normalization divides each
component by the length instead of multiplying by its reciprocal.

## Reproduce

```sh
export PATH=$HOME/.cargo/bin:$PATH
export CARGO_TARGET_DIR=/tmp/afterhours-roads-target
cargo test -p afterhours-mapgen --test roads_parity -- --nocapture
cargo fmt -p afterhours-mapgen --check
cargo clippy -p afterhours-mapgen --all-targets -- -D warnings
cargo test -p afterhours-mapgen
```

The isolated Cargo target directory avoids artifacts from concurrently compiling
worktrees being mistaken for this worktree's library. Bun must be available for
the test-only TypeScript oracle. Native code in `src/` never starts a JS runtime.

Each parity test runs the actual TypeScript terrain, erosion, hydrology, site and
road stages through `scripts/mapgen-dump.ts --roads-only`. It loads
`road-inputs.json` into `RoadInputs`, calls native `generate_roads`, then compares
every output value with `roads-generated.json`. This includes node and edge ids,
incidence order, kinds, bridge flags, widths, every polyline coordinate, heights,
and all array lengths. A failure prints the first differing JSON path and leaves
`roads-rust.json` beside the oracle files for inspection.

For repeated local comparisons, generate reusable inputs first:

```sh
bun run scripts/mapgen-dump.ts --roads-only --seed 713 --out /tmp/road-dumps/713
bun run scripts/mapgen-dump.ts --roads-only --seed 42 --out /tmp/road-dumps/42
MAPGEN_ROAD_DUMP_ROOT=/tmp/road-dumps \
  cargo test -p afterhours-mapgen --test roads_parity -- --nocapture
```

The default full dump retains all existing files and adds the raw road input and
output files. Its existing `roads.json` still contains the graph after geometry
and profiles, so it must not be used as the raw road-stage reference.

## Results

Both seeds have zero numeric delta for every field:

- Seed 713 compares 222 nodes, 351 edges and 1,731 polyline points.
- Seed 42 compares 246 nodes, 384 edges and 1,811 polyline points.
- `nodes[].id`, `x`, `z`, `y` and `edges[]`: maximum absolute and relative delta 0.
- `edges[].id`, `a`, `b`, `width`, `points[].x` and `points[].z`: maximum absolute
  and relative delta 0.
- `edges[].kind`, `bridge`, the empty initial `heights[]`, and every array's
  ordering and length match exactly.

There are no unexplained arithmetic or iteration-order differences. The tests
require exact numeric equality, which is stricter than the original 1e-9 relative
target. `serde_json` uses its `float_roundtrip` feature so reading the oracle JSON
preserves each f64; the default parser introduced apparent deltas of at most
2.2737367544323206e-13 that disappear with correctly rounded parsing.
