import { staticGeometry } from "./static.ts";
import { LIMIT, inputX, inputY, type Entity, type City, type Input } from "../world.ts";
import { clamp, wrap } from "./vehicle.ts";
import { TUNING, VEHICLES } from "../catalog.ts";
import { shape } from "./collision.ts";
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
    } else if (
      Math.abs(x - b.x) < b.w / 2 + radius &&
      Math.abs(z - b.z) < b.d / 2 + radius
    )
      top = Math.max(top, b.h + 1.8);
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
    if (e.takeoffDelay <= 0 || input.up || input.down || input.left || input.right)
      e.takeoffDelay = undefined;
  }
  if (!e.driver || !e.flight || e.flight === "grounded" || (e.takeoffDelay || 0) > 0) {
    e.vx *= Math.exp(-6 * dt);
    e.vz *= Math.exp(-6 * dt);
    e.angularVelocity = (e.angularVelocity || 0) * Math.exp(-6 * dt);
    if (Math.abs(e.angularVelocity) < 0.001) e.angularVelocity = 0;
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
  let dx = inputX(input),
    dz = inputY(input);
  let maxSpeed: number = e.model ? VEHICLES[e.model].speed : 15;
  if (e.flight === "landing") {
    dx = (e.landingX ?? e.x) - e.x;
    dz = (e.landingZ ?? e.z) - e.z;
    maxSpeed = Math.min(8, Math.hypot(dx, dz) * 1.4);
  }
  if (e.flight === "takingOff" && e.y < groundLevel(e.x, e.z, city) + 8) {
    dx = 0;
    dz = 0;
  }
  const length = Math.hypot(dx, dz);
  if (length) {
    dx /= length;
    dz /= length;
  }
  const footprint = rotorRadius(e);
  let under = surface(city, e.x, e.z, footprint);
  for (const other of entities)
    if (
      other.id !== e.id &&
      !other.vehicle &&
      other.y <= e.y &&
      Math.hypot(other.x - e.x, other.z - e.z) <
        footprint + Math.hypot(shape(other).w, shape(other).d)
    )
      under = Math.max(under, other.y + 2);
  // Look ahead and climb before advancing over a roof; never teleport through it.
  const ahead = surface(city, e.x + dx * 12, e.z + dz * 12, footprint);
  const clearance = Math.max(under, ahead) + TUNING.clearance;
  let target = e.targetAltitude ?? clearance;
  if (input.ascend || input.descend)
    target =
      e.y +
      (Number(input.ascend) * tuning.climb - Number(input.descend) * tuning.descend) /
        tuning.response;
  if (!input.descend && e.flight !== "landing") target = Math.max(target, clearance);
  target = clamp(
    Math.max(target, Math.max(under, ahead) + 2),
    0,
    groundLevel(e.x, e.z, city) + tuning.ceiling,
  );
  if (!input.ascend && !input.descend && e.flight === "takingOff")
    target = Math.max(target, clearance);
  const atLanding =
    e.flight === "landing" &&
    Math.hypot((e.landingX ?? e.x) - e.x, (e.landingZ ?? e.z) - e.z) < 0.7;
  if (atLanding) target = surface(city, e.x, e.z, footprint);
  e.targetAltitude = target;
  const desiredVertical = clamp(
    (target - e.y) * tuning.response,
    -tuning.descend,
    tuning.climb,
  );
  e.vy += (desiredVertical - e.vy) * (1 - Math.exp(-tuning.vertical * dt));
  e.y = Math.max(groundLevel(e.x, e.z, city), e.y + e.vy * dt);
  if (e.flight === "takingOff" && e.y >= groundLevel(e.x, e.z, city) + 9)
    e.flight = "cruising";
  if (!atLanding && e.y < ahead + (input.descend ? 1.8 : TUNING.clearance - 1))
    maxSpeed = 0;
  if (input.brake) maxSpeed = 0;
  e.vx += (dx * maxSpeed - e.vx) * (1 - Math.exp(-tuning.acceleration * dt));
  e.vz += (dz * maxSpeed - e.vz) * (1 - Math.exp(-tuning.acceleration * dt));
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
