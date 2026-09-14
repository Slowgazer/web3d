import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Railway Track Segment
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createRailwayTrackSegmentModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Railway Track Segment";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["earth-clay"] = createSculptMaterial(
    "earth-clay",
    {"id": "earth-clay", "name": "Earth Clay", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#BB9563", "color": "#BB9563", "albedo": {"dominant": "#BB9563", "secondary": ["#C6A879"], "samplingNotes": "reference crop palette"}, "colorVariation": {"palette": ["#BB9563", "#C6A879", "#99805C", "#D9C59A", "#765B3D"], "pattern": "mottled", "amplitude": 0.18, "heightCorrelation": 0.35}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensity": "uniform world-space, 1024px per 2.4 world units"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "pattern": "broad color zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "pattern": "grain / gravel / sleat seams", "role": "surface relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "pattern": "paper grain highlight breakup", "role": "fine grain"}], "roughness": {"base": 0.85, "variation": 0.16, "map": "earth-clay-roughness", "localResponse": "rougher in cavities, slightly lower on worn edges"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.24, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "response": "cavity darkening between gravel, under sleepers, at rail web"}, "wear": {"edgeWear": 0.2, "scratches": ["rail web rust streaks"], "chips": []}, "dirt": {"amount": 0.25, "cavityBias": 0.5, "color": "#5A4A32"}, "localOverrides": [{"id": "clay-vertical-streak", "zone": "embankment face", "albedo": "#8B6B45", "roughness": 0.9, "description": "vertical water-streak staining down the clay face"}, {"id": "clay-base-pebbles", "zone": "embankment base", "albedo": "#C6A879", "description": "scattered loose pebbles and lighter dust at the foot of the slope"}], "qualityTier": "utility"},
    options
  );
  materialMap["ballast-gravel"] = createSculptMaterial(
    "ballast-gravel",
    {"id": "ballast-gravel", "name": "Ballast Gravel", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#766149", "color": "#766149", "albedo": {"dominant": "#766149", "secondary": ["#917E64"], "samplingNotes": "reference crop palette"}, "colorVariation": {"palette": ["#766149", "#917E64", "#B69262", "#4C3C2D", "#C4AC85"], "pattern": "mottled", "amplitude": 0.18, "heightCorrelation": 0.35}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensity": "uniform world-space, 1024px per 2.4 world units"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "pattern": "broad color zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "pattern": "grain / gravel / sleat seams", "role": "surface relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "pattern": "paper grain highlight breakup", "role": "fine grain"}], "roughness": {"base": 0.8, "variation": 0.16, "map": "ballast-gravel-roughness", "localResponse": "rougher in cavities, slightly lower on worn edges"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.3, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "response": "cavity darkening between gravel, under sleepers, at rail web"}, "wear": {"edgeWear": 0.2, "scratches": ["rail web rust streaks"], "chips": []}, "dirt": {"amount": 0.25, "cavityBias": 0.5, "color": "#5A4A32"}, "localOverrides": [{"id": "gravel-mottle", "zone": "ballast top", "albedo": "#9C9484", "description": "mixed grey / tan rounded stone mottling"}], "qualityTier": "utility"},
    options
  );
  materialMap["rail-steel"] = createSculptMaterial(
    "rail-steel",
    {"id": "rail-steel", "name": "Rail Steel", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#503F31", "color": "#503F31", "albedo": {"dominant": "#503F31", "secondary": ["#69533E"], "samplingNotes": "reference crop palette"}, "colorVariation": {"palette": ["#503F31", "#69533E", "#3B2D22", "#806C53", "#9F8B70"], "pattern": "mottled", "amplitude": 0.18, "heightCorrelation": 0.35}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensity": "uniform world-space, 1024px per 2.4 world units"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "pattern": "broad color zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "pattern": "grain / gravel / sleat seams", "role": "surface relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "pattern": "paper grain highlight breakup", "role": "fine grain"}], "roughness": {"base": 0.28, "variation": 0.16, "map": "rail-steel-roughness", "localResponse": "rougher in cavities, slightly lower on worn edges"}, "metalness": {"base": 0.85, "variation": 0.05}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.18, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "response": "cavity darkening between gravel, under sleepers, at rail web"}, "wear": {"edgeWear": 0.2, "scratches": ["rail web rust streaks"], "chips": []}, "dirt": {"amount": 0.25, "cavityBias": 0.5, "color": "#5A4A32"}, "localOverrides": [{"id": "rail-web-rust", "zone": "rail web", "albedo": "#6B4A32", "roughness": 0.72, "description": "dark rusted web below the polished head"}, {"id": "railhead-specular", "zone": "railhead", "albedo": "#C9CFD6", "roughness": 0.18, "description": "bright polished running surface catching the light"}], "qualityTier": "utility"},
    options
  );
  materialMap["sleeper-wood"] = createSculptMaterial(
    "sleeper-wood",
    {"id": "sleeper-wood", "name": "Weathered Sleeper Wood", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#7A654D", "color": "#7A654D", "albedo": {"dominant": "#7A654D", "secondary": ["#5E4A37"], "samplingNotes": "reference crop palette"}, "colorVariation": {"palette": ["#7A654D", "#5E4A37", "#998467", "#3F3226", "#B8A587"], "pattern": "mottled", "amplitude": 0.18, "heightCorrelation": 0.35}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensity": "uniform world-space, 1024px per 2.4 world units"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "pattern": "broad color zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "pattern": "grain / gravel / sleat seams", "role": "surface relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "pattern": "paper grain highlight breakup", "role": "fine grain"}], "roughness": {"base": 0.86, "variation": 0.16, "map": "sleeper-wood-roughness", "localResponse": "rougher in cavities, slightly lower on worn edges"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.34, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "response": "cavity darkening between gravel, under sleepers, at rail web"}, "wear": {"edgeWear": 0.2, "scratches": ["rail web rust streaks"], "chips": []}, "dirt": {"amount": 0.25, "cavityBias": 0.5, "color": "#5A4A32"}, "localOverrides": [{"id": "sleeper-end-crack", "zone": "sleeper end", "albedo": "#3B2A1E", "description": "dark longitudinal crack opening at the tie end"}], "qualityTier": "utility"},
    options
  );
  materialMap["grass-tuft"] = createSculptMaterial(
    "grass-tuft",
    {"id": "grass-tuft", "name": "Dry Grass Tuft", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B99767", "color": "#B99767", "albedo": {"dominant": "#B99767", "secondary": ["#C4AB7D"], "samplingNotes": "reference crop palette"}, "colorVariation": {"palette": ["#B99767", "#C4AB7D", "#9A815A", "#DAC395", "#745D3E"], "pattern": "mottled", "amplitude": 0.18, "heightCorrelation": 0.35}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensity": "uniform world-space, 1024px per 2.4 world units"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "pattern": "broad color zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "pattern": "grain / gravel / sleat seams", "role": "surface relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "pattern": "paper grain highlight breakup", "role": "fine grain"}], "roughness": {"base": 0.9, "variation": 0.16, "map": "grass-tuft-roughness", "localResponse": "rougher in cavities, slightly lower on worn edges"}, "metalness": {"base": 0.0, "variation": 0.05}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.2, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "response": "cavity darkening between gravel, under sleepers, at rail web"}, "wear": {"edgeWear": 0.2, "scratches": ["rail web rust streaks"], "chips": []}, "dirt": {"amount": 0.25, "cavityBias": 0.5, "color": "#5A4A32"}, "localOverrides": [{"id": "grass-yellow-tip", "zone": "tuft tip", "albedo": "#C9B26A", "description": "yellowed dry tips on the grass blades"}], "qualityTier": "utility"},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_track_root_0 = makeAttachmentEndpoint(null);
  const node_track_root_0 = new THREE.Group();
  node_track_root_0.name = "RailwayTrackSegment__pivot";
  node_track_root_0.scale.set(1, 1, 1);
  if (endpoint_track_root_0) {
    node_track_root_0.position.copy(endpoint_track_root_0.start);
    node_track_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_track_root_0.position.set(0.0, 0.0, 0.0);
    node_track_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_track_root_0.userData.sculptComponent = {"id": "track-root", "name": "RailwayTrackSegment", "level": "macro", "role": "static", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Invisible root pivot; real volume lives on children.", "parent": null, "attachment": null, "dimensions": {"width": 0.001, "height": 0.001, "depth": 0.001, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.001, 0.001, 0.001]}, "material": "earth-clay", "materialLayers": ["earth-clay"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(187, 149, 99, 1.0)", "secondaryAlbedo": "rgba(198, 168, 121, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "track-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_track_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "track-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_track_root_0);
  nodes["track-root"] = node_track_root_0;
  const mesh_track_root_0Geometry = endpoint_track_root_0
    ? new THREE.CylinderGeometry(endpoint_track_root_0.endRadius, endpoint_track_root_0.baseRadius, endpoint_track_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_track_root_0) {
    mesh_track_root_0Geometry.scale(0.001, 0.001, 0.001);
  }
  const mesh_track_root_0 = new THREE.Mesh(
    mesh_track_root_0Geometry,
    materialMap["earth-clay"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_track_root_0.name = "RailwayTrackSegment";
  if (endpoint_track_root_0) {
    mesh_track_root_0.position.copy(endpoint_track_root_0.midpoint);
    mesh_track_root_0.quaternion.copy(endpoint_track_root_0.quaternion);
  }
  mesh_track_root_0.castShadow = options.castShadow ?? true;
  mesh_track_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_track_root_0.userData.sculptComponent = {"id": "track-root", "name": "RailwayTrackSegment", "level": "macro", "role": "static", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Invisible root pivot; real volume lives on children.", "parent": null, "attachment": null, "dimensions": {"width": 0.001, "height": 0.001, "depth": 0.001, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.001, 0.001, 0.001]}, "material": "earth-clay", "materialLayers": ["earth-clay"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(187, 149, 99, 1.0)", "secondaryAlbedo": "rgba(198, 168, 121, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "track-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_track_root_0.add(mesh_track_root_0);
  meshes["track-root"] = mesh_track_root_0;
  colliders["track-root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["track-root"] ??= [];
  destructionGroups["track-root"].push(node_track_root_0);

  const endpoint_embankment_1 = makeAttachmentEndpoint(null);
  const node_embankment_1 = new THREE.Group();
  node_embankment_1.name = "Embankment__pivot";
  node_embankment_1.scale.set(1, 1, 1);
  if (endpoint_embankment_1) {
    node_embankment_1.position.copy(endpoint_embankment_1.start);
    node_embankment_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_embankment_1.position.set(0.0, 0.0, -2.0);
    node_embankment_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_embankment_1.userData.sculptComponent = {"id": "embankment", "name": "Embankment", "level": "macro", "role": "main-volume", "importance": 1.0, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Trapezoidal earthwork: 2.4m base, 1.6m top, 0.7m tall, extruded 4m along the track.", "parent": "track-root", "attachment": {"parentId": "track-root", "parentSocket": "track-root-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 0, -2.0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "earth-clay", "materialLayers": ["earth-clay"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(187, 149, 99, 1.0)", "secondaryAlbedo": "rgba(198, 168, 121, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "main-volume", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "embankment", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["clay-vertical-streak", "green-grass-lip"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"profile2D": {"points": [[-1.2, -0.35], [1.2, -0.35], [0.8, 0.35], [-0.8, 0.35]], "depth": 4.0}, "topologyIntent": "extruded trapezoidal prism", "normalStrategy": "flat side faces with procedural height relief"}};
  node_embankment_1.userData.actionProfile = {"animationRole": "main-volume", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "embankment", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["track-root"] ?? root).add(node_embankment_1);
  nodes["embankment"] = node_embankment_1;
  const mesh_embankment_1Geometry = endpoint_embankment_1
    ? new THREE.CylinderGeometry(endpoint_embankment_1.endRadius, endpoint_embankment_1.baseRadius, endpoint_embankment_1.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-1.2, -0.35], [1.2, -0.35], [0.8, 0.35], [-0.8, 0.35]], "depth": 4.0});
  if (!endpoint_embankment_1) {
    mesh_embankment_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_embankment_1 = new THREE.Mesh(
    mesh_embankment_1Geometry,
    materialMap["earth-clay"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_embankment_1.name = "Embankment";
  if (endpoint_embankment_1) {
    mesh_embankment_1.position.copy(endpoint_embankment_1.midpoint);
    mesh_embankment_1.quaternion.copy(endpoint_embankment_1.quaternion);
  }
  mesh_embankment_1.castShadow = options.castShadow ?? true;
  mesh_embankment_1.receiveShadow = options.receiveShadow ?? true;
  mesh_embankment_1.userData.sculptComponent = {"id": "embankment", "name": "Embankment", "level": "macro", "role": "main-volume", "importance": 1.0, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Trapezoidal earthwork: 2.4m base, 1.6m top, 0.7m tall, extruded 4m along the track.", "parent": "track-root", "attachment": {"parentId": "track-root", "parentSocket": "track-root-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 0, -2.0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "earth-clay", "materialLayers": ["earth-clay"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(187, 149, 99, 1.0)", "secondaryAlbedo": "rgba(198, 168, 121, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "main-volume", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "embankment", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["clay-vertical-streak", "green-grass-lip"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"profile2D": {"points": [[-1.2, -0.35], [1.2, -0.35], [0.8, 0.35], [-0.8, 0.35]], "depth": 4.0}, "topologyIntent": "extruded trapezoidal prism", "normalStrategy": "flat side faces with procedural height relief"}};
  node_embankment_1.add(mesh_embankment_1);
  meshes["embankment"] = mesh_embankment_1;
  colliders["embankment"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["embankment"] ??= [];
  destructionGroups["embankment"].push(node_embankment_1);

  const endpoint_ballast_bed_2 = makeAttachmentEndpoint(null);
  const node_ballast_bed_2 = new THREE.Group();
  node_ballast_bed_2.name = "BallastBed__pivot";
  node_ballast_bed_2.scale.set(1, 1, 1);
  if (endpoint_ballast_bed_2) {
    node_ballast_bed_2.position.copy(endpoint_ballast_bed_2.start);
    node_ballast_bed_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ballast_bed_2.position.set(0.0, 0.35, 0.0);
    node_ballast_bed_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_ballast_bed_2.userData.sculptComponent = {"id": "ballast-bed", "name": "BallastBed", "level": "macro", "role": "bedding", "importance": 1.0, "confidence": 0.88, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Rounded gravel ballast strip cradling the sleepers on the embankment top.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0.35, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "bedding", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ballast-bed", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["gravel-mottle"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"profile2D": {"points": [[-0.78, 0.0], [0.78, 0.0], [0.62, 0.13], [-0.62, 0.13]], "depth": 4.0}, "topologyIntent": "extruded gravel shoulder"}};
  node_ballast_bed_2.userData.actionProfile = {"animationRole": "bedding", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ballast-bed", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_ballast_bed_2);
  nodes["ballast-bed"] = node_ballast_bed_2;
  const mesh_ballast_bed_2Geometry = endpoint_ballast_bed_2
    ? new THREE.CylinderGeometry(endpoint_ballast_bed_2.endRadius, endpoint_ballast_bed_2.baseRadius, endpoint_ballast_bed_2.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.78, 0.0], [0.78, 0.0], [0.62, 0.13], [-0.62, 0.13]], "depth": 4.0});
  if (!endpoint_ballast_bed_2) {
    mesh_ballast_bed_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ballast_bed_2 = new THREE.Mesh(
    mesh_ballast_bed_2Geometry,
    materialMap["ballast-gravel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ballast_bed_2.name = "BallastBed";
  if (endpoint_ballast_bed_2) {
    mesh_ballast_bed_2.position.copy(endpoint_ballast_bed_2.midpoint);
    mesh_ballast_bed_2.quaternion.copy(endpoint_ballast_bed_2.quaternion);
  }
  mesh_ballast_bed_2.castShadow = options.castShadow ?? true;
  mesh_ballast_bed_2.receiveShadow = options.receiveShadow ?? true;
  mesh_ballast_bed_2.userData.sculptComponent = {"id": "ballast-bed", "name": "BallastBed", "level": "macro", "role": "bedding", "importance": 1.0, "confidence": 0.88, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Rounded gravel ballast strip cradling the sleepers on the embankment top.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0.35, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "bedding", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ballast-bed", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["gravel-mottle"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"profile2D": {"points": [[-0.78, 0.0], [0.78, 0.0], [0.62, 0.13], [-0.62, 0.13]], "depth": 4.0}, "topologyIntent": "extruded gravel shoulder"}};
  node_ballast_bed_2.add(mesh_ballast_bed_2);
  meshes["ballast-bed"] = mesh_ballast_bed_2;
  colliders["ballast-bed"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["ballast-bed"] ??= [];
  destructionGroups["ballast-bed"].push(node_ballast_bed_2);

  const endpoint_rail_left_3 = makeAttachmentEndpoint(null);
  const node_rail_left_3 = new THREE.Group();
  node_rail_left_3.name = "RailLeft__pivot";
  node_rail_left_3.scale.set(1, 1, 1);
  if (endpoint_rail_left_3) {
    node_rail_left_3.position.copy(endpoint_rail_left_3.start);
    node_rail_left_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rail_left_3.position.set(-0.42, 0.19, 2.0);
    node_rail_left_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_rail_left_3.userData.sculptComponent = {"id": "rail-left", "name": "RailLeft", "level": "macro", "role": "rail", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Parallel steel rail, rectangular section.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.12, "depth": 4.0, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.42, 0.19, 2.0], "rotation": [0, 0, 0], "scale": [0.09, 0.12, 4.0]}, "material": "rail-steel", "materialLayers": ["rail-steel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(80, 63, 49, 1.0)", "secondaryAlbedo": "rgba(105, 83, 62, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["railhead-specular"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rail_left_3.userData.actionProfile = {"animationRole": "rail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_rail_left_3);
  nodes["rail-left"] = node_rail_left_3;
  const mesh_rail_left_3Geometry = endpoint_rail_left_3
    ? new THREE.CylinderGeometry(endpoint_rail_left_3.endRadius, endpoint_rail_left_3.baseRadius, endpoint_rail_left_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_rail_left_3) {
    mesh_rail_left_3Geometry.scale(0.09, 0.12, 4.0);
  }
  const mesh_rail_left_3 = new THREE.Mesh(
    mesh_rail_left_3Geometry,
    materialMap["rail-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rail_left_3.name = "RailLeft";
  if (endpoint_rail_left_3) {
    mesh_rail_left_3.position.copy(endpoint_rail_left_3.midpoint);
    mesh_rail_left_3.quaternion.copy(endpoint_rail_left_3.quaternion);
  }
  mesh_rail_left_3.castShadow = options.castShadow ?? true;
  mesh_rail_left_3.receiveShadow = options.receiveShadow ?? true;
  mesh_rail_left_3.userData.sculptComponent = {"id": "rail-left", "name": "RailLeft", "level": "macro", "role": "rail", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Parallel steel rail, rectangular section.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.12, "depth": 4.0, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.42, 0.19, 2.0], "rotation": [0, 0, 0], "scale": [0.09, 0.12, 4.0]}, "material": "rail-steel", "materialLayers": ["rail-steel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(80, 63, 49, 1.0)", "secondaryAlbedo": "rgba(105, 83, 62, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["railhead-specular"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rail_left_3.add(mesh_rail_left_3);
  meshes["rail-left"] = mesh_rail_left_3;
  colliders["rail-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rail-left"] ??= [];
  destructionGroups["rail-left"].push(node_rail_left_3);

  const endpoint_rail_right_4 = makeAttachmentEndpoint(null);
  const node_rail_right_4 = new THREE.Group();
  node_rail_right_4.name = "RailRight__pivot";
  node_rail_right_4.scale.set(1, 1, 1);
  if (endpoint_rail_right_4) {
    node_rail_right_4.position.copy(endpoint_rail_right_4.start);
    node_rail_right_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rail_right_4.position.set(0.42, 0.19, 2.0);
    node_rail_right_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_rail_right_4.userData.sculptComponent = {"id": "rail-right", "name": "RailRight", "level": "macro", "role": "rail", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Mirror of rail-left across the track centerline.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.12, "depth": 4.0, "units": "world", "confidence": 0.85}, "transform": {"position": [0.42, 0.19, 2.0], "rotation": [0, 0, 0], "scale": [0.09, 0.12, 4.0]}, "material": "rail-steel", "materialLayers": ["rail-steel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(80, 63, 49, 1.0)", "secondaryAlbedo": "rgba(105, 83, 62, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["railhead-specular"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rail_right_4.userData.actionProfile = {"animationRole": "rail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_rail_right_4);
  nodes["rail-right"] = node_rail_right_4;
  const mesh_rail_right_4Geometry = endpoint_rail_right_4
    ? new THREE.CylinderGeometry(endpoint_rail_right_4.endRadius, endpoint_rail_right_4.baseRadius, endpoint_rail_right_4.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_rail_right_4) {
    mesh_rail_right_4Geometry.scale(0.09, 0.12, 4.0);
  }
  const mesh_rail_right_4 = new THREE.Mesh(
    mesh_rail_right_4Geometry,
    materialMap["rail-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rail_right_4.name = "RailRight";
  if (endpoint_rail_right_4) {
    mesh_rail_right_4.position.copy(endpoint_rail_right_4.midpoint);
    mesh_rail_right_4.quaternion.copy(endpoint_rail_right_4.quaternion);
  }
  mesh_rail_right_4.castShadow = options.castShadow ?? true;
  mesh_rail_right_4.receiveShadow = options.receiveShadow ?? true;
  mesh_rail_right_4.userData.sculptComponent = {"id": "rail-right", "name": "RailRight", "level": "macro", "role": "rail", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Mirror of rail-left across the track centerline.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.12, "depth": 4.0, "units": "world", "confidence": 0.85}, "transform": {"position": [0.42, 0.19, 2.0], "rotation": [0, 0, 0], "scale": [0.09, 0.12, 4.0]}, "material": "rail-steel", "materialLayers": ["rail-steel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(80, 63, 49, 1.0)", "secondaryAlbedo": "rgba(105, 83, 62, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rail", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["railhead-specular"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rail_right_4.add(mesh_rail_right_4);
  meshes["rail-right"] = mesh_rail_right_4;
  colliders["rail-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rail-right"] ??= [];
  destructionGroups["rail-right"].push(node_rail_right_4);

  const endpoint_railhead_left_5 = makeAttachmentEndpoint(null);
  const node_railhead_left_5 = new THREE.Group();
  node_railhead_left_5.name = "RailHeadLeft__pivot";
  node_railhead_left_5.scale.set(1, 1, 1);
  if (endpoint_railhead_left_5) {
    node_railhead_left_5.position.copy(endpoint_railhead_left_5.start);
    node_railhead_left_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_railhead_left_5.position.set(0.0, 0.06, 0.0);
    node_railhead_left_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_railhead_left_5.userData.sculptComponent = {"id": "railhead-left", "name": "RailHeadLeft", "level": "meso", "role": "railhead", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Bright polished running surface on top of the rail.", "parent": "rail-left", "attachment": {"parentId": "rail-left", "parentSocket": "rail-left-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.02, "depth": 4.0, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.06, 0.0], "rotation": [0, 0, 0], "scale": [0.1, 0.02, 4.0]}, "material": "rail-steel", "materialLayers": ["rail-steel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(80, 63, 49, 1.0)", "secondaryAlbedo": "rgba(105, 83, 62, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "railhead", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "railhead-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_railhead_left_5.userData.actionProfile = {"animationRole": "railhead", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "railhead-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rail-left"] ?? root).add(node_railhead_left_5);
  nodes["railhead-left"] = node_railhead_left_5;
  const mesh_railhead_left_5Geometry = endpoint_railhead_left_5
    ? new THREE.CylinderGeometry(endpoint_railhead_left_5.endRadius, endpoint_railhead_left_5.baseRadius, endpoint_railhead_left_5.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_railhead_left_5) {
    mesh_railhead_left_5Geometry.scale(0.1, 0.02, 4.0);
  }
  const mesh_railhead_left_5 = new THREE.Mesh(
    mesh_railhead_left_5Geometry,
    materialMap["rail-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_railhead_left_5.name = "RailHeadLeft";
  if (endpoint_railhead_left_5) {
    mesh_railhead_left_5.position.copy(endpoint_railhead_left_5.midpoint);
    mesh_railhead_left_5.quaternion.copy(endpoint_railhead_left_5.quaternion);
  }
  mesh_railhead_left_5.castShadow = options.castShadow ?? true;
  mesh_railhead_left_5.receiveShadow = options.receiveShadow ?? true;
  mesh_railhead_left_5.userData.sculptComponent = {"id": "railhead-left", "name": "RailHeadLeft", "level": "meso", "role": "railhead", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Bright polished running surface on top of the rail.", "parent": "rail-left", "attachment": {"parentId": "rail-left", "parentSocket": "rail-left-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.02, "depth": 4.0, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.06, 0.0], "rotation": [0, 0, 0], "scale": [0.1, 0.02, 4.0]}, "material": "rail-steel", "materialLayers": ["rail-steel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(80, 63, 49, 1.0)", "secondaryAlbedo": "rgba(105, 83, 62, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "railhead", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "railhead-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_railhead_left_5.add(mesh_railhead_left_5);
  meshes["railhead-left"] = mesh_railhead_left_5;
  colliders["railhead-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["railhead-left"] ??= [];
  destructionGroups["railhead-left"].push(node_railhead_left_5);

  const endpoint_railhead_right_6 = makeAttachmentEndpoint(null);
  const node_railhead_right_6 = new THREE.Group();
  node_railhead_right_6.name = "RailHeadRight__pivot";
  node_railhead_right_6.scale.set(1, 1, 1);
  if (endpoint_railhead_right_6) {
    node_railhead_right_6.position.copy(endpoint_railhead_right_6.start);
    node_railhead_right_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_railhead_right_6.position.set(0.0, 0.06, 0.0);
    node_railhead_right_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_railhead_right_6.userData.sculptComponent = {"id": "railhead-right", "name": "RailHeadRight", "level": "meso", "role": "railhead", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Bright polished running surface, mirror side.", "parent": "rail-right", "attachment": {"parentId": "rail-right", "parentSocket": "rail-right-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.02, "depth": 4.0, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.06, 0.0], "rotation": [0, 0, 0], "scale": [0.1, 0.02, 4.0]}, "material": "rail-steel", "materialLayers": ["rail-steel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(80, 63, 49, 1.0)", "secondaryAlbedo": "rgba(105, 83, 62, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "railhead", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "railhead-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_railhead_right_6.userData.actionProfile = {"animationRole": "railhead", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "railhead-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rail-right"] ?? root).add(node_railhead_right_6);
  nodes["railhead-right"] = node_railhead_right_6;
  const mesh_railhead_right_6Geometry = endpoint_railhead_right_6
    ? new THREE.CylinderGeometry(endpoint_railhead_right_6.endRadius, endpoint_railhead_right_6.baseRadius, endpoint_railhead_right_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_railhead_right_6) {
    mesh_railhead_right_6Geometry.scale(0.1, 0.02, 4.0);
  }
  const mesh_railhead_right_6 = new THREE.Mesh(
    mesh_railhead_right_6Geometry,
    materialMap["rail-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_railhead_right_6.name = "RailHeadRight";
  if (endpoint_railhead_right_6) {
    mesh_railhead_right_6.position.copy(endpoint_railhead_right_6.midpoint);
    mesh_railhead_right_6.quaternion.copy(endpoint_railhead_right_6.quaternion);
  }
  mesh_railhead_right_6.castShadow = options.castShadow ?? true;
  mesh_railhead_right_6.receiveShadow = options.receiveShadow ?? true;
  mesh_railhead_right_6.userData.sculptComponent = {"id": "railhead-right", "name": "RailHeadRight", "level": "meso", "role": "railhead", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Bright polished running surface, mirror side.", "parent": "rail-right", "attachment": {"parentId": "rail-right", "parentSocket": "rail-right-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.02, "depth": 4.0, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.06, 0.0], "rotation": [0, 0, 0], "scale": [0.1, 0.02, 4.0]}, "material": "rail-steel", "materialLayers": ["rail-steel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(80, 63, 49, 1.0)", "secondaryAlbedo": "rgba(105, 83, 62, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "railhead", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "railhead-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_railhead_right_6.add(mesh_railhead_right_6);
  meshes["railhead-right"] = mesh_railhead_right_6;
  colliders["railhead-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["railhead-right"] ??= [];
  destructionGroups["railhead-right"].push(node_railhead_right_6);

  const endpoint_sleeper_01_7 = makeAttachmentEndpoint(null);
  const node_sleeper_01_7 = new THREE.Group();
  node_sleeper_01_7.name = "Sleeper01__pivot";
  node_sleeper_01_7.scale.set(1, 1, 1);
  if (endpoint_sleeper_01_7) {
    node_sleeper_01_7.position.copy(endpoint_sleeper_01_7.start);
    node_sleeper_01_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeper_01_7.position.set(0.0, 0.175, 0.225);
    node_sleeper_01_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeper_01_7.userData.sculptComponent = {"id": "sleeper-01", "name": "Sleeper01", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 0.225], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["sleeper-end-crack"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_01_7.userData.actionProfile = {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_sleeper_01_7);
  nodes["sleeper-01"] = node_sleeper_01_7;
  const mesh_sleeper_01_7Geometry = endpoint_sleeper_01_7
    ? new THREE.CylinderGeometry(endpoint_sleeper_01_7.endRadius, endpoint_sleeper_01_7.baseRadius, endpoint_sleeper_01_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sleeper_01_7) {
    mesh_sleeper_01_7Geometry.scale(1.45, 0.09, 0.24);
  }
  const mesh_sleeper_01_7 = new THREE.Mesh(
    mesh_sleeper_01_7Geometry,
    materialMap["sleeper-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sleeper_01_7.name = "Sleeper01";
  if (endpoint_sleeper_01_7) {
    mesh_sleeper_01_7.position.copy(endpoint_sleeper_01_7.midpoint);
    mesh_sleeper_01_7.quaternion.copy(endpoint_sleeper_01_7.quaternion);
  }
  mesh_sleeper_01_7.castShadow = options.castShadow ?? true;
  mesh_sleeper_01_7.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeper_01_7.userData.sculptComponent = {"id": "sleeper-01", "name": "Sleeper01", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 0.225], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["sleeper-end-crack"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_01_7.add(mesh_sleeper_01_7);
  meshes["sleeper-01"] = mesh_sleeper_01_7;
  colliders["sleeper-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sleeper-01"] ??= [];
  destructionGroups["sleeper-01"].push(node_sleeper_01_7);

  const endpoint_sleeper_02_8 = makeAttachmentEndpoint(null);
  const node_sleeper_02_8 = new THREE.Group();
  node_sleeper_02_8.name = "Sleeper02__pivot";
  node_sleeper_02_8.scale.set(1, 1, 1);
  if (endpoint_sleeper_02_8) {
    node_sleeper_02_8.position.copy(endpoint_sleeper_02_8.start);
    node_sleeper_02_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeper_02_8.position.set(0.0, 0.175, 0.675);
    node_sleeper_02_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeper_02_8.userData.sculptComponent = {"id": "sleeper-02", "name": "Sleeper02", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 0.675], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_02_8.userData.actionProfile = {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_sleeper_02_8);
  nodes["sleeper-02"] = node_sleeper_02_8;
  const mesh_sleeper_02_8Geometry = endpoint_sleeper_02_8
    ? new THREE.CylinderGeometry(endpoint_sleeper_02_8.endRadius, endpoint_sleeper_02_8.baseRadius, endpoint_sleeper_02_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sleeper_02_8) {
    mesh_sleeper_02_8Geometry.scale(1.45, 0.09, 0.24);
  }
  const mesh_sleeper_02_8 = new THREE.Mesh(
    mesh_sleeper_02_8Geometry,
    materialMap["sleeper-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sleeper_02_8.name = "Sleeper02";
  if (endpoint_sleeper_02_8) {
    mesh_sleeper_02_8.position.copy(endpoint_sleeper_02_8.midpoint);
    mesh_sleeper_02_8.quaternion.copy(endpoint_sleeper_02_8.quaternion);
  }
  mesh_sleeper_02_8.castShadow = options.castShadow ?? true;
  mesh_sleeper_02_8.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeper_02_8.userData.sculptComponent = {"id": "sleeper-02", "name": "Sleeper02", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 0.675], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_02_8.add(mesh_sleeper_02_8);
  meshes["sleeper-02"] = mesh_sleeper_02_8;
  colliders["sleeper-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sleeper-02"] ??= [];
  destructionGroups["sleeper-02"].push(node_sleeper_02_8);

  const endpoint_sleeper_03_9 = makeAttachmentEndpoint(null);
  const node_sleeper_03_9 = new THREE.Group();
  node_sleeper_03_9.name = "Sleeper03__pivot";
  node_sleeper_03_9.scale.set(1, 1, 1);
  if (endpoint_sleeper_03_9) {
    node_sleeper_03_9.position.copy(endpoint_sleeper_03_9.start);
    node_sleeper_03_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeper_03_9.position.set(0.0, 0.175, 1.125);
    node_sleeper_03_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeper_03_9.userData.sculptComponent = {"id": "sleeper-03", "name": "Sleeper03", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 1.125], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_03_9.userData.actionProfile = {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_sleeper_03_9);
  nodes["sleeper-03"] = node_sleeper_03_9;
  const mesh_sleeper_03_9Geometry = endpoint_sleeper_03_9
    ? new THREE.CylinderGeometry(endpoint_sleeper_03_9.endRadius, endpoint_sleeper_03_9.baseRadius, endpoint_sleeper_03_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sleeper_03_9) {
    mesh_sleeper_03_9Geometry.scale(1.45, 0.09, 0.24);
  }
  const mesh_sleeper_03_9 = new THREE.Mesh(
    mesh_sleeper_03_9Geometry,
    materialMap["sleeper-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sleeper_03_9.name = "Sleeper03";
  if (endpoint_sleeper_03_9) {
    mesh_sleeper_03_9.position.copy(endpoint_sleeper_03_9.midpoint);
    mesh_sleeper_03_9.quaternion.copy(endpoint_sleeper_03_9.quaternion);
  }
  mesh_sleeper_03_9.castShadow = options.castShadow ?? true;
  mesh_sleeper_03_9.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeper_03_9.userData.sculptComponent = {"id": "sleeper-03", "name": "Sleeper03", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 1.125], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_03_9.add(mesh_sleeper_03_9);
  meshes["sleeper-03"] = mesh_sleeper_03_9;
  colliders["sleeper-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sleeper-03"] ??= [];
  destructionGroups["sleeper-03"].push(node_sleeper_03_9);

  const endpoint_sleeper_04_10 = makeAttachmentEndpoint(null);
  const node_sleeper_04_10 = new THREE.Group();
  node_sleeper_04_10.name = "Sleeper04__pivot";
  node_sleeper_04_10.scale.set(1, 1, 1);
  if (endpoint_sleeper_04_10) {
    node_sleeper_04_10.position.copy(endpoint_sleeper_04_10.start);
    node_sleeper_04_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeper_04_10.position.set(0.0, 0.175, 1.575);
    node_sleeper_04_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeper_04_10.userData.sculptComponent = {"id": "sleeper-04", "name": "Sleeper04", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 1.575], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_04_10.userData.actionProfile = {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_sleeper_04_10);
  nodes["sleeper-04"] = node_sleeper_04_10;
  const mesh_sleeper_04_10Geometry = endpoint_sleeper_04_10
    ? new THREE.CylinderGeometry(endpoint_sleeper_04_10.endRadius, endpoint_sleeper_04_10.baseRadius, endpoint_sleeper_04_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sleeper_04_10) {
    mesh_sleeper_04_10Geometry.scale(1.45, 0.09, 0.24);
  }
  const mesh_sleeper_04_10 = new THREE.Mesh(
    mesh_sleeper_04_10Geometry,
    materialMap["sleeper-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sleeper_04_10.name = "Sleeper04";
  if (endpoint_sleeper_04_10) {
    mesh_sleeper_04_10.position.copy(endpoint_sleeper_04_10.midpoint);
    mesh_sleeper_04_10.quaternion.copy(endpoint_sleeper_04_10.quaternion);
  }
  mesh_sleeper_04_10.castShadow = options.castShadow ?? true;
  mesh_sleeper_04_10.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeper_04_10.userData.sculptComponent = {"id": "sleeper-04", "name": "Sleeper04", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 1.575], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_04_10.add(mesh_sleeper_04_10);
  meshes["sleeper-04"] = mesh_sleeper_04_10;
  colliders["sleeper-04"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sleeper-04"] ??= [];
  destructionGroups["sleeper-04"].push(node_sleeper_04_10);

  const endpoint_sleeper_05_11 = makeAttachmentEndpoint(null);
  const node_sleeper_05_11 = new THREE.Group();
  node_sleeper_05_11.name = "Sleeper05__pivot";
  node_sleeper_05_11.scale.set(1, 1, 1);
  if (endpoint_sleeper_05_11) {
    node_sleeper_05_11.position.copy(endpoint_sleeper_05_11.start);
    node_sleeper_05_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeper_05_11.position.set(0.0, 0.175, 2.025);
    node_sleeper_05_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeper_05_11.userData.sculptComponent = {"id": "sleeper-05", "name": "Sleeper05", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 2.025], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_05_11.userData.actionProfile = {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_sleeper_05_11);
  nodes["sleeper-05"] = node_sleeper_05_11;
  const mesh_sleeper_05_11Geometry = endpoint_sleeper_05_11
    ? new THREE.CylinderGeometry(endpoint_sleeper_05_11.endRadius, endpoint_sleeper_05_11.baseRadius, endpoint_sleeper_05_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sleeper_05_11) {
    mesh_sleeper_05_11Geometry.scale(1.45, 0.09, 0.24);
  }
  const mesh_sleeper_05_11 = new THREE.Mesh(
    mesh_sleeper_05_11Geometry,
    materialMap["sleeper-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sleeper_05_11.name = "Sleeper05";
  if (endpoint_sleeper_05_11) {
    mesh_sleeper_05_11.position.copy(endpoint_sleeper_05_11.midpoint);
    mesh_sleeper_05_11.quaternion.copy(endpoint_sleeper_05_11.quaternion);
  }
  mesh_sleeper_05_11.castShadow = options.castShadow ?? true;
  mesh_sleeper_05_11.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeper_05_11.userData.sculptComponent = {"id": "sleeper-05", "name": "Sleeper05", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 2.025], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_05_11.add(mesh_sleeper_05_11);
  meshes["sleeper-05"] = mesh_sleeper_05_11;
  colliders["sleeper-05"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sleeper-05"] ??= [];
  destructionGroups["sleeper-05"].push(node_sleeper_05_11);

  const endpoint_sleeper_06_12 = makeAttachmentEndpoint(null);
  const node_sleeper_06_12 = new THREE.Group();
  node_sleeper_06_12.name = "Sleeper06__pivot";
  node_sleeper_06_12.scale.set(1, 1, 1);
  if (endpoint_sleeper_06_12) {
    node_sleeper_06_12.position.copy(endpoint_sleeper_06_12.start);
    node_sleeper_06_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeper_06_12.position.set(0.0, 0.175, 2.475);
    node_sleeper_06_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeper_06_12.userData.sculptComponent = {"id": "sleeper-06", "name": "Sleeper06", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 2.475], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_06_12.userData.actionProfile = {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_sleeper_06_12);
  nodes["sleeper-06"] = node_sleeper_06_12;
  const mesh_sleeper_06_12Geometry = endpoint_sleeper_06_12
    ? new THREE.CylinderGeometry(endpoint_sleeper_06_12.endRadius, endpoint_sleeper_06_12.baseRadius, endpoint_sleeper_06_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sleeper_06_12) {
    mesh_sleeper_06_12Geometry.scale(1.45, 0.09, 0.24);
  }
  const mesh_sleeper_06_12 = new THREE.Mesh(
    mesh_sleeper_06_12Geometry,
    materialMap["sleeper-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sleeper_06_12.name = "Sleeper06";
  if (endpoint_sleeper_06_12) {
    mesh_sleeper_06_12.position.copy(endpoint_sleeper_06_12.midpoint);
    mesh_sleeper_06_12.quaternion.copy(endpoint_sleeper_06_12.quaternion);
  }
  mesh_sleeper_06_12.castShadow = options.castShadow ?? true;
  mesh_sleeper_06_12.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeper_06_12.userData.sculptComponent = {"id": "sleeper-06", "name": "Sleeper06", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 2.475], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_06_12.add(mesh_sleeper_06_12);
  meshes["sleeper-06"] = mesh_sleeper_06_12;
  colliders["sleeper-06"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sleeper-06"] ??= [];
  destructionGroups["sleeper-06"].push(node_sleeper_06_12);

  const endpoint_sleeper_07_13 = makeAttachmentEndpoint(null);
  const node_sleeper_07_13 = new THREE.Group();
  node_sleeper_07_13.name = "Sleeper07__pivot";
  node_sleeper_07_13.scale.set(1, 1, 1);
  if (endpoint_sleeper_07_13) {
    node_sleeper_07_13.position.copy(endpoint_sleeper_07_13.start);
    node_sleeper_07_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeper_07_13.position.set(0.0, 0.175, 2.925);
    node_sleeper_07_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeper_07_13.userData.sculptComponent = {"id": "sleeper-07", "name": "Sleeper07", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 2.925], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_07_13.userData.actionProfile = {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_sleeper_07_13);
  nodes["sleeper-07"] = node_sleeper_07_13;
  const mesh_sleeper_07_13Geometry = endpoint_sleeper_07_13
    ? new THREE.CylinderGeometry(endpoint_sleeper_07_13.endRadius, endpoint_sleeper_07_13.baseRadius, endpoint_sleeper_07_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sleeper_07_13) {
    mesh_sleeper_07_13Geometry.scale(1.45, 0.09, 0.24);
  }
  const mesh_sleeper_07_13 = new THREE.Mesh(
    mesh_sleeper_07_13Geometry,
    materialMap["sleeper-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sleeper_07_13.name = "Sleeper07";
  if (endpoint_sleeper_07_13) {
    mesh_sleeper_07_13.position.copy(endpoint_sleeper_07_13.midpoint);
    mesh_sleeper_07_13.quaternion.copy(endpoint_sleeper_07_13.quaternion);
  }
  mesh_sleeper_07_13.castShadow = options.castShadow ?? true;
  mesh_sleeper_07_13.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeper_07_13.userData.sculptComponent = {"id": "sleeper-07", "name": "Sleeper07", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 2.925], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_07_13.add(mesh_sleeper_07_13);
  meshes["sleeper-07"] = mesh_sleeper_07_13;
  colliders["sleeper-07"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sleeper-07"] ??= [];
  destructionGroups["sleeper-07"].push(node_sleeper_07_13);

  const endpoint_sleeper_08_14 = makeAttachmentEndpoint(null);
  const node_sleeper_08_14 = new THREE.Group();
  node_sleeper_08_14.name = "Sleeper08__pivot";
  node_sleeper_08_14.scale.set(1, 1, 1);
  if (endpoint_sleeper_08_14) {
    node_sleeper_08_14.position.copy(endpoint_sleeper_08_14.start);
    node_sleeper_08_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeper_08_14.position.set(0.0, 0.175, 3.375);
    node_sleeper_08_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeper_08_14.userData.sculptComponent = {"id": "sleeper-08", "name": "Sleeper08", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 3.375], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_08_14.userData.actionProfile = {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_sleeper_08_14);
  nodes["sleeper-08"] = node_sleeper_08_14;
  const mesh_sleeper_08_14Geometry = endpoint_sleeper_08_14
    ? new THREE.CylinderGeometry(endpoint_sleeper_08_14.endRadius, endpoint_sleeper_08_14.baseRadius, endpoint_sleeper_08_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sleeper_08_14) {
    mesh_sleeper_08_14Geometry.scale(1.45, 0.09, 0.24);
  }
  const mesh_sleeper_08_14 = new THREE.Mesh(
    mesh_sleeper_08_14Geometry,
    materialMap["sleeper-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sleeper_08_14.name = "Sleeper08";
  if (endpoint_sleeper_08_14) {
    mesh_sleeper_08_14.position.copy(endpoint_sleeper_08_14.midpoint);
    mesh_sleeper_08_14.quaternion.copy(endpoint_sleeper_08_14.quaternion);
  }
  mesh_sleeper_08_14.castShadow = options.castShadow ?? true;
  mesh_sleeper_08_14.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeper_08_14.userData.sculptComponent = {"id": "sleeper-08", "name": "Sleeper08", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 3.375], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_08_14.add(mesh_sleeper_08_14);
  meshes["sleeper-08"] = mesh_sleeper_08_14;
  colliders["sleeper-08"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sleeper-08"] ??= [];
  destructionGroups["sleeper-08"].push(node_sleeper_08_14);

  const endpoint_sleeper_09_15 = makeAttachmentEndpoint(null);
  const node_sleeper_09_15 = new THREE.Group();
  node_sleeper_09_15.name = "Sleeper09__pivot";
  node_sleeper_09_15.scale.set(1, 1, 1);
  if (endpoint_sleeper_09_15) {
    node_sleeper_09_15.position.copy(endpoint_sleeper_09_15.start);
    node_sleeper_09_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeper_09_15.position.set(0.0, 0.175, 3.825);
    node_sleeper_09_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeper_09_15.userData.sculptComponent = {"id": "sleeper-09", "name": "Sleeper09", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 3.825], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-09", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_09_15.userData.actionProfile = {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-09", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_sleeper_09_15);
  nodes["sleeper-09"] = node_sleeper_09_15;
  const mesh_sleeper_09_15Geometry = endpoint_sleeper_09_15
    ? new THREE.CylinderGeometry(endpoint_sleeper_09_15.endRadius, endpoint_sleeper_09_15.baseRadius, endpoint_sleeper_09_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sleeper_09_15) {
    mesh_sleeper_09_15Geometry.scale(1.45, 0.09, 0.24);
  }
  const mesh_sleeper_09_15 = new THREE.Mesh(
    mesh_sleeper_09_15Geometry,
    materialMap["sleeper-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sleeper_09_15.name = "Sleeper09";
  if (endpoint_sleeper_09_15) {
    mesh_sleeper_09_15.position.copy(endpoint_sleeper_09_15.midpoint);
    mesh_sleeper_09_15.quaternion.copy(endpoint_sleeper_09_15.quaternion);
  }
  mesh_sleeper_09_15.castShadow = options.castShadow ?? true;
  mesh_sleeper_09_15.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeper_09_15.userData.sculptComponent = {"id": "sleeper-09", "name": "Sleeper09", "level": "meso", "role": "sleeper", "importance": 0.7, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Weathered wooden tie laid perpendicular to the rails; repeated every 0.45m.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.45, "height": 0.09, "depth": 0.24, "units": "world", "confidence": 0.82}, "transform": {"position": [0, 0.175, 3.825], "rotation": [0, 0, 0], "scale": [1.45, 0.09, 0.24]}, "material": "sleeper-wood", "materialLayers": ["sleeper-wood"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 101, 77, 1.0)", "secondaryAlbedo": "rgba(94, 74, 55, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.82, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "sleeper", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sleeper-09", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_sleeper_09_15.add(mesh_sleeper_09_15);
  meshes["sleeper-09"] = mesh_sleeper_09_15;
  colliders["sleeper-09"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sleeper-09"] ??= [];
  destructionGroups["sleeper-09"].push(node_sleeper_09_15);

  const attachment_grass_tuft_01_16 = {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_grass_tuft_01_16 = makeAttachmentEndpoint(attachment_grass_tuft_01_16);
  const node_grass_tuft_01_16 = new THREE.Group();
  node_grass_tuft_01_16.name = "GrassTuft01__pivot";
  node_grass_tuft_01_16.scale.set(1, 1, 1);
  if (endpoint_grass_tuft_01_16) {
    node_grass_tuft_01_16.position.copy(endpoint_grass_tuft_01_16.start);
    node_grass_tuft_01_16.rotation.set(0.0, 0.0, -0.3);
  } else {
    node_grass_tuft_01_16.position.set(1.02, 0.11500000000000002, 0.8);
    node_grass_tuft_01_16.rotation.set(0.0, 0.0, -0.3);
  }
  node_grass_tuft_01_16.userData.sculptComponent = {"id": "grass-tuft-01", "name": "GrassTuft01", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [1.02, 0.11500000000000002, 0.8], "rotation": [0, 0, -0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["grass-yellow-tip"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_01_16.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_grass_tuft_01_16);
  nodes["grass-tuft-01"] = node_grass_tuft_01_16;
  const mesh_grass_tuft_01_16Geometry = endpoint_grass_tuft_01_16
    ? new THREE.CylinderGeometry(endpoint_grass_tuft_01_16.endRadius, endpoint_grass_tuft_01_16.baseRadius, endpoint_grass_tuft_01_16.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_grass_tuft_01_16) {
    mesh_grass_tuft_01_16Geometry.scale(0.15, 0.5, 0.15);
  }
  const mesh_grass_tuft_01_16 = new THREE.Mesh(
    mesh_grass_tuft_01_16Geometry,
    materialMap["grass-tuft"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grass_tuft_01_16.name = "GrassTuft01";
  if (endpoint_grass_tuft_01_16) {
    mesh_grass_tuft_01_16.position.copy(endpoint_grass_tuft_01_16.midpoint);
    mesh_grass_tuft_01_16.quaternion.copy(endpoint_grass_tuft_01_16.quaternion);
  }
  mesh_grass_tuft_01_16.castShadow = options.castShadow ?? true;
  mesh_grass_tuft_01_16.receiveShadow = options.receiveShadow ?? true;
  mesh_grass_tuft_01_16.userData.sculptComponent = {"id": "grass-tuft-01", "name": "GrassTuft01", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [1.02, 0.11500000000000002, 0.8], "rotation": [0, 0, -0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["grass-yellow-tip"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_01_16.add(mesh_grass_tuft_01_16);
  meshes["grass-tuft-01"] = mesh_grass_tuft_01_16;
  colliders["grass-tuft-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["grass-tuft-01"] ??= [];
  destructionGroups["grass-tuft-01"].push(node_grass_tuft_01_16);

  const attachment_grass_tuft_02_17 = {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_grass_tuft_02_17 = makeAttachmentEndpoint(attachment_grass_tuft_02_17);
  const node_grass_tuft_02_17 = new THREE.Group();
  node_grass_tuft_02_17.name = "GrassTuft02__pivot";
  node_grass_tuft_02_17.scale.set(1, 1, 1);
  if (endpoint_grass_tuft_02_17) {
    node_grass_tuft_02_17.position.copy(endpoint_grass_tuft_02_17.start);
    node_grass_tuft_02_17.rotation.set(0.0, 0.0, 0.3);
  } else {
    node_grass_tuft_02_17.position.set(-1.02, 0.11500000000000002, 1.5);
    node_grass_tuft_02_17.rotation.set(0.0, 0.0, 0.3);
  }
  node_grass_tuft_02_17.userData.sculptComponent = {"id": "grass-tuft-02", "name": "GrassTuft02", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [-1.02, 0.11500000000000002, 1.5], "rotation": [0, 0, 0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_02_17.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_grass_tuft_02_17);
  nodes["grass-tuft-02"] = node_grass_tuft_02_17;
  const mesh_grass_tuft_02_17Geometry = endpoint_grass_tuft_02_17
    ? new THREE.CylinderGeometry(endpoint_grass_tuft_02_17.endRadius, endpoint_grass_tuft_02_17.baseRadius, endpoint_grass_tuft_02_17.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_grass_tuft_02_17) {
    mesh_grass_tuft_02_17Geometry.scale(0.15, 0.5, 0.15);
  }
  const mesh_grass_tuft_02_17 = new THREE.Mesh(
    mesh_grass_tuft_02_17Geometry,
    materialMap["grass-tuft"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grass_tuft_02_17.name = "GrassTuft02";
  if (endpoint_grass_tuft_02_17) {
    mesh_grass_tuft_02_17.position.copy(endpoint_grass_tuft_02_17.midpoint);
    mesh_grass_tuft_02_17.quaternion.copy(endpoint_grass_tuft_02_17.quaternion);
  }
  mesh_grass_tuft_02_17.castShadow = options.castShadow ?? true;
  mesh_grass_tuft_02_17.receiveShadow = options.receiveShadow ?? true;
  mesh_grass_tuft_02_17.userData.sculptComponent = {"id": "grass-tuft-02", "name": "GrassTuft02", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [-1.02, 0.11500000000000002, 1.5], "rotation": [0, 0, 0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_02_17.add(mesh_grass_tuft_02_17);
  meshes["grass-tuft-02"] = mesh_grass_tuft_02_17;
  colliders["grass-tuft-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["grass-tuft-02"] ??= [];
  destructionGroups["grass-tuft-02"].push(node_grass_tuft_02_17);

  const attachment_grass_tuft_03_18 = {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_grass_tuft_03_18 = makeAttachmentEndpoint(attachment_grass_tuft_03_18);
  const node_grass_tuft_03_18 = new THREE.Group();
  node_grass_tuft_03_18.name = "GrassTuft03__pivot";
  node_grass_tuft_03_18.scale.set(1, 1, 1);
  if (endpoint_grass_tuft_03_18) {
    node_grass_tuft_03_18.position.copy(endpoint_grass_tuft_03_18.start);
    node_grass_tuft_03_18.rotation.set(0.0, 0.0, -0.3);
  } else {
    node_grass_tuft_03_18.position.set(1.12, -0.06000000000000008, 2.4);
    node_grass_tuft_03_18.rotation.set(0.0, 0.0, -0.3);
  }
  node_grass_tuft_03_18.userData.sculptComponent = {"id": "grass-tuft-03", "name": "GrassTuft03", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [1.12, -0.06000000000000008, 2.4], "rotation": [0, 0, -0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_03_18.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_grass_tuft_03_18);
  nodes["grass-tuft-03"] = node_grass_tuft_03_18;
  const mesh_grass_tuft_03_18Geometry = endpoint_grass_tuft_03_18
    ? new THREE.CylinderGeometry(endpoint_grass_tuft_03_18.endRadius, endpoint_grass_tuft_03_18.baseRadius, endpoint_grass_tuft_03_18.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_grass_tuft_03_18) {
    mesh_grass_tuft_03_18Geometry.scale(0.15, 0.5, 0.15);
  }
  const mesh_grass_tuft_03_18 = new THREE.Mesh(
    mesh_grass_tuft_03_18Geometry,
    materialMap["grass-tuft"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grass_tuft_03_18.name = "GrassTuft03";
  if (endpoint_grass_tuft_03_18) {
    mesh_grass_tuft_03_18.position.copy(endpoint_grass_tuft_03_18.midpoint);
    mesh_grass_tuft_03_18.quaternion.copy(endpoint_grass_tuft_03_18.quaternion);
  }
  mesh_grass_tuft_03_18.castShadow = options.castShadow ?? true;
  mesh_grass_tuft_03_18.receiveShadow = options.receiveShadow ?? true;
  mesh_grass_tuft_03_18.userData.sculptComponent = {"id": "grass-tuft-03", "name": "GrassTuft03", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [1.12, -0.06000000000000008, 2.4], "rotation": [0, 0, -0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_03_18.add(mesh_grass_tuft_03_18);
  meshes["grass-tuft-03"] = mesh_grass_tuft_03_18;
  colliders["grass-tuft-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["grass-tuft-03"] ??= [];
  destructionGroups["grass-tuft-03"].push(node_grass_tuft_03_18);

  const attachment_grass_tuft_04_19 = {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_grass_tuft_04_19 = makeAttachmentEndpoint(attachment_grass_tuft_04_19);
  const node_grass_tuft_04_19 = new THREE.Group();
  node_grass_tuft_04_19.name = "GrassTuft04__pivot";
  node_grass_tuft_04_19.scale.set(1, 1, 1);
  if (endpoint_grass_tuft_04_19) {
    node_grass_tuft_04_19.position.copy(endpoint_grass_tuft_04_19.start);
    node_grass_tuft_04_19.rotation.set(0.0, 0.0, 0.3);
  } else {
    node_grass_tuft_04_19.position.set(-1.12, -0.06000000000000008, 3.1);
    node_grass_tuft_04_19.rotation.set(0.0, 0.0, 0.3);
  }
  node_grass_tuft_04_19.userData.sculptComponent = {"id": "grass-tuft-04", "name": "GrassTuft04", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [-1.12, -0.06000000000000008, 3.1], "rotation": [0, 0, 0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_04_19.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_grass_tuft_04_19);
  nodes["grass-tuft-04"] = node_grass_tuft_04_19;
  const mesh_grass_tuft_04_19Geometry = endpoint_grass_tuft_04_19
    ? new THREE.CylinderGeometry(endpoint_grass_tuft_04_19.endRadius, endpoint_grass_tuft_04_19.baseRadius, endpoint_grass_tuft_04_19.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_grass_tuft_04_19) {
    mesh_grass_tuft_04_19Geometry.scale(0.15, 0.5, 0.15);
  }
  const mesh_grass_tuft_04_19 = new THREE.Mesh(
    mesh_grass_tuft_04_19Geometry,
    materialMap["grass-tuft"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grass_tuft_04_19.name = "GrassTuft04";
  if (endpoint_grass_tuft_04_19) {
    mesh_grass_tuft_04_19.position.copy(endpoint_grass_tuft_04_19.midpoint);
    mesh_grass_tuft_04_19.quaternion.copy(endpoint_grass_tuft_04_19.quaternion);
  }
  mesh_grass_tuft_04_19.castShadow = options.castShadow ?? true;
  mesh_grass_tuft_04_19.receiveShadow = options.receiveShadow ?? true;
  mesh_grass_tuft_04_19.userData.sculptComponent = {"id": "grass-tuft-04", "name": "GrassTuft04", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [-1.12, -0.06000000000000008, 3.1], "rotation": [0, 0, 0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_04_19.add(mesh_grass_tuft_04_19);
  meshes["grass-tuft-04"] = mesh_grass_tuft_04_19;
  colliders["grass-tuft-04"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["grass-tuft-04"] ??= [];
  destructionGroups["grass-tuft-04"].push(node_grass_tuft_04_19);

  const attachment_grass_tuft_05_20 = {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_grass_tuft_05_20 = makeAttachmentEndpoint(attachment_grass_tuft_05_20);
  const node_grass_tuft_05_20 = new THREE.Group();
  node_grass_tuft_05_20.name = "GrassTuft05__pivot";
  node_grass_tuft_05_20.scale.set(1, 1, 1);
  if (endpoint_grass_tuft_05_20) {
    node_grass_tuft_05_20.position.copy(endpoint_grass_tuft_05_20.start);
    node_grass_tuft_05_20.rotation.set(0.0, 0.0, -0.3);
  } else {
    node_grass_tuft_05_20.position.set(0.92, 0.29, 3.7);
    node_grass_tuft_05_20.rotation.set(0.0, 0.0, -0.3);
  }
  node_grass_tuft_05_20.userData.sculptComponent = {"id": "grass-tuft-05", "name": "GrassTuft05", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [0.92, 0.29, 3.7], "rotation": [0, 0, -0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_05_20.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_grass_tuft_05_20);
  nodes["grass-tuft-05"] = node_grass_tuft_05_20;
  const mesh_grass_tuft_05_20Geometry = endpoint_grass_tuft_05_20
    ? new THREE.CylinderGeometry(endpoint_grass_tuft_05_20.endRadius, endpoint_grass_tuft_05_20.baseRadius, endpoint_grass_tuft_05_20.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_grass_tuft_05_20) {
    mesh_grass_tuft_05_20Geometry.scale(0.15, 0.5, 0.15);
  }
  const mesh_grass_tuft_05_20 = new THREE.Mesh(
    mesh_grass_tuft_05_20Geometry,
    materialMap["grass-tuft"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grass_tuft_05_20.name = "GrassTuft05";
  if (endpoint_grass_tuft_05_20) {
    mesh_grass_tuft_05_20.position.copy(endpoint_grass_tuft_05_20.midpoint);
    mesh_grass_tuft_05_20.quaternion.copy(endpoint_grass_tuft_05_20.quaternion);
  }
  mesh_grass_tuft_05_20.castShadow = options.castShadow ?? true;
  mesh_grass_tuft_05_20.receiveShadow = options.receiveShadow ?? true;
  mesh_grass_tuft_05_20.userData.sculptComponent = {"id": "grass-tuft-05", "name": "GrassTuft05", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [0.92, 0.29, 3.7], "rotation": [0, 0, -0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_05_20.add(mesh_grass_tuft_05_20);
  meshes["grass-tuft-05"] = mesh_grass_tuft_05_20;
  colliders["grass-tuft-05"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["grass-tuft-05"] ??= [];
  destructionGroups["grass-tuft-05"].push(node_grass_tuft_05_20);

  const attachment_grass_tuft_06_21 = {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_grass_tuft_06_21 = makeAttachmentEndpoint(attachment_grass_tuft_06_21);
  const node_grass_tuft_06_21 = new THREE.Group();
  node_grass_tuft_06_21.name = "GrassTuft06__pivot";
  node_grass_tuft_06_21.scale.set(1, 1, 1);
  if (endpoint_grass_tuft_06_21) {
    node_grass_tuft_06_21.position.copy(endpoint_grass_tuft_06_21.start);
    node_grass_tuft_06_21.rotation.set(0.0, 0.0, 0.3);
  } else {
    node_grass_tuft_06_21.position.set(-0.92, 0.29, 0.4);
    node_grass_tuft_06_21.rotation.set(0.0, 0.0, 0.3);
  }
  node_grass_tuft_06_21.userData.sculptComponent = {"id": "grass-tuft-06", "name": "GrassTuft06", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.92, 0.29, 0.4], "rotation": [0, 0, 0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_06_21.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_grass_tuft_06_21);
  nodes["grass-tuft-06"] = node_grass_tuft_06_21;
  const mesh_grass_tuft_06_21Geometry = endpoint_grass_tuft_06_21
    ? new THREE.CylinderGeometry(endpoint_grass_tuft_06_21.endRadius, endpoint_grass_tuft_06_21.baseRadius, endpoint_grass_tuft_06_21.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_grass_tuft_06_21) {
    mesh_grass_tuft_06_21Geometry.scale(0.15, 0.5, 0.15);
  }
  const mesh_grass_tuft_06_21 = new THREE.Mesh(
    mesh_grass_tuft_06_21Geometry,
    materialMap["grass-tuft"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grass_tuft_06_21.name = "GrassTuft06";
  if (endpoint_grass_tuft_06_21) {
    mesh_grass_tuft_06_21.position.copy(endpoint_grass_tuft_06_21.midpoint);
    mesh_grass_tuft_06_21.quaternion.copy(endpoint_grass_tuft_06_21.quaternion);
  }
  mesh_grass_tuft_06_21.castShadow = options.castShadow ?? true;
  mesh_grass_tuft_06_21.receiveShadow = options.receiveShadow ?? true;
  mesh_grass_tuft_06_21.userData.sculptComponent = {"id": "grass-tuft-06", "name": "GrassTuft06", "level": "micro", "role": "foliage", "importance": 0.45, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Toon grass tuft seated on the embankment slope, leaning outward.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.15, "height": 0.5, "depth": 0.15, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.92, 0.29, 0.4], "rotation": [0, 0, 0.3], "scale": [0.15, 0.5, 0.15]}, "material": "grass-tuft", "materialLayers": ["grass-tuft"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 151, 103, 1.0)", "secondaryAlbedo": "rgba(196, 171, 125, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-tuft-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_grass_tuft_06_21.add(mesh_grass_tuft_06_21);
  meshes["grass-tuft-06"] = mesh_grass_tuft_06_21;
  colliders["grass-tuft-06"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["grass-tuft-06"] ??= [];
  destructionGroups["grass-tuft-06"].push(node_grass_tuft_06_21);

  const endpoint_pebble_01_22 = makeAttachmentEndpoint(null);
  const node_pebble_01_22 = new THREE.Group();
  node_pebble_01_22.name = "Pebble01__pivot";
  node_pebble_01_22.scale.set(1, 1, 1);
  if (endpoint_pebble_01_22) {
    node_pebble_01_22.position.copy(endpoint_pebble_01_22.start);
    node_pebble_01_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_01_22.position.set(0.55, 0.14400000000000002, 0.6);
    node_pebble_01_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_01_22.userData.sculptComponent = {"id": "pebble-01", "name": "Pebble01", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 0.055999999999999994, "depth": 0.08, "units": "world", "confidence": 0.7}, "transform": {"position": [0.55, 0.14400000000000002, 0.6], "rotation": [0, 0, 0], "scale": [0.08, 0.055999999999999994, 0.08]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_01_22.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_pebble_01_22);
  nodes["pebble-01"] = node_pebble_01_22;
  const mesh_pebble_01_22Geometry = endpoint_pebble_01_22
    ? new THREE.CylinderGeometry(endpoint_pebble_01_22.endRadius, endpoint_pebble_01_22.baseRadius, endpoint_pebble_01_22.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_01_22) {
    mesh_pebble_01_22Geometry.scale(0.08, 0.055999999999999994, 0.08);
  }
  const mesh_pebble_01_22 = new THREE.Mesh(
    mesh_pebble_01_22Geometry,
    materialMap["ballast-gravel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_01_22.name = "Pebble01";
  if (endpoint_pebble_01_22) {
    mesh_pebble_01_22.position.copy(endpoint_pebble_01_22.midpoint);
    mesh_pebble_01_22.quaternion.copy(endpoint_pebble_01_22.quaternion);
  }
  mesh_pebble_01_22.castShadow = options.castShadow ?? true;
  mesh_pebble_01_22.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_01_22.userData.sculptComponent = {"id": "pebble-01", "name": "Pebble01", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 0.055999999999999994, "depth": 0.08, "units": "world", "confidence": 0.7}, "transform": {"position": [0.55, 0.14400000000000002, 0.6], "rotation": [0, 0, 0], "scale": [0.08, 0.055999999999999994, 0.08]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_01_22.add(mesh_pebble_01_22);
  meshes["pebble-01"] = mesh_pebble_01_22;
  colliders["pebble-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-01"] ??= [];
  destructionGroups["pebble-01"].push(node_pebble_01_22);

  const endpoint_pebble_02_23 = makeAttachmentEndpoint(null);
  const node_pebble_02_23 = new THREE.Group();
  node_pebble_02_23.name = "Pebble02__pivot";
  node_pebble_02_23.scale.set(1, 1, 1);
  if (endpoint_pebble_02_23) {
    node_pebble_02_23.position.copy(endpoint_pebble_02_23.start);
    node_pebble_02_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_02_23.position.set(-0.5, 0.1475, 1.3);
    node_pebble_02_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_02_23.userData.sculptComponent = {"id": "pebble-02", "name": "Pebble02", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.06999999999999999, "depth": 0.1, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.5, 0.1475, 1.3], "rotation": [0, 0, 0], "scale": [0.1, 0.06999999999999999, 0.1]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_02_23.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_pebble_02_23);
  nodes["pebble-02"] = node_pebble_02_23;
  const mesh_pebble_02_23Geometry = endpoint_pebble_02_23
    ? new THREE.CylinderGeometry(endpoint_pebble_02_23.endRadius, endpoint_pebble_02_23.baseRadius, endpoint_pebble_02_23.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_02_23) {
    mesh_pebble_02_23Geometry.scale(0.1, 0.06999999999999999, 0.1);
  }
  const mesh_pebble_02_23 = new THREE.Mesh(
    mesh_pebble_02_23Geometry,
    materialMap["ballast-gravel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_02_23.name = "Pebble02";
  if (endpoint_pebble_02_23) {
    mesh_pebble_02_23.position.copy(endpoint_pebble_02_23.midpoint);
    mesh_pebble_02_23.quaternion.copy(endpoint_pebble_02_23.quaternion);
  }
  mesh_pebble_02_23.castShadow = options.castShadow ?? true;
  mesh_pebble_02_23.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_02_23.userData.sculptComponent = {"id": "pebble-02", "name": "Pebble02", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.06999999999999999, "depth": 0.1, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.5, 0.1475, 1.3], "rotation": [0, 0, 0], "scale": [0.1, 0.06999999999999999, 0.1]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_02_23.add(mesh_pebble_02_23);
  meshes["pebble-02"] = mesh_pebble_02_23;
  colliders["pebble-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-02"] ??= [];
  destructionGroups["pebble-02"].push(node_pebble_02_23);

  const endpoint_pebble_03_24 = makeAttachmentEndpoint(null);
  const node_pebble_03_24 = new THREE.Group();
  node_pebble_03_24.name = "Pebble03__pivot";
  node_pebble_03_24.scale.set(1, 1, 1);
  if (endpoint_pebble_03_24) {
    node_pebble_03_24.position.copy(endpoint_pebble_03_24.start);
    node_pebble_03_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_03_24.position.set(0.3, 0.151, 2.1);
    node_pebble_03_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_03_24.userData.sculptComponent = {"id": "pebble-03", "name": "Pebble03", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.08399999999999999, "depth": 0.12, "units": "world", "confidence": 0.7}, "transform": {"position": [0.3, 0.151, 2.1], "rotation": [0, 0, 0], "scale": [0.12, 0.08399999999999999, 0.12]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_03_24.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_pebble_03_24);
  nodes["pebble-03"] = node_pebble_03_24;
  const mesh_pebble_03_24Geometry = endpoint_pebble_03_24
    ? new THREE.CylinderGeometry(endpoint_pebble_03_24.endRadius, endpoint_pebble_03_24.baseRadius, endpoint_pebble_03_24.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_03_24) {
    mesh_pebble_03_24Geometry.scale(0.12, 0.08399999999999999, 0.12);
  }
  const mesh_pebble_03_24 = new THREE.Mesh(
    mesh_pebble_03_24Geometry,
    materialMap["ballast-gravel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_03_24.name = "Pebble03";
  if (endpoint_pebble_03_24) {
    mesh_pebble_03_24.position.copy(endpoint_pebble_03_24.midpoint);
    mesh_pebble_03_24.quaternion.copy(endpoint_pebble_03_24.quaternion);
  }
  mesh_pebble_03_24.castShadow = options.castShadow ?? true;
  mesh_pebble_03_24.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_03_24.userData.sculptComponent = {"id": "pebble-03", "name": "Pebble03", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.08399999999999999, "depth": 0.12, "units": "world", "confidence": 0.7}, "transform": {"position": [0.3, 0.151, 2.1], "rotation": [0, 0, 0], "scale": [0.12, 0.08399999999999999, 0.12]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_03_24.add(mesh_pebble_03_24);
  meshes["pebble-03"] = mesh_pebble_03_24;
  colliders["pebble-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-03"] ??= [];
  destructionGroups["pebble-03"].push(node_pebble_03_24);

  const endpoint_pebble_04_25 = makeAttachmentEndpoint(null);
  const node_pebble_04_25 = new THREE.Group();
  node_pebble_04_25.name = "Pebble04__pivot";
  node_pebble_04_25.scale.set(1, 1, 1);
  if (endpoint_pebble_04_25) {
    node_pebble_04_25.position.copy(endpoint_pebble_04_25.start);
    node_pebble_04_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_04_25.position.set(-0.62, 0.14400000000000002, 2.8);
    node_pebble_04_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_04_25.userData.sculptComponent = {"id": "pebble-04", "name": "Pebble04", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 0.055999999999999994, "depth": 0.08, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.62, 0.14400000000000002, 2.8], "rotation": [0, 0, 0], "scale": [0.08, 0.055999999999999994, 0.08]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_04_25.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_pebble_04_25);
  nodes["pebble-04"] = node_pebble_04_25;
  const mesh_pebble_04_25Geometry = endpoint_pebble_04_25
    ? new THREE.CylinderGeometry(endpoint_pebble_04_25.endRadius, endpoint_pebble_04_25.baseRadius, endpoint_pebble_04_25.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_04_25) {
    mesh_pebble_04_25Geometry.scale(0.08, 0.055999999999999994, 0.08);
  }
  const mesh_pebble_04_25 = new THREE.Mesh(
    mesh_pebble_04_25Geometry,
    materialMap["ballast-gravel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_04_25.name = "Pebble04";
  if (endpoint_pebble_04_25) {
    mesh_pebble_04_25.position.copy(endpoint_pebble_04_25.midpoint);
    mesh_pebble_04_25.quaternion.copy(endpoint_pebble_04_25.quaternion);
  }
  mesh_pebble_04_25.castShadow = options.castShadow ?? true;
  mesh_pebble_04_25.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_04_25.userData.sculptComponent = {"id": "pebble-04", "name": "Pebble04", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 0.055999999999999994, "depth": 0.08, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.62, 0.14400000000000002, 2.8], "rotation": [0, 0, 0], "scale": [0.08, 0.055999999999999994, 0.08]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_04_25.add(mesh_pebble_04_25);
  meshes["pebble-04"] = mesh_pebble_04_25;
  colliders["pebble-04"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-04"] ??= [];
  destructionGroups["pebble-04"].push(node_pebble_04_25);

  const endpoint_pebble_05_26 = makeAttachmentEndpoint(null);
  const node_pebble_05_26 = new THREE.Group();
  node_pebble_05_26.name = "Pebble05__pivot";
  node_pebble_05_26.scale.set(1, 1, 1);
  if (endpoint_pebble_05_26) {
    node_pebble_05_26.position.copy(endpoint_pebble_05_26.start);
    node_pebble_05_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_05_26.position.set(0.7, 0.1475, 3.4);
    node_pebble_05_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_05_26.userData.sculptComponent = {"id": "pebble-05", "name": "Pebble05", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.06999999999999999, "depth": 0.1, "units": "world", "confidence": 0.7}, "transform": {"position": [0.7, 0.1475, 3.4], "rotation": [0, 0, 0], "scale": [0.1, 0.06999999999999999, 0.1]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_05_26.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["ballast-bed"] ?? root).add(node_pebble_05_26);
  nodes["pebble-05"] = node_pebble_05_26;
  const mesh_pebble_05_26Geometry = endpoint_pebble_05_26
    ? new THREE.CylinderGeometry(endpoint_pebble_05_26.endRadius, endpoint_pebble_05_26.baseRadius, endpoint_pebble_05_26.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_05_26) {
    mesh_pebble_05_26Geometry.scale(0.1, 0.06999999999999999, 0.1);
  }
  const mesh_pebble_05_26 = new THREE.Mesh(
    mesh_pebble_05_26Geometry,
    materialMap["ballast-gravel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_05_26.name = "Pebble05";
  if (endpoint_pebble_05_26) {
    mesh_pebble_05_26.position.copy(endpoint_pebble_05_26.midpoint);
    mesh_pebble_05_26.quaternion.copy(endpoint_pebble_05_26.quaternion);
  }
  mesh_pebble_05_26.castShadow = options.castShadow ?? true;
  mesh_pebble_05_26.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_05_26.userData.sculptComponent = {"id": "pebble-05", "name": "Pebble05", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble resting on the ballast.", "parent": "ballast-bed", "attachment": {"parentId": "ballast-bed", "parentSocket": "ballast-bed-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.06999999999999999, "depth": 0.1, "units": "world", "confidence": 0.7}, "transform": {"position": [0.7, 0.1475, 3.4], "rotation": [0, 0, 0], "scale": [0.1, 0.06999999999999999, 0.1]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_05_26.add(mesh_pebble_05_26);
  meshes["pebble-05"] = mesh_pebble_05_26;
  colliders["pebble-05"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-05"] ??= [];
  destructionGroups["pebble-05"].push(node_pebble_05_26);

  const endpoint_pebble_06_27 = makeAttachmentEndpoint(null);
  const node_pebble_06_27 = new THREE.Group();
  node_pebble_06_27.name = "Pebble06__pivot";
  node_pebble_06_27.scale.set(1, 1, 1);
  if (endpoint_pebble_06_27) {
    node_pebble_06_27.position.copy(endpoint_pebble_06_27.start);
    node_pebble_06_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_06_27.position.set(-1.12, -0.33425, 1.0);
    node_pebble_06_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_06_27.userData.sculptComponent = {"id": "pebble-06", "name": "Pebble06", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble at the foot of the embankment.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.063, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [-1.12, -0.33425, 1.0], "rotation": [0, 0, 0], "scale": [0.09, 0.063, 0.09]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_06_27.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_pebble_06_27);
  nodes["pebble-06"] = node_pebble_06_27;
  const mesh_pebble_06_27Geometry = endpoint_pebble_06_27
    ? new THREE.CylinderGeometry(endpoint_pebble_06_27.endRadius, endpoint_pebble_06_27.baseRadius, endpoint_pebble_06_27.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_06_27) {
    mesh_pebble_06_27Geometry.scale(0.09, 0.063, 0.09);
  }
  const mesh_pebble_06_27 = new THREE.Mesh(
    mesh_pebble_06_27Geometry,
    materialMap["ballast-gravel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_06_27.name = "Pebble06";
  if (endpoint_pebble_06_27) {
    mesh_pebble_06_27.position.copy(endpoint_pebble_06_27.midpoint);
    mesh_pebble_06_27.quaternion.copy(endpoint_pebble_06_27.quaternion);
  }
  mesh_pebble_06_27.castShadow = options.castShadow ?? true;
  mesh_pebble_06_27.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_06_27.userData.sculptComponent = {"id": "pebble-06", "name": "Pebble06", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble at the foot of the embankment.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.063, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [-1.12, -0.33425, 1.0], "rotation": [0, 0, 0], "scale": [0.09, 0.063, 0.09]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_06_27.add(mesh_pebble_06_27);
  meshes["pebble-06"] = mesh_pebble_06_27;
  colliders["pebble-06"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-06"] ??= [];
  destructionGroups["pebble-06"].push(node_pebble_06_27);

  const endpoint_pebble_07_28 = makeAttachmentEndpoint(null);
  const node_pebble_07_28 = new THREE.Group();
  node_pebble_07_28.name = "Pebble07__pivot";
  node_pebble_07_28.scale.set(1, 1, 1);
  if (endpoint_pebble_07_28) {
    node_pebble_07_28.position.copy(endpoint_pebble_07_28.start);
    node_pebble_07_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_07_28.position.set(1.14, -0.33075, 2.6);
    node_pebble_07_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_07_28.userData.sculptComponent = {"id": "pebble-07", "name": "Pebble07", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble at the foot of the embankment.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.11, "height": 0.077, "depth": 0.11, "units": "world", "confidence": 0.7}, "transform": {"position": [1.14, -0.33075, 2.6], "rotation": [0, 0, 0], "scale": [0.11, 0.077, 0.11]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_07_28.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_pebble_07_28);
  nodes["pebble-07"] = node_pebble_07_28;
  const mesh_pebble_07_28Geometry = endpoint_pebble_07_28
    ? new THREE.CylinderGeometry(endpoint_pebble_07_28.endRadius, endpoint_pebble_07_28.baseRadius, endpoint_pebble_07_28.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_07_28) {
    mesh_pebble_07_28Geometry.scale(0.11, 0.077, 0.11);
  }
  const mesh_pebble_07_28 = new THREE.Mesh(
    mesh_pebble_07_28Geometry,
    materialMap["ballast-gravel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_07_28.name = "Pebble07";
  if (endpoint_pebble_07_28) {
    mesh_pebble_07_28.position.copy(endpoint_pebble_07_28.midpoint);
    mesh_pebble_07_28.quaternion.copy(endpoint_pebble_07_28.quaternion);
  }
  mesh_pebble_07_28.castShadow = options.castShadow ?? true;
  mesh_pebble_07_28.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_07_28.userData.sculptComponent = {"id": "pebble-07", "name": "Pebble07", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble at the foot of the embankment.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.11, "height": 0.077, "depth": 0.11, "units": "world", "confidence": 0.7}, "transform": {"position": [1.14, -0.33075, 2.6], "rotation": [0, 0, 0], "scale": [0.11, 0.077, 0.11]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_07_28.add(mesh_pebble_07_28);
  meshes["pebble-07"] = mesh_pebble_07_28;
  colliders["pebble-07"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-07"] ??= [];
  destructionGroups["pebble-07"].push(node_pebble_07_28);

  const endpoint_pebble_08_29 = makeAttachmentEndpoint(null);
  const node_pebble_08_29 = new THREE.Group();
  node_pebble_08_29.name = "Pebble08__pivot";
  node_pebble_08_29.scale.set(1, 1, 1);
  if (endpoint_pebble_08_29) {
    node_pebble_08_29.position.copy(endpoint_pebble_08_29.start);
    node_pebble_08_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_08_29.position.set(-0.35, -0.33425, 3.8);
    node_pebble_08_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_08_29.userData.sculptComponent = {"id": "pebble-08", "name": "Pebble08", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble at the foot of the embankment.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.063, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.35, -0.33425, 3.8], "rotation": [0, 0, 0], "scale": [0.09, 0.063, 0.09]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_08_29.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["embankment"] ?? root).add(node_pebble_08_29);
  nodes["pebble-08"] = node_pebble_08_29;
  const mesh_pebble_08_29Geometry = endpoint_pebble_08_29
    ? new THREE.CylinderGeometry(endpoint_pebble_08_29.endRadius, endpoint_pebble_08_29.baseRadius, endpoint_pebble_08_29.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_08_29) {
    mesh_pebble_08_29Geometry.scale(0.09, 0.063, 0.09);
  }
  const mesh_pebble_08_29 = new THREE.Mesh(
    mesh_pebble_08_29Geometry,
    materialMap["ballast-gravel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_08_29.name = "Pebble08";
  if (endpoint_pebble_08_29) {
    mesh_pebble_08_29.position.copy(endpoint_pebble_08_29.midpoint);
    mesh_pebble_08_29.quaternion.copy(endpoint_pebble_08_29.quaternion);
  }
  mesh_pebble_08_29.castShadow = options.castShadow ?? true;
  mesh_pebble_08_29.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_08_29.userData.sculptComponent = {"id": "pebble-08", "name": "Pebble08", "level": "micro", "role": "debris", "importance": 0.45, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Loose pebble at the foot of the embankment.", "parent": "embankment", "attachment": {"parentId": "embankment", "parentSocket": "embankment-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.063, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.35, -0.33425, 3.8], "rotation": [0, 0, 0], "scale": [0.09, 0.063, 0.09]}, "material": "ballast-gravel", "materialLayers": ["ballast-gravel"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(118, 97, 73, 1.0)", "secondaryAlbedo": "rgba(145, 126, 100, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_08_29.add(mesh_pebble_08_29);
  meshes["pebble-08"] = mesh_pebble_08_29;
  colliders["pebble-08"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-08"] ??= [];
  destructionGroups["pebble-08"].push(node_pebble_08_29);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createRailwayTrackSegmentLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Railway Track Segment look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"role": "key light", "direction": "upper-left", "color": "#FFF3D6", "intensity": 2.6, "exposure": "ACESFilmic tone mapping, exposure 1.15", "notes": "warm midday sun, soft-edged shadows"}, {"role": "fill light", "direction": "front-right", "color": "#A9C6E0", "intensity": 0.5, "notes": "cool sky bounce lifting the shadow side"}, {"role": "rim / environment light", "color": "#CFE8FF", "intensity": 0.4, "notes": "hemisphere sky/ground environment"}, {"role": "contact shadow", "notes": "soft ground contact shadow via shadow map; ambient occlusion darkens seams and gravel", "ambientOcclusion": 0.35}, {"role": "background", "notes": "flat cream #F5EFE0 background matching the reference paper for fair comparison"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createRailwayTrackSegmentEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameRailwayTrackSegmentCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createRailwayTrackSegmentPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureRailwayTrackSegmentRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createRailwayTrackSegmentInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
