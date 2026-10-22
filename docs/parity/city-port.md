# Native city stages and oracle parity

The city branch ports the complete blocks, buildings, pad stamping, parks,
vegetation, feature placement, map-to-city conversion, terrain fitting, street
surface clipping/welding, and version 7 packing code. It does not merge the
separate terrain or roads branches.

## Reference and comparison

The oracle is Node.js v26.11.1, V8 14.6.202.34-node.37, running the current
TypeScript through `node --import tsx scripts/mapgen-dump.ts`. Node's seed 713
artifact equals checked-in `data/city.json` in every JSON field. The active
`node_seed_713_oracle_matches_checked_in_artifact` test checks this relationship.
Bun's JavaScriptCore produces different street-surface bytes, so invoking the
TypeScript directly under Bun is not the reference for these tests.

Every stage test loads that stage's TypeScript input before mutation. It invokes
the Rust stage and compares the entire output recursively, including array order,
object keys, optional fields, integer values and strings. The helper requires
exact numeric equality, reports the first differing path and prints the maximum
absolute and relative numeric deltas. It does not use the comparator's optional
1e-9 float tolerance. JSON normalizes negative zero, and this comparison targets
JSON output rather than the internal sign bit of zero.

Both seeds 713 and 42 have these measured maximum absolute and relative deltas:

| Output                                   | Seed 713 abs / relative | Seed 42 abs / relative |
| ---------------------------------------- | ----------------------- | ---------------------- |
| Blocks and lots                          | 0 / 0                   | 0 / 0                  |
| Building placements                      | 0 / 0                   | 0 / 0                  |
| Terrain after pad stamping               | 0 / 0                   | 0 / 0                  |
| Parks                                    | 0 / 0                   | 0 / 0                  |
| Trees and lamps                          | 0 / 0                   | 0 / 0                  |
| Town hall context and return value       | 0 / 0                   | 0 / 0                  |
| Airport dressing, both airports          | 0 / 0                   | 0 / 0                  |
| Racetrack context and return value       | 0 / 0                   | 0 / 0                  |
| Harbour context and return value         | 0 / 0                   | 0 / 0                  |
| Terrain after street fitting             | 0 / 0                   | 0 / 0                  |
| Complete city from the TS map            | 0 / 0                   | 0 / 0                  |
| Complete packed artifact from the TS map | 0 / 0                   | 0 / 0                  |
| Packing independently from the TS city   | 0 / 0                   | 0 / 0                  |

These checks establish exact output given oracle inputs. They do not establish
that the unmerged native stages form an exact full pipeline.

## Floating-point details

Platform `sin`, `cos`, `atan2` and `hypot` can differ from V8 by one ULP.
Oriented-box area comparisons use strict `<`; one ULP can change the chosen edge,
then change recursive lot splits and later RNG consumption. Adding epsilon ties
would change the TypeScript algorithm and was rejected.

The port instead uses the V8 fdlibm trigonometric routines and the two-argument
V8 `Math.hypot` scaling/evaluation order. It preserves f64 expression order and
f32 assignments where TypeScript writes a Float32Array. JSON parsing enables
serde_json's `float_roundtrip`, since an imprecisely parsed input also changes
strict ties. JavaScript rounding uses ties toward positive infinity. No residual
float difference is waived for the measured outputs.

The vendored C++20 translation unit runs natively. It does not invoke JavaScript.
[The provenance record](../../crates/mapgen/licenses/V8-SOURCE.txt) includes the
upstream URL, original and adapted SHA-256 hashes, and a complete adaptation patch.
The compiler must support `-ffp-contract=off`; unsupported compilers fail the build.

## Reproduce

Install the locked TypeScript dependencies with `bun install --frozen-lockfile`
and make Node and Cargo available. Then run:

```sh
export PATH=$HOME/.cargo/bin:$PATH
cargo fmt --all -- --check
cargo clippy -p afterhours-mapgen --all-targets -- -D warnings
cargo test -p afterhours-mapgen -- --nocapture
bun run build
```

The tests generate both seeds' TS dumps automatically. To reuse oracle dumps:

```sh
node --import tsx scripts/mapgen-dump.ts --seed 713 --out /tmp/city-parity/713
node --import tsx scripts/mapgen-dump.ts --seed 42 --out /tmp/city-parity/42
MAPGEN_DUMP_ROOT=/tmp/city-parity cargo test -p afterhours-mapgen -- --nocapture
```

The supported app build generates the physics wasm bindings before running the
TypeScript check. A standalone `tsc --noEmit` fails if those bindings are absent.

## Final merge boundary

`generate_map(options, progress)` follows `mapgen/pipeline.ts`, including hydrology
mutation, derived RNG streams, road progress callbacks, road profile/stamping order,
pad protection and street fitting before vegetation. `pipeline::stages` contains
explicitly failing adapters for the external terrain and roads stages. Replace
those adapters with the merged functions and their default arguments, then set
`NATIVE_STAGES_AVAILABLE` to true. The CLI currently exits with a missing-integration
error and creates no artifact.

After integration, run the ignored test. It invokes the native CLI and compares
every field of the written version 7 artifact with checked-in `data/city.json`:

```sh
cargo test -p afterhours-mapgen --test city_artifact -- --ignored --nocapture
cargo run --release -p afterhours-mapgen --bin generate-city -- --seed 713 --out /tmp/city.json
```

The existing server preparation path is unchanged. Replacing it and baking meshes
are separate Phase 3 integration work.
