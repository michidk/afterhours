/** Write deterministic intermediate snapshots for the native Rust mapgen parity port. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cloneField } from "../mapgen/field.ts";
import { generateHeightmap, thermalErosion, dropletErosion, settle, keepMainIsland, shapeCoast } from "../mapgen/terrain.ts";
import { generateHydrology } from "../mapgen/hydrology.ts";
import { derive } from "../mapgen/random.ts";
import { desirabilityField, chooseCentre } from "../mapgen/site.ts";
import { generateMap } from "../mapgen/pipeline.ts";
import { LIMIT } from "../shared/world.ts";
import { TERRAIN_STEP } from "../shared/terrain.ts";
const args=process.argv.slice(2); const value=(name:string,fallback:string)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]??(()=>{throw Error(`${name} requires a value`)})();};
const seed=Number(value("--seed","713")); const out=resolve(value("--out",".mapgen-dump")); if(!Number.isInteger(seed)) throw Error("--seed must be an integer"); await mkdir(out,{recursive:true});
const json=(v:unknown)=>JSON.stringify(v,(_k,nested)=>ArrayBuffer.isView(nested) && !(nested instanceof DataView)?Array.from(nested):nested); const write=(name:string,v:unknown)=>writeFile(resolve(out,`${name}.json`),`${json(v)}\n`);
const options={seed,size:LIMIT*2,cell:TERRAIN_STEP}; const {field,flatness}=generateHeightmap(seed,options.size,options.cell); await write("terrain",{field,flatness});
const erosion=cloneField(field); thermalErosion(erosion,10); await write("erosion-thermal-1",erosion); dropletErosion(erosion,derive(seed,"droplets"),Math.round(erosion.w*erosion.h*0.7)); await write("erosion-droplet",erosion); thermalErosion(erosion,4); await write("erosion-thermal-2",erosion); settle(erosion); await write("erosion-settle",erosion); keepMainIsland(erosion); await write("erosion-island",erosion); shapeCoast(erosion); await write("erosion",erosion);
const hydro=generateHydrology(erosion,seed); await write("hydrology",{field:erosion,flow:hydro.flow,rivers:hydro.rivers,lakes:hydro.lakes,riverMask:hydro.riverMask,waterDistance:hydro.waterDistance,coastDistance:hydro.coastDistance});
const desirability=desirabilityField(erosion,hydro,seed); await write("site",{desirability,centre:chooseCentre(erosion,desirability)});
// The complete snapshot remains useful to later stage ports.
const map=generateMap(options); await write("roads",map.roads); await write("shaped",map.shaped); await write("blocks",map.blocks); await write("buildings",map.buildings); await write("parks",map.parks); await write("vegetation",{trees:map.trees,lamps:map.lamps});
console.log(`Wrote mapgen stage dumps for seed ${seed} to ${out}`);
