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

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
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

// Generated from ObjectSculptSpec target: Island Shape 2
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createIslandShape2Model(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Island Shape 2";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["island-clay"] = createSculptMaterial(
    "island-clay",
    {"id": "island-clay", "name": "Island Clay", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#D3B06E", "color": "#D3B06E", "albedo": {"dominant": "#D3B06E", "secondary": ["#DCC38C"], "samplingNotes": "reference crop palette"}, "colorVariation": {"palette": ["#D3B06E", "#DCC38C", "#8EB168", "#A88958", "#69573A"], "pattern": "mottled", "amplitude": 0.2, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensity": "uniform world-space, 1024px per 2.0 world units"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "pattern": "broad color zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.24, "pattern": "grass clumps / clay blotches", "role": "surface relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "roughness": {"base": 0.88, "variation": 0.15, "map": "island-clay-roughness", "localResponse": "rougher in crevices, softer on the turf top"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.26, "scale": 22.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "response": "cavity darkening under the grass lip and between stones"}, "wear": {"edgeWear": 0.18, "scratches": ["clay erosion striations"], "chips": []}, "dirt": {"amount": 0.22, "cavityBias": 0.5, "color": "#5A4A32"}, "localOverrides": [{"id": "clay-vertical-streak", "zone": "clay wall", "albedo": "#8B6B45", "roughness": 0.92, "description": "vertical erosion streaks down the ochre wall"}, {"id": "clay-color-blotch", "zone": "clay wall", "albedo": "#C6A879", "description": "lighter and darker clay blotches from water staining"}], "qualityTier": "utility"},
    options
  );
  materialMap["island-grass"] = createSculptMaterial(
    "island-grass",
    {"id": "island-grass", "name": "Island Turf", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#9CBC77", "color": "#9CBC77", "albedo": {"dominant": "#9CBC77", "secondary": ["#AAC687"], "samplingNotes": "reference crop palette"}, "colorVariation": {"palette": ["#9CBC77", "#AAC687", "#BCCE98", "#85A65D", "#495D39"], "pattern": "mottled", "amplitude": 0.2, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensity": "uniform world-space, 1024px per 2.0 world units"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "pattern": "broad color zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.24, "pattern": "grass clumps / clay blotches", "role": "surface relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "roughness": {"base": 0.8, "variation": 0.15, "map": "island-grass-roughness", "localResponse": "rougher in crevices, softer on the turf top"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.28, "scale": 22.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "response": "cavity darkening under the grass lip and between stones"}, "wear": {"edgeWear": 0.18, "scratches": ["clay erosion striations"], "chips": []}, "dirt": {"amount": 0.22, "cavityBias": 0.5, "color": "#5A4A32"}, "localOverrides": [{"id": "grass-tone-bands", "zone": "turf top", "albedo": "#7FA85A", "description": "lighter and darker green wash bands across the turf"}, {"id": "grass-edge-tuft-line", "zone": "turf rim", "albedo": "#9CC46A", "description": "bright fringe of short blades along the overhanging lip"}, {"id": "grass-blade-linework", "zone": "tuft", "albedo": "#C9B26A", "description": "dark ink blade strokes of the toon grass tufts"}], "qualityTier": "utility"},
    options
  );
  materialMap["island-bush"] = createSculptMaterial(
    "island-bush",
    {"id": "island-bush", "name": "Island Bush", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#8DB368", "color": "#8DB368", "albedo": {"dominant": "#8DB368", "secondary": ["#A8C08E"], "samplingNotes": "reference crop palette"}, "colorVariation": {"palette": ["#8DB368", "#A8C08E", "#5B8654", "#779468", "#3A4A2E"], "pattern": "mottled", "amplitude": 0.2, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensity": "uniform world-space, 1024px per 2.0 world units"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "pattern": "broad color zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.24, "pattern": "grass clumps / clay blotches", "role": "surface relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "roughness": {"base": 0.78, "variation": 0.15, "map": "island-bush-roughness", "localResponse": "rougher in crevices, softer on the turf top"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.32, "scale": 22.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "response": "cavity darkening under the grass lip and between stones"}, "wear": {"edgeWear": 0.18, "scratches": ["clay erosion striations"], "chips": []}, "dirt": {"amount": 0.22, "cavityBias": 0.5, "color": "#5A4A32"}, "localOverrides": [{"id": "bush-lobe-clusters", "zone": "bush", "albedo": "#4E7A3A", "description": "clustered lobes with darker green shadow pockets"}], "qualityTier": "utility"},
    options
  );
  materialMap["island-rock"] = createSculptMaterial(
    "island-rock",
    {"id": "island-rock", "name": "Island Rock", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#9BBC7B", "color": "#9BBC7B", "albedo": {"dominant": "#9BBC7B", "secondary": ["#BCCC95"], "samplingNotes": "reference crop palette"}, "colorVariation": {"palette": ["#9BBC7B", "#BCCC95", "#ACC683", "#8B9B67", "#484E31"], "pattern": "mottled", "amplitude": 0.2, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensity": "uniform world-space, 1024px per 2.0 world units"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "pattern": "broad color zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.24, "pattern": "grass clumps / clay blotches", "role": "surface relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "pattern": "paper grain", "role": "fine grain"}], "roughness": {"base": 0.82, "variation": 0.15, "map": "island-rock-roughness", "localResponse": "rougher in crevices, softer on the turf top"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.22, "scale": 22.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "response": "cavity darkening under the grass lip and between stones"}, "wear": {"edgeWear": 0.18, "scratches": ["clay erosion striations"], "chips": []}, "dirt": {"amount": 0.22, "cavityBias": 0.5, "color": "#5A4A32"}, "localOverrides": [{"id": "rock-grey-mottle", "zone": "rock", "albedo": "#9A938A", "description": "grey stone with cool shadow mottling"}], "qualityTier": "utility"},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_island_root_0 = makeAttachmentEndpoint(null);
  const node_island_root_0 = new THREE.Group();
  node_island_root_0.name = "Island Elongated__pivot";
  node_island_root_0.scale.set(1, 1, 1);
  if (endpoint_island_root_0) {
    node_island_root_0.position.copy(endpoint_island_root_0.start);
    node_island_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_island_root_0.position.set(0.0, 0.0, 0.0);
    node_island_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_island_root_0.userData.sculptComponent = {"id": "island-root", "name": "Island Elongated", "level": "macro", "role": "static", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Invisible root pivot.", "parent": null, "attachment": null, "dimensions": {"width": 0.001, "height": 0.001, "depth": 0.001, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.001, 0.001, 0.001]}, "material": "island-clay", "materialLayers": ["island-clay"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 176, 110, 1.0)", "secondaryAlbedo": "rgba(220, 195, 140, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "island-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_island_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "island-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_island_root_0);
  nodes["island-root"] = node_island_root_0;
  const mesh_island_root_0Geometry = endpoint_island_root_0
    ? new THREE.CylinderGeometry(endpoint_island_root_0.endRadius, endpoint_island_root_0.baseRadius, endpoint_island_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_island_root_0) {
    mesh_island_root_0Geometry.scale(0.001, 0.001, 0.001);
  }
  const mesh_island_root_0 = new THREE.Mesh(
    mesh_island_root_0Geometry,
    materialMap["island-clay"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_island_root_0.name = "Island Elongated";
  if (endpoint_island_root_0) {
    mesh_island_root_0.position.copy(endpoint_island_root_0.midpoint);
    mesh_island_root_0.quaternion.copy(endpoint_island_root_0.quaternion);
  }
  mesh_island_root_0.castShadow = options.castShadow ?? true;
  mesh_island_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_island_root_0.userData.sculptComponent = {"id": "island-root", "name": "Island Elongated", "level": "macro", "role": "static", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Invisible root pivot.", "parent": null, "attachment": null, "dimensions": {"width": 0.001, "height": 0.001, "depth": 0.001, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.001, 0.001, 0.001]}, "material": "island-clay", "materialLayers": ["island-clay"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 176, 110, 1.0)", "secondaryAlbedo": "rgba(220, 195, 140, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "island-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_island_root_0.add(mesh_island_root_0);
  meshes["island-root"] = mesh_island_root_0;
  colliders["island-root"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["island-root"] ??= [];
  destructionGroups["island-root"].push(node_island_root_0);

  const endpoint_island_body_1 = makeAttachmentEndpoint(null);
  const node_island_body_1 = new THREE.Group();
  node_island_body_1.name = "IslandBody__pivot";
  node_island_body_1.scale.set(1, 1, 1);
  if (endpoint_island_body_1) {
    node_island_body_1.position.copy(endpoint_island_body_1.start);
    node_island_body_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_island_body_1.position.set(0.0, 0.0, 0.0);
    node_island_body_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_island_body_1.userData.sculptComponent = {"id": "island-body", "name": "IslandBody", "level": "macro", "role": "main-volume", "importance": 1.0, "confidence": 0.88, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "Lathe of a flat-top / sloped-side profile: grass lip overhangs the ochre clay wall.", "parent": "island-root", "attachment": {"parentId": "island-root", "parentSocket": "island-root-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.44, "height": 1.0, "depth": 0.92, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1.44, 1.0, 0.92]}, "material": "island-clay", "materialLayers": ["island-clay"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 176, 110, 1.0)", "secondaryAlbedo": "rgba(220, 195, 140, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "main-volume", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "island-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["clay-vertical-streak", "clay-color-blotch"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"latheProfile": {"points": [[0.0, 0.3], [0.6, 0.3], [0.88, 0.24], [1.02, 0.12], [0.96, -0.04], [0.78, -0.2], [0.5, -0.28], [0.0, -0.3]], "segments": 30}, "topologyIntent": "revolved island disc", "normalStrategy": "smooth revolve normals + procedural relief"}};
  node_island_body_1.userData.actionProfile = {"animationRole": "main-volume", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "island-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["island-root"] ?? root).add(node_island_body_1);
  nodes["island-body"] = node_island_body_1;
  const mesh_island_body_1Geometry = endpoint_island_body_1
    ? new THREE.CylinderGeometry(endpoint_island_body_1.endRadius, endpoint_island_body_1.baseRadius, endpoint_island_body_1.length, 32, 12)
    : buildLatheGeometry({"points": [[0.0, 0.3], [0.6, 0.3], [0.88, 0.24], [1.02, 0.12], [0.96, -0.04], [0.78, -0.2], [0.5, -0.28], [0.0, -0.3]], "segments": 30});
  if (!endpoint_island_body_1) {
    mesh_island_body_1Geometry.scale(1.44, 1.0, 0.92);
  }
  const mesh_island_body_1 = new THREE.Mesh(
    mesh_island_body_1Geometry,
    materialMap["island-clay"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_island_body_1.name = "IslandBody";
  if (endpoint_island_body_1) {
    mesh_island_body_1.position.copy(endpoint_island_body_1.midpoint);
    mesh_island_body_1.quaternion.copy(endpoint_island_body_1.quaternion);
  }
  mesh_island_body_1.castShadow = options.castShadow ?? true;
  mesh_island_body_1.receiveShadow = options.receiveShadow ?? true;
  mesh_island_body_1.userData.sculptComponent = {"id": "island-body", "name": "IslandBody", "level": "macro", "role": "main-volume", "importance": 1.0, "confidence": 0.88, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "Lathe of a flat-top / sloped-side profile: grass lip overhangs the ochre clay wall.", "parent": "island-root", "attachment": {"parentId": "island-root", "parentSocket": "island-root-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.44, "height": 1.0, "depth": 0.92, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1.44, 1.0, 0.92]}, "material": "island-clay", "materialLayers": ["island-clay"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(211, 176, 110, 1.0)", "secondaryAlbedo": "rgba(220, 195, 140, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "main-volume", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "island-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["clay-vertical-streak", "clay-color-blotch"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"latheProfile": {"points": [[0.0, 0.3], [0.6, 0.3], [0.88, 0.24], [1.02, 0.12], [0.96, -0.04], [0.78, -0.2], [0.5, -0.28], [0.0, -0.3]], "segments": 30}, "topologyIntent": "revolved island disc", "normalStrategy": "smooth revolve normals + procedural relief"}};
  node_island_body_1.add(mesh_island_body_1);
  meshes["island-body"] = mesh_island_body_1;
  colliders["island-body"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["island-body"] ??= [];
  destructionGroups["island-body"].push(node_island_body_1);

  const endpoint_grass_cap_2 = makeAttachmentEndpoint(null);
  const node_grass_cap_2 = new THREE.Group();
  node_grass_cap_2.name = "GrassCap__pivot";
  node_grass_cap_2.scale.set(1, 1, 1);
  if (endpoint_grass_cap_2) {
    node_grass_cap_2.position.copy(endpoint_grass_cap_2.start);
    node_grass_cap_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_grass_cap_2.position.set(0.0, 0.0, 0.0);
    node_grass_cap_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_grass_cap_2.userData.sculptComponent = {"id": "grass-cap", "name": "GrassCap", "level": "macro", "role": "cap", "importance": 1.0, "confidence": 0.86, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "Green turf shell with an overhanging lip that reads as the grass edge.", "parent": "island-root", "attachment": {"parentId": "island-root", "parentSocket": "island-root-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.44, "height": 1.0, "depth": 0.92, "units": "world", "confidence": 0.86}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1.44, 1.0, 0.92]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.86, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "cap", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["grass-tone-bands", "grass-edge-tuft-line"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"latheProfile": {"points": [[0.0, 0.345], [0.6, 0.345], [0.9, 0.285], [1.045, 0.135], [0.98, 0.075], [0.0, 0.11]], "segments": 30}, "topologyIntent": "grass cap shell"}};
  node_grass_cap_2.userData.actionProfile = {"animationRole": "cap", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["island-root"] ?? root).add(node_grass_cap_2);
  nodes["grass-cap"] = node_grass_cap_2;
  const mesh_grass_cap_2Geometry = endpoint_grass_cap_2
    ? new THREE.CylinderGeometry(endpoint_grass_cap_2.endRadius, endpoint_grass_cap_2.baseRadius, endpoint_grass_cap_2.length, 32, 12)
    : buildLatheGeometry({"points": [[0.0, 0.345], [0.6, 0.345], [0.9, 0.285], [1.045, 0.135], [0.98, 0.075], [0.0, 0.11]], "segments": 30});
  if (!endpoint_grass_cap_2) {
    mesh_grass_cap_2Geometry.scale(1.44, 1.0, 0.92);
  }
  const mesh_grass_cap_2 = new THREE.Mesh(
    mesh_grass_cap_2Geometry,
    materialMap["island-grass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grass_cap_2.name = "GrassCap";
  if (endpoint_grass_cap_2) {
    mesh_grass_cap_2.position.copy(endpoint_grass_cap_2.midpoint);
    mesh_grass_cap_2.quaternion.copy(endpoint_grass_cap_2.quaternion);
  }
  mesh_grass_cap_2.castShadow = options.castShadow ?? true;
  mesh_grass_cap_2.receiveShadow = options.receiveShadow ?? true;
  mesh_grass_cap_2.userData.sculptComponent = {"id": "grass-cap", "name": "GrassCap", "level": "macro", "role": "cap", "importance": 1.0, "confidence": 0.86, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "Green turf shell with an overhanging lip that reads as the grass edge.", "parent": "island-root", "attachment": {"parentId": "island-root", "parentSocket": "island-root-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1.44, "height": 1.0, "depth": 0.92, "units": "world", "confidence": 0.86}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1.44, 1.0, 0.92]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.86, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "cap", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "grass-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["grass-tone-bands", "grass-edge-tuft-line"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement", "geometryDescriptor": {"latheProfile": {"points": [[0.0, 0.345], [0.6, 0.345], [0.9, 0.285], [1.045, 0.135], [0.98, 0.075], [0.0, 0.11]], "segments": 30}, "topologyIntent": "grass cap shell"}};
  node_grass_cap_2.add(mesh_grass_cap_2);
  meshes["grass-cap"] = mesh_grass_cap_2;
  colliders["grass-cap"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["grass-cap"] ??= [];
  destructionGroups["grass-cap"].push(node_grass_cap_2);

  const endpoint_bush_01_3 = makeAttachmentEndpoint(null);
  const node_bush_01_3 = new THREE.Group();
  node_bush_01_3.name = "Bush01__pivot";
  node_bush_01_3.scale.set(1, 1, 1);
  if (endpoint_bush_01_3) {
    node_bush_01_3.position.copy(endpoint_bush_01_3.start);
    node_bush_01_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_bush_01_3.position.set(0.3, 0.39899999999999997, 0.16);
    node_bush_01_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_bush_01_3.userData.sculptComponent = {"id": "bush-01", "name": "Bush01", "level": "meso", "role": "vegetation", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Bush clump seated on the turf surface.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.24, "depth": 0.3, "units": "world", "confidence": 0.8}, "transform": {"position": [0.3, 0.39899999999999997, 0.16], "rotation": [0, 0, 0], "scale": [0.3, 0.24, 0.3]}, "material": "island-bush", "materialLayers": ["island-bush"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 179, 104, 1.0)", "secondaryAlbedo": "rgba(168, 192, 142, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "vegetation", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "bush-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["bush-lobe-clusters"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_bush_01_3.userData.actionProfile = {"animationRole": "vegetation", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "bush-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_bush_01_3);
  nodes["bush-01"] = node_bush_01_3;
  const mesh_bush_01_3Geometry = endpoint_bush_01_3
    ? new THREE.CylinderGeometry(endpoint_bush_01_3.endRadius, endpoint_bush_01_3.baseRadius, endpoint_bush_01_3.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_bush_01_3) {
    mesh_bush_01_3Geometry.scale(0.3, 0.24, 0.3);
  }
  const mesh_bush_01_3 = new THREE.Mesh(
    mesh_bush_01_3Geometry,
    materialMap["island-bush"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bush_01_3.name = "Bush01";
  if (endpoint_bush_01_3) {
    mesh_bush_01_3.position.copy(endpoint_bush_01_3.midpoint);
    mesh_bush_01_3.quaternion.copy(endpoint_bush_01_3.quaternion);
  }
  mesh_bush_01_3.castShadow = options.castShadow ?? true;
  mesh_bush_01_3.receiveShadow = options.receiveShadow ?? true;
  mesh_bush_01_3.userData.sculptComponent = {"id": "bush-01", "name": "Bush01", "level": "meso", "role": "vegetation", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Bush clump seated on the turf surface.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.24, "depth": 0.3, "units": "world", "confidence": 0.8}, "transform": {"position": [0.3, 0.39899999999999997, 0.16], "rotation": [0, 0, 0], "scale": [0.3, 0.24, 0.3]}, "material": "island-bush", "materialLayers": ["island-bush"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 179, 104, 1.0)", "secondaryAlbedo": "rgba(168, 192, 142, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "vegetation", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "bush-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["bush-lobe-clusters"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_bush_01_3.add(mesh_bush_01_3);
  meshes["bush-01"] = mesh_bush_01_3;
  colliders["bush-01"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["bush-01"] ??= [];
  destructionGroups["bush-01"].push(node_bush_01_3);

  const endpoint_bush_02_4 = makeAttachmentEndpoint(null);
  const node_bush_02_4 = new THREE.Group();
  node_bush_02_4.name = "Bush02__pivot";
  node_bush_02_4.scale.set(1, 1, 1);
  if (endpoint_bush_02_4) {
    node_bush_02_4.position.copy(endpoint_bush_02_4.start);
    node_bush_02_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_bush_02_4.position.set(-0.34, 0.39899999999999997, 0.26);
    node_bush_02_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_bush_02_4.userData.sculptComponent = {"id": "bush-02", "name": "Bush02", "level": "meso", "role": "vegetation", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Bush clump seated on the turf surface.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.24, "depth": 0.3, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.34, 0.39899999999999997, 0.26], "rotation": [0, 0, 0], "scale": [0.3, 0.24, 0.3]}, "material": "island-bush", "materialLayers": ["island-bush"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 179, 104, 1.0)", "secondaryAlbedo": "rgba(168, 192, 142, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "vegetation", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "bush-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_bush_02_4.userData.actionProfile = {"animationRole": "vegetation", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "bush-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_bush_02_4);
  nodes["bush-02"] = node_bush_02_4;
  const mesh_bush_02_4Geometry = endpoint_bush_02_4
    ? new THREE.CylinderGeometry(endpoint_bush_02_4.endRadius, endpoint_bush_02_4.baseRadius, endpoint_bush_02_4.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_bush_02_4) {
    mesh_bush_02_4Geometry.scale(0.3, 0.24, 0.3);
  }
  const mesh_bush_02_4 = new THREE.Mesh(
    mesh_bush_02_4Geometry,
    materialMap["island-bush"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bush_02_4.name = "Bush02";
  if (endpoint_bush_02_4) {
    mesh_bush_02_4.position.copy(endpoint_bush_02_4.midpoint);
    mesh_bush_02_4.quaternion.copy(endpoint_bush_02_4.quaternion);
  }
  mesh_bush_02_4.castShadow = options.castShadow ?? true;
  mesh_bush_02_4.receiveShadow = options.receiveShadow ?? true;
  mesh_bush_02_4.userData.sculptComponent = {"id": "bush-02", "name": "Bush02", "level": "meso", "role": "vegetation", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Bush clump seated on the turf surface.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.24, "depth": 0.3, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.34, 0.39899999999999997, 0.26], "rotation": [0, 0, 0], "scale": [0.3, 0.24, 0.3]}, "material": "island-bush", "materialLayers": ["island-bush"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 179, 104, 1.0)", "secondaryAlbedo": "rgba(168, 192, 142, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "vegetation", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "bush-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_bush_02_4.add(mesh_bush_02_4);
  meshes["bush-02"] = mesh_bush_02_4;
  colliders["bush-02"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["bush-02"] ??= [];
  destructionGroups["bush-02"].push(node_bush_02_4);

  const endpoint_bush_03_5 = makeAttachmentEndpoint(null);
  const node_bush_03_5 = new THREE.Group();
  node_bush_03_5.name = "Bush03__pivot";
  node_bush_03_5.scale.set(1, 1, 1);
  if (endpoint_bush_03_5) {
    node_bush_03_5.position.copy(endpoint_bush_03_5.start);
    node_bush_03_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_bush_03_5.position.set(0.12, 0.39899999999999997, -0.42);
    node_bush_03_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_bush_03_5.userData.sculptComponent = {"id": "bush-03", "name": "Bush03", "level": "meso", "role": "vegetation", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Bush clump seated on the turf surface.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.24, "depth": 0.3, "units": "world", "confidence": 0.8}, "transform": {"position": [0.12, 0.39899999999999997, -0.42], "rotation": [0, 0, 0], "scale": [0.3, 0.24, 0.3]}, "material": "island-bush", "materialLayers": ["island-bush"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 179, 104, 1.0)", "secondaryAlbedo": "rgba(168, 192, 142, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "vegetation", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "bush-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_bush_03_5.userData.actionProfile = {"animationRole": "vegetation", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "bush-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_bush_03_5);
  nodes["bush-03"] = node_bush_03_5;
  const mesh_bush_03_5Geometry = endpoint_bush_03_5
    ? new THREE.CylinderGeometry(endpoint_bush_03_5.endRadius, endpoint_bush_03_5.baseRadius, endpoint_bush_03_5.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_bush_03_5) {
    mesh_bush_03_5Geometry.scale(0.3, 0.24, 0.3);
  }
  const mesh_bush_03_5 = new THREE.Mesh(
    mesh_bush_03_5Geometry,
    materialMap["island-bush"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bush_03_5.name = "Bush03";
  if (endpoint_bush_03_5) {
    mesh_bush_03_5.position.copy(endpoint_bush_03_5.midpoint);
    mesh_bush_03_5.quaternion.copy(endpoint_bush_03_5.quaternion);
  }
  mesh_bush_03_5.castShadow = options.castShadow ?? true;
  mesh_bush_03_5.receiveShadow = options.receiveShadow ?? true;
  mesh_bush_03_5.userData.sculptComponent = {"id": "bush-03", "name": "Bush03", "level": "meso", "role": "vegetation", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Bush clump seated on the turf surface.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.24, "depth": 0.3, "units": "world", "confidence": 0.8}, "transform": {"position": [0.12, 0.39899999999999997, -0.42], "rotation": [0, 0, 0], "scale": [0.3, 0.24, 0.3]}, "material": "island-bush", "materialLayers": ["island-bush"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 179, 104, 1.0)", "secondaryAlbedo": "rgba(168, 192, 142, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "vegetation", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "bush-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_bush_03_5.add(mesh_bush_03_5);
  meshes["bush-03"] = mesh_bush_03_5;
  colliders["bush-03"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["bush-03"] ??= [];
  destructionGroups["bush-03"].push(node_bush_03_5);

  const endpoint_rock_01_6 = makeAttachmentEndpoint(null);
  const node_rock_01_6 = new THREE.Group();
  node_rock_01_6.name = "Rock01__pivot";
  node_rock_01_6.scale.set(1, 1, 1);
  if (endpoint_rock_01_6) {
    node_rock_01_6.position.copy(endpoint_rock_01_6.start);
    node_rock_01_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rock_01_6.position.set(0.45, 0.36669999999999997, 0.25);
    node_rock_01_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_rock_01_6.userData.sculptComponent = {"id": "rock-01", "name": "Rock01", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.78, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock half-buried in the turf.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.124, "depth": 0.18000000000000002, "units": "world", "confidence": 0.78}, "transform": {"position": [0.45, 0.36669999999999997, 0.25], "rotation": [0, 0, 0], "scale": [0.2, 0.124, 0.18000000000000002]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.78, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["rock-grey-mottle"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_01_6.userData.actionProfile = {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_rock_01_6);
  nodes["rock-01"] = node_rock_01_6;
  const mesh_rock_01_6Geometry = endpoint_rock_01_6
    ? new THREE.CylinderGeometry(endpoint_rock_01_6.endRadius, endpoint_rock_01_6.baseRadius, endpoint_rock_01_6.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_rock_01_6) {
    mesh_rock_01_6Geometry.scale(0.2, 0.124, 0.18000000000000002);
  }
  const mesh_rock_01_6 = new THREE.Mesh(
    mesh_rock_01_6Geometry,
    materialMap["island-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rock_01_6.name = "Rock01";
  if (endpoint_rock_01_6) {
    mesh_rock_01_6.position.copy(endpoint_rock_01_6.midpoint);
    mesh_rock_01_6.quaternion.copy(endpoint_rock_01_6.quaternion);
  }
  mesh_rock_01_6.castShadow = options.castShadow ?? true;
  mesh_rock_01_6.receiveShadow = options.receiveShadow ?? true;
  mesh_rock_01_6.userData.sculptComponent = {"id": "rock-01", "name": "Rock01", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.78, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock half-buried in the turf.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.124, "depth": 0.18000000000000002, "units": "world", "confidence": 0.78}, "transform": {"position": [0.45, 0.36669999999999997, 0.25], "rotation": [0, 0, 0], "scale": [0.2, 0.124, 0.18000000000000002]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.78, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["rock-grey-mottle"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_01_6.add(mesh_rock_01_6);
  meshes["rock-01"] = mesh_rock_01_6;
  colliders["rock-01"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rock-01"] ??= [];
  destructionGroups["rock-01"].push(node_rock_01_6);

  const endpoint_rock_02_7 = makeAttachmentEndpoint(null);
  const node_rock_02_7 = new THREE.Group();
  node_rock_02_7.name = "Rock02__pivot";
  node_rock_02_7.scale.set(1, 1, 1);
  if (endpoint_rock_02_7) {
    node_rock_02_7.position.copy(endpoint_rock_02_7.start);
    node_rock_02_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rock_02_7.position.set(-0.4, 0.36290249999999996, -0.25);
    node_rock_02_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_rock_02_7.userData.sculptComponent = {"id": "rock-02", "name": "Rock02", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.78, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock half-buried in the turf.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.165, "height": 0.1023, "depth": 0.14850000000000002, "units": "world", "confidence": 0.78}, "transform": {"position": [-0.4, 0.36290249999999996, -0.25], "rotation": [0, 0, 0], "scale": [0.165, 0.1023, 0.14850000000000002]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.78, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_02_7.userData.actionProfile = {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_rock_02_7);
  nodes["rock-02"] = node_rock_02_7;
  const mesh_rock_02_7Geometry = endpoint_rock_02_7
    ? new THREE.CylinderGeometry(endpoint_rock_02_7.endRadius, endpoint_rock_02_7.baseRadius, endpoint_rock_02_7.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_rock_02_7) {
    mesh_rock_02_7Geometry.scale(0.165, 0.1023, 0.14850000000000002);
  }
  const mesh_rock_02_7 = new THREE.Mesh(
    mesh_rock_02_7Geometry,
    materialMap["island-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rock_02_7.name = "Rock02";
  if (endpoint_rock_02_7) {
    mesh_rock_02_7.position.copy(endpoint_rock_02_7.midpoint);
    mesh_rock_02_7.quaternion.copy(endpoint_rock_02_7.quaternion);
  }
  mesh_rock_02_7.castShadow = options.castShadow ?? true;
  mesh_rock_02_7.receiveShadow = options.receiveShadow ?? true;
  mesh_rock_02_7.userData.sculptComponent = {"id": "rock-02", "name": "Rock02", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.78, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock half-buried in the turf.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.165, "height": 0.1023, "depth": 0.14850000000000002, "units": "world", "confidence": 0.78}, "transform": {"position": [-0.4, 0.36290249999999996, -0.25], "rotation": [0, 0, 0], "scale": [0.165, 0.1023, 0.14850000000000002]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.78, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_02_7.add(mesh_rock_02_7);
  meshes["rock-02"] = mesh_rock_02_7;
  colliders["rock-02"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rock-02"] ??= [];
  destructionGroups["rock-02"].push(node_rock_02_7);

  const endpoint_rock_03_8 = makeAttachmentEndpoint(null);
  const node_rock_03_8 = new THREE.Group();
  node_rock_03_8.name = "Rock03__pivot";
  node_rock_03_8.scale.set(1, 1, 1);
  if (endpoint_rock_03_8) {
    node_rock_03_8.position.copy(endpoint_rock_03_8.start);
    node_rock_03_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rock_03_8.position.set(0.15, 0.35910499999999995, 0.52);
    node_rock_03_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_rock_03_8.userData.sculptComponent = {"id": "rock-03", "name": "Rock03", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.78, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock half-buried in the turf.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.0806, "depth": 0.117, "units": "world", "confidence": 0.78}, "transform": {"position": [0.15, 0.35910499999999995, 0.52], "rotation": [0, 0, 0], "scale": [0.13, 0.0806, 0.117]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.78, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_03_8.userData.actionProfile = {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_rock_03_8);
  nodes["rock-03"] = node_rock_03_8;
  const mesh_rock_03_8Geometry = endpoint_rock_03_8
    ? new THREE.CylinderGeometry(endpoint_rock_03_8.endRadius, endpoint_rock_03_8.baseRadius, endpoint_rock_03_8.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_rock_03_8) {
    mesh_rock_03_8Geometry.scale(0.13, 0.0806, 0.117);
  }
  const mesh_rock_03_8 = new THREE.Mesh(
    mesh_rock_03_8Geometry,
    materialMap["island-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rock_03_8.name = "Rock03";
  if (endpoint_rock_03_8) {
    mesh_rock_03_8.position.copy(endpoint_rock_03_8.midpoint);
    mesh_rock_03_8.quaternion.copy(endpoint_rock_03_8.quaternion);
  }
  mesh_rock_03_8.castShadow = options.castShadow ?? true;
  mesh_rock_03_8.receiveShadow = options.receiveShadow ?? true;
  mesh_rock_03_8.userData.sculptComponent = {"id": "rock-03", "name": "Rock03", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.78, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock half-buried in the turf.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.0806, "depth": 0.117, "units": "world", "confidence": 0.78}, "transform": {"position": [0.15, 0.35910499999999995, 0.52], "rotation": [0, 0, 0], "scale": [0.13, 0.0806, 0.117]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.78, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_03_8.add(mesh_rock_03_8);
  meshes["rock-03"] = mesh_rock_03_8;
  colliders["rock-03"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rock-03"] ??= [];
  destructionGroups["rock-03"].push(node_rock_03_8);

  const endpoint_rock_04_9 = makeAttachmentEndpoint(null);
  const node_rock_04_9 = new THREE.Group();
  node_rock_04_9.name = "Rock04__pivot";
  node_rock_04_9.scale.set(1, 1, 1);
  if (endpoint_rock_04_9) {
    node_rock_04_9.position.copy(endpoint_rock_04_9.start);
    node_rock_04_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rock_04_9.position.set(-0.25, 0.36669999999999997, 0.12);
    node_rock_04_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_rock_04_9.userData.sculptComponent = {"id": "rock-04", "name": "Rock04", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.78, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock half-buried in the turf.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.124, "depth": 0.18000000000000002, "units": "world", "confidence": 0.78}, "transform": {"position": [-0.25, 0.36669999999999997, 0.12], "rotation": [0, 0, 0], "scale": [0.2, 0.124, 0.18000000000000002]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.78, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_04_9.userData.actionProfile = {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_rock_04_9);
  nodes["rock-04"] = node_rock_04_9;
  const mesh_rock_04_9Geometry = endpoint_rock_04_9
    ? new THREE.CylinderGeometry(endpoint_rock_04_9.endRadius, endpoint_rock_04_9.baseRadius, endpoint_rock_04_9.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_rock_04_9) {
    mesh_rock_04_9Geometry.scale(0.2, 0.124, 0.18000000000000002);
  }
  const mesh_rock_04_9 = new THREE.Mesh(
    mesh_rock_04_9Geometry,
    materialMap["island-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rock_04_9.name = "Rock04";
  if (endpoint_rock_04_9) {
    mesh_rock_04_9.position.copy(endpoint_rock_04_9.midpoint);
    mesh_rock_04_9.quaternion.copy(endpoint_rock_04_9.quaternion);
  }
  mesh_rock_04_9.castShadow = options.castShadow ?? true;
  mesh_rock_04_9.receiveShadow = options.receiveShadow ?? true;
  mesh_rock_04_9.userData.sculptComponent = {"id": "rock-04", "name": "Rock04", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.78, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock half-buried in the turf.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.124, "depth": 0.18000000000000002, "units": "world", "confidence": 0.78}, "transform": {"position": [-0.25, 0.36669999999999997, 0.12], "rotation": [0, 0, 0], "scale": [0.2, 0.124, 0.18000000000000002]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.78, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_04_9.add(mesh_rock_04_9);
  meshes["rock-04"] = mesh_rock_04_9;
  colliders["rock-04"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rock-04"] ??= [];
  destructionGroups["rock-04"].push(node_rock_04_9);

  const endpoint_rock_05_10 = makeAttachmentEndpoint(null);
  const node_rock_05_10 = new THREE.Group();
  node_rock_05_10.name = "Rock05__pivot";
  node_rock_05_10.scale.set(1, 1, 1);
  if (endpoint_rock_05_10) {
    node_rock_05_10.position.copy(endpoint_rock_05_10.start);
    node_rock_05_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rock_05_10.position.set(0.5718811708090112, 0.2156342857142857, 0.7206607568572848);
    node_rock_05_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_rock_05_10.userData.sculptComponent = {"id": "rock-05", "name": "Rock05", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.0992, "depth": 0.14400000000000002, "units": "world", "confidence": 0.75}, "transform": {"position": [0.5718811708090112, 0.2156342857142857, 0.7206607568572848], "rotation": [0, 0, 0], "scale": [0.16, 0.0992, 0.14400000000000002]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_05_10.userData.actionProfile = {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["island-body"] ?? root).add(node_rock_05_10);
  nodes["rock-05"] = node_rock_05_10;
  const mesh_rock_05_10Geometry = endpoint_rock_05_10
    ? new THREE.CylinderGeometry(endpoint_rock_05_10.endRadius, endpoint_rock_05_10.baseRadius, endpoint_rock_05_10.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_rock_05_10) {
    mesh_rock_05_10Geometry.scale(0.16, 0.0992, 0.14400000000000002);
  }
  const mesh_rock_05_10 = new THREE.Mesh(
    mesh_rock_05_10Geometry,
    materialMap["island-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rock_05_10.name = "Rock05";
  if (endpoint_rock_05_10) {
    mesh_rock_05_10.position.copy(endpoint_rock_05_10.midpoint);
    mesh_rock_05_10.quaternion.copy(endpoint_rock_05_10.quaternion);
  }
  mesh_rock_05_10.castShadow = options.castShadow ?? true;
  mesh_rock_05_10.receiveShadow = options.receiveShadow ?? true;
  mesh_rock_05_10.userData.sculptComponent = {"id": "rock-05", "name": "Rock05", "level": "meso", "role": "rock", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Grey rock lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.0992, "depth": 0.14400000000000002, "units": "world", "confidence": 0.75}, "transform": {"position": [0.5718811708090112, 0.2156342857142857, 0.7206607568572848], "rotation": [0, 0, 0], "scale": [0.16, 0.0992, 0.14400000000000002]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.75, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "rock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rock-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_rock_05_10.add(mesh_rock_05_10);
  meshes["rock-05"] = mesh_rock_05_10;
  colliders["rock-05"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rock-05"] ??= [];
  destructionGroups["rock-05"].push(node_rock_05_10);

  const attachment_tuft_01_11 = {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_tuft_01_11 = makeAttachmentEndpoint(attachment_tuft_01_11);
  const node_tuft_01_11 = new THREE.Group();
  node_tuft_01_11.name = "Tuft01__pivot";
  node_tuft_01_11.scale.set(1, 1, 1);
  if (endpoint_tuft_01_11) {
    node_tuft_01_11.position.copy(endpoint_tuft_01_11.start);
    node_tuft_01_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tuft_01_11.position.set(0.8913994279737932, 0.33231034482758615, 0.2276116425141611);
    node_tuft_01_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_tuft_01_11.userData.sculptComponent = {"id": "tuft-01", "name": "Tuft01", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [0.8913994279737932, 0.33231034482758615, 0.2276116425141611], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["grass-blade-linework"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_01_11.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_tuft_01_11);
  nodes["tuft-01"] = node_tuft_01_11;
  const mesh_tuft_01_11Geometry = endpoint_tuft_01_11
    ? new THREE.CylinderGeometry(endpoint_tuft_01_11.endRadius, endpoint_tuft_01_11.baseRadius, endpoint_tuft_01_11.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_tuft_01_11) {
    mesh_tuft_01_11Geometry.scale(0.13, 0.34, 0.13);
  }
  const mesh_tuft_01_11 = new THREE.Mesh(
    mesh_tuft_01_11Geometry,
    materialMap["island-grass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_01_11.name = "Tuft01";
  if (endpoint_tuft_01_11) {
    mesh_tuft_01_11.position.copy(endpoint_tuft_01_11.midpoint);
    mesh_tuft_01_11.quaternion.copy(endpoint_tuft_01_11.quaternion);
  }
  mesh_tuft_01_11.castShadow = options.castShadow ?? true;
  mesh_tuft_01_11.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_01_11.userData.sculptComponent = {"id": "tuft-01", "name": "Tuft01", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [0.8913994279737932, 0.33231034482758615, 0.2276116425141611], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": ["grass-blade-linework"], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_01_11.add(mesh_tuft_01_11);
  meshes["tuft-01"] = mesh_tuft_01_11;
  colliders["tuft-01"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["tuft-01"] ??= [];
  destructionGroups["tuft-01"].push(node_tuft_01_11);

  const attachment_tuft_02_12 = {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_tuft_02_12 = makeAttachmentEndpoint(attachment_tuft_02_12);
  const node_tuft_02_12 = new THREE.Group();
  node_tuft_02_12.name = "Tuft02__pivot";
  node_tuft_02_12.scale.set(1, 1, 1);
  if (endpoint_tuft_02_12) {
    node_tuft_02_12.position.copy(endpoint_tuft_02_12.start);
    node_tuft_02_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tuft_02_12.position.set(0.24858224937253104, 0.33231034482758615, 0.8857803708013025);
    node_tuft_02_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_tuft_02_12.userData.sculptComponent = {"id": "tuft-02", "name": "Tuft02", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [0.24858224937253104, 0.33231034482758615, 0.8857803708013025], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_02_12.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_tuft_02_12);
  nodes["tuft-02"] = node_tuft_02_12;
  const mesh_tuft_02_12Geometry = endpoint_tuft_02_12
    ? new THREE.CylinderGeometry(endpoint_tuft_02_12.endRadius, endpoint_tuft_02_12.baseRadius, endpoint_tuft_02_12.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_tuft_02_12) {
    mesh_tuft_02_12Geometry.scale(0.13, 0.34, 0.13);
  }
  const mesh_tuft_02_12 = new THREE.Mesh(
    mesh_tuft_02_12Geometry,
    materialMap["island-grass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_02_12.name = "Tuft02";
  if (endpoint_tuft_02_12) {
    mesh_tuft_02_12.position.copy(endpoint_tuft_02_12.midpoint);
    mesh_tuft_02_12.quaternion.copy(endpoint_tuft_02_12.quaternion);
  }
  mesh_tuft_02_12.castShadow = options.castShadow ?? true;
  mesh_tuft_02_12.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_02_12.userData.sculptComponent = {"id": "tuft-02", "name": "Tuft02", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [0.24858224937253104, 0.33231034482758615, 0.8857803708013025], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_02_12.add(mesh_tuft_02_12);
  meshes["tuft-02"] = mesh_tuft_02_12;
  colliders["tuft-02"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["tuft-02"] ??= [];
  destructionGroups["tuft-02"].push(node_tuft_02_12);

  const attachment_tuft_03_13 = {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_tuft_03_13 = makeAttachmentEndpoint(attachment_tuft_03_13);
  const node_tuft_03_13 = new THREE.Group();
  node_tuft_03_13.name = "Tuft03__pivot";
  node_tuft_03_13.scale.set(1, 1, 1);
  if (endpoint_tuft_03_13) {
    node_tuft_03_13.position.copy(endpoint_tuft_03_13.start);
    node_tuft_03_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tuft_03_13.position.set(-0.6428171786012621, 0.33231034482758615, 0.6581687282871415);
    node_tuft_03_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_tuft_03_13.userData.sculptComponent = {"id": "tuft-03", "name": "Tuft03", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.6428171786012621, 0.33231034482758615, 0.6581687282871415], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_03_13.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_tuft_03_13);
  nodes["tuft-03"] = node_tuft_03_13;
  const mesh_tuft_03_13Geometry = endpoint_tuft_03_13
    ? new THREE.CylinderGeometry(endpoint_tuft_03_13.endRadius, endpoint_tuft_03_13.baseRadius, endpoint_tuft_03_13.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_tuft_03_13) {
    mesh_tuft_03_13Geometry.scale(0.13, 0.34, 0.13);
  }
  const mesh_tuft_03_13 = new THREE.Mesh(
    mesh_tuft_03_13Geometry,
    materialMap["island-grass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_03_13.name = "Tuft03";
  if (endpoint_tuft_03_13) {
    mesh_tuft_03_13.position.copy(endpoint_tuft_03_13.midpoint);
    mesh_tuft_03_13.quaternion.copy(endpoint_tuft_03_13.quaternion);
  }
  mesh_tuft_03_13.castShadow = options.castShadow ?? true;
  mesh_tuft_03_13.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_03_13.userData.sculptComponent = {"id": "tuft-03", "name": "Tuft03", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.6428171786012621, 0.33231034482758615, 0.6581687282871415], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_03_13.add(mesh_tuft_03_13);
  meshes["tuft-03"] = mesh_tuft_03_13;
  colliders["tuft-03"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["tuft-03"] ??= [];
  destructionGroups["tuft-03"].push(node_tuft_03_13);

  const attachment_tuft_04_14 = {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_tuft_04_14 = makeAttachmentEndpoint(attachment_tuft_04_14);
  const node_tuft_04_14 = new THREE.Group();
  node_tuft_04_14.name = "Tuft04__pivot";
  node_tuft_04_14.scale.set(1, 1, 1);
  if (endpoint_tuft_04_14) {
    node_tuft_04_14.position.copy(endpoint_tuft_04_14.start);
    node_tuft_04_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tuft_04_14.position.set(-0.8913994279737933, 0.33231034482758615, -0.227611642514161);
    node_tuft_04_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_tuft_04_14.userData.sculptComponent = {"id": "tuft-04", "name": "Tuft04", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.8913994279737933, 0.33231034482758615, -0.227611642514161], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_04_14.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_tuft_04_14);
  nodes["tuft-04"] = node_tuft_04_14;
  const mesh_tuft_04_14Geometry = endpoint_tuft_04_14
    ? new THREE.CylinderGeometry(endpoint_tuft_04_14.endRadius, endpoint_tuft_04_14.baseRadius, endpoint_tuft_04_14.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_tuft_04_14) {
    mesh_tuft_04_14Geometry.scale(0.13, 0.34, 0.13);
  }
  const mesh_tuft_04_14 = new THREE.Mesh(
    mesh_tuft_04_14Geometry,
    materialMap["island-grass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_04_14.name = "Tuft04";
  if (endpoint_tuft_04_14) {
    mesh_tuft_04_14.position.copy(endpoint_tuft_04_14.midpoint);
    mesh_tuft_04_14.quaternion.copy(endpoint_tuft_04_14.quaternion);
  }
  mesh_tuft_04_14.castShadow = options.castShadow ?? true;
  mesh_tuft_04_14.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_04_14.userData.sculptComponent = {"id": "tuft-04", "name": "Tuft04", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.8913994279737933, 0.33231034482758615, -0.227611642514161], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_04_14.add(mesh_tuft_04_14);
  meshes["tuft-04"] = mesh_tuft_04_14;
  colliders["tuft-04"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["tuft-04"] ??= [];
  destructionGroups["tuft-04"].push(node_tuft_04_14);

  const attachment_tuft_05_15 = {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_tuft_05_15 = makeAttachmentEndpoint(attachment_tuft_05_15);
  const node_tuft_05_15 = new THREE.Group();
  node_tuft_05_15.name = "Tuft05__pivot";
  node_tuft_05_15.scale.set(1, 1, 1);
  if (endpoint_tuft_05_15) {
    node_tuft_05_15.position.copy(endpoint_tuft_05_15.start);
    node_tuft_05_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tuft_05_15.position.set(-0.24858224937253134, 0.33231034482758615, -0.8857803708013025);
    node_tuft_05_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_tuft_05_15.userData.sculptComponent = {"id": "tuft-05", "name": "Tuft05", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.24858224937253134, 0.33231034482758615, -0.8857803708013025], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_05_15.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_tuft_05_15);
  nodes["tuft-05"] = node_tuft_05_15;
  const mesh_tuft_05_15Geometry = endpoint_tuft_05_15
    ? new THREE.CylinderGeometry(endpoint_tuft_05_15.endRadius, endpoint_tuft_05_15.baseRadius, endpoint_tuft_05_15.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_tuft_05_15) {
    mesh_tuft_05_15Geometry.scale(0.13, 0.34, 0.13);
  }
  const mesh_tuft_05_15 = new THREE.Mesh(
    mesh_tuft_05_15Geometry,
    materialMap["island-grass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_05_15.name = "Tuft05";
  if (endpoint_tuft_05_15) {
    mesh_tuft_05_15.position.copy(endpoint_tuft_05_15.midpoint);
    mesh_tuft_05_15.quaternion.copy(endpoint_tuft_05_15.quaternion);
  }
  mesh_tuft_05_15.castShadow = options.castShadow ?? true;
  mesh_tuft_05_15.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_05_15.userData.sculptComponent = {"id": "tuft-05", "name": "Tuft05", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.24858224937253134, 0.33231034482758615, -0.8857803708013025], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_05_15.add(mesh_tuft_05_15);
  meshes["tuft-05"] = mesh_tuft_05_15;
  colliders["tuft-05"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["tuft-05"] ??= [];
  destructionGroups["tuft-05"].push(node_tuft_05_15);

  const attachment_tuft_06_16 = {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_tuft_06_16 = makeAttachmentEndpoint(attachment_tuft_06_16);
  const node_tuft_06_16 = new THREE.Group();
  node_tuft_06_16.name = "Tuft06__pivot";
  node_tuft_06_16.scale.set(1, 1, 1);
  if (endpoint_tuft_06_16) {
    node_tuft_06_16.position.copy(endpoint_tuft_06_16.start);
    node_tuft_06_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tuft_06_16.position.set(0.6428171786012618, 0.33231034482758615, -0.6581687282871419);
    node_tuft_06_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_tuft_06_16.userData.sculptComponent = {"id": "tuft-06", "name": "Tuft06", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [0.6428171786012618, 0.33231034482758615, -0.6581687282871419], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_06_16.userData.actionProfile = {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["grass-cap"] ?? root).add(node_tuft_06_16);
  nodes["tuft-06"] = node_tuft_06_16;
  const mesh_tuft_06_16Geometry = endpoint_tuft_06_16
    ? new THREE.CylinderGeometry(endpoint_tuft_06_16.endRadius, endpoint_tuft_06_16.baseRadius, endpoint_tuft_06_16.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_tuft_06_16) {
    mesh_tuft_06_16Geometry.scale(0.13, 0.34, 0.13);
  }
  const mesh_tuft_06_16 = new THREE.Mesh(
    mesh_tuft_06_16Geometry,
    materialMap["island-grass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_06_16.name = "Tuft06";
  if (endpoint_tuft_06_16) {
    mesh_tuft_06_16.position.copy(endpoint_tuft_06_16.midpoint);
    mesh_tuft_06_16.quaternion.copy(endpoint_tuft_06_16.quaternion);
  }
  mesh_tuft_06_16.castShadow = options.castShadow ?? true;
  mesh_tuft_06_16.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_06_16.userData.sculptComponent = {"id": "tuft-06", "name": "Tuft06", "level": "micro", "role": "foliage", "importance": 0.4, "confidence": 0.72, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Sparse grass tuft seated on the turf rim.", "parent": "grass-cap", "attachment": {"parentId": "grass-cap", "parentSocket": "grass-cap-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.13, "height": 0.34, "depth": 0.13, "units": "world", "confidence": 0.72}, "transform": {"position": [0.6428171786012618, 0.33231034482758615, -0.6581687282871419], "rotation": [0, 0, 0], "scale": [0.13, 0.34, 0.13]}, "material": "island-grass", "materialLayers": ["island-grass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(156, 188, 119, 1.0)", "secondaryAlbedo": "rgba(170, 198, 135, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "foliage", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "tuft-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_tuft_06_16.add(mesh_tuft_06_16);
  meshes["tuft-06"] = mesh_tuft_06_16;
  colliders["tuft-06"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["tuft-06"] ??= [];
  destructionGroups["tuft-06"].push(node_tuft_06_16);

  const endpoint_pebble_01_17 = makeAttachmentEndpoint(null);
  const node_pebble_01_17 = new THREE.Group();
  node_pebble_01_17.name = "Pebble01__pivot";
  node_pebble_01_17.scale.set(1, 1, 1);
  if (endpoint_pebble_01_17) {
    node_pebble_01_17.position.copy(endpoint_pebble_01_17.start);
    node_pebble_01_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_01_17.position.set(0.5905294698571312, 0.18600000000000005, 0.7441605641461092);
    node_pebble_01_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_01_17.userData.sculptComponent = {"id": "pebble-01", "name": "Pebble01", "level": "micro", "role": "debris", "importance": 0.4, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small stone lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.06, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [0.5905294698571312, 0.18600000000000005, 0.7441605641461092], "rotation": [0, 0, 0], "scale": [0.09, 0.06, 0.09]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_01_17.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["island-body"] ?? root).add(node_pebble_01_17);
  nodes["pebble-01"] = node_pebble_01_17;
  const mesh_pebble_01_17Geometry = endpoint_pebble_01_17
    ? new THREE.CylinderGeometry(endpoint_pebble_01_17.endRadius, endpoint_pebble_01_17.baseRadius, endpoint_pebble_01_17.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_01_17) {
    mesh_pebble_01_17Geometry.scale(0.09, 0.06, 0.09);
  }
  const mesh_pebble_01_17 = new THREE.Mesh(
    mesh_pebble_01_17Geometry,
    materialMap["island-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_01_17.name = "Pebble01";
  if (endpoint_pebble_01_17) {
    mesh_pebble_01_17.position.copy(endpoint_pebble_01_17.midpoint);
    mesh_pebble_01_17.quaternion.copy(endpoint_pebble_01_17.quaternion);
  }
  mesh_pebble_01_17.castShadow = options.castShadow ?? true;
  mesh_pebble_01_17.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_01_17.userData.sculptComponent = {"id": "pebble-01", "name": "Pebble01", "level": "micro", "role": "debris", "importance": 0.4, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small stone lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.06, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [0.5905294698571312, 0.18600000000000005, 0.7441605641461092], "rotation": [0, 0, 0], "scale": [0.09, 0.06, 0.09]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_01_17.add(mesh_pebble_01_17);
  meshes["pebble-01"] = mesh_pebble_01_17;
  colliders["pebble-01"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-01"] ??= [];
  destructionGroups["pebble-01"].push(node_pebble_01_17);

  const endpoint_pebble_02_18 = makeAttachmentEndpoint(null);
  const node_pebble_02_18 = new THREE.Group();
  node_pebble_02_18.name = "Pebble02__pivot";
  node_pebble_02_18.scale.set(1, 1, 1);
  if (endpoint_pebble_02_18) {
    node_pebble_02_18.position.copy(endpoint_pebble_02_18.start);
    node_pebble_02_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_02_18.position.set(-0.7441605641461091, 0.18600000000000005, 0.5905294698571314);
    node_pebble_02_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_02_18.userData.sculptComponent = {"id": "pebble-02", "name": "Pebble02", "level": "micro", "role": "debris", "importance": 0.4, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small stone lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.06, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.7441605641461091, 0.18600000000000005, 0.5905294698571314], "rotation": [0, 0, 0], "scale": [0.09, 0.06, 0.09]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_02_18.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["island-body"] ?? root).add(node_pebble_02_18);
  nodes["pebble-02"] = node_pebble_02_18;
  const mesh_pebble_02_18Geometry = endpoint_pebble_02_18
    ? new THREE.CylinderGeometry(endpoint_pebble_02_18.endRadius, endpoint_pebble_02_18.baseRadius, endpoint_pebble_02_18.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_02_18) {
    mesh_pebble_02_18Geometry.scale(0.09, 0.06, 0.09);
  }
  const mesh_pebble_02_18 = new THREE.Mesh(
    mesh_pebble_02_18Geometry,
    materialMap["island-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_02_18.name = "Pebble02";
  if (endpoint_pebble_02_18) {
    mesh_pebble_02_18.position.copy(endpoint_pebble_02_18.midpoint);
    mesh_pebble_02_18.quaternion.copy(endpoint_pebble_02_18.quaternion);
  }
  mesh_pebble_02_18.castShadow = options.castShadow ?? true;
  mesh_pebble_02_18.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_02_18.userData.sculptComponent = {"id": "pebble-02", "name": "Pebble02", "level": "micro", "role": "debris", "importance": 0.4, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small stone lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.06, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.7441605641461091, 0.18600000000000005, 0.5905294698571314], "rotation": [0, 0, 0], "scale": [0.09, 0.06, 0.09]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_02_18.add(mesh_pebble_02_18);
  meshes["pebble-02"] = mesh_pebble_02_18;
  colliders["pebble-02"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-02"] ??= [];
  destructionGroups["pebble-02"].push(node_pebble_02_18);

  const endpoint_pebble_03_19 = makeAttachmentEndpoint(null);
  const node_pebble_03_19 = new THREE.Group();
  node_pebble_03_19.name = "Pebble03__pivot";
  node_pebble_03_19.scale.set(1, 1, 1);
  if (endpoint_pebble_03_19) {
    node_pebble_03_19.position.copy(endpoint_pebble_03_19.start);
    node_pebble_03_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_03_19.position.set(-0.5905294698571311, 0.18600000000000005, -0.7441605641461093);
    node_pebble_03_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_03_19.userData.sculptComponent = {"id": "pebble-03", "name": "Pebble03", "level": "micro", "role": "debris", "importance": 0.4, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small stone lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.06, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.5905294698571311, 0.18600000000000005, -0.7441605641461093], "rotation": [0, 0, 0], "scale": [0.09, 0.06, 0.09]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_03_19.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["island-body"] ?? root).add(node_pebble_03_19);
  nodes["pebble-03"] = node_pebble_03_19;
  const mesh_pebble_03_19Geometry = endpoint_pebble_03_19
    ? new THREE.CylinderGeometry(endpoint_pebble_03_19.endRadius, endpoint_pebble_03_19.baseRadius, endpoint_pebble_03_19.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_03_19) {
    mesh_pebble_03_19Geometry.scale(0.09, 0.06, 0.09);
  }
  const mesh_pebble_03_19 = new THREE.Mesh(
    mesh_pebble_03_19Geometry,
    materialMap["island-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_03_19.name = "Pebble03";
  if (endpoint_pebble_03_19) {
    mesh_pebble_03_19.position.copy(endpoint_pebble_03_19.midpoint);
    mesh_pebble_03_19.quaternion.copy(endpoint_pebble_03_19.quaternion);
  }
  mesh_pebble_03_19.castShadow = options.castShadow ?? true;
  mesh_pebble_03_19.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_03_19.userData.sculptComponent = {"id": "pebble-03", "name": "Pebble03", "level": "micro", "role": "debris", "importance": 0.4, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small stone lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.06, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [-0.5905294698571311, 0.18600000000000005, -0.7441605641461093], "rotation": [0, 0, 0], "scale": [0.09, 0.06, 0.09]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_03_19.add(mesh_pebble_03_19);
  meshes["pebble-03"] = mesh_pebble_03_19;
  colliders["pebble-03"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-03"] ??= [];
  destructionGroups["pebble-03"].push(node_pebble_03_19);

  const endpoint_pebble_04_20 = makeAttachmentEndpoint(null);
  const node_pebble_04_20 = new THREE.Group();
  node_pebble_04_20.name = "Pebble04__pivot";
  node_pebble_04_20.scale.set(1, 1, 1);
  if (endpoint_pebble_04_20) {
    node_pebble_04_20.position.copy(endpoint_pebble_04_20.start);
    node_pebble_04_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pebble_04_20.position.set(0.7441605641461093, 0.18600000000000005, -0.5905294698571311);
    node_pebble_04_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_pebble_04_20.userData.sculptComponent = {"id": "pebble-04", "name": "Pebble04", "level": "micro", "role": "debris", "importance": 0.4, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small stone lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.06, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [0.7441605641461093, 0.18600000000000005, -0.5905294698571311], "rotation": [0, 0, 0], "scale": [0.09, 0.06, 0.09]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_04_20.userData.actionProfile = {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["island-body"] ?? root).add(node_pebble_04_20);
  nodes["pebble-04"] = node_pebble_04_20;
  const mesh_pebble_04_20Geometry = endpoint_pebble_04_20
    ? new THREE.CylinderGeometry(endpoint_pebble_04_20.endRadius, endpoint_pebble_04_20.baseRadius, endpoint_pebble_04_20.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pebble_04_20) {
    mesh_pebble_04_20Geometry.scale(0.09, 0.06, 0.09);
  }
  const mesh_pebble_04_20 = new THREE.Mesh(
    mesh_pebble_04_20Geometry,
    materialMap["island-rock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pebble_04_20.name = "Pebble04";
  if (endpoint_pebble_04_20) {
    mesh_pebble_04_20.position.copy(endpoint_pebble_04_20.midpoint);
    mesh_pebble_04_20.quaternion.copy(endpoint_pebble_04_20.quaternion);
  }
  mesh_pebble_04_20.castShadow = options.castShadow ?? true;
  mesh_pebble_04_20.receiveShadow = options.receiveShadow ?? true;
  mesh_pebble_04_20.userData.sculptComponent = {"id": "pebble-04", "name": "Pebble04", "level": "micro", "role": "debris", "importance": 0.4, "confidence": 0.7, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small stone lodged on the clay wall.", "parent": "island-body", "attachment": {"parentId": "island-body", "parentSocket": "island-body-socket", "contactType": "embedded", "embedDepth": 0.03, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.06, "depth": 0.09, "units": "world", "confidence": 0.7}, "transform": {"position": [0.7441605641461093, 0.18600000000000005, -0.5905294698571311], "rotation": [0, 0, 0], "scale": [0.09, 0.06, 0.09]}, "material": "island-rock", "materialLayers": ["island-rock"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 188, 123, 1.0)", "secondaryAlbedo": "rgba(188, 204, 149, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.7, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "debris", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.85}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "pebble-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "localFeatures": [], "evidenceRefs": ["full-object"], "fidelityTier": "form-refinement"};
  node_pebble_04_20.add(mesh_pebble_04_20);
  meshes["pebble-04"] = mesh_pebble_04_20;
  colliders["pebble-04"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["pebble-04"] ??= [];
  destructionGroups["pebble-04"].push(node_pebble_04_20);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createIslandShape2LookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Island Shape 2 look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"role": "key light", "direction": "upper-left", "color": "#FFF3D6", "intensity": 2.5, "exposure": "ACESFilmic tone mapping, exposure 1.15", "notes": "warm sun"}, {"role": "fill light", "direction": "front-right", "color": "#A9C6E0", "intensity": 0.5, "notes": "cool sky bounce"}, {"role": "rim / environment light", "color": "#CFE8FF", "intensity": 0.4, "notes": "hemisphere environment"}, {"role": "contact shadow", "notes": "soft contact shadow under the island; ambient occlusion darkens the lip and stone pockets", "ambientOcclusion": 0.35}, {"role": "background", "notes": "flat cream #F5EFE0 background matching the reference paper"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createIslandShape2Environment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameIslandShape2Camera(
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
export function createIslandShape2PresentationComposer(
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

export function configureIslandShape2Renderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createIslandShape2InspectControls(
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
