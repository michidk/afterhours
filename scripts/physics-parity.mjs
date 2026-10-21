// Same scripted run as crates/physics/examples/parity.rs, on the wasm build.
import { createRequire } from "node:module";
const { Physics } = createRequire(import.meta.url)("../crates/physics/pkg-node/afterhours_physics.js");
const w = new Physics();
w.add_box(0, -0.5, 0, 200, 0.5, 200, 0);
w.add_box(10, 0.5, 20, 3, 0.5, 3, 0.4);
const car = w.spawn_vehicle(1000, 2, 4.3, 1.4, 9750, 7000, 0.55, 0.34, 0, 1, 0, 0.2);
const who = w.spawn_character(4, 1, 0);
let hash = 0xcbf29ce484222325n;
const view = new DataView(new ArrayBuffer(4));
for (let i = 0; i < 300; i++) {
  w.set_drive(car, 1, Math.fround(((i % 40) - 20) / 20), i % 50 > 45);
  w.set_move(who, Math.fround(((i % 60) - 30) / 30), 1, 6, i % 40 === 0);
  w.step();
  for (const f of w.states()) {
    view.setFloat32(0, f);
    hash = ((hash ^ BigInt(view.getUint32(0))) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
}
console.log(hash.toString(16).padStart(16, "0"));
