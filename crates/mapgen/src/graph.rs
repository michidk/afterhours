//! Literal port of `mapgen/graph.ts`. Adjacency vectors preserve JavaScript Set
//! insertion order, including deletion followed by reinsertion.
use crate::{
    geom::{
        self, Point, area, closest_on_segment, cross, dist, polyline_length, segment_intersection,
        signed_area, sub,
    },
    types::{River, RoadEdge, RoadGraph, RoadKind, RoadNode},
};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    f64::consts::PI,
};

pub const ROAD_WIDTH: [(RoadKind, f64); 4] = [
    (RoadKind::Highway, 24.0),
    (RoadKind::Avenue, 18.0),
    (RoadKind::Street, 12.0),
    (RoadKind::Lane, 7.0),
];
pub fn road_width(kind: RoadKind) -> f64 {
    match kind {
        RoadKind::Highway => 24.0,
        RoadKind::Avenue => 18.0,
        RoadKind::Street => 12.0,
        RoadKind::Lane => 7.0,
    }
}
pub fn road_rank(kind: RoadKind) -> i32 {
    match kind {
        RoadKind::Highway => 3,
        RoadKind::Avenue => 2,
        RoadKind::Street => 1,
        RoadKind::Lane => 0,
    }
}
fn cmp(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}
fn or_one(v: f64) -> f64 {
    if v == 0.0 { 1.0 } else { v }
}
fn perimeter(ring: &[Point]) -> f64 {
    ring.iter()
        .enumerate()
        .fold(0.0, |s, (i, &p)| s + dist(p, ring[(i + 1) % ring.len()]))
}
/// Sidewalk width plus a one-metre verge beyond a road's kerb.
const KERB_CLEARANCE: f64 = 3.5;

#[derive(Clone, Debug)]
pub struct GNode {
    pub id: usize,
    pub point: Point,
    pub edges: Vec<usize>,
    pub alive: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct GEdge {
    pub id: usize,
    pub a: usize,
    pub b: usize,
    pub kind: RoadKind,
    pub bridge: bool,
    pub alive: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct SnapOptions {
    pub snap: f64,
    pub min_angle: f64,
}
impl Default for SnapOptions {
    fn default() -> Self {
        Self {
            snap: 14.0,
            min_angle: (34.0 * PI) / 180.0,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct InsertResult {
    pub node: usize,
    pub severed: bool,
}
#[derive(Debug, Default)]
struct CleanupStats {
    merged: usize,
    angle: usize,
    slivers: usize,
    joined: usize,
    ends: usize,
    stubs: usize,
}
impl CleanupStats {
    fn total(&self) -> usize {
        self.merged + self.angle + self.slivers + self.joined + self.ends + self.stubs
    }
}
pub type CanBuild<'a> = &'a dyn Fn(Point, Point) -> bool;
pub struct CleanupOptions<'a> {
    pub min_edge: f64,
    pub min_stub: f64,
    pub join: Option<(f64, CanBuild<'a>)>,
    pub debug: bool,
}
#[derive(Debug)]
pub struct CompactGraph {
    pub graph: RoadGraph,
    pub node_map: Vec<isize>,
    pub segments: Vec<Vec<usize>>,
}

/// Mutable planar graph of straight segments with Citygen/Parish–Müller local
/// constraints. A crossing or snap cuts the inserted segment and severs growth.
#[derive(Debug)]
pub struct GraphBuilder {
    pub nodes: Vec<GNode>,
    pub edges: Vec<GEdge>,
    cell: f64,
    node_cells: HashMap<(i64, i64), Vec<usize>>,
    edge_cells: HashMap<(i64, i64), Vec<usize>>,
}
impl Default for GraphBuilder {
    fn default() -> Self {
        Self::new()
    }
}
impl GraphBuilder {
    pub fn new() -> Self {
        Self {
            nodes: vec![],
            edges: vec![],
            cell: 48.0,
            node_cells: HashMap::new(),
            edge_cells: HashMap::new(),
        }
    }
    fn key(&self, x: f64, z: f64) -> (i64, i64) {
        (
            (x / self.cell).floor() as i64,
            (z / self.cell).floor() as i64,
        )
    }
    pub fn add_node(&mut self, x: f64, z: f64) -> usize {
        let id = self.nodes.len();
        self.nodes.push(GNode {
            id,
            point: Point { x, z },
            edges: vec![],
            alive: true,
        });
        let key = self.key(x, z);
        self.node_cells.entry(key).or_default().push(id);
        id
    }
    fn index_edge(&mut self, e: GEdge) {
        let a = self.nodes[e.a].point;
        let b = self.nodes[e.b].point;
        let x0 = (a.x.min(b.x) / self.cell).floor() as i64;
        let x1 = (a.x.max(b.x) / self.cell).floor() as i64;
        let z0 = (a.z.min(b.z) / self.cell).floor() as i64;
        let z1 = (a.z.max(b.z) / self.cell).floor() as i64;
        for x in x0..=x1 {
            for z in z0..=z1 {
                self.edge_cells.entry((x, z)).or_default().push(e.id);
            }
        }
    }
    pub fn add_edge(&mut self, a: usize, b: usize, kind: RoadKind, bridge: bool) -> Option<usize> {
        if a == b {
            return None;
        }
        for &id in &self.nodes[a].edges {
            let e = &mut self.edges[id];
            if e.alive && (e.a == b || e.b == b) {
                if road_rank(kind) > road_rank(e.kind) {
                    e.kind = kind;
                }
                return Some(id);
            }
        }
        let edge = GEdge {
            id: self.edges.len(),
            a,
            b,
            kind,
            bridge,
            alive: true,
        };
        self.edges.push(edge);
        self.nodes[a].edges.push(edge.id);
        self.nodes[b].edges.push(edge.id);
        self.index_edge(edge);
        Some(edge.id)
    }
    pub fn remove_edge(&mut self, id: usize) {
        let e = &mut self.edges[id];
        if !e.alive {
            return;
        }
        e.alive = false;
        self.nodes[e.a].edges.retain(|&x| x != id);
        self.nodes[e.b].edges.retain(|&x| x != id);
    }
    pub fn remove_node(&mut self, id: usize) {
        for e in self.nodes[id].edges.clone() {
            self.remove_edge(e);
        }
        self.nodes[id].alive = false;
    }
    pub fn other(&self, e: GEdge, node: usize) -> usize {
        if e.a == node { e.b } else { e.a }
    }
    pub fn degree(&self, id: usize) -> usize {
        self.nodes[id].edges.len()
    }
    pub fn nodes_near(&self, x: f64, z: f64, radius: f64) -> Vec<usize> {
        let mut out = vec![];
        let r = (radius / self.cell).ceil() as i64;
        let (cx, cz) = self.key(x, z);
        for i in -r..=r {
            for j in -r..=r {
                if let Some(list) = self.node_cells.get(&(cx + i, cz + j)) {
                    for &id in list {
                        let n = &self.nodes[id];
                        if n.alive && geom::hypot(n.point.x - x, n.point.z - z) <= radius {
                            out.push(id);
                        }
                    }
                }
            }
        }
        out
    }
    pub fn edges_near(&self, x0: f64, z0: f64, x1: f64, z1: f64, pad: f64) -> Vec<usize> {
        let mut out = HashSet::new();
        let cx0 = ((x0.min(x1) - pad) / self.cell).floor() as i64;
        let cx1 = ((x0.max(x1) + pad) / self.cell).floor() as i64;
        let cz0 = ((z0.min(z1) - pad) / self.cell).floor() as i64;
        let cz1 = ((z0.max(z1) + pad) / self.cell).floor() as i64;
        for x in cx0..=cx1 {
            for z in cz0..=cz1 {
                if let Some(list) = self.edge_cells.get(&(x, z)) {
                    for &id in list {
                        if self.edges[id].alive {
                            out.insert(id);
                        }
                    }
                }
            }
        }
        let mut out: Vec<_> = out.into_iter().collect();
        out.sort_unstable();
        out
    }
    pub fn split_edge(&mut self, id: usize, p: Point) -> usize {
        let e = self.edges[id];
        if dist(self.nodes[e.a].point, p) < 0.5 {
            return e.a;
        }
        if dist(self.nodes[e.b].point, p) < 0.5 {
            return e.b;
        }
        let mid = self.add_node(p.x, p.z);
        self.remove_edge(id);
        self.add_edge(e.a, mid, e.kind, e.bridge);
        self.add_edge(mid, e.b, e.kind, e.bridge);
        mid
    }
    /// Angle between two segments as lines (0..π/2).
    fn line_angle(&self, a: Point, b: Point, c: Point, d: Point) -> f64 {
        let u = sub(b, a);
        let v = sub(d, c);
        let cos = (u.x * v.x + u.z * v.z).abs()
            / (or_one(geom::hypot(u.x, u.z)) * or_one(geom::hypot(v.x, v.z)));
        cos.min(1.0).acos()
    }
    /// Insert from an existing node, preserving all mutations on rejection just
    /// as the TypeScript builder does.
    pub fn insert(
        &mut self,
        from: usize,
        to: Point,
        kind: RoadKind,
        options: SnapOptions,
        bridge: bool,
    ) -> Option<InsertResult> {
        let SnapOptions { snap, min_angle } = options;
        let start = self.nodes[from].point;
        let mut end = to;
        if dist(start, end) < 2.0 {
            return None;
        }
        let mut severed = false;
        let mut end_node = None;
        let candidates = self.edges_near(start.x, start.z, end.x, end.z, snap);
        // Priority 1: a true crossing closest to the start wins and cuts the segment.
        let mut best_t = f64::INFINITY;
        let mut crossing = None;
        for &id in &candidates {
            let e = self.edges[id];
            if e.a == from || e.b == from {
                continue;
            }
            if bridge != e.bridge {
                continue;
            }
            let a = self.nodes[e.a].point;
            let b = self.nodes[e.b].point;
            if let Some((t, u)) = segment_intersection(start, end, a, b)
                && t < best_t
            {
                if self.line_angle(start, end, a, b) < min_angle {
                    return None;
                }
                best_t = t;
                crossing = Some((
                    id,
                    Point {
                        x: a.x + (b.x - a.x) * u,
                        z: a.z + (b.z - a.z) * u,
                    },
                ));
            }
        }
        if let Some((edge, point)) = crossing {
            end = point;
            end_node = Some(self.split_edge(edge, end));
            severed = true;
        }
        if end_node.is_none() {
            // Priority 2: snap to a nearby node.
            let mut nearest = None;
            let mut nearest_distance = snap;
            for id in self.nodes_near(end.x, end.z, snap) {
                if id == from {
                    continue;
                }
                let d = dist(self.nodes[id].point, end);
                if d < nearest_distance {
                    nearest_distance = d;
                    nearest = Some(id);
                }
            }
            if let Some(id) = nearest {
                end_node = Some(id);
                end = self.nodes[id].point;
                severed = true;
            }
        }
        if end_node.is_none() {
            // Priority 3: snap onto an edge body, splitting it, if the angle is usable.
            let mut best: Option<(usize, Point, f64)> = None;
            for &id in &candidates {
                let e = self.edges[id];
                if e.a == from || e.b == from {
                    continue;
                }
                let a = self.nodes[e.a].point;
                let b = self.nodes[e.b].point;
                let (point, _) = closest_on_segment(end, a, b);
                let d = dist(point, end);
                if d <= snap && best.is_none_or(|(_, _, v)| d < v) {
                    best = Some((id, point, d));
                }
            }
            if let Some((id, point, _)) = best {
                let e = self.edges[id];
                let a = self.nodes[e.a].point;
                let b = self.nodes[e.b].point;
                if self.line_angle(start, point, a, b) < min_angle {
                    return None;
                }
                end = point;
                end_node = Some(self.split_edge(id, end));
                severed = true;
            }
        }
        let end_node = end_node.unwrap_or_else(|| self.add_node(end.x, end.z));
        if end_node == from || dist(self.nodes[end_node].point, start) < 4.0 {
            return None;
        }
        // Reject if the new segment would still cross something after snapping.
        for id in self.edges_near(start.x, start.z, end.x, end.z, 0.0) {
            let e = self.edges[id];
            if e.a == from || e.b == from || e.a == end_node || e.b == end_node {
                continue;
            }
            if bridge != e.bridge {
                continue;
            }
            if segment_intersection(start, end, self.nodes[e.a].point, self.nodes[e.b].point)
                .is_some()
            {
                return None;
            }
        }
        // Reject shallow angles against the edges already at either node.
        for node in [from, end_node] {
            for &id in &self.nodes[node].edges {
                let e = self.edges[id];
                let o = self.nodes[self.other(e, node)].point;
                let here = self.nodes[node].point;
                let far = if node == from {
                    self.nodes[end_node].point
                } else {
                    start
                };
                let u = sub(o, here);
                let v = sub(far, here);
                let angle = ((u.x * v.x + u.z * v.z)
                    / (or_one(geom::hypot(u.x, u.z)) * or_one(geom::hypot(v.x, v.z))))
                .clamp(-1.0, 1.0)
                .acos();
                if angle < min_angle {
                    return None;
                }
            }
        }
        if self.degree(from) >= 4 || self.degree(end_node) >= 4 {
            return None;
        }
        self.add_edge(from, end_node, kind, bridge);
        Some(InsertResult {
            node: end_node,
            severed,
        })
    }
    pub fn length(&self, e: GEdge) -> f64 {
        dist(self.nodes[e.a].point, self.nodes[e.b].point)
    }

    /// Collapse tiny edges, drop shallow arms and slivers, join and settle dead
    /// ends, prune stubs, then retain the largest component. Steps repeat because
    /// each can expose work for another.
    pub fn cleanup(&mut self, options: CleanupOptions<'_>) {
        let mut stats = CleanupStats::default();
        for _ in 0..6 {
            let before = stats.total();
            self.merge_close(options.min_edge, &mut stats);
            self.drop_shallow_arms(&mut stats);
            self.drop_slivers(&mut stats);
            if let Some((reach, can_build)) = options.join {
                stats.joined += self.join_dead_ends(reach, can_build);
            }
            self.settle_dead_ends(&mut stats, true);
            self.prune_stubs(options.min_stub, &mut stats);
            if stats.total() == before {
                break;
            }
        }
        // Joined dead ends can close new slivers; settle without joining so this ends.
        for _ in 0..6 {
            let before = stats.total();
            self.merge_close(options.min_edge, &mut stats);
            self.drop_slivers(&mut stats);
            self.settle_dead_ends(&mut stats, false);
            self.prune_stubs(options.min_stub, &mut stats);
            if stats.total() == before {
                break;
            }
        }
        for n in &mut self.nodes {
            if n.alive && n.edges.is_empty() {
                n.alive = false;
            }
        }
        if options.debug {
            eprintln!("cleanup {stats:?}");
        }
        // Keep the largest connected component.
        let mut component = vec![-1isize; self.nodes.len()];
        let mut sizes = vec![];
        for n in &self.nodes {
            if !n.alive || component[n.id] >= 0 {
                continue;
            }
            let id = sizes.len();
            let mut stack = vec![n.id];
            component[n.id] = id as isize;
            sizes.push(0);
            while let Some(c) = stack.pop() {
                sizes[id] += 1;
                for &eid in &self.nodes[c].edges {
                    let o = self.other(self.edges[eid], c);
                    if component[o] < 0 {
                        component[o] = id as isize;
                        stack.push(o);
                    }
                }
            }
        }
        let mut main = 0;
        for i in 1..sizes.len() {
            if sizes[i] > sizes[main] {
                main = i;
            }
        }
        let remove: Vec<_> = self
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(id, n)| (n.alive && component[id] != main as isize).then_some(id))
            .collect();
        for id in remove {
            self.remove_node(id);
        }
    }
    /// Merge the two nodes of a removed connection into the better-connected one.
    fn merge_nodes(&mut self, p: usize, q: usize) {
        let (keep, drop) = if self.degree(p) >= self.degree(q) {
            (p, q)
        } else {
            (q, p)
        };
        for id in self.nodes[drop].edges.clone() {
            let other = self.edges[id];
            let far = self.other(other, drop);
            self.remove_edge(id);
            if far != keep {
                self.add_edge(keep, far, other.kind, other.bridge);
            }
        }
        self.nodes[drop].alive = false;
        // Lane generation needs at most four arms; shed the least important extras.
        while self.degree(keep) > 4 {
            let mut extra: Vec<_> = self.nodes[keep]
                .edges
                .iter()
                .copied()
                .filter(|&id| !self.edges[id].bridge)
                .collect();
            extra.sort_by(|&p, &q| {
                road_rank(self.edges[p].kind)
                    .cmp(&road_rank(self.edges[q].kind))
                    .then_with(|| cmp(self.length(self.edges[p]), self.length(self.edges[q])))
            });
            let Some(&id) = extra.first() else {
                break;
            };
            self.remove_edge(id);
        }
    }
    fn merge_close(&mut self, min_edge: f64, stats: &mut CleanupStats) {
        for _ in 0..4 {
            let mut changed = false;
            let mut id = 0;
            // JS array iteration also visits edges appended by merge_nodes.
            while id < self.edges.len() {
                let e = self.edges[id];
                id += 1;
                if !e.alive || e.bridge || self.length(e) >= min_edge {
                    continue;
                }
                self.remove_edge(e.id);
                self.merge_nodes(e.a, e.b);
                changed = true;
                stats.merged += 1;
            }
            // Close junctions need room for both mouths and a crossing, even
            // when their connection contains intermediate bends.
            let compact = self.to_road_graph_with_segments();
            let graph = &compact.graph;
            let mut builder = vec![0; graph.nodes.len()];
            let mut touched = HashSet::new();
            for (node, &id) in compact.node_map.iter().enumerate() {
                if id >= 0 {
                    builder[id as usize] = node;
                }
            }
            for e in &graph.edges {
                let a = builder[e.a];
                let b = builder[e.b];
                if e.bridge || a == b || touched.contains(&a) || touched.contains(&b) {
                    continue;
                }
                if self.degree(a) < 3 || self.degree(b) < 3 {
                    continue;
                }
                let mut widest: f64 = 0.0;
                for n in [a, b] {
                    for &id in &self.nodes[n].edges {
                        widest = widest.max(road_width(self.edges[id].kind));
                    }
                }
                if polyline_length(&e.points) >= widest * 1.5 {
                    continue;
                }
                for &id in &compact.segments[e.id] {
                    self.remove_edge(id);
                }
                for &id in &compact.segments[e.id] {
                    for n in [self.edges[id].a, self.edges[id].b] {
                        if n != a && n != b {
                            self.nodes[n].alive = false;
                        }
                    }
                }
                self.merge_nodes(a, b);
                touched.insert(a);
                touched.insert(b);
                changed = true;
                stats.merged += 1;
            }
            if !changed {
                break;
            }
        }
    }
    /// Shallow angles between arms make junctions unbuildable: drop the lesser arm.
    fn drop_shallow_arms(&mut self, stats: &mut CleanupStats) {
        for _ in 0..4 {
            let mut changed = false;
            for node in 0..self.nodes.len() {
                if !self.nodes[node].alive || self.degree(node) < 2 {
                    continue;
                }
                let n = self.nodes[node].point;
                let mut arms: Vec<_> = self.nodes[node]
                    .edges
                    .iter()
                    .map(|&id| {
                        let e = self.edges[id];
                        let o = self.nodes[self.other(e, node)].point;
                        (e, (o.z - n.z).atan2(o.x - n.x))
                    })
                    .collect();
                arms.sort_by(|p, q| cmp(p.1, q.1));
                let limit = ((if self.degree(node) == 2 { 50.0 } else { 45.0 }) * PI) / 180.0;
                for i in 0..arms.len() {
                    let a = arms[i];
                    let b = arms[(i + 1) % arms.len()];
                    if i == (i + 1) % arms.len() {
                        continue;
                    }
                    let mut gap = b.1 - a.1;
                    if gap <= 0.0 {
                        gap += PI * 2.0;
                    }
                    if gap >= limit {
                        continue;
                    }
                    let lesser = if road_rank(a.0.kind) != road_rank(b.0.kind) {
                        if road_rank(a.0.kind) < road_rank(b.0.kind) {
                            a
                        } else {
                            b
                        }
                    } else if self.length(a.0) < self.length(b.0) {
                        a
                    } else {
                        b
                    };
                    if lesser.0.bridge {
                        continue;
                    }
                    self.remove_edge(lesser.0.id);
                    stats.angle += 1;
                    changed = true;
                    break;
                }
            }
            if !changed {
                break;
            }
        }
    }
    /// Prune short dead-end chains.
    fn prune_stubs(&mut self, min_stub: f64, stats: &mut CleanupStats) {
        for _ in 0..6 {
            let mut changed = false;
            for node in 0..self.nodes.len() {
                if !self.nodes[node].alive || self.degree(node) != 1 {
                    continue;
                }
                let mut chain = vec![];
                let mut nodes = vec![node];
                let mut current = node;
                let mut length = 0.0;
                let mut guard = 0;
                loop {
                    let next = self.nodes[current]
                        .edges
                        .iter()
                        .copied()
                        .find(|id| !chain.contains(id));
                    let Some(next) = next else {
                        break;
                    };
                    if guard > 500 {
                        break;
                    }
                    guard += 1;
                    chain.push(next);
                    length += self.length(self.edges[next]);
                    current = self.other(self.edges[next], current);
                    nodes.push(current);
                    if self.degree(current) != 2 {
                        break;
                    }
                }
                if length < min_stub && !chain.is_empty() {
                    for &id in &chain {
                        self.remove_edge(id);
                    }
                    stats.stubs += chain.len();
                    for &id in &nodes[..nodes.len() - 1] {
                        self.nodes[id].alive = false;
                    }
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }
    /// Drop the least important boundary road of a block too small to hold a lot
    /// after road and sidewalk insets. Spurs walked twice are never candidates.
    fn drop_slivers(&mut self, stats: &mut CleanupStats) {
        let compact = self.to_road_graph_with_segments();
        let graph = &compact.graph;
        let mut removed = HashSet::new();
        for (ring, edges) in planar_faces(graph) {
            if area(&ring) > 8000.0 {
                continue;
            }
            if edges
                .iter()
                .any(|&id| compact.segments[id].iter().any(|s| removed.contains(s)))
            {
                continue;
            }
            let mut reach: f64 = 0.0;
            for &id in &edges {
                reach = reach.max(graph.edges[id].width / 2.0);
            }
            // A roomy awkward outline can fail inset validation; use the outline
            // estimate then (exact for convex blocks with rounded corners).
            let d = reach + KERB_CLEARANCE;
            let inset = inset_polygon(&ring, d);
            let net = if let Some(inset) = inset {
                area(&inset)
            } else {
                area(&ring) - perimeter(&ring) * d + PI * d * d
            };
            if net >= 300.0 {
                continue;
            }
            let mut victims: Vec<_> = edges
                .iter()
                .copied()
                .filter(|id| {
                    edges.iter().position(|v| v == id) == edges.iter().rposition(|v| v == id)
                })
                .map(|id| &graph.edges[id])
                .filter(|e| !e.bridge)
                .collect();
            victims.sort_by(|p, q| {
                road_rank(p.kind)
                    .cmp(&road_rank(q.kind))
                    .then_with(|| cmp(polyline_length(&q.points), polyline_length(&p.points)))
            });
            let Some(victim) = victims.first() else {
                continue;
            };
            for &id in &compact.segments[victim.id] {
                self.remove_edge(id);
                removed.insert(id);
            }
            stats.slivers += 1;
        }
        // A ring road leaving and re-entering one junction encloses its own block.
        for e in &graph.edges {
            if e.a != e.b || e.bridge {
                continue;
            }
            if compact.segments[e.id].iter().any(|id| removed.contains(id)) {
                continue;
            }
            let d = e.width / 2.0 + KERB_CLEARANCE;
            let net = area(&e.points) - polyline_length(&e.points) * d + PI * d * d;
            if net >= 300.0 {
                continue;
            }
            for &id in &compact.segments[e.id] {
                self.remove_edge(id);
                removed.insert(id);
            }
            stats.slivers += 1;
        }
        for n in &mut self.nodes {
            if n.alive && n.edges.is_empty() {
                n.alive = false;
            }
        }
    }
    /// Dead ends need a turning circle. Join an adjacent road when valid, or cut
    /// back a segment at a time until the dead end has enough clearance.
    fn settle_dead_ends(&mut self, stats: &mut CleanupStats, join: bool) {
        for _ in 0..40 {
            let mut changed = false;
            let mut node = 0;
            while node < self.nodes.len() {
                let id = node;
                node += 1;
                if !self.nodes[id].alive || self.degree(id) != 1 {
                    continue;
                }
                let e = self.edges[self.nodes[id].edges[0]];
                if e.bridge {
                    continue;
                }
                let n = self.nodes[id].point;
                let other = self.other(e, id);
                let o = self.nodes[other].point;
                let mut nearest = f64::INFINITY;
                for fid in self.edges_near(n.x, n.z, n.x, n.z, 40.0) {
                    let f = self.edges[fid];
                    if f.a == id || f.b == id || f.a == other || f.b == other {
                        continue;
                    }
                    let (point, _) =
                        closest_on_segment(n, self.nodes[f.a].point, self.nodes[f.b].point);
                    nearest = nearest.min(dist(n, point) - road_width(f.kind) / 2.0);
                }
                // Turning circle plus both sidewalks and a verge between them.
                if nearest >= road_width(e.kind) / 2.0 + 4.5 + 2.0 * KERB_CLEARANCE {
                    continue;
                }
                let dir = sub(n, o);
                let l = or_one(geom::hypot(dir.x, dir.z));
                let reach = nearest + road_width(RoadKind::Highway);
                let joined = if join {
                    self.insert(
                        id,
                        Point {
                            x: n.x + (dir.x / l) * reach,
                            z: n.z + (dir.z / l) * reach,
                        },
                        e.kind,
                        SnapOptions {
                            snap: 10.0,
                            ..Default::default()
                        },
                        false,
                    )
                } else {
                    None
                };
                changed = true;
                stats.ends += 1;
                if let Some(result) = joined {
                    if self.degree(result.node) >= 2 {
                        continue;
                    }
                    self.remove_node(result.node);
                }
                self.remove_edge(e.id);
                self.nodes[id].alive = false;
            }
            if !changed {
                break;
            }
        }
    }
    /// Look straight ahead first, then at nearest targets within 60 degrees.
    /// Only a buildable connector that lands on the network is retained.
    pub fn join_dead_ends(&mut self, reach: f64, can_build: CanBuild<'_>) -> usize {
        let mut joined = 0;
        let mut node = 0;
        while node < self.nodes.len() {
            let id = node;
            node += 1;
            if !self.nodes[id].alive || self.degree(id) != 1 {
                continue;
            }
            let e = self.edges[self.nodes[id].edges[0]];
            if e.bridge {
                continue;
            }
            let n = self.nodes[id].point;
            let other = self.other(e, id);
            let o = self.nodes[other].point;
            let dir = sub(n, o);
            let l = or_one(geom::hypot(dir.x, dir.z));
            let mut targets = vec![Point {
                x: n.x + (dir.x / l) * reach,
                z: n.z + (dir.z / l) * reach,
            }];
            let mut ahead = vec![];
            for fid in self.edges_near(n.x, n.z, n.x, n.z, reach) {
                let f = self.edges[fid];
                if f.a == id || f.b == id || f.a == other || f.b == other || f.bridge {
                    continue;
                }
                let (point, _) =
                    closest_on_segment(n, self.nodes[f.a].point, self.nodes[f.b].point);
                let d = dist(n, point);
                if d > 1.0
                    && d <= reach
                    && (point.x - n.x) * dir.x + (point.z - n.z) * dir.z > d * l * 0.5
                {
                    ahead.push((point, d));
                }
            }
            ahead.sort_by(|p, q| cmp(p.1, q.1));
            targets.extend(ahead.into_iter().map(|t| t.0));
            for target in targets {
                let result = self.insert(
                    id,
                    target,
                    e.kind,
                    SnapOptions {
                        snap: 8.0,
                        ..Default::default()
                    },
                    false,
                );
                let Some(result) = result else {
                    continue;
                };
                if result.node == other {
                    continue;
                }
                let end = result.node;
                if self.degree(end) >= 2 && can_build(n, self.nodes[end].point) {
                    joined += 1;
                    break;
                }
                for eid in self.nodes[id].edges.clone() {
                    if self.other(self.edges[eid], id) == end {
                        self.remove_edge(eid);
                    }
                }
                if self.degree(end) == 0 {
                    self.nodes[end].alive = false;
                }
            }
        }
        joined
    }
    /// Segments that pass over a river channel become bridges.
    pub fn bridge_rivers(&mut self, rivers: &[River]) {
        for id in 0..self.edges.len() {
            let e = self.edges[id];
            if !e.alive || e.bridge {
                continue;
            }
            let a = self.nodes[e.a].point;
            let b = self.nodes[e.b].point;
            self.edges[id].bridge = rivers.iter().any(|river| {
                river.points.iter().enumerate().any(|(i, &p)| {
                    if i == 0 {
                        return false;
                    }
                    let q = river.points[i - 1];
                    let reach = river.widths[i].max(river.widths[i - 1]) / 2.0 + 1.0;
                    segment_intersection(a, b, q, p).is_some()
                        || dist(closest_on_segment(p, a, b).0, p) < reach
                        || dist(closest_on_segment(a, q, p).0, a) < reach
                        || dist(closest_on_segment(b, q, p).0, b) < reach
                })
            });
        }
    }
    fn continuous(&self, node: usize) -> bool {
        let n = &self.nodes[node];
        if n.edges.len() != 2 {
            return false;
        }
        let p = self.edges[n.edges[0]];
        let q = self.edges[n.edges[1]];
        p.kind == q.kind && p.bridge == q.bridge
    }
    /// Merge degree-2 chains of equal kind into compact polyline edge ids.
    pub fn to_road_graph_with_segments(&self) -> CompactGraph {
        let mut chains = vec![];
        let mut used = vec![false; self.edges.len()];
        for &e in &self.edges {
            if !e.alive || used[e.id] {
                continue;
            }
            // Walk back to the chain start.
            let mut start_node = e.a;
            let mut start_edge = e;
            let mut seen = HashSet::from([e.id]);
            while self.continuous(start_node) {
                let prev = self.nodes[start_node]
                    .edges
                    .iter()
                    .map(|&id| self.edges[id])
                    .find(|x| x.id != start_edge.id)
                    .unwrap();
                if seen.contains(&prev.id) {
                    break;
                }
                seen.insert(prev.id);
                start_edge = prev;
                start_node = self.other(prev, start_node);
            }
            let mut nodes = vec![start_node];
            let mut segments = vec![];
            let mut current = start_node;
            let mut edge = start_edge;
            loop {
                used[edge.id] = true;
                segments.push(edge.id);
                current = self.other(edge, current);
                nodes.push(current);
                if !self.continuous(current) {
                    break;
                }
                let next = self.nodes[current]
                    .edges
                    .iter()
                    .map(|&id| self.edges[id])
                    .find(|x| x.id != edge.id)
                    .unwrap();
                if used[next.id] {
                    break;
                }
                edge = next;
            }
            chains.push((e.kind, e.bridge, nodes, segments));
        }
        let mut node_map = vec![-1; self.nodes.len()];
        let mut nodes = vec![];
        let mut edges = vec![];
        let mut segments = vec![];
        for (kind, bridge, chain, segs) in chains {
            let mut ends = [0; 2];
            for (i, id) in [chain[0], *chain.last().unwrap()].into_iter().enumerate() {
                if node_map[id] < 0 {
                    node_map[id] = nodes.len() as isize;
                    let p = self.nodes[id].point;
                    nodes.push(RoadNode {
                        id: nodes.len(),
                        x: p.x,
                        z: p.z,
                        y: 0.0,
                        edges: vec![],
                    });
                }
                ends[i] = node_map[id] as usize;
            }
            let [a, b] = ends;
            let id = edges.len();
            edges.push(RoadEdge {
                id,
                a,
                b,
                kind,
                width: road_width(kind),
                bridge,
                points: chain.iter().map(|&id| self.nodes[id].point).collect(),
                heights: vec![],
            });
            nodes[a].edges.push(id);
            nodes[b].edges.push(id);
            segments.push(segs);
        }
        CompactGraph {
            graph: RoadGraph { nodes, edges },
            node_map,
            segments,
        }
    }
    pub fn to_road_graph(&self) -> RoadGraph {
        self.to_road_graph_with_segments().graph
    }
}

/// Planar angular walk, dropping the outer face by area sign. `order` preserves
/// the insertion order of TypeScript's Map, which is not necessarily node-id order.
pub fn planar_faces(graph: &RoadGraph) -> Vec<(Vec<Point>, Vec<usize>)> {
    struct Half {
        edge: usize,
        from: usize,
        to: usize,
        points: Vec<Point>,
    }
    let mut outgoing: Vec<Vec<Half>> = (0..graph.nodes.len()).map(|_| vec![]).collect();
    let mut order = vec![];
    for e in &graph.edges {
        for h in [
            Half {
                edge: e.id,
                from: e.a,
                to: e.b,
                points: e.points.clone(),
            },
            Half {
                edge: e.id,
                from: e.b,
                to: e.a,
                points: e.points.iter().rev().copied().collect(),
            },
        ] {
            if outgoing[h.from].is_empty() {
                order.push(h.from);
            }
            outgoing[h.from].push(h);
        }
    }
    let angle = |h: &Half| {
        let p = h.points[0];
        let q = h.points[1];
        (q.z - p.z).atan2(q.x - p.x)
    };
    for &id in &order {
        outgoing[id].sort_by(|a, b| cmp(angle(a), angle(b)));
    }
    let mut used = HashSet::new();
    let mut faces = vec![];
    for &id in &order {
        for start in &outgoing[id] {
            if used.contains(&(start.edge, start.from)) {
                continue;
            }
            let mut ring = vec![];
            let mut edges = vec![];
            let mut h = start;
            let mut guard = 0;
            while !used.contains(&(h.edge, h.from)) && guard < 10000 {
                guard += 1;
                used.insert((h.edge, h.from));
                edges.push(h.edge);
                ring.extend_from_slice(&h.points[..h.points.len() - 1]);
                let arrivals = &outgoing[h.to];
                // Reverse the arrival direction, then take the next edge clockwise.
                let back = h.points[h.points.len() - 2];
                let tip = h.points[h.points.len() - 1];
                let incoming = (back.z - tip.z).atan2(back.x - tip.x);
                let mut next = &arrivals[0];
                let mut best_delta = f64::INFINITY;
                for cand in arrivals {
                    let mut delta = incoming - angle(cand);
                    while delta <= 1e-9 {
                        delta += PI * 2.0;
                    }
                    while delta > PI * 2.0 + 1e-9 {
                        delta -= PI * 2.0;
                    }
                    if cand.edge == h.edge && arrivals.len() > 1 {
                        delta += PI * 2.0;
                    }
                    if delta < best_delta {
                        best_delta = delta;
                        next = cand;
                    }
                }
                h = next;
            }
            if ring.len() >= 3 && signed_area(&ring) > 0.0 {
                faces.push((ring, edges));
            }
        }
    }
    faces
}
pub fn turns_left(a: Point, b: Point, c: Point) -> bool {
    cross(sub(b, a), sub(c, b)) > 0.0
}

// graph.ts calls this geometry helper when deciding whether a face is a sliver.
// Kept here until the shared geometry module exports the full inset operation.
fn inset_polygon(poly: &[Point], d: f64) -> Option<Vec<Point>> {
    use geom::{add, line_intersection, mul, norm, self_intersects};
    if poly.len() < 3 {
        return None;
    }
    let ccw = signed_area(poly) > 0.0;
    let mut ring = poly.to_vec();
    if !ccw {
        ring.reverse();
    }
    let mut out = vec![];
    for _ in 0..poly.len() {
        let n = ring.len();
        if n < 3 {
            return None;
        }
        out.clear();
        for i in 0..n {
            let prev = ring[(i + n - 1) % n];
            let cur = ring[i];
            let next = ring[(i + 1) % n];
            let d0 = norm(sub(cur, prev));
            let d1 = norm(sub(next, cur));
            let n0 = Point { x: -d0.z, z: d0.x };
            let n1 = Point { x: -d1.z, z: d1.x };
            let p0 = add(cur, mul(n0, d));
            let p1 = add(cur, mul(n1, d));
            if let Some(hit) = line_intersection(p0, d0, p1, d1) {
                let limit = d * 2.5;
                if dist(hit, cur) > limit {
                    out.push(add(cur, mul(norm(sub(hit, cur)), limit)));
                } else {
                    out.push(hit);
                }
            } else {
                out.push(p0);
            }
        }
        let mut reversed = None;
        for i in 0..n {
            let dir = sub(ring[(i + 1) % n], ring[i]);
            let a = out[i];
            let b = out[(i + 1) % n];
            if (b.x - a.x) * dir.x + (b.z - a.z) * dir.z <= 1e-6 {
                reversed = Some(i);
                break;
            }
        }
        let Some(i) = reversed else {
            break;
        };
        let j = (i + 1) % n;
        let before = dist(ring[(i + n - 1) % n], ring[i]);
        let after = dist(ring[j], ring[(j + 1) % n]);
        ring.remove(if before < after { i } else { j });
    }
    let mut cleaned = vec![];
    for &p in &out {
        if cleaned.last().is_none_or(|&last| dist(last, p) > 0.05) {
            cleaned.push(p);
        }
    }
    while cleaned.len() > 1 && dist(cleaned[0], *cleaned.last().unwrap()) <= 0.05 {
        cleaned.pop();
    }
    let mut i = 0;
    while i < cleaned.len() && cleaned.len() > 3 {
        let n = cleaned.len();
        let a = cleaned[(i + n - 1) % n];
        let b = cleaned[i];
        let c = cleaned[(i + 1) % n];
        let l = or_one(dist(a, c));
        if cross(sub(b, a), sub(c, a)).abs() / l < 0.05 {
            cleaned.remove(i);
        } else {
            i += 1;
        }
    }
    if cleaned.len() < 3 {
        return None;
    }
    if !ccw {
        cleaned.reverse();
    }
    if signed_area(&cleaned) * signed_area(poly) <= 0.0
        || area(&cleaned) >= area(poly)
        || self_intersects(&cleaned)
    {
        return None;
    }
    Some(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_chooses_nearest_before_splitting_either_candidate() {
        let mut g = GraphBuilder::new();
        let start = g.add_node(0.0, 0.0);
        let far_a = g.add_node(80.0, -50.0);
        let far_b = g.add_node(80.0, 50.0);
        let near_a = g.add_node(40.0, -50.0);
        let near_b = g.add_node(40.0, 50.0);
        let far = g.add_edge(far_a, far_b, RoadKind::Street, false).unwrap();
        let near = g.add_edge(near_a, near_b, RoadKind::Street, false).unwrap();
        let result = g
            .insert(
                start,
                Point { x: 100.0, z: 0.0 },
                RoadKind::Street,
                SnapOptions {
                    snap: 0.0,
                    ..Default::default()
                },
                false,
            )
            .unwrap();
        assert_eq!(g.nodes[result.node].point, Point { x: 40.0, z: 0.0 });
        assert!(result.severed);
        assert!(g.edges[far].alive);
        assert!(!g.edges[near].alive);
        assert_eq!(g.nodes[result.node].edges, vec![2, 3, 4]);
    }

    #[test]
    fn shallow_incident_angle_rejects_but_keeps_the_allocated_node() {
        let mut g = GraphBuilder::new();
        let a = g.add_node(0.0, 0.0);
        let b = g.add_node(100.0, 0.0);
        g.add_edge(a, b, RoadKind::Street, false);
        assert!(
            g.insert(
                a,
                Point { x: 100.0, z: 10.0 },
                RoadKind::Street,
                SnapOptions {
                    snap: 0.0,
                    ..Default::default()
                },
                false
            )
            .is_none()
        );
        assert_eq!(g.nodes[2].point, Point { x: 100.0, z: 10.0 });
        assert!(g.nodes[2].edges.is_empty());
        assert_eq!(g.nodes[a].edges, vec![0]);
    }

    #[test]
    fn compaction_preserves_ring_orientation_duplicate_incidence_and_segments() {
        let mut g = GraphBuilder::new();
        let a = g.add_node(0.0, 0.0);
        let b = g.add_node(100.0, 0.0);
        let c = g.add_node(100.0, 100.0);
        let d = g.add_node(-100.0, 0.0);
        g.add_edge(a, b, RoadKind::Street, false);
        g.add_edge(b, c, RoadKind::Street, false);
        g.add_edge(c, a, RoadKind::Street, false);
        g.add_edge(d, a, RoadKind::Avenue, false);
        let compact = g.to_road_graph_with_segments();
        assert_eq!(compact.node_map, vec![0, -1, -1, 1]);
        assert_eq!(compact.segments, vec![vec![0, 1, 2], vec![3]]);
        assert_eq!(compact.graph.nodes[0].edges, vec![0, 0, 1]);
        assert_eq!(
            compact.graph.edges[0].points,
            vec![
                Point { x: 0.0, z: 0.0 },
                Point { x: 100.0, z: 0.0 },
                Point { x: 100.0, z: 100.0 },
                Point { x: 0.0, z: 0.0 }
            ]
        );
        assert_eq!((compact.graph.edges[0].a, compact.graph.edges[0].b), (0, 0));
    }

    #[test]
    fn faces_follow_map_insertion_order_even_when_node_ids_do_not() {
        let points = [
            Point { x: 0.0, z: 0.0 },
            Point { x: 100.0, z: 0.0 },
            Point { x: 0.0, z: 100.0 },
            Point { x: 200.0, z: 0.0 },
            Point { x: 300.0, z: 0.0 },
            Point { x: 200.0, z: 100.0 },
        ];
        let nodes = points
            .iter()
            .enumerate()
            .map(|(id, p)| RoadNode {
                id,
                x: p.x,
                z: p.z,
                y: 0.0,
                edges: vec![],
            })
            .collect();
        let edges = [(3, 4), (4, 5), (5, 3), (0, 1), (1, 2), (2, 0)]
            .into_iter()
            .enumerate()
            .map(|(id, (a, b))| RoadEdge {
                id,
                a,
                b,
                kind: RoadKind::Street,
                width: 12.0,
                bridge: false,
                points: vec![points[a], points[b]],
                heights: vec![],
            })
            .collect();
        let faces = planar_faces(&RoadGraph { nodes, edges });
        assert_eq!(
            faces,
            vec![
                (points[3..].to_vec(), vec![0, 1, 2]),
                (points[..3].to_vec(), vec![3, 4, 5])
            ]
        );
    }

    #[test]
    fn cleanup_keeps_largest_component_and_compacts_its_chain() {
        let mut g = GraphBuilder::new();
        let a = g.add_node(-1000.0, 0.0);
        let b = g.add_node(-900.0, 0.0);
        let c = g.add_node(-800.0, 0.0);
        let d = g.add_node(500.0, 0.0);
        let e = g.add_node(1000.0, 0.0);
        g.add_edge(a, b, RoadKind::Street, false);
        g.add_edge(b, c, RoadKind::Street, false);
        g.add_edge(d, e, RoadKind::Street, false);
        g.cleanup(CleanupOptions {
            min_edge: 0.0,
            min_stub: 0.0,
            join: None,
            debug: false,
        });
        let graph = g.to_road_graph();
        assert_eq!(
            graph.edges[0].points,
            vec![
                Point { x: -1000.0, z: 0.0 },
                Point { x: -900.0, z: 0.0 },
                Point { x: -800.0, z: 0.0 }
            ]
        );
        assert!(!g.nodes[d].alive);
        assert!(!g.nodes[e].alive);
        assert_eq!(graph.nodes[0].edges, vec![0]);
        assert_eq!(graph.nodes[1].edges, vec![0]);
    }
}
