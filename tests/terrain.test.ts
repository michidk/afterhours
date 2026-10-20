import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCity } from "../scripts/city-generator.ts";
import {
  terrainHeight,
  terrainMesh,
  TERRAIN_SIDE,
  TERRAIN_STEP,
} from "../shared/terrain.ts";
import {
  groundLevel,
  isWater,
  resolveWorldBounds,
  WORLD_LIMIT,
} from "../shared/water.ts";
import { LIMIT, idle, type Entity } from "../shared/world.ts";
import { Simulation } from "../server/simulation.ts";
import {
  closeTJunctions,
  drapeOnTerrain,
  sealSurfaces,
  sinkUnderStreets,
  weldCorners,
} from "../mapgen/streetfit.ts";
import { createField } from "../mapgen/field.ts";
import { shapeCoast } from "../mapgen/terrain.ts";
import {
  carAltitude,
  carForces,
  carGrounded,
  predictStep,
  watercraftForces,
} from "../shared/physics/index.ts";
import { CityStore } from "../server/city-stream.ts";
import { emptyCity, mapManifestSchema } from "../shared/city-stream.ts";
import { packHeights, unpackHeights } from "../shared/city-pack.ts";

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
  assert.ok(city.terrain.heights.reduce((m, h) => Math.max(m, h), -Infinity) > 120);
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
  assert.equal(manifest.hasTerrain, true);
  assert.equal(
    "terrain" in manifest,
    false,
    "heights travel on their own binary route",
  );
  const restored = unpackHeights(packHeights(city.terrain.heights));
  assert.equal(restored.length, city.terrain.heights.length);
  for (let i = 0; i < restored.length; i++)
    assert.ok(Math.abs(restored[i] - city.terrain.heights[i]) <= 0.005);
  assert.equal(
    emptyCity({ ...manifest, terrain: { heights: restored } }).terrain?.heights,
    restored,
  );
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

test("boats run aground and slide to a halt on land; all actors hit the invisible offshore wall", () => {
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
    let r = 800;
    while (!isWater(Math.cos(a) * r, Math.sin(a) * r, city)) r += 0.5;
    const boat = body("speedboat", Math.cos(a) * (r + 10), Math.sin(a) * (r + 10));
    boat.model = "offshore";
    boat.driver = "pilot";
    boat.vx = -Math.cos(a) * 20;
    boat.vz = -Math.sin(a) * 20;
    boat.angle = Math.atan2(boat.vx, boat.vz);
    for (let i = 0; i < 600; i++) {
      watercraftForces(boat, { throttle: 1, steer: 0, brake: false }, 1 / 60, city);
      boat.x += boat.vx / 60;
      boat.z += boat.vz / 60;
      resolveWorldBounds(boat, city);
    }
    // Full throttle cannot push a beached hull; friction stops it short of the interior.
    assert.ok(!isWater(boat.x, boat.z, city));
    assert.equal(Math.hypot(boat.vx, boat.vz), 0);
    assert.ok(r - Math.hypot(boat.x, boat.z) < 60);
    assert.equal(boat.y, groundLevel(boat.x, boat.z, city));
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
  const peak = city.terrain!.heights.indexOf(
    city.terrain!.heights.reduce((m, h) => Math.max(m, h), -Infinity),
  );
  const x = (peak % TERRAIN_SIDE) * TERRAIN_STEP - LIMIT,
    z = Math.floor(peak / TERRAIN_SIDE) * TERRAIN_STEP - LIMIT;
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

test("parked cars and stopped drivers off the throttle hold their place on a hill", () => {
  let x = 0,
    z = 0;
  // A dry, steady slope of roughly 15%.
  for (let i = 0; i < city.terrain!.heights.length; i += 7) {
    x = (i % TERRAIN_SIDE) * TERRAIN_STEP - LIMIT;
    z = Math.floor(i / TERRAIN_SIDE) * TERRAIN_STEP - LIMIT;
    const slope = (terrainHeight(x + 2, z, city) - terrainHeight(x - 2, z, city)) / 4;
    if (
      Math.abs(slope) > 0.12 &&
      Math.abs(slope) < 0.2 &&
      terrainHeight(x, z, city) > 2
    )
      break;
  }
  for (const driver of [undefined, "driver"]) {
    const car = body("car", x, z);
    car.driver = driver;
    const start = { x: car.x, z: car.z };
    for (let i = 0; i < 360; i++) {
      const previous = { x: car.x, y: car.y, z: car.z, vy: car.vy, vz: car.vz };
      carForces(
        car,
        { throttle: 0, steer: 0, brake: false },
        1 / 120,
        carGrounded(car, city),
      );
      car.x += car.vx / 120;
      car.z += car.vz / 120;
      carAltitude(car, previous, city, 1 / 120);
    }
    assert.ok(Math.hypot(car.x - start.x, car.z - start.z) < 0.05);
  }
});

test("street fit pulls a valley up under a street without lifting it through", () => {
  // A 5 x 5 grid, 8 m apart; the column under an 8 m wide street carries its
  // height and the ground either side lies 5 m lower.
  const side = 5,
    heights = Array.from({ length: side * side }, (_, i) => (i % side === 2 ? 5 : 0));
  const grid = { heights, side, step: 8, half: 16 },
    street = [-4, 5, -16, 4, 5, -16, 4, 5, 16, -4, 5, 16];
  sinkUnderStreets(grid, [{ polygons: [street], top: 0.1 }], []);
  // The game's triangle split, on this small grid.
  const at = (x: number, z: number) => {
    const gx = (x + 16) / 8,
      gz = (z + 16) / 8,
      ix = Math.min(side - 2, Math.floor(gx)),
      iz = Math.min(side - 2, Math.floor(gz)),
      u = gx - ix,
      v = gz - iz,
      i = iz * side + ix;
    return u + v <= 1
      ? heights[i] +
          u * (heights[i + 1] - heights[i]) +
          v * (heights[i + side] - heights[i])
      : heights[i + side + 1] +
          (1 - u) * (heights[i + side] - heights[i + side + 1]) +
          (1 - v) * (heights[i + 1] - heights[i + side + 1]);
  };
  for (const z of [-12, 0, 12])
    for (const x of [-4, 0, 4]) {
      assert.ok(at(x, z) <= 5.1 - 0.05, "ground stays under the surface");
      assert.ok(at(x, z) >= 5.1 - 0.5, "ground stays close below the surface");
    }
  assert.equal(heights[0], 0, "ground away from the street is untouched");
});

test("draped streets lie on the terrain triangles and keep their area", () => {
  // A 4 x 4 grid of uneven heights and an L-shaped street crossing several cells.
  const side = 4,
    heights = [0, 1, 3, 2, 1, 4, 2, 0, 2, 1, 5, 3, 0, 2, 1, 4];
  const grid = { heights, side, step: 8, half: 12 },
    street = [-10, 9, -10, 10, 9, -10, 10, 9, -4, -4, 9, -4, -4, 9, 10, -10, 9, 10];
  const pieces = drapeOnTerrain([street], grid);
  const at = (x: number, z: number) => {
    const gx = (x + 12) / 8,
      gz = (z + 12) / 8,
      ix = Math.min(side - 2, Math.floor(gx)),
      iz = Math.min(side - 2, Math.floor(gz)),
      u = gx - ix,
      v = gz - iz,
      i = iz * side + ix;
    return u + v <= 1
      ? heights[i] +
          u * (heights[i + 1] - heights[i]) +
          v * (heights[i + side] - heights[i])
      : heights[i + side + 1] +
          (1 - u) * (heights[i + side] - heights[i + side + 1]) +
          (1 - v) * (heights[i + 1] - heights[i + side + 1]);
  };
  let area = 0;
  for (const piece of pieces) {
    const n = piece.length / 3;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += piece[i * 3] * piece[j * 3 + 2] - piece[j * 3] * piece[i * 3 + 2];
      assert.ok(
        Math.abs(piece[i * 3 + 1] - at(piece[i * 3], piece[i * 3 + 2])) < 1e-9,
        "every corner is at the terrain height",
      );
    }
    // Inside one terrain triangle: the centroid lies on the same plane as the corners.
    const c = [0, 1, 2].map(
      (k) => piece.filter((_, i) => i % 3 === k).reduce((a, b) => a + b) / n,
    );
    assert.ok(
      Math.abs(c[1] - at(c[0], c[2])) < 1e-9,
      "each piece is planar on the terrain",
    );
  }
  assert.ok(
    Math.abs(Math.abs(area) / 2 - (20 * 6 + 6 * 14)) < 1e-6,
    "the street's area is kept",
  );
});

test("sidewalks are cut away where asphalt lies, and neighbouring pieces share corners", () => {
  const grid = { heights: new Array(9).fill(2), side: 3, step: 8, half: 8 };
  const area = (pieces: number[][]) =>
    pieces.reduce((total, p) => {
      let a = 0;
      for (let i = 0; i < p.length; i += 3) {
        const j = (i + 3) % p.length;
        a += p[i] * p[j + 2] - p[j] * p[i + 2];
      }
      return total + Math.abs(a) / 2;
    }, 0);
  // A 4 x 12 m sidewalk across a 6 x 6 m patch of asphalt: 4 x 6 m of it is covered.
  const walk = [-2, 2, -6, 2, 2, -6, 2, 2, 6, -2, 2, 6],
    road = [-6, 2, -3, 6, 2, -3, 6, 2, 3, -6, 2, 3];
  assert.ok(Math.abs(area(drapeOnTerrain([walk], grid)) - 48) < 1e-6);
  const cut = drapeOnTerrain([walk], grid, [road]);
  assert.ok(
    Math.abs(area(cut) - 24) < 1e-6,
    "the covered part of the sidewalk is left out",
  );
  for (const piece of cut)
    for (let i = 0; i < piece.length; i += 3)
      assert.ok(
        Math.abs(piece[i + 2]) >= 3 - 1e-9 || Math.abs(piece[i]) >= 6,
        "no sidewalk corner lies inside the road",
      );
  // Two strips whose shared corner differs by a centimetre are welded into one corner.
  const left = [0, 2, 0, 4, 2, 0, 4, 2, 4, 0, 2, 4],
    right = [4.01, 2, 0, 8, 2, 0, 8, 2, 4, 4.01, 2, 4, 4, 2, 4];
  const corners = new Set(
    drapeOnTerrain([left, right], grid).flatMap((p) =>
      Array.from({ length: p.length / 3 }, (_, i) => `${p[i * 3]},${p[i * 3 + 2]}`),
    ),
  );
  assert.ok(
    !corners.has("4.01,0") && !corners.has("4.01,4"),
    "the 1 cm offset is welded away",
  );
});

test("coast shaping turns a stepped plateau edge into a smooth beach at sea level", () => {
  // Level land 0.3 m above the sea whose edge zigzags by a cell, then a drop into deep water.
  const f = createField(512, 8),
    edge = (z: number) => 24 + (z % 4 < 2 ? 0 : 1) + (z % 7 === 0 ? 1 : 0);
  for (let z = 0; z < f.h; z++)
    for (let x = 0; x < f.w; x++) f.data[z * f.w + x] = x <= edge(z) ? 0.3 : -6;
  const far = f.data[32 * f.w + 2];
  shapeCoast(f);
  // Where each row crosses sea level, found by interpolation.
  const crossings: number[] = [];
  for (let z = 8; z < f.h - 8; z++) {
    let found: number | undefined;
    for (let x = 1; x < f.w - 1; x++) {
      const a = f.data[z * f.w + x],
        b = f.data[z * f.w + x + 1];
      if (a > 0 && b <= 0) {
        assert.equal(found, undefined, "each row crosses sea level exactly once");
        found = x + a / (a - b);
      }
    }
    assert.ok(found !== undefined, "each row has a coast");
    crossings.push(found);
  }
  const mean = crossings.reduce((a, b) => a + b) / crossings.length;
  assert.ok(
    Math.max(...crossings.map((c) => Math.abs(c - mean))) < 0.35,
    "the waterline no longer follows the cell staircase",
  );
  const z = 32,
    row = (x: number) => f.data[z * f.w + x];
  const at = Math.floor(mean);
  assert.ok(
    Math.abs((row(at) - row(at + 1)) / 8 - (BEACH_SLOPE + SHELF_SLOPE) / 2) < 0.06,
    "a gentle slope crosses the waterline",
  );
  assert.equal(f.data[32 * f.w + 2], far, "land far from the coast is untouched");
});
const BEACH_SLOPE = 0.06,
  SHELF_SLOPE = 0.1;

test("corners a few centimetres apart are welded and a T-junction that wide is closed", () => {
  const square = (x: number, z: number, w: number) => [
    x,
    0,
    z,
    x + w,
    0,
    z,
    x + w,
    0,
    z + 4,
    x,
    0,
    z + 4,
  ];
  // The second piece starts 4 cm short of the first one's right edge.
  const [a, b] = weldCorners([square(0, 0, 4), square(4.04, 0, 3)]);
  assert.equal(a[3], b[0], "the shared corner is one point");
  const [left] = closeTJunctions([
    square(0, 0, 4),
    [4.04, 0, 1, 7, 0, 1, 7, 0, 3, 4.04, 0, 3],
  ]);
  assert.ok(left.length > 12, "the neighbour's corners were added to the edge");
});

test("a corner shared by asphalt and a sidewalk is one point on both layers", () => {
  const asphalt = [[0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4]],
    // The sidewalk starts 3 cm off the asphalt's right edge.
    sidewalk = [[4.03, 0, 0, 7, 0, 0, 7, 0, 4, 4.03, 0, 4]];
  const [[a], [s]] = sealSurfaces([asphalt, sidewalk]);
  assert.equal(a[3], s[0], "their shared corner is the same x");
  assert.equal(a[5], s[2], "and the same z");
});

test("a sidewalk corner joins the asphalt's edge, never the other way round", () => {
  const asphalt = [[0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4]],
    // A triangle whose corner (4.07, 2) is 7 cm off the asphalt's right edge.
    sidewalk = [[4.07, 0, 2, 7, 0, 0, 7, 0, 4]];
  const [[a], [s]] = sealSurfaces([asphalt, sidewalk]);
  assert.equal(a.length, 15, "the asphalt edge gained the sidewalk's corner");
  assert.equal(s.length, 9, "the sidewalk kept its three corners");
});
