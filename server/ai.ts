import { staticGeometry } from "../shared/physics/static.ts";
import type { City } from "../shared/world.ts";
import { signal, type Entity } from "../shared/world.ts";
import { clamp, wrap, type Drive } from "../shared/physics/index.ts";
import { Citizens, type Intent } from "./citizens.ts";
import { rayDistance, buildingBox } from "../shared/physics/collision.ts";
import { Navigation, type Waypoint } from "../shared/navigation.ts";
import { VEHICLES, DEFAULT_MODELS } from "../shared/catalog.ts";
import { LIMIT } from "../shared/world.ts";
import { isWater, watercraft, WATER_LEVEL } from "../shared/water.ts";
type Point = Waypoint;
interface Route {
  points: Point[];
  index: number;
  progress: number;
  last: Point;
  destination: number;
  /** Car routes: the node before `destination`, so the next leg can curve there. */
  previous?: number;
  trip: number;
  crossing: boolean;
  routine?: {
    stops: [home: number, work: number, leisure: number];
    goal: number;
    waiting: boolean;
    until: number;
  };
  reacting?: boolean;
  waitingAtSignal: boolean;
}
export class CityAI {
  citizens = new Citizens();
  private detours = new WeakMap<
    Entity,
    { goal: number; destination: Point; points: Point[]; index: number }
  >();
  constructor(
    readonly navigation: Navigation,
    readonly city: City,
  ) {}

  private nearestSidewalk(point: Point) {
    let nearest = this.navigation.sidewalks[0],
      distance = Infinity;
    for (const node of this.navigation.sidewalks) {
      const squared = (node.x - point.x) ** 2 + (node.z - point.z) ** 2;
      if (squared < distance) {
        nearest = node;
        distance = squared;
      }
    }
    return nearest.id;
  }
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
      previous: from,
      trip,
      crossing: false,
      waitingAtSignal: false,
    });
    this.extendCar(this.routes.get(e.id)!);
  }
  /**
   * Plan a car's next leg while it still drives toward the last point of this one,
   * so a junction where the legs meet keeps its signal approach and stop line.
   */
  private extendCar(route: Route) {
    if (route.previous === undefined) return;
    let goal = ((route.trip + 1) * 17 + 3) % this.navigation.roads.length;
    if (goal === route.destination) goal = (goal + 1) % this.navigation.roads.length;
    const ids = this.navigation.roadPath(route.destination, goal);
    if (ids.length < 2) return;
    route.points = [
      ...route.points.slice(route.index, route.points.length - 1),
      ...this.navigation.lanePath([route.previous, ...ids]),
    ];
    route.index = 0;
    route.previous = ids[ids.length - 2];
    route.destination = goal;
    route.trip++;
  }
  assign(e: Entity, index: number, relocate = true) {
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
      const corner = relocate
          ? (index * 31) % this.navigation.sidewalks.length
          : this.nearestSidewalk(e),
        a = this.navigation.sidewalks[corner];
      destination = corner;
      points = [{ x: a.x, z: a.z }];
      if (relocate) {
        // Spread neighbours along the sidewalk instead of stepping onto the road.
        const next =
            this.navigation.sidewalks[a.edges.find((l) => !l.crossing)?.id ?? a.id],
          dx = next.x - a.x,
          dz = next.z - a.z,
          length = Math.hypot(dx, dz) || 1,
          step = Math.min(length / 2, (index % 3) * 1.3);
        e.x = a.x + (dx / length) * step;
        e.z = a.z + (dz / length) * step;
        e.angle = 0;
      }
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
      routine: {
        stops: [
          destination,
          this.nearestSidewalk(
            this.city.buildings[(index * 13) % this.city.buildings.length] ??
              this.navigation.sidewalks[
                (index * 17 + 1) % this.navigation.sidewalks.length
              ],
          ),
          this.nearestSidewalk(
            this.city.parks[index % this.city.parks.length] ??
              this.navigation.sidewalks[
                (index * 31 + 3) % this.navigation.sidewalks.length
              ],
          ),
        ],
        goal: 0,
        waiting: false,
        until: 0,
      },
      waitingAtSignal: false,
    });
  }
  target(e: Entity, dt: number, time = 0) {
    const route = this.routes.get(e.id);
    if (!route) return;
    if (route.routine?.waiting) {
      if (time < route.routine.until) return;
      route.routine.waiting = false;
      route.routine.goal = (route.routine.goal + 1) % 3;
      const goal = route.routine.stops[route.routine.goal];
      route.points = this.navigation.sidewalkPath(route.destination, goal);
      // Disconnected destinations must not strand a citizen or lie about its position.
      if (route.points.length) route.destination = goal;
      else route.points = [{ ...this.navigation.sidewalks[route.destination] }];
      route.index = 0;
    }
    let target = route.points[route.index];
    if (!target) return;
    if (Math.hypot(target.x - e.x, target.z - e.z) < (e.kind === "car" ? 4 : 0.9)) {
      route.index++;
      route.crossing = false;
      if (e.kind === "car" && route.index === route.points.length - 1)
        this.extendCar(route);
      if (route.index >= route.points.length) {
        route.trip++;
        if (e.kind === "car") {
          let goal = (route.trip * 17 + 3) % this.navigation.roads.length;
          if (goal === route.destination)
            goal = (goal + 1) % this.navigation.roads.length;
          const ids = this.navigation.roadPath(route.destination, goal);
          route.points = this.navigation.lanePath(ids);
          route.previous = ids[ids.length - 2];
          route.destination = goal;
        } else if (route.routine) {
          route.routine.waiting = true;
          route.routine.until =
            time +
            (this.citizens.state(e).personality === "restless" ? 2 : 6) +
            (route.trip % 5);
          return;
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
    const reaction = this.citizens.reaction(e, time);
    if (reaction.kind === "exit")
      return { throttle: 0, steer: 0, brake: false, serviceBrake: 1 };
    const data = this.target(e, dt, time);
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
    // Stop at the junction's own stop line where known; legacy maps use 10 m.
    const line = junction?.stop ?? 10,
      remaining = ahead - line;
    const stop =
      !!junction &&
      side < 12 &&
      ahead > line - 1 &&
      ahead < line + 14 &&
      signal(time, junction.axis) !== "green";
    const personality = this.citizens.state(e).personality;
    const cruise =
      reaction.kind === "drive"
        ? 13
        : personality === "calm" || personality === "timid"
          ? 7
          : 9;
    let desiredSpeed = Math.abs(error) > 0.25 ? 4 : cruise;
    data.route.waitingAtSignal = stop;
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
    time: number,
    all: Map<string, Entity>,
  ): Intent {
    const reaction = this.citizens.intent(e, entities, all, time, this.city);
    const route = this.routes.get(e.id);
    if (reaction && route) route.reacting = true;
    if (!reaction && route?.reacting) {
      // Rejoin the nearest sidewalk after a chase instead of crossing a block to an old waypoint.
      const start = this.nearestSidewalk(e);
      route.points = [
        this.navigation.sidewalks[start],
        ...this.navigation.sidewalkPath(start, route.destination),
      ];
      route.index = 0;
      route.crossing = false;
      route.reacting = false;
      if (route.routine) route.routine.waiting = false;
    }
    const data = reaction ? undefined : this.target(e, dt, time);
    let intent: Intent = reaction ?? { x: 0, z: 0, sprint: false };
    if (data) {
      let waiting = false;
      if (data.target.crossing && !data.route.crossing) {
        waiting =
          signal(time, data.target.crossing) !== "red" ||
          entities.some(
            (v) => v.kind === "car" && Math.hypot(v.x - e.x, v.z - e.z) < 8,
          );
        if (!waiting) data.route.crossing = true;
      }
      if (!waiting)
        intent = { x: data.target.x - e.x, z: data.target.z - e.z, sprint: false };
    }
    let length = Math.hypot(intent.x, intent.z);
    if (!length) return intent;
    if (reaction && intent.attack === undefined) {
      const distance = Math.min(30, Math.max(10, length));
      const dx = intent.x / length,
        dz = intent.z / length;
      const blocked = staticGeometry(this.city)
        .query(e.x + (dx * distance) / 2, e.z + (dz * distance) / 2, distance / 2 + 2)
        .some(
          (b) =>
            !b.obstacle &&
            e.y < b.h + 1.8 &&
            rayDistance(e.x, e.z, dx, dz, buildingBox(b), distance) < distance,
        );
      if (blocked) {
        const destination = { x: e.x + dx * distance, z: e.z + dz * distance };
        let detour = this.detours.get(e);
        if (
          !detour ||
          Math.hypot(
            destination.x - detour.destination.x,
            destination.z - detour.destination.z,
          ) > 8
        ) {
          const goal = this.nearestSidewalk(destination);
          if (!detour || detour.goal !== goal) {
            const start = this.nearestSidewalk(e);
            detour = {
              goal,
              destination,
              points: [
                this.navigation.sidewalks[start],
                ...this.navigation.sidewalkPath(start, goal),
              ],
              index: 0,
            };
            this.detours.set(e, detour);
          } else detour.destination = destination;
        }
        while (
          detour.points[detour.index] &&
          Math.hypot(
            detour.points[detour.index].x - e.x,
            detour.points[detour.index].z - e.z,
          ) < 0.9
        )
          detour.index++;
        const waypoint = detour.points[detour.index];
        if (waypoint) intent = { ...intent, x: waypoint.x - e.x, z: waypoint.z - e.z };
      } else this.detours.delete(e);
      length = Math.hypot(intent.x, intent.z);
      if (!length) return intent;
    }
    const x = intent.x / length,
      z = intent.z / length;
    const obstacles = staticGeometry(this.city).query(e.x, e.z, 5);
    // Citizens on land treat the shoreline as a wall, so fleeing or dodging never
    // runs them into the sea; one already in the water may head anywhere.
    const ashore = !isWater(e.x, e.z, this.city);
    const clear = (dx: number, dz: number) =>
      !(ashore && isWater(e.x + dx * 3, e.z + dz * 3, this.city)) &&
      obstacles.every(
        (b) =>
          e.y >= b.h + (b.obstacle ? 0 : 1.8) ||
          rayDistance(
            e.x,
            e.z,
            dx,
            dz,
            { ...buildingBox(b), w: b.w / 2 + 0.6, d: b.d / 2 + 0.6 },
            3,
          ) >= 3,
      );
    if (clear(x, z)) return { ...intent, x, z };
    for (const turn of [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
      const dx = x * Math.cos(turn) - z * Math.sin(turn),
        dz = x * Math.sin(turn) + z * Math.cos(turn);
      if (clear(dx, dz)) return { ...intent, x: dx, z: dz, attack: undefined };
    }
    return { x: 0, z: 0, sprint: false };
  }
}
