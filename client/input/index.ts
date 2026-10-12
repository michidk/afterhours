import { idle, type Input } from "../../shared/world.ts";

interface GamepadState {
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}

const deadzone = (value = 0) => {
  const magnitude = Math.abs(value);
  return magnitude <= 0.2 ? 0 : Math.sign(value) * Math.min(1, (magnitude - 0.2) / 0.8);
};

export class Controls {
  keys = new Set<string>();
  mouseDown = false;
  aim: number | undefined;
  private pressed = new Set<string>();
  private clicked = false;
  private gamepadButtons = new Set<number>();
  private gamepadPresses = new Set<number>();
  pointer: { x: number; y: number } | undefined;
  constructor(
    private gamepads: () => readonly (GamepadState | null)[] = () =>
      typeof navigator === "undefined" || !navigator.getGamepads
        ? []
        : [...navigator.getGamepads()],
  ) {}
  press(code: string) {
    if (!this.keys.has(code)) this.pressed.add(code);
    this.keys.add(code);
  }
  click() {
    this.mouseDown = true;
    this.clicked = true;
  }
  sample(): Input {
    const pad = this.gamepads().find((gamepad) => gamepad !== null) ?? undefined;
    const buttons = new Set<number>();
    pad?.buttons.forEach((button, index) => {
      if (button.pressed) buttons.add(index);
    });
    this.gamepadPresses = new Set(
      [...buttons].filter((button) => !this.gamepadButtons.has(button)),
    );
    this.gamepadButtons = buttons;
    const input = this.read(new Set([...this.keys, ...this.pressed]), pad);
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
    this.gamepadButtons.clear();
    this.gamepadPresses.clear();
  }
  gamepadPressed(button: number) {
    return this.gamepadPresses.has(button);
  }
  read(
    keys = this.keys,
    pad = this.gamepads().find((gamepad) => gamepad !== null) ?? undefined,
  ): Input {
    const button = (index: number) => pad?.buttons[index]?.pressed || false;
    const buttonValue = (index: number) => pad?.buttons[index]?.value || 0;
    const digitalX =
      Number(keys.has("KeyD") || keys.has("ArrowRight")) -
      Number(keys.has("KeyA") || keys.has("ArrowLeft"));
    const digitalY =
      Number(keys.has("KeyW") || keys.has("ArrowUp")) -
      Number(keys.has("KeyS") || keys.has("ArrowDown"));
    const triggerY = deadzone(buttonValue(7) - buttonValue(6));
    const moveX = digitalX || deadzone(pad?.axes[0]);
    const moveY = digitalY || triggerY || deadzone(-(pad?.axes[1] || 0));
    return {
      ...idle(),
      up: moveY > 0,
      down: moveY < 0,
      left: moveX < 0,
      right: moveX > 0,
      ...(pad ? { moveX, moveY } : {}),
      brake: keys.has("Space") || button(0),
      sprint: keys.has("ShiftLeft") || keys.has("ShiftRight"),
      ascend: keys.has("KeyE") || button(5),
      descend: keys.has("KeyQ") || button(4),
      attack: keys.has("KeyJ") || this.mouseDown || button(2),
      aim: this.aim,
    };
  }
}
