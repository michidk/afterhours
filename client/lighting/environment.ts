type RGB = [number, number, number];
const rgb = (hex: string): RGB =>
  [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB;
const mix = (a: RGB, b: RGB, t: number): RGB =>
  a.map((n, i) => n + (b[i] - n) * t) as RGB;
const smooth = (a: number, b: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export function environmentAt(hour: number) {
  const phase = (((((hour % 24) + 24) % 24) - 6) / 24) * Math.PI * 2;
  const elevation = Math.sin(phase);
  const daylight = smooth(-0.09, 0.42, elevation);
  const twilight = 1 - smooth(0, 0.45, Math.abs(elevation));
  const night = 1 - daylight;
  const direction = [Math.cos(phase) * 0.9, elevation, 0.35] as RGB;
  const length = Math.hypot(...direction);
  const sunDirection = direction.map((v) => v / length) as RGB;
  const warm = rgb(hour < 12 ? "efb594" : "ed917d");
  return {
    daylight,
    twilight,
    night,
    zenith: mix(
      mix(rgb("101c37"), rgb("78b5d0"), daylight),
      rgb("7979a3"),
      twilight * 0.35,
    ),
    horizon: mix(mix(rgb("293952"), rgb("d1e1db"), daylight), warm, twilight * 0.85),
    sunlight: mix(rgb("ffd0a0"), rgb("fff2dc"), smooth(0.05, 0.65, elevation)),
    ambient: mix(rgb("9cb4e2"), rgb("e2edf0"), daylight),
    ground: mix(rgb("414e72"), rgb("879888"), daylight),
    sunDirection,
    lightDirection:
      elevation >= 0 ? sunDirection : (sunDirection.map((v) => -v) as RGB),
    directIntensity:
      elevation >= 0
        ? Math.pow(elevation, 0.55) * 0.85
        : 0.18 * night * smooth(0, 0.3, -elevation),
    ambientIntensity: 0.46 + daylight * 0.05,
    windowGlow: night * 0.9,
    lampIntensity: smooth(0.15, 0.85, night) * 1.5,
    fogDensity: 0.0017 + night * 0.0007,
  };
}
