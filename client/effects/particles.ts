import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

export type ParticleStyle =
  "fire" | "smoke" | "soot" | "spark" | "flash" | "spray" | "mist";
type TextureStyle = "cloud" | "glow" | "ring";
const textures = new WeakMap<Scene, Map<TextureStyle, RawTexture>>();

/** Shared procedural textures also work in the headless renderer. */
export function particleTexture(scene: Scene, style: TextureStyle) {
  let cache = textures.get(scene);
  if (!cache) {
    cache = new Map();
    textures.set(scene, cache);
    const sceneTextures = cache;
    scene.onDisposeObservable.addOnce(() => {
      for (const texture of sceneTextures.values()) texture.dispose();
      textures.delete(scene);
    });
  }
  const existing = cache.get(style);
  if (existing) return existing;
  const size = 128,
    data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1,
        v = ((y + 0.5) / size) * 2 - 1;
      const radius = Math.hypot(u, v);
      const noise =
        0.62 +
        0.18 * Math.sin(u * 17 + Math.sin(v * 11)) +
        0.12 * Math.sin(v * 27 + u * 13) +
        0.08 * Math.cos(u * 43 - v * 31);
      const alpha =
        style === "ring"
          ? Math.exp(-(((radius - 0.72) / 0.085) ** 2)) * noise
          : style === "cloud"
            ? Math.max(0, 1 - radius) ** 1.3 * noise
            : Math.max(0, Math.exp(-radius * radius * 7) - Math.exp(-7));
      const offset = (y * size + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 255;
      data[offset + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    }
  }
  const texture = RawTexture.CreateRGBATexture(
    data,
    size,
    size,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  texture.name = `particles:${style}`;
  texture.hasAlpha = true;
  cache.set(style, texture);
  return texture;
}

export function createParticles(
  scene: Scene,
  style: ParticleStyle,
  capacity: number,
  position: Vector3,
) {
  const p = new ParticleSystem(`fx:${style}`, capacity, scene);
  const smoke = style === "smoke" || style === "soot" || style === "mist";
  p.particleTexture = particleTexture(
    scene,
    smoke || style === "fire" ? "cloud" : "glow",
  );
  p.emitter = position;
  p.emitRate = 0;
  // Babylon's default advances particle time at 60% of wall time.
  p.updateSpeed = 1 / 60;
  p.minEmitBox.set(-0.15, -0.1, -0.15);
  p.maxEmitBox.set(0.15, 0.1, 0.15);
  p.minEmitPower = p.maxEmitPower = 1;
  p.minInitialRotation = 0;
  p.maxInitialRotation = Math.PI * 2;
  p.minAngularSpeed = -0.7;
  p.maxAngularSpeed = 0.7;
  p.blendMode =
    smoke || style === "spray"
      ? ParticleSystem.BLENDMODE_STANDARD
      : ParticleSystem.BLENDMODE_ADD;
  p.forceDepthWrite = false;
  switch (style) {
    case "fire":
      p.minLifeTime = 0.3;
      p.maxLifeTime = 0.65;
      p.direction1.set(-0.8, 1.8, -0.8);
      p.direction2.set(0.8, 3.5, 0.8);
      p.addSizeGradient(0, 0.35, 0.65)
        .addSizeGradient(0.35, 1, 1.5)
        .addSizeGradient(1, 0.15, 0.4);
      p.addColorGradient(0, new Color4(1, 0.94, 0.65, 0.9));
      p.addColorGradient(0.25, new Color4(1, 0.48, 0.08, 0.85));
      p.addColorGradient(0.7, new Color4(0.8, 0.12, 0.015, 0.45));
      p.addColorGradient(1, new Color4(0.2, 0.02, 0, 0));
      break;
    case "smoke":
    case "soot":
    case "mist": {
      const shade = style === "soot" ? 0.22 : style === "mist" ? 0.88 : 0.57;
      p.minLifeTime = 1.4;
      p.maxLifeTime = 2.6;
      p.direction1.set(-0.4, 0.7, -0.3);
      p.direction2.set(0.8, 1.6, 0.5);
      p.gravity.set(0.15, 0.25, 0.08);
      p.addSizeGradient(0, 0.6, 1).addSizeGradient(1, 2.8, 4);
      p.addColorGradient(0, new Color4(shade, shade, shade, 0));
      p.addColorGradient(
        0.12,
        new Color4(shade, shade * 1.02, shade * 1.05, style === "mist" ? 0.2 : 0.65),
      );
      p.addColorGradient(1, new Color4(shade + 0.08, shade + 0.08, shade + 0.08, 0));
      break;
    }
    case "spark":
      p.minLifeTime = 0.2;
      p.maxLifeTime = 0.65;
      p.direction1.set(-5, 2, -5);
      p.direction2.set(5, 7, 5);
      p.gravity.set(0, -12, 0);
      p.minSize = 0.07;
      p.maxSize = 0.14;
      p.minScaleY = 3;
      p.maxScaleY = 6;
      p.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      p.addColorGradient(0, new Color4(1, 0.92, 0.62, 1));
      p.addColorGradient(0.5, new Color4(1, 0.4, 0.04, 0.9));
      p.addColorGradient(1, new Color4(0.65, 0.07, 0, 0));
      break;
    case "flash":
      p.minLifeTime = 0.06;
      p.maxLifeTime = 0.1;
      p.direction1.setAll(0);
      p.direction2.setAll(0);
      p.addSizeGradient(0, 1.2).addSizeGradient(1, 0.2);
      p.addColorGradient(0, new Color4(1, 0.94, 0.7, 1));
      p.addColorGradient(1, new Color4(1, 0.4, 0.05, 0));
      break;
    case "spray":
      p.minLifeTime = 0.65;
      p.maxLifeTime = 1.15;
      p.direction1.set(-1.3, 6, -1.3);
      p.direction2.set(1.3, 9, 1.3);
      p.gravity.set(0, -14, 0);
      p.minSize = 0.08;
      p.maxSize = 0.18;
      p.minScaleY = 1.5;
      p.maxScaleY = 3;
      p.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      p.addColorGradient(0, new Color4(0.8, 0.94, 1, 0.85));
      p.addColorGradient(0.6, new Color4(0.85, 0.96, 1, 0.65));
      p.addColorGradient(1, new Color4(0.9, 0.97, 1, 0));
      break;
  }
  return p;
}
