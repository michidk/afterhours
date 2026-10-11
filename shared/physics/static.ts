import type { City, Building } from "../world.ts";
import { SpatialGrid } from "../spatial.ts";
import { destructibles, destructionOverlay, type PropKind } from "../destruction.ts";
export type StaticCollider = Building & {
  obstacle?: PropKind;
  destructibleId?: string;
};
const cache = new WeakMap<
  City,
  {
    buildings: City["buildings"];
    props: City["props"];
    parks: City["parks"];
    roads: City["roads"];
    revision: number;
    grid: SpatialGrid<StaticCollider>;
  }
>();
export function staticGeometry(city: City) {
  let stored = cache.get(city);
  const overlay = destructionOverlay(city);
  if (
    !stored ||
    stored.buildings !== city.buildings ||
    stored.props !== city.props ||
    stored.parks !== city.parks ||
    stored.roads !== city.roads ||
    stored.revision !== overlay.revision
  ) {
    const grid = new SpatialGrid<StaticCollider>(32);
    for (const b of city.buildings) grid.insert(b, b.x, b.z, Math.max(b.w, b.d) / 2);
    for (const p of destructibles(city)) {
      if (overlay.ids.has(p.id)) continue;
      const b: StaticCollider = {
        obstacle: p.kind,
        destructibleId: p.id,
        x: p.x,
        z: p.z,
        w: p.w,
        d: p.d,
        h: p.h,
        color: "#88775b",
        style: 0,
      };
      grid.insert(b, p.x, p.z, Math.max(p.w, p.d) / 2);
    }
    stored = {
      buildings: city.buildings,
      props: city.props,
      parks: city.parks,
      roads: city.roads,
      revision: overlay.revision,
      grid,
    };
    cache.set(city, stored);
  }
  return stored.grid;
}
