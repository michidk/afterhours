import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { Material } from "@babylonjs/core/Materials/material";

/**
 * Screen-door dither driven by mesh.visibility so buildings between the camera and the
 * player fade per object (Witcher 3 / A Hat in Time "geometry dithering"). No alpha
 * blending: depth and shadows stay intact and merged chunk meshes need no material swap.
 */
export class CameraDither extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "CameraDither", 200, { CAMERA_DITHER: true });
    // visibility < 1 would otherwise move the mesh into the alpha-blend pass.
    material.transparencyMode = Material.MATERIAL_OPAQUE;
    this._enable(true);
  }
  override getClassName() {
    return "CameraDither";
  }
  override getCustomCode(shaderType: string) {
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
float ditherBayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float ditherBayer4(vec2 a) { return ditherBayer2(0.5 * a) * 0.25 + ditherBayer2(a); }`,
      CUSTOM_FRAGMENT_MAIN_BEGIN: `if (visibility < ditherBayer4(gl_FragCoord.xy)) discard;`,
    };
  }
}
