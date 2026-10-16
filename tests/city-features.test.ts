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

test("final building pads keep ground below walls and within foundation depth", () => {
  assert.ok(city.buildings.length > 250, "the city retains its buildings");
  for (const b of city.buildings) {
    const angle = b.angle ?? 0;
    for (const dx of [-b.w / 2, 0, b.w / 2])
      for (const dz of [-b.d / 2, 0, b.d / 2]) {
        const h = terrainHeight(
          b.x + dx * Math.cos(angle) - dz * Math.sin(angle),
          b.z + dx * Math.sin(angle) + dz * Math.cos(angle),
          city,
        );
        assert.ok(h <= b.y! + 0.011, `ground buries walls at ${b.x}, ${b.z}`);
        assert.ok(b.y! - h <= 4.4, `foundation floats at ${b.x}, ${b.z}`);
      }
  }
});

test("airport services leave the runway clear and lakes stay within their basins", () => {
  for (const a of airportsOf(city)) {
    const nearby = city.buildings.filter(
      (b) => Math.abs(b.x - a.x) < 110 && Math.abs(b.z - a.z) < 110,
    );
    assert.equal(nearby.filter((b) => b.asset === "warehouse").length, 2);
    assert.ok(nearby.some((b) => b.asset === "campus"));
    assert.ok(nearby.some((b) => b.h - (b.y ?? 0) > 20));
    for (const b of nearby)
      assert.ok(Math.abs(b.x - a.x) - b.w / 2 > 11, "services stay outside the runway");
  }
  assert.ok(city.water!.lakes.length >= 2 && city.water!.lakes.length < 10);
  for (const lake of city.water!.lakes) {
    const xs = lake.outline.filter((_, i) => i % 2 === 0),
      zs = lake.outline.filter((_, i) => i % 2 === 1);
    assert.ok(Math.max(...xs) - Math.min(...xs) < 700);
    assert.ok(Math.max(...zs) - Math.min(...zs) < 1000);
    for (let i = 0; i < lake.outline.length; i += 2)
      assert.ok(
        Math.abs(
          terrainHeight(lake.outline[i], lake.outline[i + 1], city) - lake.level,
        ) < 0.15,
        "shore meets terrain at water level",
      );
  }
});
