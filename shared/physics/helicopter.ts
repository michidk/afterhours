import { staticGeometry } from "./static.ts";
import { LIMIT, inputX, inputY, type Entity, type City, type Input } from "../world.ts";
import { clamp, wrap } from "./vehicle.ts";
import { TUNING, VEHICLES } from "../catalog.ts";
import { insideBuilding, shape } from "./collision.ts";
import { groundLevel, isWater } from "../water.ts";
function rotorRadius(e: Entity) {
  const model = e.model && VEHICLES[e.model];
  return model && model.kind === "helicopter" ? model.rotorRadius : 4.7;
}
function landingBlocked(e: Entity, other: Entity, x: number, z: number) {
  const footprint = shape(other);
  return (
    other.id !== e.id &&
    !other.vehicle &&
    other.y < 3 &&
    Math.hypot(other.x - x, other.z - z) <
      rotorRadius(e) + Math.hypot(footprint.w, footprint.d)
  );
}
export function surface(city: City, x: number, z: number, radius = 0) {
  let top = groundLevel(x, z, city);
  for (const b of staticGeometry(city).query(x, z, radius + 4)) {
    if (b.obstacle) {
      const r = radius + (b.obstacle === "lamp" ? 0.5 : 4);
      if ((b.x - x) ** 2 + (b.z - z) ** 2 < r * r) top = Math.max(top, b.h);
    } else if (insideBuilding(b, x, z, radius)) top = Math.max(top, b.h + 1.8);
  }
  return top;
}
export function landingSite(e: Entity, city: City, entities: Entity[]) {
  const footprint = rotorRadius(e);
  for (let radius = 0; radius <= 40; radius += 4)
    for (let i = 0; i < (radius ? 16 : 1); i++) {
      const x = clamp(
          e.x + Math.sin((i * Math.PI) / 8) * radius,
          -LIMIT + footprint + 1,
          LIMIT - footprint - 1,
        ),
        z = clamp(
          e.z + Math.cos((i * Math.PI) / 8) * radius,
          -LIMIT + footprint + 1,
          LIMIT - footprint - 1,
        );
      // Prefer road/ground landing so the player can resume walking immediately.
      if (
        !isWater(x, z, city) &&
        surface(city, x, z, footprint) === groundLevel(x, z, city) &&
        !entities.some((v) => landingBlocked(e, v, x, z))
      )
        return { x, z };
    }
  return undefined;
}
export function flyHelicopter(
  e: Entity,
  input: Input,
  city: City,
  entities: Entity[],
  dt: number,
) {
  const model = VEHICLES[e.model || "scout"];
  if (model.kind !== "helicopter") return;
  const tuning = model.flight;
  if (e.flight === "takingOff" && e.takeoffDelay !== undefined) {
    e.takeoffDelay -= dt;
    if (
      e.takeoffDelay <= 0 ||
      input.up ||
      input.down ||
      input.left ||
      input.right ||
      input.ascend
    )
      e.takeoffDelay = undefined;
  }
  if (!e.driver || !e.flight || e.flight === "grounded" || (e.takeoffDelay || 0) > 0) {
    e.vx *= Math.exp(-6 * dt);
    e.vz *= Math.exp(-6 * dt);
    e.angularVelocity = (e.angularVelocity || 0) * Math.exp(-6 * dt);
    if (Math.abs(e.angularVelocity) < 0.001) e.angularVelocity = 0;
    if (e.pitch || e.roll) {
      e.pitch = Math.abs(e.pitch ?? 0) < 0.001 ? 0 : (e.pitch ?? 0) * Math.exp(-6 * dt);
      e.roll = Math.abs(e.roll ?? 0) < 0.001 ? 0 : (e.roll ?? 0) * Math.exp(-6 * dt);
    }
    e.vy = 0;
    return;
  }
  if (
    e.flight === "landing" &&
    entities.some((v) => landingBlocked(e, v, e.landingX ?? e.x, e.landingZ ?? e.z))
  ) {
    const site = landingSite(e, city, entities);
    if (site) {
      e.landingX = site.x;
      e.landingZ = site.z;
    } else {
      e.flight = "cruising";
      e.vx = e.vz = 0;
    }
  }
  // Pilots fly relative to the nose; an automatic landing flies straight at its site.
  const piloted = e.flight !== "landing";
  let dx = 0,
    dz = 0,
    maxSpeed: number = model.speed;
  if (!piloted) {
    dx = (e.landingX ?? e.x) - e.x;
    dz = (e.landingZ ?? e.z) - e.z;
    maxSpeed = Math.min(8, Math.hypot(dx, dz) * 1.4);
  }
  const length = Math.hypot(dx, dz);
  if (length) {
    dx /= length;
    dz /= length;
  }
  // A pilot looks ahead along the direction of travel, or the nose when hovering.
  const travel = Math.hypot(e.vx, e.vz),
    lookX = piloted ? (travel > 0.5 ? e.vx / travel : Math.sin(e.angle)) : dx,
    lookZ = piloted ? (travel > 0.5 ? e.vz / travel : Math.cos(e.angle)) : dz;
  const footprint = rotorRadius(e);
  // Automatic landings clear the whole rotor; pilots only collide with the fuselage.
  const reach = e.flight === "landing" ? footprint : 2;
  let under = surface(city, e.x, e.z, reach);
  for (const other of entities)
    if (
      other.id !== e.id &&
      !other.vehicle &&
      other.y <= e.y &&
      Math.hypot(other.x - e.x, other.z - e.z) <
        reach + Math.hypot(shape(other).w, shape(other).d)
    )
      under = Math.max(under, other.y + 2);
  // Look ahead so the pilot must climb over a roof; never teleport through it.
  const ahead = surface(city, e.x + lookX * 6, e.z + lookZ * 6, reach);
  const ceiling = groundLevel(e.x, e.z, city) + tuning.ceiling;
  const atLanding =
    e.flight === "landing" &&
    Math.hypot((e.landingX ?? e.x) - e.x, (e.landingZ ?? e.z) - e.z) < 0.7;
  // Pilots set climb rate directly (Space/Shift); releasing both holds altitude.
  let desiredVertical =
    Number(input.ascend) * tuning.climb - Number(input.descend) * tuning.descend;
  if (e.flight === "landing") {
    const target = atLanding
      ? surface(city, e.x, e.z, footprint)
      : clamp(
          Math.max(
            e.targetAltitude ?? Math.max(under, ahead) + TUNING.clearance,
            Math.max(under, ahead) + 2,
          ),
          0,
          ceiling,
        );
    e.targetAltitude = target;
    desiredVertical = clamp(
      (target - e.y) * tuning.response,
      -tuning.descend,
      tuning.climb,
    );
  } else e.targetAltitude = undefined;
  // Ease onto roofs and people below instead of snapping through them.
  if (!atLanding)
    desiredVertical = Math.max(
      desiredVertical,
      Math.min(tuning.climb, (under - e.y) * tuning.response),
    );
  if (e.y >= ceiling) desiredVertical = Math.min(0, desiredVertical);
  e.vy += (desiredVertical - e.vy) * (1 - Math.exp(-tuning.vertical * dt));
  e.y = Math.max(groundLevel(e.x, e.z, city), e.y + e.vy * dt);
  if (e.flight === "takingOff" && e.y >= groundLevel(e.x, e.z, city) + 9)
    e.flight = "cruising";
  const blocked = !atLanding && e.y < ahead + 1;
  if (piloted) {
    flyAttitude(e, input, model, blocked, dt);
    return;
  }
  if (blocked) maxSpeed = 0;
  // The autopilot levels the airframe and steers the velocity directly.
  const level = Math.exp(-model.flight.tiltRate * dt);
  e.pitch = (e.pitch ?? 0) * level;
  e.roll = (e.roll ?? 0) * level;
  // Sideways momentum bleeds off slower than the autopilot accelerates.
  const along = 1 - Math.exp(-tuning.acceleration * dt),
    across =
      e.flight === "landing" || !length
        ? along
        : 1 - Math.exp(-tuning.acceleration * 0.5 * dt),
    parallel = e.vx * dx + e.vz * dz,
    sideX = (e.vx - dx * parallel) * (1 - across),
    sideZ = (e.vz - dz * parallel) * (1 - across),
    forward = parallel + (maxSpeed - parallel) * along;
  e.vx = dx * forward + sideX;
  e.vz = dz * forward + sideZ;
  if (length > 0.01) {
    const error = wrap(Math.atan2(dx, dz) - e.angle);
    e.angularVelocity = clamp(error * tuning.yaw, -tuning.turn, tuning.turn);
  } else e.angularVelocity = (e.angularVelocity || 0) * Math.exp(-5 * dt);
  if (atLanding && e.y < 0.12 && Math.abs(e.vy) < 0.5) {
    e.y = 0;
    e.vy = 0;
    e.vx = 0;
    e.vz = 0;
    e.flight = "grounded";
  }
}

/** Gravity, matching falls elsewhere, which the rotor's tilted lift works against. */
const GRAVITY = 18;
type HelicopterSpec = Extract<
  (typeof VEHICLES)[keyof typeof VEHICLES],
  { kind: "helicopter" }
>;
/**
 * Piloted flight. W/S tilt the rotor disc nose down or up and A/D yaw the airframe;
 * the tilted lift accelerates the helicopter and drag sets its top speed, so it keeps
 * its momentum and takes a moment to stop. Attitude and yaw rate build up and settle
 * over time. Turning at speed banks the airframe so the lift curves the flight path
 * with the nose; hands off, a stabiliser leans against any drift until it hovers.
 */
function flyAttitude(
  e: Entity,
  input: Input,
  model: HelicopterSpec,
  blocked: boolean,
  dt: number,
) {
  const t = model.flight,
    s = Math.sin(e.angle),
    c = Math.cos(e.angle),
    forward = e.vx * s + e.vz * c,
    right = e.vx * c - e.vz * s,
    stick = clamp(inputY(input), -1, 1),
    pedal = clamp(inputX(input), -1, 1);
  // At speed the nose turns only as fast as a full bank can curve the flight path;
  // hovering, it pirouettes at the full pedal rate.
  const turn = Math.min(
    t.turn,
    (GRAVITY * Math.tan(t.bank)) / Math.max(1, Math.abs(forward)),
  );
  e.angularVelocity =
    (e.angularVelocity || 0) +
    (pedal * turn - (e.angularVelocity || 0)) * (1 - Math.exp(-t.yaw * dt));
  // The stabiliser leans fully against drift from 4 m/s down, so a hover settles briskly.
  const drift = (v: number) => clamp(v / 4, -1, 1);
  const pitchTarget = stick ? stick * t.tilt : -drift(forward) * t.tilt * 0.6,
    bankTarget = clamp(
      Math.atan2(forward * e.angularVelocity, GRAVITY) - drift(right) * t.bank * 0.6,
      -t.bank,
      t.bank,
    ),
    ease = 1 - Math.exp(-t.tiltRate * dt);
  e.pitch = (e.pitch ?? 0) + (pitchTarget - (e.pitch ?? 0)) * ease;
  e.roll = (e.roll ?? 0) + (bankTarget - (e.roll ?? 0)) * ease;
  // Full forward tilt balances drag exactly at the model's top speed; air resists
  // sideways motion twice as much, so the helicopter carves rather than skids.
  const drag = (GRAVITY * Math.tan(t.tilt)) / model.speed;
  let ahead = forward + (GRAVITY * Math.tan(e.pitch) - drag * forward) * dt;
  const side = right + (GRAVITY * Math.tan(e.roll) - drag * 2 * right) * dt;
  // A roof ahead stops the approach until the pilot climbs over it.
  if (blocked && ahead > 0) ahead *= Math.exp(-8 * dt);
  e.vx = s * ahead + c * side;
  e.vz = c * ahead - s * side;
}
