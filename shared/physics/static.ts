import type { City, Building } from "../world.ts";
import { SpatialGrid } from "../spatial.ts";
import { destructibles, destructionOverlay, type PropKind } from "../destruction.ts";
export type StaticCollider = Building & {
  obstacle?: PropKind;
  destructibleId?: string;
  /** Position among the destructible props; buildings have none and always come first. */
  order?: number;
};
const rank = (c: StaticCollider) => c.order ?? -1;
const radius = (c: StaticCollider) => Math.max(c.w, c.d) / 2;
interface Entry {
  buildings: City["buildings"];
  props: City["props"];
  parks: City["parks"];
  roads: City["roads"];
  revision: number;
  grid: SpatialGrid<StaticCollider>;
  /** Every destructible prop's collider, whether or not it is currently standing. */
  colliders: Map<string, StaticCollider>;
  /** Ids currently out of the grid because the prop is broken. */
  removed: Set<string>;
}
const cache = new WeakMap<City, Entry>();

function build(city: City, overlay: ReturnType<typeof destructionOverlay>): Entry {
  const grid = new SpatialGrid<StaticCollider>(32),
    colliders = new Map<string, StaticCollider>(),
    removed = new Set<string>();
  for (const b of city.buildings) grid.insert(b, b.x, b.z, Math.max(b.w, b.d) / 2);
  destructibles(city).forEach((p, order) => {
    const b: StaticCollider = {
      obstacle: p.kind,
      destructibleId: p.id,
      order,
      x: p.x,
      z: p.z,
      w: p.w,
      d: p.d,
      h: p.h,
      color: "#88775b",
      style: 0,
    };
    colliders.set(p.id, b);
    if (overlay.ids.has(p.id)) removed.add(p.id);
    else grid.insert(b, p.x, p.z, radius(b));
  });
  return {
    buildings: city.buildings,
    props: city.props,
    parks: city.parks,
    roads: city.roads,
    revision: overlay.revision,
    grid,
    colliders,
    removed,
  };
}

/**
 * Props breaking and restoring change only a handful of colliders, so the grid is updated in
 * place. Rebuilding every collider of a city with ten thousand props took 13 ms or more,
 * on every break and every restore, on the server and in each browser. Colliders keep their
 * original rank, so query order matches a grid built from scratch.
 */
function sync(entry: Entry, overlay: ReturnType<typeof destructionOverlay>) {
  for (const id of overlay.ids) {
    if (entry.removed.has(id)) continue;
    entry.removed.add(id);
    const c = entry.colliders.get(id);
    if (c) entry.grid.remove(c, c.x, c.z, radius(c));
  }
  for (const id of [...entry.removed]) {
    if (overlay.ids.has(id)) continue;
    entry.removed.delete(id);
    const c = entry.colliders.get(id);
    if (c) entry.grid.insertRanked(c, c.x, c.z, radius(c), rank);
  }
  entry.revision = overlay.revision;
}

export function staticGeometry(city: City) {
  let stored = cache.get(city);
  const overlay = destructionOverlay(city);
  if (
    !stored ||
    stored.buildings !== city.buildings ||
    stored.props !== city.props ||
    stored.parks !== city.parks ||
    stored.roads !== city.roads
  ) {
    stored = build(city, overlay);
    cache.set(city, stored);
  } else if (stored.revision !== overlay.revision) sync(stored, overlay);
  return stored.grid;
}
