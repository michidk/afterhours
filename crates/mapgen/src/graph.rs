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
        let mut map = vec![usize::MAX; self.nodes.len()];
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for e in self.edges.iter().filter(|e| e.alive) {
            for &id in &[e.a, e.b] {
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
                a: map[e.a],
                b: map[e.b],
                kind: e.kind,
                width: road_width(e.kind),
                bridge: e.bridge,
                points: vec![self.nodes[e.a].p, self.nodes[e.b].p],
                heights: Vec::new(),
            });
            nodes[map[e.a]].edges.push(id);
            nodes[map[e.b]].edges.push(id);
        }
        RoadGraph { nodes, edges }
    }
}

pub fn planar_faces(graph: &RoadGraph) -> Vec<Vec<Point>> {
    let mut out = Vec::new();
    for e in &graph.edges {
        if e.points.len() >= 2 {
            out.push(e.points.clone());
        }
    }
    out
}
pub fn turns_left(a: Point, b: Point, c: Point) -> bool {
    geom::cross(geom::sub(b, a), geom::sub(c, b)) > 0.0
}
