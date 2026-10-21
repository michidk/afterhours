use crate::{Drive, Move, VehicleSpec, World};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Physics(World);

#[wasm_bindgen]
impl Physics {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Physics {
        Physics(World::new())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn add_box(&mut self, cx: f32, cy: f32, cz: f32, hx: f32, hy: f32, hz: f32, yaw: f32) {
        self.0.add_box([cx, cy, cz], [hx, hy, hz], yaw);
    }
    pub fn add_trimesh(&mut self, vertices: &[f32], indices: &[u32]) -> Result<(), JsError> {
        self.0
            .add_trimesh(vertices, indices)
            .map_err(|e| JsError::new(&e))
    }
    #[allow(clippy::too_many_arguments)]
    pub fn add_prop(
        &mut self,
        cx: f32,
        cy: f32,
        cz: f32,
        hx: f32,
        hy: f32,
        hz: f32,
        yaw: f32,
    ) -> u32 {
        self.0.add_prop([cx, cy, cz], [hx, hy, hz], yaw)
    }
    pub fn remove_prop(&mut self, id: u32) -> bool {
        self.0.remove_prop(id)
    }
    /// Flat `[vehicle, prop, speed, vx, vy, vz]` rows from the last step.
    pub fn impacts(&self) -> Vec<f32> {
        self.0
            .impacts()
            .iter()
            .flat_map(|i| {
                let [vx, vy, vz] = i.velocity;
                [i.vehicle as f32, i.prop as f32, i.speed, vx, vy, vz]
            })
            .collect()
    }
    pub fn set_vehicle_velocity(&mut self, id: u32, vx: f32, vy: f32, vz: f32) -> bool {
        self.0.set_vehicle_velocity(id, [vx, vy, vz])
    }
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_vehicle(
        &mut self,
        mass: f32,
        width: f32,
        length: f32,
        height: f32,
        engine: f32,
        brake: f32,
        steer: f32,
        wheel_radius: f32,
        x: f32,
        y: f32,
        z: f32,
        yaw: f32,
    ) -> u32 {
        let spec = VehicleSpec {
            mass,
            width,
            length,
            height,
            engine,
            brake,
            steer,
            wheel_radius,
        };
        self.0.spawn_vehicle(spec, [x, y, z], yaw)
    }
    pub fn set_drive(&mut self, id: u32, throttle: f32, steer: f32, brake: bool) -> bool {
        self.0.set_drive(
            id,
            Drive {
                throttle,
                steer,
                brake,
            },
        )
    }
    pub fn remove_vehicle(&mut self, id: u32) -> bool {
        self.0.remove_vehicle(id)
    }
    pub fn spawn_character(&mut self, x: f32, y: f32, z: f32) -> u32 {
        self.0.spawn_character([x, y, z])
    }
    pub fn set_move(&mut self, id: u32, x: f32, z: f32, speed: f32, jump: bool) -> bool {
        self.0.set_move(id, Move { x, z, speed, jump })
    }
    pub fn remove_character(&mut self, id: u32) -> bool {
        self.0.remove_character(id)
    }
    pub fn step(&mut self) {
        self.0.step()
    }
    pub fn states(&self) -> Vec<f32> {
        self.0.states()
    }
    pub fn snapshot(&self) -> Vec<f32> {
        self.0.snapshot()
    }
    pub fn restore(&mut self, data: &[f32]) -> Result<(), JsError> {
        self.0.restore(data).map_err(|e| JsError::new(&e))
    }
}

impl Default for Physics {
    fn default() -> Self {
        Self::new()
    }
}
