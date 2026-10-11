import { idle, type Input } from "../../shared/world.ts";
export class Controls {
  keys = new Set<string>();
  mouseDown = false;
  aim: number | undefined;
  clear() {
    this.keys.clear();
    this.mouseDown = false;
  }
  read(): Input {
    return {
      ...idle(),
      up: this.keys.has("KeyW") || this.keys.has("ArrowUp"),
      down: this.keys.has("KeyS") || this.keys.has("ArrowDown"),
      left: this.keys.has("KeyA") || this.keys.has("ArrowLeft"),
      right: this.keys.has("KeyD") || this.keys.has("ArrowRight"),
      brake: this.keys.has("Space"),
      sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
      ascend: this.keys.has("KeyE"),
      descend: this.keys.has("KeyQ"),
      attack: this.keys.has("KeyJ") || this.mouseDown,
      aim: this.aim,
    };
  }
}
