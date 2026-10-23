# The test world

A small hand-built island for trying things, instead of the generated city. Everything you want to
test is within walking distance of where you spawn, and the AI lives somewhere else.

```sh
TEST_WORLD=1 bun run start      # or: bun run start:test-world
```

`TEST_WORLD=1` serves `data/test-world.json` and its meshes (regenerated on every boot, like the
city; they are not committed). Open the page with `?play` to skip the character screen, for example
`http://localhost:5174/?play&name=Tester`. Without `TEST_WORLD` nothing changes.

## What is where

| Place      | What                                                                                                                                                                                                                               | Where                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Spawn      | the racetrack's start line side, facing the showroom                                                                                                                                                                               | about 50 m from the showroom      |
| SHOWROOM   | 3 cars (sedan, sport, van) in a row, 2 helicopters (scout, utility) behind them, 2 planes (plane, aerobatic) further back with the flat island ahead for a take-off run                                                            | beside the track start            |
| Items      | 13 pads in a row in front of the showroom: every weapon (bat, pistol, smg, knife, machinegun, flamethrower, grenade), every ammo kind (handgun, light, rifle, fuel, grenade) and the jetpack; each restocks 20 s after you take it | between spawn and the showroom    |
| BOAT POND  | the 6 watercraft (boat, launch, jetski, racer, speedboat, offshore) afloat                                                                                                                                                         | about 85 m beside the showroom    |
| Racetrack  | the generated loop, tarmac with a start grid                                                                                                                                                                                       | next to the spawn                 |
| PROP ALLEY | 6 props in a row to drive into (lamp, tree, lamp, palm, lamp, tree), on flat ground with 60 m of clear run-up to the south, so every hit is the same                                                                               | about 180 m south of the showroom |
| AI STREETS | a 4 x 4 grid of streets with junctions, signals and sidewalks; traffic drives and pedestrians walk                                                                                                                                 | about 800 m east, a separate area |

SHOWROOM, BOAT POND, PROP ALLEY and AI STREETS are landmarks, so they appear in the dev tools' places list
(F1) and on the map: teleport between them. Nothing else spawns near the showroom, so what you see
there is exactly the list above (AI only appears within range of a player, around the streets).

## How it is built

`crates/mapgen/src/testworld.rs` builds a map by hand (a flat island with a low coastal shelf and a
high plateau, a street grid) and runs it through the same road geometry stages and `city_from_map`
as the generator, so streets, sidewalks, signals and walkways come out the same. It then moves the
spawn beside the racetrack's start line, carves the pond, and adds the three landmarks.
`crates/server/src/showroom.rs` reads those landmarks and the start line's heading to place
everything; `Game::stock` picks the showroom for a city that carries one and the parked fleet for any
other. The scene lab does the same (`scene-lab data/test-world.json`).

Tests: `crates/server/tests/test_world.rs` generates the world and checks that every vehicle model
is within 160 m of the spawn exactly once, that boats float over deep water on the pond, that nothing
is in the water that should not be, and that the AI streets are a separate area where cars and
pedestrians appear. The live feel suite drives the world's racetrack with the real client and
rams the prop alley (`--strike lamp|tree|palm`), checking that the break shows at the impact.

## Changing it

Edit the layout in `showroom.rs` (rows, spacing, item order) and the map in `testworld.rs` (island,
streets, pond size); `AHEAD` and `POND_OFFSET` in the generator and the rows in `showroom.rs` are
the numbers that have to agree, and the server test fails if the boats end up off the water.
