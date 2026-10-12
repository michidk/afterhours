import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCity } from "../scripts/city-generator.ts";
import { terrainHeight, terrainMesh, TERRAIN_SIDE } from "../shared/terrain.ts";
import {
  groundLevel,
  isWater,
  resolveWorldBounds,
  WORLD_LIMIT,
} from "../shared/water.ts";
import { LIMIT, idle, type Entity } from "../shared/world.ts";
import { Simulation } from "../server/simulation.ts";
import { predictStep, entityBox } from "../shared/physics/index.ts";
import { CityStore } from "../server/city-stream.ts";
import { emptyCity, mapManifestSchema } from "../shared/city-stream.ts";

const city = generateCity();
const body = (kind: Entity["kind"], x: number, z: number): Entity => ({
  id: "test",
  kind,
  x,
  z,
  y: groundLevel(x, z, city),
  angle: 0,
  vx: 0,
  vz: 0,
  vy: 0,
  health: 100,
  color: "#ffffff",
});

test("saved island is reproducible, larger, varied and surrounded by ocean", () => {
  assert.deepEqual(generateCity().terrain, city.terrain);
  assert.notDeepEqual(generateCity(714).terrain, city.terrain);
  assert.ok(city.terrain);
  assert.ok(Math.max(...city.terrain.heights) > 120);
  assert.equal(groundLevel(0, 0, city), 0);
  assert.equal(groundLevel(city.airport.x, city.airport.z, city), 0);
  let land = 0;
  for (let z = -LIMIT; z <= LIMIT; z += 32)
    for (let x = -LIMIT; x <= LIMIT; x += 32) {
      if (!isWater(x, z, city)) land++;
      if (Math.abs(x) === LIMIT || Math.abs(z) === LIMIT)
        assert.ok(isWater(x, z, city));
    }
  assert.ok(land * 32 * 32 > 1.7 * 1632 * 1632);
  const radii: number[] = [];
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
    let r = 800;
    while (!isWater(Math.cos(a) * r, Math.sin(a) * r, city)) r += 4;
    radii.push(r);
  }
  assert.ok(Math.max(...radii) - Math.min(...radii) > 200);
  for (const b of city.buildings)
    for (const dx of [-1, 1])
      for (const dz of [-1, 1])
        assert.equal(groundLevel(b.x + (dx * b.w) / 2, b.z + (dz * b.d) / 2, city), 0);
  const manifest = mapManifestSchema.parse(new CityStore(city).manifest);
  assert.deepEqual(emptyCity(manifest).terrain, city.terrain);
  const mesh = terrainMesh(city.terrain);
  assert.equal(mesh.positions.length, TERRAIN_SIDE ** 2 * 3);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const vertices = mesh.indices
      .slice(i, i + 3)
      .map((j) => mesh.positions.slice(j * 3, j * 3 + 3));
    const [x, y, z] = [0, 1, 2].map(
      (axis) => vertices.reduce((sum, p) => sum + p[axis], 0) / 3,
    );
    assert.ok(Math.abs(terrainHeight(x, z, city) - y) < 1e-8);
  }
});

test("characters and cars follow hills identically in authority and prediction", () => {
  for (const kind of ["player", "car"] as const) {
    const sim = new Simulation(structuredClone(city));
    sim.entities.clear();
    const e = sim.spawn(kind, 970, 280);
    e.driver = kind === "car" ? "driver" : undefined;
    const predicted = structuredClone(e),
      input = { ...idle(), up: true };
    sim.inputs.set(e.driver ?? e.id, input);
    const start = e.y;
    for (let i = 0; i < 90; i++) {
      sim.tick(1 / 30);
      predictStep(predicted, input, sim.city, [], 1 / 30);
      for (const key of ["x", "y", "z"] as const)
        assert.ok(Math.abs(e[key] - predicted[key]) < 1e-8, `${kind} ${key}`);
      assert.ok(e.y >= groundLevel(e.x, e.z, sim.city) - 0.001);
    }
    assert.ok(start > 20);
    assert.ok(Math.abs(start - e.y) > 0.1);
  }
});

test("rotated boats stay off the irregular shore and all actors hit the invisible offshore wall", () => {
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    let r = 800;
    while (!isWater(Math.cos(a) * r, Math.sin(a) * r, city)) r += 0.5;
    const boat = body("speedboat", Math.cos(a) * (r - 1), Math.sin(a) * (r - 1));
    boat.angle = a;
    boat.vx = -Math.cos(a) * 20;
    boat.vz = -Math.sin(a) * 20;
    resolveWorldBounds(boat, city);
    const s = entityBox(boat);
    for (const u of [-1, 0, 1])
      for (const v of [-1, 0, 1])
        assert.ok(
          isWater(
            boat.x + u * s.w * Math.cos(a) + v * s.d * Math.sin(a),
            boat.z - u * s.w * Math.sin(a) + v * s.d * Math.cos(a),
            city,
          ),
        );
    assert.equal(boat.y, -1.1);
  }
  for (const kind of ["player", "car", "boat", "helicopter", "plane"] as const) {
    const e = body(kind, WORLD_LIMIT + 20, -WORLD_LIMIT - 20);
    e.y = 200;
    e.vx = 30;
    e.vz = -30;
    resolveWorldBounds(e, city);
    assert.ok(Math.abs(e.x) < WORLD_LIMIT && Math.abs(e.z) < WORLD_LIMIT);
    assert.ok(e.vx <= 0 && e.vz >= 0);
  }
});

test("flight ceilings allow powered takeoff above high terrain", () => {
  const peak = city.terrain!.heights.indexOf(Math.max(...city.terrain!.heights));
  const x = (peak % TERRAIN_SIDE) * 32 - LIMIT,
    z = Math.floor(peak / TERRAIN_SIDE) * 32 - LIMIT;
  for (const kind of ["player", "helicopter", "plane"] as const) {
    const e = body(kind, x, z),
      floor = e.y;
    e.driver = kind === "player" ? undefined : "driver";
    if (kind === "helicopter") e.flight = "takingOff";
    if (kind === "player") e.jetpack = { fuel: 45, active: true };
    if (kind === "plane") e.vz = 35;
    for (let i = 0; i < 30; i++)
      predictStep(
        e,
        { ...idle(), ascend: true, up: kind === "plane" },
        city,
        [],
        1 / 30,
      );
    assert.ok(e.y > floor + 1, `${kind} can climb above a ${floor} m hill`);
  }
});

test("players can board and leave parked vehicles on a hillside", () => {
  const sim = new Simulation(structuredClone(city));
  sim.entities.clear();
  const car = sim.spawn("car", 970, 280);
  const player = sim.join("Hiker", "#ffffff");
  player.x = car.x + 3;
  player.z = car.z;
  player.y = groundLevel(player.x, player.z, city);
  sim.interact(player.id);
  assert.equal(player.vehicle, car.id);
  sim.interact(player.id);
  assert.equal(player.vehicle, undefined);
  assert.equal(car.driver, undefined);
  assert.equal(player.parachute, undefined);
  assert.equal(player.y, groundLevel(player.x, player.z, city));
});
