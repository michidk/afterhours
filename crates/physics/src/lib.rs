//! Authoritative and predicted movement on one Rapier world. Built natively for the
//! server and to wasm for client prediction; `enhanced-determinism` keeps both identical.
//!
//! Coordinates match the game: x right, y up, z forward, yaw positive turns right.
use rapier3d::control::{
    CharacterLength, DynamicRayCastVehicleController, KinematicCharacterController, WheelTuning,
};
use rapier3d::prelude::*;
use std::collections::HashMap;

pub mod lab;
#[cfg(feature = "wasm")]
mod wasm;

/// Server tick; `SUBSTEPS` physics steps run per tick for stable suspension.
pub const TICK: f32 = 1.0 / 30.0;
pub const SUBSTEPS: u32 = 4;
pub const GRAVITY: f32 = -9.81;
/// Floats per vehicle and per character in [`World::states`].
pub const VEHICLE_STRIDE: usize = 11;
pub const CHARACTER_STRIDE: usize = 6;
/// Below this speed with no throttle the parking brake holds the car (m/s).
const HOLD_SPEED: f32 = 2.0;
const JUMP_SPEED: f32 = 5.5;
const CHARACTER_RADIUS: f32 = 0.35;
const CHARACTER_HALF_HEIGHT: f32 = 0.55;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VehicleSpec {
    pub mass: f32,
    pub width: f32,
    pub length: f32,
    pub height: f32,
    /// Peak drive force in newtons split over all four wheels.
    pub engine: f32,
    /// Total braking force in newtons.
    pub brake: f32,
    /// Steering lock in radians at standstill.
    pub steer: f32,
    pub wheel_radius: f32,
    /// Speed in m/s the engine cannot push past (`shared/catalog.ts` `speed`).
    pub top_speed: f32,
}

impl VehicleSpec {
    pub const SEDAN: VehicleSpec = VehicleSpec {
        mass: 1000.0,
        width: 2.0,
        length: 4.3,
        height: 1.4,
        engine: 9750.0,
        brake: 7_000.0,
        steer: 0.55,
        wheel_radius: 0.34,
        top_speed: 42.0,
    };
    /// `shared/catalog.ts` VEHICLES.sport; brake, steer and wheels as the sedan.
    pub const SPORT: VehicleSpec = VehicleSpec {
        mass: 850.0,
        width: 1.9,
        length: 4.1,
        engine: 12500.0,
        top_speed: 52.0,
        ..Self::SEDAN
    };
    /// `shared/catalog.ts` VEHICLES.van; brake, steer and wheels as the sedan.
    pub const VAN: VehicleSpec = VehicleSpec {
        mass: 1600.0,
        width: 2.2,
        length: 5.0,
        engine: 12500.0,
        // The sedan's 7 m/s² of braking, scaled to the heavier body.
        brake: 11_200.0,
        top_speed: 30.0,
        ..Self::SEDAN
    };
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Drive {
    pub throttle: f32,
    pub steer: f32,
    pub brake: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Move {
    pub x: f32,
    pub z: f32,
    pub speed: f32,
    pub jump: bool,
}

struct Vehicle {
    id: u32,
    body: RigidBodyHandle,
    collider: ColliderHandle,
    controller: DynamicRayCastVehicleController,
    spec: VehicleSpec,
    drive: Drive,
}

struct Character {
    id: u32,
    body: RigidBodyHandle,
    collider: ColliderHandle,
    mv: Move,
    vertical: f32,
    grounded: bool,
}

/// A vehicle touched a prop this tick; `speed` is its approach speed along the contact
/// normal before the solver cancelled it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Impact {
    pub vehicle: u32,
    pub prop: u32,
    pub speed: f32,
    /// The vehicle's velocity before the solver stopped it at the prop.
    pub velocity: [f32; 3],
}

pub struct World {
    physics: PhysicsWorld,
    controller: KinematicCharacterController,
    vehicles: Vec<Vehicle>,
    characters: Vec<Character>,
    /// Breakable static boxes, by id (see [`World::add_prop`]).
    props: HashMap<u32, ColliderHandle>,
    /// Free-tumbling bodies, by id (see [`World::spawn_debris`]).
    debris: HashMap<u32, RigidBodyHandle>,
    impacts: Vec<Impact>,
    next_id: u32,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    pub fn new() -> Self {
        let mut physics = PhysicsWorld::new();
        physics.gravity = Vector::new(0.0, GRAVITY, 0.0);
        physics.integration_parameters.dt = TICK / SUBSTEPS as f32;
        // No warm starting: a restored snapshot has no cached impulses, so replay must not depend on them.
        physics.integration_parameters.warmstart_coefficient = 0.0;
        let controller = KinematicCharacterController {
            snap_to_ground: Some(CharacterLength::Absolute(0.3)),
            ..Default::default()
        };
        Self {
            physics,
            controller,
            vehicles: Vec::new(),
            characters: Vec::new(),
            props: HashMap::new(),
            debris: HashMap::new(),
            impacts: Vec::new(),
            next_id: 1,
        }
    }

    // ── Static geometry ───────────────────────────────────────────────────

    pub fn add_box(&mut self, center: [f32; 3], half: [f32; 3], yaw: f32) {
        let pose = Pose::from_parts(Vector::from(center), Rotation::from_rotation_y(yaw));
        self.physics.insert_collider(
            ColliderBuilder::cuboid(half[0], half[1], half[2])
                .position(pose)
                .build(),
            None,
        );
    }

    /// Triangle mesh in world space; `indices` are triples into `vertices` (xyz triples).
    pub fn add_trimesh(&mut self, vertices: &[f32], indices: &[u32]) -> Result<(), String> {
        let verts: Vec<Vector> = vertices
            .as_chunks::<3>()
            .0
            .iter()
            .map(|v| Vector::from(*v))
            .collect();
        let idx: Vec<[u32; 3]> = indices.as_chunks::<3>().0.to_vec();
        let collider = ColliderBuilder::trimesh(verts, idx)
            .map_err(|e| e.to_string())?
            .build();
        self.physics.insert_collider(collider, None);
        Ok(())
    }

    /// Static box like [`World::add_box`] that vehicles report impacts against and that
    /// can be removed once broken.
    pub fn add_prop(&mut self, center: [f32; 3], half: [f32; 3], yaw: f32) -> u32 {
        let pose = Pose::from_parts(Vector::from(center), Rotation::from_rotation_y(yaw));
        let collider = self.physics.insert_collider(
            ColliderBuilder::cuboid(half[0], half[1], half[2])
                .position(pose)
                .friction(0.8)
                .build(),
            None,
        );
        let id = self.next_id;
        self.next_id += 1;
        self.props.insert(id, collider);
        id
    }

    pub fn remove_prop(&mut self, id: u32) -> bool {
        match self.props.remove(&id) {
            Some(c) => self.physics.remove_collider(c).is_some(),
            None => false,
        }
    }

    /// Vehicle-prop contacts recorded during the last [`World::step`].
    pub fn impacts(&self) -> &[Impact] {
        &self.impacts
    }

    // ── Debris ────────────────────────────────────────────────────────────

    /// Dynamic box with CCD; tuning copied from the Node `server/destruction.ts` spawn.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_debris(
        &mut self,
        center: [f32; 3],
        half: [f32; 3],
        yaw: f32,
        mass: f32,
        linvel: [f32; 3],
        angvel: [f32; 3],
    ) -> u32 {
        let body = self.physics.insert_body(
            RigidBodyBuilder::dynamic()
                .pose(Pose::from_parts(
                    Vector::from(center),
                    Rotation::from_rotation_y(yaw),
                ))
                .linvel(Vector::from(linvel))
                .angvel(Vector::from(angvel))
                .linear_damping(0.6)
                .angular_damping(0.8)
                .ccd_enabled(true)
                .build(),
        );
        self.physics.insert_collider(
            ColliderBuilder::cuboid(half[0], half[1], half[2])
                .mass(mass)
                .restitution(0.15)
                .friction(0.8)
                .build(),
            Some(body),
        );
        let id = self.next_id;
        self.next_id += 1;
        self.debris.insert(id, body);
        id
    }

    pub fn remove_debris(&mut self, id: u32) -> bool {
        match self.debris.remove(&id) {
            Some(b) => {
                self.physics.remove_body_with_colliders(b, true);
                true
            }
            None => false,
        }
    }

    /// `[x, y, z, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz]` of one debris body.
    pub fn debris_state(&self, id: u32) -> Option<[f32; 13]> {
        let b = &self.physics.bodies[*self.debris.get(&id)?];
        let (t, r, l, a) = (b.translation(), b.rotation(), b.linvel(), b.angvel());
        Some([
            t.x, t.y, t.z, r.x, r.y, r.z, r.w, l.x, l.y, l.z, a.x, a.y, a.z,
        ])
    }

    /// Overrides a vehicle's velocity, e.g. to carry it through a prop it just broke.
    pub fn set_vehicle_velocity(&mut self, id: u32, linvel: [f32; 3]) -> bool {
        let Some(v) = self.vehicles.iter().find(|v| v.id == id) else {
            return false;
        };
        self.physics.bodies[v.body].set_linvel(Vector::from(linvel), true);
        true
    }

    // ── Vehicles ──────────────────────────────────────────────────────────

    pub fn spawn_vehicle(&mut self, spec: VehicleSpec, position: [f32; 3], yaw: f32) -> u32 {
        let body = self.physics.insert_body(
            RigidBodyBuilder::dynamic()
                .pose(Pose::from_parts(
                    Vector::from(position),
                    Rotation::from_rotation_y(yaw),
                ))
                .build(),
        );
        let collider = self.physics.insert_collider(
            ColliderBuilder::cuboid(spec.width / 2.0, spec.height / 2.0, spec.length / 2.0)
                // Centre of mass near the floor pan, or hard braking tips the car over.
                .mass_properties(MassProperties::new(
                    Vector::new(0.0, 0.3 - spec.height / 2.0, 0.0),
                    spec.mass,
                    MassProperties::from_cuboid(
                        spec.mass,
                        Vector::new(spec.width / 2.0, spec.height / 2.0, spec.length / 2.0),
                    )
                    .principal_inertia(),
                ))
                .build(),
            Some(body),
        );
        let mut controller = DynamicRayCastVehicleController::new(body);
        let tuning = WheelTuning {
            suspension_stiffness: 30.0,
            // Light damping let a car rock for seconds after settling on a slope.
            suspension_compression: 6.0,
            suspension_damping: 6.0,
            // City terrain is a baked mesh with small height discontinuities at
            // chunk/road seams; extra travel keeps the raycast wheels grounded.
            max_suspension_travel: 0.8,
            side_friction_stiffness: 1.0,
            friction_slip: 1.35,
            max_suspension_force: spec.mass * 40.0,
        };
        let (hx, hz, y) = (
            spec.width * 0.35,
            spec.length * 0.31,
            // Start the suspension ray just below the body floor.  The baked city
            // terrain is a triangle mesh; placing the ray origin too high leaves
            // small gaps at sloped triangles, so Rapier reports no wheel contact
            // and the engine force never reaches the ground.
            -spec.height / 2.0,
        );
        for (x, z) in [(-hx, hz), (hx, hz), (-hx, -hz), (hx, -hz)] {
            // Rapier drives along normal × axle, so a -X axle makes +Z the forward direction.
            controller.add_wheel(
                Vector::new(x, y, z),
                -Vector::Y,
                -Vector::X,
                0.3,
                spec.wheel_radius,
                &tuning,
            );
        }
        let id = self.next_id;
        self.next_id += 1;
        self.vehicles.push(Vehicle {
            id,
            body,
            collider,
            controller,
            spec,
            drive: Drive::default(),
        });
        id
    }

    pub fn set_drive(&mut self, id: u32, drive: Drive) -> bool {
        match self.vehicles.iter_mut().find(|v| v.id == id) {
            Some(v) => {
                v.drive = drive;
                true
            }
            None => false,
        }
    }

    pub fn remove_vehicle(&mut self, id: u32) -> bool {
        let Some(i) = self.vehicles.iter().position(|v| v.id == id) else {
            return false;
        };
        let v = self.vehicles.remove(i);
        self.physics.remove_body_with_colliders(v.body, true);
        true
    }

    /// Moves a vehicle to an administrative destination and clears its motion.
    /// True when a box of half extents `half` at `center`, turned by `yaw`, touches no
    /// collider except the terrain mesh and the world floor (walls, props, cars and
    /// characters all count). Spawn tools use it to find a free spot.
    pub fn is_clear(&self, center: [f32; 3], half: [f32; 3], yaw: f32) -> bool {
        let shape = Cuboid::new(Vector::from(half));
        let pose = Pose::from_parts(Vector::from(center), Rotation::from_rotation_y(yaw));
        // The ground is meant to be touched; trimeshes and the huge floor slabs are ground.
        let not_ground = |_: ColliderHandle, c: &Collider| {
            c.shape().as_trimesh().is_none()
                && c.shape()
                    .as_cuboid()
                    .is_none_or(|b| b.half_extents.x < 100.0)
        };
        self.physics
            .intersect_shape(pose, &shape, QueryFilter::default().predicate(&not_ground))
            .next()
            .is_none()
    }

    pub fn set_vehicle_position(&mut self, id: u32, position: [f32; 3], yaw: f32) -> bool {
        let Some(v) = self.vehicles.iter().find(|v| v.id == id) else {
            return false;
        };
        let body = &mut self.physics.bodies[v.body];
        body.set_position(
            Pose::from_parts(Vector::from(position), Rotation::from_rotation_y(yaw)),
            true,
        );
        body.set_linvel(Vector::new(0.0, 0.0, 0.0), true);
        body.set_angvel(Vector::new(0.0, 0.0, 0.0), true);
        true
    }

    // ── Characters ────────────────────────────────────────────────────────

    pub fn spawn_character(&mut self, position: [f32; 3]) -> u32 {
        let body = self.physics.insert_body(
            RigidBodyBuilder::kinematic_position_based()
                .translation(Vector::from(position))
                .build(),
        );
        let collider = self.physics.insert_collider(
            ColliderBuilder::capsule_y(CHARACTER_HALF_HEIGHT, CHARACTER_RADIUS).build(),
            Some(body),
        );
        let id = self.next_id;
        self.next_id += 1;
        self.characters.push(Character {
            id,
            body,
            collider,
            mv: Move::default(),
            vertical: 0.0,
            grounded: false,
        });
        id
    }

    pub fn set_move(&mut self, id: u32, mv: Move) -> bool {
        match self.characters.iter_mut().find(|c| c.id == id) {
            Some(c) => {
                c.mv = mv;
                true
            }
            None => false,
        }
    }

    pub fn remove_character(&mut self, id: u32) -> bool {
        let Some(i) = self.characters.iter().position(|c| c.id == id) else {
            return false;
        };
        let c = self.characters.remove(i);
        self.physics.remove_body_with_colliders(c.body, true);
        true
    }

    /// Moves a character to an administrative destination and clears its motion.
    pub fn set_character_position(&mut self, id: u32, position: [f32; 3]) -> bool {
        let Some(c) = self.characters.iter().find(|c| c.id == id) else {
            return false;
        };
        let body = &mut self.physics.bodies[c.body];
        body.set_position(Pose::from_translation(Vector::from(position)), true);
        body.set_next_kinematic_translation(Vector::from(position));
        true
    }

    // ── Stepping ──────────────────────────────────────────────────────────

    /// Advance one server tick.
    pub fn step(&mut self) {
        let dt = self.physics.integration_parameters.dt;
        self.impacts.clear();
        for _ in 0..SUBSTEPS {
            self.drive_vehicles(dt);
            self.move_characters(dt);
            // The solver cancels the approach velocity, so remember it before stepping.
            let before: Vec<Vector> = self
                .vehicles
                .iter()
                .map(|v| self.physics.bodies[v.body].linvel())
                .collect();
            self.physics.step();
            self.record_impacts(&before);
        }
    }

    /// Keeps the fastest horizontal approach per (vehicle, prop) pair this tick, as the Node
    /// contact pass did with `pointVelocity · normal` (angular velocity skipped).
    fn record_impacts(&mut self, before: &[Vector]) {
        if self.props.is_empty() {
            return;
        }
        for (v, vel) in self.vehicles.iter().zip(before) {
            for pair in self.physics.contact_pairs_with(v.collider) {
                let other = if pair.collider1 == v.collider {
                    pair.collider2
                } else {
                    pair.collider1
                };
                let Some((&prop, _)) = self.props.iter().find(|(_, c)| **c == other) else {
                    continue;
                };
                let Some((m, c)) = pair.find_deepest_contact() else {
                    continue;
                };
                if c.dist > 0.0 {
                    continue;
                }
                // The manifold normal points from collider1 to collider2.
                let n = if pair.collider1 == v.collider {
                    m.data.normal
                } else {
                    -m.data.normal
                };
                let speed = vel.x * n.x + vel.z * n.z;
                if speed <= 0.0 {
                    continue;
                }
                match self
                    .impacts
                    .iter_mut()
                    .find(|i| i.vehicle == v.id && i.prop == prop)
                {
                    Some(i) if i.speed >= speed => {}
                    Some(i) => (i.speed, i.velocity) = (speed, [vel.x, vel.y, vel.z]),
                    None => self.impacts.push(Impact {
                        vehicle: v.id,
                        prop,
                        speed,
                        velocity: [vel.x, vel.y, vel.z],
                    }),
                }
            }
        }
    }

    fn drive_vehicles(&mut self, dt: f32) {
        let p = &mut self.physics;
        for v in &mut self.vehicles {
            // Read speed off the body, not the controller: a controller rebuilt after a
            // restore has no history, and replay must match the continuous run exactly.
            let speed = p.bodies[v.body].linvel().length();
            // Steering lock halves at 30 m/s so fast turns stay gripped (as the old model).
            let lock = v.spec.steer / (1.0 + speed / 30.0);
            // Rapier takes a per-wheel, per-update brake impulse, so convert the total force.
            // An unpowered car near standstill is held by the parking brake, so it cannot
            // roll off a slope (`shared/physics/vehicle.ts` CAR.holdSpeed).
            let hold = v.drive.throttle == 0.0 && speed < HOLD_SPEED;
            let brake = if v.drive.brake || hold {
                v.spec.brake * dt / 4.0
            } else {
                0.0
            };
            // The engine fades out over the last 30% of the top speed, so a flat-out car
            // levels off there instead of accelerating without limit.
            let headroom = ((1.0 - speed / v.spec.top_speed) / 0.3).clamp(0.0, 1.0);
            // Wheel rays that land on a wall would drive the car up it, so a car tipped
            // beyond about 30 degrees loses its engine until it falls back.
            let upright = (p.bodies[v.body].rotation() * Vector::Y).y > 0.85;
            let force = v.drive.throttle.clamp(-1.0, 1.0) * v.spec.engine / 4.0
                * headroom
                * f32::from(upright);
            for (i, w) in v.controller.wheels_mut().iter_mut().enumerate() {
                w.steering = if i < 2 {
                    v.drive.steer.clamp(-1.0, 1.0) * lock
                } else {
                    0.0
                };
                w.engine_force = force;
                w.brake = brake;
            }
            let queries = p.broad_phase.as_query_pipeline_mut(
                p.narrow_phase.query_dispatcher(),
                &mut p.bodies,
                &mut p.colliders,
                QueryFilter::exclude_dynamic().exclude_rigid_body(v.body),
            );
            v.controller.update_vehicle(dt, queries);
        }
    }

    fn move_characters(&mut self, dt: f32) {
        let p = &mut self.physics;
        for c in &mut self.characters {
            if c.grounded && c.mv.jump {
                c.vertical = JUMP_SPEED;
            } else if !c.grounded {
                c.vertical += GRAVITY * dt;
            } else {
                c.vertical = 0.0;
            }
            let horizontal = Vector::new(c.mv.x, 0.0, c.mv.z).clamp_length_max(1.0) * c.mv.speed;
            let desired = (horizontal + Vector::new(0.0, c.vertical, 0.0)) * dt;
            let pose = *p.bodies[c.body].position();
            let shape = p.colliders[c.collider].shape();
            let queries =
                p.query_pipeline_with_filter(QueryFilter::default().exclude_rigid_body(c.body));
            let out = self
                .controller
                .move_shape(dt, &queries, shape, &pose, desired, |_| {});
            c.grounded = out.grounded;
            if out.grounded && c.vertical < 0.0 {
                c.vertical = 0.0;
            }
            p.bodies[c.body].set_next_kinematic_translation(pose.translation + out.translation);
        }
    }

    // ── Queries used by gameplay ──────────────────────────────────────────

    /// First body along `origin + dir * t`, `t <= max`: its vehicle/character id (0 for
    /// static geometry) and the distance. `exclude` skips one body id (0 skips none).
    pub fn cast_ray(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        max: f32,
        exclude: u32,
    ) -> Option<(u32, f32)> {
        let dir = Vector::from(dir).normalize_or_zero();
        let mut filter = QueryFilter::default();
        if let Some(h) = self.body_of(exclude) {
            filter = filter.exclude_rigid_body(h);
        }
        let (collider, t) =
            self.physics
                .cast_ray(&Ray::new(Vector::from(origin), dir), max, true, filter)?;
        let body = self.physics.colliders[collider].parent();
        let id = self
            .vehicles
            .iter()
            .map(|v| (v.id, v.body))
            .chain(self.characters.iter().map(|c| (c.id, c.body)))
            .find(|(_, b)| Some(*b) == body)
            .map_or(0, |(id, _)| id);
        Some((id, t))
    }

    fn body_of(&self, id: u32) -> Option<RigidBodyHandle> {
        self.vehicles
            .iter()
            .find(|v| v.id == id)
            .map(|v| v.body)
            .or_else(|| self.characters.iter().find(|c| c.id == id).map(|c| c.body))
    }

    /// Overrides a character's vertical speed and lifts it off the ground (jetpack thrust).
    pub fn set_vertical(&mut self, id: u32, vy: f32) -> bool {
        match self.characters.iter_mut().find(|c| c.id == id) {
            Some(c) => {
                c.vertical = vy;
                c.grounded = false;
                true
            }
            None => false,
        }
    }

    /// Moves a character to `position` at rest (respawn).
    pub fn teleport_character(&mut self, id: u32, position: [f32; 3]) -> bool {
        let Some(c) = self.characters.iter_mut().find(|c| c.id == id) else {
            return false;
        };
        let b = &mut self.physics.bodies[c.body];
        b.set_position(Pose::from_translation(Vector::from(position)), true);
        b.set_next_kinematic_translation(Vector::from(position));
        c.vertical = 0.0;
        c.grounded = false;
        true
    }

    // ── Reading and replaying state ───────────────────────────────────────

    /// Flat state: per vehicle `[id, x, y, z, qx, qy, qz, qw, vx, vy, vz]`, then per
    /// character `[id, x, y, z, vy, grounded]`. Counts come from [`World::counts`].
    pub fn states(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(
            self.vehicles.len() * VEHICLE_STRIDE + self.characters.len() * CHARACTER_STRIDE,
        );
        for v in &self.vehicles {
            let b = &self.physics.bodies[v.body];
            // A sleeping body keeps the velocity it dozed off with; report it as still.
            let l = if b.is_sleeping() {
                Vector::ZERO
            } else {
                b.linvel()
            };
            let (t, r) = (b.translation(), b.rotation());
            out.extend_from_slice(&[
                v.id as f32,
                t.x,
                t.y,
                t.z,
                r.x,
                r.y,
                r.z,
                r.w,
                l.x,
                l.y,
                l.z,
            ]);
        }
        for c in &self.characters {
            let t = self.physics.bodies[c.body].translation();
            out.extend_from_slice(&[
                c.id as f32,
                t.x,
                t.y,
                t.z,
                c.vertical,
                c.grounded as u8 as f32,
            ]);
        }
        out
    }

    pub fn counts(&self) -> (usize, usize) {
        (self.vehicles.len(), self.characters.len())
    }

    /// Dynamic state only, for prediction: restore the server's state then replay inputs.
    /// shortcut: wheel spin is not saved, it is cosmetic and never feeds back into motion;
    /// extend `restore` if wheel visuals must survive a reconcile.
    pub fn snapshot(&self) -> Vec<f32> {
        let mut out = Vec::new();
        for v in &self.vehicles {
            let b = &self.physics.bodies[v.body];
            let (t, r, l, a) = (b.translation(), b.rotation(), b.linvel(), b.angvel());
            out.extend_from_slice(&[
                t.x, t.y, t.z, r.x, r.y, r.z, r.w, l.x, l.y, l.z, a.x, a.y, a.z,
            ]);
        }
        for c in &self.characters {
            let t = self.physics.bodies[c.body].translation();
            out.extend_from_slice(&[t.x, t.y, t.z, c.vertical, c.grounded as u8 as f32]);
        }
        out
    }

    /// Inverse of [`World::snapshot`] for the same set of entities, spawned in the same order.
    pub fn restore(&mut self, data: &[f32]) -> Result<(), String> {
        let expected = self.vehicles.len() * 13 + self.characters.len() * 5;
        if data.len() != expected {
            return Err(format!(
                "snapshot has {} floats, world needs {expected}",
                data.len()
            ));
        }
        let (vehicles, rest) = data.split_at(self.vehicles.len() * 13);
        for (v, d) in self.vehicles.iter().zip(vehicles.as_chunks::<13>().0) {
            let b = &mut self.physics.bodies[v.body];
            b.set_position(
                Pose::from_parts(
                    Vector::new(d[0], d[1], d[2]),
                    Rotation::from_xyzw(d[3], d[4], d[5], d[6]),
                ),
                true,
            );
            b.set_linvel(Vector::new(d[7], d[8], d[9]), true);
            b.set_angvel(Vector::new(d[10], d[11], d[12]), true);
        }
        for (c, d) in self.characters.iter_mut().zip(rest.as_chunks::<5>().0) {
            let b = &mut self.physics.bodies[c.body];
            b.set_position(Pose::from_translation(Vector::new(d[0], d[1], d[2])), true);
            b.set_next_kinematic_translation(Vector::new(d[0], d[1], d[2]));
            c.vertical = d[3];
            c.grounded = d[4] != 0.0;
        }
        // A zero-length pipeline step re-indexes the moved bodies without integrating, so
        // the next tick's wheel raycasts see the same scene as a continuous run.
        let dt = self.physics.integration_parameters.dt;
        self.physics.integration_parameters.dt = 0.0;
        self.physics.step();
        self.physics.integration_parameters.dt = dt;
        Ok(())
    }
}
