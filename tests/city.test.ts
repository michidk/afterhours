import { roadDistance, roadIntersectsBox } from "../shared/roads.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadCity } from "../server/city-loader.ts";
import { navigationFor } from "../shared/navigation.ts";
test("manual generator persists a reproducible city and loader rejects bad artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afterhours-city-")),
    path = join(dir, "city.json");
  try {
    execFileSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/generate-city.ts",
      "--seed",
      "932",
      "--out",
      path,
    ]);
    const city = await loadCity(path),
      first = await readFile(path, "utf8");
    assert.equal(city.seed, 932);
    assert.ok(city.props.length > 50);
    execFileSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/generate-city.ts",
      "--seed",
      "932",
      "--out",
      path,
    ]);
    assert.equal(await readFile(path, "utf8"), first);
    assert.ok(
      !city.buildings.some(
        (b) =>
          Math.abs(b.x - city.airport.x) < 18 && Math.abs(b.z - city.airport.z) < 23,
      ),
    );
    await writeFile(path, '{"format":"afterhours-city","version":99}');
    await assert.rejects(loadCity(path), /Invalid city file/);
    await writeFile(path, "{broken");
    await assert.rejects(loadCity(path), /Invalid city file.*malformed JSON/);
    await assert.rejects(loadCity(join(dir, "missing.json")), /city:generate/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("road and sidewalk graphs connect distant destinations and include crosswalks", () => {
  const nav = navigationFor(generateCity());
  const ROAD_GRAPH = nav.roads,
    SIDEWALKS = nav.sidewalks;
  const path = nav.roadPath(0, ROAD_GRAPH.length - 1);
  assert.equal(path[0], 0);
  assert.equal(path.at(-1), ROAD_GRAPH.length - 1);
  for (let i = 1; i < path.length; i++)
    assert.ok(ROAD_GRAPH[path[i - 1]].edges.includes(path[i]));
  const walk = nav.sidewalkPath(0, SIDEWALKS.length - 1);
  assert.ok(walk.length > 10);
  assert.ok(walk.some((p) => p.crossing));
});

import { generateCity } from "../scripts/city-generator.ts";
import {
  BUILDING_ASSETS,
  BUILDING_ASSET_IDS,
} from "../shared/assets/buildings/index.ts";
import { cityFileSchema } from "../shared/city-schema.ts";
import { LIMIT, district } from "../shared/world.ts";

test("district composition keeps streets, alleys, parks and airfield clear across seeds", () => {
  for (const seed of [0, 1, 42, 713, 932, -17, 2147483647]) {
    const city = generateCity(seed);
    assert.deepEqual(generateCity(seed), city);
    cityFileSchema.parse({ format: "afterhours-city", version: 4, city });
    assert.ok(city.parks.length >= 20);
    assert.ok(city.buildings.length >= 250);
    assert.ok(LIMIT * 2 >= 1600);
    assert.ok(city.buildings.some((b) => b.x > 600));
    assert.ok(city.buildings.some((b) => b.x < -600));
    assert.ok(city.buildings.some((b) => b.h >= 100));
    assert.ok(city.buildings.some((b) => b.h < 10));
    assert.ok(new Set(city.buildings.map((b) => b.asset)).size >= 7);
    const downtown = city.buildings.filter((b) => district(b.x, b.z) === "DOWNTOWN");
    const neighborhoods = city.buildings.filter(
      (b) => district(b.x, b.z) !== "DOWNTOWN",
    );
    const average = (bs: typeof city.buildings) =>
      bs.reduce((sum, b) => sum + b.h, 0) / bs.length;
    assert.ok(average(downtown) > average(neighborhoods) * 1.7);
    for (const [i, b] of city.buildings.entries()) {
      assert.ok(b.asset && BUILDING_ASSETS[b.asset]);
      for (const road of city.roads)
        assert.ok(!roadIntersectsBox(road, b), `street clearance at seed ${seed}`);
      for (const other of city.buildings.slice(i + 1))
        assert.ok(
          Math.abs(b.x - other.x) >= (b.w + other.w) / 2 + 1.9 ||
            Math.abs(b.z - other.z) >= (b.d + other.d) / 2 + 1.9,
          "buildings need an alley gap",
        );
      for (const p of [
        ...city.parks.map((p) => ({ ...p, w: p.w ?? 38, d: p.d ?? 38 })),
        { ...city.airport, w: 32 },
      ])
        assert.ok(
          Math.abs(b.x - p.x) >= (b.w + p.w) / 2 ||
            Math.abs(b.z - p.z) >= (b.d + p.d) / 2,
        );
      for (const lane of city.surfaces?.filter((s) => s.kind === "service") ?? [])
        assert.ok(
          Math.abs(b.x - lane.x) >= (b.w + lane.w) / 2 ||
            Math.abs(b.z - lane.z) >= (b.d + lane.d) / 2,
          "service street clear",
        );
      for (const p of [...city.props, ...city.pickups])
        assert.ok(
          Math.abs(b.x - p.x) > b.w / 2 + 0.5 || Math.abs(b.z - p.z) > b.d / 2 + 0.5,
        );
    }
    assert.equal(
      new Set(city.props.map((p) => `${p.x},${p.z}`)).size,
      city.props.length,
    );
    for (const p of city.props) {
      for (const pad of [
        { x: 0, z: 36 },
        { x: -64, z: 30 },
      ])
        assert.ok(
          Math.hypot(p.x - pad.x, p.z - pad.z) >= 14,
          "starter aircraft boarding clearance",
        );
      assert.ok(
        city.roads.every((road) => roadDistance(p, road) >= road.width / 2 + 0.6),
        "street clear of props",
      );
    }
  }
  assert.notDeepEqual(generateCity(1), generateCity(2));
});

test("asset catalog and v4 references remain valid and old artifacts fail explicitly", () => {
  for (const id of BUILDING_ASSET_IDS) {
    const asset = BUILDING_ASSETS[id];
    assert.equal(asset.id, id);
    assert.ok(asset.height[0] > 0 && asset.height[1] >= asset.height[0]);
    assert.ok(asset.colors.every((color) => /^#[0-9a-f]{6}$/i.test(color)));
    assert.ok(asset.floorHeight >= 3);
  }
  const city = generateCity();
  assert.equal(
    cityFileSchema.safeParse({ format: "afterhours-city", version: 1, city }).success,
    false,
  );
  assert.equal(
    cityFileSchema.safeParse({
      format: "afterhours-city",
      version: 2,
      city: { ...city, buildings: [{ ...city.buildings[0], asset: "missing-model" }] },
    }).success,
    false,
  );
});

test("irregular streets form one connected network and include bends, loops and dead ends", () => {
  const city = generateCity(713),
    nav = navigationFor(city);
  const visited = new Set([0]),
    queue = [0];
  for (let i = 0; i < queue.length; i++)
    for (const id of nav.roads[queue[i]].edges)
      if (!visited.has(id)) {
        visited.add(id);
        queue.push(id);
      }
  assert.equal(visited.size, nav.roads.length, "every district is reachable");
  const diagonals = city.roads.filter(
    (r) => Math.abs(r.bx - r.ax) > 1 && Math.abs(r.bz - r.az) > 1,
  );
  assert.ok(diagonals.length > city.roads.length * 0.6);
  assert.ok(
    nav.roads.some((n) => n.edges.length === 1),
    "residential cul-de-sacs",
  );
  assert.ok(city.roads.length >= nav.roads.length, "alternative loop routes");
  for (const n of nav.roads)
    for (const id of n.edges) {
      const point = nav.lanePoint(n.id, id, 0.5),
        other = nav.roads[id];
      assert.ok(
        Math.abs(
          Math.hypot(point.x - (n.x + other.x) / 2, point.z - (n.z + other.z) / 2) -
            3.5,
        ) < 1e-6,
        "diagonal lanes use a normalized perpendicular",
      );
    }
  const walked = new Set([0]),
    walks = [0];
  for (let i = 0; i < walks.length; i++)
    for (const e of nav.sidewalks[walks[i]].edges)
      if (!walked.has(e.id)) {
        walked.add(e.id);
        walks.push(e.id);
      }
  assert.equal(
    walked.size,
    nav.sidewalks.length,
    "all sidewalk components are connected",
  );
});
