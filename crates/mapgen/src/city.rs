use crate::{
    packing::{pack_heights, pack_surface_chunks},
    types::{BuildingKind, GeneratedMap, ParkKind, RoadKind},
};
use serde_json::{Value, json};
fn round(v: f64) -> f64 {
    (v * 100.0).round() / 100.0 + 0.0
}
fn asset(k: BuildingKind) -> &'static str {
    match k {
        BuildingKind::Tower => "glass-tower",
        BuildingKind::Office => "deco-tower",
        BuildingKind::Apartments => "apartments",
        BuildingKind::Shop => "shop-house",
        BuildingKind::Townhouse => "townhouse",
        BuildingKind::House => "villa",
        BuildingKind::Warehouse => "warehouse",
        BuildingKind::Civic => "civic-hall",
    }
}
fn kind(k: RoadKind) -> &'static str {
    match k {
        RoadKind::Highway | RoadKind::Avenue => "avenue",
        RoadKind::Street => "street",
        RoadKind::Lane => "service",
    }
}
pub fn city_from_map(map: &GeneratedMap) -> Value {
    let shift = -1.1 - map.sea_level;
    let heights: Vec<f64> = map
        .shaped
        .data
        .iter()
        .map(|h| round((*h as f64 + shift).clamp(-80., 240.)))
        .collect();
    let mut roads = Vec::new();
    for e in &map.roads.edges {
        for p in e.points.windows(2) {
            let (a, b) = (p[0], p[1]);
            let ax = round(a.x);
            let az = round(a.z);
            let bx = round(b.x);
            let bz = round(b.z);
            if (bx - ax).hypot(bz - az) < 0.05 {
                continue;
            }
            roads.push(json!({"x":round((ax+bx)/2.),"z":round((az+bz)/2.),"ax":ax,"az":az,"bx":bx,"bz":bz,"width":e.width.clamp(6.,24.),"kind":kind(e.kind)}));
        }
    }
    let buildings:Vec<Value>=map.buildings.iter().enumerate().map(|(i,b)|json!({"x":round(b.x),"z":round(b.z),"w":round(b.w),"d":round(b.d),"y":round(b.y+shift),"h":round((b.y+b.h+shift).min(256.)),"angle":round(b.angle),"asset":asset(b.kind),"facing":0,"color":b.color.to_lowercase(),"style":i%3})).collect();
    let props:Vec<Value>=map.trees.iter().map(|t|json!({"x":round(t.x),"z":round(t.z),"h":t.h,"kind":format!("{:?}",t.kind).to_lowercase()})).chain(map.lamps.iter().map(|t|json!({"x":round(t.x),"z":round(t.z),"h":t.h,"angle":round(t.angle),"kind":"lamp"}))).collect();
    let parks:Vec<Value>=map.parks.iter().map(|p|{let c=crate::geom::centroid(&p.polygon);json!({"x":round(c.x),"z":round(c.z),"kind":match p.kind{ParkKind::Garden=>"garden",ParkKind::Woodland=>"woodland",ParkKind::Riverside=>"woodland"}})}).collect();
    let lakes:Vec<Value>=map.lakes.iter().map(|l|json!({"level":round(l.level+shift),"outline":l.outline.iter().flat_map(|p|[round(p.x),round(p.z)]).collect::<Vec<_>>()})).collect();
    let rivers:Vec<Value>=map.rivers.iter().map(|r|json!({"points":r.points.iter().zip(&r.widths).flat_map(|(p,w)|[round(p.x),round(p.z),round(*w)]).collect::<Vec<_>>()})).collect();
    let city = json!({"seed":map.options.seed,"terrain":{"cm":pack_heights(&heights.iter().map(|v|*v as f32).collect::<Vec<_>>())},"centre":{"x":round(map.centre.x),"z":round(map.centre.z)},"surface":pack_surface_chunks(&map.geometry,shift),"roads":roads,"props":props,"buildings":buildings,"parks":parks,"surfaces":[],"ramps":[],"water":{"lakes":lakes,"rivers":rivers},"pickups":[],"airport":{"x":640,"z":-640,"w":220,"d":220},"landmarks":[]});
    json!({"format":"afterhours-city","version":7,"city":city})
}
