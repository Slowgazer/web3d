import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
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

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
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

// Generated from ObjectSculptSpec target: Summer Caravan
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.

// 车身四段水彩渐变带（顶→底：绿、黄、橙、粉）
function createBodyGradientTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const stops = ['#90C870', '#E8D870', '#E8B870', '#E8A0B0'];
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  let seed = 42;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 90; i++) {
    const x = rand() * size, y = rand() * size, r = 12 + rand() * 42;
    const band = Math.min(3, Math.floor((y / size) * 4));
    ctx.globalAlpha = 0.06 + rand() * 0.1;
    ctx.fillStyle = stops[band];
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.4 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// 屋顶水彩延续（檐口粉 → 顶部黄）
function createRoofWashTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, size, 0, 0);
  grad.addColorStop(0, '#E8A0B0');
  grad.addColorStop(0.45, '#E8B870');
  grad.addColorStop(1, '#E8D870');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 60; i++) {
    const x = rand() * size, y = rand() * size, r = 14 + rand() * 50;
    ctx.globalAlpha = 0.05 + rand() * 0.09;
    ctx.fillStyle = rand() > 0.5 ? '#E8A0B0' : '#E8D870';
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.5, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function createSummerCaravanModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Summer Caravan";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.333, "orientation": {"yaw": -15, "pitch": 5, "roll": 0}, "positionHint": [3.0, 1.5, 4.0], "note": "Three-quarter front-left view, slightly elevated"}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["body-gradient"] = createSculptMaterial(
    "body-gradient",
    {"id": "body-gradient", "name": "Body Watercolor Gradient", "type": "standard", "baseColor": "#E8B870", "albedo": {"dominant": "#E8B870", "secondary": ["#E8A0B0", "#E8D870", "#90C870"], "samplingNotes": "4 horizontal gradient bands from reference: pink bottom, orange mid-low, yellow mid-high, green top. Watercolor bleeding between bands."}, "roughness": {"base": 0.75, "variation": 0.15, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "subtle-watercolor-bump", "strength": 0.2, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.2, "response": "cavity and crevice darkening via procedural AO map"}, "shaderNotes": ["Watercolor gradient via vertex color or procedural y-axis ramp", "Subtle bump for painterly texture"], "localOverrides": [{"zone": "bottom-band", "albedo": "#E8A0B0", "description": "Pink watercolor band at body base"}, {"zone": "mid-low-band", "albedo": "#E8B870", "description": "Orange watercolor band"}, {"zone": "mid-high-band", "albedo": "#E8D870", "description": "Yellow watercolor band"}, {"zone": "top-band", "albedo": "#90C870", "description": "Green watercolor band at body top"}], "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "colorVariation": {"palette": ["#E8B870"]}},
    options
  );
  materialMap["roof-material"] = createSculptMaterial(
    "roof-material",
    {"id": "roof-material", "name": "Roof Material", "type": "standard", "baseColor": "#C8884A", "roughness": {"base": 0.7, "variation": 0.1, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.15, "scale": 12.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#C8884A"]}},
    options
  );
  materialMap["window-frame-wood"] = createSculptMaterial(
    "window-frame-wood",
    {"id": "window-frame-wood", "name": "Window Frame Wood", "type": "standard", "baseColor": "#5A3A20", "roughness": {"base": 0.55, "variation": 0.1, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.15}, "normal": {"pattern": "wood-grain", "strength": 0.3, "scale": 20.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#5A3A20"]}},
    options
  );
  materialMap["window-glass-emissive"] = createSculptMaterial(
    "window-glass-emissive",
    {"id": "window-glass-emissive", "name": "Window Glass Emissive", "type": "emissive", "baseColor": "#F0D860", "emissive": "#F0D860", "emissiveIntensity": 0.6, "roughness": {"base": 0.15, "variation": 0.05, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.05}, "opacity": 0.85, "shaderNotes": ["Warm yellow self-lit glass", "Slight transparency for depth"], "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#F0D860"]}, "normal": {"pattern": "subtle-grain", "strength": 0.15, "scale": 12.0}},
    options
  );
  materialMap["chimney-stone"] = createSculptMaterial(
    "chimney-stone",
    {"id": "chimney-stone", "name": "Chimney Stone", "type": "standard", "baseColor": "#8A7A6A", "roughness": {"base": 0.75, "variation": 0.12, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "stone-rough", "strength": 0.4, "scale": 16.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#8A7A6A"]}},
    options
  );
  materialMap["wheel-wood"] = createSculptMaterial(
    "wheel-wood",
    {"id": "wheel-wood", "name": "Wheel Wood", "type": "standard", "baseColor": "#4A3020", "roughness": {"base": 0.75, "variation": 0.1, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "wood-grain", "strength": 0.25, "scale": 15.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#4A3020"]}},
    options
  );
  materialMap["chassis-wood"] = createSculptMaterial(
    "chassis-wood",
    {"id": "chassis-wood", "name": "Chassis Wood", "type": "standard", "baseColor": "#5A4030", "roughness": {"base": 0.7, "variation": 0.1, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.05}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#5A4030"]}, "normal": {"pattern": "subtle-grain", "strength": 0.15, "scale": 12.0}},
    options
  );
  materialMap["coupling-metal"] = createSculptMaterial(
    "coupling-metal",
    {"id": "coupling-metal", "name": "Coupling Metal", "type": "standard", "baseColor": "#5A5A5A", "roughness": {"base": 0.65, "variation": 0.1, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.45}, "normal": {"pattern": "metal-worn", "strength": 0.2, "scale": 10.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#5A5A5A"]}},
    options
  );
  materialMap["vine-green"] = createSculptMaterial(
    "vine-green",
    {"id": "vine-green", "name": "Vine Green", "type": "standard", "baseColor": "#3FBFAE", "roughness": {"base": 0.75, "variation": 0.1, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "organic-smooth", "strength": 0.15, "scale": 6.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#4AADA0"]}, "localOverrides": [{"zone": "default", "albedo": "#4AADA0", "description": "teal vine"}]},
    options
  );
  materialMap["flower-pink"] = createSculptMaterial(
    "flower-pink",
    {"id": "flower-pink", "name": "Flower Pink", "type": "standard", "baseColor": "#F5A8C0", "roughness": {"base": 0.6, "variation": 0.1, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "petal-soft", "strength": 0.1, "scale": 4.0}, "localOverrides": [{"zone": "default", "albedo": "#F5A8C0", "description": "bright pink"}], "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#F5A8C0", "#F8B860", "#F8D868", "#B090E0"]}},
    options
  );
  materialMap["flower-center-yellow"] = createSculptMaterial(
    "flower-center-yellow",
    {"id": "flower-center-yellow", "name": "Flower Center Yellow", "type": "standard", "baseColor": "#F8D848", "roughness": {"base": 0.5, "variation": 0.1, "map": "procedural-noise-roughness-map"}, "metalness": {"base": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space density, 1024px per 3.2 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.4, "pattern": "large watercolor wash zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.22, "pattern": "watercolor bleeding mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity and crevice darkening via procedural AO map"}, "colorVariation": {"palette": ["#F8D848"]}, "normal": {"pattern": "subtle-grain", "strength": 0.15, "scale": 12.0}},
    options
  );

  
  // refine-code: 车身/屋顶水彩渐变 + 玻璃暖光 + 藤蔓花朵提亮
  {
    const bodyMat = materialMap["body-gradient"] as THREE.MeshStandardMaterial | undefined;
    if (bodyMat) { bodyMat.map = createBodyGradientTexture(); bodyMat.color.set(0xffffff); bodyMat.needsUpdate = true; }
    const roofMat = materialMap["roof-material"] as THREE.MeshStandardMaterial | undefined;
    if (roofMat) { roofMat.map = createRoofWashTexture(); roofMat.color.set(0xffffff); roofMat.needsUpdate = true; }
    const glassMat = materialMap["window-glass-emissive"] as THREE.MeshStandardMaterial | undefined;
    if (glassMat) {
      glassMat.emissive.set("#FFB840"); glassMat.emissiveIntensity = 2.6;
      glassMat.color.set("#E8A838");
      glassMat.map = null;
      glassMat.roughness = 0.35;
      glassMat.needsUpdate = true;
    }
    const vineMat = materialMap["vine-green"] as THREE.MeshStandardMaterial | undefined;
    if (vineMat) { vineMat.color.set("#3FBFAE"); vineMat.map = null; vineMat.needsUpdate = true; }
    const flowerMat = materialMap["flower-pink"] as THREE.MeshStandardMaterial | undefined;
    if (flowerMat) { flowerMat.color.set("#F5A8C0"); flowerMat.map = null; flowerMat.needsUpdate = true; }
    const centerMat = materialMap["flower-center-yellow"] as THREE.MeshStandardMaterial | undefined;
    if (centerMat) { centerMat.color.set("#F8D848"); centerMat.map = null; centerMat.needsUpdate = true; }
  }

const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_caravan_root_0 = null;
  const endpoint_caravan_root_0 = makeAttachmentEndpoint(attachment_caravan_root_0);
  const node_caravan_root_0 = new THREE.Group();
  node_caravan_root_0.name = "SummerCaravan__pivot";
  node_caravan_root_0.scale.set(1, 1, 1);
  if (endpoint_caravan_root_0) {
    node_caravan_root_0.position.copy(endpoint_caravan_root_0.start);
    node_caravan_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_caravan_root_0.position.set(0.0, 0.0, 0.0);
    node_caravan_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_caravan_root_0.userData.sculptComponent = {"id": "caravan-root", "name": "SummerCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 3.2, "height": 2.0, "depth": 1.6, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [3.2, 2.0, 1.6]}, "material": null, "evidenceRefs": ["full-object"], "children": ["body", "chassis", "roof-assembly", "window-system", "vine-system-left", "vine-system-right"], "topologyRationale": "Solid geometry for SummerCaravan", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "caravan-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 184, 112, 1.0)", "secondaryAlbedo": "rgba(144, 200, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_caravan_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "caravan-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_caravan_root_0);
  nodes["caravan-root"] = node_caravan_root_0;
  const mesh_caravan_root_0Geometry = endpoint_caravan_root_0
    ? new THREE.CylinderGeometry(endpoint_caravan_root_0.endRadius, endpoint_caravan_root_0.baseRadius, endpoint_caravan_root_0.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_caravan_root_0) {
    mesh_caravan_root_0Geometry.scale(3.2, 2.0, 1.6);
  }
  const mesh_caravan_root_0 = new THREE.Mesh(
    mesh_caravan_root_0Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_caravan_root_0.name = "SummerCaravan";
  if (endpoint_caravan_root_0) {
    mesh_caravan_root_0.position.copy(endpoint_caravan_root_0.midpoint);
    mesh_caravan_root_0.quaternion.copy(endpoint_caravan_root_0.quaternion);
  }
  mesh_caravan_root_0.castShadow = options.castShadow ?? true;
  mesh_caravan_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_caravan_root_0.visible = false; // 容器节点不渲染
  mesh_caravan_root_0.userData.sculptComponent = {"id": "caravan-root", "name": "SummerCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 3.2, "height": 2.0, "depth": 1.6, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [3.2, 2.0, 1.6]}, "material": null, "evidenceRefs": ["full-object"], "children": ["body", "chassis", "roof-assembly", "window-system", "vine-system-left", "vine-system-right"], "topologyRationale": "Solid geometry for SummerCaravan", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "caravan-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 184, 112, 1.0)", "secondaryAlbedo": "rgba(144, 200, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_caravan_root_0.add(mesh_caravan_root_0);
  meshes["caravan-root"] = mesh_caravan_root_0;
  colliders["caravan-root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["caravan-root"] ??= [];
  destructionGroups["caravan-root"].push(node_caravan_root_0);

  const endpoint_body_1 = makeAttachmentEndpoint(null);
  const node_body_1 = new THREE.Group();
  node_body_1.name = "Body__pivot";
  node_body_1.scale.set(1, 1, 1);
  if (endpoint_body_1) {
    node_body_1.position.copy(endpoint_body_1.start);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_body_1.position.set(0.0, 0.65, 0.0);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "caravan-root", "attachment": {"parentSocket": "caravan-root-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.3, "depth": 1.5, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.65, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.3, 1.5]}, "geometryDescriptor": {"topologyIntent": "rounded cuboid with beveled edges, radius ~0.08", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.08, "segments": 3}, "uvStrategy": "box-projection"}, "material": "body-gradient", "localFeatures": [{"id": "gradient-bands", "type": "color-zone", "description": "4 horizontal watercolor gradient bands: pink (#E8A0B0) bottom, orange (#E8B870) mid-low, yellow (#E8D870) mid-high, green (#90C870) top", "evidenceRef": "full-object"}, {"id": "watercolor-texture", "type": "surface-finish", "description": "Soft watercolor bleeding between bands, irregular boundaries, painterly feel", "evidenceRef": "full-object"}], "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Body", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 184, 112, 1.0)", "secondaryAlbedo": "rgba(232, 160, 176, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "watercolor paper grain + wash mottling", "strength": 0.25, "scale": 8.0}, "roughnessVariation": {"pattern": "wash zones vary sheen", "amount": 0.15}}};
  node_body_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["caravan-root"] ?? root).add(node_body_1);
  nodes["body"] = node_body_1;
  const mesh_body_1Geometry = endpoint_body_1
    ? new THREE.CylinderGeometry(endpoint_body_1.endRadius, endpoint_body_1.baseRadius, endpoint_body_1.length, 16, 6)
    : new RoundedBoxGeometry(3.0, 1.3, 1.5, 4, 0.08);
  if (!endpoint_body_1) {
    mesh_body_1Geometry.scale(1, 1, 1); // 几何体已是最终尺寸
  }
  const mesh_body_1 = new THREE.Mesh(
    mesh_body_1Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_1.name = "Body";
  if (endpoint_body_1) {
    mesh_body_1.position.copy(endpoint_body_1.midpoint);
    mesh_body_1.quaternion.copy(endpoint_body_1.quaternion);
  }
  mesh_body_1.castShadow = options.castShadow ?? true;
  mesh_body_1.receiveShadow = options.receiveShadow ?? true;
  mesh_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "caravan-root", "attachment": {"parentSocket": "caravan-root-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.3, "depth": 1.5, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.65, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.3, 1.5]}, "geometryDescriptor": {"topologyIntent": "rounded cuboid with beveled edges, radius ~0.08", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.08, "segments": 3}, "uvStrategy": "box-projection"}, "material": "body-gradient", "localFeatures": [{"id": "gradient-bands", "type": "color-zone", "description": "4 horizontal watercolor gradient bands: pink (#E8A0B0) bottom, orange (#E8B870) mid-low, yellow (#E8D870) mid-high, green (#90C870) top", "evidenceRef": "full-object"}, {"id": "watercolor-texture", "type": "surface-finish", "description": "Soft watercolor bleeding between bands, irregular boundaries, painterly feel", "evidenceRef": "full-object"}], "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Body", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 184, 112, 1.0)", "secondaryAlbedo": "rgba(232, 160, 176, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "watercolor paper grain + wash mottling", "strength": 0.25, "scale": 8.0}, "roughnessVariation": {"pattern": "wash zones vary sheen", "amount": 0.15}}};
  node_body_1.add(mesh_body_1);
  meshes["body"] = mesh_body_1;
  colliders["body"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_body_1);

  const attachment_chassis_2 = {"parentSocket": "caravan-root-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_chassis_2 = makeAttachmentEndpoint(attachment_chassis_2);
  const node_chassis_2 = new THREE.Group();
  node_chassis_2.name = "Chassis__pivot";
  node_chassis_2.scale.set(1, 1, 1);
  if (endpoint_chassis_2) {
    node_chassis_2.position.copy(endpoint_chassis_2.start);
    node_chassis_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chassis_2.position.set(0.0, 0.15, 0.0);
    node_chassis_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_chassis_2.userData.sculptComponent = {"id": "chassis", "name": "Chassis", "level": "meso", "role": "undercarriage", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "caravan-root", "attachment": {"parentSocket": "caravan-root-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.2, "height": 0.3, "depth": 1.4, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.15, 0], "rotation": [0, 0, 0], "scale": [3.2, 0.3, 1.4]}, "material": "chassis-wood", "evidenceRefs": ["full-object"], "children": ["beam-left", "beam-right", "wheel-mount-front", "wheel-mount-rear"], "children_note": "Beams are longitudinal, wheels attach via mounts", "topologyRationale": "Solid geometry for Chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 64, 48, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chassis_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["caravan-root"] ?? root).add(node_chassis_2);
  nodes["chassis"] = node_chassis_2;
  const mesh_chassis_2Geometry = endpoint_chassis_2
    ? new THREE.CylinderGeometry(endpoint_chassis_2.endRadius, endpoint_chassis_2.baseRadius, endpoint_chassis_2.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_chassis_2) {
    mesh_chassis_2Geometry.scale(3.2, 0.3, 1.4);
  }
  const mesh_chassis_2 = new THREE.Mesh(
    mesh_chassis_2Geometry,
    materialMap["chassis-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chassis_2.name = "Chassis";
  if (endpoint_chassis_2) {
    mesh_chassis_2.position.copy(endpoint_chassis_2.midpoint);
    mesh_chassis_2.quaternion.copy(endpoint_chassis_2.quaternion);
  }
  mesh_chassis_2.castShadow = options.castShadow ?? true;
  mesh_chassis_2.receiveShadow = options.receiveShadow ?? true;
  mesh_chassis_2.userData.sculptComponent = {"id": "chassis", "name": "Chassis", "level": "meso", "role": "undercarriage", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "caravan-root", "attachment": {"parentSocket": "caravan-root-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.2, "height": 0.3, "depth": 1.4, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.15, 0], "rotation": [0, 0, 0], "scale": [3.2, 0.3, 1.4]}, "material": "chassis-wood", "evidenceRefs": ["full-object"], "children": ["beam-left", "beam-right", "wheel-mount-front", "wheel-mount-rear"], "children_note": "Beams are longitudinal, wheels attach via mounts", "topologyRationale": "Solid geometry for Chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 64, 48, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chassis_2.add(mesh_chassis_2);
  meshes["chassis"] = mesh_chassis_2;
  colliders["chassis"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["chassis"] ??= [];
  destructionGroups["chassis"].push(node_chassis_2);

  const endpoint_beam_left_3 = makeAttachmentEndpoint(null);
  const node_beam_left_3 = new THREE.Group();
  node_beam_left_3.name = "BeamLeft__pivot";
  node_beam_left_3.scale.set(1, 1, 1);
  if (endpoint_beam_left_3) {
    node_beam_left_3.position.copy(endpoint_beam_left_3.start);
    node_beam_left_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_beam_left_3.position.set(0.0, 0.0, -0.55);
    node_beam_left_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_beam_left_3.userData.sculptComponent = {"id": "beam-left", "name": "BeamLeft", "level": "meso", "role": "structural-beam", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentSocket": "chassis-left", "contactType": "continuous", "embedDepth": 0.0, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 0.12, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, -0.55], "rotation": [0, 0, 0], "scale": [3.0, 0.12, 0.1]}, "material": "chassis-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for BeamLeft", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 64, 48, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_beam_left_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_beam_left_3);
  nodes["beam-left"] = node_beam_left_3;
  const mesh_beam_left_3Geometry = endpoint_beam_left_3
    ? new THREE.CylinderGeometry(endpoint_beam_left_3.endRadius, endpoint_beam_left_3.baseRadius, endpoint_beam_left_3.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_beam_left_3) {
    mesh_beam_left_3Geometry.scale(3.0, 0.12, 0.1);
  }
  const mesh_beam_left_3 = new THREE.Mesh(
    mesh_beam_left_3Geometry,
    materialMap["chassis-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_beam_left_3.name = "BeamLeft";
  if (endpoint_beam_left_3) {
    mesh_beam_left_3.position.copy(endpoint_beam_left_3.midpoint);
    mesh_beam_left_3.quaternion.copy(endpoint_beam_left_3.quaternion);
  }
  mesh_beam_left_3.castShadow = options.castShadow ?? true;
  mesh_beam_left_3.receiveShadow = options.receiveShadow ?? true;
  mesh_beam_left_3.userData.sculptComponent = {"id": "beam-left", "name": "BeamLeft", "level": "meso", "role": "structural-beam", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentSocket": "chassis-left", "contactType": "continuous", "embedDepth": 0.0, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 0.12, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, -0.55], "rotation": [0, 0, 0], "scale": [3.0, 0.12, 0.1]}, "material": "chassis-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for BeamLeft", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 64, 48, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_beam_left_3.add(mesh_beam_left_3);
  meshes["beam-left"] = mesh_beam_left_3;
  colliders["beam-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["beam-left"] ??= [];
  destructionGroups["beam-left"].push(node_beam_left_3);

  const endpoint_beam_right_4 = makeAttachmentEndpoint(null);
  const node_beam_right_4 = new THREE.Group();
  node_beam_right_4.name = "BeamRight__pivot";
  node_beam_right_4.scale.set(1, 1, 1);
  if (endpoint_beam_right_4) {
    node_beam_right_4.position.copy(endpoint_beam_right_4.start);
    node_beam_right_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_beam_right_4.position.set(0.0, 0.0, 0.55);
    node_beam_right_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_beam_right_4.userData.sculptComponent = {"id": "beam-right", "name": "BeamRight", "level": "meso", "role": "structural-beam", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentSocket": "chassis-right", "contactType": "continuous", "embedDepth": 0.0, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 0.12, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.55], "rotation": [0, 0, 0], "scale": [3.0, 0.12, 0.1]}, "material": "chassis-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for BeamRight", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 64, 48, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_beam_right_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_beam_right_4);
  nodes["beam-right"] = node_beam_right_4;
  const mesh_beam_right_4Geometry = endpoint_beam_right_4
    ? new THREE.CylinderGeometry(endpoint_beam_right_4.endRadius, endpoint_beam_right_4.baseRadius, endpoint_beam_right_4.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_beam_right_4) {
    mesh_beam_right_4Geometry.scale(3.0, 0.12, 0.1);
  }
  const mesh_beam_right_4 = new THREE.Mesh(
    mesh_beam_right_4Geometry,
    materialMap["chassis-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_beam_right_4.name = "BeamRight";
  if (endpoint_beam_right_4) {
    mesh_beam_right_4.position.copy(endpoint_beam_right_4.midpoint);
    mesh_beam_right_4.quaternion.copy(endpoint_beam_right_4.quaternion);
  }
  mesh_beam_right_4.castShadow = options.castShadow ?? true;
  mesh_beam_right_4.receiveShadow = options.receiveShadow ?? true;
  mesh_beam_right_4.userData.sculptComponent = {"id": "beam-right", "name": "BeamRight", "level": "meso", "role": "structural-beam", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentSocket": "chassis-right", "contactType": "continuous", "embedDepth": 0.0, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 0.12, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.55], "rotation": [0, 0, 0], "scale": [3.0, 0.12, 0.1]}, "material": "chassis-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for BeamRight", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 64, 48, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_beam_right_4.add(mesh_beam_right_4);
  meshes["beam-right"] = mesh_beam_right_4;
  colliders["beam-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["beam-right"] ??= [];
  destructionGroups["beam-right"].push(node_beam_right_4);

  const attachment_wheel_mount_front_5 = {"parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_mount_front_5 = makeAttachmentEndpoint(attachment_wheel_mount_front_5);
  const node_wheel_mount_front_5 = new THREE.Group();
  node_wheel_mount_front_5.name = "WheelMountFront__pivot";
  node_wheel_mount_front_5.scale.set(1, 1, 1);
  if (endpoint_wheel_mount_front_5) {
    node_wheel_mount_front_5.position.copy(endpoint_wheel_mount_front_5.start);
    node_wheel_mount_front_5.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_mount_front_5.position.set(-1.0, -0.3, 0.0);
    node_wheel_mount_front_5.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_mount_front_5.userData.sculptComponent = {"id": "wheel-mount-front", "name": "WheelMountFront", "level": "meso", "role": "wheel-attachment", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "parent": "chassis", "attachment": {"parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-1.0, -0.3, 0], "rotation": [1.5708, 0.0, 0.0], "scale": [1, 1, 1]}, "children": ["wheel-front-left", "wheel-front-right"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-mount-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for WheelMountFront", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(90, 64, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_wheel_mount_front_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-mount-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_mount_front_5);
  nodes["wheel-mount-front"] = node_wheel_mount_front_5;
  const mesh_wheel_mount_front_5Geometry = endpoint_wheel_mount_front_5
    ? new THREE.CylinderGeometry(endpoint_wheel_mount_front_5.endRadius, endpoint_wheel_mount_front_5.baseRadius, endpoint_wheel_mount_front_5.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_mount_front_5) {
    mesh_wheel_mount_front_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wheel_mount_front_5 = new THREE.Mesh(
    mesh_wheel_mount_front_5Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_mount_front_5.name = "WheelMountFront";
  if (endpoint_wheel_mount_front_5) {
    mesh_wheel_mount_front_5.position.copy(endpoint_wheel_mount_front_5.midpoint);
    mesh_wheel_mount_front_5.quaternion.copy(endpoint_wheel_mount_front_5.quaternion);
  }
  mesh_wheel_mount_front_5.castShadow = options.castShadow ?? true;
  mesh_wheel_mount_front_5.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_mount_front_5.visible = false; // 容器节点不渲染
  mesh_wheel_mount_front_5.userData.sculptComponent = {"id": "wheel-mount-front", "name": "WheelMountFront", "level": "meso", "role": "wheel-attachment", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "parent": "chassis", "attachment": {"parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-1.0, -0.3, 0], "rotation": [1.5708, 0.0, 0.0], "scale": [1, 1, 1]}, "children": ["wheel-front-left", "wheel-front-right"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-mount-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for WheelMountFront", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(90, 64, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_wheel_mount_front_5.add(mesh_wheel_mount_front_5);
  meshes["wheel-mount-front"] = mesh_wheel_mount_front_5;
  colliders["wheel-mount-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-mount-front"] ??= [];
  destructionGroups["wheel-mount-front"].push(node_wheel_mount_front_5);

  const attachment_wheel_mount_rear_6 = {"parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_mount_rear_6 = makeAttachmentEndpoint(attachment_wheel_mount_rear_6);
  const node_wheel_mount_rear_6 = new THREE.Group();
  node_wheel_mount_rear_6.name = "WheelMountRear__pivot";
  node_wheel_mount_rear_6.scale.set(1, 1, 1);
  if (endpoint_wheel_mount_rear_6) {
    node_wheel_mount_rear_6.position.copy(endpoint_wheel_mount_rear_6.start);
    node_wheel_mount_rear_6.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_mount_rear_6.position.set(1.0, -0.3, 0.0);
    node_wheel_mount_rear_6.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_mount_rear_6.userData.sculptComponent = {"id": "wheel-mount-rear", "name": "WheelMountRear", "level": "meso", "role": "wheel-attachment", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "parent": "chassis", "attachment": {"parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [1.0, -0.3, 0], "rotation": [1.5708, 0.0, 0.0], "scale": [1, 1, 1]}, "children": ["wheel-rear-left", "wheel-rear-right"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-mount-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for WheelMountRear", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(90, 64, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_wheel_mount_rear_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-mount-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_mount_rear_6);
  nodes["wheel-mount-rear"] = node_wheel_mount_rear_6;
  const mesh_wheel_mount_rear_6Geometry = endpoint_wheel_mount_rear_6
    ? new THREE.CylinderGeometry(endpoint_wheel_mount_rear_6.endRadius, endpoint_wheel_mount_rear_6.baseRadius, endpoint_wheel_mount_rear_6.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_mount_rear_6) {
    mesh_wheel_mount_rear_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wheel_mount_rear_6 = new THREE.Mesh(
    mesh_wheel_mount_rear_6Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_mount_rear_6.name = "WheelMountRear";
  if (endpoint_wheel_mount_rear_6) {
    mesh_wheel_mount_rear_6.position.copy(endpoint_wheel_mount_rear_6.midpoint);
    mesh_wheel_mount_rear_6.quaternion.copy(endpoint_wheel_mount_rear_6.quaternion);
  }
  mesh_wheel_mount_rear_6.castShadow = options.castShadow ?? true;
  mesh_wheel_mount_rear_6.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_mount_rear_6.visible = false; // 容器节点不渲染
  mesh_wheel_mount_rear_6.userData.sculptComponent = {"id": "wheel-mount-rear", "name": "WheelMountRear", "level": "meso", "role": "wheel-attachment", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "parent": "chassis", "attachment": {"parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [1.0, -0.3, 0], "rotation": [1.5708, 0.0, 0.0], "scale": [1, 1, 1]}, "children": ["wheel-rear-left", "wheel-rear-right"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-mount-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for WheelMountRear", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(90, 64, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_wheel_mount_rear_6.add(mesh_wheel_mount_rear_6);
  meshes["wheel-mount-rear"] = mesh_wheel_mount_rear_6;
  colliders["wheel-mount-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-mount-rear"] ??= [];
  destructionGroups["wheel-mount-rear"].push(node_wheel_mount_rear_6);

  const attachment_wheel_front_left_7 = {"parentSocket": "axle-left", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_front_left_7 = makeAttachmentEndpoint(attachment_wheel_front_left_7);
  const node_wheel_front_left_7 = new THREE.Group();
  node_wheel_front_left_7.name = "WheelFrontLeft__pivot";
  node_wheel_front_left_7.scale.set(1, 1, 1);
  if (endpoint_wheel_front_left_7) {
    node_wheel_front_left_7.position.copy(endpoint_wheel_front_left_7.start);
    node_wheel_front_left_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_front_left_7.position.set(0.0, -0.65, 0.0);
    node_wheel_front_left_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_front_left_7.userData.sculptComponent = {"id": "wheel-front-left", "name": "WheelFrontLeft", "level": "meso", "role": "wheel", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "wheel-mount-front", "attachment": {"parentSocket": "axle-left", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.15, "depth": 0.5, "units": "world", "confidence": 0.8}, "transform": {"position": [0, -0.65, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.15, 0.5]}, "material": "wheel-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WheelFrontLeft", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(42, 26, 16, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "spoked wheel wood grain + hub bevel", "strength": 0.3, "scale": 15.0}, "roughnessVariation": {"pattern": "worn rim", "amount": 0.15}}};
  node_wheel_front_left_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-mount-front"] ?? root).add(node_wheel_front_left_7);
  nodes["wheel-front-left"] = node_wheel_front_left_7;
  const mesh_wheel_front_left_7Geometry = endpoint_wheel_front_left_7
    ? new THREE.CylinderGeometry(endpoint_wheel_front_left_7.endRadius, endpoint_wheel_front_left_7.baseRadius, endpoint_wheel_front_left_7.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_front_left_7) {
    mesh_wheel_front_left_7Geometry.scale(0.5, 0.15, 0.5);
  }
  const mesh_wheel_front_left_7 = new THREE.Mesh(
    mesh_wheel_front_left_7Geometry,
    materialMap["wheel-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_left_7.name = "WheelFrontLeft";
  if (endpoint_wheel_front_left_7) {
    mesh_wheel_front_left_7.position.copy(endpoint_wheel_front_left_7.midpoint);
    mesh_wheel_front_left_7.quaternion.copy(endpoint_wheel_front_left_7.quaternion);
  }
  mesh_wheel_front_left_7.castShadow = options.castShadow ?? true;
  mesh_wheel_front_left_7.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_left_7.userData.sculptComponent = {"id": "wheel-front-left", "name": "WheelFrontLeft", "level": "meso", "role": "wheel", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "wheel-mount-front", "attachment": {"parentSocket": "axle-left", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.15, "depth": 0.5, "units": "world", "confidence": 0.8}, "transform": {"position": [0, -0.65, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.15, 0.5]}, "material": "wheel-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WheelFrontLeft", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(42, 26, 16, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "spoked wheel wood grain + hub bevel", "strength": 0.3, "scale": 15.0}, "roughnessVariation": {"pattern": "worn rim", "amount": 0.15}}};
  node_wheel_front_left_7.add(mesh_wheel_front_left_7);
  meshes["wheel-front-left"] = mesh_wheel_front_left_7;
  colliders["wheel-front-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-front-left"] ??= [];
  destructionGroups["wheel-front-left"].push(node_wheel_front_left_7);

  const attachment_wheel_front_right_8 = {"parentSocket": "axle-right", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_front_right_8 = makeAttachmentEndpoint(attachment_wheel_front_right_8);
  const node_wheel_front_right_8 = new THREE.Group();
  node_wheel_front_right_8.name = "WheelFrontRight__pivot";
  node_wheel_front_right_8.scale.set(1, 1, 1);
  if (endpoint_wheel_front_right_8) {
    node_wheel_front_right_8.position.copy(endpoint_wheel_front_right_8.start);
    node_wheel_front_right_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_front_right_8.position.set(0.0, 0.65, 0.0);
    node_wheel_front_right_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_front_right_8.userData.sculptComponent = {"id": "wheel-front-right", "name": "WheelFrontRight", "level": "meso", "role": "wheel", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "wheel-mount-front", "attachment": {"parentSocket": "axle-right", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.15, "depth": 0.5, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.65, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.15, 0.5]}, "material": "wheel-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WheelFrontRight", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(42, 26, 16, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "spoked wheel wood grain + hub bevel", "strength": 0.3, "scale": 15.0}, "roughnessVariation": {"pattern": "worn rim", "amount": 0.15}}};
  node_wheel_front_right_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-mount-front"] ?? root).add(node_wheel_front_right_8);
  nodes["wheel-front-right"] = node_wheel_front_right_8;
  const mesh_wheel_front_right_8Geometry = endpoint_wheel_front_right_8
    ? new THREE.CylinderGeometry(endpoint_wheel_front_right_8.endRadius, endpoint_wheel_front_right_8.baseRadius, endpoint_wheel_front_right_8.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_front_right_8) {
    mesh_wheel_front_right_8Geometry.scale(0.5, 0.15, 0.5);
  }
  const mesh_wheel_front_right_8 = new THREE.Mesh(
    mesh_wheel_front_right_8Geometry,
    materialMap["wheel-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_right_8.name = "WheelFrontRight";
  if (endpoint_wheel_front_right_8) {
    mesh_wheel_front_right_8.position.copy(endpoint_wheel_front_right_8.midpoint);
    mesh_wheel_front_right_8.quaternion.copy(endpoint_wheel_front_right_8.quaternion);
  }
  mesh_wheel_front_right_8.castShadow = options.castShadow ?? true;
  mesh_wheel_front_right_8.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_right_8.userData.sculptComponent = {"id": "wheel-front-right", "name": "WheelFrontRight", "level": "meso", "role": "wheel", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "wheel-mount-front", "attachment": {"parentSocket": "axle-right", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.15, "depth": 0.5, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.65, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.15, 0.5]}, "material": "wheel-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WheelFrontRight", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(42, 26, 16, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "spoked wheel wood grain + hub bevel", "strength": 0.3, "scale": 15.0}, "roughnessVariation": {"pattern": "worn rim", "amount": 0.15}}};
  node_wheel_front_right_8.add(mesh_wheel_front_right_8);
  meshes["wheel-front-right"] = mesh_wheel_front_right_8;
  colliders["wheel-front-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-front-right"] ??= [];
  destructionGroups["wheel-front-right"].push(node_wheel_front_right_8);

  const attachment_wheel_rear_left_9 = {"parentSocket": "axle-left", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_rear_left_9 = makeAttachmentEndpoint(attachment_wheel_rear_left_9);
  const node_wheel_rear_left_9 = new THREE.Group();
  node_wheel_rear_left_9.name = "WheelRearLeft__pivot";
  node_wheel_rear_left_9.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_left_9) {
    node_wheel_rear_left_9.position.copy(endpoint_wheel_rear_left_9.start);
    node_wheel_rear_left_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_rear_left_9.position.set(0.0, -0.65, 0.0);
    node_wheel_rear_left_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_rear_left_9.userData.sculptComponent = {"id": "wheel-rear-left", "name": "WheelRearLeft", "level": "meso", "role": "wheel", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "wheel-mount-rear", "attachment": {"parentSocket": "axle-left", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.15, "depth": 0.5, "units": "world", "confidence": 0.8}, "transform": {"position": [0, -0.65, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.15, 0.5]}, "material": "wheel-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WheelRearLeft", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(42, 26, 16, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "spoked wheel wood grain + hub bevel", "strength": 0.3, "scale": 15.0}, "roughnessVariation": {"pattern": "worn rim", "amount": 0.15}}};
  node_wheel_rear_left_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-mount-rear"] ?? root).add(node_wheel_rear_left_9);
  nodes["wheel-rear-left"] = node_wheel_rear_left_9;
  const mesh_wheel_rear_left_9Geometry = endpoint_wheel_rear_left_9
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_left_9.endRadius, endpoint_wheel_rear_left_9.baseRadius, endpoint_wheel_rear_left_9.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_rear_left_9) {
    mesh_wheel_rear_left_9Geometry.scale(0.5, 0.15, 0.5);
  }
  const mesh_wheel_rear_left_9 = new THREE.Mesh(
    mesh_wheel_rear_left_9Geometry,
    materialMap["wheel-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_left_9.name = "WheelRearLeft";
  if (endpoint_wheel_rear_left_9) {
    mesh_wheel_rear_left_9.position.copy(endpoint_wheel_rear_left_9.midpoint);
    mesh_wheel_rear_left_9.quaternion.copy(endpoint_wheel_rear_left_9.quaternion);
  }
  mesh_wheel_rear_left_9.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_left_9.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_left_9.userData.sculptComponent = {"id": "wheel-rear-left", "name": "WheelRearLeft", "level": "meso", "role": "wheel", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "wheel-mount-rear", "attachment": {"parentSocket": "axle-left", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.15, "depth": 0.5, "units": "world", "confidence": 0.8}, "transform": {"position": [0, -0.65, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.15, 0.5]}, "material": "wheel-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WheelRearLeft", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(42, 26, 16, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "spoked wheel wood grain + hub bevel", "strength": 0.3, "scale": 15.0}, "roughnessVariation": {"pattern": "worn rim", "amount": 0.15}}};
  node_wheel_rear_left_9.add(mesh_wheel_rear_left_9);
  meshes["wheel-rear-left"] = mesh_wheel_rear_left_9;
  colliders["wheel-rear-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-rear-left"] ??= [];
  destructionGroups["wheel-rear-left"].push(node_wheel_rear_left_9);

  const attachment_wheel_rear_right_10 = {"parentSocket": "axle-right", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_rear_right_10 = makeAttachmentEndpoint(attachment_wheel_rear_right_10);
  const node_wheel_rear_right_10 = new THREE.Group();
  node_wheel_rear_right_10.name = "WheelRearRight__pivot";
  node_wheel_rear_right_10.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_right_10) {
    node_wheel_rear_right_10.position.copy(endpoint_wheel_rear_right_10.start);
    node_wheel_rear_right_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_rear_right_10.position.set(0.0, 0.65, 0.0);
    node_wheel_rear_right_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_rear_right_10.userData.sculptComponent = {"id": "wheel-rear-right", "name": "WheelRearRight", "level": "meso", "role": "wheel", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "wheel-mount-rear", "attachment": {"parentSocket": "axle-right", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.15, "depth": 0.5, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.65, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.15, 0.5]}, "material": "wheel-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WheelRearRight", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(42, 26, 16, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "spoked wheel wood grain + hub bevel", "strength": 0.3, "scale": 15.0}, "roughnessVariation": {"pattern": "worn rim", "amount": 0.15}}};
  node_wheel_rear_right_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["wheel-mount-rear"] ?? root).add(node_wheel_rear_right_10);
  nodes["wheel-rear-right"] = node_wheel_rear_right_10;
  const mesh_wheel_rear_right_10Geometry = endpoint_wheel_rear_right_10
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_right_10.endRadius, endpoint_wheel_rear_right_10.baseRadius, endpoint_wheel_rear_right_10.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_wheel_rear_right_10) {
    mesh_wheel_rear_right_10Geometry.scale(0.5, 0.15, 0.5);
  }
  const mesh_wheel_rear_right_10 = new THREE.Mesh(
    mesh_wheel_rear_right_10Geometry,
    materialMap["wheel-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_right_10.name = "WheelRearRight";
  if (endpoint_wheel_rear_right_10) {
    mesh_wheel_rear_right_10.position.copy(endpoint_wheel_rear_right_10.midpoint);
    mesh_wheel_rear_right_10.quaternion.copy(endpoint_wheel_rear_right_10.quaternion);
  }
  mesh_wheel_rear_right_10.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_right_10.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_right_10.userData.sculptComponent = {"id": "wheel-rear-right", "name": "WheelRearRight", "level": "meso", "role": "wheel", "importance": 0.6, "confidence": 0.82, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "wheel-mount-rear", "attachment": {"parentSocket": "axle-right", "contactType": "axle", "embedDepth": 0.15, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.15, "depth": 0.5, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.65, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.15, 0.5]}, "material": "wheel-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WheelRearRight", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 32, 1.0)", "secondaryAlbedo": "rgba(42, 26, 16, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "spoked wheel wood grain + hub bevel", "strength": 0.3, "scale": 15.0}, "roughnessVariation": {"pattern": "worn rim", "amount": 0.15}}};
  node_wheel_rear_right_10.add(mesh_wheel_rear_right_10);
  meshes["wheel-rear-right"] = mesh_wheel_rear_right_10;
  colliders["wheel-rear-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-rear-right"] ??= [];
  destructionGroups["wheel-rear-right"].push(node_wheel_rear_right_10);

  const attachment_coupling_front_11 = {"parentSocket": "chassis-front", "contactType": "bolted", "embedDepth": 0.05, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coupling_front_11 = makeAttachmentEndpoint(attachment_coupling_front_11);
  const node_coupling_front_11 = new THREE.Group();
  node_coupling_front_11.name = "CouplingFront__pivot";
  node_coupling_front_11.scale.set(1, 1, 1);
  if (endpoint_coupling_front_11) {
    node_coupling_front_11.position.copy(endpoint_coupling_front_11.start);
    node_coupling_front_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coupling_front_11.position.set(-1.65, 0.0, 0.0);
    node_coupling_front_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_coupling_front_11.userData.sculptComponent = {"id": "coupling-front", "name": "CouplingFront", "level": "meso", "role": "coupling", "importance": 0.55, "confidence": 0.85, "primitive": "cylinder", "parent": "chassis", "attachment": {"parentSocket": "chassis-front", "contactType": "bolted", "embedDepth": 0.05, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-1.65, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "coupling-metal", "evidenceRefs": ["full-object"], "children": ["coupling-head", "coupling-disc"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 90, 90, 1.0)", "secondaryAlbedo": "rgba(68, 68, 68, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupling-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for CouplingFront"};
  node_coupling_front_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupling-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_coupling_front_11);
  nodes["coupling-front"] = node_coupling_front_11;
  const mesh_coupling_front_11Geometry = endpoint_coupling_front_11
    ? new THREE.CylinderGeometry(endpoint_coupling_front_11.endRadius, endpoint_coupling_front_11.baseRadius, endpoint_coupling_front_11.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_coupling_front_11) {
    mesh_coupling_front_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_coupling_front_11 = new THREE.Mesh(
    mesh_coupling_front_11Geometry,
    materialMap["coupling-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coupling_front_11.name = "CouplingFront";
  if (endpoint_coupling_front_11) {
    mesh_coupling_front_11.position.copy(endpoint_coupling_front_11.midpoint);
    mesh_coupling_front_11.quaternion.copy(endpoint_coupling_front_11.quaternion);
  }
  mesh_coupling_front_11.castShadow = options.castShadow ?? true;
  mesh_coupling_front_11.receiveShadow = options.receiveShadow ?? true;
  mesh_coupling_front_11.visible = false; // 容器节点不渲染
  mesh_coupling_front_11.userData.sculptComponent = {"id": "coupling-front", "name": "CouplingFront", "level": "meso", "role": "coupling", "importance": 0.55, "confidence": 0.85, "primitive": "cylinder", "parent": "chassis", "attachment": {"parentSocket": "chassis-front", "contactType": "bolted", "embedDepth": 0.05, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-1.65, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "coupling-metal", "evidenceRefs": ["full-object"], "children": ["coupling-head", "coupling-disc"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 90, 90, 1.0)", "secondaryAlbedo": "rgba(68, 68, 68, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupling-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for CouplingFront"};
  node_coupling_front_11.add(mesh_coupling_front_11);
  meshes["coupling-front"] = mesh_coupling_front_11;
  colliders["coupling-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coupling-front"] ??= [];
  destructionGroups["coupling-front"].push(node_coupling_front_11);

  const endpoint_coupling_head_12 = makeAttachmentEndpoint(null);
  const node_coupling_head_12 = new THREE.Group();
  node_coupling_head_12.name = "CouplingHead__pivot";
  node_coupling_head_12.scale.set(1, 1, 1);
  if (endpoint_coupling_head_12) {
    node_coupling_head_12.position.copy(endpoint_coupling_head_12.start);
    node_coupling_head_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coupling_head_12.position.set(-0.15, 0.0, 0.0);
    node_coupling_head_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_coupling_head_12.userData.sculptComponent = {"id": "coupling-head", "name": "CouplingHead", "level": "meso", "role": "coupling-part", "importance": 0.5, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "coupling-front", "attachment": {"parentSocket": "coupling-front-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.15, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.15, 0, 0], "rotation": [0, 0, 0], "scale": [0.2, 0.15, 0.12]}, "material": "coupling-metal", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for CouplingHead", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 90, 90, 1.0)", "secondaryAlbedo": "rgba(68, 68, 68, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupling-head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupling_head_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupling-head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["coupling-front"] ?? root).add(node_coupling_head_12);
  nodes["coupling-head"] = node_coupling_head_12;
  const mesh_coupling_head_12Geometry = endpoint_coupling_head_12
    ? new THREE.CylinderGeometry(endpoint_coupling_head_12.endRadius, endpoint_coupling_head_12.baseRadius, endpoint_coupling_head_12.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_coupling_head_12) {
    mesh_coupling_head_12Geometry.scale(0.2, 0.15, 0.12);
  }
  const mesh_coupling_head_12 = new THREE.Mesh(
    mesh_coupling_head_12Geometry,
    materialMap["coupling-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coupling_head_12.name = "CouplingHead";
  if (endpoint_coupling_head_12) {
    mesh_coupling_head_12.position.copy(endpoint_coupling_head_12.midpoint);
    mesh_coupling_head_12.quaternion.copy(endpoint_coupling_head_12.quaternion);
  }
  mesh_coupling_head_12.castShadow = options.castShadow ?? true;
  mesh_coupling_head_12.receiveShadow = options.receiveShadow ?? true;
  mesh_coupling_head_12.userData.sculptComponent = {"id": "coupling-head", "name": "CouplingHead", "level": "meso", "role": "coupling-part", "importance": 0.5, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "coupling-front", "attachment": {"parentSocket": "coupling-front-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.15, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.15, 0, 0], "rotation": [0, 0, 0], "scale": [0.2, 0.15, 0.12]}, "material": "coupling-metal", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for CouplingHead", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 90, 90, 1.0)", "secondaryAlbedo": "rgba(68, 68, 68, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupling-head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupling_head_12.add(mesh_coupling_head_12);
  meshes["coupling-head"] = mesh_coupling_head_12;
  colliders["coupling-head"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coupling-head"] ??= [];
  destructionGroups["coupling-head"].push(node_coupling_head_12);

  const attachment_coupling_disc_13 = {"parentSocket": "coupling-front-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coupling_disc_13 = makeAttachmentEndpoint(attachment_coupling_disc_13);
  const node_coupling_disc_13 = new THREE.Group();
  node_coupling_disc_13.name = "CouplingDisc__pivot";
  node_coupling_disc_13.scale.set(1, 1, 1);
  if (endpoint_coupling_disc_13) {
    node_coupling_disc_13.position.copy(endpoint_coupling_disc_13.start);
    node_coupling_disc_13.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_coupling_disc_13.position.set(0.0, 0.0, 0.0);
    node_coupling_disc_13.rotation.set(0.0, 0.0, 1.5708);
  }
  node_coupling_disc_13.userData.sculptComponent = {"id": "coupling-disc", "name": "CouplingDisc", "level": "meso", "role": "coupling-part", "importance": 0.5, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "coupling-front", "attachment": {"parentSocket": "coupling-front-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.05, "height": 0.25, "depth": 0.25, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 1.5708], "scale": [0.05, 0.25, 0.25]}, "material": "coupling-metal", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for CouplingDisc", "colorMaterialRecipe": {"dominantAlbedo": "rgba(68, 68, 85, 1.0)", "secondaryAlbedo": "rgba(90, 90, 90, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupling-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupling_disc_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupling-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["coupling-front"] ?? root).add(node_coupling_disc_13);
  nodes["coupling-disc"] = node_coupling_disc_13;
  const mesh_coupling_disc_13Geometry = endpoint_coupling_disc_13
    ? new THREE.CylinderGeometry(endpoint_coupling_disc_13.endRadius, endpoint_coupling_disc_13.baseRadius, endpoint_coupling_disc_13.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_coupling_disc_13) {
    mesh_coupling_disc_13Geometry.scale(0.05, 0.25, 0.25);
  }
  const mesh_coupling_disc_13 = new THREE.Mesh(
    mesh_coupling_disc_13Geometry,
    materialMap["coupling-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coupling_disc_13.name = "CouplingDisc";
  if (endpoint_coupling_disc_13) {
    mesh_coupling_disc_13.position.copy(endpoint_coupling_disc_13.midpoint);
    mesh_coupling_disc_13.quaternion.copy(endpoint_coupling_disc_13.quaternion);
  }
  mesh_coupling_disc_13.castShadow = options.castShadow ?? true;
  mesh_coupling_disc_13.receiveShadow = options.receiveShadow ?? true;
  mesh_coupling_disc_13.userData.sculptComponent = {"id": "coupling-disc", "name": "CouplingDisc", "level": "meso", "role": "coupling-part", "importance": 0.5, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "coupling-front", "attachment": {"parentSocket": "coupling-front-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.05, "height": 0.25, "depth": 0.25, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 1.5708], "scale": [0.05, 0.25, 0.25]}, "material": "coupling-metal", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for CouplingDisc", "colorMaterialRecipe": {"dominantAlbedo": "rgba(68, 68, 85, 1.0)", "secondaryAlbedo": "rgba(90, 90, 90, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupling-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupling_disc_13.add(mesh_coupling_disc_13);
  meshes["coupling-disc"] = mesh_coupling_disc_13;
  colliders["coupling-disc"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coupling-disc"] ??= [];
  destructionGroups["coupling-disc"].push(node_coupling_disc_13);

  const attachment_roof_assembly_14 = {"parentSocket": "body-top", "contactType": "sitting", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_roof_assembly_14 = makeAttachmentEndpoint(attachment_roof_assembly_14);
  const node_roof_assembly_14 = new THREE.Group();
  node_roof_assembly_14.name = "RoofAssembly__pivot";
  node_roof_assembly_14.scale.set(1, 1, 1);
  if (endpoint_roof_assembly_14) {
    node_roof_assembly_14.position.copy(endpoint_roof_assembly_14.start);
    node_roof_assembly_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_assembly_14.position.set(0.0, 1.3, 0.0);
    node_roof_assembly_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_assembly_14.userData.sculptComponent = {"id": "roof-assembly", "name": "RoofAssembly", "level": "macro", "role": "roof", "importance": 0.85, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "caravan-root", "attachment": {"parentSocket": "body-top", "contactType": "sitting", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0, 1.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "roof-material", "evidenceRefs": ["full-object"], "children": ["roof-shell", "chimney"], "topologyRationale": "Solid geometry for RoofAssembly", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 216, 112, 1.0)", "secondaryAlbedo": "rgba(232, 160, 176, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_roof_assembly_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["caravan-root"] ?? root).add(node_roof_assembly_14);
  nodes["roof-assembly"] = node_roof_assembly_14;
  const mesh_roof_assembly_14Geometry = endpoint_roof_assembly_14
    ? new THREE.CylinderGeometry(endpoint_roof_assembly_14.endRadius, endpoint_roof_assembly_14.baseRadius, endpoint_roof_assembly_14.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_roof_assembly_14) {
    mesh_roof_assembly_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_roof_assembly_14 = new THREE.Mesh(
    mesh_roof_assembly_14Geometry,
    materialMap["roof-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_assembly_14.name = "RoofAssembly";
  if (endpoint_roof_assembly_14) {
    mesh_roof_assembly_14.position.copy(endpoint_roof_assembly_14.midpoint);
    mesh_roof_assembly_14.quaternion.copy(endpoint_roof_assembly_14.quaternion);
  }
  mesh_roof_assembly_14.castShadow = options.castShadow ?? true;
  mesh_roof_assembly_14.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_assembly_14.visible = false; // 容器节点不渲染
  mesh_roof_assembly_14.userData.sculptComponent = {"id": "roof-assembly", "name": "RoofAssembly", "level": "macro", "role": "roof", "importance": 0.85, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "caravan-root", "attachment": {"parentSocket": "body-top", "contactType": "sitting", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0, 1.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "roof-material", "evidenceRefs": ["full-object"], "children": ["roof-shell", "chimney"], "topologyRationale": "Solid geometry for RoofAssembly", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 216, 112, 1.0)", "secondaryAlbedo": "rgba(232, 160, 176, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_roof_assembly_14.add(mesh_roof_assembly_14);
  meshes["roof-assembly"] = mesh_roof_assembly_14;
  colliders["roof-assembly"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-assembly"] ??= [];
  destructionGroups["roof-assembly"].push(node_roof_assembly_14);

  const endpoint_roof_shell_15 = makeAttachmentEndpoint(null);
  const node_roof_shell_15 = new THREE.Group();
  node_roof_shell_15.name = "RoofShell__pivot";
  node_roof_shell_15.scale.set(1, 1, 1);
  if (endpoint_roof_shell_15) {
    node_roof_shell_15.position.copy(endpoint_roof_shell_15.start);
    node_roof_shell_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_shell_15.position.set(0.0, 0.25, 0.0);
    node_roof_shell_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_shell_15.userData.sculptComponent = {"id": "roof-shell", "name": "RoofShell", "level": "macro", "role": "roof-surface", "importance": 0.85, "confidence": 0.88, "primitive": "extrude", "topologyClass": "assembled-solid", "parent": "roof-assembly", "attachment": {"parentSocket": "roof-assembly-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.1, "height": 0.5, "depth": 1.6, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.25, 0], "rotation": [0, 0, 0], "scale": [3.1, 0.5, 1.6]}, "geometryDescriptor": {"topologyIntent": "arc profile extruded along width, single continuous curve from left to right eaves", "edgeTreatment": {"type": "round", "bevelRadius": 0.03, "segments": 2}, "uvStrategy": "box-projection"}, "material": "roof-material", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for RoofShell", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 216, 112, 1.0)", "secondaryAlbedo": "rgba(232, 184, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "arc shingle seams + paper grain", "strength": 0.2, "scale": 10.0}, "roughnessVariation": {"pattern": "seams slightly rougher", "amount": 0.12}}};
  node_roof_shell_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["roof-assembly"] ?? root).add(node_roof_shell_15);
  nodes["roof-shell"] = node_roof_shell_15;
  const mesh_roof_shell_15Geometry = endpoint_roof_shell_15
    ? new THREE.CylinderGeometry(endpoint_roof_shell_15.endRadius, endpoint_roof_shell_15.baseRadius, endpoint_roof_shell_15.length, 16, 6)
    : buildExtrudeGeometry((() => {const rx = 0.8, ry = 0.5;const pts = [];for (let i = 0; i <= 20; i++) { const t = (i / 20) * Math.PI; pts.push([Math.cos(t) * rx, Math.sin(t) * ry]); }return { points: pts, depth: 3.1 };})());
  if (!endpoint_roof_shell_15) {
    mesh_roof_shell_15Geometry.translate(0, 0, -1.55); // 沿挤出轴居中
  }
  const mesh_roof_shell_15 = new THREE.Mesh(
    mesh_roof_shell_15Geometry,
    materialMap["roof-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_shell_15.name = "RoofShell";
  mesh_roof_shell_15.rotation.y = Math.PI / 2;
mesh_roof_shell_15.position.set(0, -0.26, 0);

  mesh_roof_shell_15.castShadow = options.castShadow ?? true;
  mesh_roof_shell_15.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_shell_15.userData.sculptComponent = {"id": "roof-shell", "name": "RoofShell", "level": "macro", "role": "roof-surface", "importance": 0.85, "confidence": 0.88, "primitive": "extrude", "topologyClass": "assembled-solid", "parent": "roof-assembly", "attachment": {"parentSocket": "roof-assembly-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.1, "height": 0.5, "depth": 1.6, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.25, 0], "rotation": [0, 0, 0], "scale": [3.1, 0.5, 1.6]}, "geometryDescriptor": {"topologyIntent": "arc profile extruded along width, single continuous curve from left to right eaves", "edgeTreatment": {"type": "round", "bevelRadius": 0.03, "segments": 2}, "uvStrategy": "box-projection"}, "material": "roof-material", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for RoofShell", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 216, 112, 1.0)", "secondaryAlbedo": "rgba(232, 184, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "arc shingle seams + paper grain", "strength": 0.2, "scale": 10.0}, "roughnessVariation": {"pattern": "seams slightly rougher", "amount": 0.12}}};
  node_roof_shell_15.add(mesh_roof_shell_15);
  meshes["roof-shell"] = mesh_roof_shell_15;
  colliders["roof-shell"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-shell"] ??= [];
  destructionGroups["roof-shell"].push(node_roof_shell_15);

  const attachment_chimney_16 = {"parentSocket": "roof-front-left", "contactType": "embedded", "embedDepth": 0.1, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_chimney_16 = makeAttachmentEndpoint(attachment_chimney_16);
  const node_chimney_16 = new THREE.Group();
  node_chimney_16.name = "Chimney__pivot";
  node_chimney_16.scale.set(1, 1, 1);
  if (endpoint_chimney_16) {
    node_chimney_16.position.copy(endpoint_chimney_16.start);
    node_chimney_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chimney_16.position.set(-0.8, 0.5, -0.3);
    node_chimney_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_chimney_16.userData.sculptComponent = {"id": "chimney", "name": "Chimney", "level": "meso", "role": "chimney", "importance": 0.7, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "roof-assembly", "attachment": {"parentSocket": "roof-front-left", "contactType": "embedded", "embedDepth": 0.1, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-0.8, 0.5, -0.3], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "chimney-stone", "evidenceRefs": ["full-object"], "children": ["chimney-base", "chimney-body", "chimney-cap"], "topologyRationale": "Solid geometry for Chimney", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 122, 106, 1.0)", "secondaryAlbedo": "rgba(106, 90, 74, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chimney_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["roof-assembly"] ?? root).add(node_chimney_16);
  nodes["chimney"] = node_chimney_16;
  const mesh_chimney_16Geometry = endpoint_chimney_16
    ? new THREE.CylinderGeometry(endpoint_chimney_16.endRadius, endpoint_chimney_16.baseRadius, endpoint_chimney_16.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_chimney_16) {
    mesh_chimney_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chimney_16 = new THREE.Mesh(
    mesh_chimney_16Geometry,
    materialMap["chimney-stone"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chimney_16.name = "Chimney";
  if (endpoint_chimney_16) {
    mesh_chimney_16.position.copy(endpoint_chimney_16.midpoint);
    mesh_chimney_16.quaternion.copy(endpoint_chimney_16.quaternion);
  }
  mesh_chimney_16.castShadow = options.castShadow ?? true;
  mesh_chimney_16.receiveShadow = options.receiveShadow ?? true;
  mesh_chimney_16.visible = false; // 容器节点不渲染
  mesh_chimney_16.userData.sculptComponent = {"id": "chimney", "name": "Chimney", "level": "meso", "role": "chimney", "importance": 0.7, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "roof-assembly", "attachment": {"parentSocket": "roof-front-left", "contactType": "embedded", "embedDepth": 0.1, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-0.8, 0.5, -0.3], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "chimney-stone", "evidenceRefs": ["full-object"], "children": ["chimney-base", "chimney-body", "chimney-cap"], "topologyRationale": "Solid geometry for Chimney", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 122, 106, 1.0)", "secondaryAlbedo": "rgba(106, 90, 74, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chimney_16.add(mesh_chimney_16);
  meshes["chimney"] = mesh_chimney_16;
  colliders["chimney"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["chimney"] ??= [];
  destructionGroups["chimney"].push(node_chimney_16);

  const attachment_chimney_base_17 = {"parentSocket": "chimney-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_chimney_base_17 = makeAttachmentEndpoint(attachment_chimney_base_17);
  const node_chimney_base_17 = new THREE.Group();
  node_chimney_base_17.name = "ChimneyBase__pivot";
  node_chimney_base_17.scale.set(1, 1, 1);
  if (endpoint_chimney_base_17) {
    node_chimney_base_17.position.copy(endpoint_chimney_base_17.start);
    node_chimney_base_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chimney_base_17.position.set(0.0, 0.0, 0.0);
    node_chimney_base_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_chimney_base_17.userData.sculptComponent = {"id": "chimney-base", "name": "ChimneyBase", "level": "meso", "role": "chimney-part", "importance": 0.6, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chimney", "attachment": {"parentSocket": "chimney-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.18, "height": 0.12, "depth": 0.18, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.18, 0.12, 0.18]}, "material": "chimney-stone", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for ChimneyBase", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 122, 106, 1.0)", "secondaryAlbedo": "rgba(106, 90, 74, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "stone roughness", "strength": 0.4, "scale": 16.0}, "roughnessVariation": {"pattern": "stone patches", "amount": 0.12}}};
  node_chimney_base_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chimney"] ?? root).add(node_chimney_base_17);
  nodes["chimney-base"] = node_chimney_base_17;
  const mesh_chimney_base_17Geometry = endpoint_chimney_base_17
    ? new THREE.CylinderGeometry(endpoint_chimney_base_17.endRadius, endpoint_chimney_base_17.baseRadius, endpoint_chimney_base_17.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_chimney_base_17) {
    mesh_chimney_base_17Geometry.scale(0.18, 0.12, 0.18);
  }
  const mesh_chimney_base_17 = new THREE.Mesh(
    mesh_chimney_base_17Geometry,
    materialMap["chimney-stone"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chimney_base_17.name = "ChimneyBase";
  if (endpoint_chimney_base_17) {
    mesh_chimney_base_17.position.copy(endpoint_chimney_base_17.midpoint);
    mesh_chimney_base_17.quaternion.copy(endpoint_chimney_base_17.quaternion);
  }
  mesh_chimney_base_17.castShadow = options.castShadow ?? true;
  mesh_chimney_base_17.receiveShadow = options.receiveShadow ?? true;
  mesh_chimney_base_17.userData.sculptComponent = {"id": "chimney-base", "name": "ChimneyBase", "level": "meso", "role": "chimney-part", "importance": 0.6, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chimney", "attachment": {"parentSocket": "chimney-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.18, "height": 0.12, "depth": 0.18, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.18, 0.12, 0.18]}, "material": "chimney-stone", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for ChimneyBase", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 122, 106, 1.0)", "secondaryAlbedo": "rgba(106, 90, 74, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "stone roughness", "strength": 0.4, "scale": 16.0}, "roughnessVariation": {"pattern": "stone patches", "amount": 0.12}}};
  node_chimney_base_17.add(mesh_chimney_base_17);
  meshes["chimney-base"] = mesh_chimney_base_17;
  colliders["chimney-base"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["chimney-base"] ??= [];
  destructionGroups["chimney-base"].push(node_chimney_base_17);

  const attachment_chimney_body_18 = {"parentSocket": "chimney-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_chimney_body_18 = makeAttachmentEndpoint(attachment_chimney_body_18);
  const node_chimney_body_18 = new THREE.Group();
  node_chimney_body_18.name = "ChimneyBody__pivot";
  node_chimney_body_18.scale.set(1, 1, 1);
  if (endpoint_chimney_body_18) {
    node_chimney_body_18.position.copy(endpoint_chimney_body_18.start);
    node_chimney_body_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chimney_body_18.position.set(0.0, 0.18, 0.0);
    node_chimney_body_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_chimney_body_18.userData.sculptComponent = {"id": "chimney-body", "name": "ChimneyBody", "level": "meso", "role": "chimney-part", "importance": 0.6, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chimney", "attachment": {"parentSocket": "chimney-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.25, "depth": 0.12, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.18, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.25, 0.12]}, "material": "chimney-stone", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for ChimneyBody", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 122, 106, 1.0)", "secondaryAlbedo": "rgba(106, 90, 74, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chimney_body_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chimney"] ?? root).add(node_chimney_body_18);
  nodes["chimney-body"] = node_chimney_body_18;
  const mesh_chimney_body_18Geometry = endpoint_chimney_body_18
    ? new THREE.CylinderGeometry(endpoint_chimney_body_18.endRadius, endpoint_chimney_body_18.baseRadius, endpoint_chimney_body_18.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_chimney_body_18) {
    mesh_chimney_body_18Geometry.scale(0.12, 0.25, 0.12);
  }
  const mesh_chimney_body_18 = new THREE.Mesh(
    mesh_chimney_body_18Geometry,
    materialMap["chimney-stone"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chimney_body_18.name = "ChimneyBody";
  if (endpoint_chimney_body_18) {
    mesh_chimney_body_18.position.copy(endpoint_chimney_body_18.midpoint);
    mesh_chimney_body_18.quaternion.copy(endpoint_chimney_body_18.quaternion);
  }
  mesh_chimney_body_18.castShadow = options.castShadow ?? true;
  mesh_chimney_body_18.receiveShadow = options.receiveShadow ?? true;
  mesh_chimney_body_18.userData.sculptComponent = {"id": "chimney-body", "name": "ChimneyBody", "level": "meso", "role": "chimney-part", "importance": 0.6, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chimney", "attachment": {"parentSocket": "chimney-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.25, "depth": 0.12, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.18, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.25, 0.12]}, "material": "chimney-stone", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for ChimneyBody", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 122, 106, 1.0)", "secondaryAlbedo": "rgba(106, 90, 74, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chimney_body_18.add(mesh_chimney_body_18);
  meshes["chimney-body"] = mesh_chimney_body_18;
  colliders["chimney-body"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["chimney-body"] ??= [];
  destructionGroups["chimney-body"].push(node_chimney_body_18);

  const attachment_chimney_cap_19 = {"parentSocket": "chimney-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_chimney_cap_19 = makeAttachmentEndpoint(attachment_chimney_cap_19);
  const node_chimney_cap_19 = new THREE.Group();
  node_chimney_cap_19.name = "ChimneyCap__pivot";
  node_chimney_cap_19.scale.set(1, 1, 1);
  if (endpoint_chimney_cap_19) {
    node_chimney_cap_19.position.copy(endpoint_chimney_cap_19.start);
    node_chimney_cap_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chimney_cap_19.position.set(0.0, 0.33, 0.0);
    node_chimney_cap_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_chimney_cap_19.userData.sculptComponent = {"id": "chimney-cap", "name": "ChimneyCap", "level": "meso", "role": "chimney-part", "importance": 0.6, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chimney", "attachment": {"parentSocket": "chimney-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.18, "height": 0.06, "depth": 0.18, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.33, 0], "rotation": [0, 0, 0], "scale": [0.18, 0.06, 0.18]}, "material": "chimney-stone", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for ChimneyCap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 106, 90, 1.0)", "secondaryAlbedo": "rgba(138, 122, 106, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chimney_cap_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chimney"] ?? root).add(node_chimney_cap_19);
  nodes["chimney-cap"] = node_chimney_cap_19;
  const mesh_chimney_cap_19Geometry = endpoint_chimney_cap_19
    ? new THREE.CylinderGeometry(endpoint_chimney_cap_19.endRadius, endpoint_chimney_cap_19.baseRadius, endpoint_chimney_cap_19.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_chimney_cap_19) {
    mesh_chimney_cap_19Geometry.scale(0.18, 0.06, 0.18);
  }
  const mesh_chimney_cap_19 = new THREE.Mesh(
    mesh_chimney_cap_19Geometry,
    materialMap["chimney-stone"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chimney_cap_19.name = "ChimneyCap";
  if (endpoint_chimney_cap_19) {
    mesh_chimney_cap_19.position.copy(endpoint_chimney_cap_19.midpoint);
    mesh_chimney_cap_19.quaternion.copy(endpoint_chimney_cap_19.quaternion);
  }
  mesh_chimney_cap_19.castShadow = options.castShadow ?? true;
  mesh_chimney_cap_19.receiveShadow = options.receiveShadow ?? true;
  mesh_chimney_cap_19.userData.sculptComponent = {"id": "chimney-cap", "name": "ChimneyCap", "level": "meso", "role": "chimney-part", "importance": 0.6, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chimney", "attachment": {"parentSocket": "chimney-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.18, "height": 0.06, "depth": 0.18, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.33, 0], "rotation": [0, 0, 0], "scale": [0.18, 0.06, 0.18]}, "material": "chimney-stone", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for ChimneyCap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 106, 90, 1.0)", "secondaryAlbedo": "rgba(138, 122, 106, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chimney-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chimney_cap_19.add(mesh_chimney_cap_19);
  meshes["chimney-cap"] = mesh_chimney_cap_19;
  colliders["chimney-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["chimney-cap"] ??= [];
  destructionGroups["chimney-cap"].push(node_chimney_cap_19);

  const attachment_window_system_20 = {"parentSocket": "body-lateral", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_window_system_20 = makeAttachmentEndpoint(attachment_window_system_20);
  const node_window_system_20 = new THREE.Group();
  node_window_system_20.name = "WindowSystem__pivot";
  node_window_system_20.scale.set(1, 1, 1);
  if (endpoint_window_system_20) {
    node_window_system_20.position.copy(endpoint_window_system_20.start);
    node_window_system_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_system_20.position.set(0.0, 0.7, 0.0);
    node_window_system_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_system_20.userData.sculptComponent = {"id": "window-system", "name": "WindowSystem", "level": "meso", "role": "window-group", "importance": 0.8, "confidence": 0.9, "primitive": "cylinder", "parent": "caravan-root", "attachment": {"parentSocket": "body-lateral", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0, 0.7, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-01", "window-02", "window-03"], "repetition": {"type": "linear-array", "axis": "x", "count": 3, "spacing": 0.9, "offset": -0.9}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for WindowSystem", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_system_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["caravan-root"] ?? root).add(node_window_system_20);
  nodes["window-system"] = node_window_system_20;
  const mesh_window_system_20Geometry = endpoint_window_system_20
    ? new THREE.CylinderGeometry(endpoint_window_system_20.endRadius, endpoint_window_system_20.baseRadius, endpoint_window_system_20.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_window_system_20) {
    mesh_window_system_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_system_20 = new THREE.Mesh(
    mesh_window_system_20Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_system_20.name = "WindowSystem";
  if (endpoint_window_system_20) {
    mesh_window_system_20.position.copy(endpoint_window_system_20.midpoint);
    mesh_window_system_20.quaternion.copy(endpoint_window_system_20.quaternion);
  }
  mesh_window_system_20.castShadow = options.castShadow ?? true;
  mesh_window_system_20.receiveShadow = options.receiveShadow ?? true;
  mesh_window_system_20.visible = false; // 容器节点不渲染
  mesh_window_system_20.userData.sculptComponent = {"id": "window-system", "name": "WindowSystem", "level": "meso", "role": "window-group", "importance": 0.8, "confidence": 0.9, "primitive": "cylinder", "parent": "caravan-root", "attachment": {"parentSocket": "body-lateral", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0, 0.7, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-01", "window-02", "window-03"], "repetition": {"type": "linear-array", "axis": "x", "count": 3, "spacing": 0.9, "offset": -0.9}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for WindowSystem", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_system_20.add(mesh_window_system_20);
  meshes["window-system"] = mesh_window_system_20;
  colliders["window-system"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-system"] ??= [];
  destructionGroups["window-system"].push(node_window_system_20);

  const attachment_window_01_21 = {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_window_01_21 = makeAttachmentEndpoint(attachment_window_01_21);
  const node_window_01_21 = new THREE.Group();
  node_window_01_21.name = "Window01__pivot";
  node_window_01_21.scale.set(1, 1, 1);
  if (endpoint_window_01_21) {
    node_window_01_21.position.copy(endpoint_window_01_21.start);
    node_window_01_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_21.position.set(-0.9, 0.0, 0.78);
    node_window_01_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_21.userData.sculptComponent = {"id": "window-01", "name": "Window01", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-0.9, 0, 0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "topologyRationale": "Solid geometry for Window01", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_01_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_01_21);
  nodes["window-01"] = node_window_01_21;
  const mesh_window_01_21Geometry = endpoint_window_01_21
    ? new THREE.CylinderGeometry(endpoint_window_01_21.endRadius, endpoint_window_01_21.baseRadius, endpoint_window_01_21.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_window_01_21) {
    mesh_window_01_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_01_21 = new THREE.Mesh(
    mesh_window_01_21Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_21.name = "Window01";
  if (endpoint_window_01_21) {
    mesh_window_01_21.position.copy(endpoint_window_01_21.midpoint);
    mesh_window_01_21.quaternion.copy(endpoint_window_01_21.quaternion);
  }
  mesh_window_01_21.castShadow = options.castShadow ?? true;
  mesh_window_01_21.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_21.visible = false; // 容器节点不渲染
  mesh_window_01_21.userData.sculptComponent = {"id": "window-01", "name": "Window01", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-0.9, 0, 0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "topologyRationale": "Solid geometry for Window01", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_01_21.add(mesh_window_01_21);
  meshes["window-01"] = mesh_window_01_21;
  colliders["window-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01"] ??= [];
  destructionGroups["window-01"].push(node_window_01_21);

  const endpoint_window_frame_22 = makeAttachmentEndpoint(null);
  const node_window_frame_22 = new THREE.Group();
  node_window_frame_22.name = "WindowFrame__pivot";
  node_window_frame_22.scale.set(1, 1, 1);
  if (endpoint_window_frame_22) {
    node_window_frame_22.position.copy(endpoint_window_frame_22.start);
    node_window_frame_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_frame_22.position.set(0.0, 0.0, 0.0);
    node_window_frame_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_frame_22.userData.sculptComponent = {"id": "window-frame", "name": "WindowFrame", "level": "meso", "role": "frame", "importance": 0.7, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.06]}, "geometryDescriptor": {"topologyIntent": "hollow frame, outer dims 0.5x0.5, inner cutout 0.4x0.4, depth 0.06", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.005, "segments": 1}}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowFrame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "wood grain along frame", "strength": 0.3, "scale": 18.0}, "roughnessVariation": {"pattern": "grain sheen variation", "amount": 0.1}}};
  node_window_frame_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_frame_22);
  nodes["window-frame"] = node_window_frame_22;
  const mesh_window_frame_22Geometry = endpoint_window_frame_22
    ? new THREE.CylinderGeometry(endpoint_window_frame_22.endRadius, endpoint_window_frame_22.baseRadius, endpoint_window_frame_22.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_frame_22) {
    mesh_window_frame_22Geometry.scale(0.5, 0.5, 0.06);
  }
  const mesh_window_frame_22 = new THREE.Mesh(
    mesh_window_frame_22Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_frame_22.name = "WindowFrame";
  if (endpoint_window_frame_22) {
    mesh_window_frame_22.position.copy(endpoint_window_frame_22.midpoint);
    mesh_window_frame_22.quaternion.copy(endpoint_window_frame_22.quaternion);
  }
  mesh_window_frame_22.castShadow = options.castShadow ?? true;
  mesh_window_frame_22.receiveShadow = options.receiveShadow ?? true;
  mesh_window_frame_22.userData.sculptComponent = {"id": "window-frame", "name": "WindowFrame", "level": "meso", "role": "frame", "importance": 0.7, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.06]}, "geometryDescriptor": {"topologyIntent": "hollow frame, outer dims 0.5x0.5, inner cutout 0.4x0.4, depth 0.06", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.005, "segments": 1}}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowFrame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "wood grain along frame", "strength": 0.3, "scale": 18.0}, "roughnessVariation": {"pattern": "grain sheen variation", "amount": 0.1}}};
  node_window_frame_22.add(mesh_window_frame_22);
  meshes["window-frame"] = mesh_window_frame_22;
  colliders["window-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_frame_22);

  const endpoint_window_glass_23 = makeAttachmentEndpoint(null);
  const node_window_glass_23 = new THREE.Group();
  node_window_glass_23.name = "WindowGlass__pivot";
  node_window_glass_23.scale.set(1, 1, 1);
  if (endpoint_window_glass_23) {
    node_window_glass_23.position.copy(endpoint_window_glass_23.start);
    node_window_glass_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_glass_23.position.set(0.0, 0.0, 0.045);
    node_window_glass_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_glass_23.userData.sculptComponent = {"id": "window-glass", "name": "WindowGlass", "level": "meso", "role": "glass", "importance": 0.75, "confidence": 0.92, "primitive": "plane-card", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 0, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowGlass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_glass_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_glass_23);
  nodes["window-glass"] = node_window_glass_23;
  const mesh_window_glass_23Geometry = endpoint_window_glass_23
    ? new THREE.CylinderGeometry(endpoint_window_glass_23.endRadius, endpoint_window_glass_23.baseRadius, endpoint_window_glass_23.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_window_glass_23) {
    mesh_window_glass_23Geometry.scale(0.4, 0.4, 0.01);
  }
  const mesh_window_glass_23 = new THREE.Mesh(
    mesh_window_glass_23Geometry,
    materialMap["window-glass-emissive"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_glass_23.name = "WindowGlass";
  if (endpoint_window_glass_23) {
    mesh_window_glass_23.position.copy(endpoint_window_glass_23.midpoint);
    mesh_window_glass_23.quaternion.copy(endpoint_window_glass_23.quaternion);
  }
  mesh_window_glass_23.castShadow = options.castShadow ?? true;
  mesh_window_glass_23.receiveShadow = options.receiveShadow ?? true;
  mesh_window_glass_23.userData.sculptComponent = {"id": "window-glass", "name": "WindowGlass", "level": "meso", "role": "glass", "importance": 0.75, "confidence": 0.92, "primitive": "plane-card", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 0, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowGlass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_glass_23.add(mesh_window_glass_23);
  meshes["window-glass"] = mesh_window_glass_23;
  colliders["window-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-glass"] ??= [];
  destructionGroups["window-glass"].push(node_window_glass_23);

  const endpoint_window_cross_h_24 = makeAttachmentEndpoint(null);
  const node_window_cross_h_24 = new THREE.Group();
  node_window_cross_h_24.name = "WindowCrossH__pivot";
  node_window_cross_h_24.scale.set(1, 1, 1);
  if (endpoint_window_cross_h_24) {
    node_window_cross_h_24.position.copy(endpoint_window_cross_h_24.start);
    node_window_cross_h_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_cross_h_24.position.set(0.0, 0.0, 0.06);
    node_window_cross_h_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_cross_h_24.userData.sculptComponent = {"id": "window-cross-h", "name": "WindowCrossH", "level": "meso", "role": "cross-divider", "importance": 0.5, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowCrossH", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-h", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_cross_h_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-h", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_cross_h_24);
  nodes["window-cross-h"] = node_window_cross_h_24;
  const mesh_window_cross_h_24Geometry = endpoint_window_cross_h_24
    ? new THREE.CylinderGeometry(endpoint_window_cross_h_24.endRadius, endpoint_window_cross_h_24.baseRadius, endpoint_window_cross_h_24.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_cross_h_24) {
    mesh_window_cross_h_24Geometry.scale(0.4, 0.03, 0.03);
  }
  const mesh_window_cross_h_24 = new THREE.Mesh(
    mesh_window_cross_h_24Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_cross_h_24.name = "WindowCrossH";
  if (endpoint_window_cross_h_24) {
    mesh_window_cross_h_24.position.copy(endpoint_window_cross_h_24.midpoint);
    mesh_window_cross_h_24.quaternion.copy(endpoint_window_cross_h_24.quaternion);
  }
  mesh_window_cross_h_24.castShadow = options.castShadow ?? true;
  mesh_window_cross_h_24.receiveShadow = options.receiveShadow ?? true;
  mesh_window_cross_h_24.userData.sculptComponent = {"id": "window-cross-h", "name": "WindowCrossH", "level": "meso", "role": "cross-divider", "importance": 0.5, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowCrossH", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-h", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_cross_h_24.add(mesh_window_cross_h_24);
  meshes["window-cross-h"] = mesh_window_cross_h_24;
  colliders["window-cross-h"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-cross-h"] ??= [];
  destructionGroups["window-cross-h"].push(node_window_cross_h_24);

  const endpoint_window_cross_v_25 = makeAttachmentEndpoint(null);
  const node_window_cross_v_25 = new THREE.Group();
  node_window_cross_v_25.name = "WindowCrossV__pivot";
  node_window_cross_v_25.scale.set(1, 1, 1);
  if (endpoint_window_cross_v_25) {
    node_window_cross_v_25.position.copy(endpoint_window_cross_v_25.start);
    node_window_cross_v_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_cross_v_25.position.set(0.0, 0.0, 0.06);
    node_window_cross_v_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_cross_v_25.userData.sculptComponent = {"id": "window-cross-v", "name": "WindowCrossV", "level": "meso", "role": "cross-divider", "importance": 0.5, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowCrossV", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-v", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_cross_v_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-v", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_cross_v_25);
  nodes["window-cross-v"] = node_window_cross_v_25;
  const mesh_window_cross_v_25Geometry = endpoint_window_cross_v_25
    ? new THREE.CylinderGeometry(endpoint_window_cross_v_25.endRadius, endpoint_window_cross_v_25.baseRadius, endpoint_window_cross_v_25.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_cross_v_25) {
    mesh_window_cross_v_25Geometry.scale(0.03, 0.4, 0.03);
  }
  const mesh_window_cross_v_25 = new THREE.Mesh(
    mesh_window_cross_v_25Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_cross_v_25.name = "WindowCrossV";
  if (endpoint_window_cross_v_25) {
    mesh_window_cross_v_25.position.copy(endpoint_window_cross_v_25.midpoint);
    mesh_window_cross_v_25.quaternion.copy(endpoint_window_cross_v_25.quaternion);
  }
  mesh_window_cross_v_25.castShadow = options.castShadow ?? true;
  mesh_window_cross_v_25.receiveShadow = options.receiveShadow ?? true;
  mesh_window_cross_v_25.userData.sculptComponent = {"id": "window-cross-v", "name": "WindowCrossV", "level": "meso", "role": "cross-divider", "importance": 0.5, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowCrossV", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-v", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_cross_v_25.add(mesh_window_cross_v_25);
  meshes["window-cross-v"] = mesh_window_cross_v_25;
  colliders["window-cross-v"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-cross-v"] ??= [];
  destructionGroups["window-cross-v"].push(node_window_cross_v_25);

  const endpoint_window_sill_26 = makeAttachmentEndpoint(null);
  const node_window_sill_26 = new THREE.Group();
  node_window_sill_26.name = "WindowSill__pivot";
  node_window_sill_26.scale.set(1, 1, 1);
  if (endpoint_window_sill_26) {
    node_window_sill_26.position.copy(endpoint_window_sill_26.start);
    node_window_sill_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_sill_26.position.set(0.0, -0.27, -0.02);
    node_window_sill_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_sill_26.userData.sculptComponent = {"id": "window-sill", "name": "WindowSill", "level": "meso", "role": "sill", "importance": 0.5, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 0, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowSill", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-sill", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_sill_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-sill", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_sill_26);
  nodes["window-sill"] = node_window_sill_26;
  const mesh_window_sill_26Geometry = endpoint_window_sill_26
    ? new THREE.CylinderGeometry(endpoint_window_sill_26.endRadius, endpoint_window_sill_26.baseRadius, endpoint_window_sill_26.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_sill_26) {
    mesh_window_sill_26Geometry.scale(0.55, 0.04, 0.08);
  }
  const mesh_window_sill_26 = new THREE.Mesh(
    mesh_window_sill_26Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_sill_26.name = "WindowSill";
  if (endpoint_window_sill_26) {
    mesh_window_sill_26.position.copy(endpoint_window_sill_26.midpoint);
    mesh_window_sill_26.quaternion.copy(endpoint_window_sill_26.quaternion);
  }
  mesh_window_sill_26.castShadow = options.castShadow ?? true;
  mesh_window_sill_26.receiveShadow = options.receiveShadow ?? true;
  mesh_window_sill_26.userData.sculptComponent = {"id": "window-sill", "name": "WindowSill", "level": "meso", "role": "sill", "importance": 0.5, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 0, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowSill", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-sill", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_sill_26.add(mesh_window_sill_26);
  meshes["window-sill"] = mesh_window_sill_26;
  colliders["window-sill"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-sill"] ??= [];
  destructionGroups["window-sill"].push(node_window_sill_26);

  const attachment_window_02_27 = {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_window_02_27 = makeAttachmentEndpoint(attachment_window_02_27);
  const node_window_02_27 = new THREE.Group();
  node_window_02_27.name = "Window02__pivot";
  node_window_02_27.scale.set(1, 1, 1);
  if (endpoint_window_02_27) {
    node_window_02_27.position.copy(endpoint_window_02_27.start);
    node_window_02_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_27.position.set(0.0, 0.0, 0.78);
    node_window_02_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_27.userData.sculptComponent = {"id": "window-02", "name": "Window02", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0, 0, 0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for Window02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_02_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_02_27);
  nodes["window-02"] = node_window_02_27;
  const mesh_window_02_27Geometry = endpoint_window_02_27
    ? new THREE.CylinderGeometry(endpoint_window_02_27.endRadius, endpoint_window_02_27.baseRadius, endpoint_window_02_27.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_window_02_27) {
    mesh_window_02_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_02_27 = new THREE.Mesh(
    mesh_window_02_27Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_27.name = "Window02";
  if (endpoint_window_02_27) {
    mesh_window_02_27.position.copy(endpoint_window_02_27.midpoint);
    mesh_window_02_27.quaternion.copy(endpoint_window_02_27.quaternion);
  }
  mesh_window_02_27.castShadow = options.castShadow ?? true;
  mesh_window_02_27.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_27.visible = false; // 容器节点不渲染
  mesh_window_02_27.userData.sculptComponent = {"id": "window-02", "name": "Window02", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0, 0, 0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for Window02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_02_27.add(mesh_window_02_27);
  meshes["window-02"] = mesh_window_02_27;
  colliders["window-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02"] ??= [];
  destructionGroups["window-02"].push(node_window_02_27);

  const attachment_window_03_28 = {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_window_03_28 = makeAttachmentEndpoint(attachment_window_03_28);
  const node_window_03_28 = new THREE.Group();
  node_window_03_28.name = "Window03__pivot";
  node_window_03_28.scale.set(1, 1, 1);
  if (endpoint_window_03_28) {
    node_window_03_28.position.copy(endpoint_window_03_28.start);
    node_window_03_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_28.position.set(0.9, 0.0, 0.78);
    node_window_03_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_28.userData.sculptComponent = {"id": "window-03", "name": "Window03", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0.9, 0, 0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for Window03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_03_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_03_28);
  nodes["window-03"] = node_window_03_28;
  const mesh_window_03_28Geometry = endpoint_window_03_28
    ? new THREE.CylinderGeometry(endpoint_window_03_28.endRadius, endpoint_window_03_28.baseRadius, endpoint_window_03_28.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_window_03_28) {
    mesh_window_03_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_03_28 = new THREE.Mesh(
    mesh_window_03_28Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_28.name = "Window03";
  if (endpoint_window_03_28) {
    mesh_window_03_28.position.copy(endpoint_window_03_28.midpoint);
    mesh_window_03_28.quaternion.copy(endpoint_window_03_28.quaternion);
  }
  mesh_window_03_28.castShadow = options.castShadow ?? true;
  mesh_window_03_28.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_28.visible = false; // 容器节点不渲染
  mesh_window_03_28.userData.sculptComponent = {"id": "window-03", "name": "Window03", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0.9, 0, 0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for Window03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_03_28.add(mesh_window_03_28);
  meshes["window-03"] = mesh_window_03_28;
  colliders["window-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03"] ??= [];
  destructionGroups["window-03"].push(node_window_03_28);

  const attachment_vine_system_left_29 = {"parentSocket": "body-side-left", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "caravan-root"};
  const endpoint_vine_system_left_29 = makeAttachmentEndpoint(attachment_vine_system_left_29);
  const node_vine_system_left_29 = new THREE.Group();
  node_vine_system_left_29.name = "VineSystemLeft__pivot";
  node_vine_system_left_29.scale.set(1, 1, 1);
  if (endpoint_vine_system_left_29) {
    node_vine_system_left_29.position.copy(endpoint_vine_system_left_29.start);
    node_vine_system_left_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_system_left_29.position.set(0.5, 0.8, -0.78);
    node_vine_system_left_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_system_left_29.userData.sculptComponent = {"id": "vine-system-left", "name": "VineSystemLeft", "level": "meso", "role": "decoration-vine", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "parent": "caravan-root", "attachment": {"parentSocket": "body-side-left", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "caravan-root"}, "transform": {"position": [0.5, 0.8, -0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["vine-stem-1", "vine-stem-2", "vine-stem-3", "vine-flower-1", "vine-flower-2", "vine-flower-3", "vine-flower-4", "vine-leaf-1", "vine-leaf-2", "vine-leaf-3"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-system-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineSystemLeft", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(232, 138, 170, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}};
  node_vine_system_left_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-system-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["caravan-root"] ?? root).add(node_vine_system_left_29);
  nodes["vine-system-left"] = node_vine_system_left_29;
  const mesh_vine_system_left_29Geometry = endpoint_vine_system_left_29
    ? new THREE.CylinderGeometry(endpoint_vine_system_left_29.endRadius, endpoint_vine_system_left_29.baseRadius, endpoint_vine_system_left_29.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_system_left_29) {
    mesh_vine_system_left_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_vine_system_left_29 = new THREE.Mesh(
    mesh_vine_system_left_29Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_system_left_29.name = "VineSystemLeft";
  if (endpoint_vine_system_left_29) {
    mesh_vine_system_left_29.position.copy(endpoint_vine_system_left_29.midpoint);
    mesh_vine_system_left_29.quaternion.copy(endpoint_vine_system_left_29.quaternion);
  }
  mesh_vine_system_left_29.castShadow = options.castShadow ?? true;
  mesh_vine_system_left_29.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_system_left_29.visible = false; // 容器节点不渲染
  mesh_vine_system_left_29.userData.sculptComponent = {"id": "vine-system-left", "name": "VineSystemLeft", "level": "meso", "role": "decoration-vine", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "parent": "caravan-root", "attachment": {"parentSocket": "body-side-left", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "caravan-root"}, "transform": {"position": [0.5, 0.8, -0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["vine-stem-1", "vine-stem-2", "vine-stem-3", "vine-flower-1", "vine-flower-2", "vine-flower-3", "vine-flower-4", "vine-leaf-1", "vine-leaf-2", "vine-leaf-3"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-system-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineSystemLeft", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(232, 138, 170, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}};
  node_vine_system_left_29.add(mesh_vine_system_left_29);
  meshes["vine-system-left"] = mesh_vine_system_left_29;
  colliders["vine-system-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-system-left"] ??= [];
  destructionGroups["vine-system-left"].push(node_vine_system_left_29);

  const attachment_vine_system_right_30 = {"parentSocket": "body-side-right", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "caravan-root"};
  const endpoint_vine_system_right_30 = makeAttachmentEndpoint(attachment_vine_system_right_30);
  const node_vine_system_right_30 = new THREE.Group();
  node_vine_system_right_30.name = "VineSystemRight__pivot";
  node_vine_system_right_30.scale.set(1, 1, 1);
  if (endpoint_vine_system_right_30) {
    node_vine_system_right_30.position.copy(endpoint_vine_system_right_30.start);
    node_vine_system_right_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_system_right_30.position.set(0.0, 0.8, 0.78);
    node_vine_system_right_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_system_right_30.userData.sculptComponent = {"id": "vine-system-right", "name": "VineSystemRight", "level": "meso", "role": "decoration-vine", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "parent": "caravan-root", "attachment": {"parentSocket": "body-side-right", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "caravan-root"}, "transform": {"position": [0.0, 0.8, 0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "note": "Mirror of left vine system", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-system-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineSystemRight", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(232, 138, 170, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}};
  node_vine_system_right_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-system-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["caravan-root"] ?? root).add(node_vine_system_right_30);
  nodes["vine-system-right"] = node_vine_system_right_30;
  const mesh_vine_system_right_30Geometry = endpoint_vine_system_right_30
    ? new THREE.CylinderGeometry(endpoint_vine_system_right_30.endRadius, endpoint_vine_system_right_30.baseRadius, endpoint_vine_system_right_30.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_system_right_30) {
    mesh_vine_system_right_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_vine_system_right_30 = new THREE.Mesh(
    mesh_vine_system_right_30Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_system_right_30.name = "VineSystemRight";
  if (endpoint_vine_system_right_30) {
    mesh_vine_system_right_30.position.copy(endpoint_vine_system_right_30.midpoint);
    mesh_vine_system_right_30.quaternion.copy(endpoint_vine_system_right_30.quaternion);
  }
  mesh_vine_system_right_30.castShadow = options.castShadow ?? true;
  mesh_vine_system_right_30.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_system_right_30.visible = false; // 容器节点不渲染
  mesh_vine_system_right_30.userData.sculptComponent = {"id": "vine-system-right", "name": "VineSystemRight", "level": "meso", "role": "decoration-vine", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "parent": "caravan-root", "attachment": {"parentSocket": "body-side-right", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "caravan-root"}, "transform": {"position": [0.0, 0.8, 0.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "note": "Mirror of left vine system", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-system-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineSystemRight", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(232, 138, 170, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}};
  node_vine_system_right_30.add(mesh_vine_system_right_30);
  meshes["vine-system-right"] = mesh_vine_system_right_30;
  colliders["vine-system-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-system-right"] ??= [];
  destructionGroups["vine-system-right"].push(node_vine_system_right_30);

  const attachment_vine_stem_1_31 = {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"};
  const endpoint_vine_stem_1_31 = makeAttachmentEndpoint(attachment_vine_stem_1_31);
  const node_vine_stem_1_31 = new THREE.Group();
  node_vine_stem_1_31.name = "VineStem1__pivot";
  node_vine_stem_1_31.scale.set(1, 1, 1);
  if (endpoint_vine_stem_1_31) {
    node_vine_stem_1_31.position.copy(endpoint_vine_stem_1_31.start);
    node_vine_stem_1_31.rotation.set(0.0, 0.0, 0.08727);
  } else {
    node_vine_stem_1_31.position.set(0.0, 0.0, 0.0);
    node_vine_stem_1_31.rotation.set(0.0, 0.0, 0.08727);
  }
  node_vine_stem_1_31.userData.sculptComponent = {"id": "vine-stem-1", "name": "VineStem1", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.1056, "height": 0.8, "depth": 0.1056, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.08727], "scale": [0.1056, 0.8, 0.1056]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_1_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_stem_1_31);
  nodes["vine-stem-1"] = node_vine_stem_1_31;
  const mesh_vine_stem_1_31Geometry = endpoint_vine_stem_1_31
    ? new THREE.CylinderGeometry(endpoint_vine_stem_1_31.endRadius, endpoint_vine_stem_1_31.baseRadius, endpoint_vine_stem_1_31.length, 16, 6)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_vine_stem_1_31) {
    mesh_vine_stem_1_31Geometry.scale(0.1056, 0.8, 0.1056);
  }
  const mesh_vine_stem_1_31 = new THREE.Mesh(
    mesh_vine_stem_1_31Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_stem_1_31.name = "VineStem1";
  if (endpoint_vine_stem_1_31) {
    mesh_vine_stem_1_31.position.copy(endpoint_vine_stem_1_31.midpoint);
    mesh_vine_stem_1_31.quaternion.copy(endpoint_vine_stem_1_31.quaternion);
  }
  mesh_vine_stem_1_31.castShadow = options.castShadow ?? true;
  mesh_vine_stem_1_31.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_stem_1_31.userData.sculptComponent = {"id": "vine-stem-1", "name": "VineStem1", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.1056, "height": 0.8, "depth": 0.1056, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.08727], "scale": [0.1056, 0.8, 0.1056]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_1_31.add(mesh_vine_stem_1_31);
  meshes["vine-stem-1"] = mesh_vine_stem_1_31;
  colliders["vine-stem-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-stem-1"] ??= [];
  destructionGroups["vine-stem-1"].push(node_vine_stem_1_31);

  const attachment_vine_stem_2_32 = {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"};
  const endpoint_vine_stem_2_32 = makeAttachmentEndpoint(attachment_vine_stem_2_32);
  const node_vine_stem_2_32 = new THREE.Group();
  node_vine_stem_2_32.name = "VineStem2__pivot";
  node_vine_stem_2_32.scale.set(1, 1, 1);
  if (endpoint_vine_stem_2_32) {
    node_vine_stem_2_32.position.copy(endpoint_vine_stem_2_32.start);
    node_vine_stem_2_32.rotation.set(0.0, 0.0, -0.05236);
  } else {
    node_vine_stem_2_32.position.set(0.3, 0.1, 0.0);
    node_vine_stem_2_32.rotation.set(0.0, 0.0, -0.05236);
  }
  node_vine_stem_2_32.userData.sculptComponent = {"id": "vine-stem-2", "name": "VineStem2", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.088, "height": 0.6, "depth": 0.088, "units": "world", "confidence": 0.8}, "transform": {"position": [0.3, 0.1, 0], "rotation": [0.0, 0.0, -0.05236], "scale": [0.088, 0.6, 0.088]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_2_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_stem_2_32);
  nodes["vine-stem-2"] = node_vine_stem_2_32;
  const mesh_vine_stem_2_32Geometry = endpoint_vine_stem_2_32
    ? new THREE.CylinderGeometry(endpoint_vine_stem_2_32.endRadius, endpoint_vine_stem_2_32.baseRadius, endpoint_vine_stem_2_32.length, 16, 6)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_vine_stem_2_32) {
    mesh_vine_stem_2_32Geometry.scale(0.088, 0.6, 0.088);
  }
  const mesh_vine_stem_2_32 = new THREE.Mesh(
    mesh_vine_stem_2_32Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_stem_2_32.name = "VineStem2";
  if (endpoint_vine_stem_2_32) {
    mesh_vine_stem_2_32.position.copy(endpoint_vine_stem_2_32.midpoint);
    mesh_vine_stem_2_32.quaternion.copy(endpoint_vine_stem_2_32.quaternion);
  }
  mesh_vine_stem_2_32.castShadow = options.castShadow ?? true;
  mesh_vine_stem_2_32.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_stem_2_32.userData.sculptComponent = {"id": "vine-stem-2", "name": "VineStem2", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.088, "height": 0.6, "depth": 0.088, "units": "world", "confidence": 0.8}, "transform": {"position": [0.3, 0.1, 0], "rotation": [0.0, 0.0, -0.05236], "scale": [0.088, 0.6, 0.088]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_2_32.add(mesh_vine_stem_2_32);
  meshes["vine-stem-2"] = mesh_vine_stem_2_32;
  colliders["vine-stem-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-stem-2"] ??= [];
  destructionGroups["vine-stem-2"].push(node_vine_stem_2_32);

  const attachment_vine_stem_3_33 = {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"};
  const endpoint_vine_stem_3_33 = makeAttachmentEndpoint(attachment_vine_stem_3_33);
  const node_vine_stem_3_33 = new THREE.Group();
  node_vine_stem_3_33.name = "VineStem3__pivot";
  node_vine_stem_3_33.scale.set(1, 1, 1);
  if (endpoint_vine_stem_3_33) {
    node_vine_stem_3_33.position.copy(endpoint_vine_stem_3_33.start);
    node_vine_stem_3_33.rotation.set(0.0, 0.0, 0.13963);
  } else {
    node_vine_stem_3_33.position.set(-0.2, 0.15, 0.0);
    node_vine_stem_3_33.rotation.set(0.0, 0.0, 0.13963);
  }
  node_vine_stem_3_33.userData.sculptComponent = {"id": "vine-stem-3", "name": "VineStem3", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.0704, "height": 0.5, "depth": 0.0704, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.2, 0.15, 0], "rotation": [0.0, 0.0, 0.13963], "scale": [0.0704, 0.5, 0.0704]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_3_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_stem_3_33);
  nodes["vine-stem-3"] = node_vine_stem_3_33;
  const mesh_vine_stem_3_33Geometry = endpoint_vine_stem_3_33
    ? new THREE.CylinderGeometry(endpoint_vine_stem_3_33.endRadius, endpoint_vine_stem_3_33.baseRadius, endpoint_vine_stem_3_33.length, 16, 6)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_vine_stem_3_33) {
    mesh_vine_stem_3_33Geometry.scale(0.0704, 0.5, 0.0704);
  }
  const mesh_vine_stem_3_33 = new THREE.Mesh(
    mesh_vine_stem_3_33Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_stem_3_33.name = "VineStem3";
  if (endpoint_vine_stem_3_33) {
    mesh_vine_stem_3_33.position.copy(endpoint_vine_stem_3_33.midpoint);
    mesh_vine_stem_3_33.quaternion.copy(endpoint_vine_stem_3_33.quaternion);
  }
  mesh_vine_stem_3_33.castShadow = options.castShadow ?? true;
  mesh_vine_stem_3_33.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_stem_3_33.userData.sculptComponent = {"id": "vine-stem-3", "name": "VineStem3", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.0704, "height": 0.5, "depth": 0.0704, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.2, 0.15, 0], "rotation": [0.0, 0.0, 0.13963], "scale": [0.0704, 0.5, 0.0704]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_3_33.add(mesh_vine_stem_3_33);
  meshes["vine-stem-3"] = mesh_vine_stem_3_33;
  colliders["vine-stem-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-stem-3"] ??= [];
  destructionGroups["vine-stem-3"].push(node_vine_stem_3_33);

  const attachment_vine_flower_1_34 = {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"};
  const endpoint_vine_flower_1_34 = makeAttachmentEndpoint(attachment_vine_flower_1_34);
  const node_vine_flower_1_34 = new THREE.Group();
  node_vine_flower_1_34.name = "VineFlower1__pivot";
  node_vine_flower_1_34.scale.set(1, 1, 1);
  if (endpoint_vine_flower_1_34) {
    node_vine_flower_1_34.position.copy(endpoint_vine_flower_1_34.start);
    node_vine_flower_1_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_flower_1_34.position.set(0.0, 0.35, 0.0);
    node_vine_flower_1_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_flower_1_34.userData.sculptComponent = {"id": "vine-flower-1", "name": "VineFlower1", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "transform": {"position": [0, 0.35, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "topologyRationale": "Solid geometry for VineFlower1", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_1_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_flower_1_34);
  nodes["vine-flower-1"] = node_vine_flower_1_34;
  const mesh_vine_flower_1_34Geometry = endpoint_vine_flower_1_34
    ? new THREE.CylinderGeometry(endpoint_vine_flower_1_34.endRadius, endpoint_vine_flower_1_34.baseRadius, endpoint_vine_flower_1_34.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_flower_1_34) {
    mesh_vine_flower_1_34Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_vine_flower_1_34 = new THREE.Mesh(
    mesh_vine_flower_1_34Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_1_34.name = "VineFlower1";
  if (endpoint_vine_flower_1_34) {
    mesh_vine_flower_1_34.position.copy(endpoint_vine_flower_1_34.midpoint);
    mesh_vine_flower_1_34.quaternion.copy(endpoint_vine_flower_1_34.quaternion);
  }
  mesh_vine_flower_1_34.castShadow = options.castShadow ?? true;
  mesh_vine_flower_1_34.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_1_34.visible = false; // 容器节点不渲染
  mesh_vine_flower_1_34.userData.sculptComponent = {"id": "vine-flower-1", "name": "VineFlower1", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "transform": {"position": [0, 0.35, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "topologyRationale": "Solid geometry for VineFlower1", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_1_34.add(mesh_vine_flower_1_34);
  meshes["vine-flower-1"] = mesh_vine_flower_1_34;
  colliders["vine-flower-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-flower-1"] ??= [];
  destructionGroups["vine-flower-1"].push(node_vine_flower_1_34);

  const attachment_vine_flower_2_35 = {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"};
  const endpoint_vine_flower_2_35 = makeAttachmentEndpoint(attachment_vine_flower_2_35);
  const node_vine_flower_2_35 = new THREE.Group();
  node_vine_flower_2_35.name = "VineFlower2__pivot";
  node_vine_flower_2_35.scale.set(1, 1, 1);
  if (endpoint_vine_flower_2_35) {
    node_vine_flower_2_35.position.copy(endpoint_vine_flower_2_35.start);
    node_vine_flower_2_35.rotation.set(0.0, 1.0472, 0.0);
  } else {
    node_vine_flower_2_35.position.set(0.3, 0.2, 0.0);
    node_vine_flower_2_35.rotation.set(0.0, 1.0472, 0.0);
  }
  node_vine_flower_2_35.userData.sculptComponent = {"id": "vine-flower-2", "name": "VineFlower2", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "transform": {"position": [0.3, 0.2, 0], "rotation": [0.0, 1.0472, 0.0], "scale": [0.8, 0.8, 0.8]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_2_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_flower_2_35);
  nodes["vine-flower-2"] = node_vine_flower_2_35;
  const mesh_vine_flower_2_35Geometry = endpoint_vine_flower_2_35
    ? new THREE.CylinderGeometry(endpoint_vine_flower_2_35.endRadius, endpoint_vine_flower_2_35.baseRadius, endpoint_vine_flower_2_35.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_flower_2_35) {
    mesh_vine_flower_2_35Geometry.scale(0.8, 0.8, 0.8);
  }
  const mesh_vine_flower_2_35 = new THREE.Mesh(
    mesh_vine_flower_2_35Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_2_35.name = "VineFlower2";
  if (endpoint_vine_flower_2_35) {
    mesh_vine_flower_2_35.position.copy(endpoint_vine_flower_2_35.midpoint);
    mesh_vine_flower_2_35.quaternion.copy(endpoint_vine_flower_2_35.quaternion);
  }
  mesh_vine_flower_2_35.castShadow = options.castShadow ?? true;
  mesh_vine_flower_2_35.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_2_35.visible = false; // 容器节点不渲染
  mesh_vine_flower_2_35.userData.sculptComponent = {"id": "vine-flower-2", "name": "VineFlower2", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "transform": {"position": [0.3, 0.2, 0], "rotation": [0.0, 1.0472, 0.0], "scale": [0.8, 0.8, 0.8]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_2_35.add(mesh_vine_flower_2_35);
  meshes["vine-flower-2"] = mesh_vine_flower_2_35;
  colliders["vine-flower-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-flower-2"] ??= [];
  destructionGroups["vine-flower-2"].push(node_vine_flower_2_35);

  const attachment_vine_flower_3_36 = {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"};
  const endpoint_vine_flower_3_36 = makeAttachmentEndpoint(attachment_vine_flower_3_36);
  const node_vine_flower_3_36 = new THREE.Group();
  node_vine_flower_3_36.name = "VineFlower3__pivot";
  node_vine_flower_3_36.scale.set(1, 1, 1);
  if (endpoint_vine_flower_3_36) {
    node_vine_flower_3_36.position.copy(endpoint_vine_flower_3_36.start);
    node_vine_flower_3_36.rotation.set(0.0, 2.0944, 0.0);
  } else {
    node_vine_flower_3_36.position.set(-0.15, 0.3, 0.0);
    node_vine_flower_3_36.rotation.set(0.0, 2.0944, 0.0);
  }
  node_vine_flower_3_36.userData.sculptComponent = {"id": "vine-flower-3", "name": "VineFlower3", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "transform": {"position": [-0.15, 0.3, 0], "rotation": [0.0, 2.0944, 0.0], "scale": [0.9, 0.9, 0.9]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_3_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_flower_3_36);
  nodes["vine-flower-3"] = node_vine_flower_3_36;
  const mesh_vine_flower_3_36Geometry = endpoint_vine_flower_3_36
    ? new THREE.CylinderGeometry(endpoint_vine_flower_3_36.endRadius, endpoint_vine_flower_3_36.baseRadius, endpoint_vine_flower_3_36.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_flower_3_36) {
    mesh_vine_flower_3_36Geometry.scale(0.9, 0.9, 0.9);
  }
  const mesh_vine_flower_3_36 = new THREE.Mesh(
    mesh_vine_flower_3_36Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_3_36.name = "VineFlower3";
  if (endpoint_vine_flower_3_36) {
    mesh_vine_flower_3_36.position.copy(endpoint_vine_flower_3_36.midpoint);
    mesh_vine_flower_3_36.quaternion.copy(endpoint_vine_flower_3_36.quaternion);
  }
  mesh_vine_flower_3_36.castShadow = options.castShadow ?? true;
  mesh_vine_flower_3_36.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_3_36.visible = false; // 容器节点不渲染
  mesh_vine_flower_3_36.userData.sculptComponent = {"id": "vine-flower-3", "name": "VineFlower3", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "transform": {"position": [-0.15, 0.3, 0], "rotation": [0.0, 2.0944, 0.0], "scale": [0.9, 0.9, 0.9]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_3_36.add(mesh_vine_flower_3_36);
  meshes["vine-flower-3"] = mesh_vine_flower_3_36;
  colliders["vine-flower-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-flower-3"] ??= [];
  destructionGroups["vine-flower-3"].push(node_vine_flower_3_36);

  const attachment_vine_flower_4_37 = {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"};
  const endpoint_vine_flower_4_37 = makeAttachmentEndpoint(attachment_vine_flower_4_37);
  const node_vine_flower_4_37 = new THREE.Group();
  node_vine_flower_4_37.name = "VineFlower4__pivot";
  node_vine_flower_4_37.scale.set(1, 1, 1);
  if (endpoint_vine_flower_4_37) {
    node_vine_flower_4_37.position.copy(endpoint_vine_flower_4_37.start);
    node_vine_flower_4_37.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_vine_flower_4_37.position.set(0.05, 0.1, 0.0);
    node_vine_flower_4_37.rotation.set(0.0, 3.14159, 0.0);
  }
  node_vine_flower_4_37.userData.sculptComponent = {"id": "vine-flower-4", "name": "VineFlower4", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "transform": {"position": [0.05, 0.1, 0], "rotation": [0.0, 3.14159, 0.0], "scale": [0.7, 0.7, 0.7]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(232, 138, 170, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_4_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_flower_4_37);
  nodes["vine-flower-4"] = node_vine_flower_4_37;
  const mesh_vine_flower_4_37Geometry = endpoint_vine_flower_4_37
    ? new THREE.CylinderGeometry(endpoint_vine_flower_4_37.endRadius, endpoint_vine_flower_4_37.baseRadius, endpoint_vine_flower_4_37.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_flower_4_37) {
    mesh_vine_flower_4_37Geometry.scale(0.7, 0.7, 0.7);
  }
  const mesh_vine_flower_4_37 = new THREE.Mesh(
    mesh_vine_flower_4_37Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_4_37.name = "VineFlower4";
  if (endpoint_vine_flower_4_37) {
    mesh_vine_flower_4_37.position.copy(endpoint_vine_flower_4_37.midpoint);
    mesh_vine_flower_4_37.quaternion.copy(endpoint_vine_flower_4_37.quaternion);
  }
  mesh_vine_flower_4_37.castShadow = options.castShadow ?? true;
  mesh_vine_flower_4_37.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_4_37.visible = false; // 容器节点不渲染
  mesh_vine_flower_4_37.userData.sculptComponent = {"id": "vine-flower-4", "name": "VineFlower4", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "transform": {"position": [0.05, 0.1, 0], "rotation": [0.0, 3.14159, 0.0], "scale": [0.7, 0.7, 0.7]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(232, 138, 170, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_4_37.add(mesh_vine_flower_4_37);
  meshes["vine-flower-4"] = mesh_vine_flower_4_37;
  colliders["vine-flower-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-flower-4"] ??= [];
  destructionGroups["vine-flower-4"].push(node_vine_flower_4_37);

  const endpoint_petal_1_38 = makeAttachmentEndpoint(null);
  const node_petal_1_38 = new THREE.Group();
  node_petal_1_38.name = "Petal1__pivot";
  node_petal_1_38.scale.set(1, 1, 1);
  if (endpoint_petal_1_38) {
    node_petal_1_38.position.copy(endpoint_petal_1_38.start);
    node_petal_1_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_petal_1_38.position.set(0.04, 0.0, 0.0);
    node_petal_1_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_petal_1_38.userData.sculptComponent = {"id": "petal-1", "name": "Petal1", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.04, 0, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_1_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-1"] ?? root).add(node_petal_1_38);
  nodes["petal-1"] = node_petal_1_38;
  const mesh_petal_1_38Geometry = endpoint_petal_1_38
    ? new THREE.CylinderGeometry(endpoint_petal_1_38.endRadius, endpoint_petal_1_38.baseRadius, endpoint_petal_1_38.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_petal_1_38) {
    mesh_petal_1_38Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_petal_1_38 = new THREE.Mesh(
    mesh_petal_1_38Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_petal_1_38.name = "Petal1";
  if (endpoint_petal_1_38) {
    mesh_petal_1_38.position.copy(endpoint_petal_1_38.midpoint);
    mesh_petal_1_38.quaternion.copy(endpoint_petal_1_38.quaternion);
  }
  mesh_petal_1_38.castShadow = options.castShadow ?? true;
  mesh_petal_1_38.receiveShadow = options.receiveShadow ?? true;
  mesh_petal_1_38.userData.sculptComponent = {"id": "petal-1", "name": "Petal1", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.04, 0, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_1_38.add(mesh_petal_1_38);
  meshes["petal-1"] = mesh_petal_1_38;
  colliders["petal-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-1"] ??= [];
  destructionGroups["petal-1"].push(node_petal_1_38);

  const endpoint_petal_2_39 = makeAttachmentEndpoint(null);
  const node_petal_2_39 = new THREE.Group();
  node_petal_2_39.name = "Petal2__pivot";
  node_petal_2_39.scale.set(1, 1, 1);
  if (endpoint_petal_2_39) {
    node_petal_2_39.position.copy(endpoint_petal_2_39.start);
    node_petal_2_39.rotation.set(0.0, 1.25664, 0.0);
  } else {
    node_petal_2_39.position.set(0.012, 0.0, 0.038);
    node_petal_2_39.rotation.set(0.0, 1.25664, 0.0);
  }
  node_petal_2_39.userData.sculptComponent = {"id": "petal-2", "name": "Petal2", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, 0.038], "rotation": [0.0, 1.25664, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(240, 176, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_2_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-1"] ?? root).add(node_petal_2_39);
  nodes["petal-2"] = node_petal_2_39;
  const mesh_petal_2_39Geometry = endpoint_petal_2_39
    ? new THREE.CylinderGeometry(endpoint_petal_2_39.endRadius, endpoint_petal_2_39.baseRadius, endpoint_petal_2_39.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_petal_2_39) {
    mesh_petal_2_39Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_petal_2_39 = new THREE.Mesh(
    mesh_petal_2_39Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_petal_2_39.name = "Petal2";
  if (endpoint_petal_2_39) {
    mesh_petal_2_39.position.copy(endpoint_petal_2_39.midpoint);
    mesh_petal_2_39.quaternion.copy(endpoint_petal_2_39.quaternion);
  }
  mesh_petal_2_39.castShadow = options.castShadow ?? true;
  mesh_petal_2_39.receiveShadow = options.receiveShadow ?? true;
  mesh_petal_2_39.userData.sculptComponent = {"id": "petal-2", "name": "Petal2", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, 0.038], "rotation": [0.0, 1.25664, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(240, 176, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_2_39.add(mesh_petal_2_39);
  meshes["petal-2"] = mesh_petal_2_39;
  colliders["petal-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-2"] ??= [];
  destructionGroups["petal-2"].push(node_petal_2_39);

  const endpoint_petal_3_40 = makeAttachmentEndpoint(null);
  const node_petal_3_40 = new THREE.Group();
  node_petal_3_40.name = "Petal3__pivot";
  node_petal_3_40.scale.set(1, 1, 1);
  if (endpoint_petal_3_40) {
    node_petal_3_40.position.copy(endpoint_petal_3_40.start);
    node_petal_3_40.rotation.set(0.0, 2.51327, 0.0);
  } else {
    node_petal_3_40.position.set(-0.032, 0.0, 0.024);
    node_petal_3_40.rotation.set(0.0, 2.51327, 0.0);
  }
  node_petal_3_40.userData.sculptComponent = {"id": "petal-3", "name": "Petal3", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, 0.024], "rotation": [0.0, 2.51327, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(176, 128, 208, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_3_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-1"] ?? root).add(node_petal_3_40);
  nodes["petal-3"] = node_petal_3_40;
  const mesh_petal_3_40Geometry = endpoint_petal_3_40
    ? new THREE.CylinderGeometry(endpoint_petal_3_40.endRadius, endpoint_petal_3_40.baseRadius, endpoint_petal_3_40.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_petal_3_40) {
    mesh_petal_3_40Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_petal_3_40 = new THREE.Mesh(
    mesh_petal_3_40Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_petal_3_40.name = "Petal3";
  if (endpoint_petal_3_40) {
    mesh_petal_3_40.position.copy(endpoint_petal_3_40.midpoint);
    mesh_petal_3_40.quaternion.copy(endpoint_petal_3_40.quaternion);
  }
  mesh_petal_3_40.castShadow = options.castShadow ?? true;
  mesh_petal_3_40.receiveShadow = options.receiveShadow ?? true;
  mesh_petal_3_40.userData.sculptComponent = {"id": "petal-3", "name": "Petal3", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, 0.024], "rotation": [0.0, 2.51327, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(176, 128, 208, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_3_40.add(mesh_petal_3_40);
  meshes["petal-3"] = mesh_petal_3_40;
  colliders["petal-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-3"] ??= [];
  destructionGroups["petal-3"].push(node_petal_3_40);

  const endpoint_petal_4_41 = makeAttachmentEndpoint(null);
  const node_petal_4_41 = new THREE.Group();
  node_petal_4_41.name = "Petal4__pivot";
  node_petal_4_41.scale.set(1, 1, 1);
  if (endpoint_petal_4_41) {
    node_petal_4_41.position.copy(endpoint_petal_4_41.start);
    node_petal_4_41.rotation.set(0.0, 3.76991, 0.0);
  } else {
    node_petal_4_41.position.set(-0.032, 0.0, -0.024);
    node_petal_4_41.rotation.set(0.0, 3.76991, 0.0);
  }
  node_petal_4_41.userData.sculptComponent = {"id": "petal-4", "name": "Petal4", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, -0.024], "rotation": [0.0, 3.76991, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(240, 224, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_4_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-1"] ?? root).add(node_petal_4_41);
  nodes["petal-4"] = node_petal_4_41;
  const mesh_petal_4_41Geometry = endpoint_petal_4_41
    ? new THREE.CylinderGeometry(endpoint_petal_4_41.endRadius, endpoint_petal_4_41.baseRadius, endpoint_petal_4_41.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_petal_4_41) {
    mesh_petal_4_41Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_petal_4_41 = new THREE.Mesh(
    mesh_petal_4_41Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_petal_4_41.name = "Petal4";
  if (endpoint_petal_4_41) {
    mesh_petal_4_41.position.copy(endpoint_petal_4_41.midpoint);
    mesh_petal_4_41.quaternion.copy(endpoint_petal_4_41.quaternion);
  }
  mesh_petal_4_41.castShadow = options.castShadow ?? true;
  mesh_petal_4_41.receiveShadow = options.receiveShadow ?? true;
  mesh_petal_4_41.userData.sculptComponent = {"id": "petal-4", "name": "Petal4", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, -0.024], "rotation": [0.0, 3.76991, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(240, 224, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_4_41.add(mesh_petal_4_41);
  meshes["petal-4"] = mesh_petal_4_41;
  colliders["petal-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-4"] ??= [];
  destructionGroups["petal-4"].push(node_petal_4_41);

  const endpoint_petal_5_42 = makeAttachmentEndpoint(null);
  const node_petal_5_42 = new THREE.Group();
  node_petal_5_42.name = "Petal5__pivot";
  node_petal_5_42.scale.set(1, 1, 1);
  if (endpoint_petal_5_42) {
    node_petal_5_42.position.copy(endpoint_petal_5_42.start);
    node_petal_5_42.rotation.set(0.0, 5.02655, 0.0);
  } else {
    node_petal_5_42.position.set(0.012, 0.0, -0.038);
    node_petal_5_42.rotation.set(0.0, 5.02655, 0.0);
  }
  node_petal_5_42.userData.sculptComponent = {"id": "petal-5", "name": "Petal5", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, -0.038], "rotation": [0.0, 5.02655, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal5", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_5_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-1"] ?? root).add(node_petal_5_42);
  nodes["petal-5"] = node_petal_5_42;
  const mesh_petal_5_42Geometry = endpoint_petal_5_42
    ? new THREE.CylinderGeometry(endpoint_petal_5_42.endRadius, endpoint_petal_5_42.baseRadius, endpoint_petal_5_42.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_petal_5_42) {
    mesh_petal_5_42Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_petal_5_42 = new THREE.Mesh(
    mesh_petal_5_42Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_petal_5_42.name = "Petal5";
  if (endpoint_petal_5_42) {
    mesh_petal_5_42.position.copy(endpoint_petal_5_42.midpoint);
    mesh_petal_5_42.quaternion.copy(endpoint_petal_5_42.quaternion);
  }
  mesh_petal_5_42.castShadow = options.castShadow ?? true;
  mesh_petal_5_42.receiveShadow = options.receiveShadow ?? true;
  mesh_petal_5_42.userData.sculptComponent = {"id": "petal-5", "name": "Petal5", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, -0.038], "rotation": [0.0, 5.02655, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal5", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_petal_5_42.add(mesh_petal_5_42);
  meshes["petal-5"] = mesh_petal_5_42;
  colliders["petal-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-5"] ??= [];
  destructionGroups["petal-5"].push(node_petal_5_42);

  const endpoint_flower_center_43 = makeAttachmentEndpoint(null);
  const node_flower_center_43 = new THREE.Group();
  node_flower_center_43.name = "FlowerCenter__pivot";
  node_flower_center_43.scale.set(1, 1, 1);
  if (endpoint_flower_center_43) {
    node_flower_center_43.position.copy(endpoint_flower_center_43.start);
    node_flower_center_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_flower_center_43.position.set(0.0, 0.0, 0.0);
    node_flower_center_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_flower_center_43.userData.sculptComponent = {"id": "flower-center", "name": "FlowerCenter", "level": "micro", "role": "flower-center", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.03, 0.03, 0.03]}, "material": "flower-center-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for FlowerCenter", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 200, 64, 1.0)", "secondaryAlbedo": "rgba(232, 216, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_flower_center_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-1"] ?? root).add(node_flower_center_43);
  nodes["flower-center"] = node_flower_center_43;
  const mesh_flower_center_43Geometry = endpoint_flower_center_43
    ? new THREE.CylinderGeometry(endpoint_flower_center_43.endRadius, endpoint_flower_center_43.baseRadius, endpoint_flower_center_43.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_flower_center_43) {
    mesh_flower_center_43Geometry.scale(0.03, 0.03, 0.03);
  }
  const mesh_flower_center_43 = new THREE.Mesh(
    mesh_flower_center_43Geometry,
    materialMap["flower-center-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_flower_center_43.name = "FlowerCenter";
  if (endpoint_flower_center_43) {
    mesh_flower_center_43.position.copy(endpoint_flower_center_43.midpoint);
    mesh_flower_center_43.quaternion.copy(endpoint_flower_center_43.quaternion);
  }
  mesh_flower_center_43.castShadow = options.castShadow ?? true;
  mesh_flower_center_43.receiveShadow = options.receiveShadow ?? true;
  mesh_flower_center_43.userData.sculptComponent = {"id": "flower-center", "name": "FlowerCenter", "level": "micro", "role": "flower-center", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-1", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.03, 0.03, 0.03]}, "material": "flower-center-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for FlowerCenter", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 200, 64, 1.0)", "secondaryAlbedo": "rgba(232, 216, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_flower_center_43.add(mesh_flower_center_43);
  meshes["flower-center"] = mesh_flower_center_43;
  colliders["flower-center"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["flower-center"] ??= [];
  destructionGroups["flower-center"].push(node_flower_center_43);

  const endpoint_vine_leaf_1_44 = makeAttachmentEndpoint(null);
  const node_vine_leaf_1_44 = new THREE.Group();
  node_vine_leaf_1_44.name = "VineLeaf1__pivot";
  node_vine_leaf_1_44.scale.set(1, 1, 1);
  if (endpoint_vine_leaf_1_44) {
    node_vine_leaf_1_44.position.copy(endpoint_vine_leaf_1_44.start);
    node_vine_leaf_1_44.rotation.set(0.0, 0.0, 0.5236);
  } else {
    node_vine_leaf_1_44.position.set(0.08, 0.15, 0.0);
    node_vine_leaf_1_44.rotation.set(0.0, 0.0, 0.5236);
  }
  node_vine_leaf_1_44.userData.sculptComponent = {"id": "vine-leaf-1", "name": "VineLeaf1", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.105, "height": 0.063, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0.08, 0.15, 0], "rotation": [0.0, 0.0, 0.5236], "scale": [0.105, 0.063, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_1_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_leaf_1_44);
  nodes["vine-leaf-1"] = node_vine_leaf_1_44;
  const mesh_vine_leaf_1_44Geometry = endpoint_vine_leaf_1_44
    ? new THREE.CylinderGeometry(endpoint_vine_leaf_1_44.endRadius, endpoint_vine_leaf_1_44.baseRadius, endpoint_vine_leaf_1_44.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_leaf_1_44) {
    mesh_vine_leaf_1_44Geometry.scale(0.105, 0.063, 0.01);
  }
  const mesh_vine_leaf_1_44 = new THREE.Mesh(
    mesh_vine_leaf_1_44Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_leaf_1_44.name = "VineLeaf1";
  if (endpoint_vine_leaf_1_44) {
    mesh_vine_leaf_1_44.position.copy(endpoint_vine_leaf_1_44.midpoint);
    mesh_vine_leaf_1_44.quaternion.copy(endpoint_vine_leaf_1_44.quaternion);
  }
  mesh_vine_leaf_1_44.castShadow = options.castShadow ?? true;
  mesh_vine_leaf_1_44.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_leaf_1_44.userData.sculptComponent = {"id": "vine-leaf-1", "name": "VineLeaf1", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.105, "height": 0.063, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0.08, 0.15, 0], "rotation": [0.0, 0.0, 0.5236], "scale": [0.105, 0.063, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_1_44.add(mesh_vine_leaf_1_44);
  meshes["vine-leaf-1"] = mesh_vine_leaf_1_44;
  colliders["vine-leaf-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-leaf-1"] ??= [];
  destructionGroups["vine-leaf-1"].push(node_vine_leaf_1_44);

  const endpoint_vine_leaf_2_45 = makeAttachmentEndpoint(null);
  const node_vine_leaf_2_45 = new THREE.Group();
  node_vine_leaf_2_45.name = "VineLeaf2__pivot";
  node_vine_leaf_2_45.scale.set(1, 1, 1);
  if (endpoint_vine_leaf_2_45) {
    node_vine_leaf_2_45.position.copy(endpoint_vine_leaf_2_45.start);
    node_vine_leaf_2_45.rotation.set(0.0, 0.0, -0.34907);
  } else {
    node_vine_leaf_2_45.position.set(0.22, 0.05, 0.0);
    node_vine_leaf_2_45.rotation.set(0.0, 0.0, -0.34907);
  }
  node_vine_leaf_2_45.userData.sculptComponent = {"id": "vine-leaf-2", "name": "VineLeaf2", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.084, "height": 0.0525, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0.22, 0.05, 0], "rotation": [0.0, 0.0, -0.34907], "scale": [0.084, 0.0525, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_2_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_leaf_2_45);
  nodes["vine-leaf-2"] = node_vine_leaf_2_45;
  const mesh_vine_leaf_2_45Geometry = endpoint_vine_leaf_2_45
    ? new THREE.CylinderGeometry(endpoint_vine_leaf_2_45.endRadius, endpoint_vine_leaf_2_45.baseRadius, endpoint_vine_leaf_2_45.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_leaf_2_45) {
    mesh_vine_leaf_2_45Geometry.scale(0.084, 0.0525, 0.01);
  }
  const mesh_vine_leaf_2_45 = new THREE.Mesh(
    mesh_vine_leaf_2_45Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_leaf_2_45.name = "VineLeaf2";
  if (endpoint_vine_leaf_2_45) {
    mesh_vine_leaf_2_45.position.copy(endpoint_vine_leaf_2_45.midpoint);
    mesh_vine_leaf_2_45.quaternion.copy(endpoint_vine_leaf_2_45.quaternion);
  }
  mesh_vine_leaf_2_45.castShadow = options.castShadow ?? true;
  mesh_vine_leaf_2_45.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_leaf_2_45.userData.sculptComponent = {"id": "vine-leaf-2", "name": "VineLeaf2", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.084, "height": 0.0525, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0.22, 0.05, 0], "rotation": [0.0, 0.0, -0.34907], "scale": [0.084, 0.0525, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_2_45.add(mesh_vine_leaf_2_45);
  meshes["vine-leaf-2"] = mesh_vine_leaf_2_45;
  colliders["vine-leaf-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-leaf-2"] ??= [];
  destructionGroups["vine-leaf-2"].push(node_vine_leaf_2_45);

  const endpoint_vine_leaf_3_46 = makeAttachmentEndpoint(null);
  const node_vine_leaf_3_46 = new THREE.Group();
  node_vine_leaf_3_46.name = "VineLeaf3__pivot";
  node_vine_leaf_3_46.scale.set(1, 1, 1);
  if (endpoint_vine_leaf_3_46) {
    node_vine_leaf_3_46.position.copy(endpoint_vine_leaf_3_46.start);
    node_vine_leaf_3_46.rotation.set(0.0, 0.0, 0.2618);
  } else {
    node_vine_leaf_3_46.position.set(-0.25, 0.08, 0.0);
    node_vine_leaf_3_46.rotation.set(0.0, 0.0, 0.2618);
  }
  node_vine_leaf_3_46.userData.sculptComponent = {"id": "vine-leaf-3", "name": "VineLeaf3", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.0945, "height": 0.0588, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.25, 0.08, 0], "rotation": [0.0, 0.0, 0.2618], "scale": [0.0945, 0.0588, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_3_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-right"] ?? root).add(node_vine_leaf_3_46);
  nodes["vine-leaf-3"] = node_vine_leaf_3_46;
  const mesh_vine_leaf_3_46Geometry = endpoint_vine_leaf_3_46
    ? new THREE.CylinderGeometry(endpoint_vine_leaf_3_46.endRadius, endpoint_vine_leaf_3_46.baseRadius, endpoint_vine_leaf_3_46.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_leaf_3_46) {
    mesh_vine_leaf_3_46Geometry.scale(0.0945, 0.0588, 0.01);
  }
  const mesh_vine_leaf_3_46 = new THREE.Mesh(
    mesh_vine_leaf_3_46Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_leaf_3_46.name = "VineLeaf3";
  if (endpoint_vine_leaf_3_46) {
    mesh_vine_leaf_3_46.position.copy(endpoint_vine_leaf_3_46.midpoint);
    mesh_vine_leaf_3_46.quaternion.copy(endpoint_vine_leaf_3_46.quaternion);
  }
  mesh_vine_leaf_3_46.castShadow = options.castShadow ?? true;
  mesh_vine_leaf_3_46.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_leaf_3_46.userData.sculptComponent = {"id": "vine-leaf-3", "name": "VineLeaf3", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-right", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-right"}, "dimensions": {"width": 0.0945, "height": 0.0588, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.25, 0.08, 0], "rotation": [0.0, 0.0, 0.2618], "scale": [0.0945, 0.0588, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_3_46.add(mesh_vine_leaf_3_46);
  meshes["vine-leaf-3"] = mesh_vine_leaf_3_46;
  colliders["vine-leaf-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-leaf-3"] ??= [];
  destructionGroups["vine-leaf-3"].push(node_vine_leaf_3_46);

  const endpoint_window_02_frame_47 = makeAttachmentEndpoint(null);
  const node_window_02_frame_47 = new THREE.Group();
  node_window_02_frame_47.name = "Window02Frame__pivot";
  node_window_02_frame_47.scale.set(1, 1, 1);
  if (endpoint_window_02_frame_47) {
    node_window_02_frame_47.position.copy(endpoint_window_02_frame_47.start);
    node_window_02_frame_47.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_frame_47.position.set(0.0, 0.0, 0.0);
    node_window_02_frame_47.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_frame_47.userData.sculptComponent = {"id": "window-02-frame", "name": "Window02Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.06]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_frame_47.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_frame_47);
  nodes["window-02-frame"] = node_window_02_frame_47;
  const mesh_window_02_frame_47Geometry = endpoint_window_02_frame_47
    ? new THREE.CylinderGeometry(endpoint_window_02_frame_47.endRadius, endpoint_window_02_frame_47.baseRadius, endpoint_window_02_frame_47.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_frame_47) {
    mesh_window_02_frame_47Geometry.scale(0.5, 0.5, 0.06);
  }
  const mesh_window_02_frame_47 = new THREE.Mesh(
    mesh_window_02_frame_47Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_frame_47.name = "Window02Frame";
  if (endpoint_window_02_frame_47) {
    mesh_window_02_frame_47.position.copy(endpoint_window_02_frame_47.midpoint);
    mesh_window_02_frame_47.quaternion.copy(endpoint_window_02_frame_47.quaternion);
  }
  mesh_window_02_frame_47.castShadow = options.castShadow ?? true;
  mesh_window_02_frame_47.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_frame_47.userData.sculptComponent = {"id": "window-02-frame", "name": "Window02Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.06]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_frame_47.add(mesh_window_02_frame_47);
  meshes["window-02-frame"] = mesh_window_02_frame_47;
  colliders["window-02-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_frame_47);

  const endpoint_window_02_glass_48 = makeAttachmentEndpoint(null);
  const node_window_02_glass_48 = new THREE.Group();
  node_window_02_glass_48.name = "Window02Glass__pivot";
  node_window_02_glass_48.scale.set(1, 1, 1);
  if (endpoint_window_02_glass_48) {
    node_window_02_glass_48.position.copy(endpoint_window_02_glass_48.start);
    node_window_02_glass_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_glass_48.position.set(0.0, 0.0, 0.045);
    node_window_02_glass_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_glass_48.userData.sculptComponent = {"id": "window-02-glass", "name": "Window02Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 0, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glass_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_glass_48);
  nodes["window-02-glass"] = node_window_02_glass_48;
  const mesh_window_02_glass_48Geometry = endpoint_window_02_glass_48
    ? new THREE.CylinderGeometry(endpoint_window_02_glass_48.endRadius, endpoint_window_02_glass_48.baseRadius, endpoint_window_02_glass_48.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_glass_48) {
    mesh_window_02_glass_48Geometry.scale(0.4, 0.4, 0.01);
  }
  const mesh_window_02_glass_48 = new THREE.Mesh(
    mesh_window_02_glass_48Geometry,
    materialMap["window-glass-emissive"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_glass_48.name = "Window02Glass";
  if (endpoint_window_02_glass_48) {
    mesh_window_02_glass_48.position.copy(endpoint_window_02_glass_48.midpoint);
    mesh_window_02_glass_48.quaternion.copy(endpoint_window_02_glass_48.quaternion);
  }
  mesh_window_02_glass_48.castShadow = options.castShadow ?? true;
  mesh_window_02_glass_48.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_glass_48.userData.sculptComponent = {"id": "window-02-glass", "name": "Window02Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 0, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glass_48.add(mesh_window_02_glass_48);
  meshes["window-02-glass"] = mesh_window_02_glass_48;
  colliders["window-02-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_glass_48);

  const endpoint_window_02_cross_h_49 = makeAttachmentEndpoint(null);
  const node_window_02_cross_h_49 = new THREE.Group();
  node_window_02_cross_h_49.name = "Window02CrossH__pivot";
  node_window_02_cross_h_49.scale.set(1, 1, 1);
  if (endpoint_window_02_cross_h_49) {
    node_window_02_cross_h_49.position.copy(endpoint_window_02_cross_h_49.start);
    node_window_02_cross_h_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_cross_h_49.position.set(0.0, 0.0, 0.06);
    node_window_02_cross_h_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_cross_h_49.userData.sculptComponent = {"id": "window-02-cross-h", "name": "Window02CrossH", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_cross_h_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_cross_h_49);
  nodes["window-02-cross-h"] = node_window_02_cross_h_49;
  const mesh_window_02_cross_h_49Geometry = endpoint_window_02_cross_h_49
    ? new THREE.CylinderGeometry(endpoint_window_02_cross_h_49.endRadius, endpoint_window_02_cross_h_49.baseRadius, endpoint_window_02_cross_h_49.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_cross_h_49) {
    mesh_window_02_cross_h_49Geometry.scale(0.4, 0.03, 0.03);
  }
  const mesh_window_02_cross_h_49 = new THREE.Mesh(
    mesh_window_02_cross_h_49Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_cross_h_49.name = "Window02CrossH";
  if (endpoint_window_02_cross_h_49) {
    mesh_window_02_cross_h_49.position.copy(endpoint_window_02_cross_h_49.midpoint);
    mesh_window_02_cross_h_49.quaternion.copy(endpoint_window_02_cross_h_49.quaternion);
  }
  mesh_window_02_cross_h_49.castShadow = options.castShadow ?? true;
  mesh_window_02_cross_h_49.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_cross_h_49.userData.sculptComponent = {"id": "window-02-cross-h", "name": "Window02CrossH", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_cross_h_49.add(mesh_window_02_cross_h_49);
  meshes["window-02-cross-h"] = mesh_window_02_cross_h_49;
  colliders["window-02-cross-h"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_cross_h_49);

  const endpoint_window_02_cross_v_50 = makeAttachmentEndpoint(null);
  const node_window_02_cross_v_50 = new THREE.Group();
  node_window_02_cross_v_50.name = "Window02CrossV__pivot";
  node_window_02_cross_v_50.scale.set(1, 1, 1);
  if (endpoint_window_02_cross_v_50) {
    node_window_02_cross_v_50.position.copy(endpoint_window_02_cross_v_50.start);
    node_window_02_cross_v_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_cross_v_50.position.set(0.0, 0.0, 0.06);
    node_window_02_cross_v_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_cross_v_50.userData.sculptComponent = {"id": "window-02-cross-v", "name": "Window02CrossV", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_cross_v_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_cross_v_50);
  nodes["window-02-cross-v"] = node_window_02_cross_v_50;
  const mesh_window_02_cross_v_50Geometry = endpoint_window_02_cross_v_50
    ? new THREE.CylinderGeometry(endpoint_window_02_cross_v_50.endRadius, endpoint_window_02_cross_v_50.baseRadius, endpoint_window_02_cross_v_50.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_cross_v_50) {
    mesh_window_02_cross_v_50Geometry.scale(0.03, 0.4, 0.03);
  }
  const mesh_window_02_cross_v_50 = new THREE.Mesh(
    mesh_window_02_cross_v_50Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_cross_v_50.name = "Window02CrossV";
  if (endpoint_window_02_cross_v_50) {
    mesh_window_02_cross_v_50.position.copy(endpoint_window_02_cross_v_50.midpoint);
    mesh_window_02_cross_v_50.quaternion.copy(endpoint_window_02_cross_v_50.quaternion);
  }
  mesh_window_02_cross_v_50.castShadow = options.castShadow ?? true;
  mesh_window_02_cross_v_50.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_cross_v_50.userData.sculptComponent = {"id": "window-02-cross-v", "name": "Window02CrossV", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_cross_v_50.add(mesh_window_02_cross_v_50);
  meshes["window-02-cross-v"] = mesh_window_02_cross_v_50;
  colliders["window-02-cross-v"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_cross_v_50);

  const endpoint_window_02_sill_51 = makeAttachmentEndpoint(null);
  const node_window_02_sill_51 = new THREE.Group();
  node_window_02_sill_51.name = "Window02Sill__pivot";
  node_window_02_sill_51.scale.set(1, 1, 1);
  if (endpoint_window_02_sill_51) {
    node_window_02_sill_51.position.copy(endpoint_window_02_sill_51.start);
    node_window_02_sill_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_sill_51.position.set(0.0, -0.27, -0.02);
    node_window_02_sill_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_sill_51.userData.sculptComponent = {"id": "window-02-sill", "name": "Window02Sill", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 0, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_sill_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_sill_51);
  nodes["window-02-sill"] = node_window_02_sill_51;
  const mesh_window_02_sill_51Geometry = endpoint_window_02_sill_51
    ? new THREE.CylinderGeometry(endpoint_window_02_sill_51.endRadius, endpoint_window_02_sill_51.baseRadius, endpoint_window_02_sill_51.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_sill_51) {
    mesh_window_02_sill_51Geometry.scale(0.55, 0.04, 0.08);
  }
  const mesh_window_02_sill_51 = new THREE.Mesh(
    mesh_window_02_sill_51Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_sill_51.name = "Window02Sill";
  if (endpoint_window_02_sill_51) {
    mesh_window_02_sill_51.position.copy(endpoint_window_02_sill_51.midpoint);
    mesh_window_02_sill_51.quaternion.copy(endpoint_window_02_sill_51.quaternion);
  }
  mesh_window_02_sill_51.castShadow = options.castShadow ?? true;
  mesh_window_02_sill_51.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_sill_51.userData.sculptComponent = {"id": "window-02-sill", "name": "Window02Sill", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 0, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_sill_51.add(mesh_window_02_sill_51);
  meshes["window-02-sill"] = mesh_window_02_sill_51;
  colliders["window-02-sill"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_sill_51);

  const endpoint_window_03_frame_52 = makeAttachmentEndpoint(null);
  const node_window_03_frame_52 = new THREE.Group();
  node_window_03_frame_52.name = "Window03Frame__pivot";
  node_window_03_frame_52.scale.set(1, 1, 1);
  if (endpoint_window_03_frame_52) {
    node_window_03_frame_52.position.copy(endpoint_window_03_frame_52.start);
    node_window_03_frame_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_frame_52.position.set(0.0, 0.0, 0.0);
    node_window_03_frame_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_frame_52.userData.sculptComponent = {"id": "window-03-frame", "name": "Window03Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.06]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_frame_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_frame_52);
  nodes["window-03-frame"] = node_window_03_frame_52;
  const mesh_window_03_frame_52Geometry = endpoint_window_03_frame_52
    ? new THREE.CylinderGeometry(endpoint_window_03_frame_52.endRadius, endpoint_window_03_frame_52.baseRadius, endpoint_window_03_frame_52.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_frame_52) {
    mesh_window_03_frame_52Geometry.scale(0.5, 0.5, 0.06);
  }
  const mesh_window_03_frame_52 = new THREE.Mesh(
    mesh_window_03_frame_52Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_frame_52.name = "Window03Frame";
  if (endpoint_window_03_frame_52) {
    mesh_window_03_frame_52.position.copy(endpoint_window_03_frame_52.midpoint);
    mesh_window_03_frame_52.quaternion.copy(endpoint_window_03_frame_52.quaternion);
  }
  mesh_window_03_frame_52.castShadow = options.castShadow ?? true;
  mesh_window_03_frame_52.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_frame_52.userData.sculptComponent = {"id": "window-03-frame", "name": "Window03Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.06]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_frame_52.add(mesh_window_03_frame_52);
  meshes["window-03-frame"] = mesh_window_03_frame_52;
  colliders["window-03-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_frame_52);

  const endpoint_window_03_glass_53 = makeAttachmentEndpoint(null);
  const node_window_03_glass_53 = new THREE.Group();
  node_window_03_glass_53.name = "Window03Glass__pivot";
  node_window_03_glass_53.scale.set(1, 1, 1);
  if (endpoint_window_03_glass_53) {
    node_window_03_glass_53.position.copy(endpoint_window_03_glass_53.start);
    node_window_03_glass_53.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_glass_53.position.set(0.0, 0.0, 0.045);
    node_window_03_glass_53.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_glass_53.userData.sculptComponent = {"id": "window-03-glass", "name": "Window03Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 0, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glass_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_glass_53);
  nodes["window-03-glass"] = node_window_03_glass_53;
  const mesh_window_03_glass_53Geometry = endpoint_window_03_glass_53
    ? new THREE.CylinderGeometry(endpoint_window_03_glass_53.endRadius, endpoint_window_03_glass_53.baseRadius, endpoint_window_03_glass_53.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_glass_53) {
    mesh_window_03_glass_53Geometry.scale(0.4, 0.4, 0.01);
  }
  const mesh_window_03_glass_53 = new THREE.Mesh(
    mesh_window_03_glass_53Geometry,
    materialMap["window-glass-emissive"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_glass_53.name = "Window03Glass";
  if (endpoint_window_03_glass_53) {
    mesh_window_03_glass_53.position.copy(endpoint_window_03_glass_53.midpoint);
    mesh_window_03_glass_53.quaternion.copy(endpoint_window_03_glass_53.quaternion);
  }
  mesh_window_03_glass_53.castShadow = options.castShadow ?? true;
  mesh_window_03_glass_53.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_glass_53.userData.sculptComponent = {"id": "window-03-glass", "name": "Window03Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 0, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glass_53.add(mesh_window_03_glass_53);
  meshes["window-03-glass"] = mesh_window_03_glass_53;
  colliders["window-03-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_glass_53);

  const endpoint_window_03_cross_h_54 = makeAttachmentEndpoint(null);
  const node_window_03_cross_h_54 = new THREE.Group();
  node_window_03_cross_h_54.name = "Window03CrossH__pivot";
  node_window_03_cross_h_54.scale.set(1, 1, 1);
  if (endpoint_window_03_cross_h_54) {
    node_window_03_cross_h_54.position.copy(endpoint_window_03_cross_h_54.start);
    node_window_03_cross_h_54.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_cross_h_54.position.set(0.0, 0.0, 0.06);
    node_window_03_cross_h_54.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_cross_h_54.userData.sculptComponent = {"id": "window-03-cross-h", "name": "Window03CrossH", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_cross_h_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_cross_h_54);
  nodes["window-03-cross-h"] = node_window_03_cross_h_54;
  const mesh_window_03_cross_h_54Geometry = endpoint_window_03_cross_h_54
    ? new THREE.CylinderGeometry(endpoint_window_03_cross_h_54.endRadius, endpoint_window_03_cross_h_54.baseRadius, endpoint_window_03_cross_h_54.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_cross_h_54) {
    mesh_window_03_cross_h_54Geometry.scale(0.4, 0.03, 0.03);
  }
  const mesh_window_03_cross_h_54 = new THREE.Mesh(
    mesh_window_03_cross_h_54Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_cross_h_54.name = "Window03CrossH";
  if (endpoint_window_03_cross_h_54) {
    mesh_window_03_cross_h_54.position.copy(endpoint_window_03_cross_h_54.midpoint);
    mesh_window_03_cross_h_54.quaternion.copy(endpoint_window_03_cross_h_54.quaternion);
  }
  mesh_window_03_cross_h_54.castShadow = options.castShadow ?? true;
  mesh_window_03_cross_h_54.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_cross_h_54.userData.sculptComponent = {"id": "window-03-cross-h", "name": "Window03CrossH", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_cross_h_54.add(mesh_window_03_cross_h_54);
  meshes["window-03-cross-h"] = mesh_window_03_cross_h_54;
  colliders["window-03-cross-h"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_cross_h_54);

  const endpoint_window_03_cross_v_55 = makeAttachmentEndpoint(null);
  const node_window_03_cross_v_55 = new THREE.Group();
  node_window_03_cross_v_55.name = "Window03CrossV__pivot";
  node_window_03_cross_v_55.scale.set(1, 1, 1);
  if (endpoint_window_03_cross_v_55) {
    node_window_03_cross_v_55.position.copy(endpoint_window_03_cross_v_55.start);
    node_window_03_cross_v_55.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_cross_v_55.position.set(0.0, 0.0, 0.06);
    node_window_03_cross_v_55.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_cross_v_55.userData.sculptComponent = {"id": "window-03-cross-v", "name": "Window03CrossV", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_cross_v_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_cross_v_55);
  nodes["window-03-cross-v"] = node_window_03_cross_v_55;
  const mesh_window_03_cross_v_55Geometry = endpoint_window_03_cross_v_55
    ? new THREE.CylinderGeometry(endpoint_window_03_cross_v_55.endRadius, endpoint_window_03_cross_v_55.baseRadius, endpoint_window_03_cross_v_55.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_cross_v_55) {
    mesh_window_03_cross_v_55Geometry.scale(0.03, 0.4, 0.03);
  }
  const mesh_window_03_cross_v_55 = new THREE.Mesh(
    mesh_window_03_cross_v_55Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_cross_v_55.name = "Window03CrossV";
  if (endpoint_window_03_cross_v_55) {
    mesh_window_03_cross_v_55.position.copy(endpoint_window_03_cross_v_55.midpoint);
    mesh_window_03_cross_v_55.quaternion.copy(endpoint_window_03_cross_v_55.quaternion);
  }
  mesh_window_03_cross_v_55.castShadow = options.castShadow ?? true;
  mesh_window_03_cross_v_55.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_cross_v_55.userData.sculptComponent = {"id": "window-03-cross-v", "name": "Window03CrossV", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 0, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_cross_v_55.add(mesh_window_03_cross_v_55);
  meshes["window-03-cross-v"] = mesh_window_03_cross_v_55;
  colliders["window-03-cross-v"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_cross_v_55);

  const endpoint_window_03_sill_56 = makeAttachmentEndpoint(null);
  const node_window_03_sill_56 = new THREE.Group();
  node_window_03_sill_56.name = "Window03Sill__pivot";
  node_window_03_sill_56.scale.set(1, 1, 1);
  if (endpoint_window_03_sill_56) {
    node_window_03_sill_56.position.copy(endpoint_window_03_sill_56.start);
    node_window_03_sill_56.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_sill_56.position.set(0.0, -0.27, -0.02);
    node_window_03_sill_56.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_sill_56.userData.sculptComponent = {"id": "window-03-sill", "name": "Window03Sill", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 0, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_sill_56.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_sill_56);
  nodes["window-03-sill"] = node_window_03_sill_56;
  const mesh_window_03_sill_56Geometry = endpoint_window_03_sill_56
    ? new THREE.CylinderGeometry(endpoint_window_03_sill_56.endRadius, endpoint_window_03_sill_56.baseRadius, endpoint_window_03_sill_56.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_sill_56) {
    mesh_window_03_sill_56Geometry.scale(0.55, 0.04, 0.08);
  }
  const mesh_window_03_sill_56 = new THREE.Mesh(
    mesh_window_03_sill_56Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_sill_56.name = "Window03Sill";
  if (endpoint_window_03_sill_56) {
    mesh_window_03_sill_56.position.copy(endpoint_window_03_sill_56.midpoint);
    mesh_window_03_sill_56.quaternion.copy(endpoint_window_03_sill_56.quaternion);
  }
  mesh_window_03_sill_56.castShadow = options.castShadow ?? true;
  mesh_window_03_sill_56.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_sill_56.userData.sculptComponent = {"id": "window-03-sill", "name": "Window03Sill", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 0, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_sill_56.add(mesh_window_03_sill_56);
  meshes["window-03-sill"] = mesh_window_03_sill_56;
  colliders["window-03-sill"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_sill_56);

  const endpoint_vine_flower_2_part0_57 = makeAttachmentEndpoint(null);
  const node_vine_flower_2_part0_57 = new THREE.Group();
  node_vine_flower_2_part0_57.name = "Petal1__pivot";
  node_vine_flower_2_part0_57.scale.set(1, 1, 1);
  if (endpoint_vine_flower_2_part0_57) {
    node_vine_flower_2_part0_57.position.copy(endpoint_vine_flower_2_part0_57.start);
    node_vine_flower_2_part0_57.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_flower_2_part0_57.position.set(0.04, 0.0, 0.0);
    node_vine_flower_2_part0_57.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_flower_2_part0_57.userData.sculptComponent = {"id": "vine-flower-2-part0", "name": "Petal1", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.04, 0, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part0_57.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-2"] ?? root).add(node_vine_flower_2_part0_57);
  nodes["vine-flower-2-part0"] = node_vine_flower_2_part0_57;
  const mesh_vine_flower_2_part0_57Geometry = endpoint_vine_flower_2_part0_57
    ? new THREE.CylinderGeometry(endpoint_vine_flower_2_part0_57.endRadius, endpoint_vine_flower_2_part0_57.baseRadius, endpoint_vine_flower_2_part0_57.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_2_part0_57) {
    mesh_vine_flower_2_part0_57Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_2_part0_57 = new THREE.Mesh(
    mesh_vine_flower_2_part0_57Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_2_part0_57.name = "Petal1";
  if (endpoint_vine_flower_2_part0_57) {
    mesh_vine_flower_2_part0_57.position.copy(endpoint_vine_flower_2_part0_57.midpoint);
    mesh_vine_flower_2_part0_57.quaternion.copy(endpoint_vine_flower_2_part0_57.quaternion);
  }
  mesh_vine_flower_2_part0_57.castShadow = options.castShadow ?? true;
  mesh_vine_flower_2_part0_57.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_2_part0_57.userData.sculptComponent = {"id": "vine-flower-2-part0", "name": "Petal1", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.04, 0, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part0_57.add(mesh_vine_flower_2_part0_57);
  meshes["vine-flower-2-part0"] = mesh_vine_flower_2_part0_57;
  colliders["vine-flower-2-part0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-1"] ??= [];
  destructionGroups["petal-1"].push(node_vine_flower_2_part0_57);

  const endpoint_vine_flower_2_part1_58 = makeAttachmentEndpoint(null);
  const node_vine_flower_2_part1_58 = new THREE.Group();
  node_vine_flower_2_part1_58.name = "Petal2__pivot";
  node_vine_flower_2_part1_58.scale.set(1, 1, 1);
  if (endpoint_vine_flower_2_part1_58) {
    node_vine_flower_2_part1_58.position.copy(endpoint_vine_flower_2_part1_58.start);
    node_vine_flower_2_part1_58.rotation.set(0.0, 1.25664, 0.0);
  } else {
    node_vine_flower_2_part1_58.position.set(0.012, 0.0, 0.038);
    node_vine_flower_2_part1_58.rotation.set(0.0, 1.25664, 0.0);
  }
  node_vine_flower_2_part1_58.userData.sculptComponent = {"id": "vine-flower-2-part1", "name": "Petal2", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, 0.038], "rotation": [0.0, 1.25664, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(240, 176, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part1_58.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-2"] ?? root).add(node_vine_flower_2_part1_58);
  nodes["vine-flower-2-part1"] = node_vine_flower_2_part1_58;
  const mesh_vine_flower_2_part1_58Geometry = endpoint_vine_flower_2_part1_58
    ? new THREE.CylinderGeometry(endpoint_vine_flower_2_part1_58.endRadius, endpoint_vine_flower_2_part1_58.baseRadius, endpoint_vine_flower_2_part1_58.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_2_part1_58) {
    mesh_vine_flower_2_part1_58Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_2_part1_58 = new THREE.Mesh(
    mesh_vine_flower_2_part1_58Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_2_part1_58.name = "Petal2";
  if (endpoint_vine_flower_2_part1_58) {
    mesh_vine_flower_2_part1_58.position.copy(endpoint_vine_flower_2_part1_58.midpoint);
    mesh_vine_flower_2_part1_58.quaternion.copy(endpoint_vine_flower_2_part1_58.quaternion);
  }
  mesh_vine_flower_2_part1_58.castShadow = options.castShadow ?? true;
  mesh_vine_flower_2_part1_58.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_2_part1_58.userData.sculptComponent = {"id": "vine-flower-2-part1", "name": "Petal2", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, 0.038], "rotation": [0.0, 1.25664, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(240, 176, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part1_58.add(mesh_vine_flower_2_part1_58);
  meshes["vine-flower-2-part1"] = mesh_vine_flower_2_part1_58;
  colliders["vine-flower-2-part1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-2"] ??= [];
  destructionGroups["petal-2"].push(node_vine_flower_2_part1_58);

  const endpoint_vine_flower_2_part2_59 = makeAttachmentEndpoint(null);
  const node_vine_flower_2_part2_59 = new THREE.Group();
  node_vine_flower_2_part2_59.name = "Petal3__pivot";
  node_vine_flower_2_part2_59.scale.set(1, 1, 1);
  if (endpoint_vine_flower_2_part2_59) {
    node_vine_flower_2_part2_59.position.copy(endpoint_vine_flower_2_part2_59.start);
    node_vine_flower_2_part2_59.rotation.set(0.0, 2.51327, 0.0);
  } else {
    node_vine_flower_2_part2_59.position.set(-0.032, 0.0, 0.024);
    node_vine_flower_2_part2_59.rotation.set(0.0, 2.51327, 0.0);
  }
  node_vine_flower_2_part2_59.userData.sculptComponent = {"id": "vine-flower-2-part2", "name": "Petal3", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, 0.024], "rotation": [0.0, 2.51327, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(176, 128, 208, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part2_59.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-2"] ?? root).add(node_vine_flower_2_part2_59);
  nodes["vine-flower-2-part2"] = node_vine_flower_2_part2_59;
  const mesh_vine_flower_2_part2_59Geometry = endpoint_vine_flower_2_part2_59
    ? new THREE.CylinderGeometry(endpoint_vine_flower_2_part2_59.endRadius, endpoint_vine_flower_2_part2_59.baseRadius, endpoint_vine_flower_2_part2_59.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_2_part2_59) {
    mesh_vine_flower_2_part2_59Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_2_part2_59 = new THREE.Mesh(
    mesh_vine_flower_2_part2_59Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_2_part2_59.name = "Petal3";
  if (endpoint_vine_flower_2_part2_59) {
    mesh_vine_flower_2_part2_59.position.copy(endpoint_vine_flower_2_part2_59.midpoint);
    mesh_vine_flower_2_part2_59.quaternion.copy(endpoint_vine_flower_2_part2_59.quaternion);
  }
  mesh_vine_flower_2_part2_59.castShadow = options.castShadow ?? true;
  mesh_vine_flower_2_part2_59.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_2_part2_59.userData.sculptComponent = {"id": "vine-flower-2-part2", "name": "Petal3", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, 0.024], "rotation": [0.0, 2.51327, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(176, 128, 208, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part2_59.add(mesh_vine_flower_2_part2_59);
  meshes["vine-flower-2-part2"] = mesh_vine_flower_2_part2_59;
  colliders["vine-flower-2-part2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-3"] ??= [];
  destructionGroups["petal-3"].push(node_vine_flower_2_part2_59);

  const endpoint_vine_flower_2_part3_60 = makeAttachmentEndpoint(null);
  const node_vine_flower_2_part3_60 = new THREE.Group();
  node_vine_flower_2_part3_60.name = "Petal4__pivot";
  node_vine_flower_2_part3_60.scale.set(1, 1, 1);
  if (endpoint_vine_flower_2_part3_60) {
    node_vine_flower_2_part3_60.position.copy(endpoint_vine_flower_2_part3_60.start);
    node_vine_flower_2_part3_60.rotation.set(0.0, 3.76991, 0.0);
  } else {
    node_vine_flower_2_part3_60.position.set(-0.032, 0.0, -0.024);
    node_vine_flower_2_part3_60.rotation.set(0.0, 3.76991, 0.0);
  }
  node_vine_flower_2_part3_60.userData.sculptComponent = {"id": "vine-flower-2-part3", "name": "Petal4", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, -0.024], "rotation": [0.0, 3.76991, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(240, 224, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part3_60.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-2"] ?? root).add(node_vine_flower_2_part3_60);
  nodes["vine-flower-2-part3"] = node_vine_flower_2_part3_60;
  const mesh_vine_flower_2_part3_60Geometry = endpoint_vine_flower_2_part3_60
    ? new THREE.CylinderGeometry(endpoint_vine_flower_2_part3_60.endRadius, endpoint_vine_flower_2_part3_60.baseRadius, endpoint_vine_flower_2_part3_60.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_2_part3_60) {
    mesh_vine_flower_2_part3_60Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_2_part3_60 = new THREE.Mesh(
    mesh_vine_flower_2_part3_60Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_2_part3_60.name = "Petal4";
  if (endpoint_vine_flower_2_part3_60) {
    mesh_vine_flower_2_part3_60.position.copy(endpoint_vine_flower_2_part3_60.midpoint);
    mesh_vine_flower_2_part3_60.quaternion.copy(endpoint_vine_flower_2_part3_60.quaternion);
  }
  mesh_vine_flower_2_part3_60.castShadow = options.castShadow ?? true;
  mesh_vine_flower_2_part3_60.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_2_part3_60.userData.sculptComponent = {"id": "vine-flower-2-part3", "name": "Petal4", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, -0.024], "rotation": [0.0, 3.76991, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(240, 224, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part3_60.add(mesh_vine_flower_2_part3_60);
  meshes["vine-flower-2-part3"] = mesh_vine_flower_2_part3_60;
  colliders["vine-flower-2-part3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-4"] ??= [];
  destructionGroups["petal-4"].push(node_vine_flower_2_part3_60);

  const endpoint_vine_flower_2_part4_61 = makeAttachmentEndpoint(null);
  const node_vine_flower_2_part4_61 = new THREE.Group();
  node_vine_flower_2_part4_61.name = "Petal5__pivot";
  node_vine_flower_2_part4_61.scale.set(1, 1, 1);
  if (endpoint_vine_flower_2_part4_61) {
    node_vine_flower_2_part4_61.position.copy(endpoint_vine_flower_2_part4_61.start);
    node_vine_flower_2_part4_61.rotation.set(0.0, 5.02655, 0.0);
  } else {
    node_vine_flower_2_part4_61.position.set(0.012, 0.0, -0.038);
    node_vine_flower_2_part4_61.rotation.set(0.0, 5.02655, 0.0);
  }
  node_vine_flower_2_part4_61.userData.sculptComponent = {"id": "vine-flower-2-part4", "name": "Petal5", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, -0.038], "rotation": [0.0, 5.02655, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal5", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part4_61.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-2"] ?? root).add(node_vine_flower_2_part4_61);
  nodes["vine-flower-2-part4"] = node_vine_flower_2_part4_61;
  const mesh_vine_flower_2_part4_61Geometry = endpoint_vine_flower_2_part4_61
    ? new THREE.CylinderGeometry(endpoint_vine_flower_2_part4_61.endRadius, endpoint_vine_flower_2_part4_61.baseRadius, endpoint_vine_flower_2_part4_61.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_2_part4_61) {
    mesh_vine_flower_2_part4_61Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_2_part4_61 = new THREE.Mesh(
    mesh_vine_flower_2_part4_61Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_2_part4_61.name = "Petal5";
  if (endpoint_vine_flower_2_part4_61) {
    mesh_vine_flower_2_part4_61.position.copy(endpoint_vine_flower_2_part4_61.midpoint);
    mesh_vine_flower_2_part4_61.quaternion.copy(endpoint_vine_flower_2_part4_61.quaternion);
  }
  mesh_vine_flower_2_part4_61.castShadow = options.castShadow ?? true;
  mesh_vine_flower_2_part4_61.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_2_part4_61.userData.sculptComponent = {"id": "vine-flower-2-part4", "name": "Petal5", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, -0.038], "rotation": [0.0, 5.02655, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal5", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part4_61.add(mesh_vine_flower_2_part4_61);
  meshes["vine-flower-2-part4"] = mesh_vine_flower_2_part4_61;
  colliders["vine-flower-2-part4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-5"] ??= [];
  destructionGroups["petal-5"].push(node_vine_flower_2_part4_61);

  const endpoint_vine_flower_2_part5_62 = makeAttachmentEndpoint(null);
  const node_vine_flower_2_part5_62 = new THREE.Group();
  node_vine_flower_2_part5_62.name = "FlowerCenter__pivot";
  node_vine_flower_2_part5_62.scale.set(1, 1, 1);
  if (endpoint_vine_flower_2_part5_62) {
    node_vine_flower_2_part5_62.position.copy(endpoint_vine_flower_2_part5_62.start);
    node_vine_flower_2_part5_62.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_flower_2_part5_62.position.set(0.0, 0.0, 0.0);
    node_vine_flower_2_part5_62.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_flower_2_part5_62.userData.sculptComponent = {"id": "vine-flower-2-part5", "name": "FlowerCenter", "level": "micro", "role": "flower-center", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.03, 0.03, 0.03]}, "material": "flower-center-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for FlowerCenter", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 200, 64, 1.0)", "secondaryAlbedo": "rgba(232, 216, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part5_62.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-2"] ?? root).add(node_vine_flower_2_part5_62);
  nodes["vine-flower-2-part5"] = node_vine_flower_2_part5_62;
  const mesh_vine_flower_2_part5_62Geometry = endpoint_vine_flower_2_part5_62
    ? new THREE.CylinderGeometry(endpoint_vine_flower_2_part5_62.endRadius, endpoint_vine_flower_2_part5_62.baseRadius, endpoint_vine_flower_2_part5_62.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_2_part5_62) {
    mesh_vine_flower_2_part5_62Geometry.scale(0.03, 0.03, 0.03);
  }
  const mesh_vine_flower_2_part5_62 = new THREE.Mesh(
    mesh_vine_flower_2_part5_62Geometry,
    materialMap["flower-center-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_2_part5_62.name = "FlowerCenter";
  if (endpoint_vine_flower_2_part5_62) {
    mesh_vine_flower_2_part5_62.position.copy(endpoint_vine_flower_2_part5_62.midpoint);
    mesh_vine_flower_2_part5_62.quaternion.copy(endpoint_vine_flower_2_part5_62.quaternion);
  }
  mesh_vine_flower_2_part5_62.castShadow = options.castShadow ?? true;
  mesh_vine_flower_2_part5_62.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_2_part5_62.userData.sculptComponent = {"id": "vine-flower-2-part5", "name": "FlowerCenter", "level": "micro", "role": "flower-center", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-2", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-2"}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.03, 0.03, 0.03]}, "material": "flower-center-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for FlowerCenter", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 200, 64, 1.0)", "secondaryAlbedo": "rgba(232, 216, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_2_part5_62.add(mesh_vine_flower_2_part5_62);
  meshes["vine-flower-2-part5"] = mesh_vine_flower_2_part5_62;
  colliders["vine-flower-2-part5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["flower-center"] ??= [];
  destructionGroups["flower-center"].push(node_vine_flower_2_part5_62);

  const endpoint_vine_flower_3_part0_63 = makeAttachmentEndpoint(null);
  const node_vine_flower_3_part0_63 = new THREE.Group();
  node_vine_flower_3_part0_63.name = "Petal1__pivot";
  node_vine_flower_3_part0_63.scale.set(1, 1, 1);
  if (endpoint_vine_flower_3_part0_63) {
    node_vine_flower_3_part0_63.position.copy(endpoint_vine_flower_3_part0_63.start);
    node_vine_flower_3_part0_63.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_flower_3_part0_63.position.set(0.04, 0.0, 0.0);
    node_vine_flower_3_part0_63.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_flower_3_part0_63.userData.sculptComponent = {"id": "vine-flower-3-part0", "name": "Petal1", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.04, 0, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part0_63.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-3"] ?? root).add(node_vine_flower_3_part0_63);
  nodes["vine-flower-3-part0"] = node_vine_flower_3_part0_63;
  const mesh_vine_flower_3_part0_63Geometry = endpoint_vine_flower_3_part0_63
    ? new THREE.CylinderGeometry(endpoint_vine_flower_3_part0_63.endRadius, endpoint_vine_flower_3_part0_63.baseRadius, endpoint_vine_flower_3_part0_63.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_3_part0_63) {
    mesh_vine_flower_3_part0_63Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_3_part0_63 = new THREE.Mesh(
    mesh_vine_flower_3_part0_63Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_3_part0_63.name = "Petal1";
  if (endpoint_vine_flower_3_part0_63) {
    mesh_vine_flower_3_part0_63.position.copy(endpoint_vine_flower_3_part0_63.midpoint);
    mesh_vine_flower_3_part0_63.quaternion.copy(endpoint_vine_flower_3_part0_63.quaternion);
  }
  mesh_vine_flower_3_part0_63.castShadow = options.castShadow ?? true;
  mesh_vine_flower_3_part0_63.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_3_part0_63.userData.sculptComponent = {"id": "vine-flower-3-part0", "name": "Petal1", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.04, 0, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part0_63.add(mesh_vine_flower_3_part0_63);
  meshes["vine-flower-3-part0"] = mesh_vine_flower_3_part0_63;
  colliders["vine-flower-3-part0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-1"] ??= [];
  destructionGroups["petal-1"].push(node_vine_flower_3_part0_63);

  const endpoint_vine_flower_3_part1_64 = makeAttachmentEndpoint(null);
  const node_vine_flower_3_part1_64 = new THREE.Group();
  node_vine_flower_3_part1_64.name = "Petal2__pivot";
  node_vine_flower_3_part1_64.scale.set(1, 1, 1);
  if (endpoint_vine_flower_3_part1_64) {
    node_vine_flower_3_part1_64.position.copy(endpoint_vine_flower_3_part1_64.start);
    node_vine_flower_3_part1_64.rotation.set(0.0, 1.25664, 0.0);
  } else {
    node_vine_flower_3_part1_64.position.set(0.012, 0.0, 0.038);
    node_vine_flower_3_part1_64.rotation.set(0.0, 1.25664, 0.0);
  }
  node_vine_flower_3_part1_64.userData.sculptComponent = {"id": "vine-flower-3-part1", "name": "Petal2", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, 0.038], "rotation": [0.0, 1.25664, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(240, 176, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part1_64.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-3"] ?? root).add(node_vine_flower_3_part1_64);
  nodes["vine-flower-3-part1"] = node_vine_flower_3_part1_64;
  const mesh_vine_flower_3_part1_64Geometry = endpoint_vine_flower_3_part1_64
    ? new THREE.CylinderGeometry(endpoint_vine_flower_3_part1_64.endRadius, endpoint_vine_flower_3_part1_64.baseRadius, endpoint_vine_flower_3_part1_64.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_3_part1_64) {
    mesh_vine_flower_3_part1_64Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_3_part1_64 = new THREE.Mesh(
    mesh_vine_flower_3_part1_64Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_3_part1_64.name = "Petal2";
  if (endpoint_vine_flower_3_part1_64) {
    mesh_vine_flower_3_part1_64.position.copy(endpoint_vine_flower_3_part1_64.midpoint);
    mesh_vine_flower_3_part1_64.quaternion.copy(endpoint_vine_flower_3_part1_64.quaternion);
  }
  mesh_vine_flower_3_part1_64.castShadow = options.castShadow ?? true;
  mesh_vine_flower_3_part1_64.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_3_part1_64.userData.sculptComponent = {"id": "vine-flower-3-part1", "name": "Petal2", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, 0.038], "rotation": [0.0, 1.25664, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(240, 176, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part1_64.add(mesh_vine_flower_3_part1_64);
  meshes["vine-flower-3-part1"] = mesh_vine_flower_3_part1_64;
  colliders["vine-flower-3-part1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-2"] ??= [];
  destructionGroups["petal-2"].push(node_vine_flower_3_part1_64);

  const endpoint_vine_flower_3_part2_65 = makeAttachmentEndpoint(null);
  const node_vine_flower_3_part2_65 = new THREE.Group();
  node_vine_flower_3_part2_65.name = "Petal3__pivot";
  node_vine_flower_3_part2_65.scale.set(1, 1, 1);
  if (endpoint_vine_flower_3_part2_65) {
    node_vine_flower_3_part2_65.position.copy(endpoint_vine_flower_3_part2_65.start);
    node_vine_flower_3_part2_65.rotation.set(0.0, 2.51327, 0.0);
  } else {
    node_vine_flower_3_part2_65.position.set(-0.032, 0.0, 0.024);
    node_vine_flower_3_part2_65.rotation.set(0.0, 2.51327, 0.0);
  }
  node_vine_flower_3_part2_65.userData.sculptComponent = {"id": "vine-flower-3-part2", "name": "Petal3", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, 0.024], "rotation": [0.0, 2.51327, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(176, 128, 208, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part2_65.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-3"] ?? root).add(node_vine_flower_3_part2_65);
  nodes["vine-flower-3-part2"] = node_vine_flower_3_part2_65;
  const mesh_vine_flower_3_part2_65Geometry = endpoint_vine_flower_3_part2_65
    ? new THREE.CylinderGeometry(endpoint_vine_flower_3_part2_65.endRadius, endpoint_vine_flower_3_part2_65.baseRadius, endpoint_vine_flower_3_part2_65.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_3_part2_65) {
    mesh_vine_flower_3_part2_65Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_3_part2_65 = new THREE.Mesh(
    mesh_vine_flower_3_part2_65Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_3_part2_65.name = "Petal3";
  if (endpoint_vine_flower_3_part2_65) {
    mesh_vine_flower_3_part2_65.position.copy(endpoint_vine_flower_3_part2_65.midpoint);
    mesh_vine_flower_3_part2_65.quaternion.copy(endpoint_vine_flower_3_part2_65.quaternion);
  }
  mesh_vine_flower_3_part2_65.castShadow = options.castShadow ?? true;
  mesh_vine_flower_3_part2_65.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_3_part2_65.userData.sculptComponent = {"id": "vine-flower-3-part2", "name": "Petal3", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, 0.024], "rotation": [0.0, 2.51327, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(176, 128, 208, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part2_65.add(mesh_vine_flower_3_part2_65);
  meshes["vine-flower-3-part2"] = mesh_vine_flower_3_part2_65;
  colliders["vine-flower-3-part2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-3"] ??= [];
  destructionGroups["petal-3"].push(node_vine_flower_3_part2_65);

  const endpoint_vine_flower_3_part3_66 = makeAttachmentEndpoint(null);
  const node_vine_flower_3_part3_66 = new THREE.Group();
  node_vine_flower_3_part3_66.name = "Petal4__pivot";
  node_vine_flower_3_part3_66.scale.set(1, 1, 1);
  if (endpoint_vine_flower_3_part3_66) {
    node_vine_flower_3_part3_66.position.copy(endpoint_vine_flower_3_part3_66.start);
    node_vine_flower_3_part3_66.rotation.set(0.0, 3.76991, 0.0);
  } else {
    node_vine_flower_3_part3_66.position.set(-0.032, 0.0, -0.024);
    node_vine_flower_3_part3_66.rotation.set(0.0, 3.76991, 0.0);
  }
  node_vine_flower_3_part3_66.userData.sculptComponent = {"id": "vine-flower-3-part3", "name": "Petal4", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, -0.024], "rotation": [0.0, 3.76991, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(240, 224, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part3_66.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-3"] ?? root).add(node_vine_flower_3_part3_66);
  nodes["vine-flower-3-part3"] = node_vine_flower_3_part3_66;
  const mesh_vine_flower_3_part3_66Geometry = endpoint_vine_flower_3_part3_66
    ? new THREE.CylinderGeometry(endpoint_vine_flower_3_part3_66.endRadius, endpoint_vine_flower_3_part3_66.baseRadius, endpoint_vine_flower_3_part3_66.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_3_part3_66) {
    mesh_vine_flower_3_part3_66Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_3_part3_66 = new THREE.Mesh(
    mesh_vine_flower_3_part3_66Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_3_part3_66.name = "Petal4";
  if (endpoint_vine_flower_3_part3_66) {
    mesh_vine_flower_3_part3_66.position.copy(endpoint_vine_flower_3_part3_66.midpoint);
    mesh_vine_flower_3_part3_66.quaternion.copy(endpoint_vine_flower_3_part3_66.quaternion);
  }
  mesh_vine_flower_3_part3_66.castShadow = options.castShadow ?? true;
  mesh_vine_flower_3_part3_66.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_3_part3_66.userData.sculptComponent = {"id": "vine-flower-3-part3", "name": "Petal4", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, -0.024], "rotation": [0.0, 3.76991, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(240, 224, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part3_66.add(mesh_vine_flower_3_part3_66);
  meshes["vine-flower-3-part3"] = mesh_vine_flower_3_part3_66;
  colliders["vine-flower-3-part3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-4"] ??= [];
  destructionGroups["petal-4"].push(node_vine_flower_3_part3_66);

  const endpoint_vine_flower_3_part4_67 = makeAttachmentEndpoint(null);
  const node_vine_flower_3_part4_67 = new THREE.Group();
  node_vine_flower_3_part4_67.name = "Petal5__pivot";
  node_vine_flower_3_part4_67.scale.set(1, 1, 1);
  if (endpoint_vine_flower_3_part4_67) {
    node_vine_flower_3_part4_67.position.copy(endpoint_vine_flower_3_part4_67.start);
    node_vine_flower_3_part4_67.rotation.set(0.0, 5.02655, 0.0);
  } else {
    node_vine_flower_3_part4_67.position.set(0.012, 0.0, -0.038);
    node_vine_flower_3_part4_67.rotation.set(0.0, 5.02655, 0.0);
  }
  node_vine_flower_3_part4_67.userData.sculptComponent = {"id": "vine-flower-3-part4", "name": "Petal5", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, -0.038], "rotation": [0.0, 5.02655, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal5", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part4_67.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-3"] ?? root).add(node_vine_flower_3_part4_67);
  nodes["vine-flower-3-part4"] = node_vine_flower_3_part4_67;
  const mesh_vine_flower_3_part4_67Geometry = endpoint_vine_flower_3_part4_67
    ? new THREE.CylinderGeometry(endpoint_vine_flower_3_part4_67.endRadius, endpoint_vine_flower_3_part4_67.baseRadius, endpoint_vine_flower_3_part4_67.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_3_part4_67) {
    mesh_vine_flower_3_part4_67Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_3_part4_67 = new THREE.Mesh(
    mesh_vine_flower_3_part4_67Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_3_part4_67.name = "Petal5";
  if (endpoint_vine_flower_3_part4_67) {
    mesh_vine_flower_3_part4_67.position.copy(endpoint_vine_flower_3_part4_67.midpoint);
    mesh_vine_flower_3_part4_67.quaternion.copy(endpoint_vine_flower_3_part4_67.quaternion);
  }
  mesh_vine_flower_3_part4_67.castShadow = options.castShadow ?? true;
  mesh_vine_flower_3_part4_67.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_3_part4_67.userData.sculptComponent = {"id": "vine-flower-3-part4", "name": "Petal5", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, -0.038], "rotation": [0.0, 5.02655, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal5", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part4_67.add(mesh_vine_flower_3_part4_67);
  meshes["vine-flower-3-part4"] = mesh_vine_flower_3_part4_67;
  colliders["vine-flower-3-part4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-5"] ??= [];
  destructionGroups["petal-5"].push(node_vine_flower_3_part4_67);

  const endpoint_vine_flower_3_part5_68 = makeAttachmentEndpoint(null);
  const node_vine_flower_3_part5_68 = new THREE.Group();
  node_vine_flower_3_part5_68.name = "FlowerCenter__pivot";
  node_vine_flower_3_part5_68.scale.set(1, 1, 1);
  if (endpoint_vine_flower_3_part5_68) {
    node_vine_flower_3_part5_68.position.copy(endpoint_vine_flower_3_part5_68.start);
    node_vine_flower_3_part5_68.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_flower_3_part5_68.position.set(0.0, 0.0, 0.0);
    node_vine_flower_3_part5_68.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_flower_3_part5_68.userData.sculptComponent = {"id": "vine-flower-3-part5", "name": "FlowerCenter", "level": "micro", "role": "flower-center", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.03, 0.03, 0.03]}, "material": "flower-center-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for FlowerCenter", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 200, 64, 1.0)", "secondaryAlbedo": "rgba(232, 216, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part5_68.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-3"] ?? root).add(node_vine_flower_3_part5_68);
  nodes["vine-flower-3-part5"] = node_vine_flower_3_part5_68;
  const mesh_vine_flower_3_part5_68Geometry = endpoint_vine_flower_3_part5_68
    ? new THREE.CylinderGeometry(endpoint_vine_flower_3_part5_68.endRadius, endpoint_vine_flower_3_part5_68.baseRadius, endpoint_vine_flower_3_part5_68.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_3_part5_68) {
    mesh_vine_flower_3_part5_68Geometry.scale(0.03, 0.03, 0.03);
  }
  const mesh_vine_flower_3_part5_68 = new THREE.Mesh(
    mesh_vine_flower_3_part5_68Geometry,
    materialMap["flower-center-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_3_part5_68.name = "FlowerCenter";
  if (endpoint_vine_flower_3_part5_68) {
    mesh_vine_flower_3_part5_68.position.copy(endpoint_vine_flower_3_part5_68.midpoint);
    mesh_vine_flower_3_part5_68.quaternion.copy(endpoint_vine_flower_3_part5_68.quaternion);
  }
  mesh_vine_flower_3_part5_68.castShadow = options.castShadow ?? true;
  mesh_vine_flower_3_part5_68.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_3_part5_68.userData.sculptComponent = {"id": "vine-flower-3-part5", "name": "FlowerCenter", "level": "micro", "role": "flower-center", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-3", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-3"}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.03, 0.03, 0.03]}, "material": "flower-center-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for FlowerCenter", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 200, 64, 1.0)", "secondaryAlbedo": "rgba(232, 216, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_3_part5_68.add(mesh_vine_flower_3_part5_68);
  meshes["vine-flower-3-part5"] = mesh_vine_flower_3_part5_68;
  colliders["vine-flower-3-part5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["flower-center"] ??= [];
  destructionGroups["flower-center"].push(node_vine_flower_3_part5_68);

  const endpoint_vine_flower_4_part0_69 = makeAttachmentEndpoint(null);
  const node_vine_flower_4_part0_69 = new THREE.Group();
  node_vine_flower_4_part0_69.name = "Petal1__pivot";
  node_vine_flower_4_part0_69.scale.set(1, 1, 1);
  if (endpoint_vine_flower_4_part0_69) {
    node_vine_flower_4_part0_69.position.copy(endpoint_vine_flower_4_part0_69.start);
    node_vine_flower_4_part0_69.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_flower_4_part0_69.position.set(0.04, 0.0, 0.0);
    node_vine_flower_4_part0_69.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_flower_4_part0_69.userData.sculptComponent = {"id": "vine-flower-4-part0", "name": "Petal1", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.04, 0, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part0_69.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-4"] ?? root).add(node_vine_flower_4_part0_69);
  nodes["vine-flower-4-part0"] = node_vine_flower_4_part0_69;
  const mesh_vine_flower_4_part0_69Geometry = endpoint_vine_flower_4_part0_69
    ? new THREE.CylinderGeometry(endpoint_vine_flower_4_part0_69.endRadius, endpoint_vine_flower_4_part0_69.baseRadius, endpoint_vine_flower_4_part0_69.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_4_part0_69) {
    mesh_vine_flower_4_part0_69Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_4_part0_69 = new THREE.Mesh(
    mesh_vine_flower_4_part0_69Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_4_part0_69.name = "Petal1";
  if (endpoint_vine_flower_4_part0_69) {
    mesh_vine_flower_4_part0_69.position.copy(endpoint_vine_flower_4_part0_69.midpoint);
    mesh_vine_flower_4_part0_69.quaternion.copy(endpoint_vine_flower_4_part0_69.quaternion);
  }
  mesh_vine_flower_4_part0_69.castShadow = options.castShadow ?? true;
  mesh_vine_flower_4_part0_69.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_4_part0_69.userData.sculptComponent = {"id": "vine-flower-4-part0", "name": "Petal1", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.04, 0, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part0_69.add(mesh_vine_flower_4_part0_69);
  meshes["vine-flower-4-part0"] = mesh_vine_flower_4_part0_69;
  colliders["vine-flower-4-part0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-1"] ??= [];
  destructionGroups["petal-1"].push(node_vine_flower_4_part0_69);

  const endpoint_vine_flower_4_part1_70 = makeAttachmentEndpoint(null);
  const node_vine_flower_4_part1_70 = new THREE.Group();
  node_vine_flower_4_part1_70.name = "Petal2__pivot";
  node_vine_flower_4_part1_70.scale.set(1, 1, 1);
  if (endpoint_vine_flower_4_part1_70) {
    node_vine_flower_4_part1_70.position.copy(endpoint_vine_flower_4_part1_70.start);
    node_vine_flower_4_part1_70.rotation.set(0.0, 1.25664, 0.0);
  } else {
    node_vine_flower_4_part1_70.position.set(0.012, 0.0, 0.038);
    node_vine_flower_4_part1_70.rotation.set(0.0, 1.25664, 0.0);
  }
  node_vine_flower_4_part1_70.userData.sculptComponent = {"id": "vine-flower-4-part1", "name": "Petal2", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, 0.038], "rotation": [0.0, 1.25664, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(240, 176, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part1_70.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-4"] ?? root).add(node_vine_flower_4_part1_70);
  nodes["vine-flower-4-part1"] = node_vine_flower_4_part1_70;
  const mesh_vine_flower_4_part1_70Geometry = endpoint_vine_flower_4_part1_70
    ? new THREE.CylinderGeometry(endpoint_vine_flower_4_part1_70.endRadius, endpoint_vine_flower_4_part1_70.baseRadius, endpoint_vine_flower_4_part1_70.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_4_part1_70) {
    mesh_vine_flower_4_part1_70Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_4_part1_70 = new THREE.Mesh(
    mesh_vine_flower_4_part1_70Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_4_part1_70.name = "Petal2";
  if (endpoint_vine_flower_4_part1_70) {
    mesh_vine_flower_4_part1_70.position.copy(endpoint_vine_flower_4_part1_70.midpoint);
    mesh_vine_flower_4_part1_70.quaternion.copy(endpoint_vine_flower_4_part1_70.quaternion);
  }
  mesh_vine_flower_4_part1_70.castShadow = options.castShadow ?? true;
  mesh_vine_flower_4_part1_70.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_4_part1_70.userData.sculptComponent = {"id": "vine-flower-4-part1", "name": "Petal2", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, 0.038], "rotation": [0.0, 1.25664, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(240, 176, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part1_70.add(mesh_vine_flower_4_part1_70);
  meshes["vine-flower-4-part1"] = mesh_vine_flower_4_part1_70;
  colliders["vine-flower-4-part1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-2"] ??= [];
  destructionGroups["petal-2"].push(node_vine_flower_4_part1_70);

  const endpoint_vine_flower_4_part2_71 = makeAttachmentEndpoint(null);
  const node_vine_flower_4_part2_71 = new THREE.Group();
  node_vine_flower_4_part2_71.name = "Petal3__pivot";
  node_vine_flower_4_part2_71.scale.set(1, 1, 1);
  if (endpoint_vine_flower_4_part2_71) {
    node_vine_flower_4_part2_71.position.copy(endpoint_vine_flower_4_part2_71.start);
    node_vine_flower_4_part2_71.rotation.set(0.0, 2.51327, 0.0);
  } else {
    node_vine_flower_4_part2_71.position.set(-0.032, 0.0, 0.024);
    node_vine_flower_4_part2_71.rotation.set(0.0, 2.51327, 0.0);
  }
  node_vine_flower_4_part2_71.userData.sculptComponent = {"id": "vine-flower-4-part2", "name": "Petal3", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, 0.024], "rotation": [0.0, 2.51327, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(176, 128, 208, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part2_71.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-4"] ?? root).add(node_vine_flower_4_part2_71);
  nodes["vine-flower-4-part2"] = node_vine_flower_4_part2_71;
  const mesh_vine_flower_4_part2_71Geometry = endpoint_vine_flower_4_part2_71
    ? new THREE.CylinderGeometry(endpoint_vine_flower_4_part2_71.endRadius, endpoint_vine_flower_4_part2_71.baseRadius, endpoint_vine_flower_4_part2_71.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_4_part2_71) {
    mesh_vine_flower_4_part2_71Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_4_part2_71 = new THREE.Mesh(
    mesh_vine_flower_4_part2_71Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_4_part2_71.name = "Petal3";
  if (endpoint_vine_flower_4_part2_71) {
    mesh_vine_flower_4_part2_71.position.copy(endpoint_vine_flower_4_part2_71.midpoint);
    mesh_vine_flower_4_part2_71.quaternion.copy(endpoint_vine_flower_4_part2_71.quaternion);
  }
  mesh_vine_flower_4_part2_71.castShadow = options.castShadow ?? true;
  mesh_vine_flower_4_part2_71.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_4_part2_71.userData.sculptComponent = {"id": "vine-flower-4-part2", "name": "Petal3", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, 0.024], "rotation": [0.0, 2.51327, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(176, 128, 208, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part2_71.add(mesh_vine_flower_4_part2_71);
  meshes["vine-flower-4-part2"] = mesh_vine_flower_4_part2_71;
  colliders["vine-flower-4-part2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-3"] ??= [];
  destructionGroups["petal-3"].push(node_vine_flower_4_part2_71);

  const endpoint_vine_flower_4_part3_72 = makeAttachmentEndpoint(null);
  const node_vine_flower_4_part3_72 = new THREE.Group();
  node_vine_flower_4_part3_72.name = "Petal4__pivot";
  node_vine_flower_4_part3_72.scale.set(1, 1, 1);
  if (endpoint_vine_flower_4_part3_72) {
    node_vine_flower_4_part3_72.position.copy(endpoint_vine_flower_4_part3_72.start);
    node_vine_flower_4_part3_72.rotation.set(0.0, 3.76991, 0.0);
  } else {
    node_vine_flower_4_part3_72.position.set(-0.032, 0.0, -0.024);
    node_vine_flower_4_part3_72.rotation.set(0.0, 3.76991, 0.0);
  }
  node_vine_flower_4_part3_72.userData.sculptComponent = {"id": "vine-flower-4-part3", "name": "Petal4", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, -0.024], "rotation": [0.0, 3.76991, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(240, 224, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part3_72.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-4"] ?? root).add(node_vine_flower_4_part3_72);
  nodes["vine-flower-4-part3"] = node_vine_flower_4_part3_72;
  const mesh_vine_flower_4_part3_72Geometry = endpoint_vine_flower_4_part3_72
    ? new THREE.CylinderGeometry(endpoint_vine_flower_4_part3_72.endRadius, endpoint_vine_flower_4_part3_72.baseRadius, endpoint_vine_flower_4_part3_72.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_4_part3_72) {
    mesh_vine_flower_4_part3_72Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_4_part3_72 = new THREE.Mesh(
    mesh_vine_flower_4_part3_72Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_4_part3_72.name = "Petal4";
  if (endpoint_vine_flower_4_part3_72) {
    mesh_vine_flower_4_part3_72.position.copy(endpoint_vine_flower_4_part3_72.midpoint);
    mesh_vine_flower_4_part3_72.quaternion.copy(endpoint_vine_flower_4_part3_72.quaternion);
  }
  mesh_vine_flower_4_part3_72.castShadow = options.castShadow ?? true;
  mesh_vine_flower_4_part3_72.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_4_part3_72.userData.sculptComponent = {"id": "vine-flower-4-part3", "name": "Petal4", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.032, 0, -0.024], "rotation": [0.0, 3.76991, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(240, 224, 128, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part3_72.add(mesh_vine_flower_4_part3_72);
  meshes["vine-flower-4-part3"] = mesh_vine_flower_4_part3_72;
  colliders["vine-flower-4-part3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-4"] ??= [];
  destructionGroups["petal-4"].push(node_vine_flower_4_part3_72);

  const endpoint_vine_flower_4_part4_73 = makeAttachmentEndpoint(null);
  const node_vine_flower_4_part4_73 = new THREE.Group();
  node_vine_flower_4_part4_73.name = "Petal5__pivot";
  node_vine_flower_4_part4_73.scale.set(1, 1, 1);
  if (endpoint_vine_flower_4_part4_73) {
    node_vine_flower_4_part4_73.position.copy(endpoint_vine_flower_4_part4_73.start);
    node_vine_flower_4_part4_73.rotation.set(0.0, 5.02655, 0.0);
  } else {
    node_vine_flower_4_part4_73.position.set(0.012, 0.0, -0.038);
    node_vine_flower_4_part4_73.rotation.set(0.0, 5.02655, 0.0);
  }
  node_vine_flower_4_part4_73.userData.sculptComponent = {"id": "vine-flower-4-part4", "name": "Petal5", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, -0.038], "rotation": [0.0, 5.02655, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal5", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part4_73.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-4"] ?? root).add(node_vine_flower_4_part4_73);
  nodes["vine-flower-4-part4"] = node_vine_flower_4_part4_73;
  const mesh_vine_flower_4_part4_73Geometry = endpoint_vine_flower_4_part4_73
    ? new THREE.CylinderGeometry(endpoint_vine_flower_4_part4_73.endRadius, endpoint_vine_flower_4_part4_73.baseRadius, endpoint_vine_flower_4_part4_73.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_4_part4_73) {
    mesh_vine_flower_4_part4_73Geometry.scale(0.06, 0.04, 0.02);
  }
  const mesh_vine_flower_4_part4_73 = new THREE.Mesh(
    mesh_vine_flower_4_part4_73Geometry,
    materialMap["flower-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_4_part4_73.name = "Petal5";
  if (endpoint_vine_flower_4_part4_73) {
    mesh_vine_flower_4_part4_73.position.copy(endpoint_vine_flower_4_part4_73.midpoint);
    mesh_vine_flower_4_part4_73.quaternion.copy(endpoint_vine_flower_4_part4_73.quaternion);
  }
  mesh_vine_flower_4_part4_73.castShadow = options.castShadow ?? true;
  mesh_vine_flower_4_part4_73.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_4_part4_73.userData.sculptComponent = {"id": "vine-flower-4-part4", "name": "Petal5", "level": "micro", "role": "petal", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.06, "height": 0.04, "depth": 0.02, "units": "world", "confidence": 0.8}, "transform": {"position": [0.012, 0, -0.038], "rotation": [0.0, 5.02655, 0.0], "scale": [0.06, 0.04, 0.02]}, "material": "flower-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for Petal5", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(240, 160, 187, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "petal-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part4_73.add(mesh_vine_flower_4_part4_73);
  meshes["vine-flower-4-part4"] = mesh_vine_flower_4_part4_73;
  colliders["vine-flower-4-part4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["petal-5"] ??= [];
  destructionGroups["petal-5"].push(node_vine_flower_4_part4_73);

  const endpoint_vine_flower_4_part5_74 = makeAttachmentEndpoint(null);
  const node_vine_flower_4_part5_74 = new THREE.Group();
  node_vine_flower_4_part5_74.name = "FlowerCenter__pivot";
  node_vine_flower_4_part5_74.scale.set(1, 1, 1);
  if (endpoint_vine_flower_4_part5_74) {
    node_vine_flower_4_part5_74.position.copy(endpoint_vine_flower_4_part5_74.start);
    node_vine_flower_4_part5_74.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_flower_4_part5_74.position.set(0.0, 0.0, 0.0);
    node_vine_flower_4_part5_74.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_flower_4_part5_74.userData.sculptComponent = {"id": "vine-flower-4-part5", "name": "FlowerCenter", "level": "micro", "role": "flower-center", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.03, 0.03, 0.03]}, "material": "flower-center-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for FlowerCenter", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 200, 64, 1.0)", "secondaryAlbedo": "rgba(232, 216, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part5_74.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-flower-4"] ?? root).add(node_vine_flower_4_part5_74);
  nodes["vine-flower-4-part5"] = node_vine_flower_4_part5_74;
  const mesh_vine_flower_4_part5_74Geometry = endpoint_vine_flower_4_part5_74
    ? new THREE.CylinderGeometry(endpoint_vine_flower_4_part5_74.endRadius, endpoint_vine_flower_4_part5_74.baseRadius, endpoint_vine_flower_4_part5_74.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_flower_4_part5_74) {
    mesh_vine_flower_4_part5_74Geometry.scale(0.03, 0.03, 0.03);
  }
  const mesh_vine_flower_4_part5_74 = new THREE.Mesh(
    mesh_vine_flower_4_part5_74Geometry,
    materialMap["flower-center-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_4_part5_74.name = "FlowerCenter";
  if (endpoint_vine_flower_4_part5_74) {
    mesh_vine_flower_4_part5_74.position.copy(endpoint_vine_flower_4_part5_74.midpoint);
    mesh_vine_flower_4_part5_74.quaternion.copy(endpoint_vine_flower_4_part5_74.quaternion);
  }
  mesh_vine_flower_4_part5_74.castShadow = options.castShadow ?? true;
  mesh_vine_flower_4_part5_74.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_4_part5_74.userData.sculptComponent = {"id": "vine-flower-4-part5", "name": "FlowerCenter", "level": "micro", "role": "flower-center", "importance": 0.5, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-flower-4", "attachment": {"parentSocket": "vine-flower-1-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-flower-4"}, "dimensions": {"width": 0.03, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.03, 0.03, 0.03]}, "material": "flower-center-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for FlowerCenter", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 200, 64, 1.0)", "secondaryAlbedo": "rgba(232, 216, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "flower-center", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_flower_4_part5_74.add(mesh_vine_flower_4_part5_74);
  meshes["vine-flower-4-part5"] = mesh_vine_flower_4_part5_74;
  colliders["vine-flower-4-part5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["flower-center"] ??= [];
  destructionGroups["flower-center"].push(node_vine_flower_4_part5_74);

  const attachment_window_01m_75 = {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_window_01m_75 = makeAttachmentEndpoint(attachment_window_01m_75);
  const node_window_01m_75 = new THREE.Group();
  node_window_01m_75.name = "Window01Mirror__pivot";
  node_window_01m_75.scale.set(1, 1, 1);
  if (endpoint_window_01m_75) {
    node_window_01m_75.position.copy(endpoint_window_01m_75.start);
    node_window_01m_75.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01m_75.position.set(-0.9, 0.0, -0.78);
    node_window_01m_75.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01m_75.userData.sculptComponent = {"id": "window-01m", "name": "Window01Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-0.9, 0, -0.78], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "topologyRationale": "Solid geometry for Window01", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_01m_75.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_01m_75);
  nodes["window-01m"] = node_window_01m_75;
  const mesh_window_01m_75Geometry = endpoint_window_01m_75
    ? new THREE.CylinderGeometry(endpoint_window_01m_75.endRadius, endpoint_window_01m_75.baseRadius, endpoint_window_01m_75.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_window_01m_75) {
    mesh_window_01m_75Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_01m_75 = new THREE.Mesh(
    mesh_window_01m_75Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01m_75.name = "Window01Mirror";
  if (endpoint_window_01m_75) {
    mesh_window_01m_75.position.copy(endpoint_window_01m_75.midpoint);
    mesh_window_01m_75.quaternion.copy(endpoint_window_01m_75.quaternion);
  }
  mesh_window_01m_75.castShadow = options.castShadow ?? true;
  mesh_window_01m_75.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01m_75.visible = false; // 容器节点不渲染
  mesh_window_01m_75.userData.sculptComponent = {"id": "window-01m", "name": "Window01Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [-0.9, 0, -0.78], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "topologyRationale": "Solid geometry for Window01", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_01m_75.add(mesh_window_01m_75);
  meshes["window-01m"] = mesh_window_01m_75;
  colliders["window-01m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01"] ??= [];
  destructionGroups["window-01"].push(node_window_01m_75);

  const endpoint_window_framem_76 = makeAttachmentEndpoint(null);
  const node_window_framem_76 = new THREE.Group();
  node_window_framem_76.name = "WindowFrameMirror__pivot";
  node_window_framem_76.scale.set(1, 1, 1);
  if (endpoint_window_framem_76) {
    node_window_framem_76.position.copy(endpoint_window_framem_76.start);
    node_window_framem_76.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_framem_76.position.set(0.0, 0.0, 0.0);
    node_window_framem_76.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_framem_76.userData.sculptComponent = {"id": "window-framem", "name": "WindowFrameMirror", "level": "meso", "role": "frame", "importance": 0.7, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.06]}, "geometryDescriptor": {"topologyIntent": "hollow frame, outer dims 0.5x0.5, inner cutout 0.4x0.4, depth 0.06", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.005, "segments": 1}}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowFrame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "wood grain along frame", "strength": 0.3, "scale": 18.0}, "roughnessVariation": {"pattern": "grain sheen variation", "amount": 0.1}}};
  node_window_framem_76.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_framem_76);
  nodes["window-framem"] = node_window_framem_76;
  const mesh_window_framem_76Geometry = endpoint_window_framem_76
    ? new THREE.CylinderGeometry(endpoint_window_framem_76.endRadius, endpoint_window_framem_76.baseRadius, endpoint_window_framem_76.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_framem_76) {
    mesh_window_framem_76Geometry.scale(0.5, 0.5, 0.06);
  }
  const mesh_window_framem_76 = new THREE.Mesh(
    mesh_window_framem_76Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_framem_76.name = "WindowFrameMirror";
  if (endpoint_window_framem_76) {
    mesh_window_framem_76.position.copy(endpoint_window_framem_76.midpoint);
    mesh_window_framem_76.quaternion.copy(endpoint_window_framem_76.quaternion);
  }
  mesh_window_framem_76.castShadow = options.castShadow ?? true;
  mesh_window_framem_76.receiveShadow = options.receiveShadow ?? true;
  mesh_window_framem_76.userData.sculptComponent = {"id": "window-framem", "name": "WindowFrameMirror", "level": "meso", "role": "frame", "importance": 0.7, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.06]}, "geometryDescriptor": {"topologyIntent": "hollow frame, outer dims 0.5x0.5, inner cutout 0.4x0.4, depth 0.06", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.005, "segments": 1}}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowFrame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "wood grain along frame", "strength": 0.3, "scale": 18.0}, "roughnessVariation": {"pattern": "grain sheen variation", "amount": 0.1}}};
  node_window_framem_76.add(mesh_window_framem_76);
  meshes["window-framem"] = mesh_window_framem_76;
  colliders["window-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_framem_76);

  const endpoint_window_glassm_77 = makeAttachmentEndpoint(null);
  const node_window_glassm_77 = new THREE.Group();
  node_window_glassm_77.name = "WindowGlassMirror__pivot";
  node_window_glassm_77.scale.set(1, 1, 1);
  if (endpoint_window_glassm_77) {
    node_window_glassm_77.position.copy(endpoint_window_glassm_77.start);
    node_window_glassm_77.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_glassm_77.position.set(0.0, 0.0, 0.045);
    node_window_glassm_77.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_glassm_77.userData.sculptComponent = {"id": "window-glassm", "name": "WindowGlassMirror", "level": "meso", "role": "glass", "importance": 0.75, "confidence": 0.92, "primitive": "plane-card", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowGlass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_glassm_77.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_glassm_77);
  nodes["window-glassm"] = node_window_glassm_77;
  const mesh_window_glassm_77Geometry = endpoint_window_glassm_77
    ? new THREE.CylinderGeometry(endpoint_window_glassm_77.endRadius, endpoint_window_glassm_77.baseRadius, endpoint_window_glassm_77.length, 16, 6)
    : new THREE.PlaneGeometry(1, 1, 12, 12);
  if (!endpoint_window_glassm_77) {
    mesh_window_glassm_77Geometry.scale(0.4, 0.4, 0.01);
  }
  const mesh_window_glassm_77 = new THREE.Mesh(
    mesh_window_glassm_77Geometry,
    materialMap["window-glass-emissive"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_glassm_77.name = "WindowGlassMirror";
  if (endpoint_window_glassm_77) {
    mesh_window_glassm_77.position.copy(endpoint_window_glassm_77.midpoint);
    mesh_window_glassm_77.quaternion.copy(endpoint_window_glassm_77.quaternion);
  }
  mesh_window_glassm_77.castShadow = options.castShadow ?? true;
  mesh_window_glassm_77.receiveShadow = options.receiveShadow ?? true;
  mesh_window_glassm_77.userData.sculptComponent = {"id": "window-glassm", "name": "WindowGlassMirror", "level": "meso", "role": "glass", "importance": 0.75, "confidence": 0.92, "primitive": "plane-card", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowGlass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_glassm_77.add(mesh_window_glassm_77);
  meshes["window-glassm"] = mesh_window_glassm_77;
  colliders["window-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-glass"] ??= [];
  destructionGroups["window-glass"].push(node_window_glassm_77);

  const endpoint_window_cross_hm_78 = makeAttachmentEndpoint(null);
  const node_window_cross_hm_78 = new THREE.Group();
  node_window_cross_hm_78.name = "WindowCrossHMirror__pivot";
  node_window_cross_hm_78.scale.set(1, 1, 1);
  if (endpoint_window_cross_hm_78) {
    node_window_cross_hm_78.position.copy(endpoint_window_cross_hm_78.start);
    node_window_cross_hm_78.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_cross_hm_78.position.set(0.0, 0.0, 0.06);
    node_window_cross_hm_78.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_cross_hm_78.userData.sculptComponent = {"id": "window-cross-hm", "name": "WindowCrossHMirror", "level": "meso", "role": "cross-divider", "importance": 0.5, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowCrossH", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-h", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_cross_hm_78.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-h", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_cross_hm_78);
  nodes["window-cross-hm"] = node_window_cross_hm_78;
  const mesh_window_cross_hm_78Geometry = endpoint_window_cross_hm_78
    ? new THREE.CylinderGeometry(endpoint_window_cross_hm_78.endRadius, endpoint_window_cross_hm_78.baseRadius, endpoint_window_cross_hm_78.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_cross_hm_78) {
    mesh_window_cross_hm_78Geometry.scale(0.4, 0.03, 0.03);
  }
  const mesh_window_cross_hm_78 = new THREE.Mesh(
    mesh_window_cross_hm_78Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_cross_hm_78.name = "WindowCrossHMirror";
  if (endpoint_window_cross_hm_78) {
    mesh_window_cross_hm_78.position.copy(endpoint_window_cross_hm_78.midpoint);
    mesh_window_cross_hm_78.quaternion.copy(endpoint_window_cross_hm_78.quaternion);
  }
  mesh_window_cross_hm_78.castShadow = options.castShadow ?? true;
  mesh_window_cross_hm_78.receiveShadow = options.receiveShadow ?? true;
  mesh_window_cross_hm_78.userData.sculptComponent = {"id": "window-cross-hm", "name": "WindowCrossHMirror", "level": "meso", "role": "cross-divider", "importance": 0.5, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowCrossH", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-h", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_cross_hm_78.add(mesh_window_cross_hm_78);
  meshes["window-cross-hm"] = mesh_window_cross_hm_78;
  colliders["window-cross-hm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-cross-h"] ??= [];
  destructionGroups["window-cross-h"].push(node_window_cross_hm_78);

  const endpoint_window_cross_vm_79 = makeAttachmentEndpoint(null);
  const node_window_cross_vm_79 = new THREE.Group();
  node_window_cross_vm_79.name = "WindowCrossVMirror__pivot";
  node_window_cross_vm_79.scale.set(1, 1, 1);
  if (endpoint_window_cross_vm_79) {
    node_window_cross_vm_79.position.copy(endpoint_window_cross_vm_79.start);
    node_window_cross_vm_79.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_cross_vm_79.position.set(0.0, 0.0, 0.06);
    node_window_cross_vm_79.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_cross_vm_79.userData.sculptComponent = {"id": "window-cross-vm", "name": "WindowCrossVMirror", "level": "meso", "role": "cross-divider", "importance": 0.5, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowCrossV", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-v", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_cross_vm_79.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-v", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_cross_vm_79);
  nodes["window-cross-vm"] = node_window_cross_vm_79;
  const mesh_window_cross_vm_79Geometry = endpoint_window_cross_vm_79
    ? new THREE.CylinderGeometry(endpoint_window_cross_vm_79.endRadius, endpoint_window_cross_vm_79.baseRadius, endpoint_window_cross_vm_79.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_cross_vm_79) {
    mesh_window_cross_vm_79Geometry.scale(0.03, 0.4, 0.03);
  }
  const mesh_window_cross_vm_79 = new THREE.Mesh(
    mesh_window_cross_vm_79Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_cross_vm_79.name = "WindowCrossVMirror";
  if (endpoint_window_cross_vm_79) {
    mesh_window_cross_vm_79.position.copy(endpoint_window_cross_vm_79.midpoint);
    mesh_window_cross_vm_79.quaternion.copy(endpoint_window_cross_vm_79.quaternion);
  }
  mesh_window_cross_vm_79.castShadow = options.castShadow ?? true;
  mesh_window_cross_vm_79.receiveShadow = options.receiveShadow ?? true;
  mesh_window_cross_vm_79.userData.sculptComponent = {"id": "window-cross-vm", "name": "WindowCrossVMirror", "level": "meso", "role": "cross-divider", "importance": 0.5, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowCrossV", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-cross-v", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_cross_vm_79.add(mesh_window_cross_vm_79);
  meshes["window-cross-vm"] = mesh_window_cross_vm_79;
  colliders["window-cross-vm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-cross-v"] ??= [];
  destructionGroups["window-cross-v"].push(node_window_cross_vm_79);

  const endpoint_window_sillm_80 = makeAttachmentEndpoint(null);
  const node_window_sillm_80 = new THREE.Group();
  node_window_sillm_80.name = "WindowSillMirror__pivot";
  node_window_sillm_80.scale.set(1, 1, 1);
  if (endpoint_window_sillm_80) {
    node_window_sillm_80.position.copy(endpoint_window_sillm_80.start);
    node_window_sillm_80.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_sillm_80.position.set(0.0, -0.27, -0.02);
    node_window_sillm_80.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_sillm_80.userData.sculptComponent = {"id": "window-sillm", "name": "WindowSillMirror", "level": "meso", "role": "sill", "importance": 0.5, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowSill", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-sill", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_sillm_80.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-sill", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_sillm_80);
  nodes["window-sillm"] = node_window_sillm_80;
  const mesh_window_sillm_80Geometry = endpoint_window_sillm_80
    ? new THREE.CylinderGeometry(endpoint_window_sillm_80.endRadius, endpoint_window_sillm_80.baseRadius, endpoint_window_sillm_80.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_sillm_80) {
    mesh_window_sillm_80Geometry.scale(0.55, 0.04, 0.08);
  }
  const mesh_window_sillm_80 = new THREE.Mesh(
    mesh_window_sillm_80Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_sillm_80.name = "WindowSillMirror";
  if (endpoint_window_sillm_80) {
    mesh_window_sillm_80.position.copy(endpoint_window_sillm_80.midpoint);
    mesh_window_sillm_80.quaternion.copy(endpoint_window_sillm_80.quaternion);
  }
  mesh_window_sillm_80.castShadow = options.castShadow ?? true;
  mesh_window_sillm_80.receiveShadow = options.receiveShadow ?? true;
  mesh_window_sillm_80.userData.sculptComponent = {"id": "window-sillm", "name": "WindowSillMirror", "level": "meso", "role": "sill", "importance": 0.5, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "window-01m"}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for WindowSill", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-sill", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_sillm_80.add(mesh_window_sillm_80);
  meshes["window-sillm"] = mesh_window_sillm_80;
  colliders["window-sillm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-sill"] ??= [];
  destructionGroups["window-sill"].push(node_window_sillm_80);

  const attachment_window_02m_81 = {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_window_02m_81 = makeAttachmentEndpoint(attachment_window_02m_81);
  const node_window_02m_81 = new THREE.Group();
  node_window_02m_81.name = "Window02Mirror__pivot";
  node_window_02m_81.scale.set(1, 1, 1);
  if (endpoint_window_02m_81) {
    node_window_02m_81.position.copy(endpoint_window_02m_81.start);
    node_window_02m_81.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02m_81.position.set(0.0, 0.0, -0.78);
    node_window_02m_81.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02m_81.userData.sculptComponent = {"id": "window-02m", "name": "Window02Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0, 0, -0.78], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for Window02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_02m_81.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_02m_81);
  nodes["window-02m"] = node_window_02m_81;
  const mesh_window_02m_81Geometry = endpoint_window_02m_81
    ? new THREE.CylinderGeometry(endpoint_window_02m_81.endRadius, endpoint_window_02m_81.baseRadius, endpoint_window_02m_81.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_window_02m_81) {
    mesh_window_02m_81Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_02m_81 = new THREE.Mesh(
    mesh_window_02m_81Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02m_81.name = "Window02Mirror";
  if (endpoint_window_02m_81) {
    mesh_window_02m_81.position.copy(endpoint_window_02m_81.midpoint);
    mesh_window_02m_81.quaternion.copy(endpoint_window_02m_81.quaternion);
  }
  mesh_window_02m_81.castShadow = options.castShadow ?? true;
  mesh_window_02m_81.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02m_81.visible = false; // 容器节点不渲染
  mesh_window_02m_81.userData.sculptComponent = {"id": "window-02m", "name": "Window02Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0, 0, -0.78], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for Window02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_02m_81.add(mesh_window_02m_81);
  meshes["window-02m"] = mesh_window_02m_81;
  colliders["window-02m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02"] ??= [];
  destructionGroups["window-02"].push(node_window_02m_81);

  const endpoint_window_02_framem_82 = makeAttachmentEndpoint(null);
  const node_window_02_framem_82 = new THREE.Group();
  node_window_02_framem_82.name = "Window02FrameMirror__pivot";
  node_window_02_framem_82.scale.set(1, 1, 1);
  if (endpoint_window_02_framem_82) {
    node_window_02_framem_82.position.copy(endpoint_window_02_framem_82.start);
    node_window_02_framem_82.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_framem_82.position.set(0.0, 0.0, 0.0);
    node_window_02_framem_82.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_framem_82.userData.sculptComponent = {"id": "window-02-framem", "name": "Window02FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.06]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_framem_82.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_framem_82);
  nodes["window-02-framem"] = node_window_02_framem_82;
  const mesh_window_02_framem_82Geometry = endpoint_window_02_framem_82
    ? new THREE.CylinderGeometry(endpoint_window_02_framem_82.endRadius, endpoint_window_02_framem_82.baseRadius, endpoint_window_02_framem_82.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_framem_82) {
    mesh_window_02_framem_82Geometry.scale(0.5, 0.5, 0.06);
  }
  const mesh_window_02_framem_82 = new THREE.Mesh(
    mesh_window_02_framem_82Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_framem_82.name = "Window02FrameMirror";
  if (endpoint_window_02_framem_82) {
    mesh_window_02_framem_82.position.copy(endpoint_window_02_framem_82.midpoint);
    mesh_window_02_framem_82.quaternion.copy(endpoint_window_02_framem_82.quaternion);
  }
  mesh_window_02_framem_82.castShadow = options.castShadow ?? true;
  mesh_window_02_framem_82.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_framem_82.userData.sculptComponent = {"id": "window-02-framem", "name": "Window02FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.06]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_framem_82.add(mesh_window_02_framem_82);
  meshes["window-02-framem"] = mesh_window_02_framem_82;
  colliders["window-02-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_framem_82);

  const endpoint_window_02_glassm_83 = makeAttachmentEndpoint(null);
  const node_window_02_glassm_83 = new THREE.Group();
  node_window_02_glassm_83.name = "Window02GlassMirror__pivot";
  node_window_02_glassm_83.scale.set(1, 1, 1);
  if (endpoint_window_02_glassm_83) {
    node_window_02_glassm_83.position.copy(endpoint_window_02_glassm_83.start);
    node_window_02_glassm_83.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_glassm_83.position.set(0.0, 0.0, 0.045);
    node_window_02_glassm_83.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_glassm_83.userData.sculptComponent = {"id": "window-02-glassm", "name": "Window02GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glassm_83.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_glassm_83);
  nodes["window-02-glassm"] = node_window_02_glassm_83;
  const mesh_window_02_glassm_83Geometry = endpoint_window_02_glassm_83
    ? new THREE.CylinderGeometry(endpoint_window_02_glassm_83.endRadius, endpoint_window_02_glassm_83.baseRadius, endpoint_window_02_glassm_83.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_glassm_83) {
    mesh_window_02_glassm_83Geometry.scale(0.4, 0.4, 0.01);
  }
  const mesh_window_02_glassm_83 = new THREE.Mesh(
    mesh_window_02_glassm_83Geometry,
    materialMap["window-glass-emissive"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_glassm_83.name = "Window02GlassMirror";
  if (endpoint_window_02_glassm_83) {
    mesh_window_02_glassm_83.position.copy(endpoint_window_02_glassm_83.midpoint);
    mesh_window_02_glassm_83.quaternion.copy(endpoint_window_02_glassm_83.quaternion);
  }
  mesh_window_02_glassm_83.castShadow = options.castShadow ?? true;
  mesh_window_02_glassm_83.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_glassm_83.userData.sculptComponent = {"id": "window-02-glassm", "name": "Window02GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glassm_83.add(mesh_window_02_glassm_83);
  meshes["window-02-glassm"] = mesh_window_02_glassm_83;
  colliders["window-02-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_glassm_83);

  const endpoint_window_02_cross_hm_84 = makeAttachmentEndpoint(null);
  const node_window_02_cross_hm_84 = new THREE.Group();
  node_window_02_cross_hm_84.name = "Window02CrossHMirror__pivot";
  node_window_02_cross_hm_84.scale.set(1, 1, 1);
  if (endpoint_window_02_cross_hm_84) {
    node_window_02_cross_hm_84.position.copy(endpoint_window_02_cross_hm_84.start);
    node_window_02_cross_hm_84.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_cross_hm_84.position.set(0.0, 0.0, 0.06);
    node_window_02_cross_hm_84.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_cross_hm_84.userData.sculptComponent = {"id": "window-02-cross-hm", "name": "Window02CrossHMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_cross_hm_84.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_cross_hm_84);
  nodes["window-02-cross-hm"] = node_window_02_cross_hm_84;
  const mesh_window_02_cross_hm_84Geometry = endpoint_window_02_cross_hm_84
    ? new THREE.CylinderGeometry(endpoint_window_02_cross_hm_84.endRadius, endpoint_window_02_cross_hm_84.baseRadius, endpoint_window_02_cross_hm_84.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_cross_hm_84) {
    mesh_window_02_cross_hm_84Geometry.scale(0.4, 0.03, 0.03);
  }
  const mesh_window_02_cross_hm_84 = new THREE.Mesh(
    mesh_window_02_cross_hm_84Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_cross_hm_84.name = "Window02CrossHMirror";
  if (endpoint_window_02_cross_hm_84) {
    mesh_window_02_cross_hm_84.position.copy(endpoint_window_02_cross_hm_84.midpoint);
    mesh_window_02_cross_hm_84.quaternion.copy(endpoint_window_02_cross_hm_84.quaternion);
  }
  mesh_window_02_cross_hm_84.castShadow = options.castShadow ?? true;
  mesh_window_02_cross_hm_84.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_cross_hm_84.userData.sculptComponent = {"id": "window-02-cross-hm", "name": "Window02CrossHMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_cross_hm_84.add(mesh_window_02_cross_hm_84);
  meshes["window-02-cross-hm"] = mesh_window_02_cross_hm_84;
  colliders["window-02-cross-hm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_cross_hm_84);

  const endpoint_window_02_cross_vm_85 = makeAttachmentEndpoint(null);
  const node_window_02_cross_vm_85 = new THREE.Group();
  node_window_02_cross_vm_85.name = "Window02CrossVMirror__pivot";
  node_window_02_cross_vm_85.scale.set(1, 1, 1);
  if (endpoint_window_02_cross_vm_85) {
    node_window_02_cross_vm_85.position.copy(endpoint_window_02_cross_vm_85.start);
    node_window_02_cross_vm_85.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_cross_vm_85.position.set(0.0, 0.0, 0.06);
    node_window_02_cross_vm_85.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_cross_vm_85.userData.sculptComponent = {"id": "window-02-cross-vm", "name": "Window02CrossVMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_cross_vm_85.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_cross_vm_85);
  nodes["window-02-cross-vm"] = node_window_02_cross_vm_85;
  const mesh_window_02_cross_vm_85Geometry = endpoint_window_02_cross_vm_85
    ? new THREE.CylinderGeometry(endpoint_window_02_cross_vm_85.endRadius, endpoint_window_02_cross_vm_85.baseRadius, endpoint_window_02_cross_vm_85.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_cross_vm_85) {
    mesh_window_02_cross_vm_85Geometry.scale(0.03, 0.4, 0.03);
  }
  const mesh_window_02_cross_vm_85 = new THREE.Mesh(
    mesh_window_02_cross_vm_85Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_cross_vm_85.name = "Window02CrossVMirror";
  if (endpoint_window_02_cross_vm_85) {
    mesh_window_02_cross_vm_85.position.copy(endpoint_window_02_cross_vm_85.midpoint);
    mesh_window_02_cross_vm_85.quaternion.copy(endpoint_window_02_cross_vm_85.quaternion);
  }
  mesh_window_02_cross_vm_85.castShadow = options.castShadow ?? true;
  mesh_window_02_cross_vm_85.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_cross_vm_85.userData.sculptComponent = {"id": "window-02-cross-vm", "name": "Window02CrossVMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_cross_vm_85.add(mesh_window_02_cross_vm_85);
  meshes["window-02-cross-vm"] = mesh_window_02_cross_vm_85;
  colliders["window-02-cross-vm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_cross_vm_85);

  const endpoint_window_02_sillm_86 = makeAttachmentEndpoint(null);
  const node_window_02_sillm_86 = new THREE.Group();
  node_window_02_sillm_86.name = "Window02SillMirror__pivot";
  node_window_02_sillm_86.scale.set(1, 1, 1);
  if (endpoint_window_02_sillm_86) {
    node_window_02_sillm_86.position.copy(endpoint_window_02_sillm_86.start);
    node_window_02_sillm_86.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_sillm_86.position.set(0.0, -0.27, -0.02);
    node_window_02_sillm_86.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_sillm_86.userData.sculptComponent = {"id": "window-02-sillm", "name": "Window02SillMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_sillm_86.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_sillm_86);
  nodes["window-02-sillm"] = node_window_02_sillm_86;
  const mesh_window_02_sillm_86Geometry = endpoint_window_02_sillm_86
    ? new THREE.CylinderGeometry(endpoint_window_02_sillm_86.endRadius, endpoint_window_02_sillm_86.baseRadius, endpoint_window_02_sillm_86.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_02_sillm_86) {
    mesh_window_02_sillm_86Geometry.scale(0.55, 0.04, 0.08);
  }
  const mesh_window_02_sillm_86 = new THREE.Mesh(
    mesh_window_02_sillm_86Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_sillm_86.name = "Window02SillMirror";
  if (endpoint_window_02_sillm_86) {
    mesh_window_02_sillm_86.position.copy(endpoint_window_02_sillm_86.midpoint);
    mesh_window_02_sillm_86.quaternion.copy(endpoint_window_02_sillm_86.quaternion);
  }
  mesh_window_02_sillm_86.castShadow = options.castShadow ?? true;
  mesh_window_02_sillm_86.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_sillm_86.userData.sculptComponent = {"id": "window-02-sillm", "name": "Window02SillMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_sillm_86.add(mesh_window_02_sillm_86);
  meshes["window-02-sillm"] = mesh_window_02_sillm_86;
  colliders["window-02-sillm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_02_sillm_86);

  const attachment_window_03m_87 = {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_window_03m_87 = makeAttachmentEndpoint(attachment_window_03m_87);
  const node_window_03m_87 = new THREE.Group();
  node_window_03m_87.name = "Window03Mirror__pivot";
  node_window_03m_87.scale.set(1, 1, 1);
  if (endpoint_window_03m_87) {
    node_window_03m_87.position.copy(endpoint_window_03m_87.start);
    node_window_03m_87.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03m_87.position.set(0.9, 0.0, -0.78);
    node_window_03m_87.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03m_87.userData.sculptComponent = {"id": "window-03m", "name": "Window03Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0.9, 0, -0.78], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for Window03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_03m_87.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_03m_87);
  nodes["window-03m"] = node_window_03m_87;
  const mesh_window_03m_87Geometry = endpoint_window_03m_87
    ? new THREE.CylinderGeometry(endpoint_window_03m_87.endRadius, endpoint_window_03m_87.baseRadius, endpoint_window_03m_87.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_window_03m_87) {
    mesh_window_03m_87Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_03m_87 = new THREE.Mesh(
    mesh_window_03m_87Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03m_87.name = "Window03Mirror";
  if (endpoint_window_03m_87) {
    mesh_window_03m_87.position.copy(endpoint_window_03m_87.midpoint);
    mesh_window_03m_87.quaternion.copy(endpoint_window_03m_87.quaternion);
  }
  mesh_window_03m_87.castShadow = options.castShadow ?? true;
  mesh_window_03m_87.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03m_87.visible = false; // 容器节点不渲染
  mesh_window_03m_87.userData.sculptComponent = {"id": "window-03m", "name": "Window03Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.92, "primitive": "cylinder", "parent": "window-system", "attachment": {"parentSocket": "body-side-left", "contactType": "embedded", "embedDepth": 0.02, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "transform": {"position": [0.9, 0, -0.78], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["window-frame", "window-glass", "window-cross-h", "window-cross-v", "window-sill"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for Window03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(240, 216, 96, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_window_03m_87.add(mesh_window_03m_87);
  meshes["window-03m"] = mesh_window_03m_87;
  colliders["window-03m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03"] ??= [];
  destructionGroups["window-03"].push(node_window_03m_87);

  const endpoint_window_03_framem_88 = makeAttachmentEndpoint(null);
  const node_window_03_framem_88 = new THREE.Group();
  node_window_03_framem_88.name = "Window03FrameMirror__pivot";
  node_window_03_framem_88.scale.set(1, 1, 1);
  if (endpoint_window_03_framem_88) {
    node_window_03_framem_88.position.copy(endpoint_window_03_framem_88.start);
    node_window_03_framem_88.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_framem_88.position.set(0.0, 0.0, 0.0);
    node_window_03_framem_88.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_framem_88.userData.sculptComponent = {"id": "window-03-framem", "name": "Window03FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.06]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_framem_88.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_framem_88);
  nodes["window-03-framem"] = node_window_03_framem_88;
  const mesh_window_03_framem_88Geometry = endpoint_window_03_framem_88
    ? new THREE.CylinderGeometry(endpoint_window_03_framem_88.endRadius, endpoint_window_03_framem_88.baseRadius, endpoint_window_03_framem_88.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_framem_88) {
    mesh_window_03_framem_88Geometry.scale(0.5, 0.5, 0.06);
  }
  const mesh_window_03_framem_88 = new THREE.Mesh(
    mesh_window_03_framem_88Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_framem_88.name = "Window03FrameMirror";
  if (endpoint_window_03_framem_88) {
    mesh_window_03_framem_88.position.copy(endpoint_window_03_framem_88.midpoint);
    mesh_window_03_framem_88.quaternion.copy(endpoint_window_03_framem_88.quaternion);
  }
  mesh_window_03_framem_88.castShadow = options.castShadow ?? true;
  mesh_window_03_framem_88.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_framem_88.userData.sculptComponent = {"id": "window-03-framem", "name": "Window03FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.06]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_framem_88.add(mesh_window_03_framem_88);
  meshes["window-03-framem"] = mesh_window_03_framem_88;
  colliders["window-03-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_framem_88);

  const endpoint_window_03_glassm_89 = makeAttachmentEndpoint(null);
  const node_window_03_glassm_89 = new THREE.Group();
  node_window_03_glassm_89.name = "Window03GlassMirror__pivot";
  node_window_03_glassm_89.scale.set(1, 1, 1);
  if (endpoint_window_03_glassm_89) {
    node_window_03_glassm_89.position.copy(endpoint_window_03_glassm_89.start);
    node_window_03_glassm_89.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_glassm_89.position.set(0.0, 0.0, 0.045);
    node_window_03_glassm_89.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_glassm_89.userData.sculptComponent = {"id": "window-03-glassm", "name": "Window03GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glassm_89.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_glassm_89);
  nodes["window-03-glassm"] = node_window_03_glassm_89;
  const mesh_window_03_glassm_89Geometry = endpoint_window_03_glassm_89
    ? new THREE.CylinderGeometry(endpoint_window_03_glassm_89.endRadius, endpoint_window_03_glassm_89.baseRadius, endpoint_window_03_glassm_89.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_glassm_89) {
    mesh_window_03_glassm_89Geometry.scale(0.4, 0.4, 0.01);
  }
  const mesh_window_03_glassm_89 = new THREE.Mesh(
    mesh_window_03_glassm_89Geometry,
    materialMap["window-glass-emissive"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_glassm_89.name = "Window03GlassMirror";
  if (endpoint_window_03_glassm_89) {
    mesh_window_03_glassm_89.position.copy(endpoint_window_03_glassm_89.midpoint);
    mesh_window_03_glassm_89.quaternion.copy(endpoint_window_03_glassm_89.quaternion);
  }
  mesh_window_03_glassm_89.castShadow = options.castShadow ?? true;
  mesh_window_03_glassm_89.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_glassm_89.userData.sculptComponent = {"id": "window-03-glassm", "name": "Window03GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.4, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.4, 0.01]}, "material": "window-glass-emissive", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 216, 96, 1.0)", "secondaryAlbedo": "rgba(255, 240, 176, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glassm_89.add(mesh_window_03_glassm_89);
  meshes["window-03-glassm"] = mesh_window_03_glassm_89;
  colliders["window-03-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_glassm_89);

  const endpoint_window_03_cross_hm_90 = makeAttachmentEndpoint(null);
  const node_window_03_cross_hm_90 = new THREE.Group();
  node_window_03_cross_hm_90.name = "Window03CrossHMirror__pivot";
  node_window_03_cross_hm_90.scale.set(1, 1, 1);
  if (endpoint_window_03_cross_hm_90) {
    node_window_03_cross_hm_90.position.copy(endpoint_window_03_cross_hm_90.start);
    node_window_03_cross_hm_90.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_cross_hm_90.position.set(0.0, 0.0, 0.06);
    node_window_03_cross_hm_90.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_cross_hm_90.userData.sculptComponent = {"id": "window-03-cross-hm", "name": "Window03CrossHMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_cross_hm_90.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_cross_hm_90);
  nodes["window-03-cross-hm"] = node_window_03_cross_hm_90;
  const mesh_window_03_cross_hm_90Geometry = endpoint_window_03_cross_hm_90
    ? new THREE.CylinderGeometry(endpoint_window_03_cross_hm_90.endRadius, endpoint_window_03_cross_hm_90.baseRadius, endpoint_window_03_cross_hm_90.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_cross_hm_90) {
    mesh_window_03_cross_hm_90Geometry.scale(0.4, 0.03, 0.03);
  }
  const mesh_window_03_cross_hm_90 = new THREE.Mesh(
    mesh_window_03_cross_hm_90Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_cross_hm_90.name = "Window03CrossHMirror";
  if (endpoint_window_03_cross_hm_90) {
    mesh_window_03_cross_hm_90.position.copy(endpoint_window_03_cross_hm_90.midpoint);
    mesh_window_03_cross_hm_90.quaternion.copy(endpoint_window_03_cross_hm_90.quaternion);
  }
  mesh_window_03_cross_hm_90.castShadow = options.castShadow ?? true;
  mesh_window_03_cross_hm_90.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_cross_hm_90.userData.sculptComponent = {"id": "window-03-cross-hm", "name": "Window03CrossHMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.03, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.4, 0.03, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_cross_hm_90.add(mesh_window_03_cross_hm_90);
  meshes["window-03-cross-hm"] = mesh_window_03_cross_hm_90;
  colliders["window-03-cross-hm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_cross_hm_90);

  const endpoint_window_03_cross_vm_91 = makeAttachmentEndpoint(null);
  const node_window_03_cross_vm_91 = new THREE.Group();
  node_window_03_cross_vm_91.name = "Window03CrossVMirror__pivot";
  node_window_03_cross_vm_91.scale.set(1, 1, 1);
  if (endpoint_window_03_cross_vm_91) {
    node_window_03_cross_vm_91.position.copy(endpoint_window_03_cross_vm_91.start);
    node_window_03_cross_vm_91.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_cross_vm_91.position.set(0.0, 0.0, 0.06);
    node_window_03_cross_vm_91.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_cross_vm_91.userData.sculptComponent = {"id": "window-03-cross-vm", "name": "Window03CrossVMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_cross_vm_91.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_cross_vm_91);
  nodes["window-03-cross-vm"] = node_window_03_cross_vm_91;
  const mesh_window_03_cross_vm_91Geometry = endpoint_window_03_cross_vm_91
    ? new THREE.CylinderGeometry(endpoint_window_03_cross_vm_91.endRadius, endpoint_window_03_cross_vm_91.baseRadius, endpoint_window_03_cross_vm_91.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_cross_vm_91) {
    mesh_window_03_cross_vm_91Geometry.scale(0.03, 0.4, 0.03);
  }
  const mesh_window_03_cross_vm_91 = new THREE.Mesh(
    mesh_window_03_cross_vm_91Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_cross_vm_91.name = "Window03CrossVMirror";
  if (endpoint_window_03_cross_vm_91) {
    mesh_window_03_cross_vm_91.position.copy(endpoint_window_03_cross_vm_91.midpoint);
    mesh_window_03_cross_vm_91.quaternion.copy(endpoint_window_03_cross_vm_91.quaternion);
  }
  mesh_window_03_cross_vm_91.castShadow = options.castShadow ?? true;
  mesh_window_03_cross_vm_91.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_cross_vm_91.userData.sculptComponent = {"id": "window-03-cross-vm", "name": "Window03CrossVMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.4, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.06], "rotation": [0, 3.14159, 0], "scale": [0.03, 0.4, 0.03]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_cross_vm_91.add(mesh_window_03_cross_vm_91);
  meshes["window-03-cross-vm"] = mesh_window_03_cross_vm_91;
  colliders["window-03-cross-vm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_cross_vm_91);

  const endpoint_window_03_sillm_92 = makeAttachmentEndpoint(null);
  const node_window_03_sillm_92 = new THREE.Group();
  node_window_03_sillm_92.name = "Window03SillMirror__pivot";
  node_window_03_sillm_92.scale.set(1, 1, 1);
  if (endpoint_window_03_sillm_92) {
    node_window_03_sillm_92.position.copy(endpoint_window_03_sillm_92.start);
    node_window_03_sillm_92.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_sillm_92.position.set(0.0, -0.27, -0.02);
    node_window_03_sillm_92.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_sillm_92.userData.sculptComponent = {"id": "window-03-sillm", "name": "Window03SillMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_sillm_92.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_sillm_92);
  nodes["window-03-sillm"] = node_window_03_sillm_92;
  const mesh_window_03_sillm_92Geometry = endpoint_window_03_sillm_92
    ? new THREE.CylinderGeometry(endpoint_window_03_sillm_92.endRadius, endpoint_window_03_sillm_92.baseRadius, endpoint_window_03_sillm_92.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_03_sillm_92) {
    mesh_window_03_sillm_92Geometry.scale(0.55, 0.04, 0.08);
  }
  const mesh_window_03_sillm_92 = new THREE.Mesh(
    mesh_window_03_sillm_92Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_sillm_92.name = "Window03SillMirror";
  if (endpoint_window_03_sillm_92) {
    mesh_window_03_sillm_92.position.copy(endpoint_window_03_sillm_92.midpoint);
    mesh_window_03_sillm_92.quaternion.copy(endpoint_window_03_sillm_92.quaternion);
  }
  mesh_window_03_sillm_92.castShadow = options.castShadow ?? true;
  mesh_window_03_sillm_92.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_sillm_92.userData.sculptComponent = {"id": "window-03-sillm", "name": "Window03SillMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.04, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.27, -0.02], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.04, 0.08]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Flat rectangular part mounted flush on the window opening, edges aligned to the frame", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 58, 32, 1.0)", "secondaryAlbedo": "rgba(74, 48, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.95, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_sillm_92.add(mesh_window_03_sillm_92);
  meshes["window-03-sillm"] = mesh_window_03_sillm_92;
  colliders["window-03-sillm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-frame"] ??= [];
  destructionGroups["window-frame"].push(node_window_03_sillm_92);

  const attachment_vine_stem_1l_93 = {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"};
  const endpoint_vine_stem_1l_93 = makeAttachmentEndpoint(attachment_vine_stem_1l_93);
  const node_vine_stem_1l_93 = new THREE.Group();
  node_vine_stem_1l_93.name = "VineStem1__pivot";
  node_vine_stem_1l_93.scale.set(1, 1, 1);
  if (endpoint_vine_stem_1l_93) {
    node_vine_stem_1l_93.position.copy(endpoint_vine_stem_1l_93.start);
    node_vine_stem_1l_93.rotation.set(0.0, 0.0, 0.08727);
  } else {
    node_vine_stem_1l_93.position.set(0.0, 0.0, 0.0);
    node_vine_stem_1l_93.rotation.set(0.0, 0.0, 0.08727);
  }
  node_vine_stem_1l_93.userData.sculptComponent = {"id": "vine-stem-1l", "name": "VineStem1", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.1056, "height": 0.8, "depth": 0.1056, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.08727], "scale": [0.1056, 0.8, 0.1056]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_1l_93.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_stem_1l_93);
  nodes["vine-stem-1l"] = node_vine_stem_1l_93;
  const mesh_vine_stem_1l_93Geometry = endpoint_vine_stem_1l_93
    ? new THREE.CylinderGeometry(endpoint_vine_stem_1l_93.endRadius, endpoint_vine_stem_1l_93.baseRadius, endpoint_vine_stem_1l_93.length, 16, 6)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_vine_stem_1l_93) {
    mesh_vine_stem_1l_93Geometry.scale(0.1056, 0.8, 0.1056);
  }
  const mesh_vine_stem_1l_93 = new THREE.Mesh(
    mesh_vine_stem_1l_93Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_stem_1l_93.name = "VineStem1";
  if (endpoint_vine_stem_1l_93) {
    mesh_vine_stem_1l_93.position.copy(endpoint_vine_stem_1l_93.midpoint);
    mesh_vine_stem_1l_93.quaternion.copy(endpoint_vine_stem_1l_93.quaternion);
  }
  mesh_vine_stem_1l_93.castShadow = options.castShadow ?? true;
  mesh_vine_stem_1l_93.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_stem_1l_93.userData.sculptComponent = {"id": "vine-stem-1l", "name": "VineStem1", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.1056, "height": 0.8, "depth": 0.1056, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.08727], "scale": [0.1056, 0.8, 0.1056]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_1l_93.add(mesh_vine_stem_1l_93);
  meshes["vine-stem-1l"] = mesh_vine_stem_1l_93;
  colliders["vine-stem-1l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-stem-1"] ??= [];
  destructionGroups["vine-stem-1"].push(node_vine_stem_1l_93);

  const attachment_vine_stem_2l_94 = {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"};
  const endpoint_vine_stem_2l_94 = makeAttachmentEndpoint(attachment_vine_stem_2l_94);
  const node_vine_stem_2l_94 = new THREE.Group();
  node_vine_stem_2l_94.name = "VineStem2__pivot";
  node_vine_stem_2l_94.scale.set(1, 1, 1);
  if (endpoint_vine_stem_2l_94) {
    node_vine_stem_2l_94.position.copy(endpoint_vine_stem_2l_94.start);
    node_vine_stem_2l_94.rotation.set(0.0, 0.0, -0.05236);
  } else {
    node_vine_stem_2l_94.position.set(0.3, 0.1, 0.0);
    node_vine_stem_2l_94.rotation.set(0.0, 0.0, -0.05236);
  }
  node_vine_stem_2l_94.userData.sculptComponent = {"id": "vine-stem-2l", "name": "VineStem2", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.088, "height": 0.6, "depth": 0.088, "units": "world", "confidence": 0.8}, "transform": {"position": [0.3, 0.1, 0], "rotation": [0.0, 0.0, -0.05236], "scale": [0.088, 0.6, 0.088]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_2l_94.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_stem_2l_94);
  nodes["vine-stem-2l"] = node_vine_stem_2l_94;
  const mesh_vine_stem_2l_94Geometry = endpoint_vine_stem_2l_94
    ? new THREE.CylinderGeometry(endpoint_vine_stem_2l_94.endRadius, endpoint_vine_stem_2l_94.baseRadius, endpoint_vine_stem_2l_94.length, 16, 6)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_vine_stem_2l_94) {
    mesh_vine_stem_2l_94Geometry.scale(0.088, 0.6, 0.088);
  }
  const mesh_vine_stem_2l_94 = new THREE.Mesh(
    mesh_vine_stem_2l_94Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_stem_2l_94.name = "VineStem2";
  if (endpoint_vine_stem_2l_94) {
    mesh_vine_stem_2l_94.position.copy(endpoint_vine_stem_2l_94.midpoint);
    mesh_vine_stem_2l_94.quaternion.copy(endpoint_vine_stem_2l_94.quaternion);
  }
  mesh_vine_stem_2l_94.castShadow = options.castShadow ?? true;
  mesh_vine_stem_2l_94.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_stem_2l_94.userData.sculptComponent = {"id": "vine-stem-2l", "name": "VineStem2", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.088, "height": 0.6, "depth": 0.088, "units": "world", "confidence": 0.8}, "transform": {"position": [0.3, 0.1, 0], "rotation": [0.0, 0.0, -0.05236], "scale": [0.088, 0.6, 0.088]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_2l_94.add(mesh_vine_stem_2l_94);
  meshes["vine-stem-2l"] = mesh_vine_stem_2l_94;
  colliders["vine-stem-2l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-stem-2"] ??= [];
  destructionGroups["vine-stem-2"].push(node_vine_stem_2l_94);

  const attachment_vine_stem_3l_95 = {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"};
  const endpoint_vine_stem_3l_95 = makeAttachmentEndpoint(attachment_vine_stem_3l_95);
  const node_vine_stem_3l_95 = new THREE.Group();
  node_vine_stem_3l_95.name = "VineStem3__pivot";
  node_vine_stem_3l_95.scale.set(1, 1, 1);
  if (endpoint_vine_stem_3l_95) {
    node_vine_stem_3l_95.position.copy(endpoint_vine_stem_3l_95.start);
    node_vine_stem_3l_95.rotation.set(0.0, 0.0, 0.13963);
  } else {
    node_vine_stem_3l_95.position.set(-0.2, 0.15, 0.0);
    node_vine_stem_3l_95.rotation.set(0.0, 0.0, 0.13963);
  }
  node_vine_stem_3l_95.userData.sculptComponent = {"id": "vine-stem-3l", "name": "VineStem3", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.0704, "height": 0.5, "depth": 0.0704, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.2, 0.15, 0], "rotation": [0.0, 0.0, 0.13963], "scale": [0.0704, 0.5, 0.0704]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_3l_95.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_stem_3l_95);
  nodes["vine-stem-3l"] = node_vine_stem_3l_95;
  const mesh_vine_stem_3l_95Geometry = endpoint_vine_stem_3l_95
    ? new THREE.CylinderGeometry(endpoint_vine_stem_3l_95.endRadius, endpoint_vine_stem_3l_95.baseRadius, endpoint_vine_stem_3l_95.length, 16, 6)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_vine_stem_3l_95) {
    mesh_vine_stem_3l_95Geometry.scale(0.0704, 0.5, 0.0704);
  }
  const mesh_vine_stem_3l_95 = new THREE.Mesh(
    mesh_vine_stem_3l_95Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_stem_3l_95.name = "VineStem3";
  if (endpoint_vine_stem_3l_95) {
    mesh_vine_stem_3l_95.position.copy(endpoint_vine_stem_3l_95.midpoint);
    mesh_vine_stem_3l_95.quaternion.copy(endpoint_vine_stem_3l_95.quaternion);
  }
  mesh_vine_stem_3l_95.castShadow = options.castShadow ?? true;
  mesh_vine_stem_3l_95.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_stem_3l_95.userData.sculptComponent = {"id": "vine-stem-3l", "name": "VineStem3", "level": "meso", "role": "stem", "importance": 0.6, "confidence": 0.85, "primitive": "tube", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface-wrap", "embedDepth": 0.01, "gapTolerance": 0.02, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.0704, "height": 0.5, "depth": 0.0704, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.2, 0.15, 0], "rotation": [0.0, 0.0, 0.13963], "scale": [0.0704, 0.5, 0.0704]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineStem3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-stem-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_stem_3l_95.add(mesh_vine_stem_3l_95);
  meshes["vine-stem-3l"] = mesh_vine_stem_3l_95;
  colliders["vine-stem-3l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-stem-3"] ??= [];
  destructionGroups["vine-stem-3"].push(node_vine_stem_3l_95);

  const attachment_vine_flower_1l_96 = {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"};
  const endpoint_vine_flower_1l_96 = makeAttachmentEndpoint(attachment_vine_flower_1l_96);
  const node_vine_flower_1l_96 = new THREE.Group();
  node_vine_flower_1l_96.name = "VineFlower1__pivot";
  node_vine_flower_1l_96.scale.set(1, 1, 1);
  if (endpoint_vine_flower_1l_96) {
    node_vine_flower_1l_96.position.copy(endpoint_vine_flower_1l_96.start);
    node_vine_flower_1l_96.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vine_flower_1l_96.position.set(0.0, 0.35, 0.0);
    node_vine_flower_1l_96.rotation.set(0.0, 0.0, 0.0);
  }
  node_vine_flower_1l_96.userData.sculptComponent = {"id": "vine-flower-1l", "name": "VineFlower1", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "transform": {"position": [0, 0.35, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "topologyRationale": "Solid geometry for VineFlower1", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_1l_96.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_flower_1l_96);
  nodes["vine-flower-1l"] = node_vine_flower_1l_96;
  const mesh_vine_flower_1l_96Geometry = endpoint_vine_flower_1l_96
    ? new THREE.CylinderGeometry(endpoint_vine_flower_1l_96.endRadius, endpoint_vine_flower_1l_96.baseRadius, endpoint_vine_flower_1l_96.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_flower_1l_96) {
    mesh_vine_flower_1l_96Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_vine_flower_1l_96 = new THREE.Mesh(
    mesh_vine_flower_1l_96Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_1l_96.name = "VineFlower1";
  if (endpoint_vine_flower_1l_96) {
    mesh_vine_flower_1l_96.position.copy(endpoint_vine_flower_1l_96.midpoint);
    mesh_vine_flower_1l_96.quaternion.copy(endpoint_vine_flower_1l_96.quaternion);
  }
  mesh_vine_flower_1l_96.castShadow = options.castShadow ?? true;
  mesh_vine_flower_1l_96.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_1l_96.visible = false; // 容器节点不渲染
  mesh_vine_flower_1l_96.userData.sculptComponent = {"id": "vine-flower-1l", "name": "VineFlower1", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "transform": {"position": [0, 0.35, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "topologyRationale": "Solid geometry for VineFlower1", "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 138, 170, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_1l_96.add(mesh_vine_flower_1l_96);
  meshes["vine-flower-1l"] = mesh_vine_flower_1l_96;
  colliders["vine-flower-1l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-flower-1"] ??= [];
  destructionGroups["vine-flower-1"].push(node_vine_flower_1l_96);

  const attachment_vine_flower_2l_97 = {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"};
  const endpoint_vine_flower_2l_97 = makeAttachmentEndpoint(attachment_vine_flower_2l_97);
  const node_vine_flower_2l_97 = new THREE.Group();
  node_vine_flower_2l_97.name = "VineFlower2__pivot";
  node_vine_flower_2l_97.scale.set(1, 1, 1);
  if (endpoint_vine_flower_2l_97) {
    node_vine_flower_2l_97.position.copy(endpoint_vine_flower_2l_97.start);
    node_vine_flower_2l_97.rotation.set(0.0, 1.0472, 0.0);
  } else {
    node_vine_flower_2l_97.position.set(0.3, 0.2, 0.0);
    node_vine_flower_2l_97.rotation.set(0.0, 1.0472, 0.0);
  }
  node_vine_flower_2l_97.userData.sculptComponent = {"id": "vine-flower-2l", "name": "VineFlower2", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "transform": {"position": [0.3, 0.2, 0], "rotation": [0.0, 1.0472, 0.0], "scale": [0.8, 0.8, 0.8]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_2l_97.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_flower_2l_97);
  nodes["vine-flower-2l"] = node_vine_flower_2l_97;
  const mesh_vine_flower_2l_97Geometry = endpoint_vine_flower_2l_97
    ? new THREE.CylinderGeometry(endpoint_vine_flower_2l_97.endRadius, endpoint_vine_flower_2l_97.baseRadius, endpoint_vine_flower_2l_97.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_flower_2l_97) {
    mesh_vine_flower_2l_97Geometry.scale(0.8, 0.8, 0.8);
  }
  const mesh_vine_flower_2l_97 = new THREE.Mesh(
    mesh_vine_flower_2l_97Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_2l_97.name = "VineFlower2";
  if (endpoint_vine_flower_2l_97) {
    mesh_vine_flower_2l_97.position.copy(endpoint_vine_flower_2l_97.midpoint);
    mesh_vine_flower_2l_97.quaternion.copy(endpoint_vine_flower_2l_97.quaternion);
  }
  mesh_vine_flower_2l_97.castShadow = options.castShadow ?? true;
  mesh_vine_flower_2l_97.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_2l_97.visible = false; // 容器节点不渲染
  mesh_vine_flower_2l_97.userData.sculptComponent = {"id": "vine-flower-2l", "name": "VineFlower2", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "transform": {"position": [0.3, 0.2, 0], "rotation": [0.0, 1.0472, 0.0], "scale": [0.8, 0.8, 0.8]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 160, 96, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_2l_97.add(mesh_vine_flower_2l_97);
  meshes["vine-flower-2l"] = mesh_vine_flower_2l_97;
  colliders["vine-flower-2l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-flower-2"] ??= [];
  destructionGroups["vine-flower-2"].push(node_vine_flower_2l_97);

  const attachment_vine_flower_3l_98 = {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"};
  const endpoint_vine_flower_3l_98 = makeAttachmentEndpoint(attachment_vine_flower_3l_98);
  const node_vine_flower_3l_98 = new THREE.Group();
  node_vine_flower_3l_98.name = "VineFlower3__pivot";
  node_vine_flower_3l_98.scale.set(1, 1, 1);
  if (endpoint_vine_flower_3l_98) {
    node_vine_flower_3l_98.position.copy(endpoint_vine_flower_3l_98.start);
    node_vine_flower_3l_98.rotation.set(0.0, 2.0944, 0.0);
  } else {
    node_vine_flower_3l_98.position.set(-0.15, 0.3, 0.0);
    node_vine_flower_3l_98.rotation.set(0.0, 2.0944, 0.0);
  }
  node_vine_flower_3l_98.userData.sculptComponent = {"id": "vine-flower-3l", "name": "VineFlower3", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "transform": {"position": [-0.15, 0.3, 0], "rotation": [0.0, 2.0944, 0.0], "scale": [0.9, 0.9, 0.9]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_3l_98.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_flower_3l_98);
  nodes["vine-flower-3l"] = node_vine_flower_3l_98;
  const mesh_vine_flower_3l_98Geometry = endpoint_vine_flower_3l_98
    ? new THREE.CylinderGeometry(endpoint_vine_flower_3l_98.endRadius, endpoint_vine_flower_3l_98.baseRadius, endpoint_vine_flower_3l_98.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_flower_3l_98) {
    mesh_vine_flower_3l_98Geometry.scale(0.9, 0.9, 0.9);
  }
  const mesh_vine_flower_3l_98 = new THREE.Mesh(
    mesh_vine_flower_3l_98Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_3l_98.name = "VineFlower3";
  if (endpoint_vine_flower_3l_98) {
    mesh_vine_flower_3l_98.position.copy(endpoint_vine_flower_3l_98.midpoint);
    mesh_vine_flower_3l_98.quaternion.copy(endpoint_vine_flower_3l_98.quaternion);
  }
  mesh_vine_flower_3l_98.castShadow = options.castShadow ?? true;
  mesh_vine_flower_3l_98.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_3l_98.visible = false; // 容器节点不渲染
  mesh_vine_flower_3l_98.userData.sculptComponent = {"id": "vine-flower-3l", "name": "VineFlower3", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "transform": {"position": [-0.15, 0.3, 0], "rotation": [0.0, 2.0944, 0.0], "scale": [0.9, 0.9, 0.9]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 112, 192, 1.0)", "secondaryAlbedo": "rgba(232, 200, 64, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_3l_98.add(mesh_vine_flower_3l_98);
  meshes["vine-flower-3l"] = mesh_vine_flower_3l_98;
  colliders["vine-flower-3l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-flower-3"] ??= [];
  destructionGroups["vine-flower-3"].push(node_vine_flower_3l_98);

  const attachment_vine_flower_4l_99 = {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"};
  const endpoint_vine_flower_4l_99 = makeAttachmentEndpoint(attachment_vine_flower_4l_99);
  const node_vine_flower_4l_99 = new THREE.Group();
  node_vine_flower_4l_99.name = "VineFlower4__pivot";
  node_vine_flower_4l_99.scale.set(1, 1, 1);
  if (endpoint_vine_flower_4l_99) {
    node_vine_flower_4l_99.position.copy(endpoint_vine_flower_4l_99.start);
    node_vine_flower_4l_99.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_vine_flower_4l_99.position.set(0.05, 0.1, 0.0);
    node_vine_flower_4l_99.rotation.set(0.0, 3.14159, 0.0);
  }
  node_vine_flower_4l_99.userData.sculptComponent = {"id": "vine-flower-4l", "name": "VineFlower4", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "transform": {"position": [0.05, 0.1, 0], "rotation": [0.0, 3.14159, 0.0], "scale": [0.7, 0.7, 0.7]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(232, 138, 170, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_4l_99.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_flower_4l_99);
  nodes["vine-flower-4l"] = node_vine_flower_4l_99;
  const mesh_vine_flower_4l_99Geometry = endpoint_vine_flower_4l_99
    ? new THREE.CylinderGeometry(endpoint_vine_flower_4l_99.endRadius, endpoint_vine_flower_4l_99.baseRadius, endpoint_vine_flower_4l_99.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_vine_flower_4l_99) {
    mesh_vine_flower_4l_99Geometry.scale(0.7, 0.7, 0.7);
  }
  const mesh_vine_flower_4l_99 = new THREE.Mesh(
    mesh_vine_flower_4l_99Geometry,
    materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_flower_4l_99.name = "VineFlower4";
  if (endpoint_vine_flower_4l_99) {
    mesh_vine_flower_4l_99.position.copy(endpoint_vine_flower_4l_99.midpoint);
    mesh_vine_flower_4l_99.quaternion.copy(endpoint_vine_flower_4l_99.quaternion);
  }
  mesh_vine_flower_4l_99.castShadow = options.castShadow ?? true;
  mesh_vine_flower_4l_99.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_flower_4l_99.visible = false; // 容器节点不渲染
  mesh_vine_flower_4l_99.userData.sculptComponent = {"id": "vine-flower-4l", "name": "VineFlower4", "level": "meso", "role": "flower", "importance": 0.7, "confidence": 0.88, "primitive": "cylinder", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "attached", "embedDepth": 0.005, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "transform": {"position": [0.05, 0.1, 0], "rotation": [0.0, 3.14159, 0.0], "scale": [0.7, 0.7, 0.7]}, "material": null, "evidenceRefs": ["full-object"], "children": ["petal-1", "petal-2", "petal-3", "petal-4", "petal-5", "flower-center"], "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-flower-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "topologyClass": "assembled-solid", "topologyRationale": "Solid cylinder geometry for VineFlower4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 208, 96, 1.0)", "secondaryAlbedo": "rgba(232, 138, 170, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}};
  node_vine_flower_4l_99.add(mesh_vine_flower_4l_99);
  meshes["vine-flower-4l"] = mesh_vine_flower_4l_99;
  colliders["vine-flower-4l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-flower-4"] ??= [];
  destructionGroups["vine-flower-4"].push(node_vine_flower_4l_99);

  const endpoint_vine_leaf_1l_100 = makeAttachmentEndpoint(null);
  const node_vine_leaf_1l_100 = new THREE.Group();
  node_vine_leaf_1l_100.name = "VineLeaf1__pivot";
  node_vine_leaf_1l_100.scale.set(1, 1, 1);
  if (endpoint_vine_leaf_1l_100) {
    node_vine_leaf_1l_100.position.copy(endpoint_vine_leaf_1l_100.start);
    node_vine_leaf_1l_100.rotation.set(0.0, 0.0, 0.5236);
  } else {
    node_vine_leaf_1l_100.position.set(0.08, 0.15, 0.0);
    node_vine_leaf_1l_100.rotation.set(0.0, 0.0, 0.5236);
  }
  node_vine_leaf_1l_100.userData.sculptComponent = {"id": "vine-leaf-1l", "name": "VineLeaf1", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.105, "height": 0.063, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0.08, 0.15, 0], "rotation": [0.0, 0.0, 0.5236], "scale": [0.105, 0.063, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_1l_100.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_leaf_1l_100);
  nodes["vine-leaf-1l"] = node_vine_leaf_1l_100;
  const mesh_vine_leaf_1l_100Geometry = endpoint_vine_leaf_1l_100
    ? new THREE.CylinderGeometry(endpoint_vine_leaf_1l_100.endRadius, endpoint_vine_leaf_1l_100.baseRadius, endpoint_vine_leaf_1l_100.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_leaf_1l_100) {
    mesh_vine_leaf_1l_100Geometry.scale(0.105, 0.063, 0.01);
  }
  const mesh_vine_leaf_1l_100 = new THREE.Mesh(
    mesh_vine_leaf_1l_100Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_leaf_1l_100.name = "VineLeaf1";
  if (endpoint_vine_leaf_1l_100) {
    mesh_vine_leaf_1l_100.position.copy(endpoint_vine_leaf_1l_100.midpoint);
    mesh_vine_leaf_1l_100.quaternion.copy(endpoint_vine_leaf_1l_100.quaternion);
  }
  mesh_vine_leaf_1l_100.castShadow = options.castShadow ?? true;
  mesh_vine_leaf_1l_100.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_leaf_1l_100.userData.sculptComponent = {"id": "vine-leaf-1l", "name": "VineLeaf1", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.105, "height": 0.063, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0.08, 0.15, 0], "rotation": [0.0, 0.0, 0.5236], "scale": [0.105, 0.063, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf1", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_1l_100.add(mesh_vine_leaf_1l_100);
  meshes["vine-leaf-1l"] = mesh_vine_leaf_1l_100;
  colliders["vine-leaf-1l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-leaf-1"] ??= [];
  destructionGroups["vine-leaf-1"].push(node_vine_leaf_1l_100);

  const endpoint_vine_leaf_2l_101 = makeAttachmentEndpoint(null);
  const node_vine_leaf_2l_101 = new THREE.Group();
  node_vine_leaf_2l_101.name = "VineLeaf2__pivot";
  node_vine_leaf_2l_101.scale.set(1, 1, 1);
  if (endpoint_vine_leaf_2l_101) {
    node_vine_leaf_2l_101.position.copy(endpoint_vine_leaf_2l_101.start);
    node_vine_leaf_2l_101.rotation.set(0.0, 0.0, -0.34907);
  } else {
    node_vine_leaf_2l_101.position.set(0.22, 0.05, 0.0);
    node_vine_leaf_2l_101.rotation.set(0.0, 0.0, -0.34907);
  }
  node_vine_leaf_2l_101.userData.sculptComponent = {"id": "vine-leaf-2l", "name": "VineLeaf2", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.084, "height": 0.0525, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0.22, 0.05, 0], "rotation": [0.0, 0.0, -0.34907], "scale": [0.084, 0.0525, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_2l_101.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_leaf_2l_101);
  nodes["vine-leaf-2l"] = node_vine_leaf_2l_101;
  const mesh_vine_leaf_2l_101Geometry = endpoint_vine_leaf_2l_101
    ? new THREE.CylinderGeometry(endpoint_vine_leaf_2l_101.endRadius, endpoint_vine_leaf_2l_101.baseRadius, endpoint_vine_leaf_2l_101.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_leaf_2l_101) {
    mesh_vine_leaf_2l_101Geometry.scale(0.084, 0.0525, 0.01);
  }
  const mesh_vine_leaf_2l_101 = new THREE.Mesh(
    mesh_vine_leaf_2l_101Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_leaf_2l_101.name = "VineLeaf2";
  if (endpoint_vine_leaf_2l_101) {
    mesh_vine_leaf_2l_101.position.copy(endpoint_vine_leaf_2l_101.midpoint);
    mesh_vine_leaf_2l_101.quaternion.copy(endpoint_vine_leaf_2l_101.quaternion);
  }
  mesh_vine_leaf_2l_101.castShadow = options.castShadow ?? true;
  mesh_vine_leaf_2l_101.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_leaf_2l_101.userData.sculptComponent = {"id": "vine-leaf-2l", "name": "VineLeaf2", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.084, "height": 0.0525, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0.22, 0.05, 0], "rotation": [0.0, 0.0, -0.34907], "scale": [0.084, 0.0525, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf2", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_2l_101.add(mesh_vine_leaf_2l_101);
  meshes["vine-leaf-2l"] = mesh_vine_leaf_2l_101;
  colliders["vine-leaf-2l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-leaf-2"] ??= [];
  destructionGroups["vine-leaf-2"].push(node_vine_leaf_2l_101);

  const endpoint_vine_leaf_3l_102 = makeAttachmentEndpoint(null);
  const node_vine_leaf_3l_102 = new THREE.Group();
  node_vine_leaf_3l_102.name = "VineLeaf3__pivot";
  node_vine_leaf_3l_102.scale.set(1, 1, 1);
  if (endpoint_vine_leaf_3l_102) {
    node_vine_leaf_3l_102.position.copy(endpoint_vine_leaf_3l_102.start);
    node_vine_leaf_3l_102.rotation.set(0.0, 0.0, 0.2618);
  } else {
    node_vine_leaf_3l_102.position.set(-0.25, 0.08, 0.0);
    node_vine_leaf_3l_102.rotation.set(0.0, 0.0, 0.2618);
  }
  node_vine_leaf_3l_102.userData.sculptComponent = {"id": "vine-leaf-3l", "name": "VineLeaf3", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.0945, "height": 0.0588, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.25, 0.08, 0], "rotation": [0.0, 0.0, 0.2618], "scale": [0.0945, 0.0588, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_3l_102.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vine-system-left"] ?? root).add(node_vine_leaf_3l_102);
  nodes["vine-leaf-3l"] = node_vine_leaf_3l_102;
  const mesh_vine_leaf_3l_102Geometry = endpoint_vine_leaf_3l_102
    ? new THREE.CylinderGeometry(endpoint_vine_leaf_3l_102.endRadius, endpoint_vine_leaf_3l_102.baseRadius, endpoint_vine_leaf_3l_102.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_vine_leaf_3l_102) {
    mesh_vine_leaf_3l_102Geometry.scale(0.0945, 0.0588, 0.01);
  }
  const mesh_vine_leaf_3l_102 = new THREE.Mesh(
    mesh_vine_leaf_3l_102Geometry,
    materialMap["vine-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vine_leaf_3l_102.name = "VineLeaf3";
  if (endpoint_vine_leaf_3l_102) {
    mesh_vine_leaf_3l_102.position.copy(endpoint_vine_leaf_3l_102.midpoint);
    mesh_vine_leaf_3l_102.quaternion.copy(endpoint_vine_leaf_3l_102.quaternion);
  }
  mesh_vine_leaf_3l_102.castShadow = options.castShadow ?? true;
  mesh_vine_leaf_3l_102.receiveShadow = options.receiveShadow ?? true;
  mesh_vine_leaf_3l_102.userData.sculptComponent = {"id": "vine-leaf-3l", "name": "VineLeaf3", "level": "micro", "role": "leaf", "importance": 0.45, "confidence": 0.82, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vine-system-left", "attachment": {"parentSocket": "vine-right-socket", "contactType": "surface", "embedDepth": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "parentId": "vine-system-left"}, "dimensions": {"width": 0.0945, "height": 0.0588, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.25, 0.08, 0], "rotation": [0.0, 0.0, 0.2618], "scale": [0.0945, 0.0588, 0.01]}, "material": "vine-green", "evidenceRefs": ["full-object"], "topologyRationale": "Solid geometry for VineLeaf3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 138, 58, 1.0)", "secondaryAlbedo": "rgba(90, 154, 74, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vine-leaf-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vine_leaf_3l_102.add(mesh_vine_leaf_3l_102);
  meshes["vine-leaf-3l"] = mesh_vine_leaf_3l_102;
  colliders["vine-leaf-3l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vine-leaf-3"] ??= [];
  destructionGroups["vine-leaf-3"].push(node_vine_leaf_3l_102);

  // repetition system: window-array (InstancedMesh, radial, count=3, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["body-gradient"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 3);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 3; i++) {
      const ang = ((0.0) + (i * 360) / 3) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "window-array";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "minimumTextureResolution": 1024, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7}}};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createSummerCaravanLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Summer Caravan look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"type": "key", "direction": "front-left", "color": "#FFFFFF", "intensity": 1.0}, {"type": "fill", "direction": "right", "color": "#E8E0D0", "intensity": 0.4}, {"type": "rim", "direction": "back", "color": "#FFE8C0", "intensity": 0.3}, {"type": "tone-mapping", "note": "ACES filmic tone mapping, exposure 1.0, soft highlight rolloff for watercolor look"}, {"type": "shadow", "note": "contact shadow under chassis via ground-plane ambient occlusion"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "minimumTextureResolution": 1024, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7}}};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createSummerCaravanEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameSummerCaravanCamera(
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
export function createSummerCaravanPresentationComposer(
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

export function configureSummerCaravanRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createSummerCaravanInspectControls(
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
