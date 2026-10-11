import { staticGeometry } from "../shared/physics/static.ts";
import type { City } from "../shared/world.ts";
import { signal, type Entity, type Input } from "../shared/world.ts";
import { clamp, wrap, type Drive } from "../shared/physics/index.ts";
import { Navigation, type Waypoint } from "../shared/navigation.ts";
import { VEHICLES, DEFAULT_MODELS } from "../shared/catalog.ts";
import { LIMIT } from "../shared/world.ts";
import { watercraft, WATER_LEVEL } from "../shared/water.ts";
type Point = Waypoint;
interface Route {
  points: Point[];
  index: number;
  progress: number;
  last: Point;
  destination: number;
  trip: number;
  crossing: boolean;
}
export class CityAI {
  constructor(readonly navigation: Navigation) {}
  props: { x: number; z: number }[] = [];
  routes = new Map<string, Route>();
  waterRoutes = new Map<string, { points: Point[]; index: number }>();
  assignWatercraft(e: Entity, index: number) {
    const coast = LIMIT + 76 + (index % 3) * 22;
    const points = [
      { x: -coast, z: -coast },
      { x: coast, z: -coast },
      { x: coast, z: coast },
      { x: -coast, z: coast },
    ];
    if (index % 2) points.reverse();
    const start = index % 4,
      a = points[start],
      b = points[(start + 1) % 4];
    const fraction = index < 4 ? 0.55 : 0.7;
    e.x = a.x + (b.x - a.x) * fraction;
    e.z = a.z + (b.z - a.z) * fraction;
    e.y = WATER_LEVEL;
    e.angle = Math.atan2(b.x - a.x, b.z - a.z);
    e.ai = true;
    this.waterRoutes.set(e.id, { points, index: (start + 1) % 4 });
  }
  watercraft(e: Entity, entities: Entity[]): Drive {
    const route = this.waterRoutes.get(e.id);
    if (!route || !watercraft(e.kind)) return { throttle: 0, steer: 0, brake: false };
    if (
      Math.hypot(route.points[route.index].x - e.x, route.points[route.index].z - e.z) <
      24
    )
      route.index = (route.index + 1) % route.points.length;
    const target = route.points[route.index],
      model = VEHICLES[e.model || DEFAULT_MODELS[e.kind]];
    if (!("water" in model)) return { throttle: 0, steer: 0, brake: false };
    const error = wrap(Math.atan2(target.x - e.x, target.z - e.z) - e.angle);
    let desired = Math.abs(error) > 0.3 ? 4 : model.water.cruise;
    for (const other of entities) {
      if (other.id === e.id || !watercraft(other.kind)) continue;
      const x = other.x - e.x,
        z = other.z - e.z;
      const ahead = x * Math.sin(e.angle) + z * Math.cos(e.angle);
      const side = x * Math.cos(e.angle) - z * Math.sin(e.angle);
      if (ahead > 0 && ahead < 24 && Math.abs(side) < 4)
        desired = Math.min(desired, Math.max(0, ahead - 10) * 0.5);
    }
    const forward = e.vx * Math.sin(e.angle) + e.vz * Math.cos(e.angle);
    return {
      throttle: clamp((desired - forward) * 0.7, 0, 1),
      steer: clamp(error * 1.8 - (e.angularVelocity || 0) * 0.4, -1, 1),
      brake: forward > desired + 1,
    };
  }
  assignCar(e: Entity, from: number, to: number, fraction: number, trip: number) {
    const a = this.navigation.roads[from],
      b = this.navigation.roads[to];
    const dx = (b.x - a.x) / Math.hypot(b.x - a.x, b.z - a.z),
      dz = (b.z - a.z) / Math.hypot(b.x - a.x, b.z - a.z);
    const target = this.navigation.lanePoint(from, to);
    e.x = a.x + (b.x - a.x) * fraction + dz * 3.5;
    e.z = a.z + (b.z - a.z) * fraction - dx * 3.5;
    e.angle = Math.atan2(dx, dz);
    e.ai = true;
    this.routes.set(e.id, {
      points: [target],
      index: 0,
      progress: 0,
      last: { x: e.x, z: e.z },
      destination: to,
      trip,
      crossing: false,
    });
  }
  assign(e: Entity, index: number) {
    const node = (index * 17) % this.navigation.roads.length;
    let points: Point[], destination: number;
    if (e.kind === "car") {
      const fraction = 0.25 + ((index * 17) % 40) / 100;
      this.assignCar(
        e,
        node,
        this.navigation.roads[node].edges[
          index % this.navigation.roads[node].edges.length
        ],
        fraction,
        index,
      );
      return;
    } else {
      const corner = (index * 31) % this.navigation.sidewalks.length,
        a = this.navigation.sidewalks[corner];
      destination = corner;
      points = [{ x: a.x, z: a.z }];
      e.x = a.x;
      e.z = a.z + (index % 3) * 1.3;
      e.angle = 0;
    }
    e.ai = true;
    this.routes.set(e.id, {
      points,
      index: 0,
      progress: 0,
      last: { x: e.x, z: e.z },
      destination,
      trip: index,
      crossing: false,
    });
  }
  target(e: Entity, dt: number) {
    const route = this.routes.get(e.id);
    if (!route) return;
    let target = route.points[route.index];
    if (Math.hypot(target.x - e.x, target.z - e.z) < (e.kind === "car" ? 4 : 0.9)) {
      route.index++;
      route.crossing = false;
      if (route.index >= route.points.length) {
        route.trip++;
        if (e.kind === "car") {
          let goal = (route.trip * 17 + 3) % this.navigation.roads.length;
          if (goal === route.destination)
            goal = (goal + 1) % this.navigation.roads.length;
          const ids = this.navigation.roadPath(route.destination, goal);
          route.points = ids
            .slice(1)
            .map((id, i) => this.navigation.lanePoint(ids[i], id));
          route.destination = goal;
        } else {
          let goal = (route.trip * 31 + 7) % this.navigation.sidewalks.length;
          if (goal === route.destination)
            goal = (goal + 1) % this.navigation.sidewalks.length;
          route.points = this.navigation.sidewalkPath(route.destination, goal);
          route.destination = goal;
        }
        route.index = 0;
      }
      target = route.points[route.index];
    }
    if (!target) return;
    if (Math.hypot(e.x - route.last.x, e.z - route.last.z) > 2) {
      route.progress = 0;
      route.last = { x: e.x, z: e.z };
    } else route.progress += dt;
    return { target, route };
  }
  car(e: Entity, entities: Entity[], time: number, dt: number): Drive {
    const data = this.target(e, dt);
    if (!data) return { throttle: 0, steer: 0, brake: false };
    const dx = data.target.x - e.x,
      dz = data.target.z - e.z,
      desired = Math.atan2(dx, dz),
      error = wrap(desired - e.angle);
    const speed = Math.hypot(e.vx, e.vz);
    const junction = data.target.junction;
    const ahead = junction
      ? (junction.x - e.x) * Math.sin(e.angle) + (junction.z - e.z) * Math.cos(e.angle)
      : Infinity;
    const side = junction
      ? Math.abs(
          (junction.x - e.x) * Math.cos(e.angle) -
            (junction.z - e.z) * Math.sin(e.angle),
        )
      : Infinity;
    const remaining = ahead - 10;
    const stop =
      !!junction &&
      side < 12 &&
      ahead > 9 &&
      ahead < 24 &&
      signal(time, junction.axis) !== "green";
    let desiredSpeed = Math.abs(error) > 0.25 ? 4 : 8;
    if (stop) desiredSpeed = Math.min(desiredSpeed, Math.max(0, remaining - 1) * 0.8);
    for (const other of entities) {
      if (
        other.id === e.id ||
        other.vehicle ||
        other.kind !== "car" ||
        Math.abs(other.y - e.y) > 2
      )
        continue;
      const x = other.x - e.x,
        z = other.z - e.z,
        ahead = x * Math.sin(e.angle) + z * Math.cos(e.angle),
        side = x * Math.cos(e.angle) - z * Math.sin(e.angle);
      if (ahead > 0 && ahead < 14 && Math.abs(side) < 2.1)
        desiredSpeed = Math.min(desiredSpeed, Math.max(0, ahead - 5) * 0.9);
    }
    // Reverse out of a collision rather than permanently abandoning the lane.
    if (data.route.progress > 13 && !stop) {
      if (data.route.progress > 16) data.route.progress = 0;
      return { throttle: -0.4, steer: -clamp(error, -1, 1), brake: false };
    }
    return {
      throttle: speed < desiredSpeed ? 0.65 : 0,
      steer: clamp(error * 2 - (e.angularVelocity || 0) * 0.5, -1, 1),
      brake: false,
      serviceBrake:
        speed > desiredSpeed ? clamp((speed - desiredSpeed) * 0.6, 0, 1) : 0,
    };
  }
  pedestrian(
    e: Entity,
    entities: Entity[],
    dt: number,
    time = 0,
    city?: City,
  ): { x: number; z: number; sprint: boolean } {
    const data = this.target(e, dt);
    if (!data) return { x: 0, z: 0, sprint: false };
    if (data.target.crossing && !data.route.crossing) {
      if (signal(time, data.target.crossing) !== "red")
        return { x: 0, z: 0, sprint: false };
      if (
        entities.some((v) => v.kind === "car" && Math.hypot(v.x - e.x, v.z - e.z) < 8)
      )
        return { x: 0, z: 0, sprint: false };
      data.route.crossing = true;
    }
    let x = data.target.x - e.x,
      z = data.target.z - e.z;
    const length = Math.hypot(x, z) || 1;
    x /= length;
    z /= length;
    for (const p of city
      ? staticGeometry(city)
          .query(e.x, e.z, 2)
          .filter((p) => p.obstacle)
      : this.props) {
      const dx = p.x - e.x,
        dz = p.z - e.z,
        d = Math.hypot(dx, dz);
      if (d < 2 && dx * x + dz * z > 0) {
        if (Math.abs(z) > 0.5) x += 2;
        else z -= 2;
      }
    }
    let flee = false;
    for (const v of entities) {
      if (v.kind !== "car" || v.y > 2) continue;
      const dx = e.x - v.x,
        dz = e.z - v.z,
        d = Math.hypot(dx, dz);
      if (d < 7 && Math.hypot(v.vx, v.vz) > 3) {
        x += (dx / Math.max(d, 0.1)) * 2;
        z += (dz / Math.max(d, 0.1)) * 2;
        flee = true;
      }
    }
    return { x, z, sprint: flee };
  }
}
