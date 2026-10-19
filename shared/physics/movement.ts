import {
  remainingPropHealth,
  strikeDamage,
  strikeVelocity,
  type PredictedImpacts,
} from "../destruction.ts";
import { PHYSIQUES } from "../character.ts";
import { staticGeometry } from "./static.ts";
import { fallAircraft } from "./abandoned-aircraft.ts";
import { JETPACK, jetpackThrust } from "./jetpack.ts";
import { idle, inputX, inputY, type City, type Entity, type Input } from "../world.ts";
import {
  groundLevel,
  setWaveTime,
  surfaceLevel,
  swimming,
  WATER_LEVEL,
  WAVE_MAX,
  watercraft,
  waveTime,
  resolveWorldBounds,
} from "../water.ts";
import { watercraftForces } from "./watercraft.ts";
import { TUNING, VEHICLES } from "../catalog.ts";
import { flyPlane } from "./plane.ts";
import { carForces, clamp, wrap } from "./vehicle.ts";
import { flyHelicopter } from "./helicopter.ts";
import { carAltitude, carGrounded, rampContacts } from "./ramps.ts";
import { driftFlooded } from "./flooding.ts";
import {
  entityBox,
  buildingBox,
  insideBuilding,
  contact,
  collisionPairs,
  resolveContact,
  pointVelocity,
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
          : swimming(e, city)
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
  let floor = surfaceLevel(e.x, e.z, city);
  // The quay's shallow step is traversable from swimming height.
  if (floor === 0 && e.y >= WATER_LEVEL - WAVE_MAX && e.y < 0) e.y = 0;
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
/** The fastest a body can plausibly move: its current speed, or its top speed if higher. */
export const speedLimit = (body: Entity) =>
  Math.max(
    Math.hypot(body.vx, body.vz),
    vehicle(body)
      ? body.model
        ? VEHICLES[body.model].speed
        : 52
      : body.jetpack?.active
        ? JETPACK.speed
        : TUNING.sprint * PHYSIQUES[body.character?.physique ?? "regular"].speed,
  );
/**
 * How far apart two bodies can be and still touch within the prediction horizon, given
 * their speed limits. Clients predict contacts inside it, and the server simulates every
 * body inside it at full rate, so a contact a client predicts is one the server resolves
 * with the same fidelity.
 */
export const contactRange = (speedA: number, speedB: number) =>
  12 + (speedA + speedB) * (TUNING.predictionSeconds + TUNING.tick);
/** Private, finite-mass neighbours. Never apply speculative impulses to snapshots. */
export function predictionWorld(e: Entity, nearby: Entity[]) {
  const speed = speedLimit(e);
  return nearby
    .filter(
      (b) =>
        b.id !== e.id &&
        !b.vehicle &&
        (vehicle(b) || b.health > 0) &&
        // Cover closing motion without simulating distant pedestrians as racing cars.
        Math.hypot(b.x - e.x, b.z - e.z) < contactRange(speed, speedLimit(b)),
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
  impacts: PredictedImpacts = new Map(),
) {
  const count = Math.ceil(dt / TUNING.physicsStep),
    h = dt / count;
  const bodies = [e, ...shadows];
  // The caller sets the wave clock to the end of `dt`; replay the server's substep times.
  const end = waveTime();
  for (let i = 0; i < count; i++) {
    if (e.down || e.wreck) break;
    setWaveTime(end - dt + (i + 1) * h);
    const previous = { x: e.x, y: e.y, z: e.z, vy: e.vy, vz: e.vz };
    if (!vehicle(e)) characterForces(e, input, h, undefined, city);
    else if (e.kind === "car") {
      if (e.flooded !== undefined) driftFlooded(e, h);
      else
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
        city,
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
    // Hold the last authoritative drive; future changes still require a snapshot.
    for (const b of shadows) {
      const previous = { x: b.x, y: b.y, z: b.z, vy: b.vy, vz: b.vz };
      const drive =
        b.drive ??
        (!b.driver && !b.ai ? { throttle: 0, steer: 0, brake: false } : undefined);
      if (b.kind === "car" && b.flooded !== undefined) driftFlooded(b, h);
      else if (b.kind === "car" && drive) carForces(b, drive, h, carGrounded(b, city));
      else if (b.kind === "plane" && b.planeInput) {
        if (
          !b.driver &&
          (b.y > groundLevel(b.x, b.z, city) + 0.2 || b.flight === "falling")
        )
          fallAircraft(b, city, h);
        else flyPlane(b, { ...idle(), ...b.planeInput }, h, city);
      }
      if (watercraft(b.kind) && drive) watercraftForces(b, drive, h, city);
      const speed = Math.hypot(b.vx, b.vz),
        limit = b.model ? VEHICLES[b.model].speed : 52;
      if (vehicle(b) && speed > limit) {
        b.vx *= limit / speed;
        b.vz *= limit / speed;
      }
      b.x += b.vx * h;
      b.z += b.vz * h;
      if (vehicle(b)) b.angle = wrap(b.angle + (b.angularVelocity || 0) * h);
      if (b.kind === "car") carAltitude(b, previous, city, h);
      else if (b.kind !== "plane" || !b.planeInput)
        b.y = Math.max(surfaceLevel(b.x, b.z, city), b.y + b.vy * h);
    }
    resolveMovementContacts(bodies, city, contacts, impacts);
  }
  setWaveTime(end);
}

/** Provisional contact solve; never damage entities or change gameplay ownership. */
export function resolveMovementContacts(
  bodies: Entity[],
  city: City,
  contacts?: Set<string>,
  impacts: PredictedImpacts = new Map(),
) {
  for (let pass = 0; pass < 3; pass++) {
    for (const body of bodies) {
      resolveStaticContacts(body, city, impacts, pass === 0);
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

function resolveStaticContacts(
  body: Entity,
  city: City,
  impacts: PredictedImpacts,
  predictBreak = false,
) {
  for (const b of staticGeometry(city).query(body.x, body.z, 6)) {
    if (
      body.y >= b.h + (b.obstacle ? 0 : 1.8) - 0.02 ||
      Math.hypot(body.x - b.x, body.z - b.z) > Math.hypot(b.w, b.d) / 2 + 6
    )
      continue;
    if (b.destructibleId && impacts.has(b.destructibleId)) continue;
    const c = contact(entityBox(body), buildingBox(b));
    if (!c) continue;
    if (predictBreak && vehicle(body) && b.destructibleId && b.obstacle) {
      const v = pointVelocity(body, c.x, c.z);
      const speed = Math.max(0, v.x * c.nx + v.z * c.nz);
      // The server reports dents, so the strike that finishes a damaged prop predicts too.
      if (
        speed > 2 &&
        strikeDamage(speed) >= remainingPropHealth(city, b.destructibleId, b.obstacle)
      ) {
        impacts.set(b.destructibleId, strikeVelocity(body));
        body.vx *= 0.96;
        body.vz *= 0.96;
        continue;
      }
    }
    resolveContact(body, undefined, c);
  }
  for (const c of rampContacts(body, city)) resolveContact(body, undefined, c);
  resolveWorldBounds(body, city);
}

/** Cosmetic correction cannot displace the neighbours shown by the renderer. */
export function constrainRenderPose(
  pose: Entity,
  city: City,
  nearby: Entity[],
  impacts: PredictedImpacts = new Map(),
) {
  for (let pass = 0; pass < 3; pass++) {
    resolveStaticContacts(pose, city, impacts);
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
