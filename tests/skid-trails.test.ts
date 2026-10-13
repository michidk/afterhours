import { test } from "node:test";
import assert from "node:assert/strict";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import {
  trailTiles,
  paintTrail,
  trailTileGeometry,
  TRAIL_TEXTURE_SIZE,
  TRAIL_TILE_WIDTH,
  TRAIL_LIFT,
  TRAIL_AIRFIELD_LIFT,
} from "../client/effects/trail-data.ts";
import { TERRAIN_SIDE, TERRAIN_STEP, terrainHeight } from "../shared/terrain.ts";

test("rubber atlas covers expanded and negative city coordinates at constant detail", () => {
  assert.deepEqual(trailTiles(780, -780, 0.5), ["12,-13"]);
  assert.deepEqual(trailTiles(-0.1, 63.9, 0.5), ["-1,0", "-1,1", "0,0", "0,1"]);
  assert.ok((0.26 * TRAIL_TEXTURE_SIZE) / TRAIL_TILE_WIDTH >= 4);
});
test("tile-edge rubber is painted in both tiles with matching world placement and grooves", () => {
  const positions: number[][] = [],
    widths: number[] = [];
  const ctx = {
    save() {},
    restore() {},
    translate(x: number, z: number) {
      positions.push([x, z]);
    },
    rotate() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke(this: { lineWidth: number }) {
      widths.push(this.lineWidth);
    },
    lineWidth: 0,
  } as unknown as CanvasRenderingContext2D;
  const mark = { x: 64, z: 65, angle: 0, length: 0.5, life: 40, tiles: [] };
  paintTrail(ctx, mark, 0, 1);
  paintTrail(ctx, mark, 1, 1);
  assert.deepEqual(positions, [
    [1024, 1008],
    [0, 1008],
  ]);
  assert.equal(widths.length, 10);
  assert.ok(Math.min(...widths) < Math.max(...widths) / 5);
});

test("trail tiles follow the terrain's vertices and diagonal at every point", () => {
  const side = TERRAIN_SIDE,
    heights = Array.from({ length: side * side }, (_, i) => {
      const x = i % side,
        z = Math.floor(i / side);
      // Uneven on purpose: a different diagonal would interpolate to different heights.
      return 20 + ((x * 7 + z * 13) % 5) * 0.8 + x * 0.05;
    }),
    city = { terrain: { heights } };
  const height = (x: number, z: number) => terrainHeight(x, z, city);
  const col = 3,
    row = -5,
    lift = TRAIL_LIFT;
  const { positions, indices, uvs } = trailTileGeometry(col, row, height, lift);
  assert.equal(positions.length / 3, (TRAIL_TILE_WIDTH / TERRAIN_STEP + 1) ** 2);
  assert.equal(uvs.length / 2, positions.length / 3);
  const cx = (col + 0.5) * TRAIL_TILE_WIDTH,
    cz = (row + 0.5) * TRAIL_TILE_WIDTH;
  for (let i = 0; i < positions.length; i += 3)
    assert.ok(
      Math.abs(
        positions[i + 1] - (height(cx + positions[i], cz + positions[i + 2]) + lift),
      ) < 1e-9,
      "each vertex sits on the terrain plus the lift",
    );
  // Sample the mesh surface itself, barycentrically, against the terrain function.
  const surfaceAt = (x: number, z: number) => {
    for (let t = 0; t < indices.length; t += 3) {
      const p = [0, 1, 2].map((k) => {
        const v = indices[t + k] * 3;
        return { x: cx + positions[v], y: positions[v + 1], z: cz + positions[v + 2] };
      });
      const d =
        (p[1].z - p[2].z) * (p[0].x - p[2].x) + (p[2].x - p[1].x) * (p[0].z - p[2].z);
      const a =
          ((p[1].z - p[2].z) * (x - p[2].x) + (p[2].x - p[1].x) * (z - p[2].z)) / d,
        b = ((p[2].z - p[0].z) * (x - p[2].x) + (p[0].x - p[2].x) * (z - p[2].z)) / d,
        c = 1 - a - b;
      if (a >= -1e-9 && b >= -1e-9 && c >= -1e-9)
        return a * p[0].y + b * p[1].y + c * p[2].y;
    }
    return NaN;
  };
  for (let n = 0; n < 200; n++) {
    const x = col * TRAIL_TILE_WIDTH + ((n * 37) % 640) / 10,
      z = row * TRAIL_TILE_WIDTH + ((n * 91) % 640) / 10;
    assert.ok(
      Math.abs(surfaceAt(x, z) - (height(x, z) + lift)) < 1e-9,
      `mesh and terrain agree at ${x.toFixed(1)}, ${z.toFixed(1)}`,
    );
  }
  assert.ok(
    Math.min(...positions.filter((_, i) => i % 3 === 1)) > 19,
    "high ground stays high",
  );
});

test("trail tiles face upward and use the painted canvas orientation", () => {
  const { positions, indices, uvs } = trailTileGeometry(0, 0, () => 5, TRAIL_LIFT),
    normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  for (let i = 1; i < normals.length; i += 3) assert.ok(normals[i] > 0.99, "faces up");
  const corner = (x: number, z: number) =>
    positions.findIndex(
      (v, i) =>
        i % 3 === 0 && Math.abs(v - x) < 1e-9 && Math.abs(positions[i + 2] - z) < 1e-9,
    ) / 3;
  const half = TRAIL_TILE_WIDTH / 2;
  assert.deepEqual(
    [uvs[corner(-half, -half) * 2], uvs[corner(-half, -half) * 2 + 1]],
    [0, 0],
  );
  assert.deepEqual(
    [uvs[corner(half, half) * 2], uvs[corner(half, half) * 2 + 1]],
    [1, 1],
  );
  assert.ok(TRAIL_AIRFIELD_LIFT > TRAIL_LIFT, "runway markings stay under the rubber");
});
