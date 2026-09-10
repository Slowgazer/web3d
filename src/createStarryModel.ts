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

// Generated from ObjectSculptSpec target: Starry Caravan
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.

// 星空斑点纹理：深蓝紫底 + 金色星点
function createStarryTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#2A2A5A';
  ctx.fillRect(0, 0, size, size);
  let seed = 99;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 220; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 0.8 + rand() * 1.8;
    ctx.globalAlpha = 0.5 + rand() * 0.5;
    ctx.fillStyle = rand() > 0.3 ? '#F0D880' : '#FFFFFF';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  tex.needsUpdate = true;
  return tex;
}

export function createStarryCaravanModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Starry Caravan";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.333, "orientation": {"yaw": -15, "pitch": 5, "roll": 0}, "positionHint": [3.0, 1.5, 4.0], "note": "Three-quarter front-left view, slightly elevated"}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["starry-navy"] = createSculptMaterial(
    "starry-navy",
    {"id": "starry-navy", "name": "Starry Navy", "type": "standard", "baseColor": "#2A2A5A", "roughness": {"base": 0.75, "variation": 0.12, "map": "starry-navy-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "faceted-night", "strength": 0.25, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "night sky zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "star speckle grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#2A2A5A"]}, "localOverrides": [{"zone": "default", "albedo": "#2A2A5A", "description": "uniform zone"}]},
    options
  );
  materialMap["frame-dark"] = createSculptMaterial(
    "frame-dark",
    {"id": "frame-dark", "name": "Frame Dark", "type": "standard", "baseColor": "#3A2A20", "roughness": {"base": 0.65, "variation": 0.12, "map": "frame-dark-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "wood-grain", "strength": 0.25, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "night sky zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "star speckle grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#3A2A20"]}, "localOverrides": [{"zone": "default", "albedo": "#3A2A20", "description": "uniform zone"}]},
    options
  );
  materialMap["glass-warm"] = createSculptMaterial(
    "glass-warm",
    {"id": "glass-warm", "name": "Glass Warm", "type": "emissive", "baseColor": "#E8A860", "roughness": {"base": 0.3, "variation": 0.05, "map": "glass-warm-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.1, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "night sky zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "star speckle grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#E8A860"]}, "localOverrides": [{"zone": "default", "albedo": "#E8A860", "description": "uniform zone"}], "emissive": "#E89040", "emissiveIntensity": 1.2},
    options
  );
  materialMap["metal-gray"] = createSculptMaterial(
    "metal-gray",
    {"id": "metal-gray", "name": "Metal Gray", "type": "standard", "baseColor": "#6A6A72", "roughness": {"base": 0.5, "variation": 0.12, "map": "metal-gray-roughness-map"}, "metalness": {"base": 0.4}, "normal": {"pattern": "metal-worn", "strength": 0.2, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "night sky zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "star speckle grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#6A6A72"]}, "localOverrides": [{"zone": "default", "albedo": "#6A6A72", "description": "uniform zone"}]},
    options
  );
  materialMap["wheel-dark"] = createSculptMaterial(
    "wheel-dark",
    {"id": "wheel-dark", "name": "Wheel Dark", "type": "standard", "baseColor": "#1E1E22", "roughness": {"base": 0.7, "variation": 0.12, "map": "wheel-dark-roughness-map"}, "metalness": {"base": 0.2}, "normal": {"pattern": "metal-worn", "strength": 0.2, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "night sky zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "star speckle grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#1E1E22"]}, "localOverrides": [{"zone": "default", "albedo": "#1E1E22", "description": "uniform zone"}]},
    options
  );
  materialMap["lamp-yellow"] = createSculptMaterial(
    "lamp-yellow",
    {"id": "lamp-yellow", "name": "Lamp Yellow", "type": "emissive", "baseColor": "#F0E0A0", "roughness": {"base": 0.3, "variation": 0.05, "map": "lamp-yellow-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.1, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "night sky zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "faceted plane variation", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "star speckle grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#F0E0A0"]}, "localOverrides": [{"zone": "default", "albedo": "#F0E0A0", "description": "uniform zone"}], "emissive": "#F0D880", "emissiveIntensity": 1.5},
    options
  );

  
  // refine-code: 参考色板 + 星空斑点
  {
    const navy = materialMap["starry-navy"] as THREE.MeshStandardMaterial | undefined;
    if (navy) {
      navy.map = createStarryTexture();
      navy.color.set("#FFFFFF");
      navy.flatShading = true;
      navy.needsUpdate = true;
    }
    const set = (id, color, extra) => {
      const m = materialMap[id] as THREE.MeshStandardMaterial | undefined;
      if (m) { m.color.set(color); m.map = null; if (extra) extra(m); m.needsUpdate = true; }
    };
    set("frame-dark", "#3A2A20");
    set("glass-warm", "#E8A860", (m) => { m.emissive.set("#E89040"); m.emissiveIntensity = 1.4; });
    set("metal-gray", "#6A6A72", (m) => { m.metalness = 0.4; });
    set("wheel-dark", "#1E1E22", (m) => { m.metalness = 0.2; });
    set("lamp-yellow", "#F0E0A0", (m) => { m.emissive.set("#F0D880"); m.emissiveIntensity = 1.8; });
  }

const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_starry_root_0 = null;
  const endpoint_starry_root_0 = makeAttachmentEndpoint(attachment_starry_root_0);
  const node_starry_root_0 = new THREE.Group();
  node_starry_root_0.name = "StarryCaravan__pivot";
  node_starry_root_0.scale.set(1, 1, 1);
  if (endpoint_starry_root_0) {
    node_starry_root_0.position.copy(endpoint_starry_root_0.start);
    node_starry_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_starry_root_0.position.set(0.0, 0.0, 0.0);
    node_starry_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_starry_root_0.userData.sculptComponent = {"id": "starry-root", "name": "StarryCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "starry-navy", "evidenceRefs": ["full-object"], "topologyRationale": "StarryCaravan solid geometry attached to None", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 90, 1.0)", "secondaryAlbedo": "rgba(26, 26, 58, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "starry-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_starry_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "starry-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_starry_root_0);
  nodes["starry-root"] = node_starry_root_0;
  const mesh_starry_root_0Geometry = endpoint_starry_root_0
    ? new THREE.CylinderGeometry(endpoint_starry_root_0.endRadius, endpoint_starry_root_0.baseRadius, endpoint_starry_root_0.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_starry_root_0) {
    mesh_starry_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_starry_root_0 = new THREE.Mesh(
    mesh_starry_root_0Geometry,
    materialMap["starry-navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_starry_root_0.name = "StarryCaravan";
  if (endpoint_starry_root_0) {
    mesh_starry_root_0.position.copy(endpoint_starry_root_0.midpoint);
    mesh_starry_root_0.quaternion.copy(endpoint_starry_root_0.quaternion);
  }
  mesh_starry_root_0.castShadow = options.castShadow ?? true;
  mesh_starry_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_starry_root_0.visible = false; // 容器节点不渲染
  mesh_starry_root_0.userData.sculptComponent = {"id": "starry-root", "name": "StarryCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "starry-navy", "evidenceRefs": ["full-object"], "topologyRationale": "StarryCaravan solid geometry attached to None", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 90, 1.0)", "secondaryAlbedo": "rgba(26, 26, 58, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "starry-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_starry_root_0.add(mesh_starry_root_0);
  meshes["starry-root"] = mesh_starry_root_0;
  colliders["starry-root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["starry-root"] ??= [];
  destructionGroups["starry-root"].push(node_starry_root_0);

  const endpoint_body_1 = makeAttachmentEndpoint(null);
  const node_body_1 = new THREE.Group();
  node_body_1.name = "Body__pivot";
  node_body_1.scale.set(1, 1, 1);
  if (endpoint_body_1) {
    node_body_1.position.copy(endpoint_body_1.start);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_body_1.position.set(0.0, 1.1, 0.0);
    node_body_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.4, "depth": 1.4, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 1.1, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.4, 1.4]}, "material": "starry-navy", "evidenceRefs": ["full-object"], "topologyRationale": "Navy night-sky body covered in golden star speckles", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 90, 1.0)", "secondaryAlbedo": "rgba(26, 26, 58, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "low-poly facet planes", "strength": 0.2, "scale": 8.0}, "roughnessVariation": {"pattern": "facet sheen variation", "amount": 0.1}}};
  node_body_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_body_1);
  nodes["body"] = node_body_1;
  const mesh_body_1Geometry = endpoint_body_1
    ? new THREE.CylinderGeometry(endpoint_body_1.endRadius, endpoint_body_1.baseRadius, endpoint_body_1.length, 32, 12)
    : new RoundedBoxGeometry(3.0, 1.4, 1.4, 3, 0.08);
  if (!endpoint_body_1) {
    mesh_body_1Geometry.scale(1, 1, 1); // 已是最终尺寸
  }
  const mesh_body_1 = new THREE.Mesh(
    mesh_body_1Geometry,
    materialMap["starry-navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_1.name = "Body";
  if (endpoint_body_1) {
    mesh_body_1.position.copy(endpoint_body_1.midpoint);
    mesh_body_1.quaternion.copy(endpoint_body_1.quaternion);
  }
  mesh_body_1.castShadow = options.castShadow ?? true;
  mesh_body_1.receiveShadow = options.receiveShadow ?? true;
  mesh_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.4, "depth": 1.4, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 1.1, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.4, 1.4]}, "material": "starry-navy", "evidenceRefs": ["full-object"], "topologyRationale": "Navy night-sky body covered in golden star speckles", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 90, 1.0)", "secondaryAlbedo": "rgba(26, 26, 58, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "low-poly facet planes", "strength": 0.2, "scale": 8.0}, "roughnessVariation": {"pattern": "facet sheen variation", "amount": 0.1}}};
  node_body_1.add(mesh_body_1);
  meshes["body"] = mesh_body_1;
  colliders["body"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_body_1);

  const endpoint_roof_2 = makeAttachmentEndpoint(null);
  const node_roof_2 = new THREE.Group();
  node_roof_2.name = "Roof__pivot";
  node_roof_2.scale.set(1, 1, 1);
  if (endpoint_roof_2) {
    node_roof_2.position.copy(endpoint_roof_2.start);
    node_roof_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_2.position.set(0.0, 1.86, 0.0);
    node_roof_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_2.userData.sculptComponent = {"id": "roof", "name": "Roof", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.4, "height": 0.14, "depth": 1.7, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 1.86, 0], "rotation": [0, 0, 0], "scale": [3.4, 0.14, 1.7]}, "material": "starry-navy", "evidenceRefs": ["full-object"], "topologyRationale": "Sloped overhanging roof, same starry navy", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 90, 1.0)", "secondaryAlbedo": "rgba(26, 26, 58, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_roof_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_roof_2);
  nodes["roof"] = node_roof_2;
  const mesh_roof_2Geometry = endpoint_roof_2
    ? new THREE.CylinderGeometry(endpoint_roof_2.endRadius, endpoint_roof_2.baseRadius, endpoint_roof_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_roof_2) {
    mesh_roof_2Geometry.scale(3.4, 0.14, 1.7);
  }
  const mesh_roof_2 = new THREE.Mesh(
    mesh_roof_2Geometry,
    materialMap["starry-navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_2.name = "Roof";
  if (endpoint_roof_2) {
    mesh_roof_2.position.copy(endpoint_roof_2.midpoint);
    mesh_roof_2.quaternion.copy(endpoint_roof_2.quaternion);
  }
  mesh_roof_2.castShadow = options.castShadow ?? true;
  mesh_roof_2.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_2.userData.sculptComponent = {"id": "roof", "name": "Roof", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.4, "height": 0.14, "depth": 1.7, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 1.86, 0], "rotation": [0, 0, 0], "scale": [3.4, 0.14, 1.7]}, "material": "starry-navy", "evidenceRefs": ["full-object"], "topologyRationale": "Sloped overhanging roof, same starry navy", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 42, 90, 1.0)", "secondaryAlbedo": "rgba(26, 26, 58, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_roof_2.add(mesh_roof_2);
  meshes["roof"] = mesh_roof_2;
  colliders["roof"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof"] ??= [];
  destructionGroups["roof"].push(node_roof_2);

  const endpoint_window_system_3 = makeAttachmentEndpoint(null);
  const node_window_system_3 = new THREE.Group();
  node_window_system_3.name = "WindowSystem__pivot";
  node_window_system_3.scale.set(1, 1, 1);
  if (endpoint_window_system_3) {
    node_window_system_3.position.copy(endpoint_window_system_3.start);
    node_window_system_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_system_3.position.set(0.0, 1.2, 0.0);
    node_window_system_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_system_3.userData.sculptComponent = {"id": "window-system", "name": "WindowSystem", "level": "meso", "role": "window-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.2, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WindowSystem solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_system_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_window_system_3);
  nodes["window-system"] = node_window_system_3;
  const mesh_window_system_3Geometry = endpoint_window_system_3
    ? new THREE.CylinderGeometry(endpoint_window_system_3.endRadius, endpoint_window_system_3.baseRadius, endpoint_window_system_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_system_3) {
    mesh_window_system_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_system_3 = new THREE.Mesh(
    mesh_window_system_3Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_system_3.name = "WindowSystem";
  if (endpoint_window_system_3) {
    mesh_window_system_3.position.copy(endpoint_window_system_3.midpoint);
    mesh_window_system_3.quaternion.copy(endpoint_window_system_3.quaternion);
  }
  mesh_window_system_3.castShadow = options.castShadow ?? true;
  mesh_window_system_3.receiveShadow = options.receiveShadow ?? true;
  mesh_window_system_3.visible = false; // 容器节点不渲染
  mesh_window_system_3.userData.sculptComponent = {"id": "window-system", "name": "WindowSystem", "level": "meso", "role": "window-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.2, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WindowSystem solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_system_3.add(mesh_window_system_3);
  meshes["window-system"] = mesh_window_system_3;
  colliders["window-system"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-system"] ??= [];
  destructionGroups["window-system"].push(node_window_system_3);

  const endpoint_window_01_4 = makeAttachmentEndpoint(null);
  const node_window_01_4 = new THREE.Group();
  node_window_01_4.name = "Window01__pivot";
  node_window_01_4.scale.set(1, 1, 1);
  if (endpoint_window_01_4) {
    node_window_01_4.position.copy(endpoint_window_01_4.start);
    node_window_01_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_4.position.set(-1.2, 0.0, 0.71);
    node_window_01_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_4.userData.sculptComponent = {"id": "window-01", "name": "Window01", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.2, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_01_4);
  nodes["window-01"] = node_window_01_4;
  const mesh_window_01_4Geometry = endpoint_window_01_4
    ? new THREE.CylinderGeometry(endpoint_window_01_4.endRadius, endpoint_window_01_4.baseRadius, endpoint_window_01_4.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_4) {
    mesh_window_01_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_01_4 = new THREE.Mesh(
    mesh_window_01_4Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_4.name = "Window01";
  if (endpoint_window_01_4) {
    mesh_window_01_4.position.copy(endpoint_window_01_4.midpoint);
    mesh_window_01_4.quaternion.copy(endpoint_window_01_4.quaternion);
  }
  mesh_window_01_4.castShadow = options.castShadow ?? true;
  mesh_window_01_4.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_4.visible = false; // 容器节点不渲染
  mesh_window_01_4.userData.sculptComponent = {"id": "window-01", "name": "Window01", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.2, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_4.add(mesh_window_01_4);
  meshes["window-01"] = mesh_window_01_4;
  colliders["window-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01"] ??= [];
  destructionGroups["window-01"].push(node_window_01_4);

  const endpoint_window_01_frame_5 = makeAttachmentEndpoint(null);
  const node_window_01_frame_5 = new THREE.Group();
  node_window_01_frame_5.name = "Window01Frame__pivot";
  node_window_01_frame_5.scale.set(1, 1, 1);
  if (endpoint_window_01_frame_5) {
    node_window_01_frame_5.position.copy(endpoint_window_01_frame_5.start);
    node_window_01_frame_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_frame_5.position.set(0.0, 0.0, 0.0);
    node_window_01_frame_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_frame_5.userData.sculptComponent = {"id": "window-01-frame", "name": "Window01Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_frame_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_01_frame_5);
  nodes["window-01-frame"] = node_window_01_frame_5;
  const mesh_window_01_frame_5Geometry = endpoint_window_01_frame_5
    ? new THREE.CylinderGeometry(endpoint_window_01_frame_5.endRadius, endpoint_window_01_frame_5.baseRadius, endpoint_window_01_frame_5.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_frame_5) {
    mesh_window_01_frame_5Geometry.scale(0.38, 0.6, 0.05);
  }
  const mesh_window_01_frame_5 = new THREE.Mesh(
    mesh_window_01_frame_5Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_frame_5.name = "Window01Frame";
  if (endpoint_window_01_frame_5) {
    mesh_window_01_frame_5.position.copy(endpoint_window_01_frame_5.midpoint);
    mesh_window_01_frame_5.quaternion.copy(endpoint_window_01_frame_5.quaternion);
  }
  mesh_window_01_frame_5.castShadow = options.castShadow ?? true;
  mesh_window_01_frame_5.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_frame_5.userData.sculptComponent = {"id": "window-01-frame", "name": "Window01Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.38, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_frame_5.add(mesh_window_01_frame_5);
  meshes["window-01-frame"] = mesh_window_01_frame_5;
  colliders["window-01-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-frame"] ??= [];
  destructionGroups["window-01-frame"].push(node_window_01_frame_5);

  const endpoint_window_01_glass_6 = makeAttachmentEndpoint(null);
  const node_window_01_glass_6 = new THREE.Group();
  node_window_01_glass_6.name = "Window01Glass__pivot";
  node_window_01_glass_6.scale.set(1, 1, 1);
  if (endpoint_window_01_glass_6) {
    node_window_01_glass_6.position.copy(endpoint_window_01_glass_6.start);
    node_window_01_glass_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_glass_6.position.set(0.0, 0.0, 0.032);
    node_window_01_glass_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_glass_6.userData.sculptComponent = {"id": "window-01-glass", "name": "Window01Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glass_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_01_glass_6);
  nodes["window-01-glass"] = node_window_01_glass_6;
  const mesh_window_01_glass_6Geometry = endpoint_window_01_glass_6
    ? new THREE.CylinderGeometry(endpoint_window_01_glass_6.endRadius, endpoint_window_01_glass_6.baseRadius, endpoint_window_01_glass_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_glass_6) {
    mesh_window_01_glass_6Geometry.scale(0.3, 0.52, 0.01);
  }
  const mesh_window_01_glass_6 = new THREE.Mesh(
    mesh_window_01_glass_6Geometry,
    materialMap["glass-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_glass_6.name = "Window01Glass";
  if (endpoint_window_01_glass_6) {
    mesh_window_01_glass_6.position.copy(endpoint_window_01_glass_6.midpoint);
    mesh_window_01_glass_6.quaternion.copy(endpoint_window_01_glass_6.quaternion);
  }
  mesh_window_01_glass_6.castShadow = options.castShadow ?? true;
  mesh_window_01_glass_6.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_glass_6.userData.sculptComponent = {"id": "window-01-glass", "name": "Window01Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.3, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glass_6.add(mesh_window_01_glass_6);
  meshes["window-01-glass"] = mesh_window_01_glass_6;
  colliders["window-01-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-glass"] ??= [];
  destructionGroups["window-01-glass"].push(node_window_01_glass_6);

  const endpoint_window_02_7 = makeAttachmentEndpoint(null);
  const node_window_02_7 = new THREE.Group();
  node_window_02_7.name = "Window02__pivot";
  node_window_02_7.scale.set(1, 1, 1);
  if (endpoint_window_02_7) {
    node_window_02_7.position.copy(endpoint_window_02_7.start);
    node_window_02_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_7.position.set(-0.45, 0.0, 0.71);
    node_window_02_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_7.userData.sculptComponent = {"id": "window-02", "name": "Window02", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.45, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_02_7);
  nodes["window-02"] = node_window_02_7;
  const mesh_window_02_7Geometry = endpoint_window_02_7
    ? new THREE.CylinderGeometry(endpoint_window_02_7.endRadius, endpoint_window_02_7.baseRadius, endpoint_window_02_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_7) {
    mesh_window_02_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_02_7 = new THREE.Mesh(
    mesh_window_02_7Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_7.name = "Window02";
  if (endpoint_window_02_7) {
    mesh_window_02_7.position.copy(endpoint_window_02_7.midpoint);
    mesh_window_02_7.quaternion.copy(endpoint_window_02_7.quaternion);
  }
  mesh_window_02_7.castShadow = options.castShadow ?? true;
  mesh_window_02_7.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_7.visible = false; // 容器节点不渲染
  mesh_window_02_7.userData.sculptComponent = {"id": "window-02", "name": "Window02", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.45, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_7.add(mesh_window_02_7);
  meshes["window-02"] = mesh_window_02_7;
  colliders["window-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02"] ??= [];
  destructionGroups["window-02"].push(node_window_02_7);

  const endpoint_window_02_frame_8 = makeAttachmentEndpoint(null);
  const node_window_02_frame_8 = new THREE.Group();
  node_window_02_frame_8.name = "Window02Frame__pivot";
  node_window_02_frame_8.scale.set(1, 1, 1);
  if (endpoint_window_02_frame_8) {
    node_window_02_frame_8.position.copy(endpoint_window_02_frame_8.start);
    node_window_02_frame_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_frame_8.position.set(0.0, 0.0, 0.0);
    node_window_02_frame_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_frame_8.userData.sculptComponent = {"id": "window-02-frame", "name": "Window02Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_frame_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_frame_8);
  nodes["window-02-frame"] = node_window_02_frame_8;
  const mesh_window_02_frame_8Geometry = endpoint_window_02_frame_8
    ? new THREE.CylinderGeometry(endpoint_window_02_frame_8.endRadius, endpoint_window_02_frame_8.baseRadius, endpoint_window_02_frame_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_frame_8) {
    mesh_window_02_frame_8Geometry.scale(0.63, 0.6, 0.05);
  }
  const mesh_window_02_frame_8 = new THREE.Mesh(
    mesh_window_02_frame_8Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_frame_8.name = "Window02Frame";
  if (endpoint_window_02_frame_8) {
    mesh_window_02_frame_8.position.copy(endpoint_window_02_frame_8.midpoint);
    mesh_window_02_frame_8.quaternion.copy(endpoint_window_02_frame_8.quaternion);
  }
  mesh_window_02_frame_8.castShadow = options.castShadow ?? true;
  mesh_window_02_frame_8.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_frame_8.userData.sculptComponent = {"id": "window-02-frame", "name": "Window02Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_frame_8.add(mesh_window_02_frame_8);
  meshes["window-02-frame"] = mesh_window_02_frame_8;
  colliders["window-02-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-frame"] ??= [];
  destructionGroups["window-02-frame"].push(node_window_02_frame_8);

  const endpoint_window_02_glass_9 = makeAttachmentEndpoint(null);
  const node_window_02_glass_9 = new THREE.Group();
  node_window_02_glass_9.name = "Window02Glass__pivot";
  node_window_02_glass_9.scale.set(1, 1, 1);
  if (endpoint_window_02_glass_9) {
    node_window_02_glass_9.position.copy(endpoint_window_02_glass_9.start);
    node_window_02_glass_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_glass_9.position.set(0.0, 0.0, 0.032);
    node_window_02_glass_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_glass_9.userData.sculptComponent = {"id": "window-02-glass", "name": "Window02Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glass_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_glass_9);
  nodes["window-02-glass"] = node_window_02_glass_9;
  const mesh_window_02_glass_9Geometry = endpoint_window_02_glass_9
    ? new THREE.CylinderGeometry(endpoint_window_02_glass_9.endRadius, endpoint_window_02_glass_9.baseRadius, endpoint_window_02_glass_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_glass_9) {
    mesh_window_02_glass_9Geometry.scale(0.55, 0.52, 0.01);
  }
  const mesh_window_02_glass_9 = new THREE.Mesh(
    mesh_window_02_glass_9Geometry,
    materialMap["glass-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_glass_9.name = "Window02Glass";
  if (endpoint_window_02_glass_9) {
    mesh_window_02_glass_9.position.copy(endpoint_window_02_glass_9.midpoint);
    mesh_window_02_glass_9.quaternion.copy(endpoint_window_02_glass_9.quaternion);
  }
  mesh_window_02_glass_9.castShadow = options.castShadow ?? true;
  mesh_window_02_glass_9.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_glass_9.userData.sculptComponent = {"id": "window-02-glass", "name": "Window02Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glass_9.add(mesh_window_02_glass_9);
  meshes["window-02-glass"] = mesh_window_02_glass_9;
  colliders["window-02-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-glass"] ??= [];
  destructionGroups["window-02-glass"].push(node_window_02_glass_9);

  const endpoint_window_03_10 = makeAttachmentEndpoint(null);
  const node_window_03_10 = new THREE.Group();
  node_window_03_10.name = "Window03__pivot";
  node_window_03_10.scale.set(1, 1, 1);
  if (endpoint_window_03_10) {
    node_window_03_10.position.copy(endpoint_window_03_10.start);
    node_window_03_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_10.position.set(0.35, 0.0, 0.71);
    node_window_03_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_10.userData.sculptComponent = {"id": "window-03", "name": "Window03", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.35, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_03_10);
  nodes["window-03"] = node_window_03_10;
  const mesh_window_03_10Geometry = endpoint_window_03_10
    ? new THREE.CylinderGeometry(endpoint_window_03_10.endRadius, endpoint_window_03_10.baseRadius, endpoint_window_03_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_10) {
    mesh_window_03_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_03_10 = new THREE.Mesh(
    mesh_window_03_10Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_10.name = "Window03";
  if (endpoint_window_03_10) {
    mesh_window_03_10.position.copy(endpoint_window_03_10.midpoint);
    mesh_window_03_10.quaternion.copy(endpoint_window_03_10.quaternion);
  }
  mesh_window_03_10.castShadow = options.castShadow ?? true;
  mesh_window_03_10.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_10.visible = false; // 容器节点不渲染
  mesh_window_03_10.userData.sculptComponent = {"id": "window-03", "name": "Window03", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.35, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_10.add(mesh_window_03_10);
  meshes["window-03"] = mesh_window_03_10;
  colliders["window-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03"] ??= [];
  destructionGroups["window-03"].push(node_window_03_10);

  const endpoint_window_03_frame_11 = makeAttachmentEndpoint(null);
  const node_window_03_frame_11 = new THREE.Group();
  node_window_03_frame_11.name = "Window03Frame__pivot";
  node_window_03_frame_11.scale.set(1, 1, 1);
  if (endpoint_window_03_frame_11) {
    node_window_03_frame_11.position.copy(endpoint_window_03_frame_11.start);
    node_window_03_frame_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_frame_11.position.set(0.0, 0.0, 0.0);
    node_window_03_frame_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_frame_11.userData.sculptComponent = {"id": "window-03-frame", "name": "Window03Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_frame_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_frame_11);
  nodes["window-03-frame"] = node_window_03_frame_11;
  const mesh_window_03_frame_11Geometry = endpoint_window_03_frame_11
    ? new THREE.CylinderGeometry(endpoint_window_03_frame_11.endRadius, endpoint_window_03_frame_11.baseRadius, endpoint_window_03_frame_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_frame_11) {
    mesh_window_03_frame_11Geometry.scale(0.63, 0.6, 0.05);
  }
  const mesh_window_03_frame_11 = new THREE.Mesh(
    mesh_window_03_frame_11Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_frame_11.name = "Window03Frame";
  if (endpoint_window_03_frame_11) {
    mesh_window_03_frame_11.position.copy(endpoint_window_03_frame_11.midpoint);
    mesh_window_03_frame_11.quaternion.copy(endpoint_window_03_frame_11.quaternion);
  }
  mesh_window_03_frame_11.castShadow = options.castShadow ?? true;
  mesh_window_03_frame_11.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_frame_11.userData.sculptComponent = {"id": "window-03-frame", "name": "Window03Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_frame_11.add(mesh_window_03_frame_11);
  meshes["window-03-frame"] = mesh_window_03_frame_11;
  colliders["window-03-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-frame"] ??= [];
  destructionGroups["window-03-frame"].push(node_window_03_frame_11);

  const endpoint_window_03_glass_12 = makeAttachmentEndpoint(null);
  const node_window_03_glass_12 = new THREE.Group();
  node_window_03_glass_12.name = "Window03Glass__pivot";
  node_window_03_glass_12.scale.set(1, 1, 1);
  if (endpoint_window_03_glass_12) {
    node_window_03_glass_12.position.copy(endpoint_window_03_glass_12.start);
    node_window_03_glass_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_glass_12.position.set(0.0, 0.0, 0.032);
    node_window_03_glass_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_glass_12.userData.sculptComponent = {"id": "window-03-glass", "name": "Window03Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glass_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_glass_12);
  nodes["window-03-glass"] = node_window_03_glass_12;
  const mesh_window_03_glass_12Geometry = endpoint_window_03_glass_12
    ? new THREE.CylinderGeometry(endpoint_window_03_glass_12.endRadius, endpoint_window_03_glass_12.baseRadius, endpoint_window_03_glass_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_glass_12) {
    mesh_window_03_glass_12Geometry.scale(0.55, 0.52, 0.01);
  }
  const mesh_window_03_glass_12 = new THREE.Mesh(
    mesh_window_03_glass_12Geometry,
    materialMap["glass-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_glass_12.name = "Window03Glass";
  if (endpoint_window_03_glass_12) {
    mesh_window_03_glass_12.position.copy(endpoint_window_03_glass_12.midpoint);
    mesh_window_03_glass_12.quaternion.copy(endpoint_window_03_glass_12.quaternion);
  }
  mesh_window_03_glass_12.castShadow = options.castShadow ?? true;
  mesh_window_03_glass_12.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_glass_12.userData.sculptComponent = {"id": "window-03-glass", "name": "Window03Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glass_12.add(mesh_window_03_glass_12);
  meshes["window-03-glass"] = mesh_window_03_glass_12;
  colliders["window-03-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-glass"] ??= [];
  destructionGroups["window-03-glass"].push(node_window_03_glass_12);

  const endpoint_window_04_13 = makeAttachmentEndpoint(null);
  const node_window_04_13 = new THREE.Group();
  node_window_04_13.name = "Window04__pivot";
  node_window_04_13.scale.set(1, 1, 1);
  if (endpoint_window_04_13) {
    node_window_04_13.position.copy(endpoint_window_04_13.start);
    node_window_04_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_13.position.set(1.1, 0.0, 0.71);
    node_window_04_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_13.userData.sculptComponent = {"id": "window-04", "name": "Window04", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.1, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_04_13);
  nodes["window-04"] = node_window_04_13;
  const mesh_window_04_13Geometry = endpoint_window_04_13
    ? new THREE.CylinderGeometry(endpoint_window_04_13.endRadius, endpoint_window_04_13.baseRadius, endpoint_window_04_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_13) {
    mesh_window_04_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_04_13 = new THREE.Mesh(
    mesh_window_04_13Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_13.name = "Window04";
  if (endpoint_window_04_13) {
    mesh_window_04_13.position.copy(endpoint_window_04_13.midpoint);
    mesh_window_04_13.quaternion.copy(endpoint_window_04_13.quaternion);
  }
  mesh_window_04_13.castShadow = options.castShadow ?? true;
  mesh_window_04_13.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_13.visible = false; // 容器节点不渲染
  mesh_window_04_13.userData.sculptComponent = {"id": "window-04", "name": "Window04", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.1, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_13.add(mesh_window_04_13);
  meshes["window-04"] = mesh_window_04_13;
  colliders["window-04"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04"] ??= [];
  destructionGroups["window-04"].push(node_window_04_13);

  const endpoint_window_04_frame_14 = makeAttachmentEndpoint(null);
  const node_window_04_frame_14 = new THREE.Group();
  node_window_04_frame_14.name = "Window04Frame__pivot";
  node_window_04_frame_14.scale.set(1, 1, 1);
  if (endpoint_window_04_frame_14) {
    node_window_04_frame_14.position.copy(endpoint_window_04_frame_14.start);
    node_window_04_frame_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_frame_14.position.set(0.0, 0.0, 0.0);
    node_window_04_frame_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_frame_14.userData.sculptComponent = {"id": "window-04-frame", "name": "Window04Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_frame_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04"] ?? root).add(node_window_04_frame_14);
  nodes["window-04-frame"] = node_window_04_frame_14;
  const mesh_window_04_frame_14Geometry = endpoint_window_04_frame_14
    ? new THREE.CylinderGeometry(endpoint_window_04_frame_14.endRadius, endpoint_window_04_frame_14.baseRadius, endpoint_window_04_frame_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_frame_14) {
    mesh_window_04_frame_14Geometry.scale(0.63, 0.6, 0.05);
  }
  const mesh_window_04_frame_14 = new THREE.Mesh(
    mesh_window_04_frame_14Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_frame_14.name = "Window04Frame";
  if (endpoint_window_04_frame_14) {
    mesh_window_04_frame_14.position.copy(endpoint_window_04_frame_14.midpoint);
    mesh_window_04_frame_14.quaternion.copy(endpoint_window_04_frame_14.quaternion);
  }
  mesh_window_04_frame_14.castShadow = options.castShadow ?? true;
  mesh_window_04_frame_14.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_frame_14.userData.sculptComponent = {"id": "window-04-frame", "name": "Window04Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_frame_14.add(mesh_window_04_frame_14);
  meshes["window-04-frame"] = mesh_window_04_frame_14;
  colliders["window-04-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-frame"] ??= [];
  destructionGroups["window-04-frame"].push(node_window_04_frame_14);

  const endpoint_window_04_glass_15 = makeAttachmentEndpoint(null);
  const node_window_04_glass_15 = new THREE.Group();
  node_window_04_glass_15.name = "Window04Glass__pivot";
  node_window_04_glass_15.scale.set(1, 1, 1);
  if (endpoint_window_04_glass_15) {
    node_window_04_glass_15.position.copy(endpoint_window_04_glass_15.start);
    node_window_04_glass_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_glass_15.position.set(0.0, 0.0, 0.032);
    node_window_04_glass_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_glass_15.userData.sculptComponent = {"id": "window-04-glass", "name": "Window04Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glass_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04"] ?? root).add(node_window_04_glass_15);
  nodes["window-04-glass"] = node_window_04_glass_15;
  const mesh_window_04_glass_15Geometry = endpoint_window_04_glass_15
    ? new THREE.CylinderGeometry(endpoint_window_04_glass_15.endRadius, endpoint_window_04_glass_15.baseRadius, endpoint_window_04_glass_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_glass_15) {
    mesh_window_04_glass_15Geometry.scale(0.55, 0.52, 0.01);
  }
  const mesh_window_04_glass_15 = new THREE.Mesh(
    mesh_window_04_glass_15Geometry,
    materialMap["glass-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_glass_15.name = "Window04Glass";
  if (endpoint_window_04_glass_15) {
    mesh_window_04_glass_15.position.copy(endpoint_window_04_glass_15.midpoint);
    mesh_window_04_glass_15.quaternion.copy(endpoint_window_04_glass_15.quaternion);
  }
  mesh_window_04_glass_15.castShadow = options.castShadow ?? true;
  mesh_window_04_glass_15.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_glass_15.userData.sculptComponent = {"id": "window-04-glass", "name": "Window04Glass", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 0, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glass_15.add(mesh_window_04_glass_15);
  meshes["window-04-glass"] = mesh_window_04_glass_15;
  colliders["window-04-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-glass"] ??= [];
  destructionGroups["window-04-glass"].push(node_window_04_glass_15);

  const attachment_vent_01_16 = {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_01_16 = makeAttachmentEndpoint(attachment_vent_01_16);
  const node_vent_01_16 = new THREE.Group();
  node_vent_01_16.name = "Vent01__pivot";
  node_vent_01_16.scale.set(1, 1, 1);
  if (endpoint_vent_01_16) {
    node_vent_01_16.position.copy(endpoint_vent_01_16.start);
    node_vent_01_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_01_16.position.set(-1.1, 2.0, -0.3);
    node_vent_01_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_01_16.userData.sculptComponent = {"id": "vent-01", "name": "Vent01", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.1, 2.0, -0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_01_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_vent_01_16);
  nodes["vent-01"] = node_vent_01_16;
  const mesh_vent_01_16Geometry = endpoint_vent_01_16
    ? new THREE.CylinderGeometry(endpoint_vent_01_16.endRadius, endpoint_vent_01_16.baseRadius, endpoint_vent_01_16.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_01_16) {
    mesh_vent_01_16Geometry.scale(0.09, 0.24, 0.09);
  }
  const mesh_vent_01_16 = new THREE.Mesh(
    mesh_vent_01_16Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_01_16.name = "Vent01";
  if (endpoint_vent_01_16) {
    mesh_vent_01_16.position.copy(endpoint_vent_01_16.midpoint);
    mesh_vent_01_16.quaternion.copy(endpoint_vent_01_16.quaternion);
  }
  mesh_vent_01_16.castShadow = options.castShadow ?? true;
  mesh_vent_01_16.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_01_16.userData.sculptComponent = {"id": "vent-01", "name": "Vent01", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.1, 2.0, -0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_01_16.add(mesh_vent_01_16);
  meshes["vent-01"] = mesh_vent_01_16;
  colliders["vent-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-01"] ??= [];
  destructionGroups["vent-01"].push(node_vent_01_16);

  const attachment_vent_01_cap_17 = {"parentId": "vent-01", "parentSocket": "vent-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_01_cap_17 = makeAttachmentEndpoint(attachment_vent_01_cap_17);
  const node_vent_01_cap_17 = new THREE.Group();
  node_vent_01_cap_17.name = "Vent01Cap__pivot";
  node_vent_01_cap_17.scale.set(1, 1, 1);
  if (endpoint_vent_01_cap_17) {
    node_vent_01_cap_17.position.copy(endpoint_vent_01_cap_17.start);
    node_vent_01_cap_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_01_cap_17.position.set(0.0, 0.14, 0.0);
    node_vent_01_cap_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_01_cap_17.userData.sculptComponent = {"id": "vent-01-cap", "name": "Vent01Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-01", "attachment": {"parentId": "vent-01", "parentSocket": "vent-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent01Cap solid geometry attached to vent-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-01-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_01_cap_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-01-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-01"] ?? root).add(node_vent_01_cap_17);
  nodes["vent-01-cap"] = node_vent_01_cap_17;
  const mesh_vent_01_cap_17Geometry = endpoint_vent_01_cap_17
    ? new THREE.CylinderGeometry(endpoint_vent_01_cap_17.endRadius, endpoint_vent_01_cap_17.baseRadius, endpoint_vent_01_cap_17.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_01_cap_17) {
    mesh_vent_01_cap_17Geometry.scale(0.12, 0.06, 0.12);
  }
  const mesh_vent_01_cap_17 = new THREE.Mesh(
    mesh_vent_01_cap_17Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_01_cap_17.name = "Vent01Cap";
  if (endpoint_vent_01_cap_17) {
    mesh_vent_01_cap_17.position.copy(endpoint_vent_01_cap_17.midpoint);
    mesh_vent_01_cap_17.quaternion.copy(endpoint_vent_01_cap_17.quaternion);
  }
  mesh_vent_01_cap_17.castShadow = options.castShadow ?? true;
  mesh_vent_01_cap_17.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_01_cap_17.userData.sculptComponent = {"id": "vent-01-cap", "name": "Vent01Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-01", "attachment": {"parentId": "vent-01", "parentSocket": "vent-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent01Cap solid geometry attached to vent-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-01-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_01_cap_17.add(mesh_vent_01_cap_17);
  meshes["vent-01-cap"] = mesh_vent_01_cap_17;
  colliders["vent-01-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-01-cap"] ??= [];
  destructionGroups["vent-01-cap"].push(node_vent_01_cap_17);

  const attachment_vent_02_18 = {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_02_18 = makeAttachmentEndpoint(attachment_vent_02_18);
  const node_vent_02_18 = new THREE.Group();
  node_vent_02_18.name = "Vent02__pivot";
  node_vent_02_18.scale.set(1, 1, 1);
  if (endpoint_vent_02_18) {
    node_vent_02_18.position.copy(endpoint_vent_02_18.start);
    node_vent_02_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_02_18.position.set(-0.55, 2.0, 0.3);
    node_vent_02_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_02_18.userData.sculptComponent = {"id": "vent-02", "name": "Vent02", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.55, 2.0, 0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_02_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_vent_02_18);
  nodes["vent-02"] = node_vent_02_18;
  const mesh_vent_02_18Geometry = endpoint_vent_02_18
    ? new THREE.CylinderGeometry(endpoint_vent_02_18.endRadius, endpoint_vent_02_18.baseRadius, endpoint_vent_02_18.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_02_18) {
    mesh_vent_02_18Geometry.scale(0.09, 0.24, 0.09);
  }
  const mesh_vent_02_18 = new THREE.Mesh(
    mesh_vent_02_18Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_02_18.name = "Vent02";
  if (endpoint_vent_02_18) {
    mesh_vent_02_18.position.copy(endpoint_vent_02_18.midpoint);
    mesh_vent_02_18.quaternion.copy(endpoint_vent_02_18.quaternion);
  }
  mesh_vent_02_18.castShadow = options.castShadow ?? true;
  mesh_vent_02_18.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_02_18.userData.sculptComponent = {"id": "vent-02", "name": "Vent02", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.55, 2.0, 0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_02_18.add(mesh_vent_02_18);
  meshes["vent-02"] = mesh_vent_02_18;
  colliders["vent-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-02"] ??= [];
  destructionGroups["vent-02"].push(node_vent_02_18);

  const attachment_vent_02_cap_19 = {"parentId": "vent-02", "parentSocket": "vent-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_02_cap_19 = makeAttachmentEndpoint(attachment_vent_02_cap_19);
  const node_vent_02_cap_19 = new THREE.Group();
  node_vent_02_cap_19.name = "Vent02Cap__pivot";
  node_vent_02_cap_19.scale.set(1, 1, 1);
  if (endpoint_vent_02_cap_19) {
    node_vent_02_cap_19.position.copy(endpoint_vent_02_cap_19.start);
    node_vent_02_cap_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_02_cap_19.position.set(0.0, 0.14, 0.0);
    node_vent_02_cap_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_02_cap_19.userData.sculptComponent = {"id": "vent-02-cap", "name": "Vent02Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-02", "attachment": {"parentId": "vent-02", "parentSocket": "vent-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent02Cap solid geometry attached to vent-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-02-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_02_cap_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-02-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-02"] ?? root).add(node_vent_02_cap_19);
  nodes["vent-02-cap"] = node_vent_02_cap_19;
  const mesh_vent_02_cap_19Geometry = endpoint_vent_02_cap_19
    ? new THREE.CylinderGeometry(endpoint_vent_02_cap_19.endRadius, endpoint_vent_02_cap_19.baseRadius, endpoint_vent_02_cap_19.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_02_cap_19) {
    mesh_vent_02_cap_19Geometry.scale(0.12, 0.06, 0.12);
  }
  const mesh_vent_02_cap_19 = new THREE.Mesh(
    mesh_vent_02_cap_19Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_02_cap_19.name = "Vent02Cap";
  if (endpoint_vent_02_cap_19) {
    mesh_vent_02_cap_19.position.copy(endpoint_vent_02_cap_19.midpoint);
    mesh_vent_02_cap_19.quaternion.copy(endpoint_vent_02_cap_19.quaternion);
  }
  mesh_vent_02_cap_19.castShadow = options.castShadow ?? true;
  mesh_vent_02_cap_19.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_02_cap_19.userData.sculptComponent = {"id": "vent-02-cap", "name": "Vent02Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-02", "attachment": {"parentId": "vent-02", "parentSocket": "vent-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent02Cap solid geometry attached to vent-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-02-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_02_cap_19.add(mesh_vent_02_cap_19);
  meshes["vent-02-cap"] = mesh_vent_02_cap_19;
  colliders["vent-02-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-02-cap"] ??= [];
  destructionGroups["vent-02-cap"].push(node_vent_02_cap_19);

  const attachment_vent_03_20 = {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_03_20 = makeAttachmentEndpoint(attachment_vent_03_20);
  const node_vent_03_20 = new THREE.Group();
  node_vent_03_20.name = "Vent03__pivot";
  node_vent_03_20.scale.set(1, 1, 1);
  if (endpoint_vent_03_20) {
    node_vent_03_20.position.copy(endpoint_vent_03_20.start);
    node_vent_03_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_03_20.position.set(0.0, 2.0, -0.3);
    node_vent_03_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_03_20.userData.sculptComponent = {"id": "vent-03", "name": "Vent03", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [0.0, 2.0, -0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_03_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_vent_03_20);
  nodes["vent-03"] = node_vent_03_20;
  const mesh_vent_03_20Geometry = endpoint_vent_03_20
    ? new THREE.CylinderGeometry(endpoint_vent_03_20.endRadius, endpoint_vent_03_20.baseRadius, endpoint_vent_03_20.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_03_20) {
    mesh_vent_03_20Geometry.scale(0.09, 0.24, 0.09);
  }
  const mesh_vent_03_20 = new THREE.Mesh(
    mesh_vent_03_20Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_03_20.name = "Vent03";
  if (endpoint_vent_03_20) {
    mesh_vent_03_20.position.copy(endpoint_vent_03_20.midpoint);
    mesh_vent_03_20.quaternion.copy(endpoint_vent_03_20.quaternion);
  }
  mesh_vent_03_20.castShadow = options.castShadow ?? true;
  mesh_vent_03_20.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_03_20.userData.sculptComponent = {"id": "vent-03", "name": "Vent03", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [0.0, 2.0, -0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_03_20.add(mesh_vent_03_20);
  meshes["vent-03"] = mesh_vent_03_20;
  colliders["vent-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-03"] ??= [];
  destructionGroups["vent-03"].push(node_vent_03_20);

  const attachment_vent_03_cap_21 = {"parentId": "vent-03", "parentSocket": "vent-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_03_cap_21 = makeAttachmentEndpoint(attachment_vent_03_cap_21);
  const node_vent_03_cap_21 = new THREE.Group();
  node_vent_03_cap_21.name = "Vent03Cap__pivot";
  node_vent_03_cap_21.scale.set(1, 1, 1);
  if (endpoint_vent_03_cap_21) {
    node_vent_03_cap_21.position.copy(endpoint_vent_03_cap_21.start);
    node_vent_03_cap_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_03_cap_21.position.set(0.0, 0.14, 0.0);
    node_vent_03_cap_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_03_cap_21.userData.sculptComponent = {"id": "vent-03-cap", "name": "Vent03Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-03", "attachment": {"parentId": "vent-03", "parentSocket": "vent-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent03Cap solid geometry attached to vent-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-03-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_03_cap_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-03-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-03"] ?? root).add(node_vent_03_cap_21);
  nodes["vent-03-cap"] = node_vent_03_cap_21;
  const mesh_vent_03_cap_21Geometry = endpoint_vent_03_cap_21
    ? new THREE.CylinderGeometry(endpoint_vent_03_cap_21.endRadius, endpoint_vent_03_cap_21.baseRadius, endpoint_vent_03_cap_21.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_03_cap_21) {
    mesh_vent_03_cap_21Geometry.scale(0.12, 0.06, 0.12);
  }
  const mesh_vent_03_cap_21 = new THREE.Mesh(
    mesh_vent_03_cap_21Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_03_cap_21.name = "Vent03Cap";
  if (endpoint_vent_03_cap_21) {
    mesh_vent_03_cap_21.position.copy(endpoint_vent_03_cap_21.midpoint);
    mesh_vent_03_cap_21.quaternion.copy(endpoint_vent_03_cap_21.quaternion);
  }
  mesh_vent_03_cap_21.castShadow = options.castShadow ?? true;
  mesh_vent_03_cap_21.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_03_cap_21.userData.sculptComponent = {"id": "vent-03-cap", "name": "Vent03Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-03", "attachment": {"parentId": "vent-03", "parentSocket": "vent-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent03Cap solid geometry attached to vent-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-03-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_03_cap_21.add(mesh_vent_03_cap_21);
  meshes["vent-03-cap"] = mesh_vent_03_cap_21;
  colliders["vent-03-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-03-cap"] ??= [];
  destructionGroups["vent-03-cap"].push(node_vent_03_cap_21);

  const attachment_vent_04_22 = {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_04_22 = makeAttachmentEndpoint(attachment_vent_04_22);
  const node_vent_04_22 = new THREE.Group();
  node_vent_04_22.name = "Vent04__pivot";
  node_vent_04_22.scale.set(1, 1, 1);
  if (endpoint_vent_04_22) {
    node_vent_04_22.position.copy(endpoint_vent_04_22.start);
    node_vent_04_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_04_22.position.set(0.55, 2.0, 0.3);
    node_vent_04_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_04_22.userData.sculptComponent = {"id": "vent-04", "name": "Vent04", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [0.55, 2.0, 0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_04_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_vent_04_22);
  nodes["vent-04"] = node_vent_04_22;
  const mesh_vent_04_22Geometry = endpoint_vent_04_22
    ? new THREE.CylinderGeometry(endpoint_vent_04_22.endRadius, endpoint_vent_04_22.baseRadius, endpoint_vent_04_22.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_04_22) {
    mesh_vent_04_22Geometry.scale(0.09, 0.24, 0.09);
  }
  const mesh_vent_04_22 = new THREE.Mesh(
    mesh_vent_04_22Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_04_22.name = "Vent04";
  if (endpoint_vent_04_22) {
    mesh_vent_04_22.position.copy(endpoint_vent_04_22.midpoint);
    mesh_vent_04_22.quaternion.copy(endpoint_vent_04_22.quaternion);
  }
  mesh_vent_04_22.castShadow = options.castShadow ?? true;
  mesh_vent_04_22.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_04_22.userData.sculptComponent = {"id": "vent-04", "name": "Vent04", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [0.55, 2.0, 0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_04_22.add(mesh_vent_04_22);
  meshes["vent-04"] = mesh_vent_04_22;
  colliders["vent-04"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-04"] ??= [];
  destructionGroups["vent-04"].push(node_vent_04_22);

  const attachment_vent_04_cap_23 = {"parentId": "vent-04", "parentSocket": "vent-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_04_cap_23 = makeAttachmentEndpoint(attachment_vent_04_cap_23);
  const node_vent_04_cap_23 = new THREE.Group();
  node_vent_04_cap_23.name = "Vent04Cap__pivot";
  node_vent_04_cap_23.scale.set(1, 1, 1);
  if (endpoint_vent_04_cap_23) {
    node_vent_04_cap_23.position.copy(endpoint_vent_04_cap_23.start);
    node_vent_04_cap_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_04_cap_23.position.set(0.0, 0.14, 0.0);
    node_vent_04_cap_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_04_cap_23.userData.sculptComponent = {"id": "vent-04-cap", "name": "Vent04Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-04", "attachment": {"parentId": "vent-04", "parentSocket": "vent-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent04Cap solid geometry attached to vent-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-04-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_04_cap_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-04-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-04"] ?? root).add(node_vent_04_cap_23);
  nodes["vent-04-cap"] = node_vent_04_cap_23;
  const mesh_vent_04_cap_23Geometry = endpoint_vent_04_cap_23
    ? new THREE.CylinderGeometry(endpoint_vent_04_cap_23.endRadius, endpoint_vent_04_cap_23.baseRadius, endpoint_vent_04_cap_23.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_04_cap_23) {
    mesh_vent_04_cap_23Geometry.scale(0.12, 0.06, 0.12);
  }
  const mesh_vent_04_cap_23 = new THREE.Mesh(
    mesh_vent_04_cap_23Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_04_cap_23.name = "Vent04Cap";
  if (endpoint_vent_04_cap_23) {
    mesh_vent_04_cap_23.position.copy(endpoint_vent_04_cap_23.midpoint);
    mesh_vent_04_cap_23.quaternion.copy(endpoint_vent_04_cap_23.quaternion);
  }
  mesh_vent_04_cap_23.castShadow = options.castShadow ?? true;
  mesh_vent_04_cap_23.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_04_cap_23.userData.sculptComponent = {"id": "vent-04-cap", "name": "Vent04Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-04", "attachment": {"parentId": "vent-04", "parentSocket": "vent-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent04Cap solid geometry attached to vent-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-04-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_04_cap_23.add(mesh_vent_04_cap_23);
  meshes["vent-04-cap"] = mesh_vent_04_cap_23;
  colliders["vent-04-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-04-cap"] ??= [];
  destructionGroups["vent-04-cap"].push(node_vent_04_cap_23);

  const attachment_vent_05_24 = {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_05_24 = makeAttachmentEndpoint(attachment_vent_05_24);
  const node_vent_05_24 = new THREE.Group();
  node_vent_05_24.name = "Vent05__pivot";
  node_vent_05_24.scale.set(1, 1, 1);
  if (endpoint_vent_05_24) {
    node_vent_05_24.position.copy(endpoint_vent_05_24.start);
    node_vent_05_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_05_24.position.set(1.1, 2.0, -0.3);
    node_vent_05_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_05_24.userData.sculptComponent = {"id": "vent-05", "name": "Vent05", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [1.1, 2.0, -0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_05_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_vent_05_24);
  nodes["vent-05"] = node_vent_05_24;
  const mesh_vent_05_24Geometry = endpoint_vent_05_24
    ? new THREE.CylinderGeometry(endpoint_vent_05_24.endRadius, endpoint_vent_05_24.baseRadius, endpoint_vent_05_24.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_05_24) {
    mesh_vent_05_24Geometry.scale(0.09, 0.24, 0.09);
  }
  const mesh_vent_05_24 = new THREE.Mesh(
    mesh_vent_05_24Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_05_24.name = "Vent05";
  if (endpoint_vent_05_24) {
    mesh_vent_05_24.position.copy(endpoint_vent_05_24.midpoint);
    mesh_vent_05_24.quaternion.copy(endpoint_vent_05_24.quaternion);
  }
  mesh_vent_05_24.castShadow = options.castShadow ?? true;
  mesh_vent_05_24.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_05_24.userData.sculptComponent = {"id": "vent-05", "name": "Vent05", "level": "meso", "role": "vent", "importance": 0.55, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.09, "height": 0.24, "depth": 0.09, "units": "world", "confidence": 0.8}, "transform": {"position": [1.1, 2.0, -0.3], "rotation": [0, 0, 0], "scale": [0.09, 0.24, 0.09]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Roof vent pipe with lighter cap", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_05_24.add(mesh_vent_05_24);
  meshes["vent-05"] = mesh_vent_05_24;
  colliders["vent-05"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-05"] ??= [];
  destructionGroups["vent-05"].push(node_vent_05_24);

  const attachment_vent_05_cap_25 = {"parentId": "vent-05", "parentSocket": "vent-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_vent_05_cap_25 = makeAttachmentEndpoint(attachment_vent_05_cap_25);
  const node_vent_05_cap_25 = new THREE.Group();
  node_vent_05_cap_25.name = "Vent05Cap__pivot";
  node_vent_05_cap_25.scale.set(1, 1, 1);
  if (endpoint_vent_05_cap_25) {
    node_vent_05_cap_25.position.copy(endpoint_vent_05_cap_25.start);
    node_vent_05_cap_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_05_cap_25.position.set(0.0, 0.14, 0.0);
    node_vent_05_cap_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_05_cap_25.userData.sculptComponent = {"id": "vent-05-cap", "name": "Vent05Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-05", "attachment": {"parentId": "vent-05", "parentSocket": "vent-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent05Cap solid geometry attached to vent-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-05-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_05_cap_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-05-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-05"] ?? root).add(node_vent_05_cap_25);
  nodes["vent-05-cap"] = node_vent_05_cap_25;
  const mesh_vent_05_cap_25Geometry = endpoint_vent_05_cap_25
    ? new THREE.CylinderGeometry(endpoint_vent_05_cap_25.endRadius, endpoint_vent_05_cap_25.baseRadius, endpoint_vent_05_cap_25.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vent_05_cap_25) {
    mesh_vent_05_cap_25Geometry.scale(0.12, 0.06, 0.12);
  }
  const mesh_vent_05_cap_25 = new THREE.Mesh(
    mesh_vent_05_cap_25Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_05_cap_25.name = "Vent05Cap";
  if (endpoint_vent_05_cap_25) {
    mesh_vent_05_cap_25.position.copy(endpoint_vent_05_cap_25.midpoint);
    mesh_vent_05_cap_25.quaternion.copy(endpoint_vent_05_cap_25.quaternion);
  }
  mesh_vent_05_cap_25.castShadow = options.castShadow ?? true;
  mesh_vent_05_cap_25.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_05_cap_25.userData.sculptComponent = {"id": "vent-05-cap", "name": "Vent05Cap", "level": "meso", "role": "vent-part", "importance": 0.45, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "vent-05", "attachment": {"parentId": "vent-05", "parentSocket": "vent-05-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.12, "height": 0.06, "depth": 0.12, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.14, 0], "rotation": [0, 0, 0], "scale": [0.12, 0.06, 0.12]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "Vent05Cap solid geometry attached to vent-05", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vent-05-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_05_cap_25.add(mesh_vent_05_cap_25);
  meshes["vent-05-cap"] = mesh_vent_05_cap_25;
  colliders["vent-05-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vent-05-cap"] ??= [];
  destructionGroups["vent-05-cap"].push(node_vent_05_cap_25);

  const attachment_lamp_post_26 = {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_lamp_post_26 = makeAttachmentEndpoint(attachment_lamp_post_26);
  const node_lamp_post_26 = new THREE.Group();
  node_lamp_post_26.name = "LampPost__pivot";
  node_lamp_post_26.scale.set(1, 1, 1);
  if (endpoint_lamp_post_26) {
    node_lamp_post_26.position.copy(endpoint_lamp_post_26.start);
    node_lamp_post_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lamp_post_26.position.set(1.3, 1.98, 0.3);
    node_lamp_post_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_lamp_post_26.userData.sculptComponent = {"id": "lamp-post", "name": "LampPost", "level": "meso", "role": "lamp", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.3, "depth": 0.04, "units": "world", "confidence": 0.85}, "transform": {"position": [1.3, 1.98, 0.3], "rotation": [0, 0, 0], "scale": [0.04, 0.3, 0.04]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "LampPost solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-post", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_lamp_post_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-post", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_lamp_post_26);
  nodes["lamp-post"] = node_lamp_post_26;
  const mesh_lamp_post_26Geometry = endpoint_lamp_post_26
    ? new THREE.CylinderGeometry(endpoint_lamp_post_26.endRadius, endpoint_lamp_post_26.baseRadius, endpoint_lamp_post_26.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_lamp_post_26) {
    mesh_lamp_post_26Geometry.scale(0.04, 0.3, 0.04);
  }
  const mesh_lamp_post_26 = new THREE.Mesh(
    mesh_lamp_post_26Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lamp_post_26.name = "LampPost";
  if (endpoint_lamp_post_26) {
    mesh_lamp_post_26.position.copy(endpoint_lamp_post_26.midpoint);
    mesh_lamp_post_26.quaternion.copy(endpoint_lamp_post_26.quaternion);
  }
  mesh_lamp_post_26.castShadow = options.castShadow ?? true;
  mesh_lamp_post_26.receiveShadow = options.receiveShadow ?? true;
  mesh_lamp_post_26.userData.sculptComponent = {"id": "lamp-post", "name": "LampPost", "level": "meso", "role": "lamp", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.3, "depth": 0.04, "units": "world", "confidence": 0.85}, "transform": {"position": [1.3, 1.98, 0.3], "rotation": [0, 0, 0], "scale": [0.04, 0.3, 0.04]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "LampPost solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-post", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_lamp_post_26.add(mesh_lamp_post_26);
  meshes["lamp-post"] = mesh_lamp_post_26;
  colliders["lamp-post"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["lamp-post"] ??= [];
  destructionGroups["lamp-post"].push(node_lamp_post_26);

  const endpoint_lamp_bulb_27 = makeAttachmentEndpoint(null);
  const node_lamp_bulb_27 = new THREE.Group();
  node_lamp_bulb_27.name = "LampBulb__pivot";
  node_lamp_bulb_27.scale.set(1, 1, 1);
  if (endpoint_lamp_bulb_27) {
    node_lamp_bulb_27.position.copy(endpoint_lamp_bulb_27.start);
    node_lamp_bulb_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lamp_bulb_27.position.set(0.0, 0.2, 0.0);
    node_lamp_bulb_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_lamp_bulb_27.userData.sculptComponent = {"id": "lamp-bulb", "name": "LampBulb", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "lamp-post", "attachment": {"parentId": "lamp-post", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.2, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_lamp_bulb_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["lamp-post"] ?? root).add(node_lamp_bulb_27);
  nodes["lamp-bulb"] = node_lamp_bulb_27;
  const mesh_lamp_bulb_27Geometry = endpoint_lamp_bulb_27
    ? new THREE.CylinderGeometry(endpoint_lamp_bulb_27.endRadius, endpoint_lamp_bulb_27.baseRadius, endpoint_lamp_bulb_27.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_lamp_bulb_27) {
    mesh_lamp_bulb_27Geometry.scale(0.14, 0.14, 0.14);
  }
  const mesh_lamp_bulb_27 = new THREE.Mesh(
    mesh_lamp_bulb_27Geometry,
    materialMap["lamp-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lamp_bulb_27.name = "LampBulb";
  if (endpoint_lamp_bulb_27) {
    mesh_lamp_bulb_27.position.copy(endpoint_lamp_bulb_27.midpoint);
    mesh_lamp_bulb_27.quaternion.copy(endpoint_lamp_bulb_27.quaternion);
  }
  mesh_lamp_bulb_27.castShadow = options.castShadow ?? true;
  mesh_lamp_bulb_27.receiveShadow = options.receiveShadow ?? true;
  mesh_lamp_bulb_27.userData.sculptComponent = {"id": "lamp-bulb", "name": "LampBulb", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "lamp-post", "attachment": {"parentId": "lamp-post", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.2, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_lamp_bulb_27.add(mesh_lamp_bulb_27);
  meshes["lamp-bulb"] = mesh_lamp_bulb_27;
  colliders["lamp-bulb"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["lamp-bulb"] ??= [];
  destructionGroups["lamp-bulb"].push(node_lamp_bulb_27);

  const endpoint_stairs_left_28 = makeAttachmentEndpoint(null);
  const node_stairs_left_28 = new THREE.Group();
  node_stairs_left_28.name = "StairsLeft__pivot";
  node_stairs_left_28.scale.set(1, 1, 1);
  if (endpoint_stairs_left_28) {
    node_stairs_left_28.position.copy(endpoint_stairs_left_28.start);
    node_stairs_left_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stairs_left_28.position.set(-1.55, 0.35, 0.0);
    node_stairs_left_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_stairs_left_28.userData.sculptComponent = {"id": "stairs-left", "name": "StairsLeft", "level": "meso", "role": "stairs", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.35, "height": 0.1, "depth": 0.8, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.55, 0.35, 0], "rotation": [0, 0, 0], "scale": [0.35, 0.1, 0.8]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "StairsLeft solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_stairs_left_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_stairs_left_28);
  nodes["stairs-left"] = node_stairs_left_28;
  const mesh_stairs_left_28Geometry = endpoint_stairs_left_28
    ? new THREE.CylinderGeometry(endpoint_stairs_left_28.endRadius, endpoint_stairs_left_28.baseRadius, endpoint_stairs_left_28.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_stairs_left_28) {
    mesh_stairs_left_28Geometry.scale(0.35, 0.1, 0.8);
  }
  const mesh_stairs_left_28 = new THREE.Mesh(
    mesh_stairs_left_28Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stairs_left_28.name = "StairsLeft";
  if (endpoint_stairs_left_28) {
    mesh_stairs_left_28.position.copy(endpoint_stairs_left_28.midpoint);
    mesh_stairs_left_28.quaternion.copy(endpoint_stairs_left_28.quaternion);
  }
  mesh_stairs_left_28.castShadow = options.castShadow ?? true;
  mesh_stairs_left_28.receiveShadow = options.receiveShadow ?? true;
  mesh_stairs_left_28.userData.sculptComponent = {"id": "stairs-left", "name": "StairsLeft", "level": "meso", "role": "stairs", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.35, "height": 0.1, "depth": 0.8, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.55, 0.35, 0], "rotation": [0, 0, 0], "scale": [0.35, 0.1, 0.8]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "StairsLeft solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_stairs_left_28.add(mesh_stairs_left_28);
  meshes["stairs-left"] = mesh_stairs_left_28;
  colliders["stairs-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["stairs-left"] ??= [];
  destructionGroups["stairs-left"].push(node_stairs_left_28);

  const endpoint_rail_left_29 = makeAttachmentEndpoint(null);
  const node_rail_left_29 = new THREE.Group();
  node_rail_left_29.name = "RailLeft__pivot";
  node_rail_left_29.scale.set(1, 1, 1);
  if (endpoint_rail_left_29) {
    node_rail_left_29.position.copy(endpoint_rail_left_29.start);
    node_rail_left_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rail_left_29.position.set(-1.4300000000000002, 0.85, 0.45);
    node_rail_left_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_rail_left_29.userData.sculptComponent = {"id": "rail-left", "name": "RailLeft", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.9, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.4300000000000002, 0.85, 0.45], "rotation": [0, 0, 0], "scale": [0.04, 0.9, 0.04]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "RailLeft solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_rail_left_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_rail_left_29);
  nodes["rail-left"] = node_rail_left_29;
  const mesh_rail_left_29Geometry = endpoint_rail_left_29
    ? new THREE.CylinderGeometry(endpoint_rail_left_29.endRadius, endpoint_rail_left_29.baseRadius, endpoint_rail_left_29.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_rail_left_29) {
    mesh_rail_left_29Geometry.scale(0.04, 0.9, 0.04);
  }
  const mesh_rail_left_29 = new THREE.Mesh(
    mesh_rail_left_29Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rail_left_29.name = "RailLeft";
  if (endpoint_rail_left_29) {
    mesh_rail_left_29.position.copy(endpoint_rail_left_29.midpoint);
    mesh_rail_left_29.quaternion.copy(endpoint_rail_left_29.quaternion);
  }
  mesh_rail_left_29.castShadow = options.castShadow ?? true;
  mesh_rail_left_29.receiveShadow = options.receiveShadow ?? true;
  mesh_rail_left_29.userData.sculptComponent = {"id": "rail-left", "name": "RailLeft", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.9, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.4300000000000002, 0.85, 0.45], "rotation": [0, 0, 0], "scale": [0.04, 0.9, 0.04]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "RailLeft solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_rail_left_29.add(mesh_rail_left_29);
  meshes["rail-left"] = mesh_rail_left_29;
  colliders["rail-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rail-left"] ??= [];
  destructionGroups["rail-left"].push(node_rail_left_29);

  const endpoint_stairs_right_30 = makeAttachmentEndpoint(null);
  const node_stairs_right_30 = new THREE.Group();
  node_stairs_right_30.name = "StairsRight__pivot";
  node_stairs_right_30.scale.set(1, 1, 1);
  if (endpoint_stairs_right_30) {
    node_stairs_right_30.position.copy(endpoint_stairs_right_30.start);
    node_stairs_right_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stairs_right_30.position.set(1.55, 0.35, 0.0);
    node_stairs_right_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_stairs_right_30.userData.sculptComponent = {"id": "stairs-right", "name": "StairsRight", "level": "meso", "role": "stairs", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.35, "height": 0.1, "depth": 0.8, "units": "world", "confidence": 0.8}, "transform": {"position": [1.55, 0.35, 0], "rotation": [0, 0, 0], "scale": [0.35, 0.1, 0.8]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "StairsRight solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_stairs_right_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_stairs_right_30);
  nodes["stairs-right"] = node_stairs_right_30;
  const mesh_stairs_right_30Geometry = endpoint_stairs_right_30
    ? new THREE.CylinderGeometry(endpoint_stairs_right_30.endRadius, endpoint_stairs_right_30.baseRadius, endpoint_stairs_right_30.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_stairs_right_30) {
    mesh_stairs_right_30Geometry.scale(0.35, 0.1, 0.8);
  }
  const mesh_stairs_right_30 = new THREE.Mesh(
    mesh_stairs_right_30Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stairs_right_30.name = "StairsRight";
  if (endpoint_stairs_right_30) {
    mesh_stairs_right_30.position.copy(endpoint_stairs_right_30.midpoint);
    mesh_stairs_right_30.quaternion.copy(endpoint_stairs_right_30.quaternion);
  }
  mesh_stairs_right_30.castShadow = options.castShadow ?? true;
  mesh_stairs_right_30.receiveShadow = options.receiveShadow ?? true;
  mesh_stairs_right_30.userData.sculptComponent = {"id": "stairs-right", "name": "StairsRight", "level": "meso", "role": "stairs", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.35, "height": 0.1, "depth": 0.8, "units": "world", "confidence": 0.8}, "transform": {"position": [1.55, 0.35, 0], "rotation": [0, 0, 0], "scale": [0.35, 0.1, 0.8]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "StairsRight solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_stairs_right_30.add(mesh_stairs_right_30);
  meshes["stairs-right"] = mesh_stairs_right_30;
  colliders["stairs-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["stairs-right"] ??= [];
  destructionGroups["stairs-right"].push(node_stairs_right_30);

  const endpoint_rail_right_31 = makeAttachmentEndpoint(null);
  const node_rail_right_31 = new THREE.Group();
  node_rail_right_31.name = "RailRight__pivot";
  node_rail_right_31.scale.set(1, 1, 1);
  if (endpoint_rail_right_31) {
    node_rail_right_31.position.copy(endpoint_rail_right_31.start);
    node_rail_right_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rail_right_31.position.set(1.4300000000000002, 0.85, 0.45);
    node_rail_right_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_rail_right_31.userData.sculptComponent = {"id": "rail-right", "name": "RailRight", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.9, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [1.4300000000000002, 0.85, 0.45], "rotation": [0, 0, 0], "scale": [0.04, 0.9, 0.04]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "RailRight solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_rail_right_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_rail_right_31);
  nodes["rail-right"] = node_rail_right_31;
  const mesh_rail_right_31Geometry = endpoint_rail_right_31
    ? new THREE.CylinderGeometry(endpoint_rail_right_31.endRadius, endpoint_rail_right_31.baseRadius, endpoint_rail_right_31.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_rail_right_31) {
    mesh_rail_right_31Geometry.scale(0.04, 0.9, 0.04);
  }
  const mesh_rail_right_31 = new THREE.Mesh(
    mesh_rail_right_31Geometry,
    materialMap["metal-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rail_right_31.name = "RailRight";
  if (endpoint_rail_right_31) {
    mesh_rail_right_31.position.copy(endpoint_rail_right_31.midpoint);
    mesh_rail_right_31.quaternion.copy(endpoint_rail_right_31.quaternion);
  }
  mesh_rail_right_31.castShadow = options.castShadow ?? true;
  mesh_rail_right_31.receiveShadow = options.receiveShadow ?? true;
  mesh_rail_right_31.userData.sculptComponent = {"id": "rail-right", "name": "RailRight", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.9, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [1.4300000000000002, 0.85, 0.45], "rotation": [0, 0, 0], "scale": [0.04, 0.9, 0.04]}, "material": "metal-gray", "evidenceRefs": ["full-object"], "topologyRationale": "RailRight solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(106, 106, 114, 1.0)", "secondaryAlbedo": "rgba(74, 74, 82, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "rail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_rail_right_31.add(mesh_rail_right_31);
  meshes["rail-right"] = mesh_rail_right_31;
  colliders["rail-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["rail-right"] ??= [];
  destructionGroups["rail-right"].push(node_rail_right_31);

  const endpoint_chassis_32 = makeAttachmentEndpoint(null);
  const node_chassis_32 = new THREE.Group();
  node_chassis_32.name = "Chassis__pivot";
  node_chassis_32.scale.set(1, 1, 1);
  if (endpoint_chassis_32) {
    node_chassis_32.position.copy(endpoint_chassis_32.start);
    node_chassis_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chassis_32.position.set(0.0, 0.35, 0.0);
    node_chassis_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_chassis_32.userData.sculptComponent = {"id": "chassis", "name": "Chassis", "level": "meso", "role": "undercarriage", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.1, "height": 0.16, "depth": 1.1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.35, 0], "rotation": [0, 0, 0], "scale": [3.1, 0.16, 1.1]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Chassis solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chassis_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["starry-root"] ?? root).add(node_chassis_32);
  nodes["chassis"] = node_chassis_32;
  const mesh_chassis_32Geometry = endpoint_chassis_32
    ? new THREE.CylinderGeometry(endpoint_chassis_32.endRadius, endpoint_chassis_32.baseRadius, endpoint_chassis_32.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chassis_32) {
    mesh_chassis_32Geometry.scale(3.1, 0.16, 1.1);
  }
  const mesh_chassis_32 = new THREE.Mesh(
    mesh_chassis_32Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chassis_32.name = "Chassis";
  if (endpoint_chassis_32) {
    mesh_chassis_32.position.copy(endpoint_chassis_32.midpoint);
    mesh_chassis_32.quaternion.copy(endpoint_chassis_32.quaternion);
  }
  mesh_chassis_32.castShadow = options.castShadow ?? true;
  mesh_chassis_32.receiveShadow = options.receiveShadow ?? true;
  mesh_chassis_32.userData.sculptComponent = {"id": "chassis", "name": "Chassis", "level": "meso", "role": "undercarriage", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "starry-root", "attachment": {"parentId": "starry-root", "parentSocket": "starry-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.1, "height": 0.16, "depth": 1.1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.35, 0], "rotation": [0, 0, 0], "scale": [3.1, 0.16, 1.1]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Chassis solid geometry attached to starry-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chassis_32.add(mesh_chassis_32);
  meshes["chassis"] = mesh_chassis_32;
  colliders["chassis"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["chassis"] ??= [];
  destructionGroups["chassis"].push(node_chassis_32);

  const attachment_wheel_front_33 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_front_33 = makeAttachmentEndpoint(attachment_wheel_front_33);
  const node_wheel_front_33 = new THREE.Group();
  node_wheel_front_33.name = "WheelFront__pivot";
  node_wheel_front_33.scale.set(1, 1, 1);
  if (endpoint_wheel_front_33) {
    node_wheel_front_33.position.copy(endpoint_wheel_front_33.start);
    node_wheel_front_33.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_front_33.position.set(-0.9, -0.15, -0.45);
    node_wheel_front_33.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_front_33.userData.sculptComponent = {"id": "wheel-front", "name": "WheelFront", "level": "meso", "role": "wheel", "importance": 0.7, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.42, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.9, -0.15, -0.45], "rotation": [1.5708, 0, 0], "scale": [0.42, 0.14, 0.42]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFront solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_front_33);
  nodes["wheel-front"] = node_wheel_front_33;
  const mesh_wheel_front_33Geometry = endpoint_wheel_front_33
    ? new THREE.CylinderGeometry(endpoint_wheel_front_33.endRadius, endpoint_wheel_front_33.baseRadius, endpoint_wheel_front_33.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_front_33) {
    mesh_wheel_front_33Geometry.scale(0.42, 0.14, 0.42);
  }
  const mesh_wheel_front_33 = new THREE.Mesh(
    mesh_wheel_front_33Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_33.name = "WheelFront";
  if (endpoint_wheel_front_33) {
    mesh_wheel_front_33.position.copy(endpoint_wheel_front_33.midpoint);
    mesh_wheel_front_33.quaternion.copy(endpoint_wheel_front_33.quaternion);
  }
  mesh_wheel_front_33.castShadow = options.castShadow ?? true;
  mesh_wheel_front_33.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_33.userData.sculptComponent = {"id": "wheel-front", "name": "WheelFront", "level": "meso", "role": "wheel", "importance": 0.7, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.42, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.9, -0.15, -0.45], "rotation": [1.5708, 0, 0], "scale": [0.42, 0.14, 0.42]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFront solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_33.add(mesh_wheel_front_33);
  meshes["wheel-front"] = mesh_wheel_front_33;
  colliders["wheel-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-front"] ??= [];
  destructionGroups["wheel-front"].push(node_wheel_front_33);

  const attachment_wheel_rear_34 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_rear_34 = makeAttachmentEndpoint(attachment_wheel_rear_34);
  const node_wheel_rear_34 = new THREE.Group();
  node_wheel_rear_34.name = "WheelRear__pivot";
  node_wheel_rear_34.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_34) {
    node_wheel_rear_34.position.copy(endpoint_wheel_rear_34.start);
    node_wheel_rear_34.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_rear_34.position.set(0.9, -0.15, -0.45);
    node_wheel_rear_34.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_rear_34.userData.sculptComponent = {"id": "wheel-rear", "name": "WheelRear", "level": "meso", "role": "wheel", "importance": 0.7, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.42, "units": "world", "confidence": 0.85}, "transform": {"position": [0.9, -0.15, -0.45], "rotation": [1.5708, 0, 0], "scale": [0.42, 0.14, 0.42]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRear solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_rear_34);
  nodes["wheel-rear"] = node_wheel_rear_34;
  const mesh_wheel_rear_34Geometry = endpoint_wheel_rear_34
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_34.endRadius, endpoint_wheel_rear_34.baseRadius, endpoint_wheel_rear_34.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_rear_34) {
    mesh_wheel_rear_34Geometry.scale(0.42, 0.14, 0.42);
  }
  const mesh_wheel_rear_34 = new THREE.Mesh(
    mesh_wheel_rear_34Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_34.name = "WheelRear";
  if (endpoint_wheel_rear_34) {
    mesh_wheel_rear_34.position.copy(endpoint_wheel_rear_34.midpoint);
    mesh_wheel_rear_34.quaternion.copy(endpoint_wheel_rear_34.quaternion);
  }
  mesh_wheel_rear_34.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_34.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_34.userData.sculptComponent = {"id": "wheel-rear", "name": "WheelRear", "level": "meso", "role": "wheel", "importance": 0.7, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.42, "units": "world", "confidence": 0.85}, "transform": {"position": [0.9, -0.15, -0.45], "rotation": [1.5708, 0, 0], "scale": [0.42, 0.14, 0.42]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRear solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_34.add(mesh_wheel_rear_34);
  meshes["wheel-rear"] = mesh_wheel_rear_34;
  colliders["wheel-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-rear"] ??= [];
  destructionGroups["wheel-rear"].push(node_wheel_rear_34);

  const attachment_coupler_left_35 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coupler_left_35 = makeAttachmentEndpoint(attachment_coupler_left_35);
  const node_coupler_left_35 = new THREE.Group();
  node_coupler_left_35.name = "CouplerLeft__pivot";
  node_coupler_left_35.scale.set(1, 1, 1);
  if (endpoint_coupler_left_35) {
    node_coupler_left_35.position.copy(endpoint_coupler_left_35.start);
    node_coupler_left_35.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_coupler_left_35.position.set(-1.62, 0.0, 0.0);
    node_coupler_left_35.rotation.set(0.0, 0.0, 1.5708);
  }
  node_coupler_left_35.userData.sculptComponent = {"id": "coupler-left", "name": "CouplerLeft", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.62, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.26, 0.08, 0.08]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerLeft solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_left_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_coupler_left_35);
  nodes["coupler-left"] = node_coupler_left_35;
  const mesh_coupler_left_35Geometry = endpoint_coupler_left_35
    ? new THREE.CylinderGeometry(endpoint_coupler_left_35.endRadius, endpoint_coupler_left_35.baseRadius, endpoint_coupler_left_35.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_coupler_left_35) {
    mesh_coupler_left_35Geometry.scale(0.26, 0.08, 0.08);
  }
  const mesh_coupler_left_35 = new THREE.Mesh(
    mesh_coupler_left_35Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coupler_left_35.name = "CouplerLeft";
  if (endpoint_coupler_left_35) {
    mesh_coupler_left_35.position.copy(endpoint_coupler_left_35.midpoint);
    mesh_coupler_left_35.quaternion.copy(endpoint_coupler_left_35.quaternion);
  }
  mesh_coupler_left_35.castShadow = options.castShadow ?? true;
  mesh_coupler_left_35.receiveShadow = options.receiveShadow ?? true;
  mesh_coupler_left_35.userData.sculptComponent = {"id": "coupler-left", "name": "CouplerLeft", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.62, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.26, 0.08, 0.08]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerLeft solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_left_35.add(mesh_coupler_left_35);
  meshes["coupler-left"] = mesh_coupler_left_35;
  colliders["coupler-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coupler-left"] ??= [];
  destructionGroups["coupler-left"].push(node_coupler_left_35);

  const attachment_coupler_right_36 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coupler_right_36 = makeAttachmentEndpoint(attachment_coupler_right_36);
  const node_coupler_right_36 = new THREE.Group();
  node_coupler_right_36.name = "CouplerRight__pivot";
  node_coupler_right_36.scale.set(1, 1, 1);
  if (endpoint_coupler_right_36) {
    node_coupler_right_36.position.copy(endpoint_coupler_right_36.start);
    node_coupler_right_36.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_coupler_right_36.position.set(1.62, 0.0, 0.0);
    node_coupler_right_36.rotation.set(0.0, 0.0, 1.5708);
  }
  node_coupler_right_36.userData.sculptComponent = {"id": "coupler-right", "name": "CouplerRight", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [1.62, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.26, 0.08, 0.08]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerRight solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_right_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_coupler_right_36);
  nodes["coupler-right"] = node_coupler_right_36;
  const mesh_coupler_right_36Geometry = endpoint_coupler_right_36
    ? new THREE.CylinderGeometry(endpoint_coupler_right_36.endRadius, endpoint_coupler_right_36.baseRadius, endpoint_coupler_right_36.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_coupler_right_36) {
    mesh_coupler_right_36Geometry.scale(0.26, 0.08, 0.08);
  }
  const mesh_coupler_right_36 = new THREE.Mesh(
    mesh_coupler_right_36Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coupler_right_36.name = "CouplerRight";
  if (endpoint_coupler_right_36) {
    mesh_coupler_right_36.position.copy(endpoint_coupler_right_36.midpoint);
    mesh_coupler_right_36.quaternion.copy(endpoint_coupler_right_36.quaternion);
  }
  mesh_coupler_right_36.castShadow = options.castShadow ?? true;
  mesh_coupler_right_36.receiveShadow = options.receiveShadow ?? true;
  mesh_coupler_right_36.userData.sculptComponent = {"id": "coupler-right", "name": "CouplerRight", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.26, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [1.62, 0, 0], "rotation": [0, 0, 1.5708], "scale": [0.26, 0.08, 0.08]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerRight solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_right_36.add(mesh_coupler_right_36);
  meshes["coupler-right"] = mesh_coupler_right_36;
  colliders["coupler-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coupler-right"] ??= [];
  destructionGroups["coupler-right"].push(node_coupler_right_36);

  const endpoint_window_01m_37 = makeAttachmentEndpoint(null);
  const node_window_01m_37 = new THREE.Group();
  node_window_01m_37.name = "Window01Mirror__pivot";
  node_window_01m_37.scale.set(1, 1, 1);
  if (endpoint_window_01m_37) {
    node_window_01m_37.position.copy(endpoint_window_01m_37.start);
    node_window_01m_37.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01m_37.position.set(-1.2, 0.0, -0.71);
    node_window_01m_37.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01m_37.userData.sculptComponent = {"id": "window-01m", "name": "Window01Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.2, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01m_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_01m_37);
  nodes["window-01m"] = node_window_01m_37;
  const mesh_window_01m_37Geometry = endpoint_window_01m_37
    ? new THREE.CylinderGeometry(endpoint_window_01m_37.endRadius, endpoint_window_01m_37.baseRadius, endpoint_window_01m_37.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01m_37) {
    mesh_window_01m_37Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_01m_37 = new THREE.Mesh(
    mesh_window_01m_37Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01m_37.name = "Window01Mirror";
  if (endpoint_window_01m_37) {
    mesh_window_01m_37.position.copy(endpoint_window_01m_37.midpoint);
    mesh_window_01m_37.quaternion.copy(endpoint_window_01m_37.quaternion);
  }
  mesh_window_01m_37.castShadow = options.castShadow ?? true;
  mesh_window_01m_37.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01m_37.visible = false; // 容器节点不渲染
  mesh_window_01m_37.userData.sculptComponent = {"id": "window-01m", "name": "Window01Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.2, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01m_37.add(mesh_window_01m_37);
  meshes["window-01m"] = mesh_window_01m_37;
  colliders["window-01m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01"] ??= [];
  destructionGroups["window-01"].push(node_window_01m_37);

  const endpoint_window_01_framem_38 = makeAttachmentEndpoint(null);
  const node_window_01_framem_38 = new THREE.Group();
  node_window_01_framem_38.name = "Window01FrameMirror__pivot";
  node_window_01_framem_38.scale.set(1, 1, 1);
  if (endpoint_window_01_framem_38) {
    node_window_01_framem_38.position.copy(endpoint_window_01_framem_38.start);
    node_window_01_framem_38.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01_framem_38.position.set(0.0, 0.0, 0.0);
    node_window_01_framem_38.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01_framem_38.userData.sculptComponent = {"id": "window-01-framem", "name": "Window01FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_framem_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_01_framem_38);
  nodes["window-01-framem"] = node_window_01_framem_38;
  const mesh_window_01_framem_38Geometry = endpoint_window_01_framem_38
    ? new THREE.CylinderGeometry(endpoint_window_01_framem_38.endRadius, endpoint_window_01_framem_38.baseRadius, endpoint_window_01_framem_38.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_framem_38) {
    mesh_window_01_framem_38Geometry.scale(0.38, 0.6, 0.05);
  }
  const mesh_window_01_framem_38 = new THREE.Mesh(
    mesh_window_01_framem_38Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_framem_38.name = "Window01FrameMirror";
  if (endpoint_window_01_framem_38) {
    mesh_window_01_framem_38.position.copy(endpoint_window_01_framem_38.midpoint);
    mesh_window_01_framem_38.quaternion.copy(endpoint_window_01_framem_38.quaternion);
  }
  mesh_window_01_framem_38.castShadow = options.castShadow ?? true;
  mesh_window_01_framem_38.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_framem_38.userData.sculptComponent = {"id": "window-01-framem", "name": "Window01FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.38, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.38, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_framem_38.add(mesh_window_01_framem_38);
  meshes["window-01-framem"] = mesh_window_01_framem_38;
  colliders["window-01-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-frame"] ??= [];
  destructionGroups["window-01-frame"].push(node_window_01_framem_38);

  const endpoint_window_01_glassm_39 = makeAttachmentEndpoint(null);
  const node_window_01_glassm_39 = new THREE.Group();
  node_window_01_glassm_39.name = "Window01GlassMirror__pivot";
  node_window_01_glassm_39.scale.set(1, 1, 1);
  if (endpoint_window_01_glassm_39) {
    node_window_01_glassm_39.position.copy(endpoint_window_01_glassm_39.start);
    node_window_01_glassm_39.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01_glassm_39.position.set(0.0, 0.0, 0.032);
    node_window_01_glassm_39.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01_glassm_39.userData.sculptComponent = {"id": "window-01-glassm", "name": "Window01GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glassm_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_01_glassm_39);
  nodes["window-01-glassm"] = node_window_01_glassm_39;
  const mesh_window_01_glassm_39Geometry = endpoint_window_01_glassm_39
    ? new THREE.CylinderGeometry(endpoint_window_01_glassm_39.endRadius, endpoint_window_01_glassm_39.baseRadius, endpoint_window_01_glassm_39.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_glassm_39) {
    mesh_window_01_glassm_39Geometry.scale(0.3, 0.52, 0.01);
  }
  const mesh_window_01_glassm_39 = new THREE.Mesh(
    mesh_window_01_glassm_39Geometry,
    materialMap["glass-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_glassm_39.name = "Window01GlassMirror";
  if (endpoint_window_01_glassm_39) {
    mesh_window_01_glassm_39.position.copy(endpoint_window_01_glassm_39.midpoint);
    mesh_window_01_glassm_39.quaternion.copy(endpoint_window_01_glassm_39.quaternion);
  }
  mesh_window_01_glassm_39.castShadow = options.castShadow ?? true;
  mesh_window_01_glassm_39.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_glassm_39.userData.sculptComponent = {"id": "window-01-glassm", "name": "Window01GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.3, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glassm_39.add(mesh_window_01_glassm_39);
  meshes["window-01-glassm"] = mesh_window_01_glassm_39;
  colliders["window-01-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-glass"] ??= [];
  destructionGroups["window-01-glass"].push(node_window_01_glassm_39);

  const endpoint_window_02m_40 = makeAttachmentEndpoint(null);
  const node_window_02m_40 = new THREE.Group();
  node_window_02m_40.name = "Window02Mirror__pivot";
  node_window_02m_40.scale.set(1, 1, 1);
  if (endpoint_window_02m_40) {
    node_window_02m_40.position.copy(endpoint_window_02m_40.start);
    node_window_02m_40.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02m_40.position.set(-0.45, 0.0, -0.71);
    node_window_02m_40.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02m_40.userData.sculptComponent = {"id": "window-02m", "name": "Window02Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.45, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02m_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_02m_40);
  nodes["window-02m"] = node_window_02m_40;
  const mesh_window_02m_40Geometry = endpoint_window_02m_40
    ? new THREE.CylinderGeometry(endpoint_window_02m_40.endRadius, endpoint_window_02m_40.baseRadius, endpoint_window_02m_40.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02m_40) {
    mesh_window_02m_40Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_02m_40 = new THREE.Mesh(
    mesh_window_02m_40Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02m_40.name = "Window02Mirror";
  if (endpoint_window_02m_40) {
    mesh_window_02m_40.position.copy(endpoint_window_02m_40.midpoint);
    mesh_window_02m_40.quaternion.copy(endpoint_window_02m_40.quaternion);
  }
  mesh_window_02m_40.castShadow = options.castShadow ?? true;
  mesh_window_02m_40.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02m_40.visible = false; // 容器节点不渲染
  mesh_window_02m_40.userData.sculptComponent = {"id": "window-02m", "name": "Window02Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.45, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02m_40.add(mesh_window_02m_40);
  meshes["window-02m"] = mesh_window_02m_40;
  colliders["window-02m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02"] ??= [];
  destructionGroups["window-02"].push(node_window_02m_40);

  const endpoint_window_02_framem_41 = makeAttachmentEndpoint(null);
  const node_window_02_framem_41 = new THREE.Group();
  node_window_02_framem_41.name = "Window02FrameMirror__pivot";
  node_window_02_framem_41.scale.set(1, 1, 1);
  if (endpoint_window_02_framem_41) {
    node_window_02_framem_41.position.copy(endpoint_window_02_framem_41.start);
    node_window_02_framem_41.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_framem_41.position.set(0.0, 0.0, 0.0);
    node_window_02_framem_41.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_framem_41.userData.sculptComponent = {"id": "window-02-framem", "name": "Window02FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_framem_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_framem_41);
  nodes["window-02-framem"] = node_window_02_framem_41;
  const mesh_window_02_framem_41Geometry = endpoint_window_02_framem_41
    ? new THREE.CylinderGeometry(endpoint_window_02_framem_41.endRadius, endpoint_window_02_framem_41.baseRadius, endpoint_window_02_framem_41.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_framem_41) {
    mesh_window_02_framem_41Geometry.scale(0.63, 0.6, 0.05);
  }
  const mesh_window_02_framem_41 = new THREE.Mesh(
    mesh_window_02_framem_41Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_framem_41.name = "Window02FrameMirror";
  if (endpoint_window_02_framem_41) {
    mesh_window_02_framem_41.position.copy(endpoint_window_02_framem_41.midpoint);
    mesh_window_02_framem_41.quaternion.copy(endpoint_window_02_framem_41.quaternion);
  }
  mesh_window_02_framem_41.castShadow = options.castShadow ?? true;
  mesh_window_02_framem_41.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_framem_41.userData.sculptComponent = {"id": "window-02-framem", "name": "Window02FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_framem_41.add(mesh_window_02_framem_41);
  meshes["window-02-framem"] = mesh_window_02_framem_41;
  colliders["window-02-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-frame"] ??= [];
  destructionGroups["window-02-frame"].push(node_window_02_framem_41);

  const endpoint_window_02_glassm_42 = makeAttachmentEndpoint(null);
  const node_window_02_glassm_42 = new THREE.Group();
  node_window_02_glassm_42.name = "Window02GlassMirror__pivot";
  node_window_02_glassm_42.scale.set(1, 1, 1);
  if (endpoint_window_02_glassm_42) {
    node_window_02_glassm_42.position.copy(endpoint_window_02_glassm_42.start);
    node_window_02_glassm_42.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_glassm_42.position.set(0.0, 0.0, 0.032);
    node_window_02_glassm_42.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_glassm_42.userData.sculptComponent = {"id": "window-02-glassm", "name": "Window02GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glassm_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_glassm_42);
  nodes["window-02-glassm"] = node_window_02_glassm_42;
  const mesh_window_02_glassm_42Geometry = endpoint_window_02_glassm_42
    ? new THREE.CylinderGeometry(endpoint_window_02_glassm_42.endRadius, endpoint_window_02_glassm_42.baseRadius, endpoint_window_02_glassm_42.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_glassm_42) {
    mesh_window_02_glassm_42Geometry.scale(0.55, 0.52, 0.01);
  }
  const mesh_window_02_glassm_42 = new THREE.Mesh(
    mesh_window_02_glassm_42Geometry,
    materialMap["glass-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_glassm_42.name = "Window02GlassMirror";
  if (endpoint_window_02_glassm_42) {
    mesh_window_02_glassm_42.position.copy(endpoint_window_02_glassm_42.midpoint);
    mesh_window_02_glassm_42.quaternion.copy(endpoint_window_02_glassm_42.quaternion);
  }
  mesh_window_02_glassm_42.castShadow = options.castShadow ?? true;
  mesh_window_02_glassm_42.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_glassm_42.userData.sculptComponent = {"id": "window-02-glassm", "name": "Window02GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glassm_42.add(mesh_window_02_glassm_42);
  meshes["window-02-glassm"] = mesh_window_02_glassm_42;
  colliders["window-02-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-glass"] ??= [];
  destructionGroups["window-02-glass"].push(node_window_02_glassm_42);

  const endpoint_window_03m_43 = makeAttachmentEndpoint(null);
  const node_window_03m_43 = new THREE.Group();
  node_window_03m_43.name = "Window03Mirror__pivot";
  node_window_03m_43.scale.set(1, 1, 1);
  if (endpoint_window_03m_43) {
    node_window_03m_43.position.copy(endpoint_window_03m_43.start);
    node_window_03m_43.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03m_43.position.set(0.35, 0.0, -0.71);
    node_window_03m_43.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03m_43.userData.sculptComponent = {"id": "window-03m", "name": "Window03Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.35, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03m_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_03m_43);
  nodes["window-03m"] = node_window_03m_43;
  const mesh_window_03m_43Geometry = endpoint_window_03m_43
    ? new THREE.CylinderGeometry(endpoint_window_03m_43.endRadius, endpoint_window_03m_43.baseRadius, endpoint_window_03m_43.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03m_43) {
    mesh_window_03m_43Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_03m_43 = new THREE.Mesh(
    mesh_window_03m_43Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03m_43.name = "Window03Mirror";
  if (endpoint_window_03m_43) {
    mesh_window_03m_43.position.copy(endpoint_window_03m_43.midpoint);
    mesh_window_03m_43.quaternion.copy(endpoint_window_03m_43.quaternion);
  }
  mesh_window_03m_43.castShadow = options.castShadow ?? true;
  mesh_window_03m_43.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03m_43.visible = false; // 容器节点不渲染
  mesh_window_03m_43.userData.sculptComponent = {"id": "window-03m", "name": "Window03Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.35, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03m_43.add(mesh_window_03m_43);
  meshes["window-03m"] = mesh_window_03m_43;
  colliders["window-03m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03"] ??= [];
  destructionGroups["window-03"].push(node_window_03m_43);

  const endpoint_window_03_framem_44 = makeAttachmentEndpoint(null);
  const node_window_03_framem_44 = new THREE.Group();
  node_window_03_framem_44.name = "Window03FrameMirror__pivot";
  node_window_03_framem_44.scale.set(1, 1, 1);
  if (endpoint_window_03_framem_44) {
    node_window_03_framem_44.position.copy(endpoint_window_03_framem_44.start);
    node_window_03_framem_44.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_framem_44.position.set(0.0, 0.0, 0.0);
    node_window_03_framem_44.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_framem_44.userData.sculptComponent = {"id": "window-03-framem", "name": "Window03FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_framem_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_framem_44);
  nodes["window-03-framem"] = node_window_03_framem_44;
  const mesh_window_03_framem_44Geometry = endpoint_window_03_framem_44
    ? new THREE.CylinderGeometry(endpoint_window_03_framem_44.endRadius, endpoint_window_03_framem_44.baseRadius, endpoint_window_03_framem_44.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_framem_44) {
    mesh_window_03_framem_44Geometry.scale(0.63, 0.6, 0.05);
  }
  const mesh_window_03_framem_44 = new THREE.Mesh(
    mesh_window_03_framem_44Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_framem_44.name = "Window03FrameMirror";
  if (endpoint_window_03_framem_44) {
    mesh_window_03_framem_44.position.copy(endpoint_window_03_framem_44.midpoint);
    mesh_window_03_framem_44.quaternion.copy(endpoint_window_03_framem_44.quaternion);
  }
  mesh_window_03_framem_44.castShadow = options.castShadow ?? true;
  mesh_window_03_framem_44.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_framem_44.userData.sculptComponent = {"id": "window-03-framem", "name": "Window03FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_framem_44.add(mesh_window_03_framem_44);
  meshes["window-03-framem"] = mesh_window_03_framem_44;
  colliders["window-03-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-frame"] ??= [];
  destructionGroups["window-03-frame"].push(node_window_03_framem_44);

  const endpoint_window_03_glassm_45 = makeAttachmentEndpoint(null);
  const node_window_03_glassm_45 = new THREE.Group();
  node_window_03_glassm_45.name = "Window03GlassMirror__pivot";
  node_window_03_glassm_45.scale.set(1, 1, 1);
  if (endpoint_window_03_glassm_45) {
    node_window_03_glassm_45.position.copy(endpoint_window_03_glassm_45.start);
    node_window_03_glassm_45.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_glassm_45.position.set(0.0, 0.0, 0.032);
    node_window_03_glassm_45.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_glassm_45.userData.sculptComponent = {"id": "window-03-glassm", "name": "Window03GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glassm_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_glassm_45);
  nodes["window-03-glassm"] = node_window_03_glassm_45;
  const mesh_window_03_glassm_45Geometry = endpoint_window_03_glassm_45
    ? new THREE.CylinderGeometry(endpoint_window_03_glassm_45.endRadius, endpoint_window_03_glassm_45.baseRadius, endpoint_window_03_glassm_45.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_glassm_45) {
    mesh_window_03_glassm_45Geometry.scale(0.55, 0.52, 0.01);
  }
  const mesh_window_03_glassm_45 = new THREE.Mesh(
    mesh_window_03_glassm_45Geometry,
    materialMap["glass-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_glassm_45.name = "Window03GlassMirror";
  if (endpoint_window_03_glassm_45) {
    mesh_window_03_glassm_45.position.copy(endpoint_window_03_glassm_45.midpoint);
    mesh_window_03_glassm_45.quaternion.copy(endpoint_window_03_glassm_45.quaternion);
  }
  mesh_window_03_glassm_45.castShadow = options.castShadow ?? true;
  mesh_window_03_glassm_45.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_glassm_45.userData.sculptComponent = {"id": "window-03-glassm", "name": "Window03GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glassm_45.add(mesh_window_03_glassm_45);
  meshes["window-03-glassm"] = mesh_window_03_glassm_45;
  colliders["window-03-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-glass"] ??= [];
  destructionGroups["window-03-glass"].push(node_window_03_glassm_45);

  const endpoint_window_04m_46 = makeAttachmentEndpoint(null);
  const node_window_04m_46 = new THREE.Group();
  node_window_04m_46.name = "Window04Mirror__pivot";
  node_window_04m_46.scale.set(1, 1, 1);
  if (endpoint_window_04m_46) {
    node_window_04m_46.position.copy(endpoint_window_04m_46.start);
    node_window_04m_46.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04m_46.position.set(1.1, 0.0, -0.71);
    node_window_04m_46.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04m_46.userData.sculptComponent = {"id": "window-04m", "name": "Window04Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.1, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04m_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_04m_46);
  nodes["window-04m"] = node_window_04m_46;
  const mesh_window_04m_46Geometry = endpoint_window_04m_46
    ? new THREE.CylinderGeometry(endpoint_window_04m_46.endRadius, endpoint_window_04m_46.baseRadius, endpoint_window_04m_46.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04m_46) {
    mesh_window_04m_46Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_04m_46 = new THREE.Mesh(
    mesh_window_04m_46Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04m_46.name = "Window04Mirror";
  if (endpoint_window_04m_46) {
    mesh_window_04m_46.position.copy(endpoint_window_04m_46.midpoint);
    mesh_window_04m_46.quaternion.copy(endpoint_window_04m_46.quaternion);
  }
  mesh_window_04m_46.castShadow = options.castShadow ?? true;
  mesh_window_04m_46.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04m_46.visible = false; // 容器节点不渲染
  mesh_window_04m_46.userData.sculptComponent = {"id": "window-04m", "name": "Window04Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.1, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04m_46.add(mesh_window_04m_46);
  meshes["window-04m"] = mesh_window_04m_46;
  colliders["window-04m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04"] ??= [];
  destructionGroups["window-04"].push(node_window_04m_46);

  const endpoint_window_04_framem_47 = makeAttachmentEndpoint(null);
  const node_window_04_framem_47 = new THREE.Group();
  node_window_04_framem_47.name = "Window04FrameMirror__pivot";
  node_window_04_framem_47.scale.set(1, 1, 1);
  if (endpoint_window_04_framem_47) {
    node_window_04_framem_47.position.copy(endpoint_window_04_framem_47.start);
    node_window_04_framem_47.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04_framem_47.position.set(0.0, 0.0, 0.0);
    node_window_04_framem_47.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04_framem_47.userData.sculptComponent = {"id": "window-04-framem", "name": "Window04FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_framem_47.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04m"] ?? root).add(node_window_04_framem_47);
  nodes["window-04-framem"] = node_window_04_framem_47;
  const mesh_window_04_framem_47Geometry = endpoint_window_04_framem_47
    ? new THREE.CylinderGeometry(endpoint_window_04_framem_47.endRadius, endpoint_window_04_framem_47.baseRadius, endpoint_window_04_framem_47.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_framem_47) {
    mesh_window_04_framem_47Geometry.scale(0.63, 0.6, 0.05);
  }
  const mesh_window_04_framem_47 = new THREE.Mesh(
    mesh_window_04_framem_47Geometry,
    materialMap["frame-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_framem_47.name = "Window04FrameMirror";
  if (endpoint_window_04_framem_47) {
    mesh_window_04_framem_47.position.copy(endpoint_window_04_framem_47.midpoint);
    mesh_window_04_framem_47.quaternion.copy(endpoint_window_04_framem_47.quaternion);
  }
  mesh_window_04_framem_47.castShadow = options.castShadow ?? true;
  mesh_window_04_framem_47.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_framem_47.userData.sculptComponent = {"id": "window-04-framem", "name": "Window04FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.63, "height": 0.6, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.63, 0.6, 0.05]}, "material": "frame-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 42, 32, 1.0)", "secondaryAlbedo": "rgba(42, 30, 22, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_framem_47.add(mesh_window_04_framem_47);
  meshes["window-04-framem"] = mesh_window_04_framem_47;
  colliders["window-04-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-frame"] ??= [];
  destructionGroups["window-04-frame"].push(node_window_04_framem_47);

  const endpoint_window_04_glassm_48 = makeAttachmentEndpoint(null);
  const node_window_04_glassm_48 = new THREE.Group();
  node_window_04_glassm_48.name = "Window04GlassMirror__pivot";
  node_window_04_glassm_48.scale.set(1, 1, 1);
  if (endpoint_window_04_glassm_48) {
    node_window_04_glassm_48.position.copy(endpoint_window_04_glassm_48.start);
    node_window_04_glassm_48.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04_glassm_48.position.set(0.0, 0.0, 0.032);
    node_window_04_glassm_48.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04_glassm_48.userData.sculptComponent = {"id": "window-04-glassm", "name": "Window04GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glassm_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04m"] ?? root).add(node_window_04_glassm_48);
  nodes["window-04-glassm"] = node_window_04_glassm_48;
  const mesh_window_04_glassm_48Geometry = endpoint_window_04_glassm_48
    ? new THREE.CylinderGeometry(endpoint_window_04_glassm_48.endRadius, endpoint_window_04_glassm_48.baseRadius, endpoint_window_04_glassm_48.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_glassm_48) {
    mesh_window_04_glassm_48Geometry.scale(0.55, 0.52, 0.01);
  }
  const mesh_window_04_glassm_48 = new THREE.Mesh(
    mesh_window_04_glassm_48Geometry,
    materialMap["glass-warm"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_glassm_48.name = "Window04GlassMirror";
  if (endpoint_window_04_glassm_48) {
    mesh_window_04_glassm_48.position.copy(endpoint_window_04_glassm_48.midpoint);
    mesh_window_04_glassm_48.quaternion.copy(endpoint_window_04_glassm_48.quaternion);
  }
  mesh_window_04_glassm_48.castShadow = options.castShadow ?? true;
  mesh_window_04_glassm_48.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_glassm_48.userData.sculptComponent = {"id": "window-04-glassm", "name": "Window04GlassMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.52, "depth": 0.01, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0.032], "rotation": [0, 3.14159, 0], "scale": [0.55, 0.52, 0.01]}, "material": "glass-warm", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 168, 96, 1.0)", "secondaryAlbedo": "rgba(200, 136, 72, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glassm_48.add(mesh_window_04_glassm_48);
  meshes["window-04-glassm"] = mesh_window_04_glassm_48;
  colliders["window-04-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-glass"] ??= [];
  destructionGroups["window-04-glass"].push(node_window_04_glassm_48);

  const endpoint_vent_01_bulb_49 = makeAttachmentEndpoint(null);
  const node_vent_01_bulb_49 = new THREE.Group();
  node_vent_01_bulb_49.name = "VentBulb01__pivot";
  node_vent_01_bulb_49.scale.set(1, 1, 1);
  if (endpoint_vent_01_bulb_49) {
    node_vent_01_bulb_49.position.copy(endpoint_vent_01_bulb_49.start);
    node_vent_01_bulb_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_01_bulb_49.position.set(0.0, 0.22, 0.0);
    node_vent_01_bulb_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_01_bulb_49.userData.sculptComponent = {"id": "vent-01-bulb", "name": "VentBulb01", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-01", "attachment": {"parentId": "vent-01", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_01_bulb_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-01"] ?? root).add(node_vent_01_bulb_49);
  nodes["vent-01-bulb"] = node_vent_01_bulb_49;
  const mesh_vent_01_bulb_49Geometry = endpoint_vent_01_bulb_49
    ? new THREE.CylinderGeometry(endpoint_vent_01_bulb_49.endRadius, endpoint_vent_01_bulb_49.baseRadius, endpoint_vent_01_bulb_49.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_vent_01_bulb_49) {
    mesh_vent_01_bulb_49Geometry.scale(0.14, 0.14, 0.14);
  }
  const mesh_vent_01_bulb_49 = new THREE.Mesh(
    mesh_vent_01_bulb_49Geometry,
    materialMap["lamp-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_01_bulb_49.name = "VentBulb01";
  if (endpoint_vent_01_bulb_49) {
    mesh_vent_01_bulb_49.position.copy(endpoint_vent_01_bulb_49.midpoint);
    mesh_vent_01_bulb_49.quaternion.copy(endpoint_vent_01_bulb_49.quaternion);
  }
  mesh_vent_01_bulb_49.castShadow = options.castShadow ?? true;
  mesh_vent_01_bulb_49.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_01_bulb_49.userData.sculptComponent = {"id": "vent-01-bulb", "name": "VentBulb01", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-01", "attachment": {"parentId": "vent-01", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_01_bulb_49.add(mesh_vent_01_bulb_49);
  meshes["vent-01-bulb"] = mesh_vent_01_bulb_49;
  colliders["vent-01-bulb"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["lamp-bulb"] ??= [];
  destructionGroups["lamp-bulb"].push(node_vent_01_bulb_49);

  const endpoint_vent_02_bulb_50 = makeAttachmentEndpoint(null);
  const node_vent_02_bulb_50 = new THREE.Group();
  node_vent_02_bulb_50.name = "VentBulb02__pivot";
  node_vent_02_bulb_50.scale.set(1, 1, 1);
  if (endpoint_vent_02_bulb_50) {
    node_vent_02_bulb_50.position.copy(endpoint_vent_02_bulb_50.start);
    node_vent_02_bulb_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_02_bulb_50.position.set(0.0, 0.22, 0.0);
    node_vent_02_bulb_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_02_bulb_50.userData.sculptComponent = {"id": "vent-02-bulb", "name": "VentBulb02", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-02", "attachment": {"parentId": "vent-02", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_02_bulb_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-02"] ?? root).add(node_vent_02_bulb_50);
  nodes["vent-02-bulb"] = node_vent_02_bulb_50;
  const mesh_vent_02_bulb_50Geometry = endpoint_vent_02_bulb_50
    ? new THREE.CylinderGeometry(endpoint_vent_02_bulb_50.endRadius, endpoint_vent_02_bulb_50.baseRadius, endpoint_vent_02_bulb_50.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_vent_02_bulb_50) {
    mesh_vent_02_bulb_50Geometry.scale(0.14, 0.14, 0.14);
  }
  const mesh_vent_02_bulb_50 = new THREE.Mesh(
    mesh_vent_02_bulb_50Geometry,
    materialMap["lamp-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_02_bulb_50.name = "VentBulb02";
  if (endpoint_vent_02_bulb_50) {
    mesh_vent_02_bulb_50.position.copy(endpoint_vent_02_bulb_50.midpoint);
    mesh_vent_02_bulb_50.quaternion.copy(endpoint_vent_02_bulb_50.quaternion);
  }
  mesh_vent_02_bulb_50.castShadow = options.castShadow ?? true;
  mesh_vent_02_bulb_50.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_02_bulb_50.userData.sculptComponent = {"id": "vent-02-bulb", "name": "VentBulb02", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-02", "attachment": {"parentId": "vent-02", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_02_bulb_50.add(mesh_vent_02_bulb_50);
  meshes["vent-02-bulb"] = mesh_vent_02_bulb_50;
  colliders["vent-02-bulb"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["lamp-bulb"] ??= [];
  destructionGroups["lamp-bulb"].push(node_vent_02_bulb_50);

  const endpoint_vent_03_bulb_51 = makeAttachmentEndpoint(null);
  const node_vent_03_bulb_51 = new THREE.Group();
  node_vent_03_bulb_51.name = "VentBulb03__pivot";
  node_vent_03_bulb_51.scale.set(1, 1, 1);
  if (endpoint_vent_03_bulb_51) {
    node_vent_03_bulb_51.position.copy(endpoint_vent_03_bulb_51.start);
    node_vent_03_bulb_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_03_bulb_51.position.set(0.0, 0.22, 0.0);
    node_vent_03_bulb_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_03_bulb_51.userData.sculptComponent = {"id": "vent-03-bulb", "name": "VentBulb03", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-03", "attachment": {"parentId": "vent-03", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_03_bulb_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-03"] ?? root).add(node_vent_03_bulb_51);
  nodes["vent-03-bulb"] = node_vent_03_bulb_51;
  const mesh_vent_03_bulb_51Geometry = endpoint_vent_03_bulb_51
    ? new THREE.CylinderGeometry(endpoint_vent_03_bulb_51.endRadius, endpoint_vent_03_bulb_51.baseRadius, endpoint_vent_03_bulb_51.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_vent_03_bulb_51) {
    mesh_vent_03_bulb_51Geometry.scale(0.14, 0.14, 0.14);
  }
  const mesh_vent_03_bulb_51 = new THREE.Mesh(
    mesh_vent_03_bulb_51Geometry,
    materialMap["lamp-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_03_bulb_51.name = "VentBulb03";
  if (endpoint_vent_03_bulb_51) {
    mesh_vent_03_bulb_51.position.copy(endpoint_vent_03_bulb_51.midpoint);
    mesh_vent_03_bulb_51.quaternion.copy(endpoint_vent_03_bulb_51.quaternion);
  }
  mesh_vent_03_bulb_51.castShadow = options.castShadow ?? true;
  mesh_vent_03_bulb_51.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_03_bulb_51.userData.sculptComponent = {"id": "vent-03-bulb", "name": "VentBulb03", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-03", "attachment": {"parentId": "vent-03", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_03_bulb_51.add(mesh_vent_03_bulb_51);
  meshes["vent-03-bulb"] = mesh_vent_03_bulb_51;
  colliders["vent-03-bulb"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["lamp-bulb"] ??= [];
  destructionGroups["lamp-bulb"].push(node_vent_03_bulb_51);

  const endpoint_vent_04_bulb_52 = makeAttachmentEndpoint(null);
  const node_vent_04_bulb_52 = new THREE.Group();
  node_vent_04_bulb_52.name = "VentBulb04__pivot";
  node_vent_04_bulb_52.scale.set(1, 1, 1);
  if (endpoint_vent_04_bulb_52) {
    node_vent_04_bulb_52.position.copy(endpoint_vent_04_bulb_52.start);
    node_vent_04_bulb_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_04_bulb_52.position.set(0.0, 0.22, 0.0);
    node_vent_04_bulb_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_04_bulb_52.userData.sculptComponent = {"id": "vent-04-bulb", "name": "VentBulb04", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-04", "attachment": {"parentId": "vent-04", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_04_bulb_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-04"] ?? root).add(node_vent_04_bulb_52);
  nodes["vent-04-bulb"] = node_vent_04_bulb_52;
  const mesh_vent_04_bulb_52Geometry = endpoint_vent_04_bulb_52
    ? new THREE.CylinderGeometry(endpoint_vent_04_bulb_52.endRadius, endpoint_vent_04_bulb_52.baseRadius, endpoint_vent_04_bulb_52.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_vent_04_bulb_52) {
    mesh_vent_04_bulb_52Geometry.scale(0.14, 0.14, 0.14);
  }
  const mesh_vent_04_bulb_52 = new THREE.Mesh(
    mesh_vent_04_bulb_52Geometry,
    materialMap["lamp-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_04_bulb_52.name = "VentBulb04";
  if (endpoint_vent_04_bulb_52) {
    mesh_vent_04_bulb_52.position.copy(endpoint_vent_04_bulb_52.midpoint);
    mesh_vent_04_bulb_52.quaternion.copy(endpoint_vent_04_bulb_52.quaternion);
  }
  mesh_vent_04_bulb_52.castShadow = options.castShadow ?? true;
  mesh_vent_04_bulb_52.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_04_bulb_52.userData.sculptComponent = {"id": "vent-04-bulb", "name": "VentBulb04", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-04", "attachment": {"parentId": "vent-04", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_04_bulb_52.add(mesh_vent_04_bulb_52);
  meshes["vent-04-bulb"] = mesh_vent_04_bulb_52;
  colliders["vent-04-bulb"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["lamp-bulb"] ??= [];
  destructionGroups["lamp-bulb"].push(node_vent_04_bulb_52);

  const endpoint_vent_05_bulb_53 = makeAttachmentEndpoint(null);
  const node_vent_05_bulb_53 = new THREE.Group();
  node_vent_05_bulb_53.name = "VentBulb05__pivot";
  node_vent_05_bulb_53.scale.set(1, 1, 1);
  if (endpoint_vent_05_bulb_53) {
    node_vent_05_bulb_53.position.copy(endpoint_vent_05_bulb_53.start);
    node_vent_05_bulb_53.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_05_bulb_53.position.set(0.0, 0.22, 0.0);
    node_vent_05_bulb_53.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_05_bulb_53.userData.sculptComponent = {"id": "vent-05-bulb", "name": "VentBulb05", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-05", "attachment": {"parentId": "vent-05", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_05_bulb_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vent-05"] ?? root).add(node_vent_05_bulb_53);
  nodes["vent-05-bulb"] = node_vent_05_bulb_53;
  const mesh_vent_05_bulb_53Geometry = endpoint_vent_05_bulb_53
    ? new THREE.CylinderGeometry(endpoint_vent_05_bulb_53.endRadius, endpoint_vent_05_bulb_53.baseRadius, endpoint_vent_05_bulb_53.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_vent_05_bulb_53) {
    mesh_vent_05_bulb_53Geometry.scale(0.14, 0.14, 0.14);
  }
  const mesh_vent_05_bulb_53 = new THREE.Mesh(
    mesh_vent_05_bulb_53Geometry,
    materialMap["lamp-yellow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_05_bulb_53.name = "VentBulb05";
  if (endpoint_vent_05_bulb_53) {
    mesh_vent_05_bulb_53.position.copy(endpoint_vent_05_bulb_53.midpoint);
    mesh_vent_05_bulb_53.quaternion.copy(endpoint_vent_05_bulb_53.quaternion);
  }
  mesh_vent_05_bulb_53.castShadow = options.castShadow ?? true;
  mesh_vent_05_bulb_53.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_05_bulb_53.userData.sculptComponent = {"id": "vent-05-bulb", "name": "VentBulb05", "level": "meso", "role": "lamp-part", "importance": 0.65, "confidence": 0.85, "primitive": "sphere", "topologyClass": "assembled-solid", "parent": "vent-05", "attachment": {"parentId": "vent-05", "parentSocket": "lamp-post-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.14, "height": 0.14, "depth": 0.14, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0], "rotation": [0, 0, 0], "scale": [0.14, 0.14, 0.14]}, "material": "lamp-yellow", "evidenceRefs": ["full-object"], "topologyRationale": "Glowing yellow lamp ball on post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 224, 160, 1.0)", "secondaryAlbedo": "rgba(200, 176, 112, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "lamp-bulb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vent_05_bulb_53.add(mesh_vent_05_bulb_53);
  meshes["vent-05-bulb"] = mesh_vent_05_bulb_53;
  colliders["vent-05-bulb"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["lamp-bulb"] ??= [];
  destructionGroups["lamp-bulb"].push(node_vent_05_bulb_53);

  const attachment_wheel_front_b_54 = {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_front_b_54 = makeAttachmentEndpoint(attachment_wheel_front_b_54);
  const node_wheel_front_b_54 = new THREE.Group();
  node_wheel_front_b_54.name = "WheelFrontB__pivot";
  node_wheel_front_b_54.scale.set(1, 1, 1);
  if (endpoint_wheel_front_b_54) {
    node_wheel_front_b_54.position.copy(endpoint_wheel_front_b_54.start);
    node_wheel_front_b_54.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_front_b_54.position.set(-0.9, -0.15, 0.45);
    node_wheel_front_b_54.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_front_b_54.userData.sculptComponent = {"id": "wheel-front-b", "name": "WheelFrontB", "level": "meso", "role": "wheel", "importance": 0.7, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.42, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.9, -0.15, 0.45], "rotation": [1.5708, 0, 0], "scale": [0.42, 0.14, 0.42]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFront solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_b_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_front_b_54);
  nodes["wheel-front-b"] = node_wheel_front_b_54;
  const mesh_wheel_front_b_54Geometry = endpoint_wheel_front_b_54
    ? new THREE.CylinderGeometry(endpoint_wheel_front_b_54.endRadius, endpoint_wheel_front_b_54.baseRadius, endpoint_wheel_front_b_54.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_front_b_54) {
    mesh_wheel_front_b_54Geometry.scale(0.42, 0.14, 0.42);
  }
  const mesh_wheel_front_b_54 = new THREE.Mesh(
    mesh_wheel_front_b_54Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_b_54.name = "WheelFrontB";
  if (endpoint_wheel_front_b_54) {
    mesh_wheel_front_b_54.position.copy(endpoint_wheel_front_b_54.midpoint);
    mesh_wheel_front_b_54.quaternion.copy(endpoint_wheel_front_b_54.quaternion);
  }
  mesh_wheel_front_b_54.castShadow = options.castShadow ?? true;
  mesh_wheel_front_b_54.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_b_54.userData.sculptComponent = {"id": "wheel-front-b", "name": "WheelFrontB", "level": "meso", "role": "wheel", "importance": 0.7, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.42, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.9, -0.15, 0.45], "rotation": [1.5708, 0, 0], "scale": [0.42, 0.14, 0.42]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFront solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_b_54.add(mesh_wheel_front_b_54);
  meshes["wheel-front-b"] = mesh_wheel_front_b_54;
  colliders["wheel-front-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-front"] ??= [];
  destructionGroups["wheel-front"].push(node_wheel_front_b_54);

  const attachment_wheel_rear_b_55 = {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_rear_b_55 = makeAttachmentEndpoint(attachment_wheel_rear_b_55);
  const node_wheel_rear_b_55 = new THREE.Group();
  node_wheel_rear_b_55.name = "WheelRearB__pivot";
  node_wheel_rear_b_55.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_b_55) {
    node_wheel_rear_b_55.position.copy(endpoint_wheel_rear_b_55.start);
    node_wheel_rear_b_55.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_rear_b_55.position.set(0.9, -0.15, 0.45);
    node_wheel_rear_b_55.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_rear_b_55.userData.sculptComponent = {"id": "wheel-rear-b", "name": "WheelRearB", "level": "meso", "role": "wheel", "importance": 0.7, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.42, "units": "world", "confidence": 0.85}, "transform": {"position": [0.9, -0.15, 0.45], "rotation": [1.5708, 0, 0], "scale": [0.42, 0.14, 0.42]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRear solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_b_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_rear_b_55);
  nodes["wheel-rear-b"] = node_wheel_rear_b_55;
  const mesh_wheel_rear_b_55Geometry = endpoint_wheel_rear_b_55
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_b_55.endRadius, endpoint_wheel_rear_b_55.baseRadius, endpoint_wheel_rear_b_55.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_rear_b_55) {
    mesh_wheel_rear_b_55Geometry.scale(0.42, 0.14, 0.42);
  }
  const mesh_wheel_rear_b_55 = new THREE.Mesh(
    mesh_wheel_rear_b_55Geometry,
    materialMap["wheel-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_b_55.name = "WheelRearB";
  if (endpoint_wheel_rear_b_55) {
    mesh_wheel_rear_b_55.position.copy(endpoint_wheel_rear_b_55.midpoint);
    mesh_wheel_rear_b_55.quaternion.copy(endpoint_wheel_rear_b_55.quaternion);
  }
  mesh_wheel_rear_b_55.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_b_55.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_b_55.userData.sculptComponent = {"id": "wheel-rear-b", "name": "WheelRearB", "level": "meso", "role": "wheel", "importance": 0.7, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.42, "height": 0.14, "depth": 0.42, "units": "world", "confidence": 0.85}, "transform": {"position": [0.9, -0.15, 0.45], "rotation": [1.5708, 0, 0], "scale": [0.42, 0.14, 0.42]}, "material": "wheel-dark", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRear solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 34, 1.0)", "secondaryAlbedo": "rgba(20, 20, 24, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_b_55.add(mesh_wheel_rear_b_55);
  meshes["wheel-rear-b"] = mesh_wheel_rear_b_55;
  colliders["wheel-rear-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-rear"] ??= [];
  destructionGroups["wheel-rear"].push(node_wheel_rear_b_55);

  // repetition system: window-repeat (InstancedMesh, radial, count=4, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["starry-navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
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
    cluster.name = "window-repeat";
    parent.add(cluster);
  }

  // repetition system: vent-repeat (InstancedMesh, radial, count=5, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["starry-navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
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
    const cluster = new THREE.InstancedMesh(geo, mat, 5);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 5; i++) {
      const ang = ((0.0) + (i * 360) / 5) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "vent-repeat";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "minimumTextureResolution": 1024, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7}}};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createStarryCaravanLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Starry Caravan look-dev lights";
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
export function createStarryCaravanEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameStarryCaravanCamera(
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
export function createStarryCaravanPresentationComposer(
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

export function configureStarryCaravanRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createStarryCaravanInspectControls(
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
