import { test } from "node:test";
import assert from "node:assert/strict";
import { buildingBox, contact, insideBuilding } from "../shared/physics/collision.ts";
import type { Building } from "../shared/world.ts";
import { generateMap } from "../mapgen/pipeline.ts";
import { cityFromMap } from "../scripts/mapgen-city.ts";
import { cityFileSchema, CITY_FORMAT_VERSION } from "../shared/city-schema.ts";
import { terrainHeight } from "../shared/terrain.ts";
import { WATER_LEVEL } from "../shared/water.ts";

/** Footprint corner in the frame used by the generator and the client renderer. */
const corner = (b: Building, x: number, z: number) => {
  const a = b.angle ?? 0;
  return {
    x: b.x + x * Math.cos(a) - z * Math.sin(a),
    z: b.z + x * Math.sin(a) + z * Math.cos(a),
  };
};

test("rotated building collision matches the rendered footprint frame", () => {
  const b: Building = {
    x: 10,
    z: -5,
    w: 40,
    d: 10,
    h: 20,
    angle: 0.5,
    color: "#ffffff",
    style: 0,
  };
  const inside = corner(b, 15, 3),
    outside = corner(b, 15, 8),
    mirrored = {
      x: b.x + 15 * Math.cos(0.5) + 3 * Math.sin(0.5),
      z: b.z - 15 * Math.sin(0.5) + 3 * Math.cos(0.5),
    };
  const probe = (p: { x: number; z: number }) =>
    contact({ x: p.x, z: p.z, w: 0.3, d: 0.3, angle: 0 }, buildingBox(b));
  assert.ok(probe(inside), "point inside the drawn walls must collide");
  assert.ok(!probe(outside), "point beside the drawn walls must be free");
  assert.ok(!probe(mirrored), "the mirror image of the footprint must not block");
  assert.ok(insideBuilding(b, inside.x, inside.z));
  assert.ok(!insideBuilding(b, outside.x, outside.z));
  assert.ok(insideBuilding(b, outside.x, outside.z, 6));
});

test("generated artifact validates and places everything on land at consistent altitudes", () => {
  const map = generateMap({ seed: 5, size: 3072, cell: 8 });
  const city = cityFromMap(map);
  cityFileSchema.parse({
    format: "afterhours-city",
    version: CITY_FORMAT_VERSION,
    city,
  });
  assert.ok(city.centre);
  assert.ok(city.surface && city.surface.asphalt.length > 50);
  for (const b of city.buildings) {
    assert.ok(b.y !== undefined && b.y > WATER_LEVEL, "pads sit above water");
    assert.ok(b.h > b.y!, "roof above pad");
    assert.ok(
      Math.abs(terrainHeight(b.x, b.z, city) - b.y!) < 1.2,
      "pad stamped into terrain",
    );
  }
  for (const r of city.roads) {
    assert.ok(terrainHeight(r.x, r.z, city) > WATER_LEVEL, "lanes stay on land");
    assert.ok(Math.hypot(r.bx - r.ax, r.bz - r.az) <= 24.5, "lane segments stay short");
  }
  for (const p of city.pickups) assert.ok(terrainHeight(p.x, p.z, city) > WATER_LEVEL);
  const a = city.airport;
  for (const [dx, dz] of [
    [-a.w / 2 + 2, -a.d / 2 + 2],
    [a.w / 2 - 2, a.d / 2 - 2],
    [0, 0],
  ]) {
    const h = terrainHeight(a.x + dx, a.z + dz, city);
    assert.ok(Math.abs(h - terrainHeight(a.x, a.z, city)) < 0.6, "airfield is flat");
  }
});
