import {
  area,
  closestOnSegment,
  cross,
  dist,
  insetPolygon,
  polylineLength,
  segmentIntersection,
  signedArea,
  sub,
} from "./geom.ts";
import type { Point, RoadGraph, RoadKind } from "./types.ts";

export const ROAD_WIDTH: Record<RoadKind, number> = {
  highway: 24,
  avenue: 18,
  street: 12,
  lane: 7,
};
export const ROAD_RANK: Record<RoadKind, number> = {
  highway: 3,
  avenue: 2,
  street: 1,
  lane: 0,
};

interface GNode extends Point {
  id: number;
  edges: Set<number>;
  alive: boolean;
}
interface GEdge {
  id: number;
  a: number;
  b: number;
  kind: RoadKind;
  bridge: boolean;
  alive: boolean;
}
export interface SnapOptions {
  snap: number;
  minAngle: number;
}
const DEFAULT_SNAP: SnapOptions = { snap: 14, minAngle: (34 * Math.PI) / 180 };
const perimeter = (ring: Point[]) =>
  ring.reduce((sum, p, i) => sum + dist(p, ring[(i + 1) % ring.length]), 0);
/** Sidewalk width plus a one-metre verge beyond a road's kerb. */
const KERB_CLEARANCE = 3.5;

/**
 * Mutable planar road graph made of straight segments. Insertion applies the
 * Citygen/Parish–Müller local constraints: a segment that crosses, ends near, or
 * runs into an existing road is cut there and the growth front is severed.
 */
export class GraphBuilder {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  private cell = 48;
  private nodeCells = new Map<string, number[]>();
  private edgeCells = new Map<string, number[]>();
  private key = (x: number, z: number) =>
    `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;

  addNode(x: number, z: number) {
    const node: GNode = { id: this.nodes.length, x, z, edges: new Set(), alive: true };
    this.nodes.push(node);
    const k = this.key(x, z),
      list = this.nodeCells.get(k);
    if (list) list.push(node.id);
    else this.nodeCells.set(k, [node.id]);
    return node.id;
  }
  private indexEdge(e: GEdge) {
    const a = this.nodes[e.a],
      b = this.nodes[e.b];
    const x0 = Math.floor(Math.min(a.x, b.x) / this.cell),
      x1 = Math.floor(Math.max(a.x, b.x) / this.cell),
      z0 = Math.floor(Math.min(a.z, b.z) / this.cell),
      z1 = Math.floor(Math.max(a.z, b.z) / this.cell);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`,
          list = this.edgeCells.get(k);
        if (list) list.push(e.id);
        else this.edgeCells.set(k, [e.id]);
      }
  }
  addEdge(a: number, b: number, kind: RoadKind, bridge = false) {
    if (a === b) return -1;
    for (const id of this.nodes[a].edges) {
      const e = this.edges[id];
      if (e.alive && (e.a === b || e.b === b)) {
        if (ROAD_RANK[kind] > ROAD_RANK[e.kind]) e.kind = kind;
        return id;
      }
    }
    const edge: GEdge = { id: this.edges.length, a, b, kind, bridge, alive: true };
    this.edges.push(edge);
    this.nodes[a].edges.add(edge.id);
    this.nodes[b].edges.add(edge.id);
    this.indexEdge(edge);
    return edge.id;
  }
  removeEdge(id: number) {
    const e = this.edges[id];
    if (!e.alive) return;
    e.alive = false;
    this.nodes[e.a].edges.delete(id);
    this.nodes[e.b].edges.delete(id);
  }
  removeNode(id: number) {
    const n = this.nodes[id];
    for (const e of [...n.edges]) this.removeEdge(e);
    n.alive = false;
  }
  other(e: GEdge, node: number) {
    return e.a === node ? e.b : e.a;
  }
  degree(id: number) {
    return this.nodes[id].edges.size;
  }
  nodesNear(x: number, z: number, radius: number) {
    const out: number[] = [],
      r = Math.ceil(radius / this.cell),
      cx = Math.floor(x / this.cell),
      cz = Math.floor(z / this.cell);
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        const list = this.nodeCells.get(`${cx + i},${cz + j}`);
        if (!list) continue;
        for (const id of list) {
          const n = this.nodes[id];
          if (n.alive && Math.hypot(n.x - x, n.z - z) <= radius) out.push(id);
        }
      }
    return out;
  }
  edgesNear(x0: number, z0: number, x1: number, z1: number, pad: number) {
    const out = new Set<number>();
    const cx0 = Math.floor((Math.min(x0, x1) - pad) / this.cell),
      cx1 = Math.floor((Math.max(x0, x1) + pad) / this.cell),
      cz0 = Math.floor((Math.min(z0, z1) - pad) / this.cell),
      cz1 = Math.floor((Math.max(z0, z1) + pad) / this.cell);
    for (let x = cx0; x <= cx1; x++)
      for (let z = cz0; z <= cz1; z++) {
        const list = this.edgeCells.get(`${x},${z}`);
        if (list) for (const id of list) if (this.edges[id].alive) out.add(id);
      }
    return [...out].sort((a, b) => a - b);
  }
  splitEdge(id: number, p: Point) {
    const e = this.edges[id],
      a = this.nodes[e.a],
      b = this.nodes[e.b];
    if (dist(a, p) < 0.5) return e.a;
    if (dist(b, p) < 0.5) return e.b;
    const mid = this.addNode(p.x, p.z);
    this.removeEdge(id);
    this.addEdge(e.a, mid, e.kind, e.bridge);
    this.addEdge(mid, e.b, e.kind, e.bridge);
    return mid;
  }
  /** Angle between two segments as lines (0..π/2). */
  private lineAngle(a: Point, b: Point, c: Point, d: Point) {
    const u = sub(b, a),
      v = sub(d, c);
    const cos =
      Math.abs(u.x * v.x + u.z * v.z) /
      ((Math.hypot(u.x, u.z) || 1) * (Math.hypot(v.x, v.z) || 1));
    return Math.acos(Math.min(1, cos));
  }
  /**
   * Insert a segment from an existing node toward `to`. Returns the end node and
   * whether growth was severed by a snap, or undefined when rejected.
   */
  insert(
    from: number,
    to: Point,
    kind: RoadKind,
    options: Partial<SnapOptions> = {},
    bridge = false,
  ): { node: number; severed: boolean } | undefined {
    const { snap, minAngle } = { ...DEFAULT_SNAP, ...options };
    const start = this.nodes[from];
    let end: Point = { x: to.x, z: to.z };
    if (dist(start, end) < 2) return undefined;
    let severed = false,
      endNode = -1;
    const candidates = this.edgesNear(start.x, start.z, end.x, end.z, snap);
    // Priority 1: a true crossing closest to the start wins and cuts the segment.
    let bestT = Infinity,
      crossing: { edge: number; point: Point } | undefined;
    for (const id of candidates) {
      const e = this.edges[id];
      if (e.a === from || e.b === from) continue;
      if (bridge !== e.bridge) continue;
      const a = this.nodes[e.a],
        b = this.nodes[e.b];
      const hit = segmentIntersection(start, end, a, b);
      if (!hit || hit.t < bestT) {
        if (!hit) continue;
        if (this.lineAngle(start, end, a, b) < minAngle) return undefined;
        bestT = hit.t;
        crossing = {
          edge: id,
          point: { x: a.x + (b.x - a.x) * hit.u, z: a.z + (b.z - a.z) * hit.u },
        };
      }
    }
    if (crossing) {
      end = crossing.point;
      endNode = this.splitEdge(crossing.edge, end);
      severed = true;
    }
    if (endNode < 0) {
      // Priority 2: snap to a nearby node.
      let nearest = -1,
        nearestDistance = snap;
      for (const id of this.nodesNear(end.x, end.z, snap)) {
        if (id === from) continue;
        const d = dist(this.nodes[id], end);
        if (d < nearestDistance) {
          nearestDistance = d;
          nearest = id;
        }
      }
      if (nearest >= 0) {
        endNode = nearest;
        end = this.nodes[nearest];
        severed = true;
      }
    }
    if (endNode < 0) {
      // Priority 3: snap onto an edge body, splitting it, if the angle is usable.
      let best: { edge: number; point: Point; d: number } | undefined;
      for (const id of candidates) {
        const e = this.edges[id];
        if (e.a === from || e.b === from) continue;
        const a = this.nodes[e.a],
          b = this.nodes[e.b];
        const { point } = closestOnSegment(end, a, b),
          d = dist(point, end);
        if (d <= snap && (!best || d < best.d)) best = { edge: id, point, d };
      }
      if (best) {
        const e = this.edges[best.edge],
          a = this.nodes[e.a],
          b = this.nodes[e.b];
        if (this.lineAngle(start, best.point, a, b) < minAngle) return undefined;
        end = best.point;
        endNode = this.splitEdge(best.edge, end);
        severed = true;
      }
    }
    if (endNode < 0) endNode = this.addNode(end.x, end.z);
    if (endNode === from || dist(this.nodes[endNode], start) < 4) return undefined;
    // Reject if the new segment would still cross something after snapping.
    for (const id of this.edgesNear(start.x, start.z, end.x, end.z, 0)) {
      const e = this.edges[id];
      if (e.a === from || e.b === from || e.a === endNode || e.b === endNode) continue;
      if (bridge !== e.bridge) continue;
      if (segmentIntersection(start, end, this.nodes[e.a], this.nodes[e.b]))
        return undefined;
    }
    // Reject shallow angles against the edges already at either node.
    for (const node of [from, endNode])
      for (const id of this.nodes[node].edges) {
        const e = this.edges[id],
          o = this.nodes[this.other(e, node)];
        const here = this.nodes[node],
          far = node === from ? this.nodes[endNode] : start;
        const u = sub(o, here),
          v = sub(far, here);
        const angle = Math.acos(
          Math.max(
            -1,
            Math.min(
              1,
              (u.x * v.x + u.z * v.z) /
                ((Math.hypot(u.x, u.z) || 1) * (Math.hypot(v.x, v.z) || 1)),
            ),
          ),
        );
        if (angle < minAngle) return undefined;
      }
    if (this.degree(from) >= 4 || this.degree(endNode) >= 4) return undefined;
    this.addEdge(from, endNode, kind, bridge);
    return { node: endNode, severed };
  }
  /** Length of an edge. */
  length(e: GEdge) {
    return dist(this.nodes[e.a], this.nodes[e.b]);
  }
  /**
   * Collapse tiny edges, drop shallow arms and sliver blocks, join dead ends to a
   * road ahead, settle dead ends that stop beside another road, prune stubs, and keep one component. Each step can
   * expose work for another, so the steps repeat until the graph is stable.
   */
  cleanup(options: {
    minEdge: number;
    minStub: number;
    join?: { reach: number; canBuild: (a: Point, b: Point) => boolean };
    debug?: boolean;
  }) {
    const stats = { merged: 0, angle: 0, slivers: 0, joined: 0, ends: 0, stubs: 0 };
    const total = () => Object.values(stats).reduce((s, v) => s + v, 0);
    for (let round = 0; round < 6; round++) {
      const before = total();
      this.mergeClose(options.minEdge, stats);
      this.dropShallowArms(stats);
      this.dropSlivers(stats);
      if (options.join)
        stats.joined += this.joinDeadEnds(options.join.reach, options.join.canBuild);
      this.settleDeadEnds(stats, true);
      this.pruneStubs(options.minStub, stats);
      if (total() === before) break;
    }
    // Joined dead ends can close new slivers; settle without joining so this ends.
    for (let round = 0; round < 6; round++) {
      const before = total();
      this.mergeClose(options.minEdge, stats);
      this.dropSlivers(stats);
      this.settleDeadEnds(stats, false);
      this.pruneStubs(options.minStub, stats);
      if (total() === before) break;
    }
    for (const n of this.nodes) if (n.alive && n.edges.size === 0) n.alive = false;
    if (options.debug) console.error("cleanup", stats);
    // Keep the largest connected component.
    const component = new Int32Array(this.nodes.length).fill(-1),
      sizes: number[] = [];
    for (const n of this.nodes) {
      if (!n.alive || component[n.id] >= 0) continue;
      const id = sizes.length,
        stack = [n.id];
      component[n.id] = id;
      sizes.push(0);
      while (stack.length) {
        const c = stack.pop()!;
        sizes[id]++;
        for (const eid of this.nodes[c].edges) {
          const o = this.other(this.edges[eid], c);
          if (component[o] < 0) {
            component[o] = id;
            stack.push(o);
          }
        }
      }
    }
    let main = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
    for (const n of this.nodes)
      if (n.alive && component[n.id] !== main) this.removeNode(n.id);
  }
  /** Merge the two nodes of a removed connection into the better-connected one. */
  private mergeNodes(p: number, q: number) {
    const a = this.nodes[p],
      b = this.nodes[q];
    const keep = a.edges.size >= b.edges.size ? a : b,
      drop = keep === a ? b : a;
    for (const id of [...drop.edges]) {
      const other = this.edges[id],
        far = this.other(other, drop.id);
      this.removeEdge(id);
      if (far !== keep.id) this.addEdge(keep.id, far, other.kind, other.bridge);
    }
    drop.alive = false;
    // Lane generation needs at most four arms; shed the least important extras.
    while (keep.edges.size > 4) {
      const extra = [...keep.edges]
        .map((id) => this.edges[id])
        .filter((x) => !x.bridge)
        .sort(
          (p, q) =>
            ROAD_RANK[p.kind] - ROAD_RANK[q.kind] || this.length(p) - this.length(q),
        )[0];
      if (!extra) break;
      this.removeEdge(extra.id);
    }
  }
  private mergeClose(minEdge: number, stats: { merged: number }) {
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const e of this.edges) {
        if (!e.alive || e.bridge || this.length(e) >= minEdge) continue;
        this.removeEdge(e.id);
        this.mergeNodes(e.a, e.b);
        changed = true;
        stats.merged++;
      }
      // Junctions need room for both mouths and a crossing between them; closer
      // ones would overlap, so merge them even across intermediate bends.
      const graph = this.toRoadGraph(),
        builder = new Int32Array(graph.nodes.length),
        touched = new Set<number>();
      graph.nodeMap.forEach((id, node) => {
        if (id >= 0) builder[id] = node;
      });
      for (const e of graph.edges) {
        const a = builder[e.a],
          b = builder[e.b];
        if (e.bridge || a === b || touched.has(a) || touched.has(b)) continue;
        if (this.degree(a) < 3 || this.degree(b) < 3) continue;
        let widest = 0;
        for (const n of [a, b])
          for (const id of this.nodes[n].edges)
            widest = Math.max(widest, ROAD_WIDTH[this.edges[id].kind]);
        if (polylineLength(e.points) >= widest * 1.5) continue;
        for (const id of graph.segments[e.id]) this.removeEdge(id);
        for (const id of graph.segments[e.id])
          for (const n of [this.edges[id].a, this.edges[id].b])
            if (n !== a && n !== b) this.nodes[n].alive = false;
        this.mergeNodes(a, b);
        touched.add(a).add(b);
        changed = true;
        stats.merged++;
      }
      if (!changed) break;
    }
  }
  /** Shallow angles between arms make junctions unbuildable: drop the lesser arm. */
  private dropShallowArms(stats: { angle: number }) {
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const n of this.nodes) {
        if (!n.alive || n.edges.size < 2) continue;
        const arms = [...n.edges]
          .map((id) => {
            const e = this.edges[id],
              o = this.nodes[this.other(e, n.id)];
            return { e, ang: Math.atan2(o.z - n.z, o.x - n.x) };
          })
          .sort((p, q) => p.ang - q.ang);
        const limit = ((n.edges.size === 2 ? 50 : 45) * Math.PI) / 180;
        for (let i = 0; i < arms.length; i++) {
          const a = arms[i],
            b = arms[(i + 1) % arms.length];
          if (a === b) continue;
          let gap = b.ang - a.ang;
          if (gap <= 0) gap += Math.PI * 2;
          if (gap >= limit) continue;
          const lesser =
            ROAD_RANK[a.e.kind] !== ROAD_RANK[b.e.kind]
              ? ROAD_RANK[a.e.kind] < ROAD_RANK[b.e.kind]
                ? a
                : b
              : this.length(a.e) < this.length(b.e)
                ? a
                : b;
          if (lesser.e.bridge) continue;
          this.removeEdge(lesser.e.id);
          stats.angle++;
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
  }
  /** Prune short dead-end chains. */
  private pruneStubs(minStub: number, stats: { stubs: number }) {
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const n of this.nodes) {
        if (!n.alive || n.edges.size !== 1) continue;
        const chain: number[] = [],
          nodes: number[] = [n.id];
        let current = n.id,
          length = 0,
          guard = 0;
        for (;;) {
          const node = this.nodes[current];
          const next = [...node.edges].find((id) => !chain.includes(id));
          if (next === undefined || guard++ > 500) break;
          chain.push(next);
          length += this.length(this.edges[next]);
          current = this.other(this.edges[next], current);
          nodes.push(current);
          if (this.nodes[current].edges.size !== 2) break;
        }
        if (length < minStub && chain.length) {
          for (const id of chain) this.removeEdge(id);
          stats.stubs += chain.length;
          for (const id of nodes.slice(0, -1)) this.nodes[id].alive = false;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
  /**
   * Blocks too small to hold a lot once the roads and sidewalks are inset are
   * slivers between near-parallel roads or tiny triangles of crossing streets;
   * drop the least important road between each one and its neighbour.
   */
  private dropSlivers(stats: { slivers: number }) {
    const graph = this.toRoadGraph(),
      removed = new Set<number>();
    for (const face of planarFaces(graph)) {
      if (area(face.ring) > 8000) continue;
      if (face.edges.some((id) => graph.segments[id].some((s) => removed.has(s))))
        continue;
      let reach = 0;
      for (const id of face.edges) reach = Math.max(reach, graph.edges[id].width / 2);
      // The inset can fail on awkward but roomy outlines; then estimate the net area
      // from the outline (exact for convex blocks with rounded corners).
      const d = reach + KERB_CLEARANCE,
        inset = insetPolygon(face.ring, d),
        net = inset
          ? area(inset)
          : area(face.ring) - perimeter(face.ring) * d + Math.PI * d * d;
      if (net >= 300) continue;
      // An edge walked twice is a spur inside the face; removing it would split the graph.
      const victim = face.edges
        .filter((id) => face.edges.indexOf(id) === face.edges.lastIndexOf(id))
        .map((id) => graph.edges[id])
        .filter((e) => !e.bridge)
        .sort(
          (p, q) =>
            ROAD_RANK[p.kind] - ROAD_RANK[q.kind] ||
            polylineLength(q.points) - polylineLength(p.points),
        )[0];
      if (!victim) continue;
      for (const id of graph.segments[victim.id]) {
        this.removeEdge(id);
        removed.add(id);
      }
      stats.slivers++;
    }
    // A ring road leaving and re-entering one junction encloses its own block.
    for (const e of graph.edges) {
      if (e.a !== e.b || e.bridge) continue;
      if (graph.segments[e.id].some((id) => removed.has(id))) continue;
      const d = e.width / 2 + KERB_CLEARANCE,
        net = area(e.points) - polylineLength(e.points) * d + Math.PI * d * d;
      if (net >= 300) continue;
      for (const id of graph.segments[e.id]) {
        this.removeEdge(id);
        removed.add(id);
      }
      stats.slivers++;
    }
    for (const n of this.nodes) if (n.alive && n.edges.size === 0) n.alive = false;
  }
  /**
   * A dead end needs room for its turning circle. One that stops beside another
   * road is extended into it when that junction is valid, else cut back a segment
   * at a time until it clears.
   */
  private settleDeadEnds(stats: { ends: number }, join: boolean) {
    for (let pass = 0; pass < 40; pass++) {
      let changed = false;
      for (const n of this.nodes) {
        if (!n.alive || n.edges.size !== 1) continue;
        const e = this.edges[[...n.edges][0]];
        if (e.bridge) continue;
        const o = this.nodes[this.other(e, n.id)];
        let nearest = Infinity;
        for (const id of this.edgesNear(n.x, n.z, n.x, n.z, 40)) {
          const f = this.edges[id];
          if (f.a === n.id || f.b === n.id || f.a === o.id || f.b === o.id) continue;
          const { point } = closestOnSegment(n, this.nodes[f.a], this.nodes[f.b]);
          nearest = Math.min(nearest, dist(n, point) - ROAD_WIDTH[f.kind] / 2);
        }
        // Turning circle plus both sidewalks and a verge between them.
        if (nearest >= ROAD_WIDTH[e.kind] / 2 + 4.5 + 2 * KERB_CLEARANCE) continue;
        const dir = sub(n, o),
          l = Math.hypot(dir.x, dir.z) || 1,
          reach = nearest + ROAD_WIDTH.highway;
        const joined =
          join &&
          this.insert(
            n.id,
            { x: n.x + (dir.x / l) * reach, z: n.z + (dir.z / l) * reach },
            e.kind,
            { snap: 10 },
          );
        changed = true;
        stats.ends++;
        if (joined && this.degree(joined.node) >= 2) continue;
        if (joined) this.removeNode(joined.node);
        this.removeEdge(e.id);
        n.alive = false;
      }
      if (!changed) break;
    }
  }
  /**
   * Joins dead ends to a road up to `reach` ahead: straight on first, then the
   * nearest point within 60° of the heading. `canBuild` vetoes connectors over
   * water or steep ground; ends with no valid connector stay as they are.
   */
  joinDeadEnds(reach: number, canBuild: (a: Point, b: Point) => boolean) {
    let joined = 0;
    for (const n of this.nodes) {
      if (!n.alive || n.edges.size !== 1) continue;
      const e = this.edges[[...n.edges][0]];
      if (e.bridge) continue;
      const o = this.nodes[this.other(e, n.id)],
        dir = sub(n, o),
        l = Math.hypot(dir.x, dir.z) || 1,
        targets = [{ x: n.x + (dir.x / l) * reach, z: n.z + (dir.z / l) * reach }],
        ahead: { point: Point; d: number }[] = [];
      for (const id of this.edgesNear(n.x, n.z, n.x, n.z, reach)) {
        const f = this.edges[id];
        if (f.a === n.id || f.b === n.id || f.a === o.id || f.b === o.id || f.bridge)
          continue;
        const { point } = closestOnSegment(n, this.nodes[f.a], this.nodes[f.b]),
          d = dist(n, point);
        if (
          d > 1 &&
          d <= reach &&
          (point.x - n.x) * dir.x + (point.z - n.z) * dir.z > d * l * 0.5
        )
          ahead.push({ point, d });
      }
      targets.push(...ahead.sort((p, q) => p.d - q.d).map((t) => t.point));
      for (const target of targets) {
        const result = this.insert(n.id, target, e.kind, { snap: 8 });
        if (!result || result.node === o.id) continue;
        const end = this.nodes[result.node];
        // Only a connector that lands on the network and stays buildable is kept.
        if (end.edges.size >= 2 && canBuild(n, end)) {
          joined++;
          break;
        }
        for (const id of [...n.edges])
          if (this.other(this.edges[id], n.id) === end.id) this.removeEdge(id);
        if (end.edges.size === 0) end.alive = false;
      }
    }
    return joined;
  }
  /** Segments that pass over a river channel become bridges. */
  bridgeRivers(rivers: { points: Point[]; widths: number[] }[]) {
    for (const e of this.edges) {
      if (!e.alive || e.bridge) continue;
      const a = this.nodes[e.a],
        b = this.nodes[e.b];
      e.bridge = rivers.some((river) =>
        river.points.some((p, i) => {
          if (i === 0) return false;
          const q = river.points[i - 1],
            reach = Math.max(river.widths[i], river.widths[i - 1]) / 2 + 1;
          return (
            !!segmentIntersection(a, b, q, p) ||
            dist(closestOnSegment(p, a, b).point, p) < reach ||
            dist(closestOnSegment(a, q, p).point, a) < reach ||
            dist(closestOnSegment(b, q, p).point, b) < reach
          );
        }),
      );
    }
  }
  /** Merge degree-2 chains of equal kind into polyline edges with a compact id space. */
  toRoadGraph(): RoadGraph & { nodeMap: Int32Array; segments: number[][] } {
    const chains: {
      kind: RoadKind;
      bridge: boolean;
      nodes: number[];
      segments: number[];
    }[] = [];
    const used = new Uint8Array(this.edges.length);
    const continuous = (node: number) => {
      const n = this.nodes[node];
      if (n.edges.size !== 2) return false;
      const [p, q] = [...n.edges].map((id) => this.edges[id]);
      return p.kind === q.kind && p.bridge === q.bridge;
    };
    for (const e of this.edges) {
      if (!e.alive || used[e.id]) continue;
      // Walk back to the chain start.
      let startNode = e.a,
        startEdge = e;
      const seen = new Set<number>([e.id]);
      while (continuous(startNode)) {
        const prev = [...this.nodes[startNode].edges]
          .map((id) => this.edges[id])
          .find((x) => x !== startEdge)!;
        if (seen.has(prev.id)) break;
        seen.add(prev.id);
        startEdge = prev;
        startNode = this.other(prev, startNode);
      }
      const nodes = [startNode],
        segments: number[] = [];
      let current = startNode,
        edge = startEdge;
      for (;;) {
        used[edge.id] = 1;
        segments.push(edge.id);
        current = this.other(edge, current);
        nodes.push(current);
        if (!continuous(current)) break;
        const next = [...this.nodes[current].edges]
          .map((id) => this.edges[id])
          .find((x) => x !== edge)!;
        if (used[next.id]) break;
        edge = next;
      }
      chains.push({ kind: e.kind, bridge: e.bridge, nodes, segments });
    }
    const nodeMap = new Int32Array(this.nodes.length).fill(-1),
      nodes: RoadGraph["nodes"] = [];
    const mapNode = (id: number) => {
      if (nodeMap[id] < 0) {
        nodeMap[id] = nodes.length;
        nodes.push({
          id: nodes.length,
          x: this.nodes[id].x,
          z: this.nodes[id].z,
          y: 0,
          edges: [],
        });
      }
      return nodeMap[id];
    };
    const edges: RoadGraph["edges"] = [];
    for (const chain of chains) {
      const a = mapNode(chain.nodes[0]),
        b = mapNode(chain.nodes[chain.nodes.length - 1]);
      const edge = {
        id: edges.length,
        a,
        b,
        kind: chain.kind,
        width: ROAD_WIDTH[chain.kind],
        bridge: chain.bridge,
        points: chain.nodes.map((id) => ({ x: this.nodes[id].x, z: this.nodes[id].z })),
        heights: [],
      };
      edges.push(edge);
      nodes[a].edges.push(edge.id);
      nodes[b].edges.push(edge.id);
    }
    return { nodes, edges, nodeMap, segments: chains.map((c) => c.segments) };
  }
}

/**
 * Planar faces of the final graph (cp-algorithms angular walk). Returns rings of
 * world points with the bounding edge ids; the outer face is dropped by area sign.
 */
export function planarFaces(graph: RoadGraph) {
  type Half = { edge: number; from: number; to: number; points: Point[] };
  const outgoing = new Map<number, Half[]>();
  for (const e of graph.edges) {
    const forward: Half = { edge: e.id, from: e.a, to: e.b, points: e.points };
    const backward: Half = {
      edge: e.id,
      from: e.b,
      to: e.a,
      points: [...e.points].reverse(),
    };
    for (const h of [forward, backward]) {
      const list = outgoing.get(h.from);
      if (list) list.push(h);
      else outgoing.set(h.from, [h]);
    }
  }
  const angleOf = (h: Half) => {
    const p = h.points[0],
      q = h.points[1];
    return Math.atan2(q.z - p.z, q.x - p.x);
  };
  for (const list of outgoing.values()) list.sort((a, b) => angleOf(a) - angleOf(b));
  const used = new Set<string>(),
    faces: { ring: Point[]; edges: number[] }[] = [];
  const key = (h: Half) => `${h.edge}:${h.from}`;
  for (const list of outgoing.values())
    for (const start of list) {
      if (used.has(key(start))) continue;
      const ring: Point[] = [],
        edges: number[] = [];
      let h = start,
        guard = 0;
      while (!used.has(key(h)) && guard++ < 10000) {
        used.add(key(h));
        edges.push(h.edge);
        for (let i = 0; i < h.points.length - 1; i++) ring.push(h.points[i]);
        const arrivals = outgoing.get(h.to)!;
        // Reverse direction of arrival, then take the next edge clockwise so that
        // bounded faces are traversed with the interior on the left.
        const back = h.points[h.points.length - 2],
          tip = h.points[h.points.length - 1];
        const incoming = Math.atan2(back.z - tip.z, back.x - tip.x);
        let next = arrivals[0],
          bestDelta = Infinity;
        for (const cand of arrivals) {
          let delta = incoming - angleOf(cand);
          while (delta <= 1e-9) delta += Math.PI * 2;
          while (delta > Math.PI * 2 + 1e-9) delta -= Math.PI * 2;
          if (cand.edge === h.edge && arrivals.length > 1) delta += Math.PI * 2;
          if (delta < bestDelta) {
            bestDelta = delta;
            next = cand;
          }
        }
        h = next;
      }
      if (ring.length >= 3 && signedArea(ring) > 0) faces.push({ ring, edges });
    }
  return faces;
}
export const turnsLeft = (a: Point, b: Point, c: Point) =>
  cross(sub(b, a), sub(c, b)) > 0;
