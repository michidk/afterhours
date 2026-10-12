import { PHYSIQUES } from "../character.ts";
import { staticGeometry } from "./static.ts";
import { fallAircraft } from "./abandoned-aircraft.ts";
import { JETPACK, jetpackThrust } from "./jetpack.ts";
import { idle, inputX, inputY, type City, type Entity, type Input } from "../world.ts";
import {
  groundLevel,
  isWater,
  WATER_LEVEL,
  watercraft,
  resolveWorldBounds,
} from "../water.ts";
import { watercraftForces } from "./watercraft.ts";
import { TUNING, VEHICLES } from "../catalog.ts";
import { flyPlane } from "./plane.ts";
import { carForces, clamp, wrap } from "./vehicle.ts";
import { flyHelicopter } from "./helicopter.ts";
import { carAltitude, carGrounded, rampContacts } from "./ramps.ts";
import {
  entityBox,
  buildingBox,
  insideBuilding,
  contact,
  collisionPairs,
  resolveContact,
  vehicle,
} from "./collision.ts";
export function characterForces(
  e: Entity,
  input: Input,
  dt: number,
  direction?: { x: number; z: number; speed: number },
  city?: City,
) {
  let x = direction?.x ?? inputX(input),
    z = direction?.z ?? inputY(input);
  const length = Math.hypot(x, z),
    speed =
      direction?.speed ??
      (e.parachute
        ? 6
        : e.jetpack?.active && e.jetpack.fuel > 0 && e.y > 0.2 && !e.vehicle && !e.down
          ? JETPACK.speed
          : isWater(e.x, e.z, city) && e.y <= WATER_LEVEL + 0.1
            ? 2.8
            : input.sprint || input.brake
              ? TUNING.sprint * PHYSIQUES[e.character?.physique ?? "regular"].speed
              : TUNING.walk * PHYSIQUES[e.character?.physique ?? "regular"].speed);
  if (length) {
    x = (x / length) * speed;
    z = (z / length) * speed;
  }
  e.aim = input.aim;
  if (length)
    e.angle = wrap(
      e.angle + clamp(wrap(Math.atan2(x, z) - e.angle), -14 * dt, 14 * dt),
    );
  const dx = x - e.vx,
    dz = z - e.vz,
    d = Math.hypot(dx, dz),
    change = (e.parachute ? 8 : length ? TUNING.acceleration : TUNING.braking) * dt;
  if (d > 0) {
    e.vx += dx * Math.min(1, change / d);
    e.vz += dz * Math.min(1, change / d);
  }
}
// Only roofs under the character's feet can support it. A wall beside a
// descending player must never pull them upward onto its roof.
export function characterAltitude(
  e: Entity,
  city: City,
  dt: number,
  input: Input = idle(),
) {
  let floor = groundLevel(e.x, e.z, city);
  // The quay's shallow step is traversable from swimming height.
  if (floor === 0 && e.y >= WATER_LEVEL - 0.02 && e.y < 0) e.y = 0;
  for (const b of staticGeometry(city).query(e.x, e.z, 1)) {
    const roof = b.h + 1.8;
    if (!b.obstacle && roof <= e.y + 0.02 && insideBuilding(b, e.x, e.z))
      floor = Math.max(floor, roof);
  }
  if (jetpackThrust(e, input, dt, floor)) return;
  if (e.y > floor + 0.02) {
    // Walking off a roof is also a safe descent, rather than an invisible fall.
    if (e.kind === "player" && e.y - floor > 1.5) e.parachute = true;
    e.vy = e.parachute
      ? clamp(e.vy + (-4 - e.vy) * (1 - Math.exp(-5 * dt)), -4, 0)
      : e.vy - 18 * dt;
    e.y = Math.max(floor, e.y + e.vy * dt);
  }
  if (e.y <= floor + 0.02) {
    e.y = floor;
    e.vy = 0;
    e.parachute = undefined;
  }
}
/** Private, finite-mass neighbours. Never apply speculative impulses to snapshots. */
export function predictionWorld(e: Entity, nearby: Entity[]) {
  return nearby
    .filter(
      (b) =>
        b.id !== e.id &&
        !b.vehicle &&
        (vehicle(b) || b.health > 0) &&
        // Cover closing motion at 52 m/s each over the bounded prediction horizon.
        Math.hypot(b.x - e.x, b.z - e.z) < 40,
    )
    .map((b) => structuredClone(b));
}
export function predictStep(
  e: Entity,
  input: Input,
  city: City,
  nearby: Entity[],
  dt: number,
  shadows = predictionWorld(e, nearby),
  contacts?: Set<string>,
) {
  const count = Math.ceil(dt / TUNING.physicsStep),
    h = dt / count;
  const bodies = [e, ...shadows];
  for (let i = 0; i < count; i++) {
    if (e.down || e.wreck) return;
    const previous = { ...e };
    if (!vehicle(e)) characterForces(e, input, h, undefined, city);
    else if (e.kind === "car") {
      carForces(
        e,
        {
          throttle: inputY(input),
          steer: inputX(input),
          brake: input.brake,
        },
        h,
        carGrounded(e, city),
      );
    } else if (watercraft(e.kind))
      watercraftForces(
        e,
        {
          throttle: inputY(input),
          steer: inputX(input),
          brake: input.brake,
        },
        h,
      );
    else if (
      !e.driver &&
      (e.y > groundLevel(e.x, e.z, city) + 0.2 || e.flight === "falling")
    )
      fallAircraft(e, city, h);
    else if (e.kind === "helicopter") flyHelicopter(e, input, city, nearby, h);
    else if (e.kind === "plane") flyPlane(e, input, h, city);
    const speed = Math.hypot(e.vx, e.vz),
      limit = e.model ? VEHICLES[e.model].speed : 52;
    if (vehicle(e) && speed > limit) {
      e.vx *= limit / speed;
      e.vz *= limit / speed;
    }
    e.x += e.vx * h;
    e.z += e.vz * h;
    if (e.kind === "car") carAltitude(e, previous, city, h);
    if (!vehicle(e)) characterAltitude(e, city, h, input);
    if (vehicle(e)) e.angle = wrap(e.angle + (e.angularVelocity || 0) * h);
    // Remote controls are unknown: coast private neighbours between corrections.
    for (const b of shadows) {
      const previous = { ...b };
      if (b.kind === "car" && !b.driver && !b.ai)
        carForces(b, { throttle: 0, steer: 0, brake: false }, h, carGrounded(b, city));
      if (watercraft(b.kind) && !b.driver && !b.ai)
        watercraftForces(b, { throttle: 0, steer: 0, brake: false }, h);
      b.x += b.vx * h;
      b.z += b.vz * h;
      if (vehicle(b)) b.angle = wrap(b.angle + (b.angularVelocity || 0) * h);
      if (b.kind === "car") carAltitude(b, previous, city, h);
      else b.y = Math.max(groundLevel(b.x, b.z, city), b.y + b.vy * h);
    }
    resolveMovementContacts(bodies, city, contacts);
  }
}

/** Provisional contact solve; never damage entities or change gameplay ownership. */
export function resolveMovementContacts(
  bodies: Entity[],
  city: City,
  contacts?: Set<string>,
) {
  for (let pass = 0; pass < 3; pass++) {
    for (const body of bodies) {
      resolveStaticContacts(body, city);
    }
    for (const [a, b] of collisionPairs(bodies)) {
      if (Math.abs(a.x - b.x) > 10 || Math.abs(a.z - b.z) > 10) continue;
      const c = contact(entityBox(a), entityBox(b));
      if (c) {
        if (contacts?.has(a.id) || contacts?.has(b.id)) {
          contacts.add(a.id);
          contacts.add(b.id);
        }
        resolveContact(a, b, c);
      }
    }
  }
  for (const body of bodies) resolveWorldBounds(body, city);
}

function resolveStaticContacts(body: Entity, city: City) {
  for (const b of staticGeometry(city).query(body.x, body.z, 6)) {
    if (
      body.y >= b.h + (b.obstacle ? 0 : 1.8) - 0.02 ||
      Math.hypot(body.x - b.x, body.z - b.z) > Math.hypot(b.w, b.d) / 2 + 6
    )
      continue;
    const c = contact(entityBox(body), buildingBox(b));
    if (c) resolveContact(body, undefined, c);
  }
  for (const c of rampContacts(body, city)) resolveContact(body, undefined, c);
  resolveWorldBounds(body, city);
}

/** Cosmetic correction cannot displace the neighbours shown by the renderer. */
export function constrainRenderPose(pose: Entity, city: City, nearby: Entity[]) {
  for (let pass = 0; pass < 3; pass++) {
    resolveStaticContacts(pose, city);
    for (const b of nearby) {
      if (
        b.id === pose.id ||
        b.vehicle ||
        (!vehicle(b) && b.health <= 0) ||
        Math.abs(pose.y - b.y) > 1.8 ||
        Math.abs(pose.x - b.x) > 10 ||
        Math.abs(pose.z - b.z) > 10
      )
        continue;
      const c = contact(entityBox(pose), entityBox(b));
      if (c) resolveContact(pose, undefined, c);
    }
  }
  resolveWorldBounds(pose, city);
}
