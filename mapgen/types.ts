/** Contracts shared by every generation stage and by the explorer renderer. */
export interface Point {
  x: number;
  z: number;
}
export interface MapOptions {
  seed: number;
  /** Map edge length in metres; the origin sits at the centre. */
  size: number;
  /** Metres per height-field cell. */
  cell: number;
  /** Print stage diagnostics to the console (offline runs only). */
  debug?: boolean;
}
export interface HeightField {
  /** Cells per side. */
  w: number;
  h: number;
  cell: number;
  size: number;
  /** Row-major heights in metres; index = z * w + x. */
  data: Float32Array;
}
export type RiverOrder = "stream" | "river" | "main";
export interface River {
  points: Point[];
  /** Width per point in metres. */
  widths: number[];
  order: RiverOrder;
}
export interface Lake {
  outline: Point[];
  level: number;
}
export type RoadKind = "highway" | "avenue" | "street" | "lane";
export interface RoadNode extends Point {
  id: number;
  y: number;
  edges: number[];
}
export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  kind: RoadKind;
  width: number;
  bridge: boolean;
  /** Centreline polyline including both endpoints. */
  points: Point[];
  /** Height per polyline point after grade smoothing. */
  heights: number[];
}
export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
}
/** Final polygons that the 2D explorer and the future 3D mesh builder both consume. */
export interface RoadGeometry {
  /** One polygon per junction node of degree 3 or more (or degree 1 cul-de-sacs). */
  junctions: { node: number; polygon: Point[] }[];
  /** Road bands trimmed at junctions, one per edge; `centre` is the trimmed centreline. */
  bands: {
    edge: number;
    polygon: Point[];
    left: Point[];
    right: Point[];
    centre: Point[];
  }[];
  /** Raised sidewalk pieces: band strips (edge) and junction corners (node). */
  sidewalks: { polygon: Point[]; edge?: number; node?: number }[];
  /** Painted markings on the asphalt, each a simple polygon. */
  markings: { polygon: Point[]; color: "white" | "yellow"; edge: number }[];
}
export type Zone =
  "core" | "commercial" | "residential" | "suburb" | "industrial" | "park" | "rural";
export interface Lot {
  polygon: Point[];
  /** Index of the lot polygon edge touching the street, or -1 for landlocked lots. */
  frontage: number;
  area: number;
}
export interface Block {
  id: number;
  polygon: Point[];
  interior: Point[];
  zone: Zone;
  lots: Lot[];
}
export type BuildingKind =
  | "tower"
  | "office"
  | "apartments"
  | "shop"
  | "townhouse"
  | "house"
  | "warehouse"
  | "civic";
export interface BuildingPlacement extends Point {
  w: number;
  d: number;
  /** Rotation about the vertical axis, radians, so footprints follow their street. */
  angle: number;
  h: number;
  /** Flat pad elevation; the terrain is terraced to this height under the footprint. */
  y: number;
  kind: BuildingKind;
  color: string;
  /** Optional polygonal footprint for dense lots; x/z/w/d/angle stay its bounding box. */
  footprint?: Point[];
}
export interface Tree extends Point {
  h: number;
  kind: "pine" | "oak" | "palm" | "shrub";
}
export interface Lamp extends Point {
  h: number;
}
export interface Park {
  polygon: Point[];
  kind: "garden" | "woodland" | "riverside";
}
export interface Bridge {
  edge: number;
  /** Deck polygon in world coordinates. */
  polygon: Point[];
}
export interface StageTiming {
  stage: string;
  ms: number;
}
export interface GeneratedMap {
  options: MapOptions;
  seaLevel: number;
  terrain: HeightField;
  /** Terrain after road corridors and building pads were stamped into it. */
  shaped: HeightField;
  /** 0..1 flow accumulation normalised by log scale, for debug views. */
  flow: Float32Array;
  rivers: River[];
  lakes: Lake[];
  /** 0..1 suitability for settlement; drives the zoning and road density. */
  desirability: Float32Array;
  centre: Point;
  roads: RoadGraph;
  geometry: RoadGeometry;
  bridges: Bridge[];
  blocks: Block[];
  buildings: BuildingPlacement[];
  parks: Park[];
  trees: Tree[];
  lamps: Lamp[];
  timings: StageTiming[];
}
