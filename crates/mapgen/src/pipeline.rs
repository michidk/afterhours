//! The `stages` integration boundary is replaced by the terrain and roads merges.
use crate::types::*;
pub const NATIVE_STAGES_AVAILABLE: bool = false;
pub mod stages {
    use super::*;
    /// Borrowed equivalents of the TypeScript road generation inputs.
    pub struct RoadInputs<'a> {
        pub field: &'a HeightField,
        pub hydro: &'a Hydrology,
        pub desirability: &'a [f32],
        pub centre: Point,
        pub seed: i32,
        pub debug: bool,
    }
    pub type DebugLog<'a> = Option<&'a mut dyn FnMut(&str, f64)>;
    pub type Progress<'a> = Option<&'a mut dyn FnMut(&str)>;
    pub type StreetPolygons = (Vec<Vec<f64>>, Vec<Vec<f64>>);
    pub type StreetLayers<'a> = &'a [(&'a [Vec<f64>], f64)];
    // Each missing integration stage fails explicitly. The final merge replaces
    // these adapters with calls to the verified terrain and roads implementations.
    macro_rules! missing_stage {
        ($name:ident) => {
            panic!(concat!(
                "native integration stage has not been merged: ",
                stringify!($name)
            ))
        };
    }
    pub fn generate_heightmap(_seed: i32, _size: f64, _cell: f64) -> HeightField {
        missing_stage!(generate_heightmap)
    }
    pub fn thermal_erosion(_f: &mut HeightField, _iterations: usize) {
        missing_stage!(thermal_erosion)
    }
    pub fn droplet_erosion(_f: &mut HeightField, _rng: &mut crate::random::Rng, _count: usize) {
        missing_stage!(droplet_erosion)
    }
    pub fn settle(_f: &mut HeightField) {
        missing_stage!(settle)
    }
    pub fn keep_main_island(_f: &mut HeightField) {
        missing_stage!(keep_main_island)
    }
    pub fn shape_coast(_f: &mut HeightField) {
        missing_stage!(shape_coast)
    }
    pub fn generate_hydrology(
        _f: &mut HeightField,
        _seed: i32,
        _sea_level: f64,
        _log: DebugLog<'_>,
    ) -> Hydrology {
        missing_stage!(generate_hydrology)
    }
    pub fn desirability_field(_f: &HeightField, _hydro: &Hydrology, _seed: i32) -> Vec<f32> {
        missing_stage!(desirability_field)
    }
    pub fn choose_centre(_f: &HeightField, _desirability: &[f32]) -> Point {
        missing_stage!(choose_centre)
    }
    pub fn generate_roads(_input: &RoadInputs<'_>, _progress: Progress<'_>) -> RoadGraph {
        missing_stage!(generate_roads)
    }
    pub fn smooth_centrelines(_graph: &mut RoadGraph) {
        missing_stage!(smooth_centrelines)
    }
    pub fn densify_centrelines(_graph: &mut RoadGraph) {
        missing_stage!(densify_centrelines)
    }
    pub fn build_road_geometry(_graph: &RoadGraph) -> RoadGeometry {
        missing_stage!(build_road_geometry)
    }
    pub fn solve_profiles(_graph: &mut RoadGraph, _f: &HeightField, _trims: &[(f64, f64)]) {
        missing_stage!(solve_profiles)
    }
    pub fn stamp_roads(
        _f: &mut HeightField,
        _graph: &RoadGraph,
        _geometry: &RoadGeometry,
    ) -> Vec<f32> {
        missing_stage!(stamp_roads)
    }
    pub fn bridge_decks(_graph: &RoadGraph) -> Vec<Bridge> {
        missing_stage!(bridge_decks)
    }
    pub fn street_polygons(_graph: &RoadGraph, _geometry: &RoadGeometry) -> StreetPolygons {
        missing_stage!(street_polygons)
    }
    pub fn sink_under_streets(
        _f: &mut HeightField,
        _layers: StreetLayers<'_>,
        _pads: &[BuildingPlacement],
    ) {
        missing_stage!(sink_under_streets)
    }
    pub fn street_test(_geometry: &RoadGeometry, _margin: f64) -> impl Fn(Point) -> bool + '_ {
        |_p| missing_stage!(street_test)
    }
}
/// Execute the same stages and mutations as `mapgen/pipeline.ts`.
pub fn generate_map(
    options: MapOptions,
    mut progress: Option<&mut dyn FnMut(&str)>,
) -> GeneratedMap {
    fn stage<T>(
        name: &str,
        progress: &mut Option<&mut dyn FnMut(&str)>,
        timings: &mut Vec<StageTiming>,
        run: impl FnOnce(&mut Option<&mut dyn FnMut(&str)>) -> T,
    ) -> T {
        if let Some(p) = progress.as_mut() {
            p(name);
        }
        let now = std::time::Instant::now();
        let value = run(progress);
        timings.push(StageTiming {
            stage: name.into(),
            ms: now.elapsed().as_secs_f64() * 1000.0,
        });
        value
    }
    let mut timings = Vec::new();
    let seed = options.seed;
    let mut terrain = stage("terrain", &mut progress, &mut timings, |_| {
        stages::generate_heightmap(seed, options.size, options.cell)
    });
    stage("erosion", &mut progress, &mut timings, |_| {
        stages::thermal_erosion(&mut terrain, 10);
        let droplets = crate::random::js_round((terrain.w * terrain.h) as f64 * 0.7) as usize;
        stages::droplet_erosion(
            &mut terrain,
            &mut crate::random::derive(seed, "droplets"),
            droplets,
        );
        stages::thermal_erosion(&mut terrain, 4);
        stages::settle(&mut terrain);
        stages::keep_main_island(&mut terrain);
        stages::shape_coast(&mut terrain);
    });
    let hydro = stage("hydrology", &mut progress, &mut timings, |_| {
        let mut log = |label: &str, ms: f64| eprintln!("    {label} {ms} ms");
        let debug = if options.debug {
            Some(&mut log as &mut dyn FnMut(&str, f64))
        } else {
            None
        };
        stages::generate_hydrology(&mut terrain, seed, 0.0, debug)
    });
    let desirability = stage("site", &mut progress, &mut timings, |_| {
        stages::desirability_field(&terrain, &hydro, seed)
    });
    let centre = stages::choose_centre(&terrain, &desirability);
    let mut roads = stage("roads", &mut progress, &mut timings, |progress| {
        let input = stages::RoadInputs {
            field: &terrain,
            hydro: &hydro,
            desirability: &desirability,
            centre,
            seed,
            debug: options.debug,
        };
        let mut report = |message: &str| {
            if let Some(p) = progress.as_mut() {
                p(&format!("roads: {message}"));
            }
        };
        stages::generate_roads(&input, Some(&mut report))
    });
    let mut shaped = terrain.clone();
    let mut road_cells = Vec::new();
    let geometry = stage("road geometry", &mut progress, &mut timings, |_| {
        stages::smooth_centrelines(&mut roads);
        stages::densify_centrelines(&mut roads);
        let geometry = stages::build_road_geometry(&roads);
        stages::solve_profiles(&mut roads, &terrain, &geometry.trims);
        road_cells = stages::stamp_roads(&mut shaped, &roads, &geometry);
        geometry
    });
    let bridges = stages::bridge_decks(&roads);
    let blocks = stage("blocks", &mut progress, &mut timings, |_| {
        crate::blocks::generate_blocks(&roads, &shaped, &hydro, centre, seed)
    });
    let buildings = stage("buildings", &mut progress, &mut timings, |_| {
        let placed = crate::buildings::place_buildings(&blocks, &shaped, centre, seed);
        crate::buildings::stamp_pads(&mut shaped, &placed, Some(&road_cells));
        placed
    });
    stage("street fit", &mut progress, &mut timings, |_| {
        let (asphalt, sidewalks) = stages::street_polygons(&roads, &geometry);
        stages::sink_under_streets(
            &mut shaped,
            &[(&asphalt, 0.1), (&sidewalks, 0.1 + 0.15)],
            &buildings,
        );
    });
    let parks = crate::vegetation::make_parks(&blocks, &hydro, &shaped);
    let (trees, lamps) = stage("vegetation", &mut progress, &mut timings, |_| {
        let on_street = stages::street_test(&geometry, 0.25);
        crate::vegetation::place_vegetation(
            &shaped,
            &hydro,
            &roads,
            &blocks,
            &buildings,
            &desirability,
            seed,
            on_street,
        )
    });
    GeneratedMap {
        options,
        sea_level: 0.0,
        terrain,
        shaped,
        flow: hydro.flow,
        rivers: hydro.rivers,
        lakes: hydro.lakes,
        desirability,
        centre,
        roads,
        geometry,
        bridges,
        blocks,
        buildings,
        parks,
        trees,
        lamps,
        timings,
    }
}
