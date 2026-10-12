import { idle, type Input } from "../../shared/world.ts";
export class Controls {
  keys = new Set<string>();
  mouseDown = false;
  aim: number | undefined;
  private pressed = new Set<string>();
  private clicked = false;
  pointer: { x: number; y: number } | undefined;
  press(code: string) {
    if (!this.keys.has(code)) this.pressed.add(code);
    this.keys.add(code);
  }
  click() {
    this.mouseDown = true;
    this.clicked = true;
  }
  sample(): Input {
    const input = this.read(new Set([...this.keys, ...this.pressed]));
    input.attack ||= this.clicked;
    this.pressed.clear();
    this.clicked = false;
    return input;
  }
  clear() {
    this.keys.clear();
    this.pressed.clear();
    this.clicked = false;
    this.aim = undefined;
    this.pointer = undefined;
    this.mouseDown = false;
  }
  read(keys = this.keys): Input {
    return {
      ...idle(),
      up: keys.has("KeyW") || keys.has("ArrowUp"),
      down: keys.has("KeyS") || keys.has("ArrowDown"),
      left: keys.has("KeyA") || keys.has("ArrowLeft"),
      right: keys.has("KeyD") || keys.has("ArrowRight"),
      brake: keys.has("Space"),
      sprint: keys.has("ShiftLeft") || keys.has("ShiftRight"),
      ascend: keys.has("KeyE"),
      descend: keys.has("KeyQ"),
      attack: keys.has("KeyJ") || this.mouseDown,
      aim: this.aim,
    };
  }
}
