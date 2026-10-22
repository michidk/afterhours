//! Deterministic planar road graph construction.
use crate::{
    geom::{self, Point},
    types::{RoadEdge, RoadGraph, RoadKind, RoadNode},
};
use std::collections::{HashMap, HashSet};

pub const ROAD_WIDTH: [(RoadKind, f64); 4] = [
    (RoadKind::Highway, 24.0),
    (RoadKind::Avenue, 18.0),
    (RoadKind::Street, 12.0),
    (RoadKind::Lane, 7.0),
];
pub fn road_width(k: RoadKind) -> f64 {
    match k {
        RoadKind::Highway => 24.0,
        RoadKind::Avenue => 18.0,
        RoadKind::Street => 12.0,
        RoadKind::Lane => 7.0,
    }
}
pub fn road_rank(k: RoadKind) -> i32 {
    match k {
        RoadKind::Highway => 3,
        RoadKind::Avenue => 2,
        RoadKind::Street => 1,
        RoadKind::Lane => 0,
    }
}

#[derive(Clone, Debug)]
struct Node {
    p: Point,
    edges: HashSet<usize>,
    alive: bool,
}
#[derive(Clone, Debug)]
struct Edge {
    id: usize,
    a: usize,
    b: usize,
    kind: RoadKind,
    bridge: bool,
    alive: bool,
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
            min_angle: 34.0_f64.to_radians(),
        }
    }
}

#[derive(Default, Debug)]
pub struct GraphBuilder {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    cell: f64,
    node_cells: HashMap<(i64, i64), Vec<usize>>,
    edge_cells: HashMap<(i64, i64), Vec<usize>>,
}
impl GraphBuilder {
    pub fn new() -> Self {
        Self {
            cell: 48.0,
            ..Default::default()
        }
    }
    fn key(&self, p: Point) -> (i64, i64) {
        (
            (p.x / self.cell).floor() as i64,
            (p.z / self.cell).floor() as i64,
        )
    }
    pub fn add_node(&mut self, x: f64, z: f64) -> usize {
        let id = self.nodes.len();
        let p = Point { x, z };
        self.nodes.push(Node {
            p,
            edges: HashSet::new(),
            alive: true,
        });
        self.node_cells.entry(self.key(p)).or_default().push(id);
        id
    }
    fn index_edge(&mut self, e: &Edge) {
        let a = self.nodes[e.a].p;
        let b = self.nodes[e.b].p;
        for x in
            (a.x.min(b.x) / self.cell).floor() as i64..=(a.x.max(b.x) / self.cell).floor() as i64
        {
            for z in (a.z.min(b.z) / self.cell).floor() as i64
                ..=(a.z.max(b.z) / self.cell).floor() as i64
            {
                self.edge_cells.entry((x, z)).or_default().push(e.id);
            }
        }
    }
    pub fn add_edge(&mut self, a: usize, b: usize, kind: RoadKind, bridge: bool) -> usize {
        if a == b {
            return usize::MAX;
        }
        for id in self.nodes[a].edges.clone() {
            let e = &mut self.edges[id];
            if e.alive && (e.a == b || e.b == b) {
                if road_rank(kind) > road_rank(e.kind) {
                    e.kind = kind;
                }
                return id;
            }
        }
        let id = self.edges.len();
        let e = Edge {
            id,
            a,
            b,
            kind,
            bridge,
            alive: true,
        };
        self.edges.push(e.clone());
        self.nodes[a].edges.insert(id);
        self.nodes[b].edges.insert(id);
        self.index_edge(&e);
        id
    }
    pub fn remove_edge(&mut self, id: usize) {
        if id >= self.edges.len() || !self.edges[id].alive {
            return;
        }
        let (a, b) = (self.edges[id].a, self.edges[id].b);
        self.edges[id].alive = false;
        self.nodes[a].edges.remove(&id);
        self.nodes[b].edges.remove(&id);
    }
    pub fn remove_node(&mut self, id: usize) {
        for e in self.nodes[id].edges.clone() {
            self.remove_edge(e);
        }
        self.nodes[id].alive = false;
    }
    fn degree(&self, id: usize) -> usize {
        self.nodes[id].edges.len()
    }
    fn nodes_near(&self, p: Point, radius: f64) -> Vec<usize> {
        let r = (radius / self.cell).ceil() as i64;
        let c = self.key(p);
        let mut out = Vec::new();
        for x in c.0 - r..=c.0 + r {
            for z in c.1 - r..=c.1 + r {
                for &id in self.node_cells.get(&(x, z)).unwrap_or(&Vec::new()) {
                    let n = &self.nodes[id];
                    if n.alive && geom::dist(n.p, p) <= radius {
                        out.push(id);
                    }
                }
            }
        }
        out
    }
    fn edges_near(&self, a: Point, b: Point, pad: f64) -> Vec<usize> {
        let mut out = HashSet::new();
        let x0 = ((a.x.min(b.x) - pad) / self.cell).floor() as i64;
        let x1 = ((a.x.max(b.x) + pad) / self.cell).floor() as i64;
        let z0 = ((a.z.min(b.z) - pad) / self.cell).floor() as i64;
        let z1 = ((a.z.max(b.z) + pad) / self.cell).floor() as i64;
        for x in x0..=x1 {
            for z in z0..=z1 {
                for &id in self.edge_cells.get(&(x, z)).unwrap_or(&Vec::new()) {
                    if self.edges[id].alive {
                        out.insert(id);
                    }
                }
            }
        }
        let mut v: Vec<_> = out.into_iter().collect();
        v.sort_unstable();
        v
    }
    fn line_angle(&self, a: Point, b: Point, c: Point, d: Point) -> f64 {
        let u = geom::sub(b, a);
        let v = geom::sub(d, c);
        let q = (u.x * v.x + u.z * v.z).abs() / ((geom::len(u) * geom::len(v)).max(1.0));
        q.min(1.0).acos()
    }
    fn split_edge(&mut self, id: usize, p: Point) -> usize {
        let e = self.edges[id].clone();
        if geom::dist(self.nodes[e.a].p, p) < 0.5 {
            return e.a;
        }
        if geom::dist(self.nodes[e.b].p, p) < 0.5 {
            return e.b;
        }
        let m = self.add_node(p.x, p.z);
        self.remove_edge(id);
        self.add_edge(e.a, m, e.kind, e.bridge);
        self.add_edge(m, e.b, e.kind, e.bridge);
        m
    }
    pub fn insert(
        &mut self,
        from: usize,
        to: Point,
        kind: RoadKind,
        options: SnapOptions,
        bridge: bool,
    ) -> Option<(usize, bool)> {
        let start = self.nodes[from].p;
        if geom::dist(start, to) < 2.0 {
            return None;
        }
        let mut end = to;
        let mut end_node = None;
        let mut severed = false;
        let mut best_t = f64::INFINITY;
        for id in self.edges_near(start, end, options.snap) {
            let e = self.edges[id].clone();
            if e.a == from || e.b == from || e.bridge != bridge {
                continue;
            }
            if let Some((t, u)) =
                geom::segment_intersection(start, end, self.nodes[e.a].p, self.nodes[e.b].p)
            {
                if self.line_angle(start, end, self.nodes[e.a].p, self.nodes[e.b].p)
                    < options.min_angle
                {
                    return None;
                }
                if t < best_t {
                    best_t = t;
                    end = geom::lerp(self.nodes[e.a].p, self.nodes[e.b].p, u);
                    end_node = Some(self.split_edge(id, end));
                    severed = true;
                }
            }
        }
        if end_node.is_none() {
            let mut near = None;
            let mut d = options.snap;
            for id in self.nodes_near(end, options.snap) {
                if id != from {
                    let q = geom::dist(self.nodes[id].p, end);
                    if q < d {
                        d = q;
                        near = Some(id);
                    }
                }
            }
            if let Some(id) = near {
                end_node = Some(id);
                end = self.nodes[id].p;
                severed = true;
            }
        }
        if end_node.is_none() {
            for id in self.edges_near(start, end, options.snap) {
                let e = self.edges[id].clone();
                if e.a == from || e.b == from || e.bridge != bridge {
                    continue;
                }
                let (q, d) = geom::closest_on_segment(end, self.nodes[e.a].p, self.nodes[e.b].p);
                if d <= options.snap {
                    if self.line_angle(start, q, self.nodes[e.a].p, self.nodes[e.b].p)
                        < options.min_angle
                    {
                        return None;
                    }
                    end = q;
                    end_node = Some(self.split_edge(id, q));
                    severed = true;
                    break;
                }
            }
        }
        let n = end_node.unwrap_or_else(|| self.add_node(end.x, end.z));
        if n == from || geom::dist(self.nodes[n].p, start) < 4.0 {
            return None;
        }
        for id in self.edges_near(start, end, 0.0) {
            let e = &self.edges[id];
            if e.a != from
                && e.b != from
                && e.a != n
                && e.b != n
                && e.bridge == bridge
                && geom::segment_intersection(start, end, self.nodes[e.a].p, self.nodes[e.b].p)
                    .is_some()
            {
                return None;
            }
        }
        if self.degree(from) >= 4 || self.degree(n) >= 4 {
            return None;
        }
        self.add_edge(from, n, kind, bridge);
        Some((n, severed))
    }
    pub fn bridge_rivers(&mut self, rivers: &[crate::types::River]) {
        for e in &mut self.edges {
            if !e.alive || e.bridge {
                continue;
            }
            let a = self.nodes[e.a].p;
            let b = self.nodes[e.b].p;
            e.bridge = rivers.iter().any(|r| {
                r.points.windows(2).enumerate().any(|(i, w)| {
                    let reach = r
                        .widths
                        .get(i + 1)
                        .copied()
                        .unwrap_or(0.0)
                        .max(r.widths.get(i).copied().unwrap_or(0.0))
                        / 2.0
                        + 1.0;
                    geom::segment_intersection(a, b, w[0], w[1]).is_some()
                        || geom::distance_to_segment(w[0], a, b) < reach
                        || geom::distance_to_segment(a, w[0], w[1]) < reach
                        || geom::distance_to_segment(b, w[0], w[1]) < reach
                })
            })
        }
    }
    pub fn to_road_graph(&self) -> RoadGraph {
        let continuous = |node: usize| {
            let n = &self.nodes[node];
            if n.edges.len() != 2 {
                return false;
            }
            let mut it = n.edges.iter();
            let p = &self.edges[*it.next().unwrap()];
            let q = &self.edges[*it.next().unwrap()];
            p.kind == q.kind && p.bridge == q.bridge
        };
        let mut used = vec![false; self.edges.len()];
        let mut chains: Vec<(RoadKind, bool, Vec<usize>)> = Vec::new();
        for e in self.edges.iter().filter(|e| e.alive) {
            if used[e.id] {
                continue;
            }
            let mut start_node = e.a;
            let mut start_edge = e.id;
            let mut seen = HashSet::from([e.id]);
            while continuous(start_node) {
                let next = self.nodes[start_node]
                    .edges
                    .iter()
                    .copied()
                    .map(|id| &self.edges[id])
                    .find(|x| x.id != start_edge);
                let Some(prev) = next else {
                    break;
                };
                if !seen.insert(prev.id) {
                    break;
                }
                start_edge = prev.id;
                start_node = if prev.a == start_node { prev.b } else { prev.a };
            }
            let kind = self.edges[start_edge].kind;
            let bridge = self.edges[start_edge].bridge;
            let mut nodes = vec![start_node];
            let mut current = start_node;
            let mut edge = start_edge;
            loop {
                used[edge] = true;
                let e = &self.edges[edge];
                current = if e.a == current { e.b } else { e.a };
                nodes.push(current);
                if !continuous(current) {
                    break;
                }
                let next = self.nodes[current]
                    .edges
                    .iter()
                    .copied()
                    .find(|id| *id != edge && !used[*id]);
                let Some(next) = next else {
                    break;
                };
                edge = next;
            }
            chains.push((kind, bridge, nodes));
        }
        let mut map = vec![usize::MAX; self.nodes.len()];
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for (kind, bridge, chain) in chains {
            for &id in [chain[0], *chain.last().unwrap()].iter() {
                if map[id] == usize::MAX {
                    map[id] = nodes.len();
                    let p = self.nodes[id].p;
                    nodes.push(RoadNode {
                        id: nodes.len(),
                        x: p.x,
                        z: p.z,
                        y: 0.0,
                        edges: Vec::new(),
                    });
                }
            }
            let id = edges.len();
            edges.push(RoadEdge {
                id,
                a: map[chain[0]],
                b: map[*chain.last().unwrap()],
                kind,
                width: road_width(kind),
                bridge,
                points: chain.iter().map(|n| self.nodes[*n].p).collect(),
                heights: Vec::new(),
            });
            nodes[map[chain[0]]].edges.push(id);
            nodes[map[*chain.last().unwrap()]].edges.push(id);
        }
        RoadGraph { nodes, edges }
    }
}

pub fn planar_faces(graph: &RoadGraph) -> Vec<(Vec<Point>, Vec<usize>)> {
    #[derive(Clone)]
    struct Half {
        edge: usize,
        from: usize,
        to: usize,
        points: Vec<Point>,
    }
    let mut outgoing: HashMap<usize, Vec<Half>> = HashMap::new();
    for e in &graph.edges {
        outgoing.entry(e.a).or_default().push(Half {
            edge: e.id,
            from: e.a,
            to: e.b,
            points: e.points.clone(),
        });
        outgoing.entry(e.b).or_default().push(Half {
            edge: e.id,
            from: e.b,
            to: e.a,
            points: e.points.iter().copied().rev().collect(),
        });
    }
    let angle = |h: &Half| {
        let p = h.points[0];
        let q = h.points[1.min(h.points.len() - 1)];
        (q.z - p.z).atan2(q.x - p.x)
    };
    for list in outgoing.values_mut() {
        list.sort_by(|a, b| angle(a).total_cmp(&angle(b)));
    }
    let key = |h: &Half| (h.edge, h.from);
    let mut used = HashSet::new();
    let mut faces = Vec::new();
    for list in outgoing.values() {
        for start in list {
            if used.contains(&key(start)) {
                continue;
            }
            let mut h = start.clone();
            let mut ring = Vec::new();
            let mut edges = Vec::new();
            for _ in 0..10000 {
                if !used.insert(key(&h)) {
                    break;
                }
                edges.push(h.edge);
                ring.extend_from_slice(&h.points[..h.points.len().saturating_sub(1)]);
                let arrivals = &outgoing[&h.to];
                let back = h.points[h.points.len().saturating_sub(2)];
                let tip = *h.points.last().unwrap();
                let incoming = (back.z - tip.z).atan2(back.x - tip.x);
                let mut best = None;
                for cand in arrivals {
                    let mut delta = incoming - angle(cand);
                    while delta <= 1e-9 {
                        delta += std::f64::consts::TAU;
                    }
                    if cand.edge == h.edge && arrivals.len() > 1 {
                        delta += std::f64::consts::TAU;
                    }
                    if best.as_ref().is_none_or(|(d, _)| delta < *d) {
                        best = Some((delta, cand));
                    }
                }
                let Some((_, next)) = best else {
                    break;
                };
                h = next.clone();
            }
            if ring.len() >= 3 && geom::signed_area(&ring) > 0.0 {
                faces.push((ring, edges));
            }
        }
    }
    faces
}
pub fn turns_left(a: Point, b: Point, c: Point) -> bool {
    geom::cross(geom::sub(b, a), geom::sub(c, b)) > 0.0
}
