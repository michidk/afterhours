//! AI road traffic: the car driver from `server/ai.ts`, spawn sites and budgets from
//! `server/traffic.ts`, and lane waypoints from `shared/navigation.ts`. Cars wander the
//! street graph at random instead of routing to a far goal; everything else is a port.
use crate::city::{City, Road};
use afterhours_physics::{Drive, TICK, VEHICLE_STRIDE, VehicleSpec, World};
use afterhours_protocol::{Entity, Kind};
use std::collections::{HashMap, VecDeque};

pub const AI_CAR_ID_BASE: u32 = 2 << 24;
/// `shared/catalog.ts` TUNING.interestRadius: AI farther than this from every player is removed.
pub const INTEREST_RADIUS: f32 = 220.0;
/// `server/traffic.ts` TRAFFIC.
pub const SPAWN_PLAYER_DISTANCE: f32 = 65.0;
const SPAWN_CAR_DISTANCE: f32 = 12.0;
pub const SAMPLE_TICKS: u32 = 30;
/// `shared/navigation.ts` lanePoint: right-hand lane offset from the centre line.
const LANE_OFFSET: f32 = 3.5;
/// shortcut: the Node server keeps 160 cars island-wide; near a player that is about three,
/// too few to notice. Spawn a dozen per player instead, capped at the Node total.
const CARS_PER_PLAYER: usize = 12;
const MAX_CARS: usize = 160;
/// `server/simulation.ts` spawn colours.
const COLORS: [&str; 5] = ["#e8b63f", "#e86551", "#55a9b8", "#f3eee0", "#80a177"];
/// `shared/catalog.ts` VEHICLES sedan/sport/van: (model, seats, health, spec).
const MODELS: [(&str, usize, f32, VehicleSpec); 3] = [
    ("sedan", 4, 100.0, VehicleSpec::SEDAN),
    ("sport", 2, 85.0, VehicleSpec::SPORT),
    ("van", 2, 170.0, VehicleSpec::VAN),
];

/// xorshift64: deterministic for a given city seed, no `rand` crate.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: i64) -> Self {
        Self((seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub fn roll(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.roll() % n as u64) as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Green,
    Amber,
    Red,
}

/// `shared/world.ts` signal: an 18 s cycle, z-axis traffic green first.
pub fn signal(time: f32, axis_x: bool) -> Signal {
    let phase = time.rem_euclid(18.0);
    let (green, amber) = if axis_x {
        ((9.0..16.0).contains(&phase), phase >= 16.0)
    } else {
        (phase < 7.0, (7.0..9.0).contains(&phase))
    };
    match (green, amber) {
        (true, _) => Signal::Green,
        (_, true) => Signal::Amber,
        _ => Signal::Red,
    }
}

pub fn wrap(a: f32) -> f32 {
    (a + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI
}

/// Positions of every human player in last tick's entity set.
pub fn players(entities: &HashMap<u32, Entity>) -> Vec<[f32; 2]> {
    entities
        .values()
        .filter(|e| e.kind == Kind::Player)
        .map(|e| [e.x, e.z])
        .collect()
}

pub fn nearest(players: &[[f32; 2]], x: f32, z: f32) -> f32 {
    players
        .iter()
        .map(|p| (p[0] - x).hypot(p[1] - z))
        .fold(f32::INFINITY, f32::min)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Junction {
    pub x: f32,
    pub z: f32,
    pub axis_x: bool,
    /// Stop line distance from the junction; legacy maps without one use 10 m.
    pub stop: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Waypoint {
    pub x: f32,
    pub z: f32,
    pub junction: Option<Junction>,
}

struct Node {
    x: f32,
    z: f32,
    edges: Vec<usize>,
}

/// `shared/navigation.ts` Navigation.roads: junction nodes and directed lane edges.
#[derive(Default)]
pub struct Graph {
    nodes: Vec<Node>,
    /// (from, to) -> signal axis (None: dominant axis of travel) and stop-line distance at `to`.
    links: HashMap<(usize, usize), (Option<bool>, Option<f32>)>,
}

impl Graph {
    pub fn new(roads: &[Road]) -> Self {
        let mut g = Graph::default();
        let mut ids = HashMap::new();
        for r in roads {
            let mut node = |x: f64, z: f64| {
                *ids.entry((x.to_bits(), z.to_bits())).or_insert_with(|| {
                    g.nodes.push(Node {
                        x: x as f32,
                        z: z as f32,
                        edges: Vec::new(),
                    });
                    g.nodes.len() - 1
                })
            };
            let (a, b) = (node(r.ax, r.az), node(r.bx, r.bz));
            if a == b || g.nodes[a].edges.contains(&b) {
                continue;
            }
            g.nodes[a].edges.push(b);
            g.nodes[b].edges.push(a);
            let axis = |p: &Option<String>| p.as_ref().map(|p| p == "x");
            g.links
                .insert((a, b), (axis(&r.phase_b), r.approach_b.map(|s| s as f32)));
            g.links
                .insert((b, a), (axis(&r.phase_a), r.approach_a.map(|s| s as f32)));
        }
        g
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn edges(&self, node: usize) -> &[usize] {
        &self.nodes[node].edges
    }

    /// `lanePoint`: the right-hand lane at `fraction` along the edge, with the signal
    /// approach when `to` is a junction of three or more streets.
    pub fn lane_point(&self, from: usize, to: usize, fraction: f32) -> Waypoint {
        let (a, b) = (&self.nodes[from], &self.nodes[to]);
        let (dx, dz) = (b.x - a.x, b.z - a.z);
        let len = dx.hypot(dz);
        let (axis, stop) = self.links[&(from, to)];
        Waypoint {
            x: a.x + dx * fraction + dz / len * LANE_OFFSET,
            z: a.z + dz * fraction - dx / len * LANE_OFFSET,
            junction: (b.edges.len() >= 3).then(|| Junction {
                x: b.x,
                z: b.z,
                axis_x: axis.unwrap_or(dx.abs() > dz.abs()),
                stop: stop.unwrap_or(10.0),
            }),
        }
    }

    /// `lanePath`: appends the lane end of `from -> to`, flagging earlier unflagged points
    /// within the stop line + 20 m of the junction so a car brakes for it in time.
    pub fn extend(&self, points: &mut VecDeque<Waypoint>, from: usize, to: usize) {
        let end = self.lane_point(from, to, 1.0);
        if let Some(j) = end.junction {
            for p in points.iter_mut().rev().take_while(|p| p.junction.is_none()) {
                if (p.x - j.x).hypot(p.z - j.z) > j.stop + 20.0 {
                    break;
                }
                p.junction = Some(j);
            }
        }
        points.push_back(end);
    }

    /// Next street at `node`, never straight back along `from` unless it is a dead end.
    pub fn onward(&self, from: usize, node: usize, rng: &mut Rng) -> usize {
        let edges = &self.nodes[node].edges;
        let choices: Vec<usize> = edges.iter().copied().filter(|&e| e != from).collect();
        if choices.is_empty() {
            edges[rng.below(edges.len())]
        } else {
            choices[rng.below(choices.len())]
        }
    }
}

struct Car {
    entity: u32,
    model: usize,
    color: &'static str,
    /// Current leg runs `prev -> node`; `points` are the lane targets ahead.
    prev: usize,
    node: usize,
    points: VecDeque<Waypoint>,
    cruise: f32,
    last_angle: f32,
    /// `server/ai.ts` route.progress: seconds without moving two metres.
    anchor: [f32; 2],
    stuck: f32,
}

#[derive(Default)]
pub struct Traffic {
    graph: Graph,
    /// (from, to, fraction, x, z, y) from `server/traffic.ts` makeSpawnSites.
    sites: Vec<(usize, usize, f32, f32, f32, f32)>,
    cars: HashMap<u32, Car>,
    rng: Option<Rng>,
    serial: u32,
}

impl Traffic {
    pub fn new(city: &City) -> Self {
        let graph = Graph::new(&city.roads);
        let mut sites = Vec::new();
        for from in 0..graph.len() {
            for &to in graph.edges(from) {
                for fraction in [0.35, 0.55, 0.75] {
                    let p = graph.lane_point(from, to, fraction);
                    sites.push((from, to, fraction, p.x, p.z, city.height(p.x, p.z) + 1.0));
                }
            }
        }
        Self {
            graph,
            sites,
            cars: HashMap::new(),
            rng: Some(Rng::new(city.seed)),
            serial: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.cars.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cars.is_empty()
    }

    /// Hands an AI car over to another owner: the physics vehicle stays in the world and
    /// stops being driven or despawned here. Returns its entity id so the new owner can
    /// keep the id the clients already know, or `None` if `car` is not an AI car.
    pub fn vacate_car(&mut self, car: u32) -> Option<u32> {
        self.cars.remove(&car).map(|c| c.entity)
    }

    /// Drives every car with last tick's `entities`, despawns cars no player is near, and
    /// once a second tops the fleet up around players. Call before `world.step()`.
    pub fn step(&mut self, world: &mut World, entities: &HashMap<u32, Entity>, tick: u32) {
        let Some(mut rng) = self.rng.take() else {
            return;
        };
        let players = players(entities);
        let time = tick as f32 * TICK;
        self.cars.retain(|&id, car| {
            let near = entities
                .get(&car.entity)
                .is_none_or(|e| nearest(&players, e.x, e.z) <= INTEREST_RADIUS);
            if !near {
                world.remove_vehicle(id);
            }
            near
        });
        for (&id, car) in &mut self.cars {
            if let Some(e) = entities.get(&car.entity) {
                world.set_drive(id, car.drive(e, entities, time, &self.graph, &mut rng));
            }
        }
        if tick.is_multiple_of(SAMPLE_TICKS) {
            self.spawn(world, entities, &players, &mut rng);
        }
        self.rng = Some(rng);
    }

    fn spawn(
        &mut self,
        world: &mut World,
        entities: &HashMap<u32, Entity>,
        players: &[[f32; 2]],
        rng: &mut Rng,
    ) {
        let budget = (players.len() * CARS_PER_PLAYER).min(MAX_CARS);
        if players.is_empty() || self.cars.len() >= budget {
            return;
        }
        let mut open: Vec<usize> = (0..self.sites.len())
            .filter(|&i| {
                let (.., x, z, _) = self.sites[i];
                let d = nearest(players, x, z);
                (SPAWN_PLAYER_DISTANCE..INTEREST_RADIUS - 20.0).contains(&d)
                    && !entities.values().any(|e| {
                        e.kind == Kind::Car && (e.x - x).hypot(e.z - z) < SPAWN_CAR_DISTANCE
                    })
            })
            .collect();
        while self.cars.len() < budget && !open.is_empty() {
            let (from, to, _, x, z, y) = self.sites[open.swap_remove(rng.below(open.len()))];
            let (a, b) = (
                self.graph.lane_point(from, to, 0.0),
                self.graph.lane_point(from, to, 1.0),
            );
            let model = self.serial as usize % MODELS.len();
            let id = world.spawn_vehicle(MODELS[model].3, [x, y, z], (b.x - a.x).atan2(b.z - a.z));
            let mut points = VecDeque::new();
            self.graph.extend(&mut points, from, to);
            self.cars.insert(
                id,
                Car {
                    entity: AI_CAR_ID_BASE + self.serial,
                    model,
                    color: COLORS[self.serial as usize % COLORS.len()],
                    prev: from,
                    node: to,
                    points,
                    // `server/ai.ts`: calm and timid drivers cruise at 7 m/s, the rest at 9.
                    cruise: if rng.below(2) == 0 { 7.0 } else { 9.0 },
                    last_angle: 0.0,
                    anchor: [x, z],
                    stuck: 0.0,
                },
            );
            self.serial += 1;
        }
    }

    /// Appends one `Entity` per AI car from the physics rows keyed by vehicle id.
    pub fn entities(
        &self,
        rows: &HashMap<u32, &[f32; VEHICLE_STRIDE]>,
        out: &mut HashMap<u32, Entity>,
    ) {
        for (id, car) in &self.cars {
            let Some(r) = rows.get(id) else { continue };
            let (model, seats, health, _) = MODELS[car.model];
            let (angle, pitch, roll) = crate::game::euler([r[4], r[5], r[6], r[7]]);
            out.insert(
                car.entity,
                Entity {
                    id: car.entity.to_string(),
                    kind: Kind::Car,
                    x: r[1],
                    y: r[2],
                    z: r[3],
                    angle,
                    pitch,
                    roll,
                    vx: r[8],
                    vy: r[9],
                    vz: r[10],
                    color: car.color.into(),
                    health,
                    max_health: Some(health),
                    model: Some(model.into()),
                    seats: Some(vec![None; seats]),
                    ai: Some(true),
                    ..Default::default()
                },
            );
        }
    }
}

impl Car {
    /// `server/ai.ts` CityAI.car without personalities and reactions.
    fn drive(
        &mut self,
        e: &Entity,
        entities: &HashMap<u32, Entity>,
        time: f32,
        graph: &Graph,
        rng: &mut Rng,
    ) -> Drive {
        while self.points.len() < 3 {
            let next = graph.onward(self.prev, self.node, rng);
            graph.extend(&mut self.points, self.node, next);
            (self.prev, self.node) = (self.node, next);
        }
        let mut target = self.points[0];
        if (target.x - e.x).hypot(target.z - e.z) < 4.0 {
            self.points.pop_front();
            target = self.points[0];
        }
        let (sin, cos) = e.angle.sin_cos();
        let error = wrap((target.x - e.x).atan2(target.z - e.z) - e.angle);
        let speed = e.vx.hypot(e.vz);
        let mut desired = if error.abs() > 0.25 { 4.0 } else { self.cruise };
        let stop = target.junction.is_some_and(|j| {
            let (dx, dz) = (j.x - e.x, j.z - e.z);
            let (ahead, side) = (dx * sin + dz * cos, (dx * cos - dz * sin).abs());
            let held = side < 12.0
                && ahead > j.stop - 1.0
                && ahead < j.stop + 14.0
                && signal(time, j.axis_x) != Signal::Green;
            if held {
                desired = desired.min((ahead - j.stop - 1.0).max(0.0) * 0.8);
            }
            held
        });
        for o in entities.values() {
            if o.kind != Kind::Car || o.id == e.id || (o.y - e.y).abs() > 2.0 {
                continue;
            }
            let (dx, dz) = (o.x - e.x, o.z - e.z);
            let (ahead, side) = (dx * sin + dz * cos, dx * cos - dz * sin);
            if ahead > 0.0 && ahead < 14.0 && side.abs() < 2.1 {
                desired = desired.min((ahead - 5.0).max(0.0) * 0.9);
            }
        }
        let yaw_rate = wrap(e.angle - self.last_angle) / TICK;
        self.last_angle = e.angle;
        if (e.x - self.anchor[0]).hypot(e.z - self.anchor[1]) > 2.0 {
            self.anchor = [e.x, e.z];
            self.stuck = 0.0;
        } else {
            self.stuck += TICK;
        }
        // Reverse out of a collision rather than permanently abandoning the lane.
        if self.stuck > 13.0 && !stop {
            if self.stuck > 16.0 {
                self.stuck = 0.0;
            }
            return Drive {
                throttle: -0.4,
                steer: -error.clamp(-1.0, 1.0),
                occupied: true,
                ..Drive::default()
            };
        }
        Drive {
            throttle: if speed < desired { 0.65 } else { 0.0 },
            steer: (error * 2.0 - yaw_rate * 0.5).clamp(-1.0, 1.0),
            // shortcut: a threshold stands in for the Node service-brake ramp.
            service_brake: f32::from(speed > desired + 0.5),
            brake: false,
            occupied: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_phases_follow_the_node_cycle() {
        assert_eq!(signal(0.0, false), Signal::Green);
        assert_eq!(signal(0.0, true), Signal::Red);
        assert_eq!(signal(7.5, false), Signal::Amber);
        assert_eq!(signal(9.0, true), Signal::Green);
        assert_eq!(signal(16.5, true), Signal::Amber);
        assert_eq!(signal(16.5, false), Signal::Red);
        assert_eq!(signal(18.0, false), Signal::Green);
    }

    fn road(ax: f64, az: f64, bx: f64, bz: f64) -> Road {
        Road {
            ax,
            az,
            bx,
            bz,
            width: 12.0,
            phase_a: None,
            phase_b: None,
            approach_a: Some(8.0),
            approach_b: Some(8.0),
        }
    }

    #[test]
    fn lane_points_offset_right_and_flag_junction_approaches() {
        // A crossroads at the origin with four 100 m arms.
        let roads = [
            road(-100.0, 0.0, 0.0, 0.0),
            road(0.0, 0.0, 100.0, 0.0),
            road(0.0, -100.0, 0.0, 0.0),
            road(0.0, 0.0, 0.0, 100.0),
        ];
        let g = Graph::new(&roads);
        assert_eq!(g.len(), 5);
        let (west, centre) = (0, 1);
        let p = g.lane_point(west, centre, 1.0);
        // Driving east (+x) the right-hand lane lies at -z.
        assert_eq!((p.x, p.z), (0.0, -LANE_OFFSET));
        let j = p.junction.unwrap();
        assert!(j.axis_x);
        assert_eq!(j.stop, 8.0);
        let mut points = VecDeque::from([g.lane_point(west, centre, 0.8)]);
        g.extend(&mut points, west, centre);
        assert_eq!(points[0].junction, Some(j), "20 m out is within stop + 20");
        assert!(g.lane_point(centre, west, 1.0).junction.is_none());
        let mut rng = Rng::new(1);
        for _ in 0..20 {
            assert_ne!(g.onward(west, centre, &mut rng), west);
        }
    }

    #[test]
    fn a_car_keeps_three_targets_ahead_and_stops_for_red() {
        let roads = [road(-100.0, 0.0, 0.0, 0.0), road(0.0, 0.0, 100.0, 0.0)];
        let g = Graph::new(&roads);
        let mut car = Car {
            entity: 1,
            model: 0,
            color: "#fff",
            prev: 0,
            node: 1,
            points: VecDeque::new(),
            cruise: 9.0,
            last_angle: 0.0,
            anchor: [0.0, 0.0],
            stuck: 0.0,
        };
        let e = Entity {
            x: -50.0,
            z: -LANE_OFFSET,
            angle: std::f32::consts::FRAC_PI_2,
            ..Default::default()
        };
        let d = car.drive(&e, &HashMap::new(), 0.0, &g, &mut Rng::new(3));
        assert_eq!(car.points.len(), 3);
        assert!(d.throttle > 0.0 && d.service_brake == 0.0);
        // Signalled junctions need three arms; fake one 8 m ahead with the x axis on red.
        car.points[0].junction = Some(Junction {
            x: -42.0,
            z: 0.0,
            axis_x: true,
            stop: 8.0,
        });
        let moving = Entity {
            vx: 6.0,
            ..e.clone()
        };
        let d = car.drive(&moving, &HashMap::new(), 0.0, &g, &mut Rng::new(3));
        assert_eq!(d.throttle, 0.0);
        assert!(d.service_brake > 0.0);
        let d = car.drive(&moving, &HashMap::new(), 10.0, &g, &mut Rng::new(3));
        assert!(d.throttle > 0.0, "green for x traffic at 10 s");
    }
}
