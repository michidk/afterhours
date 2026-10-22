//! Prints a hash of a scripted run; `scripts/physics-parity.mjs` runs the same script on
//! the wasm build and must print the same number.
use afterhours_physics::*;

fn main() {
    let mut w = World::new();
    w.add_box([0.0, -0.5, 0.0], [200.0, 0.5, 200.0], 0.0);
    w.add_box([10.0, 0.5, 20.0], [3.0, 0.5, 3.0], 0.4);
    let car = w.spawn_vehicle(VehicleSpec::SEDAN, [0.0, 1.0, 0.0], 0.2);
    let who = w.spawn_character([4.0, 1.0, 0.0]);
    let mut hash: u64 = 0xcbf29ce484222325;
    for i in 0..300u32 {
        w.set_drive(
            car,
            Drive {
                throttle: 1.0,
                // Triangle waves, not sin/cos: libm results differ between native and wasm.
                steer: ((i % 40) as f32 - 20.0) / 20.0,
                brake: i % 50 > 45,
                occupied: true,
                ..Drive::default()
            },
        );
        w.set_move(
            who,
            Move {
                x: ((i % 60) as f32 - 30.0) / 30.0,
                z: 1.0,
                speed: 6.0,
                jump: i.is_multiple_of(40),
            },
        );
        w.step();
        for f in w.states() {
            hash = (hash ^ f.to_bits() as u64).wrapping_mul(0x100000001b3);
        }
    }
    println!("{hash:016x}");
}
