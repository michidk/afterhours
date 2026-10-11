import type { City, Road } from "./world.ts";
export interface Waypoint {
  x: number;
  z: number;
  crossing?: "x" | "z";
  junction?: { x: number; z: number; axis: "x" | "z" };
}
export interface Junction {
  id: number;
  x: number;
  z: number;
  edges: number[];
}
export interface SidewalkNode extends Waypoint {
  id: number;
  edges: { id: number; crossing?: "x" | "z" }[];
}

/** Navigation is derived exclusively from the server's loaded street segments. */
export class Navigation {
  readonly roads: Junction[] = [];
  readonly sidewalks: SidewalkNode[] = [];
  private links = new Map<string, Road>();
  constructor(segments: Road[]) {
    const ids = new Map<string, number>();
    const node = (x: number, z: number) => {
      const key = `${x},${z}`;
      let id = ids.get(key);
      if (id !== undefined) return id;
      id = this.roads.length;
      ids.set(key, id);
      this.roads.push({ id, x, z, edges: [] });
      return id;
    };
    const corners = new Map<number, number[]>();
    for (const road of segments) {
      const a = node(road.ax, road.az),
        b = node(road.bx, road.bz);
      if (this.roads[a].edges.includes(b)) continue;
      this.roads[a].edges.push(b);
      this.roads[b].edges.push(a);
      this.links.set(`${a}:${b}`, road);
      this.links.set(`${b}:${a}`, road);
      const dx = road.bx - road.ax,
        dz = road.bz - road.az,
        length = Math.hypot(dx, dz),
        offset = road.width / 2 + 2;
      for (const side of [-1, 1]) {
        const first = this.sidewalks.length;
        for (const id of [a, b]) {
          const n = this.roads[id],
            sid = this.sidewalks.length;
          this.sidewalks.push({
            id: sid,
            x: n.x + ((side * dz) / length) * offset,
            z: n.z - ((side * dx) / length) * offset,
            edges: [],
          });
          const list = corners.get(id) || [];
          list.push(sid);
          corners.set(id, list);
        }
        this.sidewalks[first].edges.push({ id: first + 1 });
        this.sidewalks[first + 1].edges.push({ id: first });
      }
    }
    for (const [id, list] of corners)
      for (const a of list)
        for (const b of list) {
          if (a === b) continue;
          const from = this.sidewalks[a],
            to = this.sidewalks[b];
          // Corner links stay inside the reserved junction apron. Signal-controlled crossings
          // use the same dominant approach axis as cars and rendered signal heads.
          const crossing =
            this.roads[id].edges.length >= 3
              ? Math.abs(to.x - from.x) > Math.abs(to.z - from.z)
                ? "x"
                : "z"
              : undefined;
          from.edges.push({ id: b, crossing });
        }
  }
  lanePoint(from: number, to: number, fraction = 1): Waypoint {
    const a = this.roads[from],
      b = this.roads[to];
    if (!a || !b || !this.links.has(`${from}:${to}`))
      throw Error("Invalid street edge");
    const dx = b.x - a.x,
      dz = b.z - a.z,
      length = Math.hypot(dx, dz);
    return {
      x: a.x + dx * fraction + (dz / length) * 3.5,
      z: a.z + dz * fraction - (dx / length) * 3.5,
      ...(b.edges.length >= 3
        ? {
            junction: {
              x: b.x,
              z: b.z,
              axis: Math.abs(dx) > Math.abs(dz) ? ("x" as const) : ("z" as const),
            },
          }
        : {}),
    };
  }
  roadPath(start: number, goal: number) {
    return path(this.roads, start, goal, (n) => n.edges);
  }
  sidewalkPath(start: number, goal: number): Waypoint[] {
    const ids = path(this.sidewalks, start, goal, (n) => n.edges.map((e) => e.id));
    return ids.slice(1).map((id, i) => ({
      ...this.sidewalks[id],
      crossing: this.sidewalks[ids[i]].edges.find((e) => e.id === id)?.crossing,
    }));
  }
}
function path<T>(
  nodes: T[],
  start: number,
  goal: number,
  edges: (n: T) => number[],
): number[] {
  if (!nodes[start] || !nodes[goal]) return [];
  const queue = [start],
    parents = new Map([[start, -1]]);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === goal) break;
    for (const next of edges(nodes[id]))
      if (!parents.has(next)) {
        parents.set(next, id);
        queue.push(next);
      }
  }
  if (!parents.has(goal)) return [];
  const result = [goal];
  while (result[0] !== start) result.unshift(parents.get(result[0])!);
  return result;
}
const cache = new WeakMap<City, { roads: Road[]; navigation: Navigation }>();
export function navigationFor(city: City) {
  let entry = cache.get(city);
  if (!entry || entry.roads !== city.roads) {
    entry = { roads: city.roads, navigation: new Navigation(city.roads) };
    cache.set(city, entry);
  }
  return entry.navigation;
}
