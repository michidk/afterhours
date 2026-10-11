import { debugCommandSchema, type DebugCommand } from "../../shared/debug.ts";
import { idle, type Input } from "../../shared/world.ts";
import type { VehicleModel } from "../../shared/catalog.ts";
import type { GameNetwork } from "../network/index.ts";
import type { CityScene } from "../scene.ts";
import type { CameraMode, CameraPoint } from "../camera/debug.ts";

export class AgentInterface {
  input: Input | undefined;
  private movement = 0;
  private commandTime = 0;
  private commandQueue = Promise.resolve();
  constructor(
    readonly network: GameNetwork,
    readonly scene: CityScene,
    readonly setCamera: (mode: CameraMode) => void,
  ) {}
  inspect() {
    return structuredClone({
      player: this.network.entities.get(this.network.playerId),
      entities: [...this.network.entities.values()],
      predicted: this.network.prediction?.body,
      camera: {
        mode: this.scene.debugCamera.mode,
        position: {
          x: this.scene.camera.position.x,
          y: this.scene.camera.position.y,
          z: this.scene.camera.position.z,
        },
        focus: this.scene.debugCamera.target,
        fov: this.scene.camera.fov,
      },
      lighting: this.scene.lighting.diagnostics,
      day: this.scene.day,
      destruction: this.scene.destruction.diagnostics,
    });
  }
  async command(command: DebugCommand) {
    const result = this.commandQueue.then(() => this.executeCommand(command));
    this.commandQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async executeCommand(command: DebugCommand) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 125 - (performance.now() - this.commandTime))),
    );
    try {
      return await this.network.debug(debugCommandSchema.parse(command));
    } finally {
      this.commandTime = performance.now();
    }
  }
  async time(hour: number, rate = 0) {
    const state = await this.command({ kind: "time", hour, rate });
    const deadline = performance.now() + 5000;
    while (rate === 0 && Math.abs(this.scene.day - state.day) > 0.001) {
      if (performance.now() > deadline)
        throw Error("Timed out waiting for the clock snapshot");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await this.settle();
    return state;
  }
  async settle() {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return this.inspect();
  }
  state() {
    return this.command({ kind: "state" });
  }
  teleport(x: number, z: number) {
    return this.command({ kind: "teleport", x, z });
  }
  spawn(model: VehicleModel) {
    return this.command({ kind: "spawn", model });
  }
  action(type: "interact" | "drop" | "reload" | "jetpack") {
    if (this.scene.debugCamera.active)
      throw Error("Return to player-follow before gameplay actions");
    if (!["interact", "drop", "reload", "jetpack"].includes(type))
      throw Error("Unknown action");
    this.network.send({ type });
  }
  async move(input: Partial<Input>, seconds = 1) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10)
      throw Error("Movement duration must be 0–10 seconds");
    const token = ++this.movement;
    this.input = { ...idle(), ...input };
    try {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    } finally {
      if (token === this.movement) {
        this.input = undefined;
        this.network.input(idle());
      }
    }
    return this.inspect();
  }
  camera(mode: CameraMode, point?: CameraPoint, yaw?: number, pitch?: number) {
    if (!["follow", "free", "fly"].includes(mode)) throw Error("Unknown camera mode");
    this.stop();
    this.setCamera(mode);
    if (point) this.scene.debugCamera.setPose(point, yaw, pitch);
    return this.inspect().camera;
  }
  look(dx: number, dy: number) {
    if (![dx, dy].every(Number.isFinite)) throw Error("Look delta must be finite");
    this.scene.debugCamera.look(dx, dy);
  }
  zoom(delta: number) {
    if (!Number.isFinite(delta)) throw Error("Zoom delta must be finite");
    this.scene.debugCamera.zoom(delta);
  }
  stop() {
    this.movement++;
    this.input = undefined;
    this.network.input(idle());
  }
}
