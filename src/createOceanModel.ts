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

// Generated from ObjectSculptSpec target: Ocean Caravan
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createOceanCaravanModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Ocean Caravan";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.333, "orientation": {"yaw": -15, "pitch": 5, "roll": 0}, "positionHint": [3.0, 1.5, 4.0], "note": "Three-quarter front-left view, slightly elevated"}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["ocean-blue"] = createSculptMaterial(
    "ocean-blue",
    {"id": "ocean-blue", "name": "Ocean Blue", "type": "standard", "baseColor": "#3A7FA8", "roughness": {"base": 0.6, "variation": 0.12, "map": "ocean-blue-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "carved-swirls", "strength": 0.35, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#3A7FA8"]}, "localOverrides": [{"zone": "default", "albedo": "#3A7FA8", "description": "uniform zone"}]},
    options
  );
  materialMap["ocean-blue-light"] = createSculptMaterial(
    "ocean-blue-light",
    {"id": "ocean-blue-light", "name": "Ocean Blue Light", "type": "standard", "baseColor": "#5AA8C8", "roughness": {"base": 0.6, "variation": 0.12, "map": "ocean-blue-light-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "carved-swirls", "strength": 0.3, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#5AA8C8"]}, "localOverrides": [{"zone": "default", "albedo": "#5AA8C8", "description": "uniform zone"}]},
    options
  );
  materialMap["gold-ring"] = createSculptMaterial(
    "gold-ring",
    {"id": "gold-ring", "name": "Gold Ring", "type": "standard", "baseColor": "#C8A040", "roughness": {"base": 0.35, "variation": 0.08, "map": "gold-ring-roughness-map"}, "metalness": {"base": 0.6}, "normal": {"pattern": "metal-worn", "strength": 0.15, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#C8A040"]}, "localOverrides": [{"zone": "default", "albedo": "#C8A040", "description": "uniform zone"}]},
    options
  );
  materialMap["sail-cream"] = createSculptMaterial(
    "sail-cream",
    {"id": "sail-cream", "name": "Sail Cream", "type": "standard", "baseColor": "#F0EBDD", "roughness": {"base": 0.8, "variation": 0.12, "map": "sail-cream-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "fabric-weave", "strength": 0.2, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#F0EBDD"]}, "localOverrides": [{"zone": "default", "albedo": "#F0EBDD", "description": "uniform zone"}]},
    options
  );
  materialMap["wood-brown"] = createSculptMaterial(
    "wood-brown",
    {"id": "wood-brown", "name": "Wood Brown", "type": "standard", "baseColor": "#8A6844", "roughness": {"base": 0.65, "variation": 0.12, "map": "wood-brown-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "wood-grain", "strength": 0.3, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#8A6844"]}, "localOverrides": [{"zone": "default", "albedo": "#8A6844", "description": "uniform zone"}]},
    options
  );
  materialMap["wheel-dark"] = createSculptMaterial(
    "wheel-dark",
    {"id": "wheel-dark", "name": "Wheel Dark", "type": "standard", "baseColor": "#2A2A30", "roughness": {"base": 0.7, "variation": 0.12, "map": "wheel-dark-roughness-map"}, "metalness": {"base": 0.2}, "normal": {"pattern": "metal-worn", "strength": 0.2, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#2A2A30"]}, "localOverrides": [{"zone": "default", "albedo": "#2A2A30", "description": "uniform zone"}]},
    options
  );
  materialMap["coral-pink"] = createSculptMaterial(
    "coral-pink",
    {"id": "coral-pink", "name": "Coral Pink", "type": "standard", "baseColor": "#E8788A", "roughness": {"base": 0.6, "variation": 0.12, "map": "coral-pink-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "organic-bump", "strength": 0.3, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#E8788A"]}, "localOverrides": [{"zone": "default", "albedo": "#E8788A", "description": "uniform zone"}]},
    options
  );
  materialMap["seaweed-green"] = createSculptMaterial(
    "seaweed-green",
    {"id": "seaweed-green", "name": "Seaweed Green", "type": "standard", "baseColor": "#6AA84A", "roughness": {"base": 0.65, "variation": 0.12, "map": "seaweed-green-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "organic-bump", "strength": 0.3, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#6AA84A"]}, "localOverrides": [{"zone": "default", "albedo": "#6AA84A", "description": "uniform zone"}]},
    options
  );
  materialMap["fish-orange"] = createSculptMaterial(
    "fish-orange",
    {"id": "fish-orange", "name": "Fish Orange", "type": "standard", "baseColor": "#E88840", "roughness": {"base": 0.5, "variation": 0.12, "map": "fish-orange-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.15, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#E88840"]}, "localOverrides": [{"zone": "default", "albedo": "#E88840", "description": "uniform zone"}]},
    options
  );
  materialMap["fish-teal"] = createSculptMaterial(
    "fish-teal",
    {"id": "fish-teal", "name": "Fish Teal", "type": "standard", "baseColor": "#48B8A8", "roughness": {"base": 0.5, "variation": 0.12, "map": "fish-teal-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.15, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#48B8A8"]}, "localOverrides": [{"zone": "default", "albedo": "#48B8A8", "description": "uniform zone"}]},
    options
  );
  materialMap["porthole-glass"] = createSculptMaterial(
    "porthole-glass",
    {"id": "porthole-glass", "name": "Porthole Glass", "type": "emissive", "baseColor": "#7AC0D8", "roughness": {"base": 0.25, "variation": 0.05, "map": "porthole-glass-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.1, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "plank zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "carved wave swirls", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#7AC0D8"]}, "localOverrides": [{"zone": "default", "albedo": "#7AC0D8", "description": "uniform zone"}], "emissive": "#8CC8E0", "emissiveIntensity": 0.5},
    options
  );

  
  // refine-code: 参考色板
  {
    const set = (id, color, extra) => {
      const m = materialMap[id] as THREE.MeshStandardMaterial | undefined;
      if (m) { m.color.set(color); m.map = null; if (extra) extra(m); m.needsUpdate = true; }
    };
    set("ocean-blue", "#3A7FA8");
    set("ocean-blue-light", "#5AA8C8");
    set("gold-ring", "#C8A040", (m) => { m.metalness = 0.6; m.roughness = 0.35; });
    set("sail-cream", "#F0EBDD");
    set("wood-brown", "#8A6844");
    set("wheel-dark", "#2A2A30", (m) => { m.metalness = 0.2; });
    set("coral-pink", "#E8788A");
    set("seaweed-green", "#6AA84A");
    set("fish-orange", "#E88840");
    set("fish-teal", "#48B8A8");
    set("porthole-glass", "#7AC0D8", (m) => { m.emissive.set("#8CC8E0"); m.emissiveIntensity = 0.6; });
  }

const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_ocean_root_0 = null;
  const endpoint_ocean_root_0 = makeAttachmentEndpoint(attachment_ocean_root_0);
  const node_ocean_root_0 = new THREE.Group();
  node_ocean_root_0.name = "OceanCaravan__pivot";
  node_ocean_root_0.scale.set(1, 1, 1);
  if (endpoint_ocean_root_0) {
    node_ocean_root_0.position.copy(endpoint_ocean_root_0.start);
    node_ocean_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ocean_root_0.position.set(0.0, 0.0, 0.0);
    node_ocean_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_ocean_root_0.userData.sculptComponent = {"id": "ocean-root", "name": "OceanCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "ocean-blue", "evidenceRefs": ["full-object"], "topologyRationale": "OceanCaravan solid geometry attached to None", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 127, 168, 1.0)", "secondaryAlbedo": "rgba(42, 95, 136, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ocean-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_ocean_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ocean-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_ocean_root_0);
  nodes["ocean-root"] = node_ocean_root_0;
  const mesh_ocean_root_0Geometry = endpoint_ocean_root_0
    ? new THREE.CylinderGeometry(endpoint_ocean_root_0.endRadius, endpoint_ocean_root_0.baseRadius, endpoint_ocean_root_0.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_ocean_root_0) {
    mesh_ocean_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ocean_root_0 = new THREE.Mesh(
    mesh_ocean_root_0Geometry,
    materialMap["ocean-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ocean_root_0.name = "OceanCaravan";
  if (endpoint_ocean_root_0) {
    mesh_ocean_root_0.position.copy(endpoint_ocean_root_0.midpoint);
    mesh_ocean_root_0.quaternion.copy(endpoint_ocean_root_0.quaternion);
  }
  mesh_ocean_root_0.castShadow = options.castShadow ?? true;
  mesh_ocean_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_ocean_root_0.visible = false; // 容器节点不渲染
  mesh_ocean_root_0.userData.sculptComponent = {"id": "ocean-root", "name": "OceanCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "ocean-blue", "evidenceRefs": ["full-object"], "topologyRationale": "OceanCaravan solid geometry attached to None", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 127, 168, 1.0)", "secondaryAlbedo": "rgba(42, 95, 136, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "ocean-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_ocean_root_0.add(mesh_ocean_root_0);
  meshes["ocean-root"] = mesh_ocean_root_0;
  colliders["ocean-root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["ocean-root"] ??= [];
  destructionGroups["ocean-root"].push(node_ocean_root_0);

  const endpoint_body_1 = makeAttachmentEndpoint(null);
  const node_body_1 = new THREE.Group();
  node_body_1.name = "Body__pivot";
  node_body_1.scale.set(1, 1, 1);
  if (endpoint_body_1) {
    node_body_1.position.copy(endpoint_body_1.start);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_body_1.position.set(0.0, 1.15, 0.0);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.4, "depth": 1.4, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 1.15, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.4, 1.4]}, "material": "ocean-blue", "evidenceRefs": ["full-object"], "topologyRationale": "Blue plank chest-like body with carved wave swirls", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 127, 168, 1.0)", "secondaryAlbedo": "rgba(42, 95, 136, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "carved wave swirls + plank seams", "strength": 0.35, "scale": 10.0}, "roughnessVariation": {"pattern": "swirl grooves rougher", "amount": 0.15}}};
  node_body_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_body_1);
  nodes["body"] = node_body_1;
  const mesh_body_1Geometry = endpoint_body_1
    ? new THREE.CylinderGeometry(endpoint_body_1.endRadius, endpoint_body_1.baseRadius, endpoint_body_1.length, 32, 12)
    : new RoundedBoxGeometry(3.0, 1.4, 1.4, 4, 0.1);
  if (!endpoint_body_1) {
    mesh_body_1Geometry.scale(1, 1, 1); // 已是最终尺寸
  }
  const mesh_body_1 = new THREE.Mesh(
    mesh_body_1Geometry,
    materialMap["ocean-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_1.name = "Body";
  if (endpoint_body_1) {
    mesh_body_1.position.copy(endpoint_body_1.midpoint);
    mesh_body_1.quaternion.copy(endpoint_body_1.quaternion);
  }
  mesh_body_1.castShadow = options.castShadow ?? true;
  mesh_body_1.receiveShadow = options.receiveShadow ?? true;
  mesh_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.4, "depth": 1.4, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 1.15, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.4, 1.4]}, "material": "ocean-blue", "evidenceRefs": ["full-object"], "topologyRationale": "Blue plank chest-like body with carved wave swirls", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 127, 168, 1.0)", "secondaryAlbedo": "rgba(42, 95, 136, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "carved wave swirls + plank seams", "strength": 0.35, "scale": 10.0}, "roughnessVariation": {"pattern": "swirl grooves rougher", "amount": 0.15}}};
  node_body_1.add(mesh_body_1);
  meshes["body"] = mesh_body_1;
  colliders["body"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_body_1);

  const endpoint_top_rim_2 = makeAttachmentEndpoint(null);
  const node_top_rim_2 = new THREE.Group();
  node_top_rim_2.name = "TopRim__pivot";
  node_top_rim_2.scale.set(1, 1, 1);
  if (endpoint_top_rim_2) {
    node_top_rim_2.position.copy(endpoint_top_rim_2.start);
    node_top_rim_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_top_rim_2.position.set(0.0, 1.92, 0.0);
    node_top_rim_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_top_rim_2.userData.sculptComponent = {"id": "top-rim", "name": "TopRim", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.15, "height": 0.18, "depth": 1.55, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 1.92, 0], "rotation": [0, 0, 0], "scale": [3.15, 0.18, 1.55]}, "material": "ocean-blue-light", "evidenceRefs": ["full-object"], "topologyRationale": "Curved chest-lid rim crowning the body, lighter blue", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 168, 200, 1.0)", "secondaryAlbedo": "rgba(58, 127, 168, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "top-rim", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_top_rim_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "top-rim", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_top_rim_2);
  nodes["top-rim"] = node_top_rim_2;
  const mesh_top_rim_2Geometry = endpoint_top_rim_2
    ? new THREE.CylinderGeometry(endpoint_top_rim_2.endRadius, endpoint_top_rim_2.baseRadius, endpoint_top_rim_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_top_rim_2) {
    mesh_top_rim_2Geometry.scale(3.15, 0.18, 1.55);
  }
  const mesh_top_rim_2 = new THREE.Mesh(
    mesh_top_rim_2Geometry,
    materialMap["ocean-blue-light"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_top_rim_2.name = "TopRim";
  if (endpoint_top_rim_2) {
    mesh_top_rim_2.position.copy(endpoint_top_rim_2.midpoint);
    mesh_top_rim_2.quaternion.copy(endpoint_top_rim_2.quaternion);
  }
  mesh_top_rim_2.castShadow = options.castShadow ?? true;
  mesh_top_rim_2.receiveShadow = options.receiveShadow ?? true;
  mesh_top_rim_2.userData.sculptComponent = {"id": "top-rim", "name": "TopRim", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.15, "height": 0.18, "depth": 1.55, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 1.92, 0], "rotation": [0, 0, 0], "scale": [3.15, 0.18, 1.55]}, "material": "ocean-blue-light", "evidenceRefs": ["full-object"], "topologyRationale": "Curved chest-lid rim crowning the body, lighter blue", "colorMaterialRecipe": {"dominantAlbedo": "rgba(90, 168, 200, 1.0)", "secondaryAlbedo": "rgba(58, 127, 168, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "top-rim", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_top_rim_2.add(mesh_top_rim_2);
  meshes["top-rim"] = mesh_top_rim_2;
  colliders["top-rim"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["top-rim"] ??= [];
  destructionGroups["top-rim"].push(node_top_rim_2);

  const endpoint_porthole_system_3 = makeAttachmentEndpoint(null);
  const node_porthole_system_3 = new THREE.Group();
  node_porthole_system_3.name = "PortholeSystem__pivot";
  node_porthole_system_3.scale.set(1, 1, 1);
  if (endpoint_porthole_system_3) {
    node_porthole_system_3.position.copy(endpoint_porthole_system_3.start);
    node_porthole_system_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_system_3.position.set(0.0, 1.25, 0.0);
    node_porthole_system_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_system_3.userData.sculptComponent = {"id": "porthole-system", "name": "PortholeSystem", "level": "meso", "role": "porthole-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.25, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "PortholeSystem solid geometry attached to ocean-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_system_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_porthole_system_3);
  nodes["porthole-system"] = node_porthole_system_3;
  const mesh_porthole_system_3Geometry = endpoint_porthole_system_3
    ? new THREE.CylinderGeometry(endpoint_porthole_system_3.endRadius, endpoint_porthole_system_3.baseRadius, endpoint_porthole_system_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_porthole_system_3) {
    mesh_porthole_system_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_porthole_system_3 = new THREE.Mesh(
    mesh_porthole_system_3Geometry,
    materialMap["wood-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_system_3.name = "PortholeSystem";
  if (endpoint_porthole_system_3) {
    mesh_porthole_system_3.position.copy(endpoint_porthole_system_3.midpoint);
    mesh_porthole_system_3.quaternion.copy(endpoint_porthole_system_3.quaternion);
  }
  mesh_porthole_system_3.castShadow = options.castShadow ?? true;
  mesh_porthole_system_3.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_system_3.visible = false; // 容器节点不渲染
  mesh_porthole_system_3.userData.sculptComponent = {"id": "porthole-system", "name": "PortholeSystem", "level": "meso", "role": "porthole-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.25, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "PortholeSystem solid geometry attached to ocean-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_system_3.add(mesh_porthole_system_3);
  meshes["porthole-system"] = mesh_porthole_system_3;
  colliders["porthole-system"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-system"] ??= [];
  destructionGroups["porthole-system"].push(node_porthole_system_3);

  const attachment_porthole_01_4 = {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_01_4 = makeAttachmentEndpoint(attachment_porthole_01_4);
  const node_porthole_01_4 = new THREE.Group();
  node_porthole_01_4.name = "Porthole01__pivot";
  node_porthole_01_4.scale.set(1, 1, 1);
  if (endpoint_porthole_01_4) {
    node_porthole_01_4.position.copy(endpoint_porthole_01_4.start);
    node_porthole_01_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_01_4.position.set(-1.05, 0.0, 0.71);
    node_porthole_01_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_01_4.userData.sculptComponent = {"id": "porthole-01", "name": "Porthole01", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.05, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole01 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-system"] ?? root).add(node_porthole_01_4);
  nodes["porthole-01"] = node_porthole_01_4;
  const mesh_porthole_01_4Geometry = endpoint_porthole_01_4
    ? new THREE.CylinderGeometry(endpoint_porthole_01_4.endRadius, endpoint_porthole_01_4.baseRadius, endpoint_porthole_01_4.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_01_4) {
    mesh_porthole_01_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_porthole_01_4 = new THREE.Mesh(
    mesh_porthole_01_4Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_01_4.name = "Porthole01";
  if (endpoint_porthole_01_4) {
    mesh_porthole_01_4.position.copy(endpoint_porthole_01_4.midpoint);
    mesh_porthole_01_4.quaternion.copy(endpoint_porthole_01_4.quaternion);
  }
  mesh_porthole_01_4.castShadow = options.castShadow ?? true;
  mesh_porthole_01_4.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_01_4.visible = false; // 容器节点不渲染
  mesh_porthole_01_4.userData.sculptComponent = {"id": "porthole-01", "name": "Porthole01", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.05, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole01 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_4.add(mesh_porthole_01_4);
  meshes["porthole-01"] = mesh_porthole_01_4;
  colliders["porthole-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-01"] ??= [];
  destructionGroups["porthole-01"].push(node_porthole_01_4);

  const endpoint_porthole_01_ring_5 = makeAttachmentEndpoint(null);
  const node_porthole_01_ring_5 = new THREE.Group();
  node_porthole_01_ring_5.name = "Porthole01Ring__pivot";
  node_porthole_01_ring_5.scale.set(1, 1, 1);
  if (endpoint_porthole_01_ring_5) {
    node_porthole_01_ring_5.position.copy(endpoint_porthole_01_ring_5.start);
    node_porthole_01_ring_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_01_ring_5.position.set(0.0, 0.0, 0.0);
    node_porthole_01_ring_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_01_ring_5.userData.sculptComponent = {"id": "porthole-01-ring", "name": "Porthole01Ring", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-01", "attachment": {"parentId": "porthole-01", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_01_ring_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-01"] ?? root).add(node_porthole_01_ring_5);
  nodes["porthole-01-ring"] = node_porthole_01_ring_5;
  const mesh_porthole_01_ring_5Geometry = endpoint_porthole_01_ring_5
    ? new THREE.CylinderGeometry(endpoint_porthole_01_ring_5.endRadius, endpoint_porthole_01_ring_5.baseRadius, endpoint_porthole_01_ring_5.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_porthole_01_ring_5) {
    mesh_porthole_01_ring_5Geometry.scale(0.5, 0.5, 0.08);
  }
  const mesh_porthole_01_ring_5 = new THREE.Mesh(
    mesh_porthole_01_ring_5Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_01_ring_5.name = "Porthole01Ring";
  if (endpoint_porthole_01_ring_5) {
    mesh_porthole_01_ring_5.position.copy(endpoint_porthole_01_ring_5.midpoint);
    mesh_porthole_01_ring_5.quaternion.copy(endpoint_porthole_01_ring_5.quaternion);
  }
  mesh_porthole_01_ring_5.castShadow = options.castShadow ?? true;
  mesh_porthole_01_ring_5.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_01_ring_5.userData.sculptComponent = {"id": "porthole-01-ring", "name": "Porthole01Ring", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-01", "attachment": {"parentId": "porthole-01", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_01_ring_5.add(mesh_porthole_01_ring_5);
  meshes["porthole-01-ring"] = mesh_porthole_01_ring_5;
  colliders["porthole-01-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-01-ring"] ??= [];
  destructionGroups["porthole-01-ring"].push(node_porthole_01_ring_5);

  const attachment_porthole_01_glass_6 = {"parentId": "porthole-01", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_01_glass_6 = makeAttachmentEndpoint(attachment_porthole_01_glass_6);
  const node_porthole_01_glass_6 = new THREE.Group();
  node_porthole_01_glass_6.name = "Porthole01Glass__pivot";
  node_porthole_01_glass_6.scale.set(1, 1, 1);
  if (endpoint_porthole_01_glass_6) {
    node_porthole_01_glass_6.position.copy(endpoint_porthole_01_glass_6.start);
    node_porthole_01_glass_6.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_porthole_01_glass_6.position.set(0.0, 0.0, 0.03);
    node_porthole_01_glass_6.rotation.set(1.5708, 0.0, 0.0);
  }
  node_porthole_01_glass_6.userData.sculptComponent = {"id": "porthole-01-glass", "name": "Porthole01Glass", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-01", "attachment": {"parentId": "porthole-01", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.03], "rotation": [1.5708, 0, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole01Glass solid geometry attached to porthole-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_glass_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-01"] ?? root).add(node_porthole_01_glass_6);
  nodes["porthole-01-glass"] = node_porthole_01_glass_6;
  const mesh_porthole_01_glass_6Geometry = endpoint_porthole_01_glass_6
    ? new THREE.CylinderGeometry(endpoint_porthole_01_glass_6.endRadius, endpoint_porthole_01_glass_6.baseRadius, endpoint_porthole_01_glass_6.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_01_glass_6) {
    mesh_porthole_01_glass_6Geometry.scale(0.38, 0.04, 0.38);
  }
  const mesh_porthole_01_glass_6 = new THREE.Mesh(
    mesh_porthole_01_glass_6Geometry,
    materialMap["porthole-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_01_glass_6.name = "Porthole01Glass";
  if (endpoint_porthole_01_glass_6) {
    mesh_porthole_01_glass_6.position.copy(endpoint_porthole_01_glass_6.midpoint);
    mesh_porthole_01_glass_6.quaternion.copy(endpoint_porthole_01_glass_6.quaternion);
  }
  mesh_porthole_01_glass_6.castShadow = options.castShadow ?? true;
  mesh_porthole_01_glass_6.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_01_glass_6.userData.sculptComponent = {"id": "porthole-01-glass", "name": "Porthole01Glass", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-01", "attachment": {"parentId": "porthole-01", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.03], "rotation": [1.5708, 0, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole01Glass solid geometry attached to porthole-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_glass_6.add(mesh_porthole_01_glass_6);
  meshes["porthole-01-glass"] = mesh_porthole_01_glass_6;
  colliders["porthole-01-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-01-glass"] ??= [];
  destructionGroups["porthole-01-glass"].push(node_porthole_01_glass_6);

  const attachment_porthole_01_coral_7 = {"parentId": "porthole-01", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_01_coral_7 = makeAttachmentEndpoint(attachment_porthole_01_coral_7);
  const node_porthole_01_coral_7 = new THREE.Group();
  node_porthole_01_coral_7.name = "Porthole01Coral__pivot";
  node_porthole_01_coral_7.scale.set(1, 1, 1);
  if (endpoint_porthole_01_coral_7) {
    node_porthole_01_coral_7.position.copy(endpoint_porthole_01_coral_7.start);
    node_porthole_01_coral_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_01_coral_7.position.set(0.0, 0.34, 0.05);
    node_porthole_01_coral_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_01_coral_7.userData.sculptComponent = {"id": "porthole-01-coral", "name": "Porthole01Coral", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-01", "attachment": {"parentId": "porthole-01", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.34, 0.05], "rotation": [0, 0, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_coral_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-01"] ?? root).add(node_porthole_01_coral_7);
  nodes["porthole-01-coral"] = node_porthole_01_coral_7;
  const mesh_porthole_01_coral_7Geometry = endpoint_porthole_01_coral_7
    ? new THREE.CylinderGeometry(endpoint_porthole_01_coral_7.endRadius, endpoint_porthole_01_coral_7.baseRadius, endpoint_porthole_01_coral_7.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_porthole_01_coral_7) {
    mesh_porthole_01_coral_7Geometry.scale(0.12, 0.18, 0.12);
  }
  const mesh_porthole_01_coral_7 = new THREE.Mesh(
    mesh_porthole_01_coral_7Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_01_coral_7.name = "Porthole01Coral";
  if (endpoint_porthole_01_coral_7) {
    mesh_porthole_01_coral_7.position.copy(endpoint_porthole_01_coral_7.midpoint);
    mesh_porthole_01_coral_7.quaternion.copy(endpoint_porthole_01_coral_7.quaternion);
  }
  mesh_porthole_01_coral_7.castShadow = options.castShadow ?? true;
  mesh_porthole_01_coral_7.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_01_coral_7.userData.sculptComponent = {"id": "porthole-01-coral", "name": "Porthole01Coral", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-01", "attachment": {"parentId": "porthole-01", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.34, 0.05], "rotation": [0, 0, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_coral_7.add(mesh_porthole_01_coral_7);
  meshes["porthole-01-coral"] = mesh_porthole_01_coral_7;
  colliders["porthole-01-coral"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-01-coral"] ??= [];
  destructionGroups["porthole-01-coral"].push(node_porthole_01_coral_7);

  const attachment_porthole_02_8 = {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_02_8 = makeAttachmentEndpoint(attachment_porthole_02_8);
  const node_porthole_02_8 = new THREE.Group();
  node_porthole_02_8.name = "Porthole02__pivot";
  node_porthole_02_8.scale.set(1, 1, 1);
  if (endpoint_porthole_02_8) {
    node_porthole_02_8.position.copy(endpoint_porthole_02_8.start);
    node_porthole_02_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_02_8.position.set(-0.3500000000000001, 0.0, 0.71);
    node_porthole_02_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_02_8.userData.sculptComponent = {"id": "porthole-02", "name": "Porthole02", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.3500000000000001, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole02 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-system"] ?? root).add(node_porthole_02_8);
  nodes["porthole-02"] = node_porthole_02_8;
  const mesh_porthole_02_8Geometry = endpoint_porthole_02_8
    ? new THREE.CylinderGeometry(endpoint_porthole_02_8.endRadius, endpoint_porthole_02_8.baseRadius, endpoint_porthole_02_8.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_02_8) {
    mesh_porthole_02_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_porthole_02_8 = new THREE.Mesh(
    mesh_porthole_02_8Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_02_8.name = "Porthole02";
  if (endpoint_porthole_02_8) {
    mesh_porthole_02_8.position.copy(endpoint_porthole_02_8.midpoint);
    mesh_porthole_02_8.quaternion.copy(endpoint_porthole_02_8.quaternion);
  }
  mesh_porthole_02_8.castShadow = options.castShadow ?? true;
  mesh_porthole_02_8.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_02_8.visible = false; // 容器节点不渲染
  mesh_porthole_02_8.userData.sculptComponent = {"id": "porthole-02", "name": "Porthole02", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.3500000000000001, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole02 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_8.add(mesh_porthole_02_8);
  meshes["porthole-02"] = mesh_porthole_02_8;
  colliders["porthole-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-02"] ??= [];
  destructionGroups["porthole-02"].push(node_porthole_02_8);

  const endpoint_porthole_02_ring_9 = makeAttachmentEndpoint(null);
  const node_porthole_02_ring_9 = new THREE.Group();
  node_porthole_02_ring_9.name = "Porthole02Ring__pivot";
  node_porthole_02_ring_9.scale.set(1, 1, 1);
  if (endpoint_porthole_02_ring_9) {
    node_porthole_02_ring_9.position.copy(endpoint_porthole_02_ring_9.start);
    node_porthole_02_ring_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_02_ring_9.position.set(0.0, 0.0, 0.0);
    node_porthole_02_ring_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_02_ring_9.userData.sculptComponent = {"id": "porthole-02-ring", "name": "Porthole02Ring", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-02", "attachment": {"parentId": "porthole-02", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_02_ring_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-02"] ?? root).add(node_porthole_02_ring_9);
  nodes["porthole-02-ring"] = node_porthole_02_ring_9;
  const mesh_porthole_02_ring_9Geometry = endpoint_porthole_02_ring_9
    ? new THREE.CylinderGeometry(endpoint_porthole_02_ring_9.endRadius, endpoint_porthole_02_ring_9.baseRadius, endpoint_porthole_02_ring_9.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_porthole_02_ring_9) {
    mesh_porthole_02_ring_9Geometry.scale(0.5, 0.5, 0.08);
  }
  const mesh_porthole_02_ring_9 = new THREE.Mesh(
    mesh_porthole_02_ring_9Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_02_ring_9.name = "Porthole02Ring";
  if (endpoint_porthole_02_ring_9) {
    mesh_porthole_02_ring_9.position.copy(endpoint_porthole_02_ring_9.midpoint);
    mesh_porthole_02_ring_9.quaternion.copy(endpoint_porthole_02_ring_9.quaternion);
  }
  mesh_porthole_02_ring_9.castShadow = options.castShadow ?? true;
  mesh_porthole_02_ring_9.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_02_ring_9.userData.sculptComponent = {"id": "porthole-02-ring", "name": "Porthole02Ring", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-02", "attachment": {"parentId": "porthole-02", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_02_ring_9.add(mesh_porthole_02_ring_9);
  meshes["porthole-02-ring"] = mesh_porthole_02_ring_9;
  colliders["porthole-02-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-02-ring"] ??= [];
  destructionGroups["porthole-02-ring"].push(node_porthole_02_ring_9);

  const attachment_porthole_02_glass_10 = {"parentId": "porthole-02", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_02_glass_10 = makeAttachmentEndpoint(attachment_porthole_02_glass_10);
  const node_porthole_02_glass_10 = new THREE.Group();
  node_porthole_02_glass_10.name = "Porthole02Glass__pivot";
  node_porthole_02_glass_10.scale.set(1, 1, 1);
  if (endpoint_porthole_02_glass_10) {
    node_porthole_02_glass_10.position.copy(endpoint_porthole_02_glass_10.start);
    node_porthole_02_glass_10.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_porthole_02_glass_10.position.set(0.0, 0.0, 0.03);
    node_porthole_02_glass_10.rotation.set(1.5708, 0.0, 0.0);
  }
  node_porthole_02_glass_10.userData.sculptComponent = {"id": "porthole-02-glass", "name": "Porthole02Glass", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-02", "attachment": {"parentId": "porthole-02", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.03], "rotation": [1.5708, 0, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole02Glass solid geometry attached to porthole-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_glass_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-02"] ?? root).add(node_porthole_02_glass_10);
  nodes["porthole-02-glass"] = node_porthole_02_glass_10;
  const mesh_porthole_02_glass_10Geometry = endpoint_porthole_02_glass_10
    ? new THREE.CylinderGeometry(endpoint_porthole_02_glass_10.endRadius, endpoint_porthole_02_glass_10.baseRadius, endpoint_porthole_02_glass_10.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_02_glass_10) {
    mesh_porthole_02_glass_10Geometry.scale(0.38, 0.04, 0.38);
  }
  const mesh_porthole_02_glass_10 = new THREE.Mesh(
    mesh_porthole_02_glass_10Geometry,
    materialMap["porthole-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_02_glass_10.name = "Porthole02Glass";
  if (endpoint_porthole_02_glass_10) {
    mesh_porthole_02_glass_10.position.copy(endpoint_porthole_02_glass_10.midpoint);
    mesh_porthole_02_glass_10.quaternion.copy(endpoint_porthole_02_glass_10.quaternion);
  }
  mesh_porthole_02_glass_10.castShadow = options.castShadow ?? true;
  mesh_porthole_02_glass_10.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_02_glass_10.userData.sculptComponent = {"id": "porthole-02-glass", "name": "Porthole02Glass", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-02", "attachment": {"parentId": "porthole-02", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.03], "rotation": [1.5708, 0, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole02Glass solid geometry attached to porthole-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_glass_10.add(mesh_porthole_02_glass_10);
  meshes["porthole-02-glass"] = mesh_porthole_02_glass_10;
  colliders["porthole-02-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-02-glass"] ??= [];
  destructionGroups["porthole-02-glass"].push(node_porthole_02_glass_10);

  const attachment_porthole_02_coral_11 = {"parentId": "porthole-02", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_02_coral_11 = makeAttachmentEndpoint(attachment_porthole_02_coral_11);
  const node_porthole_02_coral_11 = new THREE.Group();
  node_porthole_02_coral_11.name = "Porthole02Coral__pivot";
  node_porthole_02_coral_11.scale.set(1, 1, 1);
  if (endpoint_porthole_02_coral_11) {
    node_porthole_02_coral_11.position.copy(endpoint_porthole_02_coral_11.start);
    node_porthole_02_coral_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_02_coral_11.position.set(0.0, 0.34, 0.05);
    node_porthole_02_coral_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_02_coral_11.userData.sculptComponent = {"id": "porthole-02-coral", "name": "Porthole02Coral", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-02", "attachment": {"parentId": "porthole-02", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.34, 0.05], "rotation": [0, 0, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_coral_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-02"] ?? root).add(node_porthole_02_coral_11);
  nodes["porthole-02-coral"] = node_porthole_02_coral_11;
  const mesh_porthole_02_coral_11Geometry = endpoint_porthole_02_coral_11
    ? new THREE.CylinderGeometry(endpoint_porthole_02_coral_11.endRadius, endpoint_porthole_02_coral_11.baseRadius, endpoint_porthole_02_coral_11.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_porthole_02_coral_11) {
    mesh_porthole_02_coral_11Geometry.scale(0.12, 0.18, 0.12);
  }
  const mesh_porthole_02_coral_11 = new THREE.Mesh(
    mesh_porthole_02_coral_11Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_02_coral_11.name = "Porthole02Coral";
  if (endpoint_porthole_02_coral_11) {
    mesh_porthole_02_coral_11.position.copy(endpoint_porthole_02_coral_11.midpoint);
    mesh_porthole_02_coral_11.quaternion.copy(endpoint_porthole_02_coral_11.quaternion);
  }
  mesh_porthole_02_coral_11.castShadow = options.castShadow ?? true;
  mesh_porthole_02_coral_11.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_02_coral_11.userData.sculptComponent = {"id": "porthole-02-coral", "name": "Porthole02Coral", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-02", "attachment": {"parentId": "porthole-02", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.34, 0.05], "rotation": [0, 0, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_coral_11.add(mesh_porthole_02_coral_11);
  meshes["porthole-02-coral"] = mesh_porthole_02_coral_11;
  colliders["porthole-02-coral"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-02-coral"] ??= [];
  destructionGroups["porthole-02-coral"].push(node_porthole_02_coral_11);

  const attachment_porthole_03_12 = {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_03_12 = makeAttachmentEndpoint(attachment_porthole_03_12);
  const node_porthole_03_12 = new THREE.Group();
  node_porthole_03_12.name = "Porthole03__pivot";
  node_porthole_03_12.scale.set(1, 1, 1);
  if (endpoint_porthole_03_12) {
    node_porthole_03_12.position.copy(endpoint_porthole_03_12.start);
    node_porthole_03_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_03_12.position.set(0.34999999999999987, 0.0, 0.71);
    node_porthole_03_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_03_12.userData.sculptComponent = {"id": "porthole-03", "name": "Porthole03", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.34999999999999987, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole03 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-system"] ?? root).add(node_porthole_03_12);
  nodes["porthole-03"] = node_porthole_03_12;
  const mesh_porthole_03_12Geometry = endpoint_porthole_03_12
    ? new THREE.CylinderGeometry(endpoint_porthole_03_12.endRadius, endpoint_porthole_03_12.baseRadius, endpoint_porthole_03_12.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_03_12) {
    mesh_porthole_03_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_porthole_03_12 = new THREE.Mesh(
    mesh_porthole_03_12Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_03_12.name = "Porthole03";
  if (endpoint_porthole_03_12) {
    mesh_porthole_03_12.position.copy(endpoint_porthole_03_12.midpoint);
    mesh_porthole_03_12.quaternion.copy(endpoint_porthole_03_12.quaternion);
  }
  mesh_porthole_03_12.castShadow = options.castShadow ?? true;
  mesh_porthole_03_12.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_03_12.visible = false; // 容器节点不渲染
  mesh_porthole_03_12.userData.sculptComponent = {"id": "porthole-03", "name": "Porthole03", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.34999999999999987, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole03 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_12.add(mesh_porthole_03_12);
  meshes["porthole-03"] = mesh_porthole_03_12;
  colliders["porthole-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-03"] ??= [];
  destructionGroups["porthole-03"].push(node_porthole_03_12);

  const endpoint_porthole_03_ring_13 = makeAttachmentEndpoint(null);
  const node_porthole_03_ring_13 = new THREE.Group();
  node_porthole_03_ring_13.name = "Porthole03Ring__pivot";
  node_porthole_03_ring_13.scale.set(1, 1, 1);
  if (endpoint_porthole_03_ring_13) {
    node_porthole_03_ring_13.position.copy(endpoint_porthole_03_ring_13.start);
    node_porthole_03_ring_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_03_ring_13.position.set(0.0, 0.0, 0.0);
    node_porthole_03_ring_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_03_ring_13.userData.sculptComponent = {"id": "porthole-03-ring", "name": "Porthole03Ring", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-03", "attachment": {"parentId": "porthole-03", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_03_ring_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-03"] ?? root).add(node_porthole_03_ring_13);
  nodes["porthole-03-ring"] = node_porthole_03_ring_13;
  const mesh_porthole_03_ring_13Geometry = endpoint_porthole_03_ring_13
    ? new THREE.CylinderGeometry(endpoint_porthole_03_ring_13.endRadius, endpoint_porthole_03_ring_13.baseRadius, endpoint_porthole_03_ring_13.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_porthole_03_ring_13) {
    mesh_porthole_03_ring_13Geometry.scale(0.5, 0.5, 0.08);
  }
  const mesh_porthole_03_ring_13 = new THREE.Mesh(
    mesh_porthole_03_ring_13Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_03_ring_13.name = "Porthole03Ring";
  if (endpoint_porthole_03_ring_13) {
    mesh_porthole_03_ring_13.position.copy(endpoint_porthole_03_ring_13.midpoint);
    mesh_porthole_03_ring_13.quaternion.copy(endpoint_porthole_03_ring_13.quaternion);
  }
  mesh_porthole_03_ring_13.castShadow = options.castShadow ?? true;
  mesh_porthole_03_ring_13.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_03_ring_13.userData.sculptComponent = {"id": "porthole-03-ring", "name": "Porthole03Ring", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-03", "attachment": {"parentId": "porthole-03", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_03_ring_13.add(mesh_porthole_03_ring_13);
  meshes["porthole-03-ring"] = mesh_porthole_03_ring_13;
  colliders["porthole-03-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-03-ring"] ??= [];
  destructionGroups["porthole-03-ring"].push(node_porthole_03_ring_13);

  const attachment_porthole_03_glass_14 = {"parentId": "porthole-03", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_03_glass_14 = makeAttachmentEndpoint(attachment_porthole_03_glass_14);
  const node_porthole_03_glass_14 = new THREE.Group();
  node_porthole_03_glass_14.name = "Porthole03Glass__pivot";
  node_porthole_03_glass_14.scale.set(1, 1, 1);
  if (endpoint_porthole_03_glass_14) {
    node_porthole_03_glass_14.position.copy(endpoint_porthole_03_glass_14.start);
    node_porthole_03_glass_14.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_porthole_03_glass_14.position.set(0.0, 0.0, 0.03);
    node_porthole_03_glass_14.rotation.set(1.5708, 0.0, 0.0);
  }
  node_porthole_03_glass_14.userData.sculptComponent = {"id": "porthole-03-glass", "name": "Porthole03Glass", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-03", "attachment": {"parentId": "porthole-03", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.03], "rotation": [1.5708, 0, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole03Glass solid geometry attached to porthole-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_glass_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-03"] ?? root).add(node_porthole_03_glass_14);
  nodes["porthole-03-glass"] = node_porthole_03_glass_14;
  const mesh_porthole_03_glass_14Geometry = endpoint_porthole_03_glass_14
    ? new THREE.CylinderGeometry(endpoint_porthole_03_glass_14.endRadius, endpoint_porthole_03_glass_14.baseRadius, endpoint_porthole_03_glass_14.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_03_glass_14) {
    mesh_porthole_03_glass_14Geometry.scale(0.38, 0.04, 0.38);
  }
  const mesh_porthole_03_glass_14 = new THREE.Mesh(
    mesh_porthole_03_glass_14Geometry,
    materialMap["porthole-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_03_glass_14.name = "Porthole03Glass";
  if (endpoint_porthole_03_glass_14) {
    mesh_porthole_03_glass_14.position.copy(endpoint_porthole_03_glass_14.midpoint);
    mesh_porthole_03_glass_14.quaternion.copy(endpoint_porthole_03_glass_14.quaternion);
  }
  mesh_porthole_03_glass_14.castShadow = options.castShadow ?? true;
  mesh_porthole_03_glass_14.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_03_glass_14.userData.sculptComponent = {"id": "porthole-03-glass", "name": "Porthole03Glass", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-03", "attachment": {"parentId": "porthole-03", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.03], "rotation": [1.5708, 0, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole03Glass solid geometry attached to porthole-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_glass_14.add(mesh_porthole_03_glass_14);
  meshes["porthole-03-glass"] = mesh_porthole_03_glass_14;
  colliders["porthole-03-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-03-glass"] ??= [];
  destructionGroups["porthole-03-glass"].push(node_porthole_03_glass_14);

  const attachment_porthole_03_coral_15 = {"parentId": "porthole-03", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_03_coral_15 = makeAttachmentEndpoint(attachment_porthole_03_coral_15);
  const node_porthole_03_coral_15 = new THREE.Group();
  node_porthole_03_coral_15.name = "Porthole03Coral__pivot";
  node_porthole_03_coral_15.scale.set(1, 1, 1);
  if (endpoint_porthole_03_coral_15) {
    node_porthole_03_coral_15.position.copy(endpoint_porthole_03_coral_15.start);
    node_porthole_03_coral_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_03_coral_15.position.set(0.0, 0.34, 0.05);
    node_porthole_03_coral_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_03_coral_15.userData.sculptComponent = {"id": "porthole-03-coral", "name": "Porthole03Coral", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-03", "attachment": {"parentId": "porthole-03", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.34, 0.05], "rotation": [0, 0, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_coral_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-03"] ?? root).add(node_porthole_03_coral_15);
  nodes["porthole-03-coral"] = node_porthole_03_coral_15;
  const mesh_porthole_03_coral_15Geometry = endpoint_porthole_03_coral_15
    ? new THREE.CylinderGeometry(endpoint_porthole_03_coral_15.endRadius, endpoint_porthole_03_coral_15.baseRadius, endpoint_porthole_03_coral_15.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_porthole_03_coral_15) {
    mesh_porthole_03_coral_15Geometry.scale(0.12, 0.18, 0.12);
  }
  const mesh_porthole_03_coral_15 = new THREE.Mesh(
    mesh_porthole_03_coral_15Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_03_coral_15.name = "Porthole03Coral";
  if (endpoint_porthole_03_coral_15) {
    mesh_porthole_03_coral_15.position.copy(endpoint_porthole_03_coral_15.midpoint);
    mesh_porthole_03_coral_15.quaternion.copy(endpoint_porthole_03_coral_15.quaternion);
  }
  mesh_porthole_03_coral_15.castShadow = options.castShadow ?? true;
  mesh_porthole_03_coral_15.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_03_coral_15.userData.sculptComponent = {"id": "porthole-03-coral", "name": "Porthole03Coral", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-03", "attachment": {"parentId": "porthole-03", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.34, 0.05], "rotation": [0, 0, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_coral_15.add(mesh_porthole_03_coral_15);
  meshes["porthole-03-coral"] = mesh_porthole_03_coral_15;
  colliders["porthole-03-coral"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-03-coral"] ??= [];
  destructionGroups["porthole-03-coral"].push(node_porthole_03_coral_15);

  const attachment_porthole_04_16 = {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_04_16 = makeAttachmentEndpoint(attachment_porthole_04_16);
  const node_porthole_04_16 = new THREE.Group();
  node_porthole_04_16.name = "Porthole04__pivot";
  node_porthole_04_16.scale.set(1, 1, 1);
  if (endpoint_porthole_04_16) {
    node_porthole_04_16.position.copy(endpoint_porthole_04_16.start);
    node_porthole_04_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_04_16.position.set(1.0499999999999996, 0.0, 0.71);
    node_porthole_04_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_04_16.userData.sculptComponent = {"id": "porthole-04", "name": "Porthole04", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.0499999999999996, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole04 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-system"] ?? root).add(node_porthole_04_16);
  nodes["porthole-04"] = node_porthole_04_16;
  const mesh_porthole_04_16Geometry = endpoint_porthole_04_16
    ? new THREE.CylinderGeometry(endpoint_porthole_04_16.endRadius, endpoint_porthole_04_16.baseRadius, endpoint_porthole_04_16.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_04_16) {
    mesh_porthole_04_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_porthole_04_16 = new THREE.Mesh(
    mesh_porthole_04_16Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_04_16.name = "Porthole04";
  if (endpoint_porthole_04_16) {
    mesh_porthole_04_16.position.copy(endpoint_porthole_04_16.midpoint);
    mesh_porthole_04_16.quaternion.copy(endpoint_porthole_04_16.quaternion);
  }
  mesh_porthole_04_16.castShadow = options.castShadow ?? true;
  mesh_porthole_04_16.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_04_16.visible = false; // 容器节点不渲染
  mesh_porthole_04_16.userData.sculptComponent = {"id": "porthole-04", "name": "Porthole04", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.0499999999999996, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole04 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_16.add(mesh_porthole_04_16);
  meshes["porthole-04"] = mesh_porthole_04_16;
  colliders["porthole-04"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-04"] ??= [];
  destructionGroups["porthole-04"].push(node_porthole_04_16);

  const endpoint_porthole_04_ring_17 = makeAttachmentEndpoint(null);
  const node_porthole_04_ring_17 = new THREE.Group();
  node_porthole_04_ring_17.name = "Porthole04Ring__pivot";
  node_porthole_04_ring_17.scale.set(1, 1, 1);
  if (endpoint_porthole_04_ring_17) {
    node_porthole_04_ring_17.position.copy(endpoint_porthole_04_ring_17.start);
    node_porthole_04_ring_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_04_ring_17.position.set(0.0, 0.0, 0.0);
    node_porthole_04_ring_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_04_ring_17.userData.sculptComponent = {"id": "porthole-04-ring", "name": "Porthole04Ring", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-04", "attachment": {"parentId": "porthole-04", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_04_ring_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-04"] ?? root).add(node_porthole_04_ring_17);
  nodes["porthole-04-ring"] = node_porthole_04_ring_17;
  const mesh_porthole_04_ring_17Geometry = endpoint_porthole_04_ring_17
    ? new THREE.CylinderGeometry(endpoint_porthole_04_ring_17.endRadius, endpoint_porthole_04_ring_17.baseRadius, endpoint_porthole_04_ring_17.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_porthole_04_ring_17) {
    mesh_porthole_04_ring_17Geometry.scale(0.5, 0.5, 0.08);
  }
  const mesh_porthole_04_ring_17 = new THREE.Mesh(
    mesh_porthole_04_ring_17Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_04_ring_17.name = "Porthole04Ring";
  if (endpoint_porthole_04_ring_17) {
    mesh_porthole_04_ring_17.position.copy(endpoint_porthole_04_ring_17.midpoint);
    mesh_porthole_04_ring_17.quaternion.copy(endpoint_porthole_04_ring_17.quaternion);
  }
  mesh_porthole_04_ring_17.castShadow = options.castShadow ?? true;
  mesh_porthole_04_ring_17.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_04_ring_17.userData.sculptComponent = {"id": "porthole-04-ring", "name": "Porthole04Ring", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-04", "attachment": {"parentId": "porthole-04", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_04_ring_17.add(mesh_porthole_04_ring_17);
  meshes["porthole-04-ring"] = mesh_porthole_04_ring_17;
  colliders["porthole-04-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-04-ring"] ??= [];
  destructionGroups["porthole-04-ring"].push(node_porthole_04_ring_17);

  const attachment_porthole_04_glass_18 = {"parentId": "porthole-04", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_04_glass_18 = makeAttachmentEndpoint(attachment_porthole_04_glass_18);
  const node_porthole_04_glass_18 = new THREE.Group();
  node_porthole_04_glass_18.name = "Porthole04Glass__pivot";
  node_porthole_04_glass_18.scale.set(1, 1, 1);
  if (endpoint_porthole_04_glass_18) {
    node_porthole_04_glass_18.position.copy(endpoint_porthole_04_glass_18.start);
    node_porthole_04_glass_18.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_porthole_04_glass_18.position.set(0.0, 0.0, 0.03);
    node_porthole_04_glass_18.rotation.set(1.5708, 0.0, 0.0);
  }
  node_porthole_04_glass_18.userData.sculptComponent = {"id": "porthole-04-glass", "name": "Porthole04Glass", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-04", "attachment": {"parentId": "porthole-04", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.03], "rotation": [1.5708, 0, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole04Glass solid geometry attached to porthole-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_glass_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-04"] ?? root).add(node_porthole_04_glass_18);
  nodes["porthole-04-glass"] = node_porthole_04_glass_18;
  const mesh_porthole_04_glass_18Geometry = endpoint_porthole_04_glass_18
    ? new THREE.CylinderGeometry(endpoint_porthole_04_glass_18.endRadius, endpoint_porthole_04_glass_18.baseRadius, endpoint_porthole_04_glass_18.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_04_glass_18) {
    mesh_porthole_04_glass_18Geometry.scale(0.38, 0.04, 0.38);
  }
  const mesh_porthole_04_glass_18 = new THREE.Mesh(
    mesh_porthole_04_glass_18Geometry,
    materialMap["porthole-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_04_glass_18.name = "Porthole04Glass";
  if (endpoint_porthole_04_glass_18) {
    mesh_porthole_04_glass_18.position.copy(endpoint_porthole_04_glass_18.midpoint);
    mesh_porthole_04_glass_18.quaternion.copy(endpoint_porthole_04_glass_18.quaternion);
  }
  mesh_porthole_04_glass_18.castShadow = options.castShadow ?? true;
  mesh_porthole_04_glass_18.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_04_glass_18.userData.sculptComponent = {"id": "porthole-04-glass", "name": "Porthole04Glass", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-04", "attachment": {"parentId": "porthole-04", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.03], "rotation": [1.5708, 0, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole04Glass solid geometry attached to porthole-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_glass_18.add(mesh_porthole_04_glass_18);
  meshes["porthole-04-glass"] = mesh_porthole_04_glass_18;
  colliders["porthole-04-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-04-glass"] ??= [];
  destructionGroups["porthole-04-glass"].push(node_porthole_04_glass_18);

  const attachment_porthole_04_coral_19 = {"parentId": "porthole-04", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_04_coral_19 = makeAttachmentEndpoint(attachment_porthole_04_coral_19);
  const node_porthole_04_coral_19 = new THREE.Group();
  node_porthole_04_coral_19.name = "Porthole04Coral__pivot";
  node_porthole_04_coral_19.scale.set(1, 1, 1);
  if (endpoint_porthole_04_coral_19) {
    node_porthole_04_coral_19.position.copy(endpoint_porthole_04_coral_19.start);
    node_porthole_04_coral_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_porthole_04_coral_19.position.set(0.0, 0.34, 0.05);
    node_porthole_04_coral_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_porthole_04_coral_19.userData.sculptComponent = {"id": "porthole-04-coral", "name": "Porthole04Coral", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-04", "attachment": {"parentId": "porthole-04", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.34, 0.05], "rotation": [0, 0, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_coral_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-04"] ?? root).add(node_porthole_04_coral_19);
  nodes["porthole-04-coral"] = node_porthole_04_coral_19;
  const mesh_porthole_04_coral_19Geometry = endpoint_porthole_04_coral_19
    ? new THREE.CylinderGeometry(endpoint_porthole_04_coral_19.endRadius, endpoint_porthole_04_coral_19.baseRadius, endpoint_porthole_04_coral_19.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_porthole_04_coral_19) {
    mesh_porthole_04_coral_19Geometry.scale(0.12, 0.18, 0.12);
  }
  const mesh_porthole_04_coral_19 = new THREE.Mesh(
    mesh_porthole_04_coral_19Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_04_coral_19.name = "Porthole04Coral";
  if (endpoint_porthole_04_coral_19) {
    mesh_porthole_04_coral_19.position.copy(endpoint_porthole_04_coral_19.midpoint);
    mesh_porthole_04_coral_19.quaternion.copy(endpoint_porthole_04_coral_19.quaternion);
  }
  mesh_porthole_04_coral_19.castShadow = options.castShadow ?? true;
  mesh_porthole_04_coral_19.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_04_coral_19.userData.sculptComponent = {"id": "porthole-04-coral", "name": "Porthole04Coral", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-04", "attachment": {"parentId": "porthole-04", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.34, 0.05], "rotation": [0, 0, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_coral_19.add(mesh_porthole_04_coral_19);
  meshes["porthole-04-coral"] = mesh_porthole_04_coral_19;
  colliders["porthole-04-coral"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-04-coral"] ??= [];
  destructionGroups["porthole-04-coral"].push(node_porthole_04_coral_19);

  const attachment_mast_left_20 = {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_mast_left_20 = makeAttachmentEndpoint(attachment_mast_left_20);
  const node_mast_left_20 = new THREE.Group();
  node_mast_left_20.name = "MastLeft__pivot";
  node_mast_left_20.scale.set(1, 1, 1);
  if (endpoint_mast_left_20) {
    node_mast_left_20.position.copy(endpoint_mast_left_20.start);
    node_mast_left_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mast_left_20.position.set(-0.7, 2.35, 0.0);
    node_mast_left_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_mast_left_20.userData.sculptComponent = {"id": "mast-left", "name": "MastLeft", "level": "meso", "role": "mast", "importance": 0.8, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 1.1, "depth": 0.08, "units": "world", "confidence": 0.88}, "transform": {"position": [-0.7, 2.35, 0], "rotation": [0, 0, 0], "scale": [0.08, 1.1, 0.08]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden mast rising from the roof", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_mast_left_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_mast_left_20);
  nodes["mast-left"] = node_mast_left_20;
  const mesh_mast_left_20Geometry = endpoint_mast_left_20
    ? new THREE.CylinderGeometry(endpoint_mast_left_20.endRadius, endpoint_mast_left_20.baseRadius, endpoint_mast_left_20.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_mast_left_20) {
    mesh_mast_left_20Geometry.scale(0.08, 1.1, 0.08);
  }
  const mesh_mast_left_20 = new THREE.Mesh(
    mesh_mast_left_20Geometry,
    materialMap["wood-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mast_left_20.name = "MastLeft";
  if (endpoint_mast_left_20) {
    mesh_mast_left_20.position.copy(endpoint_mast_left_20.midpoint);
    mesh_mast_left_20.quaternion.copy(endpoint_mast_left_20.quaternion);
  }
  mesh_mast_left_20.castShadow = options.castShadow ?? true;
  mesh_mast_left_20.receiveShadow = options.receiveShadow ?? true;
  mesh_mast_left_20.userData.sculptComponent = {"id": "mast-left", "name": "MastLeft", "level": "meso", "role": "mast", "importance": 0.8, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 1.1, "depth": 0.08, "units": "world", "confidence": 0.88}, "transform": {"position": [-0.7, 2.35, 0], "rotation": [0, 0, 0], "scale": [0.08, 1.1, 0.08]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden mast rising from the roof", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_mast_left_20.add(mesh_mast_left_20);
  meshes["mast-left"] = mesh_mast_left_20;
  colliders["mast-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["mast-left"] ??= [];
  destructionGroups["mast-left"].push(node_mast_left_20);

  const attachment_mast_left_yard_21 = {"parentId": "mast-left", "parentSocket": "mast-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_mast_left_yard_21 = makeAttachmentEndpoint(attachment_mast_left_yard_21);
  const node_mast_left_yard_21 = new THREE.Group();
  node_mast_left_yard_21.name = "YardLeft__pivot";
  node_mast_left_yard_21.scale.set(1, 1, 1);
  if (endpoint_mast_left_yard_21) {
    node_mast_left_yard_21.position.copy(endpoint_mast_left_yard_21.start);
    node_mast_left_yard_21.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_mast_left_yard_21.position.set(0.0, 0.25, 0.0);
    node_mast_left_yard_21.rotation.set(0.0, 0.0, 1.5708);
  }
  node_mast_left_yard_21.userData.sculptComponent = {"id": "mast-left-yard", "name": "YardLeft", "level": "meso", "role": "spar", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "mast-left", "attachment": {"parentId": "mast-left", "parentSocket": "mast-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.9, "height": 0.05, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.25, 0], "rotation": [0, 0, 1.5708], "scale": [0.9, 0.05, 0.05]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "YardLeft solid geometry attached to mast-left", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-left-yard", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_mast_left_yard_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-left-yard", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["mast-left"] ?? root).add(node_mast_left_yard_21);
  nodes["mast-left-yard"] = node_mast_left_yard_21;
  const mesh_mast_left_yard_21Geometry = endpoint_mast_left_yard_21
    ? new THREE.CylinderGeometry(endpoint_mast_left_yard_21.endRadius, endpoint_mast_left_yard_21.baseRadius, endpoint_mast_left_yard_21.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_mast_left_yard_21) {
    mesh_mast_left_yard_21Geometry.scale(0.9, 0.05, 0.05);
  }
  const mesh_mast_left_yard_21 = new THREE.Mesh(
    mesh_mast_left_yard_21Geometry,
    materialMap["wood-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mast_left_yard_21.name = "YardLeft";
  if (endpoint_mast_left_yard_21) {
    mesh_mast_left_yard_21.position.copy(endpoint_mast_left_yard_21.midpoint);
    mesh_mast_left_yard_21.quaternion.copy(endpoint_mast_left_yard_21.quaternion);
  }
  mesh_mast_left_yard_21.castShadow = options.castShadow ?? true;
  mesh_mast_left_yard_21.receiveShadow = options.receiveShadow ?? true;
  mesh_mast_left_yard_21.userData.sculptComponent = {"id": "mast-left-yard", "name": "YardLeft", "level": "meso", "role": "spar", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "mast-left", "attachment": {"parentId": "mast-left", "parentSocket": "mast-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.9, "height": 0.05, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.25, 0], "rotation": [0, 0, 1.5708], "scale": [0.9, 0.05, 0.05]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "YardLeft solid geometry attached to mast-left", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-left-yard", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_mast_left_yard_21.add(mesh_mast_left_yard_21);
  meshes["mast-left-yard"] = mesh_mast_left_yard_21;
  colliders["mast-left-yard"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["mast-left-yard"] ??= [];
  destructionGroups["mast-left-yard"].push(node_mast_left_yard_21);

  const attachment_sail_left_22 = {"parentId": "mast-left", "parentSocket": "mast-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_sail_left_22 = makeAttachmentEndpoint(attachment_sail_left_22);
  const node_sail_left_22 = new THREE.Group();
  node_sail_left_22.name = "SailLeft__pivot";
  node_sail_left_22.scale.set(1, 1, 1);
  if (endpoint_sail_left_22) {
    node_sail_left_22.position.copy(endpoint_sail_left_22.start);
    node_sail_left_22.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_sail_left_22.position.set(-0.3, 0.05, 0.0);
    node_sail_left_22.rotation.set(0.0, 0.0, 1.5708);
  }
  node_sail_left_22.userData.sculptComponent = {"id": "sail-left", "name": "SailLeft", "level": "meso", "role": "sail", "importance": 0.8, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "mast-left", "attachment": {"parentId": "mast-left", "parentSocket": "mast-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.85, "height": 0.55, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.3, 0.05, 0], "rotation": [0, 0, 1.5708], "scale": [0.85, 0.55, 0.03]}, "material": "sail-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Triangular cream sail with wave pattern", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 235, 221, 1.0)", "secondaryAlbedo": "rgba(216, 208, 188, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_sail_left_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["mast-left"] ?? root).add(node_sail_left_22);
  nodes["sail-left"] = node_sail_left_22;
  const mesh_sail_left_22Geometry = endpoint_sail_left_22
    ? new THREE.CylinderGeometry(endpoint_sail_left_22.endRadius, endpoint_sail_left_22.baseRadius, endpoint_sail_left_22.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_sail_left_22) {
    mesh_sail_left_22Geometry.scale(0.85, 0.55, 0.03);
  }
  const mesh_sail_left_22 = new THREE.Mesh(
    mesh_sail_left_22Geometry,
    materialMap["sail-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sail_left_22.name = "SailLeft";
  if (endpoint_sail_left_22) {
    mesh_sail_left_22.position.copy(endpoint_sail_left_22.midpoint);
    mesh_sail_left_22.quaternion.copy(endpoint_sail_left_22.quaternion);
  }
  mesh_sail_left_22.castShadow = options.castShadow ?? true;
  mesh_sail_left_22.receiveShadow = options.receiveShadow ?? true;
  mesh_sail_left_22.userData.sculptComponent = {"id": "sail-left", "name": "SailLeft", "level": "meso", "role": "sail", "importance": 0.8, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "mast-left", "attachment": {"parentId": "mast-left", "parentSocket": "mast-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.85, "height": 0.55, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.3, 0.05, 0], "rotation": [0, 0, 1.5708], "scale": [0.85, 0.55, 0.03]}, "material": "sail-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Triangular cream sail with wave pattern", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 235, 221, 1.0)", "secondaryAlbedo": "rgba(216, 208, 188, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_sail_left_22.add(mesh_sail_left_22);
  meshes["sail-left"] = mesh_sail_left_22;
  colliders["sail-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sail-left"] ??= [];
  destructionGroups["sail-left"].push(node_sail_left_22);

  const attachment_mast_right_23 = {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_mast_right_23 = makeAttachmentEndpoint(attachment_mast_right_23);
  const node_mast_right_23 = new THREE.Group();
  node_mast_right_23.name = "MastRight__pivot";
  node_mast_right_23.scale.set(1, 1, 1);
  if (endpoint_mast_right_23) {
    node_mast_right_23.position.copy(endpoint_mast_right_23.start);
    node_mast_right_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mast_right_23.position.set(0.7, 2.35, 0.0);
    node_mast_right_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_mast_right_23.userData.sculptComponent = {"id": "mast-right", "name": "MastRight", "level": "meso", "role": "mast", "importance": 0.8, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 1.1, "depth": 0.08, "units": "world", "confidence": 0.88}, "transform": {"position": [0.7, 2.35, 0], "rotation": [0, 0, 0], "scale": [0.08, 1.1, 0.08]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden mast rising from the roof", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_mast_right_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_mast_right_23);
  nodes["mast-right"] = node_mast_right_23;
  const mesh_mast_right_23Geometry = endpoint_mast_right_23
    ? new THREE.CylinderGeometry(endpoint_mast_right_23.endRadius, endpoint_mast_right_23.baseRadius, endpoint_mast_right_23.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_mast_right_23) {
    mesh_mast_right_23Geometry.scale(0.08, 1.1, 0.08);
  }
  const mesh_mast_right_23 = new THREE.Mesh(
    mesh_mast_right_23Geometry,
    materialMap["wood-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mast_right_23.name = "MastRight";
  if (endpoint_mast_right_23) {
    mesh_mast_right_23.position.copy(endpoint_mast_right_23.midpoint);
    mesh_mast_right_23.quaternion.copy(endpoint_mast_right_23.quaternion);
  }
  mesh_mast_right_23.castShadow = options.castShadow ?? true;
  mesh_mast_right_23.receiveShadow = options.receiveShadow ?? true;
  mesh_mast_right_23.userData.sculptComponent = {"id": "mast-right", "name": "MastRight", "level": "meso", "role": "mast", "importance": 0.8, "confidence": 0.88, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 1.1, "depth": 0.08, "units": "world", "confidence": 0.88}, "transform": {"position": [0.7, 2.35, 0], "rotation": [0, 0, 0], "scale": [0.08, 1.1, 0.08]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden mast rising from the roof", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_mast_right_23.add(mesh_mast_right_23);
  meshes["mast-right"] = mesh_mast_right_23;
  colliders["mast-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["mast-right"] ??= [];
  destructionGroups["mast-right"].push(node_mast_right_23);

  const attachment_mast_right_yard_24 = {"parentId": "mast-right", "parentSocket": "mast-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_mast_right_yard_24 = makeAttachmentEndpoint(attachment_mast_right_yard_24);
  const node_mast_right_yard_24 = new THREE.Group();
  node_mast_right_yard_24.name = "YardRight__pivot";
  node_mast_right_yard_24.scale.set(1, 1, 1);
  if (endpoint_mast_right_yard_24) {
    node_mast_right_yard_24.position.copy(endpoint_mast_right_yard_24.start);
    node_mast_right_yard_24.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_mast_right_yard_24.position.set(0.0, 0.25, 0.0);
    node_mast_right_yard_24.rotation.set(0.0, 0.0, 1.5708);
  }
  node_mast_right_yard_24.userData.sculptComponent = {"id": "mast-right-yard", "name": "YardRight", "level": "meso", "role": "spar", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "mast-right", "attachment": {"parentId": "mast-right", "parentSocket": "mast-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.9, "height": 0.05, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.25, 0], "rotation": [0, 0, 1.5708], "scale": [0.9, 0.05, 0.05]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "YardRight solid geometry attached to mast-right", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-right-yard", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_mast_right_yard_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-right-yard", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["mast-right"] ?? root).add(node_mast_right_yard_24);
  nodes["mast-right-yard"] = node_mast_right_yard_24;
  const mesh_mast_right_yard_24Geometry = endpoint_mast_right_yard_24
    ? new THREE.CylinderGeometry(endpoint_mast_right_yard_24.endRadius, endpoint_mast_right_yard_24.baseRadius, endpoint_mast_right_yard_24.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_mast_right_yard_24) {
    mesh_mast_right_yard_24Geometry.scale(0.9, 0.05, 0.05);
  }
  const mesh_mast_right_yard_24 = new THREE.Mesh(
    mesh_mast_right_yard_24Geometry,
    materialMap["wood-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mast_right_yard_24.name = "YardRight";
  if (endpoint_mast_right_yard_24) {
    mesh_mast_right_yard_24.position.copy(endpoint_mast_right_yard_24.midpoint);
    mesh_mast_right_yard_24.quaternion.copy(endpoint_mast_right_yard_24.quaternion);
  }
  mesh_mast_right_yard_24.castShadow = options.castShadow ?? true;
  mesh_mast_right_yard_24.receiveShadow = options.receiveShadow ?? true;
  mesh_mast_right_yard_24.userData.sculptComponent = {"id": "mast-right-yard", "name": "YardRight", "level": "meso", "role": "spar", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "mast-right", "attachment": {"parentId": "mast-right", "parentSocket": "mast-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.9, "height": 0.05, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.25, 0], "rotation": [0, 0, 1.5708], "scale": [0.9, 0.05, 0.05]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "YardRight solid geometry attached to mast-right", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "mast-right-yard", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_mast_right_yard_24.add(mesh_mast_right_yard_24);
  meshes["mast-right-yard"] = mesh_mast_right_yard_24;
  colliders["mast-right-yard"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["mast-right-yard"] ??= [];
  destructionGroups["mast-right-yard"].push(node_mast_right_yard_24);

  const attachment_sail_right_25 = {"parentId": "mast-right", "parentSocket": "mast-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_sail_right_25 = makeAttachmentEndpoint(attachment_sail_right_25);
  const node_sail_right_25 = new THREE.Group();
  node_sail_right_25.name = "SailRight__pivot";
  node_sail_right_25.scale.set(1, 1, 1);
  if (endpoint_sail_right_25) {
    node_sail_right_25.position.copy(endpoint_sail_right_25.start);
    node_sail_right_25.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_sail_right_25.position.set(-0.3, 0.05, 0.0);
    node_sail_right_25.rotation.set(0.0, 0.0, 1.5708);
  }
  node_sail_right_25.userData.sculptComponent = {"id": "sail-right", "name": "SailRight", "level": "meso", "role": "sail", "importance": 0.8, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "mast-right", "attachment": {"parentId": "mast-right", "parentSocket": "mast-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.85, "height": 0.55, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.3, 0.05, 0], "rotation": [0, 0, 1.5708], "scale": [0.85, 0.55, 0.03]}, "material": "sail-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Triangular cream sail with wave pattern", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 235, 221, 1.0)", "secondaryAlbedo": "rgba(216, 208, 188, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_sail_right_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["mast-right"] ?? root).add(node_sail_right_25);
  nodes["sail-right"] = node_sail_right_25;
  const mesh_sail_right_25Geometry = endpoint_sail_right_25
    ? new THREE.CylinderGeometry(endpoint_sail_right_25.endRadius, endpoint_sail_right_25.baseRadius, endpoint_sail_right_25.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_sail_right_25) {
    mesh_sail_right_25Geometry.scale(0.85, 0.55, 0.03);
  }
  const mesh_sail_right_25 = new THREE.Mesh(
    mesh_sail_right_25Geometry,
    materialMap["sail-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sail_right_25.name = "SailRight";
  if (endpoint_sail_right_25) {
    mesh_sail_right_25.position.copy(endpoint_sail_right_25.midpoint);
    mesh_sail_right_25.quaternion.copy(endpoint_sail_right_25.quaternion);
  }
  mesh_sail_right_25.castShadow = options.castShadow ?? true;
  mesh_sail_right_25.receiveShadow = options.receiveShadow ?? true;
  mesh_sail_right_25.userData.sculptComponent = {"id": "sail-right", "name": "SailRight", "level": "meso", "role": "sail", "importance": 0.8, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "mast-right", "attachment": {"parentId": "mast-right", "parentSocket": "mast-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.85, "height": 0.55, "depth": 0.03, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.3, 0.05, 0], "rotation": [0, 0, 1.5708], "scale": [0.85, 0.55, 0.03]}, "material": "sail-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Triangular cream sail with wave pattern", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 235, 221, 1.0)", "secondaryAlbedo": "rgba(216, 208, 188, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "sail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_sail_right_25.add(mesh_sail_right_25);
  meshes["sail-right"] = mesh_sail_right_25;
  colliders["sail-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["sail-right"] ??= [];
  destructionGroups["sail-right"].push(node_sail_right_25);

  const endpoint_beam_end__1_26 = makeAttachmentEndpoint(null);
  const node_beam_end__1_26 = new THREE.Group();
  node_beam_end__1_26.name = "BeamEnd-1__pivot";
  node_beam_end__1_26.scale.set(1, 1, 1);
  if (endpoint_beam_end__1_26) {
    node_beam_end__1_26.position.copy(endpoint_beam_end__1_26.start);
    node_beam_end__1_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_beam_end__1_26.position.set(-1.42, 1.15, 0.0);
    node_beam_end__1_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_beam_end__1_26.userData.sculptComponent = {"id": "beam-end--1", "name": "BeamEnd-1", "level": "meso", "role": "frame", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 1.5, "depth": 1.5, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.42, 1.15, 0], "rotation": [0, 0, 0], "scale": [0.14, 1.5, 1.5]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden corner frame beam", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-end--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_beam_end__1_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-end--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_beam_end__1_26);
  nodes["beam-end--1"] = node_beam_end__1_26;
  const mesh_beam_end__1_26Geometry = endpoint_beam_end__1_26
    ? new THREE.CylinderGeometry(endpoint_beam_end__1_26.endRadius, endpoint_beam_end__1_26.baseRadius, endpoint_beam_end__1_26.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_beam_end__1_26) {
    mesh_beam_end__1_26Geometry.scale(0.14, 1.5, 1.5);
  }
  const mesh_beam_end__1_26 = new THREE.Mesh(
    mesh_beam_end__1_26Geometry,
    materialMap["wood-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_beam_end__1_26.name = "BeamEnd-1";
  if (endpoint_beam_end__1_26) {
    mesh_beam_end__1_26.position.copy(endpoint_beam_end__1_26.midpoint);
    mesh_beam_end__1_26.quaternion.copy(endpoint_beam_end__1_26.quaternion);
  }
  mesh_beam_end__1_26.castShadow = options.castShadow ?? true;
  mesh_beam_end__1_26.receiveShadow = options.receiveShadow ?? true;
  mesh_beam_end__1_26.userData.sculptComponent = {"id": "beam-end--1", "name": "BeamEnd-1", "level": "meso", "role": "frame", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 1.5, "depth": 1.5, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.42, 1.15, 0], "rotation": [0, 0, 0], "scale": [0.14, 1.5, 1.5]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden corner frame beam", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-end--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_beam_end__1_26.add(mesh_beam_end__1_26);
  meshes["beam-end--1"] = mesh_beam_end__1_26;
  colliders["beam-end--1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["beam-end--1"] ??= [];
  destructionGroups["beam-end--1"].push(node_beam_end__1_26);

  const endpoint_beam_end_1_27 = makeAttachmentEndpoint(null);
  const node_beam_end_1_27 = new THREE.Group();
  node_beam_end_1_27.name = "BeamEnd1__pivot";
  node_beam_end_1_27.scale.set(1, 1, 1);
  if (endpoint_beam_end_1_27) {
    node_beam_end_1_27.position.copy(endpoint_beam_end_1_27.start);
    node_beam_end_1_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_beam_end_1_27.position.set(1.42, 1.15, 0.0);
    node_beam_end_1_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_beam_end_1_27.userData.sculptComponent = {"id": "beam-end-1", "name": "BeamEnd1", "level": "meso", "role": "frame", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 1.5, "depth": 1.5, "units": "world", "confidence": 0.85}, "transform": {"position": [1.42, 1.15, 0], "rotation": [0, 0, 0], "scale": [0.14, 1.5, 1.5]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden corner frame beam", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-end-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_beam_end_1_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-end-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_beam_end_1_27);
  nodes["beam-end-1"] = node_beam_end_1_27;
  const mesh_beam_end_1_27Geometry = endpoint_beam_end_1_27
    ? new THREE.CylinderGeometry(endpoint_beam_end_1_27.endRadius, endpoint_beam_end_1_27.baseRadius, endpoint_beam_end_1_27.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_beam_end_1_27) {
    mesh_beam_end_1_27Geometry.scale(0.14, 1.5, 1.5);
  }
  const mesh_beam_end_1_27 = new THREE.Mesh(
    mesh_beam_end_1_27Geometry,
    materialMap["wood-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_beam_end_1_27.name = "BeamEnd1";
  if (endpoint_beam_end_1_27) {
    mesh_beam_end_1_27.position.copy(endpoint_beam_end_1_27.midpoint);
    mesh_beam_end_1_27.quaternion.copy(endpoint_beam_end_1_27.quaternion);
  }
  mesh_beam_end_1_27.castShadow = options.castShadow ?? true;
  mesh_beam_end_1_27.receiveShadow = options.receiveShadow ?? true;
  mesh_beam_end_1_27.userData.sculptComponent = {"id": "beam-end-1", "name": "BeamEnd1", "level": "meso", "role": "frame", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 1.5, "depth": 1.5, "units": "world", "confidence": 0.85}, "transform": {"position": [1.42, 1.15, 0], "rotation": [0, 0, 0], "scale": [0.14, 1.5, 1.5]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden corner frame beam", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "beam-end-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_beam_end_1_27.add(mesh_beam_end_1_27);
  meshes["beam-end-1"] = mesh_beam_end_1_27;
  colliders["beam-end-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["beam-end-1"] ??= [];
  destructionGroups["beam-end-1"].push(node_beam_end_1_27);

  const endpoint_chassis_28 = makeAttachmentEndpoint(null);
  const node_chassis_28 = new THREE.Group();
  node_chassis_28.name = "Chassis__pivot";
  node_chassis_28.scale.set(1, 1, 1);
  if (endpoint_chassis_28) {
    node_chassis_28.position.copy(endpoint_chassis_28.start);
    node_chassis_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chassis_28.position.set(0.0, 0.42, 0.0);
    node_chassis_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_chassis_28.userData.sculptComponent = {"id": "chassis", "name": "Chassis", "level": "meso", "role": "undercarriage", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.3, "height": 0.14, "depth": 1.0, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.42, 0], "rotation": [0, 0, 0], "scale": [3.3, 0.14, 1.0]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden running board with curved ends", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chassis_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_chassis_28);
  nodes["chassis"] = node_chassis_28;
  const mesh_chassis_28Geometry = endpoint_chassis_28
    ? new THREE.CylinderGeometry(endpoint_chassis_28.endRadius, endpoint_chassis_28.baseRadius, endpoint_chassis_28.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chassis_28) {
    mesh_chassis_28Geometry.scale(3.3, 0.14, 1.0);
  }
  const mesh_chassis_28 = new THREE.Mesh(
    mesh_chassis_28Geometry,
    materialMap["wood-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chassis_28.name = "Chassis";
  if (endpoint_chassis_28) {
    mesh_chassis_28.position.copy(endpoint_chassis_28.midpoint);
    mesh_chassis_28.quaternion.copy(endpoint_chassis_28.quaternion);
  }
  mesh_chassis_28.castShadow = options.castShadow ?? true;
  mesh_chassis_28.receiveShadow = options.receiveShadow ?? true;
  mesh_chassis_28.userData.sculptComponent = {"id": "chassis", "name": "Chassis", "level": "meso", "role": "undercarriage", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.3, "height": 0.14, "depth": 1.0, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.42, 0], "rotation": [0, 0, 0], "scale": [3.3, 0.14, 1.0]}, "material": "wood-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Wooden running board with curved ends", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 104, 68, 1.0)", "secondaryAlbedo": "rgba(106, 78, 52, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chassis_28.add(mesh_chassis_28);
  meshes["chassis"] = mesh_chassis_28;
  colliders["chassis"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["chassis"] ??= [];
  destructionGroups["chassis"].push(node_chassis_28);

  const attachment_wheel_front_29 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_front_29 = makeAttachmentEndpoint(attachment_wheel_front_29);
  const node_wheel_front_29 = new THREE.Group();
  node_wheel_front_29.name = "WheelFront__pivot";
  node_wheel_front_29.scale.set(1, 1, 1);
  if (endpoint_wheel_front_29) {
    node_wheel_front_29.position.copy(endpoint_wheel_front_29.start);
    node_wheel_front_29.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_front_29.position.set(-0.95, -0.22, -0.5);
    node_wheel_front_29.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_front_29.userData.sculptComponent = {"id": "wheel-front", "name": "WheelFront", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.14, "depth": 0.5, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.95, -0.22, -0.5], "rotation": [1.5708, 0, 0], "scale": [0.5, 0.14, 0.5]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFront solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_front_29);
  nodes["wheel-front"] = node_wheel_front_29;
  const mesh_wheel_front_29Geometry = endpoint_wheel_front_29
    ? new THREE.CylinderGeometry(endpoint_wheel_front_29.endRadius, endpoint_wheel_front_29.baseRadius, endpoint_wheel_front_29.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_front_29) {
    mesh_wheel_front_29Geometry.scale(0.5, 0.14, 0.5);
  }
  const mesh_wheel_front_29 = new THREE.Mesh(
    mesh_wheel_front_29Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_29.name = "WheelFront";
  if (endpoint_wheel_front_29) {
    mesh_wheel_front_29.position.copy(endpoint_wheel_front_29.midpoint);
    mesh_wheel_front_29.quaternion.copy(endpoint_wheel_front_29.quaternion);
  }
  mesh_wheel_front_29.castShadow = options.castShadow ?? true;
  mesh_wheel_front_29.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_29.userData.sculptComponent = {"id": "wheel-front", "name": "WheelFront", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.14, "depth": 0.5, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.95, -0.22, -0.5], "rotation": [1.5708, 0, 0], "scale": [0.5, 0.14, 0.5]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFront solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_29.add(mesh_wheel_front_29);
  meshes["wheel-front"] = mesh_wheel_front_29;
  colliders["wheel-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-front"] ??= [];
  destructionGroups["wheel-front"].push(node_wheel_front_29);

  const attachment_wheel_rear_30 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_rear_30 = makeAttachmentEndpoint(attachment_wheel_rear_30);
  const node_wheel_rear_30 = new THREE.Group();
  node_wheel_rear_30.name = "WheelRear__pivot";
  node_wheel_rear_30.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_30) {
    node_wheel_rear_30.position.copy(endpoint_wheel_rear_30.start);
    node_wheel_rear_30.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_rear_30.position.set(0.95, -0.22, -0.5);
    node_wheel_rear_30.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_rear_30.userData.sculptComponent = {"id": "wheel-rear", "name": "WheelRear", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.14, "depth": 0.5, "units": "world", "confidence": 0.85}, "transform": {"position": [0.95, -0.22, -0.5], "rotation": [1.5708, 0, 0], "scale": [0.5, 0.14, 0.5]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRear solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_rear_30);
  nodes["wheel-rear"] = node_wheel_rear_30;
  const mesh_wheel_rear_30Geometry = endpoint_wheel_rear_30
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_30.endRadius, endpoint_wheel_rear_30.baseRadius, endpoint_wheel_rear_30.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_rear_30) {
    mesh_wheel_rear_30Geometry.scale(0.5, 0.14, 0.5);
  }
  const mesh_wheel_rear_30 = new THREE.Mesh(
    mesh_wheel_rear_30Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_30.name = "WheelRear";
  if (endpoint_wheel_rear_30) {
    mesh_wheel_rear_30.position.copy(endpoint_wheel_rear_30.midpoint);
    mesh_wheel_rear_30.quaternion.copy(endpoint_wheel_rear_30.quaternion);
  }
  mesh_wheel_rear_30.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_30.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_30.userData.sculptComponent = {"id": "wheel-rear", "name": "WheelRear", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.14, "depth": 0.5, "units": "world", "confidence": 0.85}, "transform": {"position": [0.95, -0.22, -0.5], "rotation": [1.5708, 0, 0], "scale": [0.5, 0.14, 0.5]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRear solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_30.add(mesh_wheel_rear_30);
  meshes["wheel-rear"] = mesh_wheel_rear_30;
  colliders["wheel-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-rear"] ??= [];
  destructionGroups["wheel-rear"].push(node_wheel_rear_30);

  const attachment_coupler_left_31 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coupler_left_31 = makeAttachmentEndpoint(attachment_coupler_left_31);
  const node_coupler_left_31 = new THREE.Group();
  node_coupler_left_31.name = "CouplerLeft__pivot";
  node_coupler_left_31.scale.set(1, 1, 1);
  if (endpoint_coupler_left_31) {
    node_coupler_left_31.position.copy(endpoint_coupler_left_31.start);
    node_coupler_left_31.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_coupler_left_31.position.set(-1.72, 0.0, 0.0);
    node_coupler_left_31.rotation.set(0.0, 0.0, 1.5708);
  }
  node_coupler_left_31.userData.sculptComponent = {"id": "coupler-left", "name": "CouplerLeft", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.28, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.72, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.28, 0.08, 0.08]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerLeft solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_left_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_coupler_left_31);
  nodes["coupler-left"] = node_coupler_left_31;
  const mesh_coupler_left_31Geometry = endpoint_coupler_left_31
    ? new THREE.CylinderGeometry(endpoint_coupler_left_31.endRadius, endpoint_coupler_left_31.baseRadius, endpoint_coupler_left_31.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_coupler_left_31) {
    mesh_coupler_left_31Geometry.scale(0.28, 0.08, 0.08);
  }
  const mesh_coupler_left_31 = new THREE.Mesh(
    mesh_coupler_left_31Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coupler_left_31.name = "CouplerLeft";
  if (endpoint_coupler_left_31) {
    mesh_coupler_left_31.position.copy(endpoint_coupler_left_31.midpoint);
    mesh_coupler_left_31.quaternion.copy(endpoint_coupler_left_31.quaternion);
  }
  mesh_coupler_left_31.castShadow = options.castShadow ?? true;
  mesh_coupler_left_31.receiveShadow = options.receiveShadow ?? true;
  mesh_coupler_left_31.userData.sculptComponent = {"id": "coupler-left", "name": "CouplerLeft", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.28, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.72, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.28, 0.08, 0.08]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerLeft solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_left_31.add(mesh_coupler_left_31);
  meshes["coupler-left"] = mesh_coupler_left_31;
  colliders["coupler-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coupler-left"] ??= [];
  destructionGroups["coupler-left"].push(node_coupler_left_31);

  const attachment_coupler_right_32 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coupler_right_32 = makeAttachmentEndpoint(attachment_coupler_right_32);
  const node_coupler_right_32 = new THREE.Group();
  node_coupler_right_32.name = "CouplerRight__pivot";
  node_coupler_right_32.scale.set(1, 1, 1);
  if (endpoint_coupler_right_32) {
    node_coupler_right_32.position.copy(endpoint_coupler_right_32.start);
    node_coupler_right_32.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_coupler_right_32.position.set(1.72, 0.0, 0.0);
    node_coupler_right_32.rotation.set(0.0, 0.0, 1.5708);
  }
  node_coupler_right_32.userData.sculptComponent = {"id": "coupler-right", "name": "CouplerRight", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.28, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [1.72, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.28, 0.08, 0.08]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerRight solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_right_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_coupler_right_32);
  nodes["coupler-right"] = node_coupler_right_32;
  const mesh_coupler_right_32Geometry = endpoint_coupler_right_32
    ? new THREE.CylinderGeometry(endpoint_coupler_right_32.endRadius, endpoint_coupler_right_32.baseRadius, endpoint_coupler_right_32.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_coupler_right_32) {
    mesh_coupler_right_32Geometry.scale(0.28, 0.08, 0.08);
  }
  const mesh_coupler_right_32 = new THREE.Mesh(
    mesh_coupler_right_32Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coupler_right_32.name = "CouplerRight";
  if (endpoint_coupler_right_32) {
    mesh_coupler_right_32.position.copy(endpoint_coupler_right_32.midpoint);
    mesh_coupler_right_32.quaternion.copy(endpoint_coupler_right_32.quaternion);
  }
  mesh_coupler_right_32.castShadow = options.castShadow ?? true;
  mesh_coupler_right_32.receiveShadow = options.receiveShadow ?? true;
  mesh_coupler_right_32.userData.sculptComponent = {"id": "coupler-right", "name": "CouplerRight", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.28, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [1.72, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.28, 0.08, 0.08]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerRight solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_right_32.add(mesh_coupler_right_32);
  meshes["coupler-right"] = mesh_coupler_right_32;
  colliders["coupler-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coupler-right"] ??= [];
  destructionGroups["coupler-right"].push(node_coupler_right_32);

  const attachment_coral_decor_1_33 = {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coral_decor_1_33 = makeAttachmentEndpoint(attachment_coral_decor_1_33);
  const node_coral_decor_1_33 = new THREE.Group();
  node_coral_decor_1_33.name = "CoralDecor1__pivot";
  node_coral_decor_1_33.scale.set(1, 1, 1);
  if (endpoint_coral_decor_1_33) {
    node_coral_decor_1_33.position.copy(endpoint_coral_decor_1_33.start);
    node_coral_decor_1_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coral_decor_1_33.position.set(-1.3, 0.55, 0.75);
    node_coral_decor_1_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_coral_decor_1_33.userData.sculptComponent = {"id": "coral-decor-1", "name": "CoralDecor1", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.3, 0.55, 0.75], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_1_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_coral_decor_1_33);
  nodes["coral-decor-1"] = node_coral_decor_1_33;
  const mesh_coral_decor_1_33Geometry = endpoint_coral_decor_1_33
    ? new THREE.CylinderGeometry(endpoint_coral_decor_1_33.endRadius, endpoint_coral_decor_1_33.baseRadius, endpoint_coral_decor_1_33.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_coral_decor_1_33) {
    mesh_coral_decor_1_33Geometry.scale(0.16, 0.3, 0.16);
  }
  const mesh_coral_decor_1_33 = new THREE.Mesh(
    mesh_coral_decor_1_33Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coral_decor_1_33.name = "CoralDecor1";
  if (endpoint_coral_decor_1_33) {
    mesh_coral_decor_1_33.position.copy(endpoint_coral_decor_1_33.midpoint);
    mesh_coral_decor_1_33.quaternion.copy(endpoint_coral_decor_1_33.quaternion);
  }
  mesh_coral_decor_1_33.castShadow = options.castShadow ?? true;
  mesh_coral_decor_1_33.receiveShadow = options.receiveShadow ?? true;
  mesh_coral_decor_1_33.userData.sculptComponent = {"id": "coral-decor-1", "name": "CoralDecor1", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.3, 0.55, 0.75], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_1_33.add(mesh_coral_decor_1_33);
  meshes["coral-decor-1"] = mesh_coral_decor_1_33;
  colliders["coral-decor-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coral-decor-1"] ??= [];
  destructionGroups["coral-decor-1"].push(node_coral_decor_1_33);

  const attachment_coral_decor_2_34 = {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coral_decor_2_34 = makeAttachmentEndpoint(attachment_coral_decor_2_34);
  const node_coral_decor_2_34 = new THREE.Group();
  node_coral_decor_2_34.name = "CoralDecor2__pivot";
  node_coral_decor_2_34.scale.set(1, 1, 1);
  if (endpoint_coral_decor_2_34) {
    node_coral_decor_2_34.position.copy(endpoint_coral_decor_2_34.start);
    node_coral_decor_2_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coral_decor_2_34.position.set(1.3, 0.55, 0.75);
    node_coral_decor_2_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_coral_decor_2_34.userData.sculptComponent = {"id": "coral-decor-2", "name": "CoralDecor2", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [1.3, 0.55, 0.75], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_2_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_coral_decor_2_34);
  nodes["coral-decor-2"] = node_coral_decor_2_34;
  const mesh_coral_decor_2_34Geometry = endpoint_coral_decor_2_34
    ? new THREE.CylinderGeometry(endpoint_coral_decor_2_34.endRadius, endpoint_coral_decor_2_34.baseRadius, endpoint_coral_decor_2_34.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_coral_decor_2_34) {
    mesh_coral_decor_2_34Geometry.scale(0.16, 0.3, 0.16);
  }
  const mesh_coral_decor_2_34 = new THREE.Mesh(
    mesh_coral_decor_2_34Geometry,
    materialMap["seaweed-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coral_decor_2_34.name = "CoralDecor2";
  if (endpoint_coral_decor_2_34) {
    mesh_coral_decor_2_34.position.copy(endpoint_coral_decor_2_34.midpoint);
    mesh_coral_decor_2_34.quaternion.copy(endpoint_coral_decor_2_34.quaternion);
  }
  mesh_coral_decor_2_34.castShadow = options.castShadow ?? true;
  mesh_coral_decor_2_34.receiveShadow = options.receiveShadow ?? true;
  mesh_coral_decor_2_34.userData.sculptComponent = {"id": "coral-decor-2", "name": "CoralDecor2", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [1.3, 0.55, 0.75], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_2_34.add(mesh_coral_decor_2_34);
  meshes["coral-decor-2"] = mesh_coral_decor_2_34;
  colliders["coral-decor-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coral-decor-2"] ??= [];
  destructionGroups["coral-decor-2"].push(node_coral_decor_2_34);

  const attachment_coral_decor_3_35 = {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coral_decor_3_35 = makeAttachmentEndpoint(attachment_coral_decor_3_35);
  const node_coral_decor_3_35 = new THREE.Group();
  node_coral_decor_3_35.name = "CoralDecor3__pivot";
  node_coral_decor_3_35.scale.set(1, 1, 1);
  if (endpoint_coral_decor_3_35) {
    node_coral_decor_3_35.position.copy(endpoint_coral_decor_3_35.start);
    node_coral_decor_3_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coral_decor_3_35.position.set(1.45, 0.55, -0.5);
    node_coral_decor_3_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_coral_decor_3_35.userData.sculptComponent = {"id": "coral-decor-3", "name": "CoralDecor3", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [1.45, 0.55, -0.5], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_3_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_coral_decor_3_35);
  nodes["coral-decor-3"] = node_coral_decor_3_35;
  const mesh_coral_decor_3_35Geometry = endpoint_coral_decor_3_35
    ? new THREE.CylinderGeometry(endpoint_coral_decor_3_35.endRadius, endpoint_coral_decor_3_35.baseRadius, endpoint_coral_decor_3_35.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_coral_decor_3_35) {
    mesh_coral_decor_3_35Geometry.scale(0.16, 0.3, 0.16);
  }
  const mesh_coral_decor_3_35 = new THREE.Mesh(
    mesh_coral_decor_3_35Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coral_decor_3_35.name = "CoralDecor3";
  if (endpoint_coral_decor_3_35) {
    mesh_coral_decor_3_35.position.copy(endpoint_coral_decor_3_35.midpoint);
    mesh_coral_decor_3_35.quaternion.copy(endpoint_coral_decor_3_35.quaternion);
  }
  mesh_coral_decor_3_35.castShadow = options.castShadow ?? true;
  mesh_coral_decor_3_35.receiveShadow = options.receiveShadow ?? true;
  mesh_coral_decor_3_35.userData.sculptComponent = {"id": "coral-decor-3", "name": "CoralDecor3", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [1.45, 0.55, -0.5], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_3_35.add(mesh_coral_decor_3_35);
  meshes["coral-decor-3"] = mesh_coral_decor_3_35;
  colliders["coral-decor-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coral-decor-3"] ??= [];
  destructionGroups["coral-decor-3"].push(node_coral_decor_3_35);

  const endpoint_seaweed_1_36 = makeAttachmentEndpoint(null);
  const node_seaweed_1_36 = new THREE.Group();
  node_seaweed_1_36.name = "Seaweed1__pivot";
  node_seaweed_1_36.scale.set(1, 1, 1);
  if (endpoint_seaweed_1_36) {
    node_seaweed_1_36.position.copy(endpoint_seaweed_1_36.start);
    node_seaweed_1_36.rotation.set(0.0, 0.0, 0.20944);
  } else {
    node_seaweed_1_36.position.set(1.35, 1.9, 0.4);
    node_seaweed_1_36.rotation.set(0.0, 0.0, 0.20944);
  }
  node_seaweed_1_36.userData.sculptComponent = {"id": "seaweed-1", "name": "Seaweed1", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.8}, "transform": {"position": [1.35, 1.9, 0.4], "rotation": [0, 0, 0.20944], "scale": [0.1, 0.5, 0.06]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Seaweed1 solid geometry attached to ocean-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "seaweed-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_seaweed_1_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "seaweed-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_seaweed_1_36);
  nodes["seaweed-1"] = node_seaweed_1_36;
  const mesh_seaweed_1_36Geometry = endpoint_seaweed_1_36
    ? new THREE.CylinderGeometry(endpoint_seaweed_1_36.endRadius, endpoint_seaweed_1_36.baseRadius, endpoint_seaweed_1_36.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_seaweed_1_36) {
    mesh_seaweed_1_36Geometry.scale(0.1, 0.5, 0.06);
  }
  const mesh_seaweed_1_36 = new THREE.Mesh(
    mesh_seaweed_1_36Geometry,
    materialMap["seaweed-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seaweed_1_36.name = "Seaweed1";
  if (endpoint_seaweed_1_36) {
    mesh_seaweed_1_36.position.copy(endpoint_seaweed_1_36.midpoint);
    mesh_seaweed_1_36.quaternion.copy(endpoint_seaweed_1_36.quaternion);
  }
  mesh_seaweed_1_36.castShadow = options.castShadow ?? true;
  mesh_seaweed_1_36.receiveShadow = options.receiveShadow ?? true;
  mesh_seaweed_1_36.userData.sculptComponent = {"id": "seaweed-1", "name": "Seaweed1", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.8}, "transform": {"position": [1.35, 1.9, 0.4], "rotation": [0, 0, 0.20944], "scale": [0.1, 0.5, 0.06]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Seaweed1 solid geometry attached to ocean-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "seaweed-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_seaweed_1_36.add(mesh_seaweed_1_36);
  meshes["seaweed-1"] = mesh_seaweed_1_36;
  colliders["seaweed-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["seaweed-1"] ??= [];
  destructionGroups["seaweed-1"].push(node_seaweed_1_36);

  const endpoint_seaweed_2_37 = makeAttachmentEndpoint(null);
  const node_seaweed_2_37 = new THREE.Group();
  node_seaweed_2_37.name = "Seaweed2__pivot";
  node_seaweed_2_37.scale.set(1, 1, 1);
  if (endpoint_seaweed_2_37) {
    node_seaweed_2_37.position.copy(endpoint_seaweed_2_37.start);
    node_seaweed_2_37.rotation.set(0.0, 0.0, -0.2618);
  } else {
    node_seaweed_2_37.position.set(1.5, 1.8, -0.3);
    node_seaweed_2_37.rotation.set(0.0, 0.0, -0.2618);
  }
  node_seaweed_2_37.userData.sculptComponent = {"id": "seaweed-2", "name": "Seaweed2", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 0.4, "depth": 0.06, "units": "world", "confidence": 0.8}, "transform": {"position": [1.5, 1.8, -0.3], "rotation": [0, 0, -0.2618], "scale": [0.08, 0.4, 0.06]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Seaweed2 solid geometry attached to ocean-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "seaweed-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_seaweed_2_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "seaweed-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_seaweed_2_37);
  nodes["seaweed-2"] = node_seaweed_2_37;
  const mesh_seaweed_2_37Geometry = endpoint_seaweed_2_37
    ? new THREE.CylinderGeometry(endpoint_seaweed_2_37.endRadius, endpoint_seaweed_2_37.baseRadius, endpoint_seaweed_2_37.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_seaweed_2_37) {
    mesh_seaweed_2_37Geometry.scale(0.08, 0.4, 0.06);
  }
  const mesh_seaweed_2_37 = new THREE.Mesh(
    mesh_seaweed_2_37Geometry,
    materialMap["seaweed-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seaweed_2_37.name = "Seaweed2";
  if (endpoint_seaweed_2_37) {
    mesh_seaweed_2_37.position.copy(endpoint_seaweed_2_37.midpoint);
    mesh_seaweed_2_37.quaternion.copy(endpoint_seaweed_2_37.quaternion);
  }
  mesh_seaweed_2_37.castShadow = options.castShadow ?? true;
  mesh_seaweed_2_37.receiveShadow = options.receiveShadow ?? true;
  mesh_seaweed_2_37.userData.sculptComponent = {"id": "seaweed-2", "name": "Seaweed2", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.08, "height": 0.4, "depth": 0.06, "units": "world", "confidence": 0.8}, "transform": {"position": [1.5, 1.8, -0.3], "rotation": [0, 0, -0.2618], "scale": [0.08, 0.4, 0.06]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Seaweed2 solid geometry attached to ocean-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "seaweed-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_seaweed_2_37.add(mesh_seaweed_2_37);
  meshes["seaweed-2"] = mesh_seaweed_2_37;
  colliders["seaweed-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["seaweed-2"] ??= [];
  destructionGroups["seaweed-2"].push(node_seaweed_2_37);

  const endpoint_fish_1_38 = makeAttachmentEndpoint(null);
  const node_fish_1_38 = new THREE.Group();
  node_fish_1_38.name = "Fish1__pivot";
  node_fish_1_38.scale.set(1, 1, 1);
  if (endpoint_fish_1_38) {
    node_fish_1_38.position.copy(endpoint_fish_1_38.start);
    node_fish_1_38.rotation.set(0.0, -0.17453, 0.0);
  } else {
    node_fish_1_38.position.set(-1.2, 0.55, 0.78);
    node_fish_1_38.rotation.set(0.0, -0.17453, 0.0);
  }
  node_fish_1_38.userData.sculptComponent = {"id": "fish-1", "name": "Fish1", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.2, 0.55, 0.78], "rotation": [0, -0.17453, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-orange", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 136, 64, 1.0)", "secondaryAlbedo": "rgba(200, 104, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_1_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_fish_1_38);
  nodes["fish-1"] = node_fish_1_38;
  const mesh_fish_1_38Geometry = endpoint_fish_1_38
    ? new THREE.CylinderGeometry(endpoint_fish_1_38.endRadius, endpoint_fish_1_38.baseRadius, endpoint_fish_1_38.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_fish_1_38) {
    mesh_fish_1_38Geometry.scale(0.22, 0.16, 0.1);
  }
  const mesh_fish_1_38 = new THREE.Mesh(
    mesh_fish_1_38Geometry,
    materialMap["fish-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fish_1_38.name = "Fish1";
  if (endpoint_fish_1_38) {
    mesh_fish_1_38.position.copy(endpoint_fish_1_38.midpoint);
    mesh_fish_1_38.quaternion.copy(endpoint_fish_1_38.quaternion);
  }
  mesh_fish_1_38.castShadow = options.castShadow ?? true;
  mesh_fish_1_38.receiveShadow = options.receiveShadow ?? true;
  mesh_fish_1_38.userData.sculptComponent = {"id": "fish-1", "name": "Fish1", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.2, 0.55, 0.78], "rotation": [0, -0.17453, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-orange", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 136, 64, 1.0)", "secondaryAlbedo": "rgba(200, 104, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_1_38.add(mesh_fish_1_38);
  meshes["fish-1"] = mesh_fish_1_38;
  colliders["fish-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["fish-1"] ??= [];
  destructionGroups["fish-1"].push(node_fish_1_38);

  const endpoint_fish_2_39 = makeAttachmentEndpoint(null);
  const node_fish_2_39 = new THREE.Group();
  node_fish_2_39.name = "Fish2__pivot";
  node_fish_2_39.scale.set(1, 1, 1);
  if (endpoint_fish_2_39) {
    node_fish_2_39.position.copy(endpoint_fish_2_39.start);
    node_fish_2_39.rotation.set(0.0, 0.17453, 0.0);
  } else {
    node_fish_2_39.position.set(-0.3, 0.4, 0.78);
    node_fish_2_39.rotation.set(0.0, 0.17453, 0.0);
  }
  node_fish_2_39.userData.sculptComponent = {"id": "fish-2", "name": "Fish2", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.3, 0.4, 0.78], "rotation": [0, 0.17453, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-teal", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(72, 184, 168, 1.0)", "secondaryAlbedo": "rgba(56, 152, 136, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_2_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_fish_2_39);
  nodes["fish-2"] = node_fish_2_39;
  const mesh_fish_2_39Geometry = endpoint_fish_2_39
    ? new THREE.CylinderGeometry(endpoint_fish_2_39.endRadius, endpoint_fish_2_39.baseRadius, endpoint_fish_2_39.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_fish_2_39) {
    mesh_fish_2_39Geometry.scale(0.22, 0.16, 0.1);
  }
  const mesh_fish_2_39 = new THREE.Mesh(
    mesh_fish_2_39Geometry,
    materialMap["fish-teal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fish_2_39.name = "Fish2";
  if (endpoint_fish_2_39) {
    mesh_fish_2_39.position.copy(endpoint_fish_2_39.midpoint);
    mesh_fish_2_39.quaternion.copy(endpoint_fish_2_39.quaternion);
  }
  mesh_fish_2_39.castShadow = options.castShadow ?? true;
  mesh_fish_2_39.receiveShadow = options.receiveShadow ?? true;
  mesh_fish_2_39.userData.sculptComponent = {"id": "fish-2", "name": "Fish2", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.3, 0.4, 0.78], "rotation": [0, 0.17453, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-teal", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(72, 184, 168, 1.0)", "secondaryAlbedo": "rgba(56, 152, 136, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_2_39.add(mesh_fish_2_39);
  meshes["fish-2"] = mesh_fish_2_39;
  colliders["fish-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["fish-2"] ??= [];
  destructionGroups["fish-2"].push(node_fish_2_39);

  const endpoint_fish_3_40 = makeAttachmentEndpoint(null);
  const node_fish_3_40 = new THREE.Group();
  node_fish_3_40.name = "Fish3__pivot";
  node_fish_3_40.scale.set(1, 1, 1);
  if (endpoint_fish_3_40) {
    node_fish_3_40.position.copy(endpoint_fish_3_40.start);
    node_fish_3_40.rotation.set(0.0, 0.5236, 0.0);
  } else {
    node_fish_3_40.position.set(0.8, 0.45, 0.78);
    node_fish_3_40.rotation.set(0.0, 0.5236, 0.0);
  }
  node_fish_3_40.userData.sculptComponent = {"id": "fish-3", "name": "Fish3", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [0.8, 0.45, 0.78], "rotation": [0, 0.5236, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-orange", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 136, 64, 1.0)", "secondaryAlbedo": "rgba(200, 104, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_3_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_fish_3_40);
  nodes["fish-3"] = node_fish_3_40;
  const mesh_fish_3_40Geometry = endpoint_fish_3_40
    ? new THREE.CylinderGeometry(endpoint_fish_3_40.endRadius, endpoint_fish_3_40.baseRadius, endpoint_fish_3_40.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_fish_3_40) {
    mesh_fish_3_40Geometry.scale(0.22, 0.16, 0.1);
  }
  const mesh_fish_3_40 = new THREE.Mesh(
    mesh_fish_3_40Geometry,
    materialMap["fish-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fish_3_40.name = "Fish3";
  if (endpoint_fish_3_40) {
    mesh_fish_3_40.position.copy(endpoint_fish_3_40.midpoint);
    mesh_fish_3_40.quaternion.copy(endpoint_fish_3_40.quaternion);
  }
  mesh_fish_3_40.castShadow = options.castShadow ?? true;
  mesh_fish_3_40.receiveShadow = options.receiveShadow ?? true;
  mesh_fish_3_40.userData.sculptComponent = {"id": "fish-3", "name": "Fish3", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [0.8, 0.45, 0.78], "rotation": [0, 0.5236, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-orange", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 136, 64, 1.0)", "secondaryAlbedo": "rgba(200, 104, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_3_40.add(mesh_fish_3_40);
  meshes["fish-3"] = mesh_fish_3_40;
  colliders["fish-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["fish-3"] ??= [];
  destructionGroups["fish-3"].push(node_fish_3_40);

  const attachment_porthole_01m_41 = {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_01m_41 = makeAttachmentEndpoint(attachment_porthole_01m_41);
  const node_porthole_01m_41 = new THREE.Group();
  node_porthole_01m_41.name = "Porthole01Mirror__pivot";
  node_porthole_01m_41.scale.set(1, 1, 1);
  if (endpoint_porthole_01m_41) {
    node_porthole_01m_41.position.copy(endpoint_porthole_01m_41.start);
    node_porthole_01m_41.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_01m_41.position.set(-1.05, 0.0, -0.71);
    node_porthole_01m_41.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_01m_41.userData.sculptComponent = {"id": "porthole-01m", "name": "Porthole01Mirror", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.05, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole01 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01m_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-system"] ?? root).add(node_porthole_01m_41);
  nodes["porthole-01m"] = node_porthole_01m_41;
  const mesh_porthole_01m_41Geometry = endpoint_porthole_01m_41
    ? new THREE.CylinderGeometry(endpoint_porthole_01m_41.endRadius, endpoint_porthole_01m_41.baseRadius, endpoint_porthole_01m_41.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_01m_41) {
    mesh_porthole_01m_41Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_porthole_01m_41 = new THREE.Mesh(
    mesh_porthole_01m_41Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_01m_41.name = "Porthole01Mirror";
  if (endpoint_porthole_01m_41) {
    mesh_porthole_01m_41.position.copy(endpoint_porthole_01m_41.midpoint);
    mesh_porthole_01m_41.quaternion.copy(endpoint_porthole_01m_41.quaternion);
  }
  mesh_porthole_01m_41.castShadow = options.castShadow ?? true;
  mesh_porthole_01m_41.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_01m_41.visible = false; // 容器节点不渲染
  mesh_porthole_01m_41.userData.sculptComponent = {"id": "porthole-01m", "name": "Porthole01Mirror", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.05, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole01 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01m_41.add(mesh_porthole_01m_41);
  meshes["porthole-01m"] = mesh_porthole_01m_41;
  colliders["porthole-01m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-01"] ??= [];
  destructionGroups["porthole-01"].push(node_porthole_01m_41);

  const endpoint_porthole_01_ringm_42 = makeAttachmentEndpoint(null);
  const node_porthole_01_ringm_42 = new THREE.Group();
  node_porthole_01_ringm_42.name = "Porthole01RingMirror__pivot";
  node_porthole_01_ringm_42.scale.set(1, 1, 1);
  if (endpoint_porthole_01_ringm_42) {
    node_porthole_01_ringm_42.position.copy(endpoint_porthole_01_ringm_42.start);
    node_porthole_01_ringm_42.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_01_ringm_42.position.set(0.0, 0.0, 0.0);
    node_porthole_01_ringm_42.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_01_ringm_42.userData.sculptComponent = {"id": "porthole-01-ringm", "name": "Porthole01RingMirror", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-01m", "attachment": {"parentId": "porthole-01m", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_01_ringm_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-01m"] ?? root).add(node_porthole_01_ringm_42);
  nodes["porthole-01-ringm"] = node_porthole_01_ringm_42;
  const mesh_porthole_01_ringm_42Geometry = endpoint_porthole_01_ringm_42
    ? new THREE.CylinderGeometry(endpoint_porthole_01_ringm_42.endRadius, endpoint_porthole_01_ringm_42.baseRadius, endpoint_porthole_01_ringm_42.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_porthole_01_ringm_42) {
    mesh_porthole_01_ringm_42Geometry.scale(0.5, 0.5, 0.08);
  }
  const mesh_porthole_01_ringm_42 = new THREE.Mesh(
    mesh_porthole_01_ringm_42Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_01_ringm_42.name = "Porthole01RingMirror";
  if (endpoint_porthole_01_ringm_42) {
    mesh_porthole_01_ringm_42.position.copy(endpoint_porthole_01_ringm_42.midpoint);
    mesh_porthole_01_ringm_42.quaternion.copy(endpoint_porthole_01_ringm_42.quaternion);
  }
  mesh_porthole_01_ringm_42.castShadow = options.castShadow ?? true;
  mesh_porthole_01_ringm_42.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_01_ringm_42.userData.sculptComponent = {"id": "porthole-01-ringm", "name": "Porthole01RingMirror", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-01m", "attachment": {"parentId": "porthole-01m", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_01_ringm_42.add(mesh_porthole_01_ringm_42);
  meshes["porthole-01-ringm"] = mesh_porthole_01_ringm_42;
  colliders["porthole-01-ringm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-01-ring"] ??= [];
  destructionGroups["porthole-01-ring"].push(node_porthole_01_ringm_42);

  const attachment_porthole_01_glassm_43 = {"parentId": "porthole-01m", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_01_glassm_43 = makeAttachmentEndpoint(attachment_porthole_01_glassm_43);
  const node_porthole_01_glassm_43 = new THREE.Group();
  node_porthole_01_glassm_43.name = "Porthole01GlassMirror__pivot";
  node_porthole_01_glassm_43.scale.set(1, 1, 1);
  if (endpoint_porthole_01_glassm_43) {
    node_porthole_01_glassm_43.position.copy(endpoint_porthole_01_glassm_43.start);
    node_porthole_01_glassm_43.rotation.set(1.5708, 3.14159, 0.0);
  } else {
    node_porthole_01_glassm_43.position.set(0.0, 0.0, -0.01);
    node_porthole_01_glassm_43.rotation.set(1.5708, 3.14159, 0.0);
  }
  node_porthole_01_glassm_43.userData.sculptComponent = {"id": "porthole-01-glassm", "name": "Porthole01GlassMirror", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-01m", "attachment": {"parentId": "porthole-01m", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, -0.01], "rotation": [1.5708, 3.14159, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole01Glass solid geometry attached to porthole-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_glassm_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-01m"] ?? root).add(node_porthole_01_glassm_43);
  nodes["porthole-01-glassm"] = node_porthole_01_glassm_43;
  const mesh_porthole_01_glassm_43Geometry = endpoint_porthole_01_glassm_43
    ? new THREE.CylinderGeometry(endpoint_porthole_01_glassm_43.endRadius, endpoint_porthole_01_glassm_43.baseRadius, endpoint_porthole_01_glassm_43.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_01_glassm_43) {
    mesh_porthole_01_glassm_43Geometry.scale(0.38, 0.04, 0.38);
  }
  const mesh_porthole_01_glassm_43 = new THREE.Mesh(
    mesh_porthole_01_glassm_43Geometry,
    materialMap["porthole-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_01_glassm_43.name = "Porthole01GlassMirror";
  if (endpoint_porthole_01_glassm_43) {
    mesh_porthole_01_glassm_43.position.copy(endpoint_porthole_01_glassm_43.midpoint);
    mesh_porthole_01_glassm_43.quaternion.copy(endpoint_porthole_01_glassm_43.quaternion);
  }
  mesh_porthole_01_glassm_43.castShadow = options.castShadow ?? true;
  mesh_porthole_01_glassm_43.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_01_glassm_43.userData.sculptComponent = {"id": "porthole-01-glassm", "name": "Porthole01GlassMirror", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-01m", "attachment": {"parentId": "porthole-01m", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, -0.01], "rotation": [1.5708, 3.14159, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole01Glass solid geometry attached to porthole-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_glassm_43.add(mesh_porthole_01_glassm_43);
  meshes["porthole-01-glassm"] = mesh_porthole_01_glassm_43;
  colliders["porthole-01-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-01-glass"] ??= [];
  destructionGroups["porthole-01-glass"].push(node_porthole_01_glassm_43);

  const attachment_porthole_01_coralm_44 = {"parentId": "porthole-01m", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_01_coralm_44 = makeAttachmentEndpoint(attachment_porthole_01_coralm_44);
  const node_porthole_01_coralm_44 = new THREE.Group();
  node_porthole_01_coralm_44.name = "Porthole01CoralMirror__pivot";
  node_porthole_01_coralm_44.scale.set(1, 1, 1);
  if (endpoint_porthole_01_coralm_44) {
    node_porthole_01_coralm_44.position.copy(endpoint_porthole_01_coralm_44.start);
    node_porthole_01_coralm_44.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_01_coralm_44.position.set(0.0, 0.3, 0.0);
    node_porthole_01_coralm_44.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_01_coralm_44.userData.sculptComponent = {"id": "porthole-01-coralm", "name": "Porthole01CoralMirror", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-01m", "attachment": {"parentId": "porthole-01m", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.3, 0], "rotation": [0, 3.14159, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_coralm_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-01m"] ?? root).add(node_porthole_01_coralm_44);
  nodes["porthole-01-coralm"] = node_porthole_01_coralm_44;
  const mesh_porthole_01_coralm_44Geometry = endpoint_porthole_01_coralm_44
    ? new THREE.CylinderGeometry(endpoint_porthole_01_coralm_44.endRadius, endpoint_porthole_01_coralm_44.baseRadius, endpoint_porthole_01_coralm_44.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_porthole_01_coralm_44) {
    mesh_porthole_01_coralm_44Geometry.scale(0.12, 0.18, 0.12);
  }
  const mesh_porthole_01_coralm_44 = new THREE.Mesh(
    mesh_porthole_01_coralm_44Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_01_coralm_44.name = "Porthole01CoralMirror";
  if (endpoint_porthole_01_coralm_44) {
    mesh_porthole_01_coralm_44.position.copy(endpoint_porthole_01_coralm_44.midpoint);
    mesh_porthole_01_coralm_44.quaternion.copy(endpoint_porthole_01_coralm_44.quaternion);
  }
  mesh_porthole_01_coralm_44.castShadow = options.castShadow ?? true;
  mesh_porthole_01_coralm_44.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_01_coralm_44.userData.sculptComponent = {"id": "porthole-01-coralm", "name": "Porthole01CoralMirror", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-01m", "attachment": {"parentId": "porthole-01m", "parentSocket": "porthole-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.3, 0], "rotation": [0, 3.14159, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-01-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_01_coralm_44.add(mesh_porthole_01_coralm_44);
  meshes["porthole-01-coralm"] = mesh_porthole_01_coralm_44;
  colliders["porthole-01-coralm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-01-coral"] ??= [];
  destructionGroups["porthole-01-coral"].push(node_porthole_01_coralm_44);

  const attachment_porthole_02m_45 = {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_02m_45 = makeAttachmentEndpoint(attachment_porthole_02m_45);
  const node_porthole_02m_45 = new THREE.Group();
  node_porthole_02m_45.name = "Porthole02Mirror__pivot";
  node_porthole_02m_45.scale.set(1, 1, 1);
  if (endpoint_porthole_02m_45) {
    node_porthole_02m_45.position.copy(endpoint_porthole_02m_45.start);
    node_porthole_02m_45.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_02m_45.position.set(-0.3500000000000001, 0.0, -0.71);
    node_porthole_02m_45.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_02m_45.userData.sculptComponent = {"id": "porthole-02m", "name": "Porthole02Mirror", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.3500000000000001, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole02 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02m_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-system"] ?? root).add(node_porthole_02m_45);
  nodes["porthole-02m"] = node_porthole_02m_45;
  const mesh_porthole_02m_45Geometry = endpoint_porthole_02m_45
    ? new THREE.CylinderGeometry(endpoint_porthole_02m_45.endRadius, endpoint_porthole_02m_45.baseRadius, endpoint_porthole_02m_45.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_02m_45) {
    mesh_porthole_02m_45Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_porthole_02m_45 = new THREE.Mesh(
    mesh_porthole_02m_45Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_02m_45.name = "Porthole02Mirror";
  if (endpoint_porthole_02m_45) {
    mesh_porthole_02m_45.position.copy(endpoint_porthole_02m_45.midpoint);
    mesh_porthole_02m_45.quaternion.copy(endpoint_porthole_02m_45.quaternion);
  }
  mesh_porthole_02m_45.castShadow = options.castShadow ?? true;
  mesh_porthole_02m_45.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_02m_45.visible = false; // 容器节点不渲染
  mesh_porthole_02m_45.userData.sculptComponent = {"id": "porthole-02m", "name": "Porthole02Mirror", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.3500000000000001, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole02 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02m_45.add(mesh_porthole_02m_45);
  meshes["porthole-02m"] = mesh_porthole_02m_45;
  colliders["porthole-02m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-02"] ??= [];
  destructionGroups["porthole-02"].push(node_porthole_02m_45);

  const endpoint_porthole_02_ringm_46 = makeAttachmentEndpoint(null);
  const node_porthole_02_ringm_46 = new THREE.Group();
  node_porthole_02_ringm_46.name = "Porthole02RingMirror__pivot";
  node_porthole_02_ringm_46.scale.set(1, 1, 1);
  if (endpoint_porthole_02_ringm_46) {
    node_porthole_02_ringm_46.position.copy(endpoint_porthole_02_ringm_46.start);
    node_porthole_02_ringm_46.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_02_ringm_46.position.set(0.0, 0.0, 0.0);
    node_porthole_02_ringm_46.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_02_ringm_46.userData.sculptComponent = {"id": "porthole-02-ringm", "name": "Porthole02RingMirror", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-02m", "attachment": {"parentId": "porthole-02m", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_02_ringm_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-02m"] ?? root).add(node_porthole_02_ringm_46);
  nodes["porthole-02-ringm"] = node_porthole_02_ringm_46;
  const mesh_porthole_02_ringm_46Geometry = endpoint_porthole_02_ringm_46
    ? new THREE.CylinderGeometry(endpoint_porthole_02_ringm_46.endRadius, endpoint_porthole_02_ringm_46.baseRadius, endpoint_porthole_02_ringm_46.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_porthole_02_ringm_46) {
    mesh_porthole_02_ringm_46Geometry.scale(0.5, 0.5, 0.08);
  }
  const mesh_porthole_02_ringm_46 = new THREE.Mesh(
    mesh_porthole_02_ringm_46Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_02_ringm_46.name = "Porthole02RingMirror";
  if (endpoint_porthole_02_ringm_46) {
    mesh_porthole_02_ringm_46.position.copy(endpoint_porthole_02_ringm_46.midpoint);
    mesh_porthole_02_ringm_46.quaternion.copy(endpoint_porthole_02_ringm_46.quaternion);
  }
  mesh_porthole_02_ringm_46.castShadow = options.castShadow ?? true;
  mesh_porthole_02_ringm_46.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_02_ringm_46.userData.sculptComponent = {"id": "porthole-02-ringm", "name": "Porthole02RingMirror", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-02m", "attachment": {"parentId": "porthole-02m", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_02_ringm_46.add(mesh_porthole_02_ringm_46);
  meshes["porthole-02-ringm"] = mesh_porthole_02_ringm_46;
  colliders["porthole-02-ringm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-02-ring"] ??= [];
  destructionGroups["porthole-02-ring"].push(node_porthole_02_ringm_46);

  const attachment_porthole_02_glassm_47 = {"parentId": "porthole-02m", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_02_glassm_47 = makeAttachmentEndpoint(attachment_porthole_02_glassm_47);
  const node_porthole_02_glassm_47 = new THREE.Group();
  node_porthole_02_glassm_47.name = "Porthole02GlassMirror__pivot";
  node_porthole_02_glassm_47.scale.set(1, 1, 1);
  if (endpoint_porthole_02_glassm_47) {
    node_porthole_02_glassm_47.position.copy(endpoint_porthole_02_glassm_47.start);
    node_porthole_02_glassm_47.rotation.set(1.5708, 3.14159, 0.0);
  } else {
    node_porthole_02_glassm_47.position.set(0.0, 0.0, -0.01);
    node_porthole_02_glassm_47.rotation.set(1.5708, 3.14159, 0.0);
  }
  node_porthole_02_glassm_47.userData.sculptComponent = {"id": "porthole-02-glassm", "name": "Porthole02GlassMirror", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-02m", "attachment": {"parentId": "porthole-02m", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, -0.01], "rotation": [1.5708, 3.14159, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole02Glass solid geometry attached to porthole-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_glassm_47.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-02m"] ?? root).add(node_porthole_02_glassm_47);
  nodes["porthole-02-glassm"] = node_porthole_02_glassm_47;
  const mesh_porthole_02_glassm_47Geometry = endpoint_porthole_02_glassm_47
    ? new THREE.CylinderGeometry(endpoint_porthole_02_glassm_47.endRadius, endpoint_porthole_02_glassm_47.baseRadius, endpoint_porthole_02_glassm_47.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_02_glassm_47) {
    mesh_porthole_02_glassm_47Geometry.scale(0.38, 0.04, 0.38);
  }
  const mesh_porthole_02_glassm_47 = new THREE.Mesh(
    mesh_porthole_02_glassm_47Geometry,
    materialMap["porthole-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_02_glassm_47.name = "Porthole02GlassMirror";
  if (endpoint_porthole_02_glassm_47) {
    mesh_porthole_02_glassm_47.position.copy(endpoint_porthole_02_glassm_47.midpoint);
    mesh_porthole_02_glassm_47.quaternion.copy(endpoint_porthole_02_glassm_47.quaternion);
  }
  mesh_porthole_02_glassm_47.castShadow = options.castShadow ?? true;
  mesh_porthole_02_glassm_47.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_02_glassm_47.userData.sculptComponent = {"id": "porthole-02-glassm", "name": "Porthole02GlassMirror", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-02m", "attachment": {"parentId": "porthole-02m", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, -0.01], "rotation": [1.5708, 3.14159, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole02Glass solid geometry attached to porthole-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_glassm_47.add(mesh_porthole_02_glassm_47);
  meshes["porthole-02-glassm"] = mesh_porthole_02_glassm_47;
  colliders["porthole-02-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-02-glass"] ??= [];
  destructionGroups["porthole-02-glass"].push(node_porthole_02_glassm_47);

  const attachment_porthole_02_coralm_48 = {"parentId": "porthole-02m", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_02_coralm_48 = makeAttachmentEndpoint(attachment_porthole_02_coralm_48);
  const node_porthole_02_coralm_48 = new THREE.Group();
  node_porthole_02_coralm_48.name = "Porthole02CoralMirror__pivot";
  node_porthole_02_coralm_48.scale.set(1, 1, 1);
  if (endpoint_porthole_02_coralm_48) {
    node_porthole_02_coralm_48.position.copy(endpoint_porthole_02_coralm_48.start);
    node_porthole_02_coralm_48.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_02_coralm_48.position.set(0.0, 0.3, 0.0);
    node_porthole_02_coralm_48.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_02_coralm_48.userData.sculptComponent = {"id": "porthole-02-coralm", "name": "Porthole02CoralMirror", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-02m", "attachment": {"parentId": "porthole-02m", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.3, 0], "rotation": [0, 3.14159, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_coralm_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-02m"] ?? root).add(node_porthole_02_coralm_48);
  nodes["porthole-02-coralm"] = node_porthole_02_coralm_48;
  const mesh_porthole_02_coralm_48Geometry = endpoint_porthole_02_coralm_48
    ? new THREE.CylinderGeometry(endpoint_porthole_02_coralm_48.endRadius, endpoint_porthole_02_coralm_48.baseRadius, endpoint_porthole_02_coralm_48.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_porthole_02_coralm_48) {
    mesh_porthole_02_coralm_48Geometry.scale(0.12, 0.18, 0.12);
  }
  const mesh_porthole_02_coralm_48 = new THREE.Mesh(
    mesh_porthole_02_coralm_48Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_02_coralm_48.name = "Porthole02CoralMirror";
  if (endpoint_porthole_02_coralm_48) {
    mesh_porthole_02_coralm_48.position.copy(endpoint_porthole_02_coralm_48.midpoint);
    mesh_porthole_02_coralm_48.quaternion.copy(endpoint_porthole_02_coralm_48.quaternion);
  }
  mesh_porthole_02_coralm_48.castShadow = options.castShadow ?? true;
  mesh_porthole_02_coralm_48.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_02_coralm_48.userData.sculptComponent = {"id": "porthole-02-coralm", "name": "Porthole02CoralMirror", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-02m", "attachment": {"parentId": "porthole-02m", "parentSocket": "porthole-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.3, 0], "rotation": [0, 3.14159, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-02-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_02_coralm_48.add(mesh_porthole_02_coralm_48);
  meshes["porthole-02-coralm"] = mesh_porthole_02_coralm_48;
  colliders["porthole-02-coralm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-02-coral"] ??= [];
  destructionGroups["porthole-02-coral"].push(node_porthole_02_coralm_48);

  const attachment_porthole_03m_49 = {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_03m_49 = makeAttachmentEndpoint(attachment_porthole_03m_49);
  const node_porthole_03m_49 = new THREE.Group();
  node_porthole_03m_49.name = "Porthole03Mirror__pivot";
  node_porthole_03m_49.scale.set(1, 1, 1);
  if (endpoint_porthole_03m_49) {
    node_porthole_03m_49.position.copy(endpoint_porthole_03m_49.start);
    node_porthole_03m_49.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_03m_49.position.set(0.34999999999999987, 0.0, -0.71);
    node_porthole_03m_49.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_03m_49.userData.sculptComponent = {"id": "porthole-03m", "name": "Porthole03Mirror", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.34999999999999987, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole03 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03m_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-system"] ?? root).add(node_porthole_03m_49);
  nodes["porthole-03m"] = node_porthole_03m_49;
  const mesh_porthole_03m_49Geometry = endpoint_porthole_03m_49
    ? new THREE.CylinderGeometry(endpoint_porthole_03m_49.endRadius, endpoint_porthole_03m_49.baseRadius, endpoint_porthole_03m_49.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_03m_49) {
    mesh_porthole_03m_49Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_porthole_03m_49 = new THREE.Mesh(
    mesh_porthole_03m_49Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_03m_49.name = "Porthole03Mirror";
  if (endpoint_porthole_03m_49) {
    mesh_porthole_03m_49.position.copy(endpoint_porthole_03m_49.midpoint);
    mesh_porthole_03m_49.quaternion.copy(endpoint_porthole_03m_49.quaternion);
  }
  mesh_porthole_03m_49.castShadow = options.castShadow ?? true;
  mesh_porthole_03m_49.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_03m_49.visible = false; // 容器节点不渲染
  mesh_porthole_03m_49.userData.sculptComponent = {"id": "porthole-03m", "name": "Porthole03Mirror", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.34999999999999987, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole03 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03m_49.add(mesh_porthole_03m_49);
  meshes["porthole-03m"] = mesh_porthole_03m_49;
  colliders["porthole-03m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-03"] ??= [];
  destructionGroups["porthole-03"].push(node_porthole_03m_49);

  const endpoint_porthole_03_ringm_50 = makeAttachmentEndpoint(null);
  const node_porthole_03_ringm_50 = new THREE.Group();
  node_porthole_03_ringm_50.name = "Porthole03RingMirror__pivot";
  node_porthole_03_ringm_50.scale.set(1, 1, 1);
  if (endpoint_porthole_03_ringm_50) {
    node_porthole_03_ringm_50.position.copy(endpoint_porthole_03_ringm_50.start);
    node_porthole_03_ringm_50.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_03_ringm_50.position.set(0.0, 0.0, 0.0);
    node_porthole_03_ringm_50.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_03_ringm_50.userData.sculptComponent = {"id": "porthole-03-ringm", "name": "Porthole03RingMirror", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-03m", "attachment": {"parentId": "porthole-03m", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_03_ringm_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-03m"] ?? root).add(node_porthole_03_ringm_50);
  nodes["porthole-03-ringm"] = node_porthole_03_ringm_50;
  const mesh_porthole_03_ringm_50Geometry = endpoint_porthole_03_ringm_50
    ? new THREE.CylinderGeometry(endpoint_porthole_03_ringm_50.endRadius, endpoint_porthole_03_ringm_50.baseRadius, endpoint_porthole_03_ringm_50.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_porthole_03_ringm_50) {
    mesh_porthole_03_ringm_50Geometry.scale(0.5, 0.5, 0.08);
  }
  const mesh_porthole_03_ringm_50 = new THREE.Mesh(
    mesh_porthole_03_ringm_50Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_03_ringm_50.name = "Porthole03RingMirror";
  if (endpoint_porthole_03_ringm_50) {
    mesh_porthole_03_ringm_50.position.copy(endpoint_porthole_03_ringm_50.midpoint);
    mesh_porthole_03_ringm_50.quaternion.copy(endpoint_porthole_03_ringm_50.quaternion);
  }
  mesh_porthole_03_ringm_50.castShadow = options.castShadow ?? true;
  mesh_porthole_03_ringm_50.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_03_ringm_50.userData.sculptComponent = {"id": "porthole-03-ringm", "name": "Porthole03RingMirror", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-03m", "attachment": {"parentId": "porthole-03m", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_03_ringm_50.add(mesh_porthole_03_ringm_50);
  meshes["porthole-03-ringm"] = mesh_porthole_03_ringm_50;
  colliders["porthole-03-ringm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-03-ring"] ??= [];
  destructionGroups["porthole-03-ring"].push(node_porthole_03_ringm_50);

  const attachment_porthole_03_glassm_51 = {"parentId": "porthole-03m", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_03_glassm_51 = makeAttachmentEndpoint(attachment_porthole_03_glassm_51);
  const node_porthole_03_glassm_51 = new THREE.Group();
  node_porthole_03_glassm_51.name = "Porthole03GlassMirror__pivot";
  node_porthole_03_glassm_51.scale.set(1, 1, 1);
  if (endpoint_porthole_03_glassm_51) {
    node_porthole_03_glassm_51.position.copy(endpoint_porthole_03_glassm_51.start);
    node_porthole_03_glassm_51.rotation.set(1.5708, 3.14159, 0.0);
  } else {
    node_porthole_03_glassm_51.position.set(0.0, 0.0, -0.01);
    node_porthole_03_glassm_51.rotation.set(1.5708, 3.14159, 0.0);
  }
  node_porthole_03_glassm_51.userData.sculptComponent = {"id": "porthole-03-glassm", "name": "Porthole03GlassMirror", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-03m", "attachment": {"parentId": "porthole-03m", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, -0.01], "rotation": [1.5708, 3.14159, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole03Glass solid geometry attached to porthole-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_glassm_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-03m"] ?? root).add(node_porthole_03_glassm_51);
  nodes["porthole-03-glassm"] = node_porthole_03_glassm_51;
  const mesh_porthole_03_glassm_51Geometry = endpoint_porthole_03_glassm_51
    ? new THREE.CylinderGeometry(endpoint_porthole_03_glassm_51.endRadius, endpoint_porthole_03_glassm_51.baseRadius, endpoint_porthole_03_glassm_51.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_03_glassm_51) {
    mesh_porthole_03_glassm_51Geometry.scale(0.38, 0.04, 0.38);
  }
  const mesh_porthole_03_glassm_51 = new THREE.Mesh(
    mesh_porthole_03_glassm_51Geometry,
    materialMap["porthole-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_03_glassm_51.name = "Porthole03GlassMirror";
  if (endpoint_porthole_03_glassm_51) {
    mesh_porthole_03_glassm_51.position.copy(endpoint_porthole_03_glassm_51.midpoint);
    mesh_porthole_03_glassm_51.quaternion.copy(endpoint_porthole_03_glassm_51.quaternion);
  }
  mesh_porthole_03_glassm_51.castShadow = options.castShadow ?? true;
  mesh_porthole_03_glassm_51.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_03_glassm_51.userData.sculptComponent = {"id": "porthole-03-glassm", "name": "Porthole03GlassMirror", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-03m", "attachment": {"parentId": "porthole-03m", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, -0.01], "rotation": [1.5708, 3.14159, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole03Glass solid geometry attached to porthole-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_glassm_51.add(mesh_porthole_03_glassm_51);
  meshes["porthole-03-glassm"] = mesh_porthole_03_glassm_51;
  colliders["porthole-03-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-03-glass"] ??= [];
  destructionGroups["porthole-03-glass"].push(node_porthole_03_glassm_51);

  const attachment_porthole_03_coralm_52 = {"parentId": "porthole-03m", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_03_coralm_52 = makeAttachmentEndpoint(attachment_porthole_03_coralm_52);
  const node_porthole_03_coralm_52 = new THREE.Group();
  node_porthole_03_coralm_52.name = "Porthole03CoralMirror__pivot";
  node_porthole_03_coralm_52.scale.set(1, 1, 1);
  if (endpoint_porthole_03_coralm_52) {
    node_porthole_03_coralm_52.position.copy(endpoint_porthole_03_coralm_52.start);
    node_porthole_03_coralm_52.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_03_coralm_52.position.set(0.0, 0.3, 0.0);
    node_porthole_03_coralm_52.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_03_coralm_52.userData.sculptComponent = {"id": "porthole-03-coralm", "name": "Porthole03CoralMirror", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-03m", "attachment": {"parentId": "porthole-03m", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.3, 0], "rotation": [0, 3.14159, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_coralm_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-03m"] ?? root).add(node_porthole_03_coralm_52);
  nodes["porthole-03-coralm"] = node_porthole_03_coralm_52;
  const mesh_porthole_03_coralm_52Geometry = endpoint_porthole_03_coralm_52
    ? new THREE.CylinderGeometry(endpoint_porthole_03_coralm_52.endRadius, endpoint_porthole_03_coralm_52.baseRadius, endpoint_porthole_03_coralm_52.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_porthole_03_coralm_52) {
    mesh_porthole_03_coralm_52Geometry.scale(0.12, 0.18, 0.12);
  }
  const mesh_porthole_03_coralm_52 = new THREE.Mesh(
    mesh_porthole_03_coralm_52Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_03_coralm_52.name = "Porthole03CoralMirror";
  if (endpoint_porthole_03_coralm_52) {
    mesh_porthole_03_coralm_52.position.copy(endpoint_porthole_03_coralm_52.midpoint);
    mesh_porthole_03_coralm_52.quaternion.copy(endpoint_porthole_03_coralm_52.quaternion);
  }
  mesh_porthole_03_coralm_52.castShadow = options.castShadow ?? true;
  mesh_porthole_03_coralm_52.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_03_coralm_52.userData.sculptComponent = {"id": "porthole-03-coralm", "name": "Porthole03CoralMirror", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-03m", "attachment": {"parentId": "porthole-03m", "parentSocket": "porthole-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.3, 0], "rotation": [0, 3.14159, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-03-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_03_coralm_52.add(mesh_porthole_03_coralm_52);
  meshes["porthole-03-coralm"] = mesh_porthole_03_coralm_52;
  colliders["porthole-03-coralm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-03-coral"] ??= [];
  destructionGroups["porthole-03-coral"].push(node_porthole_03_coralm_52);

  const attachment_porthole_04m_53 = {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_04m_53 = makeAttachmentEndpoint(attachment_porthole_04m_53);
  const node_porthole_04m_53 = new THREE.Group();
  node_porthole_04m_53.name = "Porthole04Mirror__pivot";
  node_porthole_04m_53.scale.set(1, 1, 1);
  if (endpoint_porthole_04m_53) {
    node_porthole_04m_53.position.copy(endpoint_porthole_04m_53.start);
    node_porthole_04m_53.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_04m_53.position.set(1.0499999999999996, 0.0, -0.71);
    node_porthole_04m_53.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_04m_53.userData.sculptComponent = {"id": "porthole-04m", "name": "Porthole04Mirror", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.0499999999999996, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole04 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04m_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-system"] ?? root).add(node_porthole_04m_53);
  nodes["porthole-04m"] = node_porthole_04m_53;
  const mesh_porthole_04m_53Geometry = endpoint_porthole_04m_53
    ? new THREE.CylinderGeometry(endpoint_porthole_04m_53.endRadius, endpoint_porthole_04m_53.baseRadius, endpoint_porthole_04m_53.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_04m_53) {
    mesh_porthole_04m_53Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_porthole_04m_53 = new THREE.Mesh(
    mesh_porthole_04m_53Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_04m_53.name = "Porthole04Mirror";
  if (endpoint_porthole_04m_53) {
    mesh_porthole_04m_53.position.copy(endpoint_porthole_04m_53.midpoint);
    mesh_porthole_04m_53.quaternion.copy(endpoint_porthole_04m_53.quaternion);
  }
  mesh_porthole_04m_53.castShadow = options.castShadow ?? true;
  mesh_porthole_04m_53.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_04m_53.visible = false; // 容器节点不渲染
  mesh_porthole_04m_53.userData.sculptComponent = {"id": "porthole-04m", "name": "Porthole04Mirror", "level": "meso", "role": "porthole", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-system", "attachment": {"parentId": "porthole-system", "parentSocket": "porthole-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.0499999999999996, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole04 solid geometry attached to porthole-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04m_53.add(mesh_porthole_04m_53);
  meshes["porthole-04m"] = mesh_porthole_04m_53;
  colliders["porthole-04m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-04"] ??= [];
  destructionGroups["porthole-04"].push(node_porthole_04m_53);

  const endpoint_porthole_04_ringm_54 = makeAttachmentEndpoint(null);
  const node_porthole_04_ringm_54 = new THREE.Group();
  node_porthole_04_ringm_54.name = "Porthole04RingMirror__pivot";
  node_porthole_04_ringm_54.scale.set(1, 1, 1);
  if (endpoint_porthole_04_ringm_54) {
    node_porthole_04_ringm_54.position.copy(endpoint_porthole_04_ringm_54.start);
    node_porthole_04_ringm_54.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_04_ringm_54.position.set(0.0, 0.0, 0.0);
    node_porthole_04_ringm_54.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_04_ringm_54.userData.sculptComponent = {"id": "porthole-04-ringm", "name": "Porthole04RingMirror", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-04m", "attachment": {"parentId": "porthole-04m", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_04_ringm_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-04m"] ?? root).add(node_porthole_04_ringm_54);
  nodes["porthole-04-ringm"] = node_porthole_04_ringm_54;
  const mesh_porthole_04_ringm_54Geometry = endpoint_porthole_04_ringm_54
    ? new THREE.CylinderGeometry(endpoint_porthole_04_ringm_54.endRadius, endpoint_porthole_04_ringm_54.baseRadius, endpoint_porthole_04_ringm_54.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_porthole_04_ringm_54) {
    mesh_porthole_04_ringm_54Geometry.scale(0.5, 0.5, 0.08);
  }
  const mesh_porthole_04_ringm_54 = new THREE.Mesh(
    mesh_porthole_04_ringm_54Geometry,
    materialMap["gold-ring"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_04_ringm_54.name = "Porthole04RingMirror";
  if (endpoint_porthole_04_ringm_54) {
    mesh_porthole_04_ringm_54.position.copy(endpoint_porthole_04_ringm_54.midpoint);
    mesh_porthole_04_ringm_54.quaternion.copy(endpoint_porthole_04_ringm_54.quaternion);
  }
  mesh_porthole_04_ringm_54.castShadow = options.castShadow ?? true;
  mesh_porthole_04_ringm_54.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_04_ringm_54.userData.sculptComponent = {"id": "porthole-04-ringm", "name": "Porthole04RingMirror", "level": "meso", "role": "porthole-part", "importance": 0.7, "confidence": 0.85, "primitive": "torus", "topologyClass": "assembled-solid", "parent": "porthole-04m", "attachment": {"parentId": "porthole-04m", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.5, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.5, 0.5, 0.08]}, "material": "gold-ring", "evidenceRefs": ["full-object"], "topologyRationale": "Gold ring framing the round porthole", "colorMaterialRecipe": {"dominantAlbedo": "rgba(200, 160, 64, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "geometryDescriptor": {"torusTubeRatio": 0.18}};
  node_porthole_04_ringm_54.add(mesh_porthole_04_ringm_54);
  meshes["porthole-04-ringm"] = mesh_porthole_04_ringm_54;
  colliders["porthole-04-ringm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-04-ring"] ??= [];
  destructionGroups["porthole-04-ring"].push(node_porthole_04_ringm_54);

  const attachment_porthole_04_glassm_55 = {"parentId": "porthole-04m", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_04_glassm_55 = makeAttachmentEndpoint(attachment_porthole_04_glassm_55);
  const node_porthole_04_glassm_55 = new THREE.Group();
  node_porthole_04_glassm_55.name = "Porthole04GlassMirror__pivot";
  node_porthole_04_glassm_55.scale.set(1, 1, 1);
  if (endpoint_porthole_04_glassm_55) {
    node_porthole_04_glassm_55.position.copy(endpoint_porthole_04_glassm_55.start);
    node_porthole_04_glassm_55.rotation.set(1.5708, 3.14159, 0.0);
  } else {
    node_porthole_04_glassm_55.position.set(0.0, 0.0, -0.01);
    node_porthole_04_glassm_55.rotation.set(1.5708, 3.14159, 0.0);
  }
  node_porthole_04_glassm_55.userData.sculptComponent = {"id": "porthole-04-glassm", "name": "Porthole04GlassMirror", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-04m", "attachment": {"parentId": "porthole-04m", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, -0.01], "rotation": [1.5708, 3.14159, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole04Glass solid geometry attached to porthole-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_glassm_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-04m"] ?? root).add(node_porthole_04_glassm_55);
  nodes["porthole-04-glassm"] = node_porthole_04_glassm_55;
  const mesh_porthole_04_glassm_55Geometry = endpoint_porthole_04_glassm_55
    ? new THREE.CylinderGeometry(endpoint_porthole_04_glassm_55.endRadius, endpoint_porthole_04_glassm_55.baseRadius, endpoint_porthole_04_glassm_55.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_porthole_04_glassm_55) {
    mesh_porthole_04_glassm_55Geometry.scale(0.38, 0.04, 0.38);
  }
  const mesh_porthole_04_glassm_55 = new THREE.Mesh(
    mesh_porthole_04_glassm_55Geometry,
    materialMap["porthole-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_04_glassm_55.name = "Porthole04GlassMirror";
  if (endpoint_porthole_04_glassm_55) {
    mesh_porthole_04_glassm_55.position.copy(endpoint_porthole_04_glassm_55.midpoint);
    mesh_porthole_04_glassm_55.quaternion.copy(endpoint_porthole_04_glassm_55.quaternion);
  }
  mesh_porthole_04_glassm_55.castShadow = options.castShadow ?? true;
  mesh_porthole_04_glassm_55.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_04_glassm_55.userData.sculptComponent = {"id": "porthole-04-glassm", "name": "Porthole04GlassMirror", "level": "meso", "role": "porthole-part", "importance": 0.65, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "porthole-04m", "attachment": {"parentId": "porthole-04m", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.04, "depth": 0.38, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, -0.01], "rotation": [1.5708, 3.14159, 0], "scale": [0.38, 0.04, 0.38]}, "material": "porthole-glass", "evidenceRefs": ["full-object"], "topologyRationale": "Porthole04Glass solid geometry attached to porthole-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(122, 192, 216, 1.0)", "secondaryAlbedo": "rgba(90, 168, 200, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_glassm_55.add(mesh_porthole_04_glassm_55);
  meshes["porthole-04-glassm"] = mesh_porthole_04_glassm_55;
  colliders["porthole-04-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-04-glass"] ??= [];
  destructionGroups["porthole-04-glass"].push(node_porthole_04_glassm_55);

  const attachment_porthole_04_coralm_56 = {"parentId": "porthole-04m", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_porthole_04_coralm_56 = makeAttachmentEndpoint(attachment_porthole_04_coralm_56);
  const node_porthole_04_coralm_56 = new THREE.Group();
  node_porthole_04_coralm_56.name = "Porthole04CoralMirror__pivot";
  node_porthole_04_coralm_56.scale.set(1, 1, 1);
  if (endpoint_porthole_04_coralm_56) {
    node_porthole_04_coralm_56.position.copy(endpoint_porthole_04_coralm_56.start);
    node_porthole_04_coralm_56.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_porthole_04_coralm_56.position.set(0.0, 0.3, 0.0);
    node_porthole_04_coralm_56.rotation.set(0.0, 3.14159, 0.0);
  }
  node_porthole_04_coralm_56.userData.sculptComponent = {"id": "porthole-04-coralm", "name": "Porthole04CoralMirror", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-04m", "attachment": {"parentId": "porthole-04m", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.3, 0], "rotation": [0, 3.14159, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_coralm_56.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["porthole-04m"] ?? root).add(node_porthole_04_coralm_56);
  nodes["porthole-04-coralm"] = node_porthole_04_coralm_56;
  const mesh_porthole_04_coralm_56Geometry = endpoint_porthole_04_coralm_56
    ? new THREE.CylinderGeometry(endpoint_porthole_04_coralm_56.endRadius, endpoint_porthole_04_coralm_56.baseRadius, endpoint_porthole_04_coralm_56.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_porthole_04_coralm_56) {
    mesh_porthole_04_coralm_56Geometry.scale(0.12, 0.18, 0.12);
  }
  const mesh_porthole_04_coralm_56 = new THREE.Mesh(
    mesh_porthole_04_coralm_56Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_porthole_04_coralm_56.name = "Porthole04CoralMirror";
  if (endpoint_porthole_04_coralm_56) {
    mesh_porthole_04_coralm_56.position.copy(endpoint_porthole_04_coralm_56.midpoint);
    mesh_porthole_04_coralm_56.quaternion.copy(endpoint_porthole_04_coralm_56.quaternion);
  }
  mesh_porthole_04_coralm_56.castShadow = options.castShadow ?? true;
  mesh_porthole_04_coralm_56.receiveShadow = options.receiveShadow ?? true;
  mesh_porthole_04_coralm_56.userData.sculptComponent = {"id": "porthole-04-coralm", "name": "Porthole04CoralMirror", "level": "meso", "role": "decoration", "importance": 0.6, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "porthole-04m", "attachment": {"parentId": "porthole-04m", "parentSocket": "porthole-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.18, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.3, 0], "rotation": [0, 3.14159, 0], "scale": [0.12, 0.18, 0.12]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Pink coral tuft crowning the porthole ring", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "porthole-04-coral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_porthole_04_coralm_56.add(mesh_porthole_04_coralm_56);
  meshes["porthole-04-coralm"] = mesh_porthole_04_coralm_56;
  colliders["porthole-04-coralm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["porthole-04-coral"] ??= [];
  destructionGroups["porthole-04-coral"].push(node_porthole_04_coralm_56);

  const attachment_coral_decor_1m_57 = {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coral_decor_1m_57 = makeAttachmentEndpoint(attachment_coral_decor_1m_57);
  const node_coral_decor_1m_57 = new THREE.Group();
  node_coral_decor_1m_57.name = "CoralDecor1Mirror__pivot";
  node_coral_decor_1m_57.scale.set(1, 1, 1);
  if (endpoint_coral_decor_1m_57) {
    node_coral_decor_1m_57.position.copy(endpoint_coral_decor_1m_57.start);
    node_coral_decor_1m_57.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coral_decor_1m_57.position.set(-1.3, 0.55, -0.75);
    node_coral_decor_1m_57.rotation.set(0.0, 0.0, 0.0);
  }
  node_coral_decor_1m_57.userData.sculptComponent = {"id": "coral-decor-1m", "name": "CoralDecor1Mirror", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.3, 0.55, -0.75], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_1m_57.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_coral_decor_1m_57);
  nodes["coral-decor-1m"] = node_coral_decor_1m_57;
  const mesh_coral_decor_1m_57Geometry = endpoint_coral_decor_1m_57
    ? new THREE.CylinderGeometry(endpoint_coral_decor_1m_57.endRadius, endpoint_coral_decor_1m_57.baseRadius, endpoint_coral_decor_1m_57.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_coral_decor_1m_57) {
    mesh_coral_decor_1m_57Geometry.scale(0.16, 0.3, 0.16);
  }
  const mesh_coral_decor_1m_57 = new THREE.Mesh(
    mesh_coral_decor_1m_57Geometry,
    materialMap["coral-pink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coral_decor_1m_57.name = "CoralDecor1Mirror";
  if (endpoint_coral_decor_1m_57) {
    mesh_coral_decor_1m_57.position.copy(endpoint_coral_decor_1m_57.midpoint);
    mesh_coral_decor_1m_57.quaternion.copy(endpoint_coral_decor_1m_57.quaternion);
  }
  mesh_coral_decor_1m_57.castShadow = options.castShadow ?? true;
  mesh_coral_decor_1m_57.receiveShadow = options.receiveShadow ?? true;
  mesh_coral_decor_1m_57.userData.sculptComponent = {"id": "coral-decor-1m", "name": "CoralDecor1Mirror", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.3, 0.55, -0.75], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "coral-pink", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 120, 138, 1.0)", "secondaryAlbedo": "rgba(200, 88, 112, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_1m_57.add(mesh_coral_decor_1m_57);
  meshes["coral-decor-1m"] = mesh_coral_decor_1m_57;
  colliders["coral-decor-1m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coral-decor-1"] ??= [];
  destructionGroups["coral-decor-1"].push(node_coral_decor_1m_57);

  const attachment_coral_decor_2m_58 = {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coral_decor_2m_58 = makeAttachmentEndpoint(attachment_coral_decor_2m_58);
  const node_coral_decor_2m_58 = new THREE.Group();
  node_coral_decor_2m_58.name = "CoralDecor2Mirror__pivot";
  node_coral_decor_2m_58.scale.set(1, 1, 1);
  if (endpoint_coral_decor_2m_58) {
    node_coral_decor_2m_58.position.copy(endpoint_coral_decor_2m_58.start);
    node_coral_decor_2m_58.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coral_decor_2m_58.position.set(1.3, 0.55, -0.75);
    node_coral_decor_2m_58.rotation.set(0.0, 0.0, 0.0);
  }
  node_coral_decor_2m_58.userData.sculptComponent = {"id": "coral-decor-2m", "name": "CoralDecor2Mirror", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [1.3, 0.55, -0.75], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_2m_58.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_coral_decor_2m_58);
  nodes["coral-decor-2m"] = node_coral_decor_2m_58;
  const mesh_coral_decor_2m_58Geometry = endpoint_coral_decor_2m_58
    ? new THREE.CylinderGeometry(endpoint_coral_decor_2m_58.endRadius, endpoint_coral_decor_2m_58.baseRadius, endpoint_coral_decor_2m_58.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_coral_decor_2m_58) {
    mesh_coral_decor_2m_58Geometry.scale(0.16, 0.3, 0.16);
  }
  const mesh_coral_decor_2m_58 = new THREE.Mesh(
    mesh_coral_decor_2m_58Geometry,
    materialMap["seaweed-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coral_decor_2m_58.name = "CoralDecor2Mirror";
  if (endpoint_coral_decor_2m_58) {
    mesh_coral_decor_2m_58.position.copy(endpoint_coral_decor_2m_58.midpoint);
    mesh_coral_decor_2m_58.quaternion.copy(endpoint_coral_decor_2m_58.quaternion);
  }
  mesh_coral_decor_2m_58.castShadow = options.castShadow ?? true;
  mesh_coral_decor_2m_58.receiveShadow = options.receiveShadow ?? true;
  mesh_coral_decor_2m_58.userData.sculptComponent = {"id": "coral-decor-2m", "name": "CoralDecor2Mirror", "level": "meso", "role": "decoration", "importance": 0.55, "confidence": 0.8, "primitive": "cone", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.16, "height": 0.3, "depth": 0.16, "units": "world", "confidence": 0.8}, "transform": {"position": [1.3, 0.55, -0.75], "rotation": [0, 0, 0], "scale": [0.16, 0.3, 0.16]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Coral tuft decorating the body base", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coral-decor-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coral_decor_2m_58.add(mesh_coral_decor_2m_58);
  meshes["coral-decor-2m"] = mesh_coral_decor_2m_58;
  colliders["coral-decor-2m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coral-decor-2"] ??= [];
  destructionGroups["coral-decor-2"].push(node_coral_decor_2m_58);

  const endpoint_seaweed_1m_59 = makeAttachmentEndpoint(null);
  const node_seaweed_1m_59 = new THREE.Group();
  node_seaweed_1m_59.name = "Seaweed1Mirror__pivot";
  node_seaweed_1m_59.scale.set(1, 1, 1);
  if (endpoint_seaweed_1m_59) {
    node_seaweed_1m_59.position.copy(endpoint_seaweed_1m_59.start);
    node_seaweed_1m_59.rotation.set(0.0, 0.0, 0.20944);
  } else {
    node_seaweed_1m_59.position.set(1.35, 1.9, -0.4);
    node_seaweed_1m_59.rotation.set(0.0, 0.0, 0.20944);
  }
  node_seaweed_1m_59.userData.sculptComponent = {"id": "seaweed-1m", "name": "Seaweed1Mirror", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.8}, "transform": {"position": [1.35, 1.9, -0.4], "rotation": [0, 0, 0.20944], "scale": [0.1, 0.5, 0.06]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Seaweed1 solid geometry attached to ocean-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "seaweed-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_seaweed_1m_59.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "seaweed-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_seaweed_1m_59);
  nodes["seaweed-1m"] = node_seaweed_1m_59;
  const mesh_seaweed_1m_59Geometry = endpoint_seaweed_1m_59
    ? new THREE.CylinderGeometry(endpoint_seaweed_1m_59.endRadius, endpoint_seaweed_1m_59.baseRadius, endpoint_seaweed_1m_59.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_seaweed_1m_59) {
    mesh_seaweed_1m_59Geometry.scale(0.1, 0.5, 0.06);
  }
  const mesh_seaweed_1m_59 = new THREE.Mesh(
    mesh_seaweed_1m_59Geometry,
    materialMap["seaweed-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seaweed_1m_59.name = "Seaweed1Mirror";
  if (endpoint_seaweed_1m_59) {
    mesh_seaweed_1m_59.position.copy(endpoint_seaweed_1m_59.midpoint);
    mesh_seaweed_1m_59.quaternion.copy(endpoint_seaweed_1m_59.quaternion);
  }
  mesh_seaweed_1m_59.castShadow = options.castShadow ?? true;
  mesh_seaweed_1m_59.receiveShadow = options.receiveShadow ?? true;
  mesh_seaweed_1m_59.userData.sculptComponent = {"id": "seaweed-1m", "name": "Seaweed1Mirror", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.1, "height": 0.5, "depth": 0.06, "units": "world", "confidence": 0.8}, "transform": {"position": [1.35, 1.9, -0.4], "rotation": [0, 0, 0.20944], "scale": [0.1, 0.5, 0.06]}, "material": "seaweed-green", "evidenceRefs": ["full-object"], "topologyRationale": "Seaweed1 solid geometry attached to ocean-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 168, 74, 1.0)", "secondaryAlbedo": "rgba(74, 136, 54, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "seaweed-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_seaweed_1m_59.add(mesh_seaweed_1m_59);
  meshes["seaweed-1m"] = mesh_seaweed_1m_59;
  colliders["seaweed-1m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["seaweed-1"] ??= [];
  destructionGroups["seaweed-1"].push(node_seaweed_1m_59);

  const endpoint_fish_1m_60 = makeAttachmentEndpoint(null);
  const node_fish_1m_60 = new THREE.Group();
  node_fish_1m_60.name = "Fish1Mirror__pivot";
  node_fish_1m_60.scale.set(1, 1, 1);
  if (endpoint_fish_1m_60) {
    node_fish_1m_60.position.copy(endpoint_fish_1m_60.start);
    node_fish_1m_60.rotation.set(0.0, -0.17453, 0.0);
  } else {
    node_fish_1m_60.position.set(-1.2, 0.55, -0.78);
    node_fish_1m_60.rotation.set(0.0, -0.17453, 0.0);
  }
  node_fish_1m_60.userData.sculptComponent = {"id": "fish-1m", "name": "Fish1Mirror", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.2, 0.55, -0.78], "rotation": [0, -0.17453, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-orange", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 136, 64, 1.0)", "secondaryAlbedo": "rgba(200, 104, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_1m_60.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_fish_1m_60);
  nodes["fish-1m"] = node_fish_1m_60;
  const mesh_fish_1m_60Geometry = endpoint_fish_1m_60
    ? new THREE.CylinderGeometry(endpoint_fish_1m_60.endRadius, endpoint_fish_1m_60.baseRadius, endpoint_fish_1m_60.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_fish_1m_60) {
    mesh_fish_1m_60Geometry.scale(0.22, 0.16, 0.1);
  }
  const mesh_fish_1m_60 = new THREE.Mesh(
    mesh_fish_1m_60Geometry,
    materialMap["fish-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fish_1m_60.name = "Fish1Mirror";
  if (endpoint_fish_1m_60) {
    mesh_fish_1m_60.position.copy(endpoint_fish_1m_60.midpoint);
    mesh_fish_1m_60.quaternion.copy(endpoint_fish_1m_60.quaternion);
  }
  mesh_fish_1m_60.castShadow = options.castShadow ?? true;
  mesh_fish_1m_60.receiveShadow = options.receiveShadow ?? true;
  mesh_fish_1m_60.userData.sculptComponent = {"id": "fish-1m", "name": "Fish1Mirror", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.2, 0.55, -0.78], "rotation": [0, -0.17453, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-orange", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 136, 64, 1.0)", "secondaryAlbedo": "rgba(200, 104, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_1m_60.add(mesh_fish_1m_60);
  meshes["fish-1m"] = mesh_fish_1m_60;
  colliders["fish-1m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["fish-1"] ??= [];
  destructionGroups["fish-1"].push(node_fish_1m_60);

  const endpoint_fish_2m_61 = makeAttachmentEndpoint(null);
  const node_fish_2m_61 = new THREE.Group();
  node_fish_2m_61.name = "Fish2Mirror__pivot";
  node_fish_2m_61.scale.set(1, 1, 1);
  if (endpoint_fish_2m_61) {
    node_fish_2m_61.position.copy(endpoint_fish_2m_61.start);
    node_fish_2m_61.rotation.set(0.0, 0.17453, 0.0);
  } else {
    node_fish_2m_61.position.set(-0.3, 0.4, -0.78);
    node_fish_2m_61.rotation.set(0.0, 0.17453, 0.0);
  }
  node_fish_2m_61.userData.sculptComponent = {"id": "fish-2m", "name": "Fish2Mirror", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.3, 0.4, -0.78], "rotation": [0, 0.17453, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-teal", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(72, 184, 168, 1.0)", "secondaryAlbedo": "rgba(56, 152, 136, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_2m_61.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_fish_2m_61);
  nodes["fish-2m"] = node_fish_2m_61;
  const mesh_fish_2m_61Geometry = endpoint_fish_2m_61
    ? new THREE.CylinderGeometry(endpoint_fish_2m_61.endRadius, endpoint_fish_2m_61.baseRadius, endpoint_fish_2m_61.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_fish_2m_61) {
    mesh_fish_2m_61Geometry.scale(0.22, 0.16, 0.1);
  }
  const mesh_fish_2m_61 = new THREE.Mesh(
    mesh_fish_2m_61Geometry,
    materialMap["fish-teal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fish_2m_61.name = "Fish2Mirror";
  if (endpoint_fish_2m_61) {
    mesh_fish_2m_61.position.copy(endpoint_fish_2m_61.midpoint);
    mesh_fish_2m_61.quaternion.copy(endpoint_fish_2m_61.quaternion);
  }
  mesh_fish_2m_61.castShadow = options.castShadow ?? true;
  mesh_fish_2m_61.receiveShadow = options.receiveShadow ?? true;
  mesh_fish_2m_61.userData.sculptComponent = {"id": "fish-2m", "name": "Fish2Mirror", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.3, 0.4, -0.78], "rotation": [0, 0.17453, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-teal", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(72, 184, 168, 1.0)", "secondaryAlbedo": "rgba(56, 152, 136, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_2m_61.add(mesh_fish_2m_61);
  meshes["fish-2m"] = mesh_fish_2m_61;
  colliders["fish-2m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["fish-2"] ??= [];
  destructionGroups["fish-2"].push(node_fish_2m_61);

  const endpoint_fish_3m_62 = makeAttachmentEndpoint(null);
  const node_fish_3m_62 = new THREE.Group();
  node_fish_3m_62.name = "Fish3Mirror__pivot";
  node_fish_3m_62.scale.set(1, 1, 1);
  if (endpoint_fish_3m_62) {
    node_fish_3m_62.position.copy(endpoint_fish_3m_62.start);
    node_fish_3m_62.rotation.set(0.0, 0.5236, 0.0);
  } else {
    node_fish_3m_62.position.set(0.8, 0.45, -0.78);
    node_fish_3m_62.rotation.set(0.0, 0.5236, 0.0);
  }
  node_fish_3m_62.userData.sculptComponent = {"id": "fish-3m", "name": "Fish3Mirror", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [0.8, 0.45, -0.78], "rotation": [0, 0.5236, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-orange", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 136, 64, 1.0)", "secondaryAlbedo": "rgba(200, 104, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_3m_62.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["ocean-root"] ?? root).add(node_fish_3m_62);
  nodes["fish-3m"] = node_fish_3m_62;
  const mesh_fish_3m_62Geometry = endpoint_fish_3m_62
    ? new THREE.CylinderGeometry(endpoint_fish_3m_62.endRadius, endpoint_fish_3m_62.baseRadius, endpoint_fish_3m_62.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_fish_3m_62) {
    mesh_fish_3m_62Geometry.scale(0.22, 0.16, 0.1);
  }
  const mesh_fish_3m_62 = new THREE.Mesh(
    mesh_fish_3m_62Geometry,
    materialMap["fish-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fish_3m_62.name = "Fish3Mirror";
  if (endpoint_fish_3m_62) {
    mesh_fish_3m_62.position.copy(endpoint_fish_3m_62.midpoint);
    mesh_fish_3m_62.quaternion.copy(endpoint_fish_3m_62.quaternion);
  }
  mesh_fish_3m_62.castShadow = options.castShadow ?? true;
  mesh_fish_3m_62.receiveShadow = options.receiveShadow ?? true;
  mesh_fish_3m_62.userData.sculptComponent = {"id": "fish-3m", "name": "Fish3Mirror", "level": "meso", "role": "decoration", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "ocean-root", "attachment": {"parentId": "ocean-root", "parentSocket": "ocean-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.22, "height": 0.16, "depth": 0.1, "units": "world", "confidence": 0.8}, "transform": {"position": [0.8, 0.45, -0.78], "rotation": [0, 0.5236, 0], "scale": [0.22, 0.16, 0.1]}, "material": "fish-orange", "evidenceRefs": ["full-object"], "topologyRationale": "Small fish swimming beside the caravan", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 136, 64, 1.0)", "secondaryAlbedo": "rgba(200, 104, 48, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "fish-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_fish_3m_62.add(mesh_fish_3m_62);
  meshes["fish-3m"] = mesh_fish_3m_62;
  colliders["fish-3m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["fish-3"] ??= [];
  destructionGroups["fish-3"].push(node_fish_3m_62);

  const attachment_wheel_front_b_63 = {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_front_b_63 = makeAttachmentEndpoint(attachment_wheel_front_b_63);
  const node_wheel_front_b_63 = new THREE.Group();
  node_wheel_front_b_63.name = "WheelFrontB__pivot";
  node_wheel_front_b_63.scale.set(1, 1, 1);
  if (endpoint_wheel_front_b_63) {
    node_wheel_front_b_63.position.copy(endpoint_wheel_front_b_63.start);
    node_wheel_front_b_63.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_front_b_63.position.set(-0.95, -0.22, 0.5);
    node_wheel_front_b_63.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_front_b_63.userData.sculptComponent = {"id": "wheel-front-b", "name": "WheelFrontB", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.14, "depth": 0.5, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.95, -0.22, 0.5], "rotation": [1.5708, 0, 0], "scale": [0.5, 0.14, 0.5]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFront solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_b_63.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_front_b_63);
  nodes["wheel-front-b"] = node_wheel_front_b_63;
  const mesh_wheel_front_b_63Geometry = endpoint_wheel_front_b_63
    ? new THREE.CylinderGeometry(endpoint_wheel_front_b_63.endRadius, endpoint_wheel_front_b_63.baseRadius, endpoint_wheel_front_b_63.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_front_b_63) {
    mesh_wheel_front_b_63Geometry.scale(0.5, 0.14, 0.5);
  }
  const mesh_wheel_front_b_63 = new THREE.Mesh(
    mesh_wheel_front_b_63Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_b_63.name = "WheelFrontB";
  if (endpoint_wheel_front_b_63) {
    mesh_wheel_front_b_63.position.copy(endpoint_wheel_front_b_63.midpoint);
    mesh_wheel_front_b_63.quaternion.copy(endpoint_wheel_front_b_63.quaternion);
  }
  mesh_wheel_front_b_63.castShadow = options.castShadow ?? true;
  mesh_wheel_front_b_63.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_b_63.userData.sculptComponent = {"id": "wheel-front-b", "name": "WheelFrontB", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.14, "depth": 0.5, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.95, -0.22, 0.5], "rotation": [1.5708, 0, 0], "scale": [0.5, 0.14, 0.5]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFront solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_b_63.add(mesh_wheel_front_b_63);
  meshes["wheel-front-b"] = mesh_wheel_front_b_63;
  colliders["wheel-front-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-front"] ??= [];
  destructionGroups["wheel-front"].push(node_wheel_front_b_63);

  const attachment_wheel_rear_b_64 = {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_rear_b_64 = makeAttachmentEndpoint(attachment_wheel_rear_b_64);
  const node_wheel_rear_b_64 = new THREE.Group();
  node_wheel_rear_b_64.name = "WheelRearB__pivot";
  node_wheel_rear_b_64.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_b_64) {
    node_wheel_rear_b_64.position.copy(endpoint_wheel_rear_b_64.start);
    node_wheel_rear_b_64.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_rear_b_64.position.set(0.95, -0.22, 0.5);
    node_wheel_rear_b_64.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_rear_b_64.userData.sculptComponent = {"id": "wheel-rear-b", "name": "WheelRearB", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.14, "depth": 0.5, "units": "world", "confidence": 0.85}, "transform": {"position": [0.95, -0.22, 0.5], "rotation": [1.5708, 0, 0], "scale": [0.5, 0.14, 0.5]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRear solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_b_64.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_rear_b_64);
  nodes["wheel-rear-b"] = node_wheel_rear_b_64;
  const mesh_wheel_rear_b_64Geometry = endpoint_wheel_rear_b_64
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_b_64.endRadius, endpoint_wheel_rear_b_64.baseRadius, endpoint_wheel_rear_b_64.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_rear_b_64) {
    mesh_wheel_rear_b_64Geometry.scale(0.5, 0.14, 0.5);
  }
  const mesh_wheel_rear_b_64 = new THREE.Mesh(
    mesh_wheel_rear_b_64Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_b_64.name = "WheelRearB";
  if (endpoint_wheel_rear_b_64) {
    mesh_wheel_rear_b_64.position.copy(endpoint_wheel_rear_b_64.midpoint);
    mesh_wheel_rear_b_64.quaternion.copy(endpoint_wheel_rear_b_64.quaternion);
  }
  mesh_wheel_rear_b_64.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_b_64.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_b_64.userData.sculptComponent = {"id": "wheel-rear-b", "name": "WheelRearB", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.14, "depth": 0.5, "units": "world", "confidence": 0.85}, "transform": {"position": [0.95, -0.22, 0.5], "rotation": [1.5708, 0, 0], "scale": [0.5, 0.14, 0.5]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRear solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 48, 1.0)", "secondaryAlbedo": "rgba(26, 26, 30, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_b_64.add(mesh_wheel_rear_b_64);
  meshes["wheel-rear-b"] = mesh_wheel_rear_b_64;
  colliders["wheel-rear-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-rear"] ??= [];
  destructionGroups["wheel-rear"].push(node_wheel_rear_b_64);

  // repetition system: porthole-repeat (InstancedMesh, radial, count=4, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["ocean-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
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
    cluster.name = "porthole-repeat";
    parent.add(cluster);
  }

  // repetition system: mast-repeat (InstancedMesh, radial, count=2, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["ocean-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
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
    const cluster = new THREE.InstancedMesh(geo, mat, 2);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 2; i++) {
      const ang = ((0.0) + (i * 360) / 2) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "mast-repeat";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "minimumTextureResolution": 1024, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7}}};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createOceanCaravanLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Ocean Caravan look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"type": "key", "direction": "front-left", "color": "#FFFFFF", "intensity": 1.0}, {"type": "fill", "direction": "right", "color": "#E8E8E8", "intensity": 0.4}, {"type": "rim", "direction": "back", "color": "#F0F0F0", "intensity": 0.3}, {"type": "tone-mapping", "note": "ACES filmic tone mapping, exposure 1.0"}, {"type": "shadow", "note": "contact shadow under chassis via ground-plane ambient occlusion"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "minimumTextureResolution": 1024, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7}}};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createOceanCaravanEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameOceanCaravanCamera(
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
export function createOceanCaravanPresentationComposer(
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

export function configureOceanCaravanRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createOceanCaravanInspectControls(
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
