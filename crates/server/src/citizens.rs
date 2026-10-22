//! AI pedestrians: `server/citizens.ts` population budget and `server/ai.ts` pedestrian
//! walking over the artifact's sidewalk graph (`shared/navigation.ts` Navigation.sidewalks).
//! They wander node to node, wait for the signal at crossings, and idle now and then.
//! Skipped: reactions (fleeing, fighting), routines, and the legacy no-walkway fallback.
use crate::city::City;
use crate::traffic::{
    INTEREST_RADIUS, Rng, SAMPLE_TICKS, SPAWN_PLAYER_DISTANCE, Signal, nearest, players, signal,
};
use afterhours_physics::{CHARACTER_FEET, CHARACTER_STRIDE, Move, TICK, World};
use afterhours_protocol::{Entity, Kind};
use serde_json::json;
use std::collections::HashMap;

pub const PEDESTRIAN_ID_BASE: u32 = 3 << 24;
/// shortcut: the Node server keeps 300 pedestrians island-wide, about five near a player.
/// Spawn two dozen per player instead, capped at the Node total.
const PER_PLAYER: usize = 24;
const MAX: usize = 300;
/// `shared/catalog.ts` TUNING.walk times `shared/character.ts` PHYSIQUES speed.
const WALK: f32 = 4.5;
/// `shared/character.ts`: (physique, health, speed), skins, hair, tops, legs, SHIRT_COLORS.
const PHYSIQUES: [(&str, f32, f32); 3] = [
    ("runner", 80.0, 1.2),
    ("regular", 100.0, 1.0),
    ("tank", 150.0, 0.8),
];
const SKINS: [&str; 4] = ["#edc5a5", "#c99773", "#986747", "#654432"];
const HAIR: [&str; 4] = ["crop", "curls", "cap", "shaved"];
const TOPS: [&str; 3] = ["tee", "jacket", "vest"];
const LEGS: [&str; 3] = ["trousers", "shorts", "cargo"];
const SHIRTS: [&str; 6] = [
    "#e8b63f", "#c4664e", "#588f91", "#8d829e", "#7b8960", "#e4dfca",
];

struct Pedestrian {
    entity: u32,
    character: serde_json::Value,
    color: &'static str,
    health: f32,
    speed: f32,
    prev: usize,
    node: usize,
    /// Crossing axis of the current link, until the walker has committed to it.
    crossing: Option<bool>,
    /// Idle at a node until this time.
    until: f32,
    heading: [f32; 2],
}

#[derive(Default)]
pub struct Citizens {
    /// Sidewalk nodes as physics positions (x, y, z) and their links as (node, crossing axis: Some(true) = x).
    nodes: Vec<[f32; 3]>,
    edges: Vec<Vec<(usize, Option<bool>)>>,
    people: HashMap<u32, Pedestrian>,
    rng: Option<Rng>,
    serial: u32,
}

impl Citizens {
    pub fn new(city: &City) -> Self {
        let mut c = Citizens {
            rng: Some(Rng::new(city.seed ^ 0x5151)),
            ..Default::default()
        };
        if let Some(w) = &city.walkways {
            for p in w.points.as_chunks::<2>().0 {
                let (x, z) = (p[0] as f32, p[1] as f32);
                c.nodes.push([x, city.height(x, z) + 1.0, z]);
            }
            c.edges = vec![Vec::new(); c.nodes.len()];
            for l in w.links.as_chunks::<3>().0 {
                let (a, b) = (l[0] as usize, l[1] as usize);
                let crossing = match l[2] {
                    1 => Some(true),
                    2 => Some(false),
                    _ => None,
                };
                c.edges[a].push((b, crossing));
                c.edges[b].push((a, crossing));
            }
        }
        c
    }

    pub fn len(&self) -> usize {
        self.people.len()
    }

    pub fn is_empty(&self) -> bool {
        self.people.is_empty()
    }

    /// Walks everyone with last tick's `entities`, removes walkers no player is near, and
    /// once a second tops the population up around players. Call before `world.step()`.
    pub fn step(&mut self, world: &mut World, entities: &HashMap<u32, Entity>, tick: u32) {
        let Some(mut rng) = self.rng.take() else {
            return;
        };
        let players = players(entities);
        let time = tick as f32 * TICK;
        self.people.retain(|&id, p| {
            let near = entities
                .get(&p.entity)
                .is_none_or(|e| nearest(&players, e.x, e.z) <= INTEREST_RADIUS);
            if !near {
                world.remove_character(id);
            }
            near
        });
        for (&id, p) in &mut self.people {
            if let Some(e) = entities.get(&p.entity) {
                let mv = p.walk(e, entities, time, &self.nodes, &self.edges, &mut rng);
                world.set_move(id, mv);
            }
        }
        if tick.is_multiple_of(SAMPLE_TICKS) {
            self.spawn(world, &players, &mut rng);
        }
        self.rng = Some(rng);
    }

    fn spawn(&mut self, world: &mut World, players: &[[f32; 2]], rng: &mut Rng) {
        let budget = (players.len() * PER_PLAYER).min(MAX);
        if players.is_empty() || self.people.len() >= budget {
            return;
        }
        let mut open: Vec<usize> = (0..self.nodes.len())
            .filter(|&i| {
                let [x, _, z] = self.nodes[i];
                !self.edges[i].is_empty()
                    && (SPAWN_PLAYER_DISTANCE..INTEREST_RADIUS - 20.0)
                        .contains(&nearest(players, x, z))
            })
            .collect();
        while self.people.len() < budget && !open.is_empty() {
            let node = open.swap_remove(rng.below(open.len()));
            let id = world.spawn_character(self.nodes[node]);
            let (physique, health, speed) = PHYSIQUES[rng.below(3)];
            let (next, crossing) = self.edges[node][rng.below(self.edges[node].len())];
            self.people.insert(
                id,
                Pedestrian {
                    entity: PEDESTRIAN_ID_BASE + self.serial,
                    character: json!({
                        "physique": physique,
                        "skin": SKINS[rng.below(4)],
                        "hair": HAIR[rng.below(4)],
                        "top": TOPS[rng.below(3)],
                        "legs": LEGS[rng.below(3)],
                    }),
                    color: SHIRTS[rng.below(6)],
                    health,
                    speed: WALK * speed,
                    prev: node,
                    node: next,
                    crossing,
                    until: 0.0,
                    heading: [0.0, 1.0],
                },
            );
            self.serial += 1;
        }
    }

    /// Appends one `Entity` per pedestrian from the physics rows keyed by character id.
    pub fn entities(
        &self,
        rows: &HashMap<u32, &[f32; CHARACTER_STRIDE]>,
        out: &mut HashMap<u32, Entity>,
    ) {
        for (id, p) in &self.people {
            let Some(r) = rows.get(id) else { continue };
            out.insert(
                p.entity,
                Entity {
                    id: p.entity.to_string(),
                    kind: Kind::Pedestrian,
                    x: r[1],
                    y: r[2] - CHARACTER_FEET,
                    z: r[3],
                    angle: p.heading[0].atan2(p.heading[1]),
                    vx: p.heading[0] * p.speed,
                    vy: r[4],
                    vz: p.heading[1] * p.speed,
                    color: p.color.into(),
                    health: p.health,
                    max_health: Some(p.health),
                    character: Some(p.character.clone()),
                    ai: Some(true),
                    ..Default::default()
                },
            );
        }
    }
}

impl Pedestrian {
    /// `server/ai.ts` CityAI.pedestrian without reactions: head for the next node, wait at
    /// a crossing until its traffic is on red and no car is within 8 m, idle at some nodes.
    fn walk(
        &mut self,
        e: &Entity,
        entities: &HashMap<u32, Entity>,
        time: f32,
        nodes: &[[f32; 3]],
        edges: &[Vec<(usize, Option<bool>)>],
        rng: &mut Rng,
    ) -> Move {
        let still = Move::default();
        if time < self.until {
            return still;
        }
        let [tx, _, tz] = nodes[self.node];
        let (dx, dz) = (tx - e.x, tz - e.z);
        if dx.hypot(dz) < 0.9 {
            let (next, crossing) = edges[self.node]
                .iter()
                .copied()
                .filter(|&(n, _)| n != self.prev || edges[self.node].len() == 1)
                .nth(rng.below(edges[self.node].len().saturating_sub(1).max(1)))
                .unwrap_or(edges[self.node][0]);
            (self.prev, self.node, self.crossing) = (self.node, next, crossing);
            // `server/ai.ts` routine stops: pause 2 to 10 s, here at one node in six.
            if rng.below(6) == 0 {
                self.until = time + 2.0 + rng.below(9) as f32;
            }
            return still;
        }
        if let Some(axis_x) = self.crossing {
            let car_near = entities
                .values()
                .any(|o| o.kind == Kind::Car && (o.x - e.x).hypot(o.z - e.z) < 8.0);
            if signal(time, axis_x) != Signal::Red || car_near {
                return still;
            }
            self.crossing = None;
        }
        let len = dx.hypot(dz);
        self.heading = [dx / len, dz / len];
        Move {
            x: dx,
            z: dz,
            speed: self.speed,
            jump: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn walker(prev: usize, node: usize, crossing: Option<bool>) -> Pedestrian {
        Pedestrian {
            entity: 1,
            character: json!(null),
            color: "#fff",
            health: 100.0,
            speed: WALK,
            prev,
            node,
            crossing,
            until: 0.0,
            heading: [0.0, 1.0],
        }
    }

    #[test]
    fn a_walker_waits_at_a_crossing_until_its_traffic_is_red() {
        // Three nodes in a row; the middle link is a crossing of x-axis traffic.
        let nodes = [[0.0, 1.0, 0.0], [10.0, 1.0, 0.0], [20.0, 1.0, 0.0]];
        let edges = vec![
            vec![(1, Some(true))],
            vec![(0, Some(true)), (2, None)],
            vec![(1, None)],
        ];
        let mut p = walker(0, 1, Some(true));
        let e = Entity::default();
        let mut rng = Rng::new(7);
        // x traffic is green from 9 s: the walker holds.
        assert_eq!(
            p.walk(&e, &HashMap::new(), 10.0, &nodes, &edges, &mut rng)
                .speed,
            0.0
        );
        // Red for x traffic at 0 s, but a car within 8 m still holds it.
        let car = HashMap::from([(
            9,
            Entity {
                kind: Kind::Car,
                x: 5.0,
                ..Default::default()
            },
        )]);
        assert_eq!(p.walk(&e, &car, 0.0, &nodes, &edges, &mut rng).speed, 0.0);
        let mv = p.walk(&e, &HashMap::new(), 0.0, &nodes, &edges, &mut rng);
        assert!(mv.x > 0.0 && mv.speed == WALK);
        assert!(
            p.crossing.is_none(),
            "committed: a later green no longer stops it"
        );
        assert!(
            p.walk(&e, &HashMap::new(), 10.0, &nodes, &edges, &mut rng)
                .speed
                > 0.0
        );
        // Arriving at node 1 turns onward to node 2, never back to 0.
        let at = Entity {
            x: 10.0,
            ..Default::default()
        };
        p.walk(&at, &HashMap::new(), 0.0, &nodes, &edges, &mut rng);
        assert_eq!((p.prev, p.node), (1, 2));
    }
}
