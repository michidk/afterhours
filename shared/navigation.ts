import type { City, Road } from "./world.ts";
export interface Waypoint {
  x: number;
  z: number;
  crossing?: "x" | "z";
  /** Approaching a signalled junction; `stop` is the stop line's distance from it. */
  junction?: { x: number; z: number; axis: "x" | "z"; stop?: number };
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

/**
 * Navigation is derived exclusively from the server's loaded street segments and,
 * for generated cities, the artifact's sidewalk walkways. Without walkways the
 * sidewalk graph is approximated from the segments.
 */
export class Navigation {
  readonly roads: Junction[] = [];
  readonly sidewalks: SidewalkNode[] = [];
  private links = new Map<string, Road>();
  constructor(segments: Road[], walkways?: City["walkways"]) {
    if (walkways) {
      const { points, links } = walkways;
      for (let i = 0; i < points.length; i += 2)
        this.sidewalks.push({ id: i / 2, x: points[i], z: points[i + 1], edges: [] });
      for (let i = 0; i < links.length; i += 3) {
        const crossing =
          links[i + 2] === 1 ? "x" : links[i + 2] === 2 ? "z" : undefined;
        this.sidewalks[links[i]].edges.push({ id: links[i + 1], crossing });
        this.sidewalks[links[i + 1]].edges.push({ id: links[i], crossing });
      }
    }
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
      if (walkways) continue;
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
      length = Math.hypot(dx, dz),
      road = this.links.get(`${from}:${to}`)!,
      towardB = road.bx === b.x && road.bz === b.z,
      phase = towardB ? road.phaseB : road.phaseA,
      stop = towardB ? road.approachB : road.approachA;
    return {
      x: a.x + dx * fraction + (dz / length) * 3.5,
      z: a.z + dz * fraction - (dx / length) * 3.5,
      ...(b.edges.length >= 3
        ? {
            junction: {
              x: b.x,
              z: b.z,
              // Generated junctions carry a phase per arm; otherwise the dominant
              // axis of travel picks it.
              axis:
                phase ??
                (Math.abs(dx) > Math.abs(dz) ? ("x" as const) : ("z" as const)),
              ...(stop !== undefined ? { stop } : {}),
            },
          }
        : {}),
    };
  }
  /**
   * With `from`, the node a car arrives from, the route may not turn straight back
   * along that segment (except at a dead end): a U-turn swings wide over the kerb.
   */
  roadPath(start: number, goal: number, from?: number) {
    const first = this.roads[start],
      onward =
        first && from !== undefined && first.edges.length > 1
          ? first.edges.filter((id) => id !== from)
          : undefined;
    const ids = path(this.roads, start, goal, (n) =>
      n === first && onward ? onward : n.edges,
    );
    // A goal only reachable back the way the car came still gets a route.
    return ids.length || !onward ? ids : path(this.roads, start, goal, (n) => n.edges);
  }
  /**
   * Lane targets along a node path. Generated junctions record their stop line,
   * which can lie farther out than the waypoint before the junction; that
   * approach is flagged too, so a car sees the signal in time to brake for it.
   */
  lanePath(ids: number[]): Waypoint[] {
    const out: Waypoint[] = [];
    for (let i = 1; i < ids.length; i++) {
      const end = this.lanePoint(ids[i - 1], ids[i]),
        stop = end.junction?.stop,
        node = this.roads[ids[i]];
      if (stop !== undefined)
        for (let k = out.length - 1; k >= 0 && !out[k].junction; k--) {
          if (Math.hypot(out[k].x - node.x, out[k].z - node.z) > stop + 20) break;
          out[k] = { ...out[k], junction: end.junction };
        }
      out.push(end);
    }
    return out;
  }
  sidewalkPath(start: number, goal: number): Waypoint[] {
    let links = sidewalkLinks.get(this);
    if (!links) {
      links = this.sidewalks.map((n) => n.edges.map((e) => e.id));
      sidewalkLinks.set(this, links);
    }
    const ids = path(this.sidewalks, start, goal, (n) => links[n.id]);
    return ids.slice(1).map((id, i) => ({
      ...this.sidewalks[id],
      crossing: this.sidewalks[ids[i]].edges.find((e) => e.id === id)?.crossing,
    }));
  }
}
/** Neighbour ids per sidewalk node, derived once from the finished graph. */
const sidewalkLinks = new WeakMap<Navigation, number[][]>();
/** Reusable search state per graph: a route search must not allocate per node it visits. */
const scratch = new WeakMap<object, { parent: Int32Array; queue: Int32Array }>();
/**
 * Shortest route by hop count, ties broken by edge order, so it is stable across runs.
 * Breadth first search over typed arrays; `edges` must return the neighbour ids of a node.
 */
export function path<T>(
  nodes: T[],
  start: number,
  goal: number,
  edges: (n: T) => ArrayLike<number>,
): number[] {
  if (!nodes[start] || !nodes[goal]) return [];
  let state = scratch.get(nodes);
  if (!state || state.parent.length !== nodes.length) {
    state = {
      parent: new Int32Array(nodes.length),
      queue: new Int32Array(nodes.length),
    };
    scratch.set(nodes, state);
  }
  const { parent, queue } = state;
  parent.fill(-2);
  parent[start] = -1;
  let head = 0,
    tail = 0;
  queue[tail++] = start;
  while (head < tail) {
    const id = queue[head++];
    if (id === goal) break;
    const list = edges(nodes[id]);
    for (let i = 0; i < list.length; i++) {
      const next = list[i];
      if (parent[next] === -2) {
        parent[next] = id;
        queue[tail++] = next;
      }
    }
  }
  if (parent[goal] === -2) return [];
  const result: number[] = [];
  for (let at = goal; at !== -1; at = parent[at]) result.push(at);
  return result.reverse();
}
const cache = new WeakMap<City, { roads: Road[]; navigation: Navigation }>();
export function navigationFor(city: City) {
  let entry = cache.get(city);
  if (!entry || entry.roads !== city.roads) {
    entry = {
      roads: city.roads,
      navigation: new Navigation(city.roads, city.walkways),
    };
    cache.set(city, entry);
  }
  return entry.navigation;
}
