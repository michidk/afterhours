use crate::types::*;
pub mod stages {
    use super::*;
    pub fn generate_heightmap(_seed: i32, size: f64, cell: f64) -> HeightField {
        crate::field::create(size, cell)
    }
    pub fn thermal_erosion(_: &mut HeightField, _: usize) {}
    pub fn droplet_erosion(_: &mut HeightField, _: &mut crate::random::Rng, _: usize) {}
    pub fn settle(_: &mut HeightField) {}
    pub fn keep_main_island(_: &mut HeightField) {}
    pub fn shape_coast(_: &mut HeightField) {}
    pub fn generate_hydrology(f: &HeightField) -> Hydrology {
        Hydrology {
            rivers: vec![],
            lakes: vec![],
            river_mask: vec![0; f.w * f.h],
            water_distance: vec![1e6; f.w * f.h],
            coast_distance: vec![1e6; f.w * f.h],
            flow: vec![0.; f.w * f.h],
        }
    }
    pub fn desirability_field(f: &HeightField) -> Vec<f32> {
        vec![0.; f.w * f.h]
    }
    pub fn choose_centre(_: &HeightField, _: &[f32]) -> Point {
        Point { x: 0., z: 0. }
    }
    pub fn generate_roads(
        _: &HeightField,
        _: &Hydrology,
        _: &[f32],
        _: Point,
        _: i32,
    ) -> RoadGraph {
        RoadGraph::default()
    }
    pub fn smooth_centrelines(_: &mut RoadGraph) {}
    pub fn densify_centrelines(_: &mut RoadGraph) {}
    pub fn build_road_geometry(_: &RoadGraph) -> RoadGeometry {
        RoadGeometry::default()
    }
    pub fn solve_profiles(_: &mut RoadGraph, _: &HeightField, _: &[(f64, f64)]) {}
    pub fn stamp_roads(_: &mut HeightField, _: &RoadGraph, _: &RoadGeometry) -> Vec<f32> {
        vec![]
    }
    pub fn bridge_decks(_: &RoadGraph) -> Vec<Bridge> {
        vec![]
    }
    pub fn street_polygons(_: &RoadGraph, _: &RoadGeometry) -> (Vec<Vec<Point>>, Vec<Vec<Point>>) {
        (vec![], vec![])
    }
    pub fn sink_under_streets(_: &mut HeightField, _: &RoadGeometry) {}
    pub fn street_test(_: &RoadGeometry, _: Point) -> bool {
        false
    }
}
pub fn generate_map(options: MapOptions, progress: Option<&mut dyn FnMut(&str)>) -> GeneratedMap {
    let mut progress = progress;
    let mut stage = |name: &str| {
        if let Some(p) = progress.as_mut() {
            p(name)
        }
    };
    stage("terrain");
    let mut terrain = stages::generate_heightmap(options.seed, options.size, options.cell);
    stage("erosion");
    stages::thermal_erosion(&mut terrain, 10);
    stages::droplet_erosion(
        &mut terrain,
        &mut crate::random::derive(options.seed, "droplets"),
        0,
    );
    stages::settle(&mut terrain);
    stages::keep_main_island(&mut terrain);
    stages::shape_coast(&mut terrain);
    stage("hydrology");
    let hydro = stages::generate_hydrology(&terrain);
    stage("site");
    let desirability = stages::desirability_field(&terrain);
    let centre = stages::choose_centre(&terrain, &desirability);
    stage("roads");
    let roads = stages::generate_roads(&terrain, &hydro, &desirability, centre, options.seed);
    let shaped = terrain.clone();
    let geometry = stages::build_road_geometry(&roads);
    stage("blocks");
    let blocks = crate::blocks::generate_blocks(&roads, &shaped, &hydro, centre, options.seed);
    stage("buildings");
    let buildings = crate::buildings::place_buildings(&blocks, &shaped, centre, options.seed);
    let parks = crate::vegetation::make_parks(&blocks, &hydro, &shaped);
    stage("vegetation");
    let (trees, lamps) = crate::vegetation::place_vegetation(
        &shaped,
        &hydro,
        &roads,
        &blocks,
        &buildings,
        &desirability,
        options.seed,
        |_| false,
    );
    GeneratedMap {
        options,
        sea_level: 0.,
        terrain,
        shaped,
        flow: hydro.flow,
        rivers: hydro.rivers,
        lakes: hydro.lakes,
        desirability,
        centre,
        roads,
        geometry,
        bridges: vec![],
        blocks,
        buildings,
        parks,
        trees,
        lamps,
        timings: vec![],
    }
}
