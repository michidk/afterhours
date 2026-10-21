//! Combat, inventory, pickups, grenades, jetpack, health and respawn, ported from the Node
//! server (`server/combat.ts`, `server/inventory.ts`, `server/grenades.ts`,
//! `server/simulation.ts`). Per-player state lives here keyed by session id; `Game` feeds
//! controls and positions in and reads entity fields and snapshot lists out.
use crate::game::Player;
use afterhours_physics::{Drive, Move, World};
use afterhours_protocol::{
    Controls, Entity, GrenadeState, Jetpack, Pickup, PickupPayload, WeaponItem, WorldEvent,
};
use std::collections::HashMap;

const DT: f32 = 1.0 / 30.0;
// shared/catalog.ts TUNING
const PICKUP_SECONDS: f64 = 120.0;
const INTEREST_RADIUS: f32 = 220.0;
const WRECK_SECONDS: f32 = 180.0;
const PICKUP_RANGE: f32 = 2.5;
// server/grenades.ts
const FUSE_SECONDS: f64 = 3.0;
const MAX_GRENADES: usize = 96;
const GRENADE_GRAVITY: f32 = 18.0;
// shared/physics/jetpack.ts JETPACK (no ceiling)
const JETPACK_DRAIN: f32 = 1.0;
const JETPACK_SPEED: f32 = 10.0;
// server/simulation.ts damage(): a downed player lies for 3 s, then respawns.
const DOWN_SECONDS: f32 = 3.0;
const CHEST: f32 = 0.3;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Melee,
    Hitscan,
    Flame,
    Throw,
}

struct Spec {
    kind: &'static str,
    mode: Mode,
    ammo_kind: &'static str,
    damage: f32,
    range: f32,
    cooldown: f64,
    magazine: u32,
    reserve: u32,
    reload: f64,
}

/// shared/catalog.ts WEAPONS: kind, mode, ammo kind, damage, range, cooldown, magazine,
/// reserve, reload.
#[rustfmt::skip]
const WEAPONS: &[Spec] = &[
    Spec { kind: "fists", mode: Mode::Melee, ammo_kind: "", damage: 20.0, range: 2.1, cooldown: 0.55, magazine: 0, reserve: 0, reload: 0.0 },
    Spec { kind: "bat", mode: Mode::Melee, ammo_kind: "", damage: 30.0, range: 3.0, cooldown: 0.65, magazine: 0, reserve: 0, reload: 0.0 },
    Spec { kind: "pistol", mode: Mode::Hitscan, ammo_kind: "handgun", damage: 25.0, range: 40.0, cooldown: 0.3, magazine: 12, reserve: 48, reload: 1.4 },
    Spec { kind: "smg", mode: Mode::Hitscan, ammo_kind: "light", damage: 12.0, range: 32.0, cooldown: 0.1, magazine: 24, reserve: 96, reload: 1.8 },
    Spec { kind: "knife", mode: Mode::Melee, ammo_kind: "", damage: 35.0, range: 1.7, cooldown: 0.35, magazine: 0, reserve: 0, reload: 0.0 },
    Spec { kind: "machinegun", mode: Mode::Hitscan, ammo_kind: "rifle", damage: 19.0, range: 55.0, cooldown: 0.08, magazine: 60, reserve: 180, reload: 3.0 },
    Spec { kind: "flamethrower", mode: Mode::Flame, ammo_kind: "fuel", damage: 5.0, range: 9.0, cooldown: 0.1, magazine: 100, reserve: 200, reload: 2.5 },
    Spec { kind: "grenade", mode: Mode::Throw, ammo_kind: "grenade", damage: 130.0, range: 12.0, cooldown: 0.7, magazine: 3, reserve: 0, reload: 0.0 },
];

fn spec(kind: &str) -> &'static Spec {
    WEAPONS
        .iter()
        .find(|s| s.kind == kind)
        .unwrap_or(&WEAPONS[0])
}

/// shared/character.ts PHYSIQUES health; unknown or missing physiques count as regular.
pub fn physique_health(character: Option<&serde_json::Value>) -> f32 {
    match character.and_then(|c| c["physique"].as_str()) {
        Some("runner") => 80.0,
        Some("tank") => 150.0,
        _ => 100.0,
    }
}

#[derive(Default)]
struct Fighter {
    health: f32,
    max_health: f32,
    inventory: Vec<WeaponItem>,
    equipped: usize,
    reload_until: Option<f64>,
    cooldown: f64,
    aim: f32,
    down: f32,
    jetpack: Option<Jetpack>,
    /// This tick's controls, edge flags intact; taken once per step.
    controls: Controls,
}

struct Hull {
    health: f32,
    wreck: f32,
}

struct Source {
    at: [f32; 3],
    payload: PickupPayload,
    id: String,
    next: f64,
}

#[derive(Clone, Copy, PartialEq)]
enum Target {
    Player(u32),
    /// Vehicle physics id.
    Car(u32),
}

type Cars = HashMap<u32, (u32, Option<u32>)>;

#[derive(Default)]
pub struct Combat {
    fighters: HashMap<u32, Fighter>,
    /// Keyed by vehicle physics id.
    hulls: HashMap<u32, Hull>,
    pickups: Vec<Pickup>,
    sources: Vec<Source>,
    grenades: Vec<GrenadeState>,
    events: Vec<WorldEvent>,
    serial: u32,
}

/// Physics id -> position for every vehicle and character, and -> vertical speed for
/// characters.
fn poses(world: &World) -> (HashMap<u32, [f32; 3]>, HashMap<u32, f32>) {
    let s = world.states();
    let (nv, _) = world.counts();
    let (v, c) = s.split_at(nv * afterhours_physics::VEHICLE_STRIDE);
    let mut at = HashMap::new();
    let mut vy = HashMap::new();
    for r in v.as_chunks::<{ afterhours_physics::VEHICLE_STRIDE }>().0 {
        at.insert(r[0] as u32, [r[1], r[2], r[3]]);
    }
    for r in c.as_chunks::<{ afterhours_physics::CHARACTER_STRIDE }>().0 {
        at.insert(r[0] as u32, [r[1], r[2], r[3]]);
        vy.insert(r[0] as u32, r[4]);
    }
    (at, vy)
}

/// The body a hit on `t` lands on: the player's character, or the car itself.
fn body_of(t: Target, players: &HashMap<u32, Player>) -> Option<u32> {
    match t {
        Target::Player(p) => players.get(&p)?.body.ok(),
        Target::Car(c) => Some(c),
    }
}

/// Everything `me` can hit: other players on foot and every car, with positions.
fn targets(
    me: u32,
    players: &HashMap<u32, Player>,
    cars: &Cars,
    at: &HashMap<u32, [f32; 3]>,
) -> Vec<(Target, [f32; 3])> {
    let mut out: Vec<_> = players
        .iter()
        .filter(|(id, _)| **id != me)
        .filter_map(|(id, p)| Some((Target::Player(*id), *at.get(&p.body.ok()?)?)))
        .collect();
    out.extend(
        cars.keys()
            .filter_map(|c| Some((Target::Car(*c), *at.get(c)?))),
    );
    out.sort_by_key(|(t, _)| match t {
        Target::Player(p) => (0, *p),
        Target::Car(c) => (1, *c),
    });
    out
}

impl Combat {
    fn item(&mut self, kind: &str) -> WeaponItem {
        self.serial += 1;
        let s = spec(kind);
        WeaponItem {
            id: format!("w{}", self.serial),
            kind: s.kind.into(),
            ammo: s.magazine,
            reserve: s.reserve,
        }
    }

    /// `Inventory.initialize`: fists only, full health.
    fn fighter(&mut self, id: u32, character: Option<&serde_json::Value>) -> &mut Fighter {
        if !self.fighters.contains_key(&id) {
            let health = physique_health(character);
            let fists = self.item("fists");
            self.fighters.insert(
                id,
                Fighter {
                    health,
                    max_health: health,
                    inventory: vec![fists],
                    ..Default::default()
                },
            );
        }
        self.fighters.get_mut(&id).unwrap()
    }

    pub fn forget(&mut self, id: u32) {
        self.fighters.remove(&id);
    }

    /// Records the controls `Game::apply_input` resolved for this tick, edge flags intact.
    pub(crate) fn control(&mut self, id: u32, c: &Controls, character: Option<&serde_json::Value>) {
        let f = self.fighter(id, character);
        f.controls = c.clone();
        if let Some(a) = c.aim {
            f.aim = a;
        }
    }

    fn event(&mut self, kind: &str, at: [f32; 3], fill: impl FnOnce(&mut WorldEvent)) {
        let mut e = WorldEvent {
            kind: kind.into(),
            x: at[0],
            y: at[1],
            z: at[2],
            angle: None,
            length: None,
            target: None,
            source: None,
            sound: None,
        };
        fill(&mut e);
        self.events.push(e);
    }

    // ── Pickups ───────────────────────────────────────────────────────────

    pub fn spawn_pickup(&mut self, at: [f32; 3], payload: PickupPayload, expires: f64) -> String {
        self.serial += 1;
        let id = format!("p{}", self.serial);
        self.pickups.push(Pickup {
            payload,
            id: id.clone(),
            x: at[0],
            y: at[1],
            z: at[2],
            expires,
        });
        id
    }

    /// A pad that restocks itself 20 s after being emptied (`Inventory.addSupplySource`).
    pub fn add_source(&mut self, at: [f32; 3], payload: PickupPayload) {
        let id = self.spawn_pickup(at, payload.clone(), f64::MAX);
        self.sources.push(Source {
            at,
            payload,
            id,
            next: 0.0,
        });
    }

    /// The city's weapon pads plus the supply ring around them (`Simulation.addSupplies`).
    pub fn supplies(&mut self, pads: &[(f32, f32, String)], height: impl Fn(f32, f32) -> f32) {
        for (x, z, weapon) in pads {
            let item = self.item(weapon);
            self.add_source([*x, height(*x, *z), *z], PickupPayload::Weapon { item });
        }
        let mut payloads: Vec<PickupPayload> = ["knife", "machinegun", "flamethrower", "grenade"]
            .into_iter()
            .map(|k| PickupPayload::Weapon { item: self.item(k) })
            .collect();
        payloads.extend(["handgun", "light", "rifle", "fuel", "grenade"].map(|k| {
            PickupPayload::Ammo {
                ammo_kind: k.into(),
                amount: if k == "grenade" { 3 } else { 60 },
            }
        }));
        payloads.push(PickupPayload::Jetpack { fuel: 30.0 });
        #[rustfmt::skip]
        const RING: [(f32, f32); 8] = [(3.0, 0.0), (-3.0, 0.0), (0.0, 3.0), (0.0, -3.0), (6.0, 0.0), (-6.0, 0.0), (0.0, 6.0), (0.0, -6.0)];
        'payload: for payload in payloads {
            for (px, pz, _) in pads {
                for (dx, dz) in RING {
                    let (x, z) = (px + dx, pz + dz);
                    if self.pickups.iter().any(|p| (p.x - x).hypot(p.z - z) < 2.8) {
                        continue;
                    }
                    self.add_source([x, height(x, z), z], payload);
                    continue 'payload;
                }
            }
        }
    }

    fn cleanup(&mut self, time: f64) {
        self.pickups.retain(|p| p.expires >= time);
        for i in 0..self.sources.len() {
            let s = &self.sources[i];
            if self.pickups.iter().any(|p| p.id == s.id) {
                continue;
            }
            if s.next == 0.0 {
                self.sources[i].next = time + 20.0;
            } else if time >= s.next {
                let payload = match &s.payload {
                    PickupPayload::Weapon { item } => {
                        let kind = item.kind.clone();
                        PickupPayload::Weapon {
                            item: self.item(&kind),
                        }
                    }
                    other => other.clone(),
                };
                let at = self.sources[i].at;
                self.sources[i].id = self.spawn_pickup(at, payload, f64::MAX);
                self.sources[i].next = 0.0;
            }
        }
    }

    /// `Inventory.pickup`: the nearest pickup in reach, on `interact` like the Node server.
    fn pickup(&mut self, id: u32, at: [f32; 3]) {
        let flat = |p: &Pickup| (p.x - at[0]).hypot(p.z - at[2]);
        let Some(i) = (0..self.pickups.len())
            .filter(|&i| {
                let p = &self.pickups[i];
                (p.y - at[1]).abs() < 1.2 && flat(p) < PICKUP_RANGE
            })
            .min_by(|&a, &b| flat(&self.pickups[a]).total_cmp(&flat(&self.pickups[b])))
        else {
            return;
        };
        let f = self.fighters.get_mut(&id).unwrap();
        match &mut self.pickups[i].payload {
            PickupPayload::Ammo { ammo_kind, amount } => {
                for item in &mut f.inventory {
                    let s = spec(&item.kind);
                    if s.ammo_kind != ammo_kind {
                        continue;
                    }
                    let (field, cap) = if s.mode == Mode::Throw {
                        (&mut item.ammo, s.magazine)
                    } else {
                        (&mut item.reserve, s.reserve)
                    };
                    let take = (*amount).min(cap.saturating_sub(*field));
                    *field += take;
                    *amount -= take;
                }
                if *amount == 0 {
                    self.pickups.remove(i);
                }
            }
            PickupPayload::Jetpack { fuel } => {
                if f.jetpack.is_none() {
                    f.jetpack = Some(Jetpack {
                        fuel: *fuel,
                        active: false,
                    });
                    self.pickups.remove(i);
                }
            }
            PickupPayload::Weapon { item } => {
                if f.inventory.len() < 4 {
                    f.inventory.push(item.clone());
                    f.equipped = f.inventory.len() - 1;
                    f.reload_until = None;
                    self.pickups.remove(i);
                }
            }
        }
    }

    /// `Inventory.drop`: an active jetpack first, else the equipped weapon in front of you.
    fn drop(&mut self, id: u32, at: [f32; 3], time: f64) {
        let f = self.fighters.get_mut(&id).unwrap();
        if f.jetpack.as_ref().is_some_and(|j| j.active) {
            let fuel = f.jetpack.take().unwrap().fuel;
            self.spawn_pickup(at, PickupPayload::Jetpack { fuel }, time + PICKUP_SECONDS);
            return;
        }
        if f.inventory[f.equipped].kind == "fists" {
            return;
        }
        let item = f.inventory.remove(f.equipped);
        f.equipped = 0;
        f.reload_until = None;
        let (dx, dz) = f.aim.sin_cos();
        let at = [at[0] + dx * 0.8, at[1], at[2] + dz * 0.8];
        self.spawn_pickup(at, PickupPayload::Weapon { item }, time + PICKUP_SECONDS);
    }

    // ── Simulation ────────────────────────────────────────────────────────

    /// Runs after `Game::apply_input` and before `World::step`; `time` is in seconds.
    pub(crate) fn step(
        &mut self,
        world: &mut World,
        players: &mut HashMap<u32, Player>,
        cars: &mut Cars,
        spawn: [f32; 3],
        time: f64,
    ) {
        let (positions, vertical) = poses(world);
        let mut ids: Vec<u32> = players.keys().copied().collect();
        ids.sort_unstable();
        for &id in &ids {
            let character = players[&id].character.clone();
            let f = self.fighter(id, character.as_ref());
            f.cooldown = (f.cooldown - DT as f64).max(0.0);
            if f.reload_until.is_some_and(|t| time >= t) {
                let item = &mut f.inventory[f.equipped];
                let needed = spec(&item.kind)
                    .magazine
                    .saturating_sub(item.ammo)
                    .min(item.reserve);
                item.ammo += needed;
                item.reserve -= needed;
                f.reload_until = None;
            }
            let body = players[&id].body;
            if f.down > 0.0 {
                f.down = (f.down - DT).max(0.0);
                f.controls = Controls::default();
                if let Ok(b) = body {
                    world.set_move(b, Move::default());
                }
                if f.down == 0.0 && f.health <= 0.0 {
                    self.respawn(id, world, players, spawn);
                }
                continue;
            }
            let c = std::mem::take(&mut f.controls);
            // Seated: no weapons, pickups or jetpack until you climb out.
            let Some(&at) = body.ok().and_then(|b| positions.get(&b)) else {
                continue;
            };
            if let Some(slot) = c.equip
                && (slot as usize) < f.inventory.len()
            {
                f.equipped = slot as usize;
                f.reload_until = None;
            }
            if c.jetpack
                && let Some(j) = &mut f.jetpack
            {
                j.active = !j.active;
            }
            if let Some(j) = &mut f.jetpack
                && j.active
                && j.fuel > 0.0
                && (c.ascend || c.descend)
            {
                // shared/physics/jetpack.ts jetpackThrust
                let powered = DT.min(j.fuel / JETPACK_DRAIN);
                j.fuel = (j.fuel - powered * JETPACK_DRAIN).max(0.0);
                let target = if c.ascend { JETPACK_SPEED } else { -4.0 };
                let b = body.unwrap();
                let vy = vertical[&b];
                world.set_vertical(b, vy + (target - vy) * (1.0 - (-4.0 * powered).exp()));
            }
            if c.reload {
                self.reload(id, time);
            }
            if c.drop {
                self.drop(id, at, time);
            }
            if c.interact {
                self.pickup(id, at);
            }
            if c.attack {
                self.attack(id, at, world, players, cars, &positions, time);
            }
        }
        self.step_grenades(world, players, cars, &positions, time);
        for h in self.hulls.values_mut() {
            h.wreck = (h.wreck - DT).max(0.0);
        }
        self.cleanup(time);
    }

    fn reload(&mut self, id: u32, time: f64) {
        let f = self.fighters.get_mut(&id).unwrap();
        let item = &f.inventory[f.equipped];
        let s = spec(&item.kind);
        if f.reload_until.is_none()
            && s.mode != Mode::Throw
            && item.ammo < s.magazine
            && item.reserve > 0
        {
            f.reload_until = Some(time + s.reload);
        }
    }

    /// `Combat.attack`, minus lag compensation and destructible props.
    #[allow(clippy::too_many_arguments)]
    fn attack(
        &mut self,
        id: u32,
        at: [f32; 3],
        world: &mut World,
        players: &mut HashMap<u32, Player>,
        cars: &mut Cars,
        positions: &HashMap<u32, [f32; 3]>,
        time: f64,
    ) {
        let f = self.fighters.get_mut(&id).unwrap();
        if f.cooldown > 0.0 || f.reload_until.is_some() {
            return;
        }
        let kind = f.inventory[f.equipped].kind.clone();
        let s = spec(&kind);
        let aim = f.aim;
        // Entity `y` is the capsule centre (0.9 m over the feet), so Node's `y + 1` becomes
        // chest height for rays and effects alike.
        let muzzle = [at[0], at[1] + CHEST, at[2]];
        let (dx, dz) = aim.sin_cos();
        if s.mode != Mode::Melee {
            if f.inventory[f.equipped].ammo == 0 {
                self.reload(id, time);
                let f = self.fighters.get_mut(&id).unwrap();
                if f.reload_until.is_none() {
                    f.cooldown = s.cooldown;
                    self.event("dryFire", muzzle, |e| e.sound = Some("dryFire".into()));
                }
                return;
            }
            if s.mode == Mode::Throw {
                if self.grenades.len() >= MAX_GRENADES {
                    return;
                }
                self.serial += 1;
                self.grenades.push(GrenadeState {
                    id: format!("grenade:{}", self.serial),
                    owner: id.to_string(),
                    x: at[0],
                    y: at[1] + CHEST,
                    z: at[2],
                    vx: dx * 15.0,
                    vy: 7.0,
                    vz: dz * 15.0,
                    radius: 0.16,
                    detonate_at: time + FUSE_SECONDS,
                });
            }
            f.inventory[f.equipped].ammo -= 1;
        }
        f.cooldown = s.cooldown;
        if s.mode == Mode::Throw {
            self.event("throw", muzzle, |e| e.angle = Some(aim));
            return;
        }
        let me = players[&id].body.unwrap();
        let targets = targets(id, players, cars, positions);
        if s.mode == Mode::Flame {
            self.event("flame", muzzle, |e| {
                e.angle = Some(aim);
                e.length = Some(s.range);
            });
            for (t, pos) in targets {
                let (tx, tz) = (pos[0] - at[0], pos[2] - at[2]);
                let d = tx.hypot(tz);
                if d == 0.0
                    || d >= s.range
                    || (pos[1] - at[1]).abs() > 2.0
                    || (tx * dx + tz * dz) / d < 0.85
                {
                    continue;
                }
                // Only an unobstructed line of sight burns.
                let clear = world
                    .cast_ray(muzzle, [tx / d, 0.0, tz / d], d, me)
                    .is_none_or(|(hit, _)| Some(hit) == body_of(t, players));
                if clear {
                    self.damage(t, s.damage, world, players, cars, positions);
                }
            }
            return;
        }
        let ranged = s.mode == Mode::Hitscan;
        let (hit, length) = if ranged {
            match world.cast_ray(muzzle, [dx, 0.0, dz], s.range, me) {
                Some((0, t)) => (None, t),
                Some((body, t)) => (
                    targets
                        .iter()
                        .find(|(tg, _)| body_of(*tg, players) == Some(body))
                        .map(|(tg, _)| (*tg, t)),
                    t,
                ),
                None => (None, s.range),
            }
        } else {
            let best = targets
                .iter()
                .filter_map(|(t, pos)| {
                    let (tx, tz) = (pos[0] - at[0], pos[2] - at[2]);
                    let d = tx.hypot(tz);
                    // Wide cone up close so a target brushing your shoulder still counts.
                    let cone = if d < 1.3 { 0.2 } else { 0.7 };
                    (d > 0.0 && (pos[1] - at[1]).abs() <= 2.0 && (tx * dx + tz * dz) / d > cone)
                        .then_some((*t, (d - 0.35).max(0.0)))
                })
                .filter(|(_, d)| *d < s.range)
                .min_by(|a, b| a.1.total_cmp(&b.1));
            (best, 0.0)
        };
        let sound = match (ranged, kind.as_str()) {
            (true, "smg" | "machinegun") => "smg",
            (true, _) => "pistol",
            _ => "swing",
        };
        self.event(if ranged { "shot" } else { "swing" }, muzzle, |e| {
            e.source = Some(id.to_string());
            e.sound = Some(sound.into());
            e.angle = Some(aim);
            e.length = Some(length);
        });
        let Some((t, d)) = hit else {
            return;
        };
        self.damage(t, s.damage, world, players, cars, positions);
        if kind == "bat"
            && let Target::Player(p) = t
        {
            // Bat blows knock people off their feet; they stand up once `down` expires.
            let f = self.fighters.get_mut(&p).unwrap();
            f.down = f.down.max(1.0);
        }
        let sound = match (t, s.magazine > 0, kind.as_str()) {
            (Target::Car(_), _, _) => "impact",
            (_, true, _) => "impactBody",
            (_, _, "bat") => "bat",
            _ => "punch",
        };
        let target = match t {
            Target::Player(p) => p.to_string(),
            Target::Car(c) => cars[&c].0.to_string(),
        };
        self.event(
            "hit",
            [at[0] + dx * d, at[1] + CHEST, at[2] + dz * d],
            |e| {
                e.target = Some(target);
                e.angle = Some(aim);
                e.sound = Some(sound.into());
            },
        );
    }

    /// `Simulation.damage`: zero health knocks a player down or wrecks a car.
    fn damage(
        &mut self,
        t: Target,
        amount: f32,
        world: &mut World,
        players: &mut HashMap<u32, Player>,
        cars: &mut Cars,
        positions: &HashMap<u32, [f32; 3]>,
    ) {
        match t {
            Target::Player(p) => {
                let Some(f) = self.fighters.get_mut(&p) else {
                    return;
                };
                if f.health <= 0.0 {
                    return;
                }
                f.health = (f.health - amount).max(0.0);
                if f.health > 0.0 {
                    return;
                }
                if let Some(j) = &mut f.jetpack {
                    j.active = false;
                }
                f.down = DOWN_SECONDS;
                if let Err(car) = players[&p].body {
                    eject(p, car, world, players, cars, positions);
                }
            }
            Target::Car(c) => {
                let h = self.hulls.entry(c).or_insert(Hull {
                    health: 100.0,
                    wreck: 0.0,
                });
                if h.wreck > 0.0 {
                    return;
                }
                h.health = (h.health - amount).max(0.0);
                if h.health > 0.0 {
                    return;
                }
                h.wreck = WRECK_SECONDS;
                let seated: Vec<u32> = players
                    .iter()
                    .filter(|(_, p)| p.body == Err(c))
                    .map(|(id, _)| *id)
                    .collect();
                for p in seated {
                    eject(p, c, world, players, cars, positions);
                }
            }
        }
    }

    /// `Simulation.respawn`: back at the city spawn, full health, fists only.
    fn respawn(
        &mut self,
        id: u32,
        world: &mut World,
        players: &mut HashMap<u32, Player>,
        spawn: [f32; 3],
    ) {
        let fists = self.item("fists");
        let f = self.fighters.get_mut(&id).unwrap();
        f.health = f.max_health;
        f.down = 0.0;
        f.inventory = vec![fists];
        f.equipped = 0;
        f.reload_until = None;
        f.jetpack = None;
        if let Ok(b) = players[&id].body {
            world.teleport_character(b, spawn);
        }
    }

    /// `Grenades.step` with the ground found by a downward ray, then `Simulation.blast`.
    fn step_grenades(
        &mut self,
        world: &mut World,
        players: &mut HashMap<u32, Player>,
        cars: &mut Cars,
        positions: &HashMap<u32, [f32; 3]>,
        time: f64,
    ) {
        let mut blasts = Vec::new();
        self.grenades.retain_mut(|g| {
            if time >= g.detonate_at {
                blasts.push([g.x, g.y, g.z]);
                return false;
            }
            let previous = g.y;
            g.vy -= GRENADE_GRAVITY * DT;
            g.x += g.vx * DT;
            g.y += g.vy * DT;
            g.z += g.vz * DT;
            if g.vy < 0.0
                && let Some((_, t)) = world.cast_ray(
                    [g.x, previous, g.z],
                    [0.0, -1.0, 0.0],
                    previous - g.y + g.radius,
                    0,
                )
            {
                g.y = previous - t + g.radius;
                g.vy = if g.vy.abs() > 0.5 {
                    g.vy.abs() * 0.4
                } else {
                    0.0
                };
                let friction = (-4.0 * DT).exp();
                g.vx *= friction;
                g.vz *= friction;
            }
            true
        });
        let s = spec("grenade");
        for b in blasts {
            self.event("explosion", [b[0], b[1] + 1.0, b[2]], |_| {});
            let ids: Vec<u32> = players.keys().copied().collect();
            for id in ids {
                let body = players[&id].body;
                let Some(pos) = positions.get(&body.unwrap_or_else(|c| c)) else {
                    continue;
                };
                let d =
                    ((pos[0] - b[0]).powi(2) + (pos[1] - b[1]).powi(2) + (pos[2] - b[2]).powi(2))
                        .sqrt();
                if d >= s.range {
                    continue;
                }
                let falloff = 1.0 - d / s.range;
                self.damage(
                    Target::Player(id),
                    falloff * s.damage,
                    world,
                    players,
                    cars,
                    positions,
                );
                if body.is_ok() {
                    let f = self.fighters.get_mut(&id).unwrap();
                    f.down = f.down.max(1.5);
                }
            }
            let car_ids: Vec<u32> = cars.keys().copied().collect();
            for c in car_ids {
                let Some(pos) = positions.get(&c) else {
                    continue;
                };
                let d =
                    ((pos[0] - b[0]).powi(2) + (pos[1] - b[1]).powi(2) + (pos[2] - b[2]).powi(2))
                        .sqrt();
                if d < s.range {
                    self.damage(
                        Target::Car(c),
                        (1.0 - d / s.range) * s.damage,
                        world,
                        players,
                        cars,
                        positions,
                    );
                }
            }
        }
    }

    // ── Output ────────────────────────────────────────────────────────────

    /// Fills the gameplay fields of a player entity.
    pub fn player_fields(&self, id: u32, e: &mut Entity) {
        let Some(f) = self.fighters.get(&id) else {
            return;
        };
        e.health = f.health;
        e.max_health = Some(f.max_health);
        e.weapon = Some(f.inventory[f.equipped].kind.clone());
        e.inventory = Some(f.inventory.clone());
        e.equipped = Some(f.equipped as u8);
        e.reload_until = f.reload_until;
        e.cooldown = Some(f.cooldown);
        e.aim = Some(f.aim);
        e.down = (f.down > 0.0).then_some(f.down);
        e.jetpack = f.jetpack.clone();
    }

    /// Fills health and wreck state of a car entity, by vehicle physics id.
    pub fn car_fields(&self, car: u32, e: &mut Entity) {
        e.max_health = Some(100.0);
        if let Some(h) = self.hulls.get(&car) {
            e.health = h.health;
            e.wreck = (h.wreck > 0.0).then_some(h.wreck);
        }
    }

    pub fn take_events(&mut self) -> Vec<WorldEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn pickups_near(&self, x: f32, z: f32) -> Vec<Pickup> {
        self.pickups
            .iter()
            .filter(|p| (p.x - x).hypot(p.z - z) < INTEREST_RADIUS)
            .cloned()
            .collect()
    }

    pub fn grenades_near(&self, x: f32, z: f32) -> Vec<GrenadeState> {
        self.grenades
            .iter()
            .filter(|g| (g.x - x).hypot(g.z - z) < INTEREST_RADIUS)
            .cloned()
            .collect()
    }
}

/// Puts a seated player back on foot beside `car` and frees the driver's seat.
fn eject(
    id: u32,
    car: u32,
    world: &mut World,
    players: &mut HashMap<u32, Player>,
    cars: &mut Cars,
    positions: &HashMap<u32, [f32; 3]>,
) {
    let at = positions
        .get(&car)
        .map_or([0.0, 1.0, 0.0], |p| [p[0] + 2.0, p[1], p[2]]);
    world.set_drive(car, Drive::default());
    if let Some(c) = cars.get_mut(&car) {
        c.1 = None;
    }
    players.get_mut(&id).unwrap().body = Ok(world.spawn_character(at));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physique_sets_health() {
        assert_eq!(physique_health(None), 100.0);
        assert_eq!(
            physique_health(Some(&serde_json::json!({"physique": "runner"}))),
            80.0
        );
        assert_eq!(
            physique_health(Some(&serde_json::json!({"physique": "tank"}))),
            150.0
        );
        assert_eq!(
            physique_health(Some(&serde_json::json!({"physique": "x"}))),
            100.0
        );
    }

    #[test]
    fn ammo_pickup_merges_and_weapons_fill_free_slots() {
        let mut c = Combat::default();
        let mut pistol = c.item("pistol");
        pistol.reserve = 10;
        c.fighter(1, None).inventory.push(pistol);
        c.spawn_pickup(
            [3.0, 0.0, 0.0],
            PickupPayload::Ammo {
                ammo_kind: "handgun".into(),
                amount: 60,
            },
            f64::MAX,
        );
        c.pickup(1, [3.0, 0.0, 0.0]);
        assert_eq!(c.fighters[&1].inventory[1].reserve, 48);
        assert_eq!(
            c.pickups.len(),
            1,
            "the leftover 22 rounds stay on the ground"
        );
        for k in ["smg", "knife", "bat"] {
            let item = c.item(k);
            c.spawn_pickup([0.0, 0.0, 0.0], PickupPayload::Weapon { item }, f64::MAX);
            c.pickup(1, [0.0, 0.0, 0.0]);
        }
        assert_eq!(
            c.fighters[&1].inventory.len(),
            4,
            "four slots, the bat stays down"
        );
        assert_eq!(c.fighters[&1].equipped, 3);
    }

    #[test]
    fn supplies_ring_every_pad_and_sources_restock() {
        let mut c = Combat::default();
        c.supplies(&[(0.0, 0.0, "pistol".into())], |_, _| 0.5);
        assert_eq!(c.pickups.len(), 1 + 8, "pad weapon plus eight ring slots");
        assert!(
            c.pickups
                .iter()
                .all(|p| p.y == 0.5 && p.expires == f64::MAX)
        );
        c.pickups.clear();
        c.cleanup(10.0);
        assert!(c.pickups.is_empty());
        c.cleanup(31.0);
        assert_eq!(c.pickups.len(), 9);
    }
}
