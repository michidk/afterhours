import type { Entity } from "../world.ts";
import { VEHICLES } from "../catalog.ts";

// Independent implementation of the four-wheel damping model explained at
// https://patkerr.co.uk/2d-vehicles/ and motion-lab/src/dynamics.js.
// Our coordinates are x/right, z/forward, with positive yaw turning right.
export const WHEELS = [
  { x: -0.7, z: 1.35, front: true },
  { x: 0.7, z: 1.35, front: true },
  { x: -0.7, z: -1.35, front: false },
  { x: 0.7, z: -1.35, front: false },
];
export const CAR = {
  mass: 1000,
  inertia: (1000 * (4.3 ** 2 + 2 ** 2)) / 12,
  engine: 9750,
  rolling: 32.5,
  lateral: 1100,
  steer: 0.55,
  /** Forward speed in m/s at which the steering lock halves, so fast turns stay gripped. */
  steerFalloff: 30,
  /** Rear tyres grip harder than the fronts, so a car understeers before it slides. */
  rearBias: 1.25,
  /** Tyres skid (marks, squeal) only past this rear slip angle, and stop below the lower one. */
  skidAngle: Math.tan((15 * Math.PI) / 180),
  skidRelease: Math.tan((10 * Math.PI) / 180),
  /** Sideways tyre speed in m/s needed for a skid, so slow parking turns stay quiet. */
  skidSpeed: 3,
  steerRate: 1.65,
  steerReturn: 2.8,
  counterSteerRate: 3.5,
  rearGrip: 0.15,
  handbrakeStrength: 0.75,
  brakeRolling: 8,
  recovery: 0.15,
  /** Brake deceleration a parked or stopped car holds against shoves and slopes. */
  parkingBrake: 9,
  holdSpeed: 2,
};
export interface Drive {
  throttle: number;
  steer: number;
  brake: boolean;
  serviceBrake?: number;
}
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
export function wheelPoint(e: Entity, w: { x: number; z: number }) {
  const s = Math.sin(e.angle),
    c = Math.cos(e.angle);
  return { x: e.x + c * w.x + s * w.z, z: e.z - s * w.x + c * w.z };
}
export function carForces(e: Entity, input: Drive, dt: number, grounded = e.y <= 0.08) {
  const spec =
    VEHICLES[e.model && VEHICLES[e.model].kind === "car" ? e.model : "sedan"];
  const bodyMass = spec.mass,
    bodyInertia = (spec.mass * (spec.width ** 2 + spec.length ** 2)) / 12;
  e.rearGripLoss = input.brake
    ? 1
    : Math.max(0, (e.rearGripLoss || 0) - dt / CAR.recovery);
  const sin = Math.sin(e.angle),
    cos = Math.cos(e.angle),
    forward = e.vx * sin + e.vz * cos;
  const steering = e.steering || 0,
    targetSteering =
      (input.steer * CAR.steer) / (1 + Math.abs(forward) / CAR.steerFalloff),
    steeringRate =
      targetSteering === 0
        ? CAR.steerReturn
        : steering * targetSteering < 0
          ? CAR.counterSteerRate
          : CAR.steerRate;
  e.steering =
    steering + clamp(targetSteering - steering, -steeringRate * dt, steeringRate * dt);
  e.wheelSkids ??= [false, false, false, false];
  if (!grounded) {
    e.skidding = false;
    e.wheelSkids.fill(false);
    return;
  }
  const power = e.burning || e.wreck ? 0 : spec.engine;
  const drive =
    input.throttle * power * (input.throttle < 0 && forward <= 0 ? 0.75 : 1);
  let fx = sin * drive,
    fz = cos * drive,
    torque = 0;
  for (let i = 0; i < WHEELS.length; i++) {
    const w = WHEELS[i],
      p = wheelPoint(e, w),
      rx = p.x - e.x,
      rz = p.z - e.z;
    const vx = e.vx + (e.angularVelocity || 0) * rz,
      vz = e.vz - (e.angularVelocity || 0) * rx;
    const a = e.angle + (w.front ? e.steering : 0),
      sx = Math.sin(a),
      cz = Math.cos(a);
    const rollingSpeed = vx * sx + vz * cz,
      lateralSpeed = vx * cz - vz * sx;
    const rolling =
      CAR.rolling *
      (!w.front && input.brake
        ? 1 + CAR.handbrakeStrength * (CAR.brakeRolling - 1)
        : 1);
    const lateral =
      spec.grip *
      (w.front
        ? 1
        : CAR.rearBias *
          (1 - (e.rearGripLoss || 0) * CAR.handbrakeStrength * (1 - CAR.rearGrip)));
    const wx = -sx * rolling * rollingSpeed - cz * lateral * lateralSpeed;
    const wz = -cz * rolling * rollingSpeed + sx * lateral * lateralSpeed;
    fx += wx;
    fz += wz;
    torque += rz * wx - rx * wz;
    const sideways = Math.abs(lateralSpeed),
      slip = sideways / Math.max(1, Math.abs(rollingSpeed));
    e.wheelSkids[i] =
      !w.front &&
      (e.wheelSkids[i]
        ? sideways > CAR.skidSpeed * 0.7 && slip > CAR.skidRelease
        : sideways > CAR.skidSpeed && slip > CAR.skidAngle);
  }
  // Service brake for AI stopping; handbrake remains the reference rear-wheel model.
  const speed = Math.hypot(e.vx, e.vz),
    // Empty cars keep the parking brake on; a driver off the throttle holds the hill.
    holding = !e.ai && (!e.driver || (input.throttle === 0 && speed < CAR.holdSpeed)),
    brake = Math.min(
      speed / dt,
      holding ? CAR.parkingBrake : (input.serviceBrake || 0) * 14,
    );
  if (holding && !e.driver)
    e.angularVelocity = (e.angularVelocity || 0) * Math.exp(-6 * dt);
  if (speed > 0) {
    fx -= (e.vx / speed) * brake * bodyMass;
    fz -= (e.vz / speed) * brake * bodyMass;
  }
  e.vx += (fx / bodyMass) * dt;
  e.vz += (fz / bodyMass) * dt;
  e.angularVelocity = (e.angularVelocity || 0) + (torque / bodyInertia) * dt;
  e.skidding = e.wheelSkids.some(Boolean);
}
