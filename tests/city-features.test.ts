import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap } from "../mapgen/pipeline.ts";
import { cityFromMap } from "../scripts/mapgen-city.ts";
import { LIMIT, airportsOf, spawnOrigin } from "../shared/world.ts";
import { WATER_LEVEL, groundLevel, isWater } from "../shared/water.ts";
import { terrainHeight } from "../shared/terrain.ts";
import { insideBuilding } from "../shared/physics/collision.ts";
import { selfIntersects } from "../mapgen/geom.ts";
import { Simulation } from "../server/simulation.ts";
import { safeSpawn } from "../server/lifecycle.ts";

const city = cityFromMap(generateMap({ seed: 713, size: LIMIT * 2, cell: 8 }));
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

test("players spawn at a town hall near downtown with a car park in front", () => {
  const hall = city.townHall!;
  assert.ok(hall, "every generated city has a town hall");
  assert.ok(distance(hall.spawn, city.centre!) < 400, "the town hall is downtown");
  assert.ok(
    city.buildings.some((b) => b.asset === "civic-hall" && distance(b, hall) < 40),
  );
  assert.ok(hall.parking.length >= 20, "a bunch of parking spaces");
  for (const bay of hall.parking)
    assert.ok(
      !city.buildings.some((b) => insideBuilding(b, bay.x, bay.z, 1)),
      "no bay lies inside a building",
    );
  assert.deepEqual(spawnOrigin(city), hall.spawn);
  assert.ok(distance(safeSpawn(city, []), hall.spawn) < 10);
  assert.ok(city.landmarks.some((l) => l.kind === "townhall"));
});

test("two dry, flat airports stand far apart", () => {
  const airports = airportsOf(city);
  assert.equal(airports.length, 2);
  assert.ok(distance(airports[0], airports[1]) > 600);
  for (const a of airports) {
    assert.ok(!isWater(a.x, a.z, city));
    assert.ok(
      Math.abs(groundLevel(a.x - 80, a.z, city) - groundLevel(a.x + 80, a.z, city)) < 1,
    );
  }
  assert.equal(city.landmarks.filter((l) => l.kind === "airport").length, 2);
});

test("a closed racetrack loop runs on dry land clear of buildings", () => {
  const track = city.racetrack!;
  assert.ok(track);
  const loop = [];
  for (let i = 0; i < track.path.length; i += 2)
    loop.push({ x: track.path[i], z: track.path[i + 1] });
  let length = 0;
  for (let i = 0; i < loop.length; i++)
    length += distance(loop[i], loop[(i + 1) % loop.length]);
  assert.ok(length > 500, `a lap is ${length.toFixed(0)} m`);
  assert.ok(!selfIntersects(loop), "the circuit never crosses itself");
  for (const p of loop) {
    assert.ok(groundLevel(p.x, p.z, city) > WATER_LEVEL + 0.5, "the track stays dry");
    assert.ok(!city.buildings.some((b) => insideBuilding(b, p.x, p.z, 2)));
  }
  assert.equal(track.grid.length, 2);
});

test("three harbours moor boats in deep water beside a dry quay", () => {
  const harbours = city.harbours!;
  assert.equal(harbours.length, 3);
  for (let i = 0; i < harbours.length; i++)
    for (let j = i + 1; j < harbours.length; j++)
      assert.ok(distance(harbours[i], harbours[j]) > 300);
  for (const h of harbours) {
    assert.ok(!isWater(h.x, h.z, city), "the quay is dry land");
    assert.equal(h.berths.length, 3);
    for (const berth of h.berths) {
      assert.ok(isWater(berth.x, berth.z, city), "boats float");
      assert.ok(
        WATER_LEVEL - terrainHeight(berth.x, berth.z, city) > 1.5,
        "and the berth is deep enough not to ground them",
      );
    }
  }
});

test("the server parks boats, planes and starter cars at the new sites", () => {
  const sim = new Simulation(city);
  try {
    const parked = [...sim.entities.values()].filter((e) => !e.ai);
    for (const berth of city.harbours!.flatMap((h) => h.berths))
      assert.ok(
        parked.some((e) => e.kind !== "car" && distance(e, berth) < 0.5),
        "every berth holds a boat",
      );
    for (const a of airportsOf(city))
      assert.ok(parked.some((e) => e.kind === "plane" && distance(e, a) < a.d));
    const cars = parked.filter((e) => e.kind === "car");
    assert.ok(
      cars.filter((car) =>
        city.townHall!.parking.some((bay) => distance(car, bay) < 0.5),
      ).length >= 3,
      "starter cars stand in the town hall's bays",
    );
    for (const slot of city.racetrack!.grid)
      assert.ok(
        cars.some((car) => distance(car, slot) < 0.5),
        "racers wait on the grid",
      );
  } finally {
    sim.destruction.dispose();
  }
});
