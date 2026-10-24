import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
export function followCamera(
  camera: FreeCamera,
  target: Vector3,
  altitude: number,
  speed: number,
  dt: number,
) {
  const destination = target.add(
    new Vector3(0, 46 + altitude * 0.25 + Math.min(12, speed * 0.2), -26),
  );
  // Keep the view attached to the predicted body. A quarter-second camera tail is
  // obvious on foot and makes a car appear to slide behind its steering on bends.
  camera.position = Vector3.Lerp(camera.position, destination, 1 - Math.exp(-dt * 8));
  camera.setTarget(target.add(new Vector3(0, 0, 4)));
}
