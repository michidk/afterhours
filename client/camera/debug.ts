import { WORLD_LIMIT } from "../../shared/water.ts";
import type { Input } from "../../shared/world.ts";
export type CameraMode = "follow" | "free" | "fly";
export interface CameraPoint {
  x: number;
  y: number;
  z: number;
}

export class DebugCamera {
  mode: CameraMode = "follow";
  position: CameraPoint = { x: 0, y: 46, z: -26 };
  focus: CameraPoint = { x: 0, y: 0, z: 0 };
  distance = 53;
  yaw = 0;
  pitch = -0.35;
  private flyZoom = 0;
  get fov() {
    // Lens zoom has no gameplay cap; keep projection inside its mathematical domain.
    const angle = 2 * Math.atan(Math.tan(0.72 / 2) * Math.exp(this.flyZoom));
    return Math.max(Number.EPSILON, Math.min(Math.PI - 4 * Number.EPSILON, angle));
  }
  get active() {
    return this.mode !== "follow";
  }
  setMode(mode: CameraMode, position: CameraPoint, focus: CameraPoint) {
    this.mode = mode;
    // Babylon vectors expose components through prototype accessors.
    this.position = { x: position.x, y: position.y, z: position.z };
    this.focus = { x: focus.x, y: focus.y, z: focus.z };
    this.flyZoom = 0;
    if (mode === "free") {
      this.distance =
        Math.hypot(position.x - focus.x, position.y - focus.y, position.z - focus.z) ||
        53;
      this.updateFreePosition();
    } else if (mode === "fly") {
      const dx = focus.x - position.x,
        dy = focus.y - position.y,
        dz = focus.z - position.z;
      this.yaw = Math.atan2(dx, dz);
      this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }
  }
  setPose(point: CameraPoint, yaw?: number, pitch?: number) {
    if (![point.x, point.y, point.z, yaw ?? 0, pitch ?? 0].every(Number.isFinite))
      throw Error("Camera pose must be finite");
    if (this.mode === "free") {
      this.focus = {
        x: Math.max(-WORLD_LIMIT + 4, Math.min(WORLD_LIMIT - 4, point.x)),
        y: Math.max(0, Math.min(220, point.y)),
        z: Math.max(-WORLD_LIMIT + 4, Math.min(WORLD_LIMIT - 4, point.z)),
      };
      this.updateFreePosition();
    } else if (this.mode === "fly") {
      this.position = {
        x: point.x,
        y: Math.max(1, Math.min(700, point.y)),
        z: point.z,
      };
      if (yaw !== undefined) this.yaw = yaw;
      if (pitch !== undefined) this.pitch = Math.max(-1.45, Math.min(1.45, pitch));
    }
  }
  look(dx: number, dy: number) {
    if (this.mode !== "fly") return;
    this.yaw += dx * 0.003;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * 0.003));
  }
  zoom(delta: number) {
    if (!Number.isFinite(delta)) throw Error("Zoom delta must be finite");
    if (this.mode === "free") {
      const distance = this.distance * Math.exp(delta * 0.001);
      // Ignore only numeric overflow/underflow, not normal zoom distances.
      if (distance > 0 && Number.isFinite(distance)) this.distance = distance;
      this.updateFreePosition();
    } else if (this.mode === "fly") this.flyZoom += delta * 0.001;
  }
  update(input: Input, dt: number) {
    if (!this.active) return;
    const forward = Number(input.up) - Number(input.down),
      side = Number(input.right) - Number(input.left);
    const vertical = Number(input.ascend) - Number(input.descend);
    const speed = input.brake || input.sprint ? 75 : 25;
    let x = side,
      y = vertical,
      z = forward;
    if (this.mode === "fly") {
      x =
        Math.sin(this.yaw) * Math.cos(this.pitch) * forward + Math.cos(this.yaw) * side;
      y += Math.sin(this.pitch) * forward;
      z =
        Math.cos(this.yaw) * Math.cos(this.pitch) * forward - Math.sin(this.yaw) * side;
    }
    const length = Math.max(1, Math.hypot(x, y, z));
    const point = this.mode === "free" ? this.focus : this.position;
    point.x = Math.max(
      -WORLD_LIMIT + 4,
      Math.min(WORLD_LIMIT - 4, point.x + (x / length) * speed * dt),
    );
    point.y = Math.max(
      this.mode === "fly" ? 1 : 0,
      Math.min(700, point.y + (y / length) * speed * dt),
    );
    point.z = Math.max(
      -WORLD_LIMIT + 4,
      Math.min(WORLD_LIMIT - 4, point.z + (z / length) * speed * dt),
    );
    if (this.mode === "free") this.updateFreePosition();
  }
  get target(): CameraPoint {
    return this.mode === "free"
      ? this.focus
      : {
          x: this.position.x + Math.sin(this.yaw) * Math.cos(this.pitch) * 20,
          y: this.position.y + Math.sin(this.pitch) * 20,
          z: this.position.z + Math.cos(this.yaw) * Math.cos(this.pitch) * 20,
        };
  }
  private updateFreePosition() {
    this.position = {
      x: this.focus.x,
      y: this.focus.y + this.distance * 0.87,
      z: this.focus.z - this.distance * 0.49,
    };
  }
}
