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

// Generated from ObjectSculptSpec target: Black Cat Caravan
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createBlackCatCaravanModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Black Cat Caravan";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.333, "orientation": {"yaw": -15, "pitch": 5, "roll": 0}, "positionHint": [3.0, 1.5, 4.0], "note": "Three-quarter front-left view, slightly elevated"}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["cat-fur-black"] = createSculptMaterial(
    "cat-fur-black",
    {"id": "cat-fur-black", "name": "Cat Fur Black", "type": "standard", "baseColor": "#1A1A1E", "roughness": {"base": 0.82, "variation": 0.1, "map": "cat-fur-black-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "faceted-fur", "strength": 0.25, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "large fur shading zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted low-poly plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "fine fur grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#1A1A1E"]}, "localOverrides": [{"zone": "ear-inner", "albedo": "#26262C", "description": "slightly lifted inner ear planes"}]},
    options
  );
  materialMap["window-frame-wood"] = createSculptMaterial(
    "window-frame-wood",
    {"id": "window-frame-wood", "name": "Window Frame Wood", "type": "standard", "baseColor": "#8B5A3A", "roughness": {"base": 0.6, "variation": 0.1, "map": "window-frame-wood-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "wood-grain", "strength": 0.3, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "large fur shading zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted low-poly plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "fine fur grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#8B5A3A"]}, "localOverrides": [{"zone": "sill", "albedo": "#7A4E30", "description": "darker sill shadow zone"}]},
    options
  );
  materialMap["window-glass-cream"] = createSculptMaterial(
    "window-glass-cream",
    {"id": "window-glass-cream", "name": "Window Glass Cream", "type": "emissive", "baseColor": "#F5F0E0", "roughness": {"base": 0.25, "variation": 0.05, "map": "window-glass-cream-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.1, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "large fur shading zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted low-poly plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "fine fur grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#F5F0E0"]}, "emissive": "#F0E8C8", "emissiveIntensity": 0.7, "localOverrides": [{"zone": "pane-top", "albedo": "#FFF8E8", "description": "brighter upper pane"}]},
    options
  );
  materialMap["eye-yellow"] = createSculptMaterial(
    "eye-yellow",
    {"id": "eye-yellow", "name": "Eye Yellow", "type": "emissive", "baseColor": "#F0E020", "roughness": {"base": 0.3, "variation": 0.05, "map": "eye-yellow-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.1, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "large fur shading zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted low-poly plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "fine fur grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#F0E020"]}, "emissive": "#E8D818", "emissiveIntensity": 0.9, "localOverrides": [{"zone": "default", "albedo": "#F0E020", "description": "uniform zone"}]},
    options
  );
  materialMap["eye-pupil-black"] = createSculptMaterial(
    "eye-pupil-black",
    {"id": "eye-pupil-black", "name": "Eye Pupil Black", "type": "standard", "baseColor": "#0A0A0C", "roughness": {"base": 0.25, "variation": 0.05, "map": "eye-pupil-black-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.1, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "large fur shading zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted low-poly plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "fine fur grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#0A0A0C"]}, "localOverrides": [{"zone": "default", "albedo": "#0A0A0C", "description": "uniform zone"}]},
    options
  );
  materialMap["whisker-dark"] = createSculptMaterial(
    "whisker-dark",
    {"id": "whisker-dark", "name": "Whisker Dark", "type": "standard", "baseColor": "#2A2A30", "roughness": {"base": 0.5, "variation": 0.08, "map": "whisker-dark-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.1, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "large fur shading zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted low-poly plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "fine fur grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#2A2A30"]}, "localOverrides": [{"zone": "default", "albedo": "#2A2A30", "description": "uniform zone"}]},
    options
  );

  
  // refine-code: 低多边形刻面风格 + 参考色板
  {
    const furMat = materialMap["cat-fur-black"] as THREE.MeshStandardMaterial | undefined;
    if (furMat) {
      furMat.flatShading = true;
      furMat.color.set("#1A1A1E");
      furMat.map = null;
      furMat.needsUpdate = true;
    }
    const woodMat = materialMap["window-frame-wood"] as THREE.MeshStandardMaterial | undefined;
    if (woodMat) { woodMat.color.set("#8B5A3A"); woodMat.map = null; woodMat.needsUpdate = true; }
    const eyeMat = materialMap["eye-yellow"] as THREE.MeshStandardMaterial | undefined;
    if (eyeMat) {
      eyeMat.emissive.set("#F0E020");
      eyeMat.emissiveIntensity = 1.4;
      eyeMat.color.set("#F0E020");
      eyeMat.map = null;
      eyeMat.needsUpdate = true;
    }
    const pupilMat = materialMap["eye-pupil-black"] as THREE.MeshStandardMaterial | undefined;
    if (pupilMat) { pupilMat.color.set("#0A0A0C"); pupilMat.map = null; pupilMat.needsUpdate = true; }
    const glassMat = materialMap["window-glass-cream"] as THREE.MeshStandardMaterial | undefined;
    if (glassMat) {
      glassMat.emissive.set("#F0E4B8");
      glassMat.emissiveIntensity = 0.9;
      glassMat.color.set("#F5F0E0");
      glassMat.map = null;
      glassMat.needsUpdate = true;
    }
    const whiskerMat = materialMap["whisker-dark"] as THREE.MeshStandardMaterial | undefined;
    if (whiskerMat) { whiskerMat.color.set("#2A2A30"); whiskerMat.map = null; whiskerMat.needsUpdate = true; }
  }

const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_cat_root_0 = null;
  const endpoint_cat_root_0 = makeAttachmentEndpoint(attachment_cat_root_0);
  const node_cat_root_0 = new THREE.Group();
  node_cat_root_0.name = "BlackCatCaravan__pivot";
  node_cat_root_0.scale.set(1, 1, 1);
  if (endpoint_cat_root_0) {
    node_cat_root_0.position.copy(endpoint_cat_root_0.start);
    node_cat_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cat_root_0.position.set(0.0, 0.0, 0.0);
    node_cat_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_cat_root_0.userData.sculptComponent = {"id": "cat-root", "name": "BlackCatCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "BlackCatCaravan solid geometry attached to None", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.92, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "cat-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_cat_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "cat-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_cat_root_0);
  nodes["cat-root"] = node_cat_root_0;
  const mesh_cat_root_0Geometry = endpoint_cat_root_0
    ? new THREE.CylinderGeometry(endpoint_cat_root_0.endRadius, endpoint_cat_root_0.baseRadius, endpoint_cat_root_0.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_cat_root_0) {
    mesh_cat_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cat_root_0 = new THREE.Mesh(
    mesh_cat_root_0Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cat_root_0.name = "BlackCatCaravan";
  if (endpoint_cat_root_0) {
    mesh_cat_root_0.position.copy(endpoint_cat_root_0.midpoint);
    mesh_cat_root_0.quaternion.copy(endpoint_cat_root_0.quaternion);
  }
  mesh_cat_root_0.castShadow = options.castShadow ?? true;
  mesh_cat_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_cat_root_0.visible = false; // 容器节点不渲染
  mesh_cat_root_0.userData.sculptComponent = {"id": "cat-root", "name": "BlackCatCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "BlackCatCaravan solid geometry attached to None", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.92, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "cat-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_cat_root_0.add(mesh_cat_root_0);
  meshes["cat-root"] = mesh_cat_root_0;
  colliders["cat-root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["cat-root"] ??= [];
  destructionGroups["cat-root"].push(node_cat_root_0);

  const endpoint_body_1 = makeAttachmentEndpoint(null);
  const node_body_1 = new THREE.Group();
  node_body_1.name = "Body__pivot";
  node_body_1.scale.set(1, 1, 1);
  if (endpoint_body_1) {
    node_body_1.position.copy(endpoint_body_1.start);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_body_1.position.set(0.0, 1.05, 0.0);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.5, "depth": 1.4, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 1.05, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.5, 1.4]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded low-poly faceted volume, slightly taller at rear, chamfered edges read as faceted planes", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.92, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "low-poly facet planes + fur grain", "strength": 0.25, "scale": 8.0}, "roughnessVariation": {"pattern": "facet sheen variation", "amount": 0.15}}};
  node_body_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_body_1);
  nodes["body"] = node_body_1;
  const mesh_body_1Geometry = endpoint_body_1
    ? new THREE.CylinderGeometry(endpoint_body_1.endRadius, endpoint_body_1.baseRadius, endpoint_body_1.length, 32, 12)
    : new RoundedBoxGeometry(3.0, 1.5, 1.4, 4, 0.12);
  if (!endpoint_body_1) {
    mesh_body_1Geometry.scale(1, 1, 1); // 已是最终尺寸
  }
  const mesh_body_1 = new THREE.Mesh(
    mesh_body_1Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_1.name = "Body";
  if (endpoint_body_1) {
    mesh_body_1.position.copy(endpoint_body_1.midpoint);
    mesh_body_1.quaternion.copy(endpoint_body_1.quaternion);
  }
  mesh_body_1.castShadow = options.castShadow ?? true;
  mesh_body_1.receiveShadow = options.receiveShadow ?? true;
  mesh_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.5, "depth": 1.4, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 1.05, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.5, 1.4]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded low-poly faceted volume, slightly taller at rear, chamfered edges read as faceted planes", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.92, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "low-poly facet planes + fur grain", "strength": 0.25, "scale": 8.0}, "roughnessVariation": {"pattern": "facet sheen variation", "amount": 0.15}}};
  node_body_1.add(mesh_body_1);
  meshes["body"] = mesh_body_1;
  colliders["body"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_body_1);

  const attachment_ear_front_2 = {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_ear_front_2 = makeAttachmentEndpoint(attachment_ear_front_2);
  const node_ear_front_2 = new THREE.Group();
  node_ear_front_2.name = "EarFront__pivot";
  node_ear_front_2.scale.set(1, 1, 1);
  if (endpoint_ear_front_2) {
    node_ear_front_2.position.copy(endpoint_ear_front_2.start);
    node_ear_front_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_front_2.position.set(-1.0, 2.05, -0.42);
    node_ear_front_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_front_2.userData.sculptComponent = {"id": "ear-front", "name": "EarFront", "level": "macro", "role": "ear", "importance": 0.85, "confidence": 0.9, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.7, "depth": 0.55, "units": "world", "confidence": 0.9}, "transform": {"position": [-1.0, 2.05, -0.42], "rotation": [0, 0, 0], "scale": [0.55, 0.7, 0.55]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Triangular cat ear silhouette on roof front-left, sharp apex", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ear-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_ear_front_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ear-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_ear_front_2);
  nodes["ear-front"] = node_ear_front_2;
  const mesh_ear_front_2Geometry = endpoint_ear_front_2
    ? new THREE.CylinderGeometry(endpoint_ear_front_2.endRadius, endpoint_ear_front_2.baseRadius, endpoint_ear_front_2.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_ear_front_2) {
    mesh_ear_front_2Geometry.scale(0.55, 0.7, 0.55);
  }
  const mesh_ear_front_2 = new THREE.Mesh(
    mesh_ear_front_2Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_front_2.name = "EarFront";
  if (endpoint_ear_front_2) {
    mesh_ear_front_2.position.copy(endpoint_ear_front_2.midpoint);
    mesh_ear_front_2.quaternion.copy(endpoint_ear_front_2.quaternion);
  }
  mesh_ear_front_2.castShadow = options.castShadow ?? true;
  mesh_ear_front_2.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_front_2.userData.sculptComponent = {"id": "ear-front", "name": "EarFront", "level": "macro", "role": "ear", "importance": 0.85, "confidence": 0.9, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.7, "depth": 0.55, "units": "world", "confidence": 0.9}, "transform": {"position": [-1.0, 2.05, -0.42], "rotation": [0, 0, 0], "scale": [0.55, 0.7, 0.55]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Triangular cat ear silhouette on roof front-left, sharp apex", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ear-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_ear_front_2.add(mesh_ear_front_2);
  meshes["ear-front"] = mesh_ear_front_2;
  colliders["ear-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["ear-front"] ??= [];
  destructionGroups["ear-front"].push(node_ear_front_2);

  const attachment_ear_back_3 = {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_ear_back_3 = makeAttachmentEndpoint(attachment_ear_back_3);
  const node_ear_back_3 = new THREE.Group();
  node_ear_back_3.name = "EarBack__pivot";
  node_ear_back_3.scale.set(1, 1, 1);
  if (endpoint_ear_back_3) {
    node_ear_back_3.position.copy(endpoint_ear_back_3.start);
    node_ear_back_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_back_3.position.set(-1.0, 2.05, 0.42);
    node_ear_back_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_back_3.userData.sculptComponent = {"id": "ear-back", "name": "EarBack", "level": "macro", "role": "ear", "importance": 0.8, "confidence": 0.9, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.6, "depth": 0.5, "units": "world", "confidence": 0.9}, "transform": {"position": [-1.0, 2.05, 0.42], "rotation": [0, 0, 0], "scale": [0.5, 0.6, 0.5]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Second triangular ear on roof rear-right", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ear-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_ear_back_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ear-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_ear_back_3);
  nodes["ear-back"] = node_ear_back_3;
  const mesh_ear_back_3Geometry = endpoint_ear_back_3
    ? new THREE.CylinderGeometry(endpoint_ear_back_3.endRadius, endpoint_ear_back_3.baseRadius, endpoint_ear_back_3.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_ear_back_3) {
    mesh_ear_back_3Geometry.scale(0.5, 0.6, 0.5);
  }
  const mesh_ear_back_3 = new THREE.Mesh(
    mesh_ear_back_3Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_back_3.name = "EarBack";
  if (endpoint_ear_back_3) {
    mesh_ear_back_3.position.copy(endpoint_ear_back_3.midpoint);
    mesh_ear_back_3.quaternion.copy(endpoint_ear_back_3.quaternion);
  }
  mesh_ear_back_3.castShadow = options.castShadow ?? true;
  mesh_ear_back_3.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_back_3.userData.sculptComponent = {"id": "ear-back", "name": "EarBack", "level": "macro", "role": "ear", "importance": 0.8, "confidence": 0.9, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.6, "depth": 0.5, "units": "world", "confidence": 0.9}, "transform": {"position": [-1.0, 2.05, 0.42], "rotation": [0, 0, 0], "scale": [0.5, 0.6, 0.5]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Second triangular ear on roof rear-right", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ear-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_ear_back_3.add(mesh_ear_back_3);
  meshes["ear-back"] = mesh_ear_back_3;
  colliders["ear-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["ear-back"] ??= [];
  destructionGroups["ear-back"].push(node_ear_back_3);

  const endpoint_eye_4 = makeAttachmentEndpoint(null);
  const node_eye_4 = new THREE.Group();
  node_eye_4.name = "Eye__pivot";
  node_eye_4.scale.set(1, 1, 1);
  if (endpoint_eye_4) {
    node_eye_4.position.copy(endpoint_eye_4.start);
    node_eye_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_4.position.set(-1.51, 1.1, 0.32);
    node_eye_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_4.userData.sculptComponent = {"id": "eye", "name": "Eye", "level": "meso", "role": "eye", "importance": 0.9, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.52, "depth": 0.3, "units": "world", "confidence": 0.9}, "transform": {"position": [-1.51, 1.1, 0.32], "rotation": [0, 0, 0], "scale": [0.1, 0.52, 0.3]}, "material": "eye-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Large vertical yellow cat eye on front face", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 32, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_eye_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_eye_4);
  nodes["eye"] = node_eye_4;
  const mesh_eye_4Geometry = endpoint_eye_4
    ? new THREE.CylinderGeometry(endpoint_eye_4.endRadius, endpoint_eye_4.baseRadius, endpoint_eye_4.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_eye_4) {
    mesh_eye_4Geometry.scale(0.1, 0.52, 0.3);
  }
  const mesh_eye_4 = new THREE.Mesh(
    mesh_eye_4Geometry,
    materialMap["eye-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_4.name = "Eye";
  if (endpoint_eye_4) {
    mesh_eye_4.position.copy(endpoint_eye_4.midpoint);
    mesh_eye_4.quaternion.copy(endpoint_eye_4.quaternion);
  }
  mesh_eye_4.castShadow = options.castShadow ?? true;
  mesh_eye_4.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_4.userData.sculptComponent = {"id": "eye", "name": "Eye", "level": "meso", "role": "eye", "importance": 0.9, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.52, "depth": 0.3, "units": "world", "confidence": 0.9}, "transform": {"position": [-1.51, 1.1, 0.32], "rotation": [0, 0, 0], "scale": [0.1, 0.52, 0.3]}, "material": "eye-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Large vertical yellow cat eye on front face", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 32, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_eye_4.add(mesh_eye_4);
  meshes["eye"] = mesh_eye_4;
  colliders["eye"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["eye"] ??= [];
  destructionGroups["eye"].push(node_eye_4);

  const endpoint_eye_pupil_5 = makeAttachmentEndpoint(null);
  const node_eye_pupil_5 = new THREE.Group();
  node_eye_pupil_5.name = "EyePupil__pivot";
  node_eye_pupil_5.scale.set(1, 1, 1);
  if (endpoint_eye_pupil_5) {
    node_eye_pupil_5.position.copy(endpoint_eye_pupil_5.start);
    node_eye_pupil_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_pupil_5.position.set(-0.06, 0.0, 0.0);
    node_eye_pupil_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_pupil_5.userData.sculptComponent = {"id": "eye-pupil", "name": "EyePupil", "level": "meso", "role": "pupil", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "eye", "attachment": {"parentId": "eye", "parentSocket": "eye-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.4, "depth": 0.06, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.06, 0, 0], "rotation": [0, 0, 0], "scale": [0.02, 0.4, 0.06]}, "material": "eye-pupil-black", "evidenceRefs": ["full-object"], "topologyRationale": "Vertical slit pupil centered in the yellow eye", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 10, 12, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye-pupil", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_eye_pupil_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye-pupil", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["eye"] ?? root).add(node_eye_pupil_5);
  nodes["eye-pupil"] = node_eye_pupil_5;
  const mesh_eye_pupil_5Geometry = endpoint_eye_pupil_5
    ? new THREE.CylinderGeometry(endpoint_eye_pupil_5.endRadius, endpoint_eye_pupil_5.baseRadius, endpoint_eye_pupil_5.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_eye_pupil_5) {
    mesh_eye_pupil_5Geometry.scale(0.02, 0.4, 0.06);
  }
  const mesh_eye_pupil_5 = new THREE.Mesh(
    mesh_eye_pupil_5Geometry,
    materialMap["eye-pupil-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_pupil_5.name = "EyePupil";
  if (endpoint_eye_pupil_5) {
    mesh_eye_pupil_5.position.copy(endpoint_eye_pupil_5.midpoint);
    mesh_eye_pupil_5.quaternion.copy(endpoint_eye_pupil_5.quaternion);
  }
  mesh_eye_pupil_5.castShadow = options.castShadow ?? true;
  mesh_eye_pupil_5.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_pupil_5.userData.sculptComponent = {"id": "eye-pupil", "name": "EyePupil", "level": "meso", "role": "pupil", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "eye", "attachment": {"parentId": "eye", "parentSocket": "eye-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.4, "depth": 0.06, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.06, 0, 0], "rotation": [0, 0, 0], "scale": [0.02, 0.4, 0.06]}, "material": "eye-pupil-black", "evidenceRefs": ["full-object"], "topologyRationale": "Vertical slit pupil centered in the yellow eye", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 10, 12, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye-pupil", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_eye_pupil_5.add(mesh_eye_pupil_5);
  meshes["eye-pupil"] = mesh_eye_pupil_5;
  colliders["eye-pupil"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["eye-pupil"] ??= [];
  destructionGroups["eye-pupil"].push(node_eye_pupil_5);

  const endpoint_nose_6 = makeAttachmentEndpoint(null);
  const node_nose_6 = new THREE.Group();
  node_nose_6.name = "Nose__pivot";
  node_nose_6.scale.set(1, 1, 1);
  if (endpoint_nose_6) {
    node_nose_6.position.copy(endpoint_nose_6.start);
    node_nose_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nose_6.position.set(-1.52, 0.78, 0.0);
    node_nose_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_nose_6.userData.sculptComponent = {"id": "nose", "name": "Nose", "level": "meso", "role": "nose", "importance": 0.6, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.1, "depth": 0.14, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.52, 0.78, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.1, 0.14]}, "material": "eye-pupil-black", "evidenceRefs": ["full-object"], "topologyRationale": "Small dark nose triangle on front face below eye", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 10, 12, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_nose_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_nose_6);
  nodes["nose"] = node_nose_6;
  const mesh_nose_6Geometry = endpoint_nose_6
    ? new THREE.CylinderGeometry(endpoint_nose_6.endRadius, endpoint_nose_6.baseRadius, endpoint_nose_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_nose_6) {
    mesh_nose_6Geometry.scale(0.06, 0.1, 0.14);
  }
  const mesh_nose_6 = new THREE.Mesh(
    mesh_nose_6Geometry,
    materialMap["eye-pupil-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_6.name = "Nose";
  if (endpoint_nose_6) {
    mesh_nose_6.position.copy(endpoint_nose_6.midpoint);
    mesh_nose_6.quaternion.copy(endpoint_nose_6.quaternion);
  }
  mesh_nose_6.castShadow = options.castShadow ?? true;
  mesh_nose_6.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_6.userData.sculptComponent = {"id": "nose", "name": "Nose", "level": "meso", "role": "nose", "importance": 0.6, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.06, "height": 0.1, "depth": 0.14, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.52, 0.78, 0], "rotation": [0, 0, 0], "scale": [0.06, 0.1, 0.14]}, "material": "eye-pupil-black", "evidenceRefs": ["full-object"], "topologyRationale": "Small dark nose triangle on front face below eye", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 10, 12, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_nose_6.add(mesh_nose_6);
  meshes["nose"] = mesh_nose_6;
  colliders["nose"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["nose"] ??= [];
  destructionGroups["nose"].push(node_nose_6);

  const endpoint_whisker_left_1_7 = makeAttachmentEndpoint(null);
  const node_whisker_left_1_7 = new THREE.Group();
  node_whisker_left_1_7.name = "WhiskerLeft1__pivot";
  node_whisker_left_1_7.scale.set(1, 1, 1);
  if (endpoint_whisker_left_1_7) {
    node_whisker_left_1_7.position.copy(endpoint_whisker_left_1_7.start);
    node_whisker_left_1_7.rotation.set(0.0, -0.13963, -0.10472);
  } else {
    node_whisker_left_1_7.position.set(-1.45, 0.83, -0.33);
    node_whisker_left_1_7.rotation.set(0.0, -0.13963, -0.10472);
  }
  node_whisker_left_1_7.userData.sculptComponent = {"id": "whisker-left-1", "name": "WhiskerLeft1", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.83, -0.33], "rotation": [0, -0.13963, -0.10472], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-left-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_left_1_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-left-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_whisker_left_1_7);
  nodes["whisker-left-1"] = node_whisker_left_1_7;
  const mesh_whisker_left_1_7Geometry = endpoint_whisker_left_1_7
    ? new THREE.CylinderGeometry(endpoint_whisker_left_1_7.endRadius, endpoint_whisker_left_1_7.baseRadius, endpoint_whisker_left_1_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_whisker_left_1_7) {
    mesh_whisker_left_1_7Geometry.scale(0.02, 0.02, 0.4);
  }
  const mesh_whisker_left_1_7 = new THREE.Mesh(
    mesh_whisker_left_1_7Geometry,
    materialMap["whisker-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_whisker_left_1_7.name = "WhiskerLeft1";
  if (endpoint_whisker_left_1_7) {
    mesh_whisker_left_1_7.position.copy(endpoint_whisker_left_1_7.midpoint);
    mesh_whisker_left_1_7.quaternion.copy(endpoint_whisker_left_1_7.quaternion);
  }
  mesh_whisker_left_1_7.castShadow = options.castShadow ?? true;
  mesh_whisker_left_1_7.receiveShadow = options.receiveShadow ?? true;
  mesh_whisker_left_1_7.userData.sculptComponent = {"id": "whisker-left-1", "name": "WhiskerLeft1", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.83, -0.33], "rotation": [0, -0.13963, -0.10472], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-left-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_left_1_7.add(mesh_whisker_left_1_7);
  meshes["whisker-left-1"] = mesh_whisker_left_1_7;
  colliders["whisker-left-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["whisker-left-1"] ??= [];
  destructionGroups["whisker-left-1"].push(node_whisker_left_1_7);

  const endpoint_whisker_left_2_8 = makeAttachmentEndpoint(null);
  const node_whisker_left_2_8 = new THREE.Group();
  node_whisker_left_2_8.name = "WhiskerLeft2__pivot";
  node_whisker_left_2_8.scale.set(1, 1, 1);
  if (endpoint_whisker_left_2_8) {
    node_whisker_left_2_8.position.copy(endpoint_whisker_left_2_8.start);
    node_whisker_left_2_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_whisker_left_2_8.position.set(-1.45, 0.85, -0.28);
    node_whisker_left_2_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_whisker_left_2_8.userData.sculptComponent = {"id": "whisker-left-2", "name": "WhiskerLeft2", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.85, -0.28], "rotation": [0, 0.0, 0.0], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-left-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_left_2_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-left-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_whisker_left_2_8);
  nodes["whisker-left-2"] = node_whisker_left_2_8;
  const mesh_whisker_left_2_8Geometry = endpoint_whisker_left_2_8
    ? new THREE.CylinderGeometry(endpoint_whisker_left_2_8.endRadius, endpoint_whisker_left_2_8.baseRadius, endpoint_whisker_left_2_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_whisker_left_2_8) {
    mesh_whisker_left_2_8Geometry.scale(0.02, 0.02, 0.4);
  }
  const mesh_whisker_left_2_8 = new THREE.Mesh(
    mesh_whisker_left_2_8Geometry,
    materialMap["whisker-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_whisker_left_2_8.name = "WhiskerLeft2";
  if (endpoint_whisker_left_2_8) {
    mesh_whisker_left_2_8.position.copy(endpoint_whisker_left_2_8.midpoint);
    mesh_whisker_left_2_8.quaternion.copy(endpoint_whisker_left_2_8.quaternion);
  }
  mesh_whisker_left_2_8.castShadow = options.castShadow ?? true;
  mesh_whisker_left_2_8.receiveShadow = options.receiveShadow ?? true;
  mesh_whisker_left_2_8.userData.sculptComponent = {"id": "whisker-left-2", "name": "WhiskerLeft2", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.85, -0.28], "rotation": [0, 0.0, 0.0], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-left-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_left_2_8.add(mesh_whisker_left_2_8);
  meshes["whisker-left-2"] = mesh_whisker_left_2_8;
  colliders["whisker-left-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["whisker-left-2"] ??= [];
  destructionGroups["whisker-left-2"].push(node_whisker_left_2_8);

  const endpoint_whisker_left_3_9 = makeAttachmentEndpoint(null);
  const node_whisker_left_3_9 = new THREE.Group();
  node_whisker_left_3_9.name = "WhiskerLeft3__pivot";
  node_whisker_left_3_9.scale.set(1, 1, 1);
  if (endpoint_whisker_left_3_9) {
    node_whisker_left_3_9.position.copy(endpoint_whisker_left_3_9.start);
    node_whisker_left_3_9.rotation.set(0.0, 0.13963, 0.10472);
  } else {
    node_whisker_left_3_9.position.set(-1.45, 0.87, -0.23000000000000004);
    node_whisker_left_3_9.rotation.set(0.0, 0.13963, 0.10472);
  }
  node_whisker_left_3_9.userData.sculptComponent = {"id": "whisker-left-3", "name": "WhiskerLeft3", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.87, -0.23000000000000004], "rotation": [0, 0.13963, 0.10472], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-left-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_left_3_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-left-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_whisker_left_3_9);
  nodes["whisker-left-3"] = node_whisker_left_3_9;
  const mesh_whisker_left_3_9Geometry = endpoint_whisker_left_3_9
    ? new THREE.CylinderGeometry(endpoint_whisker_left_3_9.endRadius, endpoint_whisker_left_3_9.baseRadius, endpoint_whisker_left_3_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_whisker_left_3_9) {
    mesh_whisker_left_3_9Geometry.scale(0.02, 0.02, 0.4);
  }
  const mesh_whisker_left_3_9 = new THREE.Mesh(
    mesh_whisker_left_3_9Geometry,
    materialMap["whisker-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_whisker_left_3_9.name = "WhiskerLeft3";
  if (endpoint_whisker_left_3_9) {
    mesh_whisker_left_3_9.position.copy(endpoint_whisker_left_3_9.midpoint);
    mesh_whisker_left_3_9.quaternion.copy(endpoint_whisker_left_3_9.quaternion);
  }
  mesh_whisker_left_3_9.castShadow = options.castShadow ?? true;
  mesh_whisker_left_3_9.receiveShadow = options.receiveShadow ?? true;
  mesh_whisker_left_3_9.userData.sculptComponent = {"id": "whisker-left-3", "name": "WhiskerLeft3", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.87, -0.23000000000000004], "rotation": [0, 0.13963, 0.10472], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-left-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_left_3_9.add(mesh_whisker_left_3_9);
  meshes["whisker-left-3"] = mesh_whisker_left_3_9;
  colliders["whisker-left-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["whisker-left-3"] ??= [];
  destructionGroups["whisker-left-3"].push(node_whisker_left_3_9);

  const endpoint_whisker_right_1_10 = makeAttachmentEndpoint(null);
  const node_whisker_right_1_10 = new THREE.Group();
  node_whisker_right_1_10.name = "WhiskerRight1__pivot";
  node_whisker_right_1_10.scale.set(1, 1, 1);
  if (endpoint_whisker_right_1_10) {
    node_whisker_right_1_10.position.copy(endpoint_whisker_right_1_10.start);
    node_whisker_right_1_10.rotation.set(0.0, -0.13963, -0.10472);
  } else {
    node_whisker_right_1_10.position.set(-1.45, 0.83, 0.23000000000000004);
    node_whisker_right_1_10.rotation.set(0.0, -0.13963, -0.10472);
  }
  node_whisker_right_1_10.userData.sculptComponent = {"id": "whisker-right-1", "name": "WhiskerRight1", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.83, 0.23000000000000004], "rotation": [0, -0.13963, -0.10472], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-right-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_right_1_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-right-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_whisker_right_1_10);
  nodes["whisker-right-1"] = node_whisker_right_1_10;
  const mesh_whisker_right_1_10Geometry = endpoint_whisker_right_1_10
    ? new THREE.CylinderGeometry(endpoint_whisker_right_1_10.endRadius, endpoint_whisker_right_1_10.baseRadius, endpoint_whisker_right_1_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_whisker_right_1_10) {
    mesh_whisker_right_1_10Geometry.scale(0.02, 0.02, 0.4);
  }
  const mesh_whisker_right_1_10 = new THREE.Mesh(
    mesh_whisker_right_1_10Geometry,
    materialMap["whisker-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_whisker_right_1_10.name = "WhiskerRight1";
  if (endpoint_whisker_right_1_10) {
    mesh_whisker_right_1_10.position.copy(endpoint_whisker_right_1_10.midpoint);
    mesh_whisker_right_1_10.quaternion.copy(endpoint_whisker_right_1_10.quaternion);
  }
  mesh_whisker_right_1_10.castShadow = options.castShadow ?? true;
  mesh_whisker_right_1_10.receiveShadow = options.receiveShadow ?? true;
  mesh_whisker_right_1_10.userData.sculptComponent = {"id": "whisker-right-1", "name": "WhiskerRight1", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.83, 0.23000000000000004], "rotation": [0, -0.13963, -0.10472], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-right-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_right_1_10.add(mesh_whisker_right_1_10);
  meshes["whisker-right-1"] = mesh_whisker_right_1_10;
  colliders["whisker-right-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["whisker-right-1"] ??= [];
  destructionGroups["whisker-right-1"].push(node_whisker_right_1_10);

  const endpoint_whisker_right_2_11 = makeAttachmentEndpoint(null);
  const node_whisker_right_2_11 = new THREE.Group();
  node_whisker_right_2_11.name = "WhiskerRight2__pivot";
  node_whisker_right_2_11.scale.set(1, 1, 1);
  if (endpoint_whisker_right_2_11) {
    node_whisker_right_2_11.position.copy(endpoint_whisker_right_2_11.start);
    node_whisker_right_2_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_whisker_right_2_11.position.set(-1.45, 0.85, 0.28);
    node_whisker_right_2_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_whisker_right_2_11.userData.sculptComponent = {"id": "whisker-right-2", "name": "WhiskerRight2", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.85, 0.28], "rotation": [0, 0.0, 0.0], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-right-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_right_2_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-right-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_whisker_right_2_11);
  nodes["whisker-right-2"] = node_whisker_right_2_11;
  const mesh_whisker_right_2_11Geometry = endpoint_whisker_right_2_11
    ? new THREE.CylinderGeometry(endpoint_whisker_right_2_11.endRadius, endpoint_whisker_right_2_11.baseRadius, endpoint_whisker_right_2_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_whisker_right_2_11) {
    mesh_whisker_right_2_11Geometry.scale(0.02, 0.02, 0.4);
  }
  const mesh_whisker_right_2_11 = new THREE.Mesh(
    mesh_whisker_right_2_11Geometry,
    materialMap["whisker-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_whisker_right_2_11.name = "WhiskerRight2";
  if (endpoint_whisker_right_2_11) {
    mesh_whisker_right_2_11.position.copy(endpoint_whisker_right_2_11.midpoint);
    mesh_whisker_right_2_11.quaternion.copy(endpoint_whisker_right_2_11.quaternion);
  }
  mesh_whisker_right_2_11.castShadow = options.castShadow ?? true;
  mesh_whisker_right_2_11.receiveShadow = options.receiveShadow ?? true;
  mesh_whisker_right_2_11.userData.sculptComponent = {"id": "whisker-right-2", "name": "WhiskerRight2", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.85, 0.28], "rotation": [0, 0.0, 0.0], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-right-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_right_2_11.add(mesh_whisker_right_2_11);
  meshes["whisker-right-2"] = mesh_whisker_right_2_11;
  colliders["whisker-right-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["whisker-right-2"] ??= [];
  destructionGroups["whisker-right-2"].push(node_whisker_right_2_11);

  const endpoint_whisker_right_3_12 = makeAttachmentEndpoint(null);
  const node_whisker_right_3_12 = new THREE.Group();
  node_whisker_right_3_12.name = "WhiskerRight3__pivot";
  node_whisker_right_3_12.scale.set(1, 1, 1);
  if (endpoint_whisker_right_3_12) {
    node_whisker_right_3_12.position.copy(endpoint_whisker_right_3_12.start);
    node_whisker_right_3_12.rotation.set(0.0, 0.13963, 0.10472);
  } else {
    node_whisker_right_3_12.position.set(-1.45, 0.87, 0.33);
    node_whisker_right_3_12.rotation.set(0.0, 0.13963, 0.10472);
  }
  node_whisker_right_3_12.userData.sculptComponent = {"id": "whisker-right-3", "name": "WhiskerRight3", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.87, 0.33], "rotation": [0, 0.13963, 0.10472], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-right-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_right_3_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-right-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_whisker_right_3_12);
  nodes["whisker-right-3"] = node_whisker_right_3_12;
  const mesh_whisker_right_3_12Geometry = endpoint_whisker_right_3_12
    ? new THREE.CylinderGeometry(endpoint_whisker_right_3_12.endRadius, endpoint_whisker_right_3_12.baseRadius, endpoint_whisker_right_3_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_whisker_right_3_12) {
    mesh_whisker_right_3_12Geometry.scale(0.02, 0.02, 0.4);
  }
  const mesh_whisker_right_3_12 = new THREE.Mesh(
    mesh_whisker_right_3_12Geometry,
    materialMap["whisker-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_whisker_right_3_12.name = "WhiskerRight3";
  if (endpoint_whisker_right_3_12) {
    mesh_whisker_right_3_12.position.copy(endpoint_whisker_right_3_12.midpoint);
    mesh_whisker_right_3_12.quaternion.copy(endpoint_whisker_right_3_12.quaternion);
  }
  mesh_whisker_right_3_12.castShadow = options.castShadow ?? true;
  mesh_whisker_right_3_12.receiveShadow = options.receiveShadow ?? true;
  mesh_whisker_right_3_12.userData.sculptComponent = {"id": "whisker-right-3", "name": "WhiskerRight3", "level": "meso", "role": "whisker", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.02, "depth": 0.4, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.45, 0.87, 0.33], "rotation": [0, 0.13963, 0.10472], "scale": [0.02, 0.02, 0.4]}, "material": "whisker-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Thin whisker line radiating from muzzle", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.8, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "whisker-right-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_whisker_right_3_12.add(mesh_whisker_right_3_12);
  meshes["whisker-right-3"] = mesh_whisker_right_3_12;
  colliders["whisker-right-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["whisker-right-3"] ??= [];
  destructionGroups["whisker-right-3"].push(node_whisker_right_3_12);

  const endpoint_window_system_13 = makeAttachmentEndpoint(null);
  const node_window_system_13 = new THREE.Group();
  node_window_system_13.name = "WindowSystem__pivot";
  node_window_system_13.scale.set(1, 1, 1);
  if (endpoint_window_system_13) {
    node_window_system_13.position.copy(endpoint_window_system_13.start);
    node_window_system_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_system_13.position.set(0.0, 1.2, 0.0);
    node_window_system_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_system_13.userData.sculptComponent = {"id": "window-system", "name": "WindowSystem", "level": "meso", "role": "window-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.2, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "WindowSystem solid geometry attached to cat-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_system_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_window_system_13);
  nodes["window-system"] = node_window_system_13;
  const mesh_window_system_13Geometry = endpoint_window_system_13
    ? new THREE.CylinderGeometry(endpoint_window_system_13.endRadius, endpoint_window_system_13.baseRadius, endpoint_window_system_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_system_13) {
    mesh_window_system_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_system_13 = new THREE.Mesh(
    mesh_window_system_13Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_system_13.name = "WindowSystem";
  if (endpoint_window_system_13) {
    mesh_window_system_13.position.copy(endpoint_window_system_13.midpoint);
    mesh_window_system_13.quaternion.copy(endpoint_window_system_13.quaternion);
  }
  mesh_window_system_13.castShadow = options.castShadow ?? true;
  mesh_window_system_13.receiveShadow = options.receiveShadow ?? true;
  mesh_window_system_13.visible = false; // 容器节点不渲染
  mesh_window_system_13.userData.sculptComponent = {"id": "window-system", "name": "WindowSystem", "level": "meso", "role": "window-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.2, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "WindowSystem solid geometry attached to cat-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_system_13.add(mesh_window_system_13);
  meshes["window-system"] = mesh_window_system_13;
  colliders["window-system"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-system"] ??= [];
  destructionGroups["window-system"].push(node_window_system_13);

  const endpoint_window_01_14 = makeAttachmentEndpoint(null);
  const node_window_01_14 = new THREE.Group();
  node_window_01_14.name = "Window01__pivot";
  node_window_01_14.scale.set(1, 1, 1);
  if (endpoint_window_01_14) {
    node_window_01_14.position.copy(endpoint_window_01_14.start);
    node_window_01_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_14.position.set(-1.1, 0.0, 0.71);
    node_window_01_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_14.userData.sculptComponent = {"id": "window-01", "name": "Window01", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.1, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_01_14);
  nodes["window-01"] = node_window_01_14;
  const mesh_window_01_14Geometry = endpoint_window_01_14
    ? new THREE.CylinderGeometry(endpoint_window_01_14.endRadius, endpoint_window_01_14.baseRadius, endpoint_window_01_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_14) {
    mesh_window_01_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_01_14 = new THREE.Mesh(
    mesh_window_01_14Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_14.name = "Window01";
  if (endpoint_window_01_14) {
    mesh_window_01_14.position.copy(endpoint_window_01_14.midpoint);
    mesh_window_01_14.quaternion.copy(endpoint_window_01_14.quaternion);
  }
  mesh_window_01_14.castShadow = options.castShadow ?? true;
  mesh_window_01_14.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_14.visible = false; // 容器节点不渲染
  mesh_window_01_14.userData.sculptComponent = {"id": "window-01", "name": "Window01", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.1, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_14.add(mesh_window_01_14);
  meshes["window-01"] = mesh_window_01_14;
  colliders["window-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01"] ??= [];
  destructionGroups["window-01"].push(node_window_01_14);

  const endpoint_window_01_frame_15 = makeAttachmentEndpoint(null);
  const node_window_01_frame_15 = new THREE.Group();
  node_window_01_frame_15.name = "Window01Frame__pivot";
  node_window_01_frame_15.scale.set(1, 1, 1);
  if (endpoint_window_01_frame_15) {
    node_window_01_frame_15.position.copy(endpoint_window_01_frame_15.start);
    node_window_01_frame_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_frame_15.position.set(0.0, 0.0, 0.0);
    node_window_01_frame_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_frame_15.userData.sculptComponent = {"id": "window-01-frame", "name": "Window01Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_frame_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_01_frame_15);
  nodes["window-01-frame"] = node_window_01_frame_15;
  const mesh_window_01_frame_15Geometry = endpoint_window_01_frame_15
    ? new THREE.CylinderGeometry(endpoint_window_01_frame_15.endRadius, endpoint_window_01_frame_15.baseRadius, endpoint_window_01_frame_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_frame_15) {
    mesh_window_01_frame_15Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_01_frame_15 = new THREE.Mesh(
    mesh_window_01_frame_15Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_frame_15.name = "Window01Frame";
  if (endpoint_window_01_frame_15) {
    mesh_window_01_frame_15.position.copy(endpoint_window_01_frame_15.midpoint);
    mesh_window_01_frame_15.quaternion.copy(endpoint_window_01_frame_15.quaternion);
  }
  mesh_window_01_frame_15.castShadow = options.castShadow ?? true;
  mesh_window_01_frame_15.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_frame_15.userData.sculptComponent = {"id": "window-01-frame", "name": "Window01Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_frame_15.add(mesh_window_01_frame_15);
  meshes["window-01-frame"] = mesh_window_01_frame_15;
  colliders["window-01-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-frame"] ??= [];
  destructionGroups["window-01-frame"].push(node_window_01_frame_15);

  const endpoint_window_01_glass_16 = makeAttachmentEndpoint(null);
  const node_window_01_glass_16 = new THREE.Group();
  node_window_01_glass_16.name = "Window01Glass__pivot";
  node_window_01_glass_16.scale.set(1, 1, 1);
  if (endpoint_window_01_glass_16) {
    node_window_01_glass_16.position.copy(endpoint_window_01_glass_16.start);
    node_window_01_glass_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_glass_16.position.set(0.0, 0.0, 0.032);
    node_window_01_glass_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_glass_16.userData.sculptComponent = {"id": "window-01-glass", "name": "Window01Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glass_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_01_glass_16);
  nodes["window-01-glass"] = node_window_01_glass_16;
  const mesh_window_01_glass_16Geometry = endpoint_window_01_glass_16
    ? new THREE.CylinderGeometry(endpoint_window_01_glass_16.endRadius, endpoint_window_01_glass_16.baseRadius, endpoint_window_01_glass_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_glass_16) {
    mesh_window_01_glass_16Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_01_glass_16 = new THREE.Mesh(
    mesh_window_01_glass_16Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_glass_16.name = "Window01Glass";
  if (endpoint_window_01_glass_16) {
    mesh_window_01_glass_16.position.copy(endpoint_window_01_glass_16.midpoint);
    mesh_window_01_glass_16.quaternion.copy(endpoint_window_01_glass_16.quaternion);
  }
  mesh_window_01_glass_16.castShadow = options.castShadow ?? true;
  mesh_window_01_glass_16.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_glass_16.userData.sculptComponent = {"id": "window-01-glass", "name": "Window01Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glass_16.add(mesh_window_01_glass_16);
  meshes["window-01-glass"] = mesh_window_01_glass_16;
  colliders["window-01-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-glass"] ??= [];
  destructionGroups["window-01-glass"].push(node_window_01_glass_16);

  const endpoint_window_02_17 = makeAttachmentEndpoint(null);
  const node_window_02_17 = new THREE.Group();
  node_window_02_17.name = "Window02__pivot";
  node_window_02_17.scale.set(1, 1, 1);
  if (endpoint_window_02_17) {
    node_window_02_17.position.copy(endpoint_window_02_17.start);
    node_window_02_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_17.position.set(-0.6600000000000001, 0.0, 0.71);
    node_window_02_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_17.userData.sculptComponent = {"id": "window-02", "name": "Window02", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.6600000000000001, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_02_17);
  nodes["window-02"] = node_window_02_17;
  const mesh_window_02_17Geometry = endpoint_window_02_17
    ? new THREE.CylinderGeometry(endpoint_window_02_17.endRadius, endpoint_window_02_17.baseRadius, endpoint_window_02_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_17) {
    mesh_window_02_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_02_17 = new THREE.Mesh(
    mesh_window_02_17Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_17.name = "Window02";
  if (endpoint_window_02_17) {
    mesh_window_02_17.position.copy(endpoint_window_02_17.midpoint);
    mesh_window_02_17.quaternion.copy(endpoint_window_02_17.quaternion);
  }
  mesh_window_02_17.castShadow = options.castShadow ?? true;
  mesh_window_02_17.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_17.visible = false; // 容器节点不渲染
  mesh_window_02_17.userData.sculptComponent = {"id": "window-02", "name": "Window02", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.6600000000000001, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_17.add(mesh_window_02_17);
  meshes["window-02"] = mesh_window_02_17;
  colliders["window-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02"] ??= [];
  destructionGroups["window-02"].push(node_window_02_17);

  const endpoint_window_02_frame_18 = makeAttachmentEndpoint(null);
  const node_window_02_frame_18 = new THREE.Group();
  node_window_02_frame_18.name = "Window02Frame__pivot";
  node_window_02_frame_18.scale.set(1, 1, 1);
  if (endpoint_window_02_frame_18) {
    node_window_02_frame_18.position.copy(endpoint_window_02_frame_18.start);
    node_window_02_frame_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_frame_18.position.set(0.0, 0.0, 0.0);
    node_window_02_frame_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_frame_18.userData.sculptComponent = {"id": "window-02-frame", "name": "Window02Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_frame_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_frame_18);
  nodes["window-02-frame"] = node_window_02_frame_18;
  const mesh_window_02_frame_18Geometry = endpoint_window_02_frame_18
    ? new THREE.CylinderGeometry(endpoint_window_02_frame_18.endRadius, endpoint_window_02_frame_18.baseRadius, endpoint_window_02_frame_18.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_frame_18) {
    mesh_window_02_frame_18Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_02_frame_18 = new THREE.Mesh(
    mesh_window_02_frame_18Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_frame_18.name = "Window02Frame";
  if (endpoint_window_02_frame_18) {
    mesh_window_02_frame_18.position.copy(endpoint_window_02_frame_18.midpoint);
    mesh_window_02_frame_18.quaternion.copy(endpoint_window_02_frame_18.quaternion);
  }
  mesh_window_02_frame_18.castShadow = options.castShadow ?? true;
  mesh_window_02_frame_18.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_frame_18.userData.sculptComponent = {"id": "window-02-frame", "name": "Window02Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_frame_18.add(mesh_window_02_frame_18);
  meshes["window-02-frame"] = mesh_window_02_frame_18;
  colliders["window-02-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-frame"] ??= [];
  destructionGroups["window-02-frame"].push(node_window_02_frame_18);

  const endpoint_window_02_glass_19 = makeAttachmentEndpoint(null);
  const node_window_02_glass_19 = new THREE.Group();
  node_window_02_glass_19.name = "Window02Glass__pivot";
  node_window_02_glass_19.scale.set(1, 1, 1);
  if (endpoint_window_02_glass_19) {
    node_window_02_glass_19.position.copy(endpoint_window_02_glass_19.start);
    node_window_02_glass_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_glass_19.position.set(0.0, 0.0, 0.032);
    node_window_02_glass_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_glass_19.userData.sculptComponent = {"id": "window-02-glass", "name": "Window02Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glass_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_glass_19);
  nodes["window-02-glass"] = node_window_02_glass_19;
  const mesh_window_02_glass_19Geometry = endpoint_window_02_glass_19
    ? new THREE.CylinderGeometry(endpoint_window_02_glass_19.endRadius, endpoint_window_02_glass_19.baseRadius, endpoint_window_02_glass_19.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_glass_19) {
    mesh_window_02_glass_19Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_02_glass_19 = new THREE.Mesh(
    mesh_window_02_glass_19Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_glass_19.name = "Window02Glass";
  if (endpoint_window_02_glass_19) {
    mesh_window_02_glass_19.position.copy(endpoint_window_02_glass_19.midpoint);
    mesh_window_02_glass_19.quaternion.copy(endpoint_window_02_glass_19.quaternion);
  }
  mesh_window_02_glass_19.castShadow = options.castShadow ?? true;
  mesh_window_02_glass_19.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_glass_19.userData.sculptComponent = {"id": "window-02-glass", "name": "Window02Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glass_19.add(mesh_window_02_glass_19);
  meshes["window-02-glass"] = mesh_window_02_glass_19;
  colliders["window-02-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-glass"] ??= [];
  destructionGroups["window-02-glass"].push(node_window_02_glass_19);

  const endpoint_window_03_20 = makeAttachmentEndpoint(null);
  const node_window_03_20 = new THREE.Group();
  node_window_03_20.name = "Window03__pivot";
  node_window_03_20.scale.set(1, 1, 1);
  if (endpoint_window_03_20) {
    node_window_03_20.position.copy(endpoint_window_03_20.start);
    node_window_03_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_20.position.set(-0.22000000000000008, 0.0, 0.71);
    node_window_03_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_20.userData.sculptComponent = {"id": "window-03", "name": "Window03", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.22000000000000008, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_03_20);
  nodes["window-03"] = node_window_03_20;
  const mesh_window_03_20Geometry = endpoint_window_03_20
    ? new THREE.CylinderGeometry(endpoint_window_03_20.endRadius, endpoint_window_03_20.baseRadius, endpoint_window_03_20.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_20) {
    mesh_window_03_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_03_20 = new THREE.Mesh(
    mesh_window_03_20Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_20.name = "Window03";
  if (endpoint_window_03_20) {
    mesh_window_03_20.position.copy(endpoint_window_03_20.midpoint);
    mesh_window_03_20.quaternion.copy(endpoint_window_03_20.quaternion);
  }
  mesh_window_03_20.castShadow = options.castShadow ?? true;
  mesh_window_03_20.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_20.visible = false; // 容器节点不渲染
  mesh_window_03_20.userData.sculptComponent = {"id": "window-03", "name": "Window03", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.22000000000000008, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_20.add(mesh_window_03_20);
  meshes["window-03"] = mesh_window_03_20;
  colliders["window-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03"] ??= [];
  destructionGroups["window-03"].push(node_window_03_20);

  const endpoint_window_03_frame_21 = makeAttachmentEndpoint(null);
  const node_window_03_frame_21 = new THREE.Group();
  node_window_03_frame_21.name = "Window03Frame__pivot";
  node_window_03_frame_21.scale.set(1, 1, 1);
  if (endpoint_window_03_frame_21) {
    node_window_03_frame_21.position.copy(endpoint_window_03_frame_21.start);
    node_window_03_frame_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_frame_21.position.set(0.0, 0.0, 0.0);
    node_window_03_frame_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_frame_21.userData.sculptComponent = {"id": "window-03-frame", "name": "Window03Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_frame_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_frame_21);
  nodes["window-03-frame"] = node_window_03_frame_21;
  const mesh_window_03_frame_21Geometry = endpoint_window_03_frame_21
    ? new THREE.CylinderGeometry(endpoint_window_03_frame_21.endRadius, endpoint_window_03_frame_21.baseRadius, endpoint_window_03_frame_21.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_frame_21) {
    mesh_window_03_frame_21Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_03_frame_21 = new THREE.Mesh(
    mesh_window_03_frame_21Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_frame_21.name = "Window03Frame";
  if (endpoint_window_03_frame_21) {
    mesh_window_03_frame_21.position.copy(endpoint_window_03_frame_21.midpoint);
    mesh_window_03_frame_21.quaternion.copy(endpoint_window_03_frame_21.quaternion);
  }
  mesh_window_03_frame_21.castShadow = options.castShadow ?? true;
  mesh_window_03_frame_21.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_frame_21.userData.sculptComponent = {"id": "window-03-frame", "name": "Window03Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_frame_21.add(mesh_window_03_frame_21);
  meshes["window-03-frame"] = mesh_window_03_frame_21;
  colliders["window-03-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-frame"] ??= [];
  destructionGroups["window-03-frame"].push(node_window_03_frame_21);

  const endpoint_window_03_glass_22 = makeAttachmentEndpoint(null);
  const node_window_03_glass_22 = new THREE.Group();
  node_window_03_glass_22.name = "Window03Glass__pivot";
  node_window_03_glass_22.scale.set(1, 1, 1);
  if (endpoint_window_03_glass_22) {
    node_window_03_glass_22.position.copy(endpoint_window_03_glass_22.start);
    node_window_03_glass_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_glass_22.position.set(0.0, 0.0, 0.032);
    node_window_03_glass_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_glass_22.userData.sculptComponent = {"id": "window-03-glass", "name": "Window03Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glass_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_glass_22);
  nodes["window-03-glass"] = node_window_03_glass_22;
  const mesh_window_03_glass_22Geometry = endpoint_window_03_glass_22
    ? new THREE.CylinderGeometry(endpoint_window_03_glass_22.endRadius, endpoint_window_03_glass_22.baseRadius, endpoint_window_03_glass_22.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_glass_22) {
    mesh_window_03_glass_22Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_03_glass_22 = new THREE.Mesh(
    mesh_window_03_glass_22Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_glass_22.name = "Window03Glass";
  if (endpoint_window_03_glass_22) {
    mesh_window_03_glass_22.position.copy(endpoint_window_03_glass_22.midpoint);
    mesh_window_03_glass_22.quaternion.copy(endpoint_window_03_glass_22.quaternion);
  }
  mesh_window_03_glass_22.castShadow = options.castShadow ?? true;
  mesh_window_03_glass_22.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_glass_22.userData.sculptComponent = {"id": "window-03-glass", "name": "Window03Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glass_22.add(mesh_window_03_glass_22);
  meshes["window-03-glass"] = mesh_window_03_glass_22;
  colliders["window-03-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-glass"] ??= [];
  destructionGroups["window-03-glass"].push(node_window_03_glass_22);

  const endpoint_window_04_23 = makeAttachmentEndpoint(null);
  const node_window_04_23 = new THREE.Group();
  node_window_04_23.name = "Window04__pivot";
  node_window_04_23.scale.set(1, 1, 1);
  if (endpoint_window_04_23) {
    node_window_04_23.position.copy(endpoint_window_04_23.start);
    node_window_04_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_23.position.set(0.21999999999999997, 0.0, 0.71);
    node_window_04_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_23.userData.sculptComponent = {"id": "window-04", "name": "Window04", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.21999999999999997, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_04_23);
  nodes["window-04"] = node_window_04_23;
  const mesh_window_04_23Geometry = endpoint_window_04_23
    ? new THREE.CylinderGeometry(endpoint_window_04_23.endRadius, endpoint_window_04_23.baseRadius, endpoint_window_04_23.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_23) {
    mesh_window_04_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_04_23 = new THREE.Mesh(
    mesh_window_04_23Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_23.name = "Window04";
  if (endpoint_window_04_23) {
    mesh_window_04_23.position.copy(endpoint_window_04_23.midpoint);
    mesh_window_04_23.quaternion.copy(endpoint_window_04_23.quaternion);
  }
  mesh_window_04_23.castShadow = options.castShadow ?? true;
  mesh_window_04_23.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_23.visible = false; // 容器节点不渲染
  mesh_window_04_23.userData.sculptComponent = {"id": "window-04", "name": "Window04", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.21999999999999997, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_23.add(mesh_window_04_23);
  meshes["window-04"] = mesh_window_04_23;
  colliders["window-04"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04"] ??= [];
  destructionGroups["window-04"].push(node_window_04_23);

  const endpoint_window_04_frame_24 = makeAttachmentEndpoint(null);
  const node_window_04_frame_24 = new THREE.Group();
  node_window_04_frame_24.name = "Window04Frame__pivot";
  node_window_04_frame_24.scale.set(1, 1, 1);
  if (endpoint_window_04_frame_24) {
    node_window_04_frame_24.position.copy(endpoint_window_04_frame_24.start);
    node_window_04_frame_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_frame_24.position.set(0.0, 0.0, 0.0);
    node_window_04_frame_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_frame_24.userData.sculptComponent = {"id": "window-04-frame", "name": "Window04Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_frame_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04"] ?? root).add(node_window_04_frame_24);
  nodes["window-04-frame"] = node_window_04_frame_24;
  const mesh_window_04_frame_24Geometry = endpoint_window_04_frame_24
    ? new THREE.CylinderGeometry(endpoint_window_04_frame_24.endRadius, endpoint_window_04_frame_24.baseRadius, endpoint_window_04_frame_24.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_frame_24) {
    mesh_window_04_frame_24Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_04_frame_24 = new THREE.Mesh(
    mesh_window_04_frame_24Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_frame_24.name = "Window04Frame";
  if (endpoint_window_04_frame_24) {
    mesh_window_04_frame_24.position.copy(endpoint_window_04_frame_24.midpoint);
    mesh_window_04_frame_24.quaternion.copy(endpoint_window_04_frame_24.quaternion);
  }
  mesh_window_04_frame_24.castShadow = options.castShadow ?? true;
  mesh_window_04_frame_24.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_frame_24.userData.sculptComponent = {"id": "window-04-frame", "name": "Window04Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_frame_24.add(mesh_window_04_frame_24);
  meshes["window-04-frame"] = mesh_window_04_frame_24;
  colliders["window-04-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-frame"] ??= [];
  destructionGroups["window-04-frame"].push(node_window_04_frame_24);

  const endpoint_window_04_glass_25 = makeAttachmentEndpoint(null);
  const node_window_04_glass_25 = new THREE.Group();
  node_window_04_glass_25.name = "Window04Glass__pivot";
  node_window_04_glass_25.scale.set(1, 1, 1);
  if (endpoint_window_04_glass_25) {
    node_window_04_glass_25.position.copy(endpoint_window_04_glass_25.start);
    node_window_04_glass_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_glass_25.position.set(0.0, 0.0, 0.032);
    node_window_04_glass_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_glass_25.userData.sculptComponent = {"id": "window-04-glass", "name": "Window04Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glass_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04"] ?? root).add(node_window_04_glass_25);
  nodes["window-04-glass"] = node_window_04_glass_25;
  const mesh_window_04_glass_25Geometry = endpoint_window_04_glass_25
    ? new THREE.CylinderGeometry(endpoint_window_04_glass_25.endRadius, endpoint_window_04_glass_25.baseRadius, endpoint_window_04_glass_25.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_glass_25) {
    mesh_window_04_glass_25Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_04_glass_25 = new THREE.Mesh(
    mesh_window_04_glass_25Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_glass_25.name = "Window04Glass";
  if (endpoint_window_04_glass_25) {
    mesh_window_04_glass_25.position.copy(endpoint_window_04_glass_25.midpoint);
    mesh_window_04_glass_25.quaternion.copy(endpoint_window_04_glass_25.quaternion);
  }
  mesh_window_04_glass_25.castShadow = options.castShadow ?? true;
  mesh_window_04_glass_25.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_glass_25.userData.sculptComponent = {"id": "window-04-glass", "name": "Window04Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glass_25.add(mesh_window_04_glass_25);
  meshes["window-04-glass"] = mesh_window_04_glass_25;
  colliders["window-04-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-glass"] ??= [];
  destructionGroups["window-04-glass"].push(node_window_04_glass_25);

  const endpoint_window_05_26 = makeAttachmentEndpoint(null);
  const node_window_05_26 = new THREE.Group();
  node_window_05_26.name = "Window05__pivot";
  node_window_05_26.scale.set(1, 1, 1);
  if (endpoint_window_05_26) {
    node_window_05_26.position.copy(endpoint_window_05_26.start);
    node_window_05_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_05_26.position.set(0.6599999999999999, 0.0, 0.71);
    node_window_05_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_05_26.userData.sculptComponent = {"id": "window-05", "name": "Window05", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.6599999999999999, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window05 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_05_26);
  nodes["window-05"] = node_window_05_26;
  const mesh_window_05_26Geometry = endpoint_window_05_26
    ? new THREE.CylinderGeometry(endpoint_window_05_26.endRadius, endpoint_window_05_26.baseRadius, endpoint_window_05_26.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_05_26) {
    mesh_window_05_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_05_26 = new THREE.Mesh(
    mesh_window_05_26Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_05_26.name = "Window05";
  if (endpoint_window_05_26) {
    mesh_window_05_26.position.copy(endpoint_window_05_26.midpoint);
    mesh_window_05_26.quaternion.copy(endpoint_window_05_26.quaternion);
  }
  mesh_window_05_26.castShadow = options.castShadow ?? true;
  mesh_window_05_26.receiveShadow = options.receiveShadow ?? true;
  mesh_window_05_26.visible = false; // 容器节点不渲染
  mesh_window_05_26.userData.sculptComponent = {"id": "window-05", "name": "Window05", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.6599999999999999, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window05 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_26.add(mesh_window_05_26);
  meshes["window-05"] = mesh_window_05_26;
  colliders["window-05"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-05"] ??= [];
  destructionGroups["window-05"].push(node_window_05_26);

  const endpoint_window_05_frame_27 = makeAttachmentEndpoint(null);
  const node_window_05_frame_27 = new THREE.Group();
  node_window_05_frame_27.name = "Window05Frame__pivot";
  node_window_05_frame_27.scale.set(1, 1, 1);
  if (endpoint_window_05_frame_27) {
    node_window_05_frame_27.position.copy(endpoint_window_05_frame_27.start);
    node_window_05_frame_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_05_frame_27.position.set(0.0, 0.0, 0.0);
    node_window_05_frame_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_05_frame_27.userData.sculptComponent = {"id": "window-05-frame", "name": "Window05Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-05", "attachment": {"parentId": "window-05", "parentSocket": "window-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window05Frame solid geometry attached to window-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_frame_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-05"] ?? root).add(node_window_05_frame_27);
  nodes["window-05-frame"] = node_window_05_frame_27;
  const mesh_window_05_frame_27Geometry = endpoint_window_05_frame_27
    ? new THREE.CylinderGeometry(endpoint_window_05_frame_27.endRadius, endpoint_window_05_frame_27.baseRadius, endpoint_window_05_frame_27.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_05_frame_27) {
    mesh_window_05_frame_27Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_05_frame_27 = new THREE.Mesh(
    mesh_window_05_frame_27Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_05_frame_27.name = "Window05Frame";
  if (endpoint_window_05_frame_27) {
    mesh_window_05_frame_27.position.copy(endpoint_window_05_frame_27.midpoint);
    mesh_window_05_frame_27.quaternion.copy(endpoint_window_05_frame_27.quaternion);
  }
  mesh_window_05_frame_27.castShadow = options.castShadow ?? true;
  mesh_window_05_frame_27.receiveShadow = options.receiveShadow ?? true;
  mesh_window_05_frame_27.userData.sculptComponent = {"id": "window-05-frame", "name": "Window05Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-05", "attachment": {"parentId": "window-05", "parentSocket": "window-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window05Frame solid geometry attached to window-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_frame_27.add(mesh_window_05_frame_27);
  meshes["window-05-frame"] = mesh_window_05_frame_27;
  colliders["window-05-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-05-frame"] ??= [];
  destructionGroups["window-05-frame"].push(node_window_05_frame_27);

  const endpoint_window_05_glass_28 = makeAttachmentEndpoint(null);
  const node_window_05_glass_28 = new THREE.Group();
  node_window_05_glass_28.name = "Window05Glass__pivot";
  node_window_05_glass_28.scale.set(1, 1, 1);
  if (endpoint_window_05_glass_28) {
    node_window_05_glass_28.position.copy(endpoint_window_05_glass_28.start);
    node_window_05_glass_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_05_glass_28.position.set(0.0, 0.0, 0.032);
    node_window_05_glass_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_05_glass_28.userData.sculptComponent = {"id": "window-05-glass", "name": "Window05Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-05", "attachment": {"parentId": "window-05", "parentSocket": "window-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window05Glass solid geometry attached to window-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_glass_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-05"] ?? root).add(node_window_05_glass_28);
  nodes["window-05-glass"] = node_window_05_glass_28;
  const mesh_window_05_glass_28Geometry = endpoint_window_05_glass_28
    ? new THREE.CylinderGeometry(endpoint_window_05_glass_28.endRadius, endpoint_window_05_glass_28.baseRadius, endpoint_window_05_glass_28.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_05_glass_28) {
    mesh_window_05_glass_28Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_05_glass_28 = new THREE.Mesh(
    mesh_window_05_glass_28Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_05_glass_28.name = "Window05Glass";
  if (endpoint_window_05_glass_28) {
    mesh_window_05_glass_28.position.copy(endpoint_window_05_glass_28.midpoint);
    mesh_window_05_glass_28.quaternion.copy(endpoint_window_05_glass_28.quaternion);
  }
  mesh_window_05_glass_28.castShadow = options.castShadow ?? true;
  mesh_window_05_glass_28.receiveShadow = options.receiveShadow ?? true;
  mesh_window_05_glass_28.userData.sculptComponent = {"id": "window-05-glass", "name": "Window05Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-05", "attachment": {"parentId": "window-05", "parentSocket": "window-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window05Glass solid geometry attached to window-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_glass_28.add(mesh_window_05_glass_28);
  meshes["window-05-glass"] = mesh_window_05_glass_28;
  colliders["window-05-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-05-glass"] ??= [];
  destructionGroups["window-05-glass"].push(node_window_05_glass_28);

  const endpoint_window_06_29 = makeAttachmentEndpoint(null);
  const node_window_06_29 = new THREE.Group();
  node_window_06_29.name = "Window06__pivot";
  node_window_06_29.scale.set(1, 1, 1);
  if (endpoint_window_06_29) {
    node_window_06_29.position.copy(endpoint_window_06_29.start);
    node_window_06_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_06_29.position.set(1.1, 0.0, 0.71);
    node_window_06_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_06_29.userData.sculptComponent = {"id": "window-06", "name": "Window06", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.1, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window06 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_06_29);
  nodes["window-06"] = node_window_06_29;
  const mesh_window_06_29Geometry = endpoint_window_06_29
    ? new THREE.CylinderGeometry(endpoint_window_06_29.endRadius, endpoint_window_06_29.baseRadius, endpoint_window_06_29.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_06_29) {
    mesh_window_06_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_06_29 = new THREE.Mesh(
    mesh_window_06_29Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_06_29.name = "Window06";
  if (endpoint_window_06_29) {
    mesh_window_06_29.position.copy(endpoint_window_06_29.midpoint);
    mesh_window_06_29.quaternion.copy(endpoint_window_06_29.quaternion);
  }
  mesh_window_06_29.castShadow = options.castShadow ?? true;
  mesh_window_06_29.receiveShadow = options.receiveShadow ?? true;
  mesh_window_06_29.visible = false; // 容器节点不渲染
  mesh_window_06_29.userData.sculptComponent = {"id": "window-06", "name": "Window06", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.1, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window06 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_29.add(mesh_window_06_29);
  meshes["window-06"] = mesh_window_06_29;
  colliders["window-06"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-06"] ??= [];
  destructionGroups["window-06"].push(node_window_06_29);

  const endpoint_window_06_frame_30 = makeAttachmentEndpoint(null);
  const node_window_06_frame_30 = new THREE.Group();
  node_window_06_frame_30.name = "Window06Frame__pivot";
  node_window_06_frame_30.scale.set(1, 1, 1);
  if (endpoint_window_06_frame_30) {
    node_window_06_frame_30.position.copy(endpoint_window_06_frame_30.start);
    node_window_06_frame_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_06_frame_30.position.set(0.0, 0.0, 0.0);
    node_window_06_frame_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_06_frame_30.userData.sculptComponent = {"id": "window-06-frame", "name": "Window06Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-06", "attachment": {"parentId": "window-06", "parentSocket": "window-06-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window06Frame solid geometry attached to window-06", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_frame_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-06"] ?? root).add(node_window_06_frame_30);
  nodes["window-06-frame"] = node_window_06_frame_30;
  const mesh_window_06_frame_30Geometry = endpoint_window_06_frame_30
    ? new THREE.CylinderGeometry(endpoint_window_06_frame_30.endRadius, endpoint_window_06_frame_30.baseRadius, endpoint_window_06_frame_30.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_06_frame_30) {
    mesh_window_06_frame_30Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_06_frame_30 = new THREE.Mesh(
    mesh_window_06_frame_30Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_06_frame_30.name = "Window06Frame";
  if (endpoint_window_06_frame_30) {
    mesh_window_06_frame_30.position.copy(endpoint_window_06_frame_30.midpoint);
    mesh_window_06_frame_30.quaternion.copy(endpoint_window_06_frame_30.quaternion);
  }
  mesh_window_06_frame_30.castShadow = options.castShadow ?? true;
  mesh_window_06_frame_30.receiveShadow = options.receiveShadow ?? true;
  mesh_window_06_frame_30.userData.sculptComponent = {"id": "window-06-frame", "name": "Window06Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-06", "attachment": {"parentId": "window-06", "parentSocket": "window-06-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window06Frame solid geometry attached to window-06", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_frame_30.add(mesh_window_06_frame_30);
  meshes["window-06-frame"] = mesh_window_06_frame_30;
  colliders["window-06-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-06-frame"] ??= [];
  destructionGroups["window-06-frame"].push(node_window_06_frame_30);

  const endpoint_window_06_glass_31 = makeAttachmentEndpoint(null);
  const node_window_06_glass_31 = new THREE.Group();
  node_window_06_glass_31.name = "Window06Glass__pivot";
  node_window_06_glass_31.scale.set(1, 1, 1);
  if (endpoint_window_06_glass_31) {
    node_window_06_glass_31.position.copy(endpoint_window_06_glass_31.start);
    node_window_06_glass_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_06_glass_31.position.set(0.0, 0.0, 0.032);
    node_window_06_glass_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_06_glass_31.userData.sculptComponent = {"id": "window-06-glass", "name": "Window06Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-06", "attachment": {"parentId": "window-06", "parentSocket": "window-06-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window06Glass solid geometry attached to window-06", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_glass_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-06"] ?? root).add(node_window_06_glass_31);
  nodes["window-06-glass"] = node_window_06_glass_31;
  const mesh_window_06_glass_31Geometry = endpoint_window_06_glass_31
    ? new THREE.CylinderGeometry(endpoint_window_06_glass_31.endRadius, endpoint_window_06_glass_31.baseRadius, endpoint_window_06_glass_31.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_06_glass_31) {
    mesh_window_06_glass_31Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_06_glass_31 = new THREE.Mesh(
    mesh_window_06_glass_31Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_06_glass_31.name = "Window06Glass";
  if (endpoint_window_06_glass_31) {
    mesh_window_06_glass_31.position.copy(endpoint_window_06_glass_31.midpoint);
    mesh_window_06_glass_31.quaternion.copy(endpoint_window_06_glass_31.quaternion);
  }
  mesh_window_06_glass_31.castShadow = options.castShadow ?? true;
  mesh_window_06_glass_31.receiveShadow = options.receiveShadow ?? true;
  mesh_window_06_glass_31.userData.sculptComponent = {"id": "window-06-glass", "name": "Window06Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-06", "attachment": {"parentId": "window-06", "parentSocket": "window-06-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window06Glass solid geometry attached to window-06", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_glass_31.add(mesh_window_06_glass_31);
  meshes["window-06-glass"] = mesh_window_06_glass_31;
  colliders["window-06-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-06-glass"] ??= [];
  destructionGroups["window-06-glass"].push(node_window_06_glass_31);

  const attachment_leg_front_left_32 = {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_leg_front_left_32 = makeAttachmentEndpoint(attachment_leg_front_left_32);
  const node_leg_front_left_32 = new THREE.Group();
  node_leg_front_left_32.name = "LegFrontLeft__pivot";
  node_leg_front_left_32.scale.set(1, 1, 1);
  if (endpoint_leg_front_left_32) {
    node_leg_front_left_32.position.copy(endpoint_leg_front_left_32.start);
    node_leg_front_left_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_front_left_32.position.set(-0.95, 0.35, -0.45);
    node_leg_front_left_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_front_left_32.userData.sculptComponent = {"id": "leg-front-left", "name": "LegFrontLeft", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.6, "depth": 0.26, "units": "world", "confidence": 0.88}, "transform": {"position": [-0.95, 0.35, -0.45], "rotation": [0, 0, 0], "scale": [0.26, 0.6, 0.26]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Short tapered cat leg under body corner", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_front_left_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_leg_front_left_32);
  nodes["leg-front-left"] = node_leg_front_left_32;
  const mesh_leg_front_left_32Geometry = endpoint_leg_front_left_32
    ? new THREE.CylinderGeometry(endpoint_leg_front_left_32.endRadius, endpoint_leg_front_left_32.baseRadius, endpoint_leg_front_left_32.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_leg_front_left_32) {
    mesh_leg_front_left_32Geometry.scale(0.26, 0.6, 0.26);
  }
  const mesh_leg_front_left_32 = new THREE.Mesh(
    mesh_leg_front_left_32Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_front_left_32.name = "LegFrontLeft";
  if (endpoint_leg_front_left_32) {
    mesh_leg_front_left_32.position.copy(endpoint_leg_front_left_32.midpoint);
    mesh_leg_front_left_32.quaternion.copy(endpoint_leg_front_left_32.quaternion);
  }
  mesh_leg_front_left_32.castShadow = options.castShadow ?? true;
  mesh_leg_front_left_32.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_front_left_32.userData.sculptComponent = {"id": "leg-front-left", "name": "LegFrontLeft", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.6, "depth": 0.26, "units": "world", "confidence": 0.88}, "transform": {"position": [-0.95, 0.35, -0.45], "rotation": [0, 0, 0], "scale": [0.26, 0.6, 0.26]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Short tapered cat leg under body corner", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_front_left_32.add(mesh_leg_front_left_32);
  meshes["leg-front-left"] = mesh_leg_front_left_32;
  colliders["leg-front-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["leg-front-left"] ??= [];
  destructionGroups["leg-front-left"].push(node_leg_front_left_32);

  const endpoint_leg_front_left_paw_33 = makeAttachmentEndpoint(null);
  const node_leg_front_left_paw_33 = new THREE.Group();
  node_leg_front_left_paw_33.name = "PawFrontLeft__pivot";
  node_leg_front_left_paw_33.scale.set(1, 1, 1);
  if (endpoint_leg_front_left_paw_33) {
    node_leg_front_left_paw_33.position.copy(endpoint_leg_front_left_paw_33.start);
    node_leg_front_left_paw_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_front_left_paw_33.position.set(0.0, -0.32, 0.02);
    node_leg_front_left_paw_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_front_left_paw_33.userData.sculptComponent = {"id": "leg-front-left-paw", "name": "PawFrontLeft", "level": "meso", "role": "paw", "importance": 0.7, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "leg-front-left", "attachment": {"parentId": "leg-front-left", "parentSocket": "leg-front-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.32, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.32, 0.02], "rotation": [0, 0, 0], "scale": [0.3, 0.16, 0.32]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded paw foot at leg base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-left-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_front_left_paw_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-left-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["leg-front-left"] ?? root).add(node_leg_front_left_paw_33);
  nodes["leg-front-left-paw"] = node_leg_front_left_paw_33;
  const mesh_leg_front_left_paw_33Geometry = endpoint_leg_front_left_paw_33
    ? new THREE.CylinderGeometry(endpoint_leg_front_left_paw_33.endRadius, endpoint_leg_front_left_paw_33.baseRadius, endpoint_leg_front_left_paw_33.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_leg_front_left_paw_33) {
    mesh_leg_front_left_paw_33Geometry.scale(0.3, 0.16, 0.32);
  }
  const mesh_leg_front_left_paw_33 = new THREE.Mesh(
    mesh_leg_front_left_paw_33Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_front_left_paw_33.name = "PawFrontLeft";
  if (endpoint_leg_front_left_paw_33) {
    mesh_leg_front_left_paw_33.position.copy(endpoint_leg_front_left_paw_33.midpoint);
    mesh_leg_front_left_paw_33.quaternion.copy(endpoint_leg_front_left_paw_33.quaternion);
  }
  mesh_leg_front_left_paw_33.castShadow = options.castShadow ?? true;
  mesh_leg_front_left_paw_33.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_front_left_paw_33.userData.sculptComponent = {"id": "leg-front-left-paw", "name": "PawFrontLeft", "level": "meso", "role": "paw", "importance": 0.7, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "leg-front-left", "attachment": {"parentId": "leg-front-left", "parentSocket": "leg-front-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.32, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.32, 0.02], "rotation": [0, 0, 0], "scale": [0.3, 0.16, 0.32]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded paw foot at leg base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-left-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_front_left_paw_33.add(mesh_leg_front_left_paw_33);
  meshes["leg-front-left-paw"] = mesh_leg_front_left_paw_33;
  colliders["leg-front-left-paw"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["leg-front-left-paw"] ??= [];
  destructionGroups["leg-front-left-paw"].push(node_leg_front_left_paw_33);

  const attachment_leg_front_right_34 = {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_leg_front_right_34 = makeAttachmentEndpoint(attachment_leg_front_right_34);
  const node_leg_front_right_34 = new THREE.Group();
  node_leg_front_right_34.name = "LegFrontRight__pivot";
  node_leg_front_right_34.scale.set(1, 1, 1);
  if (endpoint_leg_front_right_34) {
    node_leg_front_right_34.position.copy(endpoint_leg_front_right_34.start);
    node_leg_front_right_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_front_right_34.position.set(-0.95, 0.35, 0.45);
    node_leg_front_right_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_front_right_34.userData.sculptComponent = {"id": "leg-front-right", "name": "LegFrontRight", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.6, "depth": 0.26, "units": "world", "confidence": 0.88}, "transform": {"position": [-0.95, 0.35, 0.45], "rotation": [0, 0, 0], "scale": [0.26, 0.6, 0.26]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Short tapered cat leg under body corner", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_front_right_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_leg_front_right_34);
  nodes["leg-front-right"] = node_leg_front_right_34;
  const mesh_leg_front_right_34Geometry = endpoint_leg_front_right_34
    ? new THREE.CylinderGeometry(endpoint_leg_front_right_34.endRadius, endpoint_leg_front_right_34.baseRadius, endpoint_leg_front_right_34.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_leg_front_right_34) {
    mesh_leg_front_right_34Geometry.scale(0.26, 0.6, 0.26);
  }
  const mesh_leg_front_right_34 = new THREE.Mesh(
    mesh_leg_front_right_34Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_front_right_34.name = "LegFrontRight";
  if (endpoint_leg_front_right_34) {
    mesh_leg_front_right_34.position.copy(endpoint_leg_front_right_34.midpoint);
    mesh_leg_front_right_34.quaternion.copy(endpoint_leg_front_right_34.quaternion);
  }
  mesh_leg_front_right_34.castShadow = options.castShadow ?? true;
  mesh_leg_front_right_34.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_front_right_34.userData.sculptComponent = {"id": "leg-front-right", "name": "LegFrontRight", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.6, "depth": 0.26, "units": "world", "confidence": 0.88}, "transform": {"position": [-0.95, 0.35, 0.45], "rotation": [0, 0, 0], "scale": [0.26, 0.6, 0.26]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Short tapered cat leg under body corner", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_front_right_34.add(mesh_leg_front_right_34);
  meshes["leg-front-right"] = mesh_leg_front_right_34;
  colliders["leg-front-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["leg-front-right"] ??= [];
  destructionGroups["leg-front-right"].push(node_leg_front_right_34);

  const endpoint_leg_front_right_paw_35 = makeAttachmentEndpoint(null);
  const node_leg_front_right_paw_35 = new THREE.Group();
  node_leg_front_right_paw_35.name = "PawFrontRight__pivot";
  node_leg_front_right_paw_35.scale.set(1, 1, 1);
  if (endpoint_leg_front_right_paw_35) {
    node_leg_front_right_paw_35.position.copy(endpoint_leg_front_right_paw_35.start);
    node_leg_front_right_paw_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_front_right_paw_35.position.set(0.0, -0.32, 0.02);
    node_leg_front_right_paw_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_front_right_paw_35.userData.sculptComponent = {"id": "leg-front-right-paw", "name": "PawFrontRight", "level": "meso", "role": "paw", "importance": 0.7, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "leg-front-right", "attachment": {"parentId": "leg-front-right", "parentSocket": "leg-front-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.32, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.32, 0.02], "rotation": [0, 0, 0], "scale": [0.3, 0.16, 0.32]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded paw foot at leg base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-right-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_front_right_paw_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-right-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["leg-front-right"] ?? root).add(node_leg_front_right_paw_35);
  nodes["leg-front-right-paw"] = node_leg_front_right_paw_35;
  const mesh_leg_front_right_paw_35Geometry = endpoint_leg_front_right_paw_35
    ? new THREE.CylinderGeometry(endpoint_leg_front_right_paw_35.endRadius, endpoint_leg_front_right_paw_35.baseRadius, endpoint_leg_front_right_paw_35.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_leg_front_right_paw_35) {
    mesh_leg_front_right_paw_35Geometry.scale(0.3, 0.16, 0.32);
  }
  const mesh_leg_front_right_paw_35 = new THREE.Mesh(
    mesh_leg_front_right_paw_35Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_front_right_paw_35.name = "PawFrontRight";
  if (endpoint_leg_front_right_paw_35) {
    mesh_leg_front_right_paw_35.position.copy(endpoint_leg_front_right_paw_35.midpoint);
    mesh_leg_front_right_paw_35.quaternion.copy(endpoint_leg_front_right_paw_35.quaternion);
  }
  mesh_leg_front_right_paw_35.castShadow = options.castShadow ?? true;
  mesh_leg_front_right_paw_35.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_front_right_paw_35.userData.sculptComponent = {"id": "leg-front-right-paw", "name": "PawFrontRight", "level": "meso", "role": "paw", "importance": 0.7, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "leg-front-right", "attachment": {"parentId": "leg-front-right", "parentSocket": "leg-front-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.32, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.32, 0.02], "rotation": [0, 0, 0], "scale": [0.3, 0.16, 0.32]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded paw foot at leg base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-front-right-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_front_right_paw_35.add(mesh_leg_front_right_paw_35);
  meshes["leg-front-right-paw"] = mesh_leg_front_right_paw_35;
  colliders["leg-front-right-paw"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["leg-front-right-paw"] ??= [];
  destructionGroups["leg-front-right-paw"].push(node_leg_front_right_paw_35);

  const attachment_leg_rear_left_36 = {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_leg_rear_left_36 = makeAttachmentEndpoint(attachment_leg_rear_left_36);
  const node_leg_rear_left_36 = new THREE.Group();
  node_leg_rear_left_36.name = "LegRearLeft__pivot";
  node_leg_rear_left_36.scale.set(1, 1, 1);
  if (endpoint_leg_rear_left_36) {
    node_leg_rear_left_36.position.copy(endpoint_leg_rear_left_36.start);
    node_leg_rear_left_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_rear_left_36.position.set(0.95, 0.35, -0.45);
    node_leg_rear_left_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_rear_left_36.userData.sculptComponent = {"id": "leg-rear-left", "name": "LegRearLeft", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.6, "depth": 0.26, "units": "world", "confidence": 0.88}, "transform": {"position": [0.95, 0.35, -0.45], "rotation": [0, 0, 0], "scale": [0.26, 0.6, 0.26]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Short tapered cat leg under body corner", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_rear_left_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_leg_rear_left_36);
  nodes["leg-rear-left"] = node_leg_rear_left_36;
  const mesh_leg_rear_left_36Geometry = endpoint_leg_rear_left_36
    ? new THREE.CylinderGeometry(endpoint_leg_rear_left_36.endRadius, endpoint_leg_rear_left_36.baseRadius, endpoint_leg_rear_left_36.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_leg_rear_left_36) {
    mesh_leg_rear_left_36Geometry.scale(0.26, 0.6, 0.26);
  }
  const mesh_leg_rear_left_36 = new THREE.Mesh(
    mesh_leg_rear_left_36Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_rear_left_36.name = "LegRearLeft";
  if (endpoint_leg_rear_left_36) {
    mesh_leg_rear_left_36.position.copy(endpoint_leg_rear_left_36.midpoint);
    mesh_leg_rear_left_36.quaternion.copy(endpoint_leg_rear_left_36.quaternion);
  }
  mesh_leg_rear_left_36.castShadow = options.castShadow ?? true;
  mesh_leg_rear_left_36.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_rear_left_36.userData.sculptComponent = {"id": "leg-rear-left", "name": "LegRearLeft", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.6, "depth": 0.26, "units": "world", "confidence": 0.88}, "transform": {"position": [0.95, 0.35, -0.45], "rotation": [0, 0, 0], "scale": [0.26, 0.6, 0.26]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Short tapered cat leg under body corner", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_rear_left_36.add(mesh_leg_rear_left_36);
  meshes["leg-rear-left"] = mesh_leg_rear_left_36;
  colliders["leg-rear-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["leg-rear-left"] ??= [];
  destructionGroups["leg-rear-left"].push(node_leg_rear_left_36);

  const endpoint_leg_rear_left_paw_37 = makeAttachmentEndpoint(null);
  const node_leg_rear_left_paw_37 = new THREE.Group();
  node_leg_rear_left_paw_37.name = "PawRearLeft__pivot";
  node_leg_rear_left_paw_37.scale.set(1, 1, 1);
  if (endpoint_leg_rear_left_paw_37) {
    node_leg_rear_left_paw_37.position.copy(endpoint_leg_rear_left_paw_37.start);
    node_leg_rear_left_paw_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_rear_left_paw_37.position.set(0.0, -0.32, 0.02);
    node_leg_rear_left_paw_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_rear_left_paw_37.userData.sculptComponent = {"id": "leg-rear-left-paw", "name": "PawRearLeft", "level": "meso", "role": "paw", "importance": 0.7, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "leg-rear-left", "attachment": {"parentId": "leg-rear-left", "parentSocket": "leg-rear-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.32, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.32, 0.02], "rotation": [0, 0, 0], "scale": [0.3, 0.16, 0.32]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded paw foot at leg base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-left-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_rear_left_paw_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-left-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["leg-rear-left"] ?? root).add(node_leg_rear_left_paw_37);
  nodes["leg-rear-left-paw"] = node_leg_rear_left_paw_37;
  const mesh_leg_rear_left_paw_37Geometry = endpoint_leg_rear_left_paw_37
    ? new THREE.CylinderGeometry(endpoint_leg_rear_left_paw_37.endRadius, endpoint_leg_rear_left_paw_37.baseRadius, endpoint_leg_rear_left_paw_37.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_leg_rear_left_paw_37) {
    mesh_leg_rear_left_paw_37Geometry.scale(0.3, 0.16, 0.32);
  }
  const mesh_leg_rear_left_paw_37 = new THREE.Mesh(
    mesh_leg_rear_left_paw_37Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_rear_left_paw_37.name = "PawRearLeft";
  if (endpoint_leg_rear_left_paw_37) {
    mesh_leg_rear_left_paw_37.position.copy(endpoint_leg_rear_left_paw_37.midpoint);
    mesh_leg_rear_left_paw_37.quaternion.copy(endpoint_leg_rear_left_paw_37.quaternion);
  }
  mesh_leg_rear_left_paw_37.castShadow = options.castShadow ?? true;
  mesh_leg_rear_left_paw_37.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_rear_left_paw_37.userData.sculptComponent = {"id": "leg-rear-left-paw", "name": "PawRearLeft", "level": "meso", "role": "paw", "importance": 0.7, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "leg-rear-left", "attachment": {"parentId": "leg-rear-left", "parentSocket": "leg-rear-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.32, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.32, 0.02], "rotation": [0, 0, 0], "scale": [0.3, 0.16, 0.32]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded paw foot at leg base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-left-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_rear_left_paw_37.add(mesh_leg_rear_left_paw_37);
  meshes["leg-rear-left-paw"] = mesh_leg_rear_left_paw_37;
  colliders["leg-rear-left-paw"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["leg-rear-left-paw"] ??= [];
  destructionGroups["leg-rear-left-paw"].push(node_leg_rear_left_paw_37);

  const attachment_leg_rear_right_38 = {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_leg_rear_right_38 = makeAttachmentEndpoint(attachment_leg_rear_right_38);
  const node_leg_rear_right_38 = new THREE.Group();
  node_leg_rear_right_38.name = "LegRearRight__pivot";
  node_leg_rear_right_38.scale.set(1, 1, 1);
  if (endpoint_leg_rear_right_38) {
    node_leg_rear_right_38.position.copy(endpoint_leg_rear_right_38.start);
    node_leg_rear_right_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_rear_right_38.position.set(0.95, 0.35, 0.45);
    node_leg_rear_right_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_rear_right_38.userData.sculptComponent = {"id": "leg-rear-right", "name": "LegRearRight", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.6, "depth": 0.26, "units": "world", "confidence": 0.88}, "transform": {"position": [0.95, 0.35, 0.45], "rotation": [0, 0, 0], "scale": [0.26, 0.6, 0.26]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Short tapered cat leg under body corner", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_rear_right_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_leg_rear_right_38);
  nodes["leg-rear-right"] = node_leg_rear_right_38;
  const mesh_leg_rear_right_38Geometry = endpoint_leg_rear_right_38
    ? new THREE.CylinderGeometry(endpoint_leg_rear_right_38.endRadius, endpoint_leg_rear_right_38.baseRadius, endpoint_leg_rear_right_38.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_leg_rear_right_38) {
    mesh_leg_rear_right_38Geometry.scale(0.26, 0.6, 0.26);
  }
  const mesh_leg_rear_right_38 = new THREE.Mesh(
    mesh_leg_rear_right_38Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_rear_right_38.name = "LegRearRight";
  if (endpoint_leg_rear_right_38) {
    mesh_leg_rear_right_38.position.copy(endpoint_leg_rear_right_38.midpoint);
    mesh_leg_rear_right_38.quaternion.copy(endpoint_leg_rear_right_38.quaternion);
  }
  mesh_leg_rear_right_38.castShadow = options.castShadow ?? true;
  mesh_leg_rear_right_38.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_rear_right_38.userData.sculptComponent = {"id": "leg-rear-right", "name": "LegRearRight", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.6, "depth": 0.26, "units": "world", "confidence": 0.88}, "transform": {"position": [0.95, 0.35, 0.45], "rotation": [0, 0, 0], "scale": [0.26, 0.6, 0.26]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Short tapered cat leg under body corner", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.88, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_rear_right_38.add(mesh_leg_rear_right_38);
  meshes["leg-rear-right"] = mesh_leg_rear_right_38;
  colliders["leg-rear-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["leg-rear-right"] ??= [];
  destructionGroups["leg-rear-right"].push(node_leg_rear_right_38);

  const endpoint_leg_rear_right_paw_39 = makeAttachmentEndpoint(null);
  const node_leg_rear_right_paw_39 = new THREE.Group();
  node_leg_rear_right_paw_39.name = "PawRearRight__pivot";
  node_leg_rear_right_paw_39.scale.set(1, 1, 1);
  if (endpoint_leg_rear_right_paw_39) {
    node_leg_rear_right_paw_39.position.copy(endpoint_leg_rear_right_paw_39.start);
    node_leg_rear_right_paw_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_rear_right_paw_39.position.set(0.0, -0.32, 0.02);
    node_leg_rear_right_paw_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_rear_right_paw_39.userData.sculptComponent = {"id": "leg-rear-right-paw", "name": "PawRearRight", "level": "meso", "role": "paw", "importance": 0.7, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "leg-rear-right", "attachment": {"parentId": "leg-rear-right", "parentSocket": "leg-rear-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.32, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.32, 0.02], "rotation": [0, 0, 0], "scale": [0.3, 0.16, 0.32]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded paw foot at leg base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-right-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_rear_right_paw_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-right-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["leg-rear-right"] ?? root).add(node_leg_rear_right_paw_39);
  nodes["leg-rear-right-paw"] = node_leg_rear_right_paw_39;
  const mesh_leg_rear_right_paw_39Geometry = endpoint_leg_rear_right_paw_39
    ? new THREE.CylinderGeometry(endpoint_leg_rear_right_paw_39.endRadius, endpoint_leg_rear_right_paw_39.baseRadius, endpoint_leg_rear_right_paw_39.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_leg_rear_right_paw_39) {
    mesh_leg_rear_right_paw_39Geometry.scale(0.3, 0.16, 0.32);
  }
  const mesh_leg_rear_right_paw_39 = new THREE.Mesh(
    mesh_leg_rear_right_paw_39Geometry,
    materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_rear_right_paw_39.name = "PawRearRight";
  if (endpoint_leg_rear_right_paw_39) {
    mesh_leg_rear_right_paw_39.position.copy(endpoint_leg_rear_right_paw_39.midpoint);
    mesh_leg_rear_right_paw_39.quaternion.copy(endpoint_leg_rear_right_paw_39.quaternion);
  }
  mesh_leg_rear_right_paw_39.castShadow = options.castShadow ?? true;
  mesh_leg_rear_right_paw_39.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_rear_right_paw_39.userData.sculptComponent = {"id": "leg-rear-right-paw", "name": "PawRearRight", "level": "meso", "role": "paw", "importance": 0.7, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "leg-rear-right", "attachment": {"parentId": "leg-rear-right", "parentSocket": "leg-rear-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.32, "units": "world", "confidence": 0.85}, "transform": {"position": [0, -0.32, 0.02], "rotation": [0, 0, 0], "scale": [0.3, 0.16, 0.32]}, "material": "cat-fur-black", "evidenceRefs": ["full-object"], "topologyRationale": "Rounded paw foot at leg base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 30, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "leg-rear-right-paw", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_leg_rear_right_paw_39.add(mesh_leg_rear_right_paw_39);
  meshes["leg-rear-right-paw"] = mesh_leg_rear_right_paw_39;
  colliders["leg-rear-right-paw"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["leg-rear-right-paw"] ??= [];
  destructionGroups["leg-rear-right-paw"].push(node_leg_rear_right_paw_39);

  const endpoint_window_01m_40 = makeAttachmentEndpoint(null);
  const node_window_01m_40 = new THREE.Group();
  node_window_01m_40.name = "Window01Mirror__pivot";
  node_window_01m_40.scale.set(1, 1, 1);
  if (endpoint_window_01m_40) {
    node_window_01m_40.position.copy(endpoint_window_01m_40.start);
    node_window_01m_40.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01m_40.position.set(-1.1, 0.0, -0.71);
    node_window_01m_40.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01m_40.userData.sculptComponent = {"id": "window-01m", "name": "Window01Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.1, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01m_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_01m_40);
  nodes["window-01m"] = node_window_01m_40;
  const mesh_window_01m_40Geometry = endpoint_window_01m_40
    ? new THREE.CylinderGeometry(endpoint_window_01m_40.endRadius, endpoint_window_01m_40.baseRadius, endpoint_window_01m_40.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01m_40) {
    mesh_window_01m_40Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_01m_40 = new THREE.Mesh(
    mesh_window_01m_40Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01m_40.name = "Window01Mirror";
  if (endpoint_window_01m_40) {
    mesh_window_01m_40.position.copy(endpoint_window_01m_40.midpoint);
    mesh_window_01m_40.quaternion.copy(endpoint_window_01m_40.quaternion);
  }
  mesh_window_01m_40.castShadow = options.castShadow ?? true;
  mesh_window_01m_40.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01m_40.visible = false; // 容器节点不渲染
  mesh_window_01m_40.userData.sculptComponent = {"id": "window-01m", "name": "Window01Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.1, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01m_40.add(mesh_window_01m_40);
  meshes["window-01m"] = mesh_window_01m_40;
  colliders["window-01m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01"] ??= [];
  destructionGroups["window-01"].push(node_window_01m_40);

  const endpoint_window_01_framem_41 = makeAttachmentEndpoint(null);
  const node_window_01_framem_41 = new THREE.Group();
  node_window_01_framem_41.name = "Window01FrameMirror__pivot";
  node_window_01_framem_41.scale.set(1, 1, 1);
  if (endpoint_window_01_framem_41) {
    node_window_01_framem_41.position.copy(endpoint_window_01_framem_41.start);
    node_window_01_framem_41.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01_framem_41.position.set(0.0, 0.0, 0.0);
    node_window_01_framem_41.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01_framem_41.userData.sculptComponent = {"id": "window-01-framem", "name": "Window01FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_framem_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_01_framem_41);
  nodes["window-01-framem"] = node_window_01_framem_41;
  const mesh_window_01_framem_41Geometry = endpoint_window_01_framem_41
    ? new THREE.CylinderGeometry(endpoint_window_01_framem_41.endRadius, endpoint_window_01_framem_41.baseRadius, endpoint_window_01_framem_41.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_framem_41) {
    mesh_window_01_framem_41Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_01_framem_41 = new THREE.Mesh(
    mesh_window_01_framem_41Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_framem_41.name = "Window01FrameMirror";
  if (endpoint_window_01_framem_41) {
    mesh_window_01_framem_41.position.copy(endpoint_window_01_framem_41.midpoint);
    mesh_window_01_framem_41.quaternion.copy(endpoint_window_01_framem_41.quaternion);
  }
  mesh_window_01_framem_41.castShadow = options.castShadow ?? true;
  mesh_window_01_framem_41.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_framem_41.userData.sculptComponent = {"id": "window-01-framem", "name": "Window01FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_framem_41.add(mesh_window_01_framem_41);
  meshes["window-01-framem"] = mesh_window_01_framem_41;
  colliders["window-01-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-frame"] ??= [];
  destructionGroups["window-01-frame"].push(node_window_01_framem_41);

  const endpoint_window_01_glassm_42 = makeAttachmentEndpoint(null);
  const node_window_01_glassm_42 = new THREE.Group();
  node_window_01_glassm_42.name = "Window01GlassMirror__pivot";
  node_window_01_glassm_42.scale.set(1, 1, 1);
  if (endpoint_window_01_glassm_42) {
    node_window_01_glassm_42.position.copy(endpoint_window_01_glassm_42.start);
    node_window_01_glassm_42.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01_glassm_42.position.set(0.0, 0.0, 0.032);
    node_window_01_glassm_42.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01_glassm_42.userData.sculptComponent = {"id": "window-01-glassm", "name": "Window01GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glassm_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_01_glassm_42);
  nodes["window-01-glassm"] = node_window_01_glassm_42;
  const mesh_window_01_glassm_42Geometry = endpoint_window_01_glassm_42
    ? new THREE.CylinderGeometry(endpoint_window_01_glassm_42.endRadius, endpoint_window_01_glassm_42.baseRadius, endpoint_window_01_glassm_42.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_glassm_42) {
    mesh_window_01_glassm_42Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_01_glassm_42 = new THREE.Mesh(
    mesh_window_01_glassm_42Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_glassm_42.name = "Window01GlassMirror";
  if (endpoint_window_01_glassm_42) {
    mesh_window_01_glassm_42.position.copy(endpoint_window_01_glassm_42.midpoint);
    mesh_window_01_glassm_42.quaternion.copy(endpoint_window_01_glassm_42.quaternion);
  }
  mesh_window_01_glassm_42.castShadow = options.castShadow ?? true;
  mesh_window_01_glassm_42.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_glassm_42.userData.sculptComponent = {"id": "window-01-glassm", "name": "Window01GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glassm_42.add(mesh_window_01_glassm_42);
  meshes["window-01-glassm"] = mesh_window_01_glassm_42;
  colliders["window-01-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-glass"] ??= [];
  destructionGroups["window-01-glass"].push(node_window_01_glassm_42);

  const endpoint_window_02m_43 = makeAttachmentEndpoint(null);
  const node_window_02m_43 = new THREE.Group();
  node_window_02m_43.name = "Window02Mirror__pivot";
  node_window_02m_43.scale.set(1, 1, 1);
  if (endpoint_window_02m_43) {
    node_window_02m_43.position.copy(endpoint_window_02m_43.start);
    node_window_02m_43.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02m_43.position.set(-0.6600000000000001, 0.0, -0.71);
    node_window_02m_43.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02m_43.userData.sculptComponent = {"id": "window-02m", "name": "Window02Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.6600000000000001, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02m_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_02m_43);
  nodes["window-02m"] = node_window_02m_43;
  const mesh_window_02m_43Geometry = endpoint_window_02m_43
    ? new THREE.CylinderGeometry(endpoint_window_02m_43.endRadius, endpoint_window_02m_43.baseRadius, endpoint_window_02m_43.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02m_43) {
    mesh_window_02m_43Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_02m_43 = new THREE.Mesh(
    mesh_window_02m_43Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02m_43.name = "Window02Mirror";
  if (endpoint_window_02m_43) {
    mesh_window_02m_43.position.copy(endpoint_window_02m_43.midpoint);
    mesh_window_02m_43.quaternion.copy(endpoint_window_02m_43.quaternion);
  }
  mesh_window_02m_43.castShadow = options.castShadow ?? true;
  mesh_window_02m_43.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02m_43.visible = false; // 容器节点不渲染
  mesh_window_02m_43.userData.sculptComponent = {"id": "window-02m", "name": "Window02Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.6600000000000001, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02m_43.add(mesh_window_02m_43);
  meshes["window-02m"] = mesh_window_02m_43;
  colliders["window-02m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02"] ??= [];
  destructionGroups["window-02"].push(node_window_02m_43);

  const endpoint_window_02_framem_44 = makeAttachmentEndpoint(null);
  const node_window_02_framem_44 = new THREE.Group();
  node_window_02_framem_44.name = "Window02FrameMirror__pivot";
  node_window_02_framem_44.scale.set(1, 1, 1);
  if (endpoint_window_02_framem_44) {
    node_window_02_framem_44.position.copy(endpoint_window_02_framem_44.start);
    node_window_02_framem_44.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_framem_44.position.set(0.0, 0.0, 0.0);
    node_window_02_framem_44.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_framem_44.userData.sculptComponent = {"id": "window-02-framem", "name": "Window02FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_framem_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_framem_44);
  nodes["window-02-framem"] = node_window_02_framem_44;
  const mesh_window_02_framem_44Geometry = endpoint_window_02_framem_44
    ? new THREE.CylinderGeometry(endpoint_window_02_framem_44.endRadius, endpoint_window_02_framem_44.baseRadius, endpoint_window_02_framem_44.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_framem_44) {
    mesh_window_02_framem_44Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_02_framem_44 = new THREE.Mesh(
    mesh_window_02_framem_44Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_framem_44.name = "Window02FrameMirror";
  if (endpoint_window_02_framem_44) {
    mesh_window_02_framem_44.position.copy(endpoint_window_02_framem_44.midpoint);
    mesh_window_02_framem_44.quaternion.copy(endpoint_window_02_framem_44.quaternion);
  }
  mesh_window_02_framem_44.castShadow = options.castShadow ?? true;
  mesh_window_02_framem_44.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_framem_44.userData.sculptComponent = {"id": "window-02-framem", "name": "Window02FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_framem_44.add(mesh_window_02_framem_44);
  meshes["window-02-framem"] = mesh_window_02_framem_44;
  colliders["window-02-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-frame"] ??= [];
  destructionGroups["window-02-frame"].push(node_window_02_framem_44);

  const endpoint_window_02_glassm_45 = makeAttachmentEndpoint(null);
  const node_window_02_glassm_45 = new THREE.Group();
  node_window_02_glassm_45.name = "Window02GlassMirror__pivot";
  node_window_02_glassm_45.scale.set(1, 1, 1);
  if (endpoint_window_02_glassm_45) {
    node_window_02_glassm_45.position.copy(endpoint_window_02_glassm_45.start);
    node_window_02_glassm_45.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_glassm_45.position.set(0.0, 0.0, 0.032);
    node_window_02_glassm_45.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_glassm_45.userData.sculptComponent = {"id": "window-02-glassm", "name": "Window02GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glassm_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_glassm_45);
  nodes["window-02-glassm"] = node_window_02_glassm_45;
  const mesh_window_02_glassm_45Geometry = endpoint_window_02_glassm_45
    ? new THREE.CylinderGeometry(endpoint_window_02_glassm_45.endRadius, endpoint_window_02_glassm_45.baseRadius, endpoint_window_02_glassm_45.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_glassm_45) {
    mesh_window_02_glassm_45Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_02_glassm_45 = new THREE.Mesh(
    mesh_window_02_glassm_45Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_glassm_45.name = "Window02GlassMirror";
  if (endpoint_window_02_glassm_45) {
    mesh_window_02_glassm_45.position.copy(endpoint_window_02_glassm_45.midpoint);
    mesh_window_02_glassm_45.quaternion.copy(endpoint_window_02_glassm_45.quaternion);
  }
  mesh_window_02_glassm_45.castShadow = options.castShadow ?? true;
  mesh_window_02_glassm_45.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_glassm_45.userData.sculptComponent = {"id": "window-02-glassm", "name": "Window02GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glassm_45.add(mesh_window_02_glassm_45);
  meshes["window-02-glassm"] = mesh_window_02_glassm_45;
  colliders["window-02-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-glass"] ??= [];
  destructionGroups["window-02-glass"].push(node_window_02_glassm_45);

  const endpoint_window_03m_46 = makeAttachmentEndpoint(null);
  const node_window_03m_46 = new THREE.Group();
  node_window_03m_46.name = "Window03Mirror__pivot";
  node_window_03m_46.scale.set(1, 1, 1);
  if (endpoint_window_03m_46) {
    node_window_03m_46.position.copy(endpoint_window_03m_46.start);
    node_window_03m_46.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03m_46.position.set(-0.22000000000000008, 0.0, -0.71);
    node_window_03m_46.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03m_46.userData.sculptComponent = {"id": "window-03m", "name": "Window03Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.22000000000000008, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03m_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_03m_46);
  nodes["window-03m"] = node_window_03m_46;
  const mesh_window_03m_46Geometry = endpoint_window_03m_46
    ? new THREE.CylinderGeometry(endpoint_window_03m_46.endRadius, endpoint_window_03m_46.baseRadius, endpoint_window_03m_46.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03m_46) {
    mesh_window_03m_46Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_03m_46 = new THREE.Mesh(
    mesh_window_03m_46Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03m_46.name = "Window03Mirror";
  if (endpoint_window_03m_46) {
    mesh_window_03m_46.position.copy(endpoint_window_03m_46.midpoint);
    mesh_window_03m_46.quaternion.copy(endpoint_window_03m_46.quaternion);
  }
  mesh_window_03m_46.castShadow = options.castShadow ?? true;
  mesh_window_03m_46.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03m_46.visible = false; // 容器节点不渲染
  mesh_window_03m_46.userData.sculptComponent = {"id": "window-03m", "name": "Window03Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.22000000000000008, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03m_46.add(mesh_window_03m_46);
  meshes["window-03m"] = mesh_window_03m_46;
  colliders["window-03m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03"] ??= [];
  destructionGroups["window-03"].push(node_window_03m_46);

  const endpoint_window_03_framem_47 = makeAttachmentEndpoint(null);
  const node_window_03_framem_47 = new THREE.Group();
  node_window_03_framem_47.name = "Window03FrameMirror__pivot";
  node_window_03_framem_47.scale.set(1, 1, 1);
  if (endpoint_window_03_framem_47) {
    node_window_03_framem_47.position.copy(endpoint_window_03_framem_47.start);
    node_window_03_framem_47.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_framem_47.position.set(0.0, 0.0, 0.0);
    node_window_03_framem_47.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_framem_47.userData.sculptComponent = {"id": "window-03-framem", "name": "Window03FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_framem_47.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_framem_47);
  nodes["window-03-framem"] = node_window_03_framem_47;
  const mesh_window_03_framem_47Geometry = endpoint_window_03_framem_47
    ? new THREE.CylinderGeometry(endpoint_window_03_framem_47.endRadius, endpoint_window_03_framem_47.baseRadius, endpoint_window_03_framem_47.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_framem_47) {
    mesh_window_03_framem_47Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_03_framem_47 = new THREE.Mesh(
    mesh_window_03_framem_47Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_framem_47.name = "Window03FrameMirror";
  if (endpoint_window_03_framem_47) {
    mesh_window_03_framem_47.position.copy(endpoint_window_03_framem_47.midpoint);
    mesh_window_03_framem_47.quaternion.copy(endpoint_window_03_framem_47.quaternion);
  }
  mesh_window_03_framem_47.castShadow = options.castShadow ?? true;
  mesh_window_03_framem_47.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_framem_47.userData.sculptComponent = {"id": "window-03-framem", "name": "Window03FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_framem_47.add(mesh_window_03_framem_47);
  meshes["window-03-framem"] = mesh_window_03_framem_47;
  colliders["window-03-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-frame"] ??= [];
  destructionGroups["window-03-frame"].push(node_window_03_framem_47);

  const endpoint_window_03_glassm_48 = makeAttachmentEndpoint(null);
  const node_window_03_glassm_48 = new THREE.Group();
  node_window_03_glassm_48.name = "Window03GlassMirror__pivot";
  node_window_03_glassm_48.scale.set(1, 1, 1);
  if (endpoint_window_03_glassm_48) {
    node_window_03_glassm_48.position.copy(endpoint_window_03_glassm_48.start);
    node_window_03_glassm_48.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_glassm_48.position.set(0.0, 0.0, 0.032);
    node_window_03_glassm_48.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_glassm_48.userData.sculptComponent = {"id": "window-03-glassm", "name": "Window03GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glassm_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_glassm_48);
  nodes["window-03-glassm"] = node_window_03_glassm_48;
  const mesh_window_03_glassm_48Geometry = endpoint_window_03_glassm_48
    ? new THREE.CylinderGeometry(endpoint_window_03_glassm_48.endRadius, endpoint_window_03_glassm_48.baseRadius, endpoint_window_03_glassm_48.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_glassm_48) {
    mesh_window_03_glassm_48Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_03_glassm_48 = new THREE.Mesh(
    mesh_window_03_glassm_48Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_glassm_48.name = "Window03GlassMirror";
  if (endpoint_window_03_glassm_48) {
    mesh_window_03_glassm_48.position.copy(endpoint_window_03_glassm_48.midpoint);
    mesh_window_03_glassm_48.quaternion.copy(endpoint_window_03_glassm_48.quaternion);
  }
  mesh_window_03_glassm_48.castShadow = options.castShadow ?? true;
  mesh_window_03_glassm_48.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_glassm_48.userData.sculptComponent = {"id": "window-03-glassm", "name": "Window03GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glassm_48.add(mesh_window_03_glassm_48);
  meshes["window-03-glassm"] = mesh_window_03_glassm_48;
  colliders["window-03-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-glass"] ??= [];
  destructionGroups["window-03-glass"].push(node_window_03_glassm_48);

  const endpoint_window_04m_49 = makeAttachmentEndpoint(null);
  const node_window_04m_49 = new THREE.Group();
  node_window_04m_49.name = "Window04Mirror__pivot";
  node_window_04m_49.scale.set(1, 1, 1);
  if (endpoint_window_04m_49) {
    node_window_04m_49.position.copy(endpoint_window_04m_49.start);
    node_window_04m_49.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04m_49.position.set(0.21999999999999997, 0.0, -0.71);
    node_window_04m_49.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04m_49.userData.sculptComponent = {"id": "window-04m", "name": "Window04Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.21999999999999997, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04m_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_04m_49);
  nodes["window-04m"] = node_window_04m_49;
  const mesh_window_04m_49Geometry = endpoint_window_04m_49
    ? new THREE.CylinderGeometry(endpoint_window_04m_49.endRadius, endpoint_window_04m_49.baseRadius, endpoint_window_04m_49.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04m_49) {
    mesh_window_04m_49Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_04m_49 = new THREE.Mesh(
    mesh_window_04m_49Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04m_49.name = "Window04Mirror";
  if (endpoint_window_04m_49) {
    mesh_window_04m_49.position.copy(endpoint_window_04m_49.midpoint);
    mesh_window_04m_49.quaternion.copy(endpoint_window_04m_49.quaternion);
  }
  mesh_window_04m_49.castShadow = options.castShadow ?? true;
  mesh_window_04m_49.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04m_49.visible = false; // 容器节点不渲染
  mesh_window_04m_49.userData.sculptComponent = {"id": "window-04m", "name": "Window04Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.21999999999999997, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04m_49.add(mesh_window_04m_49);
  meshes["window-04m"] = mesh_window_04m_49;
  colliders["window-04m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04"] ??= [];
  destructionGroups["window-04"].push(node_window_04m_49);

  const endpoint_window_04_framem_50 = makeAttachmentEndpoint(null);
  const node_window_04_framem_50 = new THREE.Group();
  node_window_04_framem_50.name = "Window04FrameMirror__pivot";
  node_window_04_framem_50.scale.set(1, 1, 1);
  if (endpoint_window_04_framem_50) {
    node_window_04_framem_50.position.copy(endpoint_window_04_framem_50.start);
    node_window_04_framem_50.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04_framem_50.position.set(0.0, 0.0, 0.0);
    node_window_04_framem_50.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04_framem_50.userData.sculptComponent = {"id": "window-04-framem", "name": "Window04FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_framem_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04m"] ?? root).add(node_window_04_framem_50);
  nodes["window-04-framem"] = node_window_04_framem_50;
  const mesh_window_04_framem_50Geometry = endpoint_window_04_framem_50
    ? new THREE.CylinderGeometry(endpoint_window_04_framem_50.endRadius, endpoint_window_04_framem_50.baseRadius, endpoint_window_04_framem_50.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_framem_50) {
    mesh_window_04_framem_50Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_04_framem_50 = new THREE.Mesh(
    mesh_window_04_framem_50Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_framem_50.name = "Window04FrameMirror";
  if (endpoint_window_04_framem_50) {
    mesh_window_04_framem_50.position.copy(endpoint_window_04_framem_50.midpoint);
    mesh_window_04_framem_50.quaternion.copy(endpoint_window_04_framem_50.quaternion);
  }
  mesh_window_04_framem_50.castShadow = options.castShadow ?? true;
  mesh_window_04_framem_50.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_framem_50.userData.sculptComponent = {"id": "window-04-framem", "name": "Window04FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_framem_50.add(mesh_window_04_framem_50);
  meshes["window-04-framem"] = mesh_window_04_framem_50;
  colliders["window-04-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-frame"] ??= [];
  destructionGroups["window-04-frame"].push(node_window_04_framem_50);

  const endpoint_window_04_glassm_51 = makeAttachmentEndpoint(null);
  const node_window_04_glassm_51 = new THREE.Group();
  node_window_04_glassm_51.name = "Window04GlassMirror__pivot";
  node_window_04_glassm_51.scale.set(1, 1, 1);
  if (endpoint_window_04_glassm_51) {
    node_window_04_glassm_51.position.copy(endpoint_window_04_glassm_51.start);
    node_window_04_glassm_51.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04_glassm_51.position.set(0.0, 0.0, 0.032);
    node_window_04_glassm_51.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04_glassm_51.userData.sculptComponent = {"id": "window-04-glassm", "name": "Window04GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glassm_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04m"] ?? root).add(node_window_04_glassm_51);
  nodes["window-04-glassm"] = node_window_04_glassm_51;
  const mesh_window_04_glassm_51Geometry = endpoint_window_04_glassm_51
    ? new THREE.CylinderGeometry(endpoint_window_04_glassm_51.endRadius, endpoint_window_04_glassm_51.baseRadius, endpoint_window_04_glassm_51.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_glassm_51) {
    mesh_window_04_glassm_51Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_04_glassm_51 = new THREE.Mesh(
    mesh_window_04_glassm_51Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_glassm_51.name = "Window04GlassMirror";
  if (endpoint_window_04_glassm_51) {
    mesh_window_04_glassm_51.position.copy(endpoint_window_04_glassm_51.midpoint);
    mesh_window_04_glassm_51.quaternion.copy(endpoint_window_04_glassm_51.quaternion);
  }
  mesh_window_04_glassm_51.castShadow = options.castShadow ?? true;
  mesh_window_04_glassm_51.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_glassm_51.userData.sculptComponent = {"id": "window-04-glassm", "name": "Window04GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glassm_51.add(mesh_window_04_glassm_51);
  meshes["window-04-glassm"] = mesh_window_04_glassm_51;
  colliders["window-04-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-glass"] ??= [];
  destructionGroups["window-04-glass"].push(node_window_04_glassm_51);

  const endpoint_window_05m_52 = makeAttachmentEndpoint(null);
  const node_window_05m_52 = new THREE.Group();
  node_window_05m_52.name = "Window05Mirror__pivot";
  node_window_05m_52.scale.set(1, 1, 1);
  if (endpoint_window_05m_52) {
    node_window_05m_52.position.copy(endpoint_window_05m_52.start);
    node_window_05m_52.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_05m_52.position.set(0.6599999999999999, 0.0, -0.71);
    node_window_05m_52.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_05m_52.userData.sculptComponent = {"id": "window-05m", "name": "Window05Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.6599999999999999, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window05 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05m_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_05m_52);
  nodes["window-05m"] = node_window_05m_52;
  const mesh_window_05m_52Geometry = endpoint_window_05m_52
    ? new THREE.CylinderGeometry(endpoint_window_05m_52.endRadius, endpoint_window_05m_52.baseRadius, endpoint_window_05m_52.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_05m_52) {
    mesh_window_05m_52Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_05m_52 = new THREE.Mesh(
    mesh_window_05m_52Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_05m_52.name = "Window05Mirror";
  if (endpoint_window_05m_52) {
    mesh_window_05m_52.position.copy(endpoint_window_05m_52.midpoint);
    mesh_window_05m_52.quaternion.copy(endpoint_window_05m_52.quaternion);
  }
  mesh_window_05m_52.castShadow = options.castShadow ?? true;
  mesh_window_05m_52.receiveShadow = options.receiveShadow ?? true;
  mesh_window_05m_52.visible = false; // 容器节点不渲染
  mesh_window_05m_52.userData.sculptComponent = {"id": "window-05m", "name": "Window05Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.6599999999999999, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window05 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05m_52.add(mesh_window_05m_52);
  meshes["window-05m"] = mesh_window_05m_52;
  colliders["window-05m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-05"] ??= [];
  destructionGroups["window-05"].push(node_window_05m_52);

  const endpoint_window_05_framem_53 = makeAttachmentEndpoint(null);
  const node_window_05_framem_53 = new THREE.Group();
  node_window_05_framem_53.name = "Window05FrameMirror__pivot";
  node_window_05_framem_53.scale.set(1, 1, 1);
  if (endpoint_window_05_framem_53) {
    node_window_05_framem_53.position.copy(endpoint_window_05_framem_53.start);
    node_window_05_framem_53.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_05_framem_53.position.set(0.0, 0.0, 0.0);
    node_window_05_framem_53.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_05_framem_53.userData.sculptComponent = {"id": "window-05-framem", "name": "Window05FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-05m", "attachment": {"parentId": "window-05m", "parentSocket": "window-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window05Frame solid geometry attached to window-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_framem_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-05m"] ?? root).add(node_window_05_framem_53);
  nodes["window-05-framem"] = node_window_05_framem_53;
  const mesh_window_05_framem_53Geometry = endpoint_window_05_framem_53
    ? new THREE.CylinderGeometry(endpoint_window_05_framem_53.endRadius, endpoint_window_05_framem_53.baseRadius, endpoint_window_05_framem_53.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_05_framem_53) {
    mesh_window_05_framem_53Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_05_framem_53 = new THREE.Mesh(
    mesh_window_05_framem_53Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_05_framem_53.name = "Window05FrameMirror";
  if (endpoint_window_05_framem_53) {
    mesh_window_05_framem_53.position.copy(endpoint_window_05_framem_53.midpoint);
    mesh_window_05_framem_53.quaternion.copy(endpoint_window_05_framem_53.quaternion);
  }
  mesh_window_05_framem_53.castShadow = options.castShadow ?? true;
  mesh_window_05_framem_53.receiveShadow = options.receiveShadow ?? true;
  mesh_window_05_framem_53.userData.sculptComponent = {"id": "window-05-framem", "name": "Window05FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-05m", "attachment": {"parentId": "window-05m", "parentSocket": "window-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window05Frame solid geometry attached to window-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_framem_53.add(mesh_window_05_framem_53);
  meshes["window-05-framem"] = mesh_window_05_framem_53;
  colliders["window-05-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-05-frame"] ??= [];
  destructionGroups["window-05-frame"].push(node_window_05_framem_53);

  const endpoint_window_05_glassm_54 = makeAttachmentEndpoint(null);
  const node_window_05_glassm_54 = new THREE.Group();
  node_window_05_glassm_54.name = "Window05GlassMirror__pivot";
  node_window_05_glassm_54.scale.set(1, 1, 1);
  if (endpoint_window_05_glassm_54) {
    node_window_05_glassm_54.position.copy(endpoint_window_05_glassm_54.start);
    node_window_05_glassm_54.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_05_glassm_54.position.set(0.0, 0.0, 0.032);
    node_window_05_glassm_54.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_05_glassm_54.userData.sculptComponent = {"id": "window-05-glassm", "name": "Window05GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-05m", "attachment": {"parentId": "window-05m", "parentSocket": "window-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window05Glass solid geometry attached to window-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_glassm_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-05m"] ?? root).add(node_window_05_glassm_54);
  nodes["window-05-glassm"] = node_window_05_glassm_54;
  const mesh_window_05_glassm_54Geometry = endpoint_window_05_glassm_54
    ? new THREE.CylinderGeometry(endpoint_window_05_glassm_54.endRadius, endpoint_window_05_glassm_54.baseRadius, endpoint_window_05_glassm_54.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_05_glassm_54) {
    mesh_window_05_glassm_54Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_05_glassm_54 = new THREE.Mesh(
    mesh_window_05_glassm_54Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_05_glassm_54.name = "Window05GlassMirror";
  if (endpoint_window_05_glassm_54) {
    mesh_window_05_glassm_54.position.copy(endpoint_window_05_glassm_54.midpoint);
    mesh_window_05_glassm_54.quaternion.copy(endpoint_window_05_glassm_54.quaternion);
  }
  mesh_window_05_glassm_54.castShadow = options.castShadow ?? true;
  mesh_window_05_glassm_54.receiveShadow = options.receiveShadow ?? true;
  mesh_window_05_glassm_54.userData.sculptComponent = {"id": "window-05-glassm", "name": "Window05GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-05m", "attachment": {"parentId": "window-05m", "parentSocket": "window-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window05Glass solid geometry attached to window-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-05-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_05_glassm_54.add(mesh_window_05_glassm_54);
  meshes["window-05-glassm"] = mesh_window_05_glassm_54;
  colliders["window-05-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-05-glass"] ??= [];
  destructionGroups["window-05-glass"].push(node_window_05_glassm_54);

  const endpoint_window_06m_55 = makeAttachmentEndpoint(null);
  const node_window_06m_55 = new THREE.Group();
  node_window_06m_55.name = "Window06Mirror__pivot";
  node_window_06m_55.scale.set(1, 1, 1);
  if (endpoint_window_06m_55) {
    node_window_06m_55.position.copy(endpoint_window_06m_55.start);
    node_window_06m_55.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_06m_55.position.set(1.1, 0.0, -0.71);
    node_window_06m_55.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_06m_55.userData.sculptComponent = {"id": "window-06m", "name": "Window06Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.1, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window06 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06m_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_06m_55);
  nodes["window-06m"] = node_window_06m_55;
  const mesh_window_06m_55Geometry = endpoint_window_06m_55
    ? new THREE.CylinderGeometry(endpoint_window_06m_55.endRadius, endpoint_window_06m_55.baseRadius, endpoint_window_06m_55.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_06m_55) {
    mesh_window_06m_55Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_06m_55 = new THREE.Mesh(
    mesh_window_06m_55Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_06m_55.name = "Window06Mirror";
  if (endpoint_window_06m_55) {
    mesh_window_06m_55.position.copy(endpoint_window_06m_55.midpoint);
    mesh_window_06m_55.quaternion.copy(endpoint_window_06m_55.quaternion);
  }
  mesh_window_06m_55.castShadow = options.castShadow ?? true;
  mesh_window_06m_55.receiveShadow = options.receiveShadow ?? true;
  mesh_window_06m_55.visible = false; // 容器节点不渲染
  mesh_window_06m_55.userData.sculptComponent = {"id": "window-06m", "name": "Window06Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.1, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window06 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06m_55.add(mesh_window_06m_55);
  meshes["window-06m"] = mesh_window_06m_55;
  colliders["window-06m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-06"] ??= [];
  destructionGroups["window-06"].push(node_window_06m_55);

  const endpoint_window_06_framem_56 = makeAttachmentEndpoint(null);
  const node_window_06_framem_56 = new THREE.Group();
  node_window_06_framem_56.name = "Window06FrameMirror__pivot";
  node_window_06_framem_56.scale.set(1, 1, 1);
  if (endpoint_window_06_framem_56) {
    node_window_06_framem_56.position.copy(endpoint_window_06_framem_56.start);
    node_window_06_framem_56.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_06_framem_56.position.set(0.0, 0.0, 0.0);
    node_window_06_framem_56.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_06_framem_56.userData.sculptComponent = {"id": "window-06-framem", "name": "Window06FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-06m", "attachment": {"parentId": "window-06m", "parentSocket": "window-06-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window06Frame solid geometry attached to window-06", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_framem_56.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-06m"] ?? root).add(node_window_06_framem_56);
  nodes["window-06-framem"] = node_window_06_framem_56;
  const mesh_window_06_framem_56Geometry = endpoint_window_06_framem_56
    ? new THREE.CylinderGeometry(endpoint_window_06_framem_56.endRadius, endpoint_window_06_framem_56.baseRadius, endpoint_window_06_framem_56.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_06_framem_56) {
    mesh_window_06_framem_56Geometry.scale(0.38, 0.46, 0.05);
  }
  const mesh_window_06_framem_56 = new THREE.Mesh(
    mesh_window_06_framem_56Geometry,
    materialMap["window-frame-wood"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_06_framem_56.name = "Window06FrameMirror";
  if (endpoint_window_06_framem_56) {
    mesh_window_06_framem_56.position.copy(endpoint_window_06_framem_56.midpoint);
    mesh_window_06_framem_56.quaternion.copy(endpoint_window_06_framem_56.quaternion);
  }
  mesh_window_06_framem_56.castShadow = options.castShadow ?? true;
  mesh_window_06_framem_56.receiveShadow = options.receiveShadow ?? true;
  mesh_window_06_framem_56.userData.sculptComponent = {"id": "window-06-framem", "name": "Window06FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-06m", "attachment": {"parentId": "window-06m", "parentSocket": "window-06-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.46, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.46, 0.05]}, "material": "window-frame-wood", "evidenceRefs": ["full-object"], "topologyRationale": "Window06Frame solid geometry attached to window-06", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 90, 58, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_framem_56.add(mesh_window_06_framem_56);
  meshes["window-06-framem"] = mesh_window_06_framem_56;
  colliders["window-06-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-06-frame"] ??= [];
  destructionGroups["window-06-frame"].push(node_window_06_framem_56);

  const endpoint_window_06_glassm_57 = makeAttachmentEndpoint(null);
  const node_window_06_glassm_57 = new THREE.Group();
  node_window_06_glassm_57.name = "Window06GlassMirror__pivot";
  node_window_06_glassm_57.scale.set(1, 1, 1);
  if (endpoint_window_06_glassm_57) {
    node_window_06_glassm_57.position.copy(endpoint_window_06_glassm_57.start);
    node_window_06_glassm_57.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_06_glassm_57.position.set(0.0, 0.0, 0.032);
    node_window_06_glassm_57.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_06_glassm_57.userData.sculptComponent = {"id": "window-06-glassm", "name": "Window06GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-06m", "attachment": {"parentId": "window-06m", "parentSocket": "window-06-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window06Glass solid geometry attached to window-06", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_glassm_57.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-06m"] ?? root).add(node_window_06_glassm_57);
  nodes["window-06-glassm"] = node_window_06_glassm_57;
  const mesh_window_06_glassm_57Geometry = endpoint_window_06_glassm_57
    ? new THREE.CylinderGeometry(endpoint_window_06_glassm_57.endRadius, endpoint_window_06_glassm_57.baseRadius, endpoint_window_06_glassm_57.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_06_glassm_57) {
    mesh_window_06_glassm_57Geometry.scale(0.3, 0.38, 0.01);
  }
  const mesh_window_06_glassm_57 = new THREE.Mesh(
    mesh_window_06_glassm_57Geometry,
    materialMap["window-glass-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_06_glassm_57.name = "Window06GlassMirror";
  if (endpoint_window_06_glassm_57) {
    mesh_window_06_glassm_57.position.copy(endpoint_window_06_glassm_57.midpoint);
    mesh_window_06_glassm_57.quaternion.copy(endpoint_window_06_glassm_57.quaternion);
  }
  mesh_window_06_glassm_57.castShadow = options.castShadow ?? true;
  mesh_window_06_glassm_57.receiveShadow = options.receiveShadow ?? true;
  mesh_window_06_glassm_57.userData.sculptComponent = {"id": "window-06-glassm", "name": "Window06GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-06m", "attachment": {"parentId": "window-06m", "parentSocket": "window-06-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.38, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.38, 0.01]}, "material": "window-glass-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window06Glass solid geometry attached to window-06", "colorMaterialRecipe": {"dominantAlbedo": "rgba(245, 240, 224, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-06-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_06_glassm_57.add(mesh_window_06_glassm_57);
  meshes["window-06-glassm"] = mesh_window_06_glassm_57;
  colliders["window-06-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-06-glass"] ??= [];
  destructionGroups["window-06-glass"].push(node_window_06_glassm_57);

  const endpoint_eye_m_58 = makeAttachmentEndpoint(null);
  const node_eye_m_58 = new THREE.Group();
  node_eye_m_58.name = "EyeMirror__pivot";
  node_eye_m_58.scale.set(1, 1, 1);
  if (endpoint_eye_m_58) {
    node_eye_m_58.position.copy(endpoint_eye_m_58.start);
    node_eye_m_58.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_m_58.position.set(-1.51, 1.1, -0.32);
    node_eye_m_58.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_m_58.userData.sculptComponent = {"id": "eye-m", "name": "EyeMirror", "level": "meso", "role": "eye", "importance": 0.9, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket-m", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.52, "depth": 0.3, "units": "world", "confidence": 0.9}, "transform": {"position": [-1.51, 1.1, -0.32], "rotation": [0, 0, 0], "scale": [0.1, 0.52, 0.3]}, "material": "eye-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Large vertical yellow cat eye on front face", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 32, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_eye_m_58.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["cat-root"] ?? root).add(node_eye_m_58);
  nodes["eye-m"] = node_eye_m_58;
  const mesh_eye_m_58Geometry = endpoint_eye_m_58
    ? new THREE.CylinderGeometry(endpoint_eye_m_58.endRadius, endpoint_eye_m_58.baseRadius, endpoint_eye_m_58.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_eye_m_58) {
    mesh_eye_m_58Geometry.scale(0.1, 0.52, 0.3);
  }
  const mesh_eye_m_58 = new THREE.Mesh(
    mesh_eye_m_58Geometry,
    materialMap["eye-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_m_58.name = "EyeMirror";
  if (endpoint_eye_m_58) {
    mesh_eye_m_58.position.copy(endpoint_eye_m_58.midpoint);
    mesh_eye_m_58.quaternion.copy(endpoint_eye_m_58.quaternion);
  }
  mesh_eye_m_58.castShadow = options.castShadow ?? true;
  mesh_eye_m_58.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_m_58.userData.sculptComponent = {"id": "eye-m", "name": "EyeMirror", "level": "meso", "role": "eye", "importance": 0.9, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "cat-root", "attachment": {"parentId": "cat-root", "parentSocket": "cat-root-socket-m", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.52, "depth": 0.3, "units": "world", "confidence": 0.9}, "transform": {"position": [-1.51, 1.1, -0.32], "rotation": [0, 0, 0], "scale": [0.1, 0.52, 0.3]}, "material": "eye-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Large vertical yellow cat eye on front face", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 32, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_eye_m_58.add(mesh_eye_m_58);
  meshes["eye-m"] = mesh_eye_m_58;
  colliders["eye-m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["eye"] ??= [];
  destructionGroups["eye"].push(node_eye_m_58);

  const endpoint_eye_pupil_m_59 = makeAttachmentEndpoint(null);
  const node_eye_pupil_m_59 = new THREE.Group();
  node_eye_pupil_m_59.name = "EyePupilMirror__pivot";
  node_eye_pupil_m_59.scale.set(1, 1, 1);
  if (endpoint_eye_pupil_m_59) {
    node_eye_pupil_m_59.position.copy(endpoint_eye_pupil_m_59.start);
    node_eye_pupil_m_59.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_pupil_m_59.position.set(-0.06, 0.0, 0.0);
    node_eye_pupil_m_59.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_pupil_m_59.userData.sculptComponent = {"id": "eye-pupil-m", "name": "EyePupilMirror", "level": "meso", "role": "pupil", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "eye-m", "attachment": {"parentId": "eye-m", "parentSocket": "eye-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.4, "depth": 0.06, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.06, 0, 0], "rotation": [0, 0, 0], "scale": [0.02, 0.4, 0.06]}, "material": "eye-pupil-black", "evidenceRefs": ["full-object"], "topologyRationale": "Vertical slit pupil centered in the yellow eye", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 10, 12, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye-pupil", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_eye_pupil_m_59.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye-pupil", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["eye-m"] ?? root).add(node_eye_pupil_m_59);
  nodes["eye-pupil-m"] = node_eye_pupil_m_59;
  const mesh_eye_pupil_m_59Geometry = endpoint_eye_pupil_m_59
    ? new THREE.CylinderGeometry(endpoint_eye_pupil_m_59.endRadius, endpoint_eye_pupil_m_59.baseRadius, endpoint_eye_pupil_m_59.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_eye_pupil_m_59) {
    mesh_eye_pupil_m_59Geometry.scale(0.02, 0.4, 0.06);
  }
  const mesh_eye_pupil_m_59 = new THREE.Mesh(
    mesh_eye_pupil_m_59Geometry,
    materialMap["eye-pupil-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_pupil_m_59.name = "EyePupilMirror";
  if (endpoint_eye_pupil_m_59) {
    mesh_eye_pupil_m_59.position.copy(endpoint_eye_pupil_m_59.midpoint);
    mesh_eye_pupil_m_59.quaternion.copy(endpoint_eye_pupil_m_59.quaternion);
  }
  mesh_eye_pupil_m_59.castShadow = options.castShadow ?? true;
  mesh_eye_pupil_m_59.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_pupil_m_59.userData.sculptComponent = {"id": "eye-pupil-m", "name": "EyePupilMirror", "level": "meso", "role": "pupil", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "eye-m", "attachment": {"parentId": "eye-m", "parentSocket": "eye-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.02, "height": 0.4, "depth": 0.06, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.06, 0, 0], "rotation": [0, 0, 0], "scale": [0.02, 0.4, 0.06]}, "material": "eye-pupil-black", "evidenceRefs": ["full-object"], "topologyRationale": "Vertical slit pupil centered in the yellow eye", "colorMaterialRecipe": {"dominantAlbedo": "rgba(10, 10, 12, 1.0)", "secondaryAlbedo": "rgba(51, 51, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "eye-pupil", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_eye_pupil_m_59.add(mesh_eye_pupil_m_59);
  meshes["eye-pupil-m"] = mesh_eye_pupil_m_59;
  colliders["eye-pupil-m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["eye-pupil"] ??= [];
  destructionGroups["eye-pupil"].push(node_eye_pupil_m_59);

  // repetition system: window-repeat (InstancedMesh, radial, count=6, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
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
    const cluster = new THREE.InstancedMesh(geo, mat, 6);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 6; i++) {
      const ang = ((0.0) + (i * 360) / 6) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "window-repeat";
    parent.add(cluster);
  }

  // repetition system: leg-repeat (InstancedMesh, radial, count=4, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["cat-fur-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
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
    const cluster = new THREE.InstancedMesh(geo, mat, 4);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 4; i++) {
      const ang = ((0.0) + (i * 360) / 4) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "leg-repeat";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "minimumTextureResolution": 1024, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7}}};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createBlackCatCaravanLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Black Cat Caravan look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"type": "key", "direction": "front-left", "color": "#FFFFFF", "intensity": 1.0}, {"type": "fill", "direction": "right", "color": "#E8E8E8", "intensity": 0.4}, {"type": "rim", "direction": "back", "color": "#F0F0F0", "intensity": 0.3}, {"type": "tone-mapping", "note": "ACES filmic tone mapping, exposure 1.0"}, {"type": "shadow", "note": "contact shadow under legs via ground-plane ambient occlusion"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "minimumTextureResolution": 1024, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7}}};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createBlackCatCaravanEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameBlackCatCaravanCamera(
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
export function createBlackCatCaravanPresentationComposer(
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

export function configureBlackCatCaravanRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createBlackCatCaravanInspectControls(
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
