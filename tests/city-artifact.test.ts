import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCity } from "../server/city-loader.ts";
import { terrainHeight } from "../shared/terrain.ts";

test("no tree crown of the saved city sits inside the terrain", async () => {
  const city = await loadCity();
  const extreme = (x: number, z: number, r: number, pick: typeof Math.min) => {
    let v = terrainHeight(x, z, city);
    for (const dx of [-r, -r / 2, 0, r / 2, r])
      for (const dz of [-r, -r / 2, 0, r / 2, r])
        v = pick(v, terrainHeight(x + dx, z + dz, city));
    return v;
  };
  for (const t of city.props)
    if (t.kind === "tree")
      assert.ok(
        extreme(t.x, t.z, 2.75, Math.max) <=
          extreme(t.x, t.z, 0.4, Math.min) + 0.52 * t.h,
        `tree at ${t.x},${t.z} buries its crown`,
      );
});
