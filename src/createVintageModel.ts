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

// Generated from ObjectSculptSpec target: Vintage Caravan
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createVintageCaravanModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Vintage Caravan";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.333, "orientation": {"yaw": -15, "pitch": 5, "roll": 0}, "positionHint": [3.0, 1.5, 4.0], "note": "Three-quarter front-left view, slightly elevated"}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["body-green"] = createSculptMaterial(
    "body-green",
    {"id": "body-green", "name": "Body Green", "type": "standard", "baseColor": "#2A4030", "roughness": {"base": 0.65, "variation": 0.12, "map": "body-green-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "paint-grain", "strength": 0.2, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "paint panel zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "weathering mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#2A4030"]}, "localOverrides": [{"zone": "default", "albedo": "#2A4030", "description": "uniform zone"}]},
    options
  );
  materialMap["roof-dark"] = createSculptMaterial(
    "roof-dark",
    {"id": "roof-dark", "name": "Roof Dark", "type": "standard", "baseColor": "#3A3530", "roughness": {"base": 0.8, "variation": 0.12, "map": "roof-dark-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "canvas-grain", "strength": 0.25, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "paint panel zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "weathering mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#3A3530"]}, "localOverrides": [{"zone": "default", "albedo": "#3A3530", "description": "uniform zone"}]},
    options
  );
  materialMap["trim-gold"] = createSculptMaterial(
    "trim-gold",
    {"id": "trim-gold", "name": "Trim Gold", "type": "standard", "baseColor": "#B8963E", "roughness": {"base": 0.35, "variation": 0.08, "map": "trim-gold-roughness-map"}, "metalness": {"base": 0.6}, "normal": {"pattern": "metal-worn", "strength": 0.15, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "paint panel zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "weathering mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#B8963E"]}, "localOverrides": [{"zone": "default", "albedo": "#B8963E", "description": "uniform zone"}]},
    options
  );
  materialMap["frame-brown"] = createSculptMaterial(
    "frame-brown",
    {"id": "frame-brown", "name": "Frame Brown", "type": "standard", "baseColor": "#6B4A32", "roughness": {"base": 0.6, "variation": 0.12, "map": "frame-brown-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "wood-grain", "strength": 0.3, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "paint panel zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "weathering mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#6B4A32"]}, "localOverrides": [{"zone": "default", "albedo": "#6B4A32", "description": "uniform zone"}]},
    options
  );
  materialMap["curtain-cream"] = createSculptMaterial(
    "curtain-cream",
    {"id": "curtain-cream", "name": "Curtain Cream", "type": "standard", "baseColor": "#E8E0CC", "roughness": {"base": 0.8, "variation": 0.12, "map": "curtain-cream-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "fabric-weave", "strength": 0.2, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "paint panel zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "weathering mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#E8E0CC"]}, "localOverrides": [{"zone": "default", "albedo": "#E8E0CC", "description": "uniform zone"}]},
    options
  );
  materialMap["iron-black"] = createSculptMaterial(
    "iron-black",
    {"id": "iron-black", "name": "Iron Black", "type": "standard", "baseColor": "#1E1E20", "roughness": {"base": 0.7, "variation": 0.12, "map": "iron-black-roughness-map"}, "metalness": {"base": 0.3}, "normal": {"pattern": "metal-worn", "strength": 0.2, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "paint panel zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "weathering mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#1E1E20"]}, "localOverrides": [{"zone": "default", "albedo": "#1E1E20", "description": "uniform zone"}]},
    options
  );
  materialMap["clerestory-dark"] = createSculptMaterial(
    "clerestory-dark",
    {"id": "clerestory-dark", "name": "Clerestory Dark", "type": "standard", "baseColor": "#4A3028", "roughness": {"base": 0.7, "variation": 0.12, "map": "clerestory-dark-roughness-map"}, "metalness": {"base": 0.0}, "normal": {"pattern": "subtle-grain", "strength": 0.15, "scale": 14.0}, "textureResolution": 1024, "textureProjection": {"mode": "box-projection", "texelDensity": "uniform world-space, 1024px per 3.0 world units", "repeat": [1, 1]}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.35, "pattern": "paint panel zones", "role": "color-zone variation"}, {"id": "meso", "frequency": 12, "amplitude": 0.2, "pattern": "weathering mottling", "role": "surface mottling"}, {"id": "micro", "frequency": 56, "amplitude": 0.08, "pattern": "paint grain", "role": "fine grain"}], "ambientOcclusion": {"cavityStrength": 0.25, "response": "cavity darkening via procedural AO map"}, "colorVariation": {"palette": ["#4A3028"]}, "localOverrides": [{"zone": "default", "albedo": "#4A3028", "description": "uniform zone"}]},
    options
  );

  
  // refine-code: 参考色板
  {
    const set = (id, color, extra) => {
      const m = materialMap[id] as THREE.MeshStandardMaterial | undefined;
      if (m) { m.color.set(color); m.map = null; if (extra) extra(m); m.needsUpdate = true; }
    };
    set("body-green", "#2E4434");
    set("roof-dark", "#3A3530");
    set("trim-gold", "#B8963E", (m) => { m.metalness = 0.6; m.roughness = 0.35; });
    set("frame-brown", "#6B4A32");
    set("curtain-cream", "#E8E0CC");
    set("iron-black", "#222226", (m) => { m.metalness = 0.3; });
    set("clerestory-dark", "#4A3028");
  }

const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_vintage_root_0 = null;
  const endpoint_vintage_root_0 = makeAttachmentEndpoint(attachment_vintage_root_0);
  const node_vintage_root_0 = new THREE.Group();
  node_vintage_root_0.name = "VintageCaravan__pivot";
  node_vintage_root_0.scale.set(1, 1, 1);
  if (endpoint_vintage_root_0) {
    node_vintage_root_0.position.copy(endpoint_vintage_root_0.start);
    node_vintage_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vintage_root_0.position.set(0.0, 0.0, 0.0);
    node_vintage_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_vintage_root_0.userData.sculptComponent = {"id": "vintage-root", "name": "VintageCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "body-green", "evidenceRefs": ["full-object"], "topologyRationale": "VintageCaravan solid geometry attached to None", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 64, 48, 1.0)", "secondaryAlbedo": "rgba(184, 150, 62, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vintage-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vintage_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vintage-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_vintage_root_0);
  nodes["vintage-root"] = node_vintage_root_0;
  const mesh_vintage_root_0Geometry = endpoint_vintage_root_0
    ? new THREE.CylinderGeometry(endpoint_vintage_root_0.endRadius, endpoint_vintage_root_0.baseRadius, endpoint_vintage_root_0.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_vintage_root_0) {
    mesh_vintage_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_vintage_root_0 = new THREE.Mesh(
    mesh_vintage_root_0Geometry,
    materialMap["body-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vintage_root_0.name = "VintageCaravan";
  if (endpoint_vintage_root_0) {
    mesh_vintage_root_0.position.copy(endpoint_vintage_root_0.midpoint);
    mesh_vintage_root_0.quaternion.copy(endpoint_vintage_root_0.quaternion);
  }
  mesh_vintage_root_0.castShadow = options.castShadow ?? true;
  mesh_vintage_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_vintage_root_0.visible = false; // 容器节点不渲染
  mesh_vintage_root_0.userData.sculptComponent = {"id": "vintage-root", "name": "VintageCaravan", "level": "macro", "role": "assembly-root", "importance": 1.0, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "body-green", "evidenceRefs": ["full-object"], "topologyRationale": "VintageCaravan solid geometry attached to None", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 64, 48, 1.0)", "secondaryAlbedo": "rgba(184, 150, 62, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "vintage-root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_vintage_root_0.add(mesh_vintage_root_0);
  meshes["vintage-root"] = mesh_vintage_root_0;
  colliders["vintage-root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["vintage-root"] ??= [];
  destructionGroups["vintage-root"].push(node_vintage_root_0);

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
  node_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.3, "depth": 1.4, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 1.15, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.3, 1.4]}, "material": "body-green", "evidenceRefs": ["full-object"], "topologyRationale": "Rectangular green body with gold trim lines around panels", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 64, 48, 1.0)", "secondaryAlbedo": "rgba(184, 150, 62, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "paint panel grain", "strength": 0.2, "scale": 8.0}, "roughnessVariation": {"pattern": "weathering variation", "amount": 0.12}}};
  node_body_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_body_1);
  nodes["body"] = node_body_1;
  const mesh_body_1Geometry = endpoint_body_1
    ? new THREE.CylinderGeometry(endpoint_body_1.endRadius, endpoint_body_1.baseRadius, endpoint_body_1.length, 32, 12)
    : new RoundedBoxGeometry(3.0, 1.3, 1.4, 3, 0.06);
  if (!endpoint_body_1) {
    mesh_body_1Geometry.scale(1, 1, 1); // 已是最终尺寸
  }
  const mesh_body_1 = new THREE.Mesh(
    mesh_body_1Geometry,
    materialMap["body-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_1.name = "Body";
  if (endpoint_body_1) {
    mesh_body_1.position.copy(endpoint_body_1.midpoint);
    mesh_body_1.quaternion.copy(endpoint_body_1.quaternion);
  }
  mesh_body_1.castShadow = options.castShadow ?? true;
  mesh_body_1.receiveShadow = options.receiveShadow ?? true;
  mesh_body_1.userData.sculptComponent = {"id": "body", "name": "Body", "level": "macro", "role": "main-volume", "importance": 0.95, "confidence": 0.92, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.0, "height": 1.3, "depth": 1.4, "units": "world", "confidence": 0.92}, "transform": {"position": [0, 1.15, 0], "rotation": [0, 0, 0], "scale": [3.0, 1.3, 1.4]}, "material": "body-green", "evidenceRefs": ["full-object"], "topologyRationale": "Rectangular green body with gold trim lines around panels", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 64, 48, 1.0)", "secondaryAlbedo": "rgba(184, 150, 62, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "surfaceDetail": {"normalBump": {"pattern": "paint panel grain", "strength": 0.2, "scale": 8.0}, "roughnessVariation": {"pattern": "weathering variation", "amount": 0.12}}};
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
    node_roof_2.position.set(0.0, 1.92, 0.0);
    node_roof_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_2.userData.sculptComponent = {"id": "roof", "name": "Roof", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.6, "height": 0.14, "depth": 1.8, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 1.92, 0], "rotation": [0, 0, 0], "scale": [3.6, 0.14, 1.8]}, "material": "roof-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Wide flat overhanging dark canvas roof", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 53, 48, 1.0)", "secondaryAlbedo": "rgba(42, 38, 34, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_roof_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_roof_2);
  nodes["roof"] = node_roof_2;
  const mesh_roof_2Geometry = endpoint_roof_2
    ? new THREE.CylinderGeometry(endpoint_roof_2.endRadius, endpoint_roof_2.baseRadius, endpoint_roof_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_roof_2) {
    mesh_roof_2Geometry.scale(3.6, 0.14, 1.8);
  }
  const mesh_roof_2 = new THREE.Mesh(
    mesh_roof_2Geometry,
    materialMap["roof-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_2.name = "Roof";
  if (endpoint_roof_2) {
    mesh_roof_2.position.copy(endpoint_roof_2.midpoint);
    mesh_roof_2.quaternion.copy(endpoint_roof_2.quaternion);
  }
  mesh_roof_2.castShadow = options.castShadow ?? true;
  mesh_roof_2.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_2.userData.sculptComponent = {"id": "roof", "name": "Roof", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.6, "height": 0.14, "depth": 1.8, "units": "world", "confidence": 0.9}, "transform": {"position": [0, 1.92, 0], "rotation": [0, 0, 0], "scale": [3.6, 0.14, 1.8]}, "material": "roof-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Wide flat overhanging dark canvas roof", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 53, 48, 1.0)", "secondaryAlbedo": "rgba(42, 38, 34, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_roof_2.add(mesh_roof_2);
  meshes["roof"] = mesh_roof_2;
  colliders["roof"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof"] ??= [];
  destructionGroups["roof"].push(node_roof_2);

  const endpoint_trim_top_3 = makeAttachmentEndpoint(null);
  const node_trim_top_3 = new THREE.Group();
  node_trim_top_3.name = "TrimTop__pivot";
  node_trim_top_3.scale.set(1, 1, 1);
  if (endpoint_trim_top_3) {
    node_trim_top_3.position.copy(endpoint_trim_top_3.start);
    node_trim_top_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_trim_top_3.position.set(0.0, 1.72, 0.0);
    node_trim_top_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_trim_top_3.userData.sculptComponent = {"id": "trim-top", "name": "TrimTop", "level": "meso", "role": "trim", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.02, "height": 0.03, "depth": 1.42, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.72, 0], "rotation": [0, 0, 0], "scale": [3.02, 0.03, 1.42]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "TrimTop solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "trim-top", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_trim_top_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "trim-top", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_trim_top_3);
  nodes["trim-top"] = node_trim_top_3;
  const mesh_trim_top_3Geometry = endpoint_trim_top_3
    ? new THREE.CylinderGeometry(endpoint_trim_top_3.endRadius, endpoint_trim_top_3.baseRadius, endpoint_trim_top_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_trim_top_3) {
    mesh_trim_top_3Geometry.scale(3.02, 0.03, 1.42);
  }
  const mesh_trim_top_3 = new THREE.Mesh(
    mesh_trim_top_3Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_trim_top_3.name = "TrimTop";
  if (endpoint_trim_top_3) {
    mesh_trim_top_3.position.copy(endpoint_trim_top_3.midpoint);
    mesh_trim_top_3.quaternion.copy(endpoint_trim_top_3.quaternion);
  }
  mesh_trim_top_3.castShadow = options.castShadow ?? true;
  mesh_trim_top_3.receiveShadow = options.receiveShadow ?? true;
  mesh_trim_top_3.userData.sculptComponent = {"id": "trim-top", "name": "TrimTop", "level": "meso", "role": "trim", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.02, "height": 0.03, "depth": 1.42, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.72, 0], "rotation": [0, 0, 0], "scale": [3.02, 0.03, 1.42]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "TrimTop solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "trim-top", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_trim_top_3.add(mesh_trim_top_3);
  meshes["trim-top"] = mesh_trim_top_3;
  colliders["trim-top"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["trim-top"] ??= [];
  destructionGroups["trim-top"].push(node_trim_top_3);

  const endpoint_trim_bottom_4 = makeAttachmentEndpoint(null);
  const node_trim_bottom_4 = new THREE.Group();
  node_trim_bottom_4.name = "TrimBottom__pivot";
  node_trim_bottom_4.scale.set(1, 1, 1);
  if (endpoint_trim_bottom_4) {
    node_trim_bottom_4.position.copy(endpoint_trim_bottom_4.start);
    node_trim_bottom_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_trim_bottom_4.position.set(0.0, 0.62, 0.0);
    node_trim_bottom_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_trim_bottom_4.userData.sculptComponent = {"id": "trim-bottom", "name": "TrimBottom", "level": "meso", "role": "trim", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.02, "height": 0.03, "depth": 1.42, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.62, 0], "rotation": [0, 0, 0], "scale": [3.02, 0.03, 1.42]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "TrimBottom solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "trim-bottom", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_trim_bottom_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "trim-bottom", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_trim_bottom_4);
  nodes["trim-bottom"] = node_trim_bottom_4;
  const mesh_trim_bottom_4Geometry = endpoint_trim_bottom_4
    ? new THREE.CylinderGeometry(endpoint_trim_bottom_4.endRadius, endpoint_trim_bottom_4.baseRadius, endpoint_trim_bottom_4.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_trim_bottom_4) {
    mesh_trim_bottom_4Geometry.scale(3.02, 0.03, 1.42);
  }
  const mesh_trim_bottom_4 = new THREE.Mesh(
    mesh_trim_bottom_4Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_trim_bottom_4.name = "TrimBottom";
  if (endpoint_trim_bottom_4) {
    mesh_trim_bottom_4.position.copy(endpoint_trim_bottom_4.midpoint);
    mesh_trim_bottom_4.quaternion.copy(endpoint_trim_bottom_4.quaternion);
  }
  mesh_trim_bottom_4.castShadow = options.castShadow ?? true;
  mesh_trim_bottom_4.receiveShadow = options.receiveShadow ?? true;
  mesh_trim_bottom_4.userData.sculptComponent = {"id": "trim-bottom", "name": "TrimBottom", "level": "meso", "role": "trim", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.02, "height": 0.03, "depth": 1.42, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.62, 0], "rotation": [0, 0, 0], "scale": [3.02, 0.03, 1.42]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "TrimBottom solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "trim-bottom", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_trim_bottom_4.add(mesh_trim_bottom_4);
  meshes["trim-bottom"] = mesh_trim_bottom_4;
  colliders["trim-bottom"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["trim-bottom"] ??= [];
  destructionGroups["trim-bottom"].push(node_trim_bottom_4);

  const endpoint_roof_deck_5 = makeAttachmentEndpoint(null);
  const node_roof_deck_5 = new THREE.Group();
  node_roof_deck_5.name = "RoofDeck__pivot";
  node_roof_deck_5.scale.set(1, 1, 1);
  if (endpoint_roof_deck_5) {
    node_roof_deck_5.position.copy(endpoint_roof_deck_5.start);
    node_roof_deck_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_deck_5.position.set(0.0, 2.05, 0.0);
    node_roof_deck_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_deck_5.userData.sculptComponent = {"id": "roof-deck", "name": "RoofDeck", "level": "meso", "role": "deck", "importance": 0.8, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 2.4, "height": 0.06, "depth": 1.2, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 2.05, 0], "rotation": [0, 0, 0], "scale": [2.4, 0.06, 1.2]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Observation deck platform on roof", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_roof_deck_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_roof_deck_5);
  nodes["roof-deck"] = node_roof_deck_5;
  const mesh_roof_deck_5Geometry = endpoint_roof_deck_5
    ? new THREE.CylinderGeometry(endpoint_roof_deck_5.endRadius, endpoint_roof_deck_5.baseRadius, endpoint_roof_deck_5.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_roof_deck_5) {
    mesh_roof_deck_5Geometry.scale(2.4, 0.06, 1.2);
  }
  const mesh_roof_deck_5 = new THREE.Mesh(
    mesh_roof_deck_5Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_deck_5.name = "RoofDeck";
  if (endpoint_roof_deck_5) {
    mesh_roof_deck_5.position.copy(endpoint_roof_deck_5.midpoint);
    mesh_roof_deck_5.quaternion.copy(endpoint_roof_deck_5.quaternion);
  }
  mesh_roof_deck_5.castShadow = options.castShadow ?? true;
  mesh_roof_deck_5.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_deck_5.userData.sculptComponent = {"id": "roof-deck", "name": "RoofDeck", "level": "meso", "role": "deck", "importance": 0.8, "confidence": 0.88, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 2.4, "height": 0.06, "depth": 1.2, "units": "world", "confidence": 0.88}, "transform": {"position": [0, 2.05, 0], "rotation": [0, 0, 0], "scale": [2.4, 0.06, 1.2]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Observation deck platform on roof", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_roof_deck_5.add(mesh_roof_deck_5);
  meshes["roof-deck"] = mesh_roof_deck_5;
  colliders["roof-deck"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_roof_deck_5);

  const endpoint_deck_rail_left_6 = makeAttachmentEndpoint(null);
  const node_deck_rail_left_6 = new THREE.Group();
  node_deck_rail_left_6.name = "DeckRailLeft__pivot";
  node_deck_rail_left_6.scale.set(1, 1, 1);
  if (endpoint_deck_rail_left_6) {
    node_deck_rail_left_6.position.copy(endpoint_deck_rail_left_6.start);
    node_deck_rail_left_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_deck_rail_left_6.position.set(0.0, 0.22, -0.58);
    node_deck_rail_left_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_deck_rail_left_6.userData.sculptComponent = {"id": "deck-rail-left", "name": "DeckRailLeft", "level": "meso", "role": "railing", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 2.4, "height": 0.04, "depth": 0.04, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, -0.58], "rotation": [0, 0, 0], "scale": [2.4, 0.04, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckRailLeft solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-rail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_rail_left_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-rail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["roof-deck"] ?? root).add(node_deck_rail_left_6);
  nodes["deck-rail-left"] = node_deck_rail_left_6;
  const mesh_deck_rail_left_6Geometry = endpoint_deck_rail_left_6
    ? new THREE.CylinderGeometry(endpoint_deck_rail_left_6.endRadius, endpoint_deck_rail_left_6.baseRadius, endpoint_deck_rail_left_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_deck_rail_left_6) {
    mesh_deck_rail_left_6Geometry.scale(2.4, 0.04, 0.04);
  }
  const mesh_deck_rail_left_6 = new THREE.Mesh(
    mesh_deck_rail_left_6Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_deck_rail_left_6.name = "DeckRailLeft";
  if (endpoint_deck_rail_left_6) {
    mesh_deck_rail_left_6.position.copy(endpoint_deck_rail_left_6.midpoint);
    mesh_deck_rail_left_6.quaternion.copy(endpoint_deck_rail_left_6.quaternion);
  }
  mesh_deck_rail_left_6.castShadow = options.castShadow ?? true;
  mesh_deck_rail_left_6.receiveShadow = options.receiveShadow ?? true;
  mesh_deck_rail_left_6.userData.sculptComponent = {"id": "deck-rail-left", "name": "DeckRailLeft", "level": "meso", "role": "railing", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 2.4, "height": 0.04, "depth": 0.04, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, -0.58], "rotation": [0, 0, 0], "scale": [2.4, 0.04, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckRailLeft solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-rail-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_rail_left_6.add(mesh_deck_rail_left_6);
  meshes["deck-rail-left"] = mesh_deck_rail_left_6;
  colliders["deck-rail-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["deck-rail-left"] ??= [];
  destructionGroups["deck-rail-left"].push(node_deck_rail_left_6);

  const endpoint_deck_rail_right_7 = makeAttachmentEndpoint(null);
  const node_deck_rail_right_7 = new THREE.Group();
  node_deck_rail_right_7.name = "DeckRailRight__pivot";
  node_deck_rail_right_7.scale.set(1, 1, 1);
  if (endpoint_deck_rail_right_7) {
    node_deck_rail_right_7.position.copy(endpoint_deck_rail_right_7.start);
    node_deck_rail_right_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_deck_rail_right_7.position.set(0.0, 0.22, 0.58);
    node_deck_rail_right_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_deck_rail_right_7.userData.sculptComponent = {"id": "deck-rail-right", "name": "DeckRailRight", "level": "meso", "role": "railing", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 2.4, "height": 0.04, "depth": 0.04, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0.58], "rotation": [0, 0, 0], "scale": [2.4, 0.04, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckRailRight solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-rail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_rail_right_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-rail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["roof-deck"] ?? root).add(node_deck_rail_right_7);
  nodes["deck-rail-right"] = node_deck_rail_right_7;
  const mesh_deck_rail_right_7Geometry = endpoint_deck_rail_right_7
    ? new THREE.CylinderGeometry(endpoint_deck_rail_right_7.endRadius, endpoint_deck_rail_right_7.baseRadius, endpoint_deck_rail_right_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_deck_rail_right_7) {
    mesh_deck_rail_right_7Geometry.scale(2.4, 0.04, 0.04);
  }
  const mesh_deck_rail_right_7 = new THREE.Mesh(
    mesh_deck_rail_right_7Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_deck_rail_right_7.name = "DeckRailRight";
  if (endpoint_deck_rail_right_7) {
    mesh_deck_rail_right_7.position.copy(endpoint_deck_rail_right_7.midpoint);
    mesh_deck_rail_right_7.quaternion.copy(endpoint_deck_rail_right_7.quaternion);
  }
  mesh_deck_rail_right_7.castShadow = options.castShadow ?? true;
  mesh_deck_rail_right_7.receiveShadow = options.receiveShadow ?? true;
  mesh_deck_rail_right_7.userData.sculptComponent = {"id": "deck-rail-right", "name": "DeckRailRight", "level": "meso", "role": "railing", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 2.4, "height": 0.04, "depth": 0.04, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.22, 0.58], "rotation": [0, 0, 0], "scale": [2.4, 0.04, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckRailRight solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-rail-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_rail_right_7.add(mesh_deck_rail_right_7);
  meshes["deck-rail-right"] = mesh_deck_rail_right_7;
  colliders["deck-rail-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["deck-rail-right"] ??= [];
  destructionGroups["deck-rail-right"].push(node_deck_rail_right_7);

  const endpoint_deck_post_0__0_58_8 = makeAttachmentEndpoint(null);
  const node_deck_post_0__0_58_8 = new THREE.Group();
  node_deck_post_0__0_58_8.name = "DeckPost0-0.58__pivot";
  node_deck_post_0__0_58_8.scale.set(1, 1, 1);
  if (endpoint_deck_post_0__0_58_8) {
    node_deck_post_0__0_58_8.position.copy(endpoint_deck_post_0__0_58_8.start);
    node_deck_post_0__0_58_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_deck_post_0__0_58_8.position.set(-1.15, 0.11, -0.58);
    node_deck_post_0__0_58_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_deck_post_0__0_58_8.userData.sculptComponent = {"id": "deck-post-0--0.58", "name": "DeckPost0-0.58", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.22, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.15, 0.11, -0.58], "rotation": [0, 0, 0], "scale": [0.04, 0.22, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckPost0-0.58 solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-0--0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_post_0__0_58_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-0--0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["roof-deck"] ?? root).add(node_deck_post_0__0_58_8);
  nodes["deck-post-0--0.58"] = node_deck_post_0__0_58_8;
  const mesh_deck_post_0__0_58_8Geometry = endpoint_deck_post_0__0_58_8
    ? new THREE.CylinderGeometry(endpoint_deck_post_0__0_58_8.endRadius, endpoint_deck_post_0__0_58_8.baseRadius, endpoint_deck_post_0__0_58_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_deck_post_0__0_58_8) {
    mesh_deck_post_0__0_58_8Geometry.scale(0.04, 0.22, 0.04);
  }
  const mesh_deck_post_0__0_58_8 = new THREE.Mesh(
    mesh_deck_post_0__0_58_8Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_deck_post_0__0_58_8.name = "DeckPost0-0.58";
  if (endpoint_deck_post_0__0_58_8) {
    mesh_deck_post_0__0_58_8.position.copy(endpoint_deck_post_0__0_58_8.midpoint);
    mesh_deck_post_0__0_58_8.quaternion.copy(endpoint_deck_post_0__0_58_8.quaternion);
  }
  mesh_deck_post_0__0_58_8.castShadow = options.castShadow ?? true;
  mesh_deck_post_0__0_58_8.receiveShadow = options.receiveShadow ?? true;
  mesh_deck_post_0__0_58_8.userData.sculptComponent = {"id": "deck-post-0--0.58", "name": "DeckPost0-0.58", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.22, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.15, 0.11, -0.58], "rotation": [0, 0, 0], "scale": [0.04, 0.22, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckPost0-0.58 solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-0--0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_post_0__0_58_8.add(mesh_deck_post_0__0_58_8);
  meshes["deck-post-0--0.58"] = mesh_deck_post_0__0_58_8;
  colliders["deck-post-0--0.58"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["deck-post-0--0.58"] ??= [];
  destructionGroups["deck-post-0--0.58"].push(node_deck_post_0__0_58_8);

  const endpoint_deck_post_0_0_58_9 = makeAttachmentEndpoint(null);
  const node_deck_post_0_0_58_9 = new THREE.Group();
  node_deck_post_0_0_58_9.name = "DeckPost00.58__pivot";
  node_deck_post_0_0_58_9.scale.set(1, 1, 1);
  if (endpoint_deck_post_0_0_58_9) {
    node_deck_post_0_0_58_9.position.copy(endpoint_deck_post_0_0_58_9.start);
    node_deck_post_0_0_58_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_deck_post_0_0_58_9.position.set(-1.15, 0.11, 0.58);
    node_deck_post_0_0_58_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_deck_post_0_0_58_9.userData.sculptComponent = {"id": "deck-post-0-0.58", "name": "DeckPost00.58", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.22, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.15, 0.11, 0.58], "rotation": [0, 0, 0], "scale": [0.04, 0.22, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckPost00.58 solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-0-0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_post_0_0_58_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-0-0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["roof-deck"] ?? root).add(node_deck_post_0_0_58_9);
  nodes["deck-post-0-0.58"] = node_deck_post_0_0_58_9;
  const mesh_deck_post_0_0_58_9Geometry = endpoint_deck_post_0_0_58_9
    ? new THREE.CylinderGeometry(endpoint_deck_post_0_0_58_9.endRadius, endpoint_deck_post_0_0_58_9.baseRadius, endpoint_deck_post_0_0_58_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_deck_post_0_0_58_9) {
    mesh_deck_post_0_0_58_9Geometry.scale(0.04, 0.22, 0.04);
  }
  const mesh_deck_post_0_0_58_9 = new THREE.Mesh(
    mesh_deck_post_0_0_58_9Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_deck_post_0_0_58_9.name = "DeckPost00.58";
  if (endpoint_deck_post_0_0_58_9) {
    mesh_deck_post_0_0_58_9.position.copy(endpoint_deck_post_0_0_58_9.midpoint);
    mesh_deck_post_0_0_58_9.quaternion.copy(endpoint_deck_post_0_0_58_9.quaternion);
  }
  mesh_deck_post_0_0_58_9.castShadow = options.castShadow ?? true;
  mesh_deck_post_0_0_58_9.receiveShadow = options.receiveShadow ?? true;
  mesh_deck_post_0_0_58_9.userData.sculptComponent = {"id": "deck-post-0-0.58", "name": "DeckPost00.58", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.22, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.15, 0.11, 0.58], "rotation": [0, 0, 0], "scale": [0.04, 0.22, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckPost00.58 solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-0-0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_post_0_0_58_9.add(mesh_deck_post_0_0_58_9);
  meshes["deck-post-0-0.58"] = mesh_deck_post_0_0_58_9;
  colliders["deck-post-0-0.58"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["deck-post-0-0.58"] ??= [];
  destructionGroups["deck-post-0-0.58"].push(node_deck_post_0_0_58_9);

  const endpoint_deck_post_1__0_58_10 = makeAttachmentEndpoint(null);
  const node_deck_post_1__0_58_10 = new THREE.Group();
  node_deck_post_1__0_58_10.name = "DeckPost1-0.58__pivot";
  node_deck_post_1__0_58_10.scale.set(1, 1, 1);
  if (endpoint_deck_post_1__0_58_10) {
    node_deck_post_1__0_58_10.position.copy(endpoint_deck_post_1__0_58_10.start);
    node_deck_post_1__0_58_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_deck_post_1__0_58_10.position.set(1.15, 0.11, -0.58);
    node_deck_post_1__0_58_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_deck_post_1__0_58_10.userData.sculptComponent = {"id": "deck-post-1--0.58", "name": "DeckPost1-0.58", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.22, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [1.15, 0.11, -0.58], "rotation": [0, 0, 0], "scale": [0.04, 0.22, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckPost1-0.58 solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-1--0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_post_1__0_58_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-1--0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["roof-deck"] ?? root).add(node_deck_post_1__0_58_10);
  nodes["deck-post-1--0.58"] = node_deck_post_1__0_58_10;
  const mesh_deck_post_1__0_58_10Geometry = endpoint_deck_post_1__0_58_10
    ? new THREE.CylinderGeometry(endpoint_deck_post_1__0_58_10.endRadius, endpoint_deck_post_1__0_58_10.baseRadius, endpoint_deck_post_1__0_58_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_deck_post_1__0_58_10) {
    mesh_deck_post_1__0_58_10Geometry.scale(0.04, 0.22, 0.04);
  }
  const mesh_deck_post_1__0_58_10 = new THREE.Mesh(
    mesh_deck_post_1__0_58_10Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_deck_post_1__0_58_10.name = "DeckPost1-0.58";
  if (endpoint_deck_post_1__0_58_10) {
    mesh_deck_post_1__0_58_10.position.copy(endpoint_deck_post_1__0_58_10.midpoint);
    mesh_deck_post_1__0_58_10.quaternion.copy(endpoint_deck_post_1__0_58_10.quaternion);
  }
  mesh_deck_post_1__0_58_10.castShadow = options.castShadow ?? true;
  mesh_deck_post_1__0_58_10.receiveShadow = options.receiveShadow ?? true;
  mesh_deck_post_1__0_58_10.userData.sculptComponent = {"id": "deck-post-1--0.58", "name": "DeckPost1-0.58", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.22, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [1.15, 0.11, -0.58], "rotation": [0, 0, 0], "scale": [0.04, 0.22, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckPost1-0.58 solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-1--0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_post_1__0_58_10.add(mesh_deck_post_1__0_58_10);
  meshes["deck-post-1--0.58"] = mesh_deck_post_1__0_58_10;
  colliders["deck-post-1--0.58"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["deck-post-1--0.58"] ??= [];
  destructionGroups["deck-post-1--0.58"].push(node_deck_post_1__0_58_10);

  const endpoint_deck_post_1_0_58_11 = makeAttachmentEndpoint(null);
  const node_deck_post_1_0_58_11 = new THREE.Group();
  node_deck_post_1_0_58_11.name = "DeckPost10.58__pivot";
  node_deck_post_1_0_58_11.scale.set(1, 1, 1);
  if (endpoint_deck_post_1_0_58_11) {
    node_deck_post_1_0_58_11.position.copy(endpoint_deck_post_1_0_58_11.start);
    node_deck_post_1_0_58_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_deck_post_1_0_58_11.position.set(1.15, 0.11, 0.58);
    node_deck_post_1_0_58_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_deck_post_1_0_58_11.userData.sculptComponent = {"id": "deck-post-1-0.58", "name": "DeckPost10.58", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.22, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [1.15, 0.11, 0.58], "rotation": [0, 0, 0], "scale": [0.04, 0.22, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckPost10.58 solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-1-0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_post_1_0_58_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-1-0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["roof-deck"] ?? root).add(node_deck_post_1_0_58_11);
  nodes["deck-post-1-0.58"] = node_deck_post_1_0_58_11;
  const mesh_deck_post_1_0_58_11Geometry = endpoint_deck_post_1_0_58_11
    ? new THREE.CylinderGeometry(endpoint_deck_post_1_0_58_11.endRadius, endpoint_deck_post_1_0_58_11.baseRadius, endpoint_deck_post_1_0_58_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_deck_post_1_0_58_11) {
    mesh_deck_post_1_0_58_11Geometry.scale(0.04, 0.22, 0.04);
  }
  const mesh_deck_post_1_0_58_11 = new THREE.Mesh(
    mesh_deck_post_1_0_58_11Geometry,
    materialMap["trim-gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_deck_post_1_0_58_11.name = "DeckPost10.58";
  if (endpoint_deck_post_1_0_58_11) {
    mesh_deck_post_1_0_58_11.position.copy(endpoint_deck_post_1_0_58_11.midpoint);
    mesh_deck_post_1_0_58_11.quaternion.copy(endpoint_deck_post_1_0_58_11.quaternion);
  }
  mesh_deck_post_1_0_58_11.castShadow = options.castShadow ?? true;
  mesh_deck_post_1_0_58_11.receiveShadow = options.receiveShadow ?? true;
  mesh_deck_post_1_0_58_11.userData.sculptComponent = {"id": "deck-post-1-0.58", "name": "DeckPost10.58", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "roof-deck", "attachment": {"parentId": "roof-deck", "parentSocket": "roof-deck-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.22, "depth": 0.04, "units": "world", "confidence": 0.8}, "transform": {"position": [1.15, 0.11, 0.58], "rotation": [0, 0, 0], "scale": [0.04, 0.22, 0.04]}, "material": "trim-gold", "evidenceRefs": ["full-object"], "topologyRationale": "DeckPost10.58 solid geometry attached to roof-deck", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 150, 62, 1.0)", "secondaryAlbedo": "rgba(138, 112, 48, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "deck-post-1-0.58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_deck_post_1_0_58_11.add(mesh_deck_post_1_0_58_11);
  meshes["deck-post-1-0.58"] = mesh_deck_post_1_0_58_11;
  colliders["deck-post-1-0.58"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["deck-post-1-0.58"] ??= [];
  destructionGroups["deck-post-1-0.58"].push(node_deck_post_1_0_58_11);

  const endpoint_clerestory_strip_12 = makeAttachmentEndpoint(null);
  const node_clerestory_strip_12 = new THREE.Group();
  node_clerestory_strip_12.name = "ClerestoryStrip__pivot";
  node_clerestory_strip_12.scale.set(1, 1, 1);
  if (endpoint_clerestory_strip_12) {
    node_clerestory_strip_12.position.copy(endpoint_clerestory_strip_12.start);
    node_clerestory_strip_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_clerestory_strip_12.position.set(0.0, 1.78, 0.0);
    node_clerestory_strip_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_clerestory_strip_12.userData.sculptComponent = {"id": "clerestory-strip", "name": "ClerestoryStrip", "level": "meso", "role": "clerestory", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 2.9, "height": 0.16, "depth": 1.3, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.78, 0], "rotation": [0, 0, 0], "scale": [2.9, 0.16, 1.3]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "ClerestoryStrip solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-strip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_strip_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-strip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_clerestory_strip_12);
  nodes["clerestory-strip"] = node_clerestory_strip_12;
  const mesh_clerestory_strip_12Geometry = endpoint_clerestory_strip_12
    ? new THREE.CylinderGeometry(endpoint_clerestory_strip_12.endRadius, endpoint_clerestory_strip_12.baseRadius, endpoint_clerestory_strip_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_clerestory_strip_12) {
    mesh_clerestory_strip_12Geometry.scale(2.9, 0.16, 1.3);
  }
  const mesh_clerestory_strip_12 = new THREE.Mesh(
    mesh_clerestory_strip_12Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clerestory_strip_12.name = "ClerestoryStrip";
  if (endpoint_clerestory_strip_12) {
    mesh_clerestory_strip_12.position.copy(endpoint_clerestory_strip_12.midpoint);
    mesh_clerestory_strip_12.quaternion.copy(endpoint_clerestory_strip_12.quaternion);
  }
  mesh_clerestory_strip_12.castShadow = options.castShadow ?? true;
  mesh_clerestory_strip_12.receiveShadow = options.receiveShadow ?? true;
  mesh_clerestory_strip_12.userData.sculptComponent = {"id": "clerestory-strip", "name": "ClerestoryStrip", "level": "meso", "role": "clerestory", "importance": 0.6, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 2.9, "height": 0.16, "depth": 1.3, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.78, 0], "rotation": [0, 0, 0], "scale": [2.9, 0.16, 1.3]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "ClerestoryStrip solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-strip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_strip_12.add(mesh_clerestory_strip_12);
  meshes["clerestory-strip"] = mesh_clerestory_strip_12;
  colliders["clerestory-strip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["clerestory-strip"] ??= [];
  destructionGroups["clerestory-strip"].push(node_clerestory_strip_12);

  const endpoint_clerestory_01_13 = makeAttachmentEndpoint(null);
  const node_clerestory_01_13 = new THREE.Group();
  node_clerestory_01_13.name = "Clerestory01__pivot";
  node_clerestory_01_13.scale.set(1, 1, 1);
  if (endpoint_clerestory_01_13) {
    node_clerestory_01_13.position.copy(endpoint_clerestory_01_13.start);
    node_clerestory_01_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_clerestory_01_13.position.set(-1.1, 0.0, 0.0);
    node_clerestory_01_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_clerestory_01_13.userData.sculptComponent = {"id": "clerestory-01", "name": "Clerestory01", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.1, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory01 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_01_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["clerestory-strip"] ?? root).add(node_clerestory_01_13);
  nodes["clerestory-01"] = node_clerestory_01_13;
  const mesh_clerestory_01_13Geometry = endpoint_clerestory_01_13
    ? new THREE.CylinderGeometry(endpoint_clerestory_01_13.endRadius, endpoint_clerestory_01_13.baseRadius, endpoint_clerestory_01_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_clerestory_01_13) {
    mesh_clerestory_01_13Geometry.scale(0.4, 0.12, 1.32);
  }
  const mesh_clerestory_01_13 = new THREE.Mesh(
    mesh_clerestory_01_13Geometry,
    materialMap["clerestory-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clerestory_01_13.name = "Clerestory01";
  if (endpoint_clerestory_01_13) {
    mesh_clerestory_01_13.position.copy(endpoint_clerestory_01_13.midpoint);
    mesh_clerestory_01_13.quaternion.copy(endpoint_clerestory_01_13.quaternion);
  }
  mesh_clerestory_01_13.castShadow = options.castShadow ?? true;
  mesh_clerestory_01_13.receiveShadow = options.receiveShadow ?? true;
  mesh_clerestory_01_13.userData.sculptComponent = {"id": "clerestory-01", "name": "Clerestory01", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [-1.1, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory01 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_01_13.add(mesh_clerestory_01_13);
  meshes["clerestory-01"] = mesh_clerestory_01_13;
  colliders["clerestory-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["clerestory-01"] ??= [];
  destructionGroups["clerestory-01"].push(node_clerestory_01_13);

  const endpoint_clerestory_02_14 = makeAttachmentEndpoint(null);
  const node_clerestory_02_14 = new THREE.Group();
  node_clerestory_02_14.name = "Clerestory02__pivot";
  node_clerestory_02_14.scale.set(1, 1, 1);
  if (endpoint_clerestory_02_14) {
    node_clerestory_02_14.position.copy(endpoint_clerestory_02_14.start);
    node_clerestory_02_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_clerestory_02_14.position.set(-0.55, 0.0, 0.0);
    node_clerestory_02_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_clerestory_02_14.userData.sculptComponent = {"id": "clerestory-02", "name": "Clerestory02", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.55, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory02 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_02_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["clerestory-strip"] ?? root).add(node_clerestory_02_14);
  nodes["clerestory-02"] = node_clerestory_02_14;
  const mesh_clerestory_02_14Geometry = endpoint_clerestory_02_14
    ? new THREE.CylinderGeometry(endpoint_clerestory_02_14.endRadius, endpoint_clerestory_02_14.baseRadius, endpoint_clerestory_02_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_clerestory_02_14) {
    mesh_clerestory_02_14Geometry.scale(0.4, 0.12, 1.32);
  }
  const mesh_clerestory_02_14 = new THREE.Mesh(
    mesh_clerestory_02_14Geometry,
    materialMap["clerestory-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clerestory_02_14.name = "Clerestory02";
  if (endpoint_clerestory_02_14) {
    mesh_clerestory_02_14.position.copy(endpoint_clerestory_02_14.midpoint);
    mesh_clerestory_02_14.quaternion.copy(endpoint_clerestory_02_14.quaternion);
  }
  mesh_clerestory_02_14.castShadow = options.castShadow ?? true;
  mesh_clerestory_02_14.receiveShadow = options.receiveShadow ?? true;
  mesh_clerestory_02_14.userData.sculptComponent = {"id": "clerestory-02", "name": "Clerestory02", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.55, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory02 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_02_14.add(mesh_clerestory_02_14);
  meshes["clerestory-02"] = mesh_clerestory_02_14;
  colliders["clerestory-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["clerestory-02"] ??= [];
  destructionGroups["clerestory-02"].push(node_clerestory_02_14);

  const endpoint_clerestory_03_15 = makeAttachmentEndpoint(null);
  const node_clerestory_03_15 = new THREE.Group();
  node_clerestory_03_15.name = "Clerestory03__pivot";
  node_clerestory_03_15.scale.set(1, 1, 1);
  if (endpoint_clerestory_03_15) {
    node_clerestory_03_15.position.copy(endpoint_clerestory_03_15.start);
    node_clerestory_03_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_clerestory_03_15.position.set(0.0, 0.0, 0.0);
    node_clerestory_03_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_clerestory_03_15.userData.sculptComponent = {"id": "clerestory-03", "name": "Clerestory03", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [0.0, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory03 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_03_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["clerestory-strip"] ?? root).add(node_clerestory_03_15);
  nodes["clerestory-03"] = node_clerestory_03_15;
  const mesh_clerestory_03_15Geometry = endpoint_clerestory_03_15
    ? new THREE.CylinderGeometry(endpoint_clerestory_03_15.endRadius, endpoint_clerestory_03_15.baseRadius, endpoint_clerestory_03_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_clerestory_03_15) {
    mesh_clerestory_03_15Geometry.scale(0.4, 0.12, 1.32);
  }
  const mesh_clerestory_03_15 = new THREE.Mesh(
    mesh_clerestory_03_15Geometry,
    materialMap["clerestory-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clerestory_03_15.name = "Clerestory03";
  if (endpoint_clerestory_03_15) {
    mesh_clerestory_03_15.position.copy(endpoint_clerestory_03_15.midpoint);
    mesh_clerestory_03_15.quaternion.copy(endpoint_clerestory_03_15.quaternion);
  }
  mesh_clerestory_03_15.castShadow = options.castShadow ?? true;
  mesh_clerestory_03_15.receiveShadow = options.receiveShadow ?? true;
  mesh_clerestory_03_15.userData.sculptComponent = {"id": "clerestory-03", "name": "Clerestory03", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [0.0, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory03 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_03_15.add(mesh_clerestory_03_15);
  meshes["clerestory-03"] = mesh_clerestory_03_15;
  colliders["clerestory-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["clerestory-03"] ??= [];
  destructionGroups["clerestory-03"].push(node_clerestory_03_15);

  const endpoint_clerestory_04_16 = makeAttachmentEndpoint(null);
  const node_clerestory_04_16 = new THREE.Group();
  node_clerestory_04_16.name = "Clerestory04__pivot";
  node_clerestory_04_16.scale.set(1, 1, 1);
  if (endpoint_clerestory_04_16) {
    node_clerestory_04_16.position.copy(endpoint_clerestory_04_16.start);
    node_clerestory_04_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_clerestory_04_16.position.set(0.55, 0.0, 0.0);
    node_clerestory_04_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_clerestory_04_16.userData.sculptComponent = {"id": "clerestory-04", "name": "Clerestory04", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [0.55, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory04 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_04_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["clerestory-strip"] ?? root).add(node_clerestory_04_16);
  nodes["clerestory-04"] = node_clerestory_04_16;
  const mesh_clerestory_04_16Geometry = endpoint_clerestory_04_16
    ? new THREE.CylinderGeometry(endpoint_clerestory_04_16.endRadius, endpoint_clerestory_04_16.baseRadius, endpoint_clerestory_04_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_clerestory_04_16) {
    mesh_clerestory_04_16Geometry.scale(0.4, 0.12, 1.32);
  }
  const mesh_clerestory_04_16 = new THREE.Mesh(
    mesh_clerestory_04_16Geometry,
    materialMap["clerestory-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clerestory_04_16.name = "Clerestory04";
  if (endpoint_clerestory_04_16) {
    mesh_clerestory_04_16.position.copy(endpoint_clerestory_04_16.midpoint);
    mesh_clerestory_04_16.quaternion.copy(endpoint_clerestory_04_16.quaternion);
  }
  mesh_clerestory_04_16.castShadow = options.castShadow ?? true;
  mesh_clerestory_04_16.receiveShadow = options.receiveShadow ?? true;
  mesh_clerestory_04_16.userData.sculptComponent = {"id": "clerestory-04", "name": "Clerestory04", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [0.55, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory04 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_04_16.add(mesh_clerestory_04_16);
  meshes["clerestory-04"] = mesh_clerestory_04_16;
  colliders["clerestory-04"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["clerestory-04"] ??= [];
  destructionGroups["clerestory-04"].push(node_clerestory_04_16);

  const endpoint_clerestory_05_17 = makeAttachmentEndpoint(null);
  const node_clerestory_05_17 = new THREE.Group();
  node_clerestory_05_17.name = "Clerestory05__pivot";
  node_clerestory_05_17.scale.set(1, 1, 1);
  if (endpoint_clerestory_05_17) {
    node_clerestory_05_17.position.copy(endpoint_clerestory_05_17.start);
    node_clerestory_05_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_clerestory_05_17.position.set(1.1, 0.0, 0.0);
    node_clerestory_05_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_clerestory_05_17.userData.sculptComponent = {"id": "clerestory-05", "name": "Clerestory05", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [1.1, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory05 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_05_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["clerestory-strip"] ?? root).add(node_clerestory_05_17);
  nodes["clerestory-05"] = node_clerestory_05_17;
  const mesh_clerestory_05_17Geometry = endpoint_clerestory_05_17
    ? new THREE.CylinderGeometry(endpoint_clerestory_05_17.endRadius, endpoint_clerestory_05_17.baseRadius, endpoint_clerestory_05_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_clerestory_05_17) {
    mesh_clerestory_05_17Geometry.scale(0.4, 0.12, 1.32);
  }
  const mesh_clerestory_05_17 = new THREE.Mesh(
    mesh_clerestory_05_17Geometry,
    materialMap["clerestory-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clerestory_05_17.name = "Clerestory05";
  if (endpoint_clerestory_05_17) {
    mesh_clerestory_05_17.position.copy(endpoint_clerestory_05_17.midpoint);
    mesh_clerestory_05_17.quaternion.copy(endpoint_clerestory_05_17.quaternion);
  }
  mesh_clerestory_05_17.castShadow = options.castShadow ?? true;
  mesh_clerestory_05_17.receiveShadow = options.receiveShadow ?? true;
  mesh_clerestory_05_17.userData.sculptComponent = {"id": "clerestory-05", "name": "Clerestory05", "level": "meso", "role": "clerestory-window", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "clerestory-strip", "attachment": {"parentId": "clerestory-strip", "parentSocket": "clerestory-strip-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.12, "depth": 1.32, "units": "world", "confidence": 0.8}, "transform": {"position": [1.1, 0, 0], "rotation": [0, 0, 0], "scale": [0.4, 0.12, 1.32]}, "material": "clerestory-dark", "evidenceRefs": ["full-object"], "topologyRationale": "Clerestory05 solid geometry attached to clerestory-strip", "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 48, 40, 1.0)", "secondaryAlbedo": "rgba(58, 38, 32, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "clerestory-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_clerestory_05_17.add(mesh_clerestory_05_17);
  meshes["clerestory-05"] = mesh_clerestory_05_17;
  colliders["clerestory-05"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["clerestory-05"] ??= [];
  destructionGroups["clerestory-05"].push(node_clerestory_05_17);

  const endpoint_window_system_18 = makeAttachmentEndpoint(null);
  const node_window_system_18 = new THREE.Group();
  node_window_system_18.name = "WindowSystem__pivot";
  node_window_system_18.scale.set(1, 1, 1);
  if (endpoint_window_system_18) {
    node_window_system_18.position.copy(endpoint_window_system_18.start);
    node_window_system_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_system_18.position.set(0.0, 1.25, 0.0);
    node_window_system_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_system_18.userData.sculptComponent = {"id": "window-system", "name": "WindowSystem", "level": "meso", "role": "window-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.25, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "WindowSystem solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_system_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_window_system_18);
  nodes["window-system"] = node_window_system_18;
  const mesh_window_system_18Geometry = endpoint_window_system_18
    ? new THREE.CylinderGeometry(endpoint_window_system_18.endRadius, endpoint_window_system_18.baseRadius, endpoint_window_system_18.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_system_18) {
    mesh_window_system_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_system_18 = new THREE.Mesh(
    mesh_window_system_18Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_system_18.name = "WindowSystem";
  if (endpoint_window_system_18) {
    mesh_window_system_18.position.copy(endpoint_window_system_18.midpoint);
    mesh_window_system_18.quaternion.copy(endpoint_window_system_18.quaternion);
  }
  mesh_window_system_18.castShadow = options.castShadow ?? true;
  mesh_window_system_18.receiveShadow = options.receiveShadow ?? true;
  mesh_window_system_18.visible = false; // 容器节点不渲染
  mesh_window_system_18.userData.sculptComponent = {"id": "window-system", "name": "WindowSystem", "level": "meso", "role": "window-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 1.25, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "WindowSystem solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_system_18.add(mesh_window_system_18);
  meshes["window-system"] = mesh_window_system_18;
  colliders["window-system"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-system"] ??= [];
  destructionGroups["window-system"].push(node_window_system_18);

  const endpoint_window_01_19 = makeAttachmentEndpoint(null);
  const node_window_01_19 = new THREE.Group();
  node_window_01_19.name = "Window01__pivot";
  node_window_01_19.scale.set(1, 1, 1);
  if (endpoint_window_01_19) {
    node_window_01_19.position.copy(endpoint_window_01_19.start);
    node_window_01_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_19.position.set(-1.05, 0.0, 0.71);
    node_window_01_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_19.userData.sculptComponent = {"id": "window-01", "name": "Window01", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.05, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_01_19);
  nodes["window-01"] = node_window_01_19;
  const mesh_window_01_19Geometry = endpoint_window_01_19
    ? new THREE.CylinderGeometry(endpoint_window_01_19.endRadius, endpoint_window_01_19.baseRadius, endpoint_window_01_19.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_19) {
    mesh_window_01_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_01_19 = new THREE.Mesh(
    mesh_window_01_19Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_19.name = "Window01";
  if (endpoint_window_01_19) {
    mesh_window_01_19.position.copy(endpoint_window_01_19.midpoint);
    mesh_window_01_19.quaternion.copy(endpoint_window_01_19.quaternion);
  }
  mesh_window_01_19.castShadow = options.castShadow ?? true;
  mesh_window_01_19.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_19.visible = false; // 容器节点不渲染
  mesh_window_01_19.userData.sculptComponent = {"id": "window-01", "name": "Window01", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.05, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_19.add(mesh_window_01_19);
  meshes["window-01"] = mesh_window_01_19;
  colliders["window-01"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01"] ??= [];
  destructionGroups["window-01"].push(node_window_01_19);

  const endpoint_window_01_frame_20 = makeAttachmentEndpoint(null);
  const node_window_01_frame_20 = new THREE.Group();
  node_window_01_frame_20.name = "Window01Frame__pivot";
  node_window_01_frame_20.scale.set(1, 1, 1);
  if (endpoint_window_01_frame_20) {
    node_window_01_frame_20.position.copy(endpoint_window_01_frame_20.start);
    node_window_01_frame_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_frame_20.position.set(0.0, 0.0, 0.0);
    node_window_01_frame_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_frame_20.userData.sculptComponent = {"id": "window-01-frame", "name": "Window01Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_frame_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_01_frame_20);
  nodes["window-01-frame"] = node_window_01_frame_20;
  const mesh_window_01_frame_20Geometry = endpoint_window_01_frame_20
    ? new THREE.CylinderGeometry(endpoint_window_01_frame_20.endRadius, endpoint_window_01_frame_20.baseRadius, endpoint_window_01_frame_20.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_frame_20) {
    mesh_window_01_frame_20Geometry.scale(0.56, 0.62, 0.05);
  }
  const mesh_window_01_frame_20 = new THREE.Mesh(
    mesh_window_01_frame_20Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_frame_20.name = "Window01Frame";
  if (endpoint_window_01_frame_20) {
    mesh_window_01_frame_20.position.copy(endpoint_window_01_frame_20.midpoint);
    mesh_window_01_frame_20.quaternion.copy(endpoint_window_01_frame_20.quaternion);
  }
  mesh_window_01_frame_20.castShadow = options.castShadow ?? true;
  mesh_window_01_frame_20.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_frame_20.userData.sculptComponent = {"id": "window-01-frame", "name": "Window01Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_frame_20.add(mesh_window_01_frame_20);
  meshes["window-01-frame"] = mesh_window_01_frame_20;
  colliders["window-01-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-frame"] ??= [];
  destructionGroups["window-01-frame"].push(node_window_01_frame_20);

  const endpoint_window_01_glass_21 = makeAttachmentEndpoint(null);
  const node_window_01_glass_21 = new THREE.Group();
  node_window_01_glass_21.name = "Window01Glass__pivot";
  node_window_01_glass_21.scale.set(1, 1, 1);
  if (endpoint_window_01_glass_21) {
    node_window_01_glass_21.position.copy(endpoint_window_01_glass_21.start);
    node_window_01_glass_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_glass_21.position.set(0.0, 0.0, 0.03);
    node_window_01_glass_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_glass_21.userData.sculptComponent = {"id": "window-01-glass", "name": "Window01Glass", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 0, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glass_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_01_glass_21);
  nodes["window-01-glass"] = node_window_01_glass_21;
  const mesh_window_01_glass_21Geometry = endpoint_window_01_glass_21
    ? new THREE.CylinderGeometry(endpoint_window_01_glass_21.endRadius, endpoint_window_01_glass_21.baseRadius, endpoint_window_01_glass_21.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_glass_21) {
    mesh_window_01_glass_21Geometry.scale(0.48, 0.54, 0.01);
  }
  const mesh_window_01_glass_21 = new THREE.Mesh(
    mesh_window_01_glass_21Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_glass_21.name = "Window01Glass";
  if (endpoint_window_01_glass_21) {
    mesh_window_01_glass_21.position.copy(endpoint_window_01_glass_21.midpoint);
    mesh_window_01_glass_21.quaternion.copy(endpoint_window_01_glass_21.quaternion);
  }
  mesh_window_01_glass_21.castShadow = options.castShadow ?? true;
  mesh_window_01_glass_21.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_glass_21.userData.sculptComponent = {"id": "window-01-glass", "name": "Window01Glass", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 0, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glass_21.add(mesh_window_01_glass_21);
  meshes["window-01-glass"] = mesh_window_01_glass_21;
  colliders["window-01-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-glass"] ??= [];
  destructionGroups["window-01-glass"].push(node_window_01_glass_21);

  const endpoint_window_01_curtain_22 = makeAttachmentEndpoint(null);
  const node_window_01_curtain_22 = new THREE.Group();
  node_window_01_curtain_22.name = "Window01Curtain__pivot";
  node_window_01_curtain_22.scale.set(1, 1, 1);
  if (endpoint_window_01_curtain_22) {
    node_window_01_curtain_22.position.copy(endpoint_window_01_curtain_22.start);
    node_window_01_curtain_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_01_curtain_22.position.set(0.0, 0.05, 0.045);
    node_window_01_curtain_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_01_curtain_22.userData.sculptComponent = {"id": "window-01-curtain", "name": "Window01Curtain", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 0, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Curtain solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_curtain_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01"] ?? root).add(node_window_01_curtain_22);
  nodes["window-01-curtain"] = node_window_01_curtain_22;
  const mesh_window_01_curtain_22Geometry = endpoint_window_01_curtain_22
    ? new THREE.CylinderGeometry(endpoint_window_01_curtain_22.endRadius, endpoint_window_01_curtain_22.baseRadius, endpoint_window_01_curtain_22.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_curtain_22) {
    mesh_window_01_curtain_22Geometry.scale(0.44, 0.4, 0.015);
  }
  const mesh_window_01_curtain_22 = new THREE.Mesh(
    mesh_window_01_curtain_22Geometry,
    materialMap["curtain-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_curtain_22.name = "Window01Curtain";
  if (endpoint_window_01_curtain_22) {
    mesh_window_01_curtain_22.position.copy(endpoint_window_01_curtain_22.midpoint);
    mesh_window_01_curtain_22.quaternion.copy(endpoint_window_01_curtain_22.quaternion);
  }
  mesh_window_01_curtain_22.castShadow = options.castShadow ?? true;
  mesh_window_01_curtain_22.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_curtain_22.userData.sculptComponent = {"id": "window-01-curtain", "name": "Window01Curtain", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01", "attachment": {"parentId": "window-01", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 0, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Curtain solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_curtain_22.add(mesh_window_01_curtain_22);
  meshes["window-01-curtain"] = mesh_window_01_curtain_22;
  colliders["window-01-curtain"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-curtain"] ??= [];
  destructionGroups["window-01-curtain"].push(node_window_01_curtain_22);

  const endpoint_window_02_23 = makeAttachmentEndpoint(null);
  const node_window_02_23 = new THREE.Group();
  node_window_02_23.name = "Window02__pivot";
  node_window_02_23.scale.set(1, 1, 1);
  if (endpoint_window_02_23) {
    node_window_02_23.position.copy(endpoint_window_02_23.start);
    node_window_02_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_23.position.set(-0.35, 0.0, 0.71);
    node_window_02_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_23.userData.sculptComponent = {"id": "window-02", "name": "Window02", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.35, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_02_23);
  nodes["window-02"] = node_window_02_23;
  const mesh_window_02_23Geometry = endpoint_window_02_23
    ? new THREE.CylinderGeometry(endpoint_window_02_23.endRadius, endpoint_window_02_23.baseRadius, endpoint_window_02_23.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_23) {
    mesh_window_02_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_02_23 = new THREE.Mesh(
    mesh_window_02_23Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_23.name = "Window02";
  if (endpoint_window_02_23) {
    mesh_window_02_23.position.copy(endpoint_window_02_23.midpoint);
    mesh_window_02_23.quaternion.copy(endpoint_window_02_23.quaternion);
  }
  mesh_window_02_23.castShadow = options.castShadow ?? true;
  mesh_window_02_23.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_23.visible = false; // 容器节点不渲染
  mesh_window_02_23.userData.sculptComponent = {"id": "window-02", "name": "Window02", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.35, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_23.add(mesh_window_02_23);
  meshes["window-02"] = mesh_window_02_23;
  colliders["window-02"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02"] ??= [];
  destructionGroups["window-02"].push(node_window_02_23);

  const endpoint_window_02_frame_24 = makeAttachmentEndpoint(null);
  const node_window_02_frame_24 = new THREE.Group();
  node_window_02_frame_24.name = "Window02Frame__pivot";
  node_window_02_frame_24.scale.set(1, 1, 1);
  if (endpoint_window_02_frame_24) {
    node_window_02_frame_24.position.copy(endpoint_window_02_frame_24.start);
    node_window_02_frame_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_frame_24.position.set(0.0, 0.0, 0.0);
    node_window_02_frame_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_frame_24.userData.sculptComponent = {"id": "window-02-frame", "name": "Window02Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_frame_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_frame_24);
  nodes["window-02-frame"] = node_window_02_frame_24;
  const mesh_window_02_frame_24Geometry = endpoint_window_02_frame_24
    ? new THREE.CylinderGeometry(endpoint_window_02_frame_24.endRadius, endpoint_window_02_frame_24.baseRadius, endpoint_window_02_frame_24.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_frame_24) {
    mesh_window_02_frame_24Geometry.scale(0.56, 0.62, 0.05);
  }
  const mesh_window_02_frame_24 = new THREE.Mesh(
    mesh_window_02_frame_24Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_frame_24.name = "Window02Frame";
  if (endpoint_window_02_frame_24) {
    mesh_window_02_frame_24.position.copy(endpoint_window_02_frame_24.midpoint);
    mesh_window_02_frame_24.quaternion.copy(endpoint_window_02_frame_24.quaternion);
  }
  mesh_window_02_frame_24.castShadow = options.castShadow ?? true;
  mesh_window_02_frame_24.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_frame_24.userData.sculptComponent = {"id": "window-02-frame", "name": "Window02Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_frame_24.add(mesh_window_02_frame_24);
  meshes["window-02-frame"] = mesh_window_02_frame_24;
  colliders["window-02-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-frame"] ??= [];
  destructionGroups["window-02-frame"].push(node_window_02_frame_24);

  const endpoint_window_02_glass_25 = makeAttachmentEndpoint(null);
  const node_window_02_glass_25 = new THREE.Group();
  node_window_02_glass_25.name = "Window02Glass__pivot";
  node_window_02_glass_25.scale.set(1, 1, 1);
  if (endpoint_window_02_glass_25) {
    node_window_02_glass_25.position.copy(endpoint_window_02_glass_25.start);
    node_window_02_glass_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_glass_25.position.set(0.0, 0.0, 0.03);
    node_window_02_glass_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_glass_25.userData.sculptComponent = {"id": "window-02-glass", "name": "Window02Glass", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 0, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glass_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_glass_25);
  nodes["window-02-glass"] = node_window_02_glass_25;
  const mesh_window_02_glass_25Geometry = endpoint_window_02_glass_25
    ? new THREE.CylinderGeometry(endpoint_window_02_glass_25.endRadius, endpoint_window_02_glass_25.baseRadius, endpoint_window_02_glass_25.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_glass_25) {
    mesh_window_02_glass_25Geometry.scale(0.48, 0.54, 0.01);
  }
  const mesh_window_02_glass_25 = new THREE.Mesh(
    mesh_window_02_glass_25Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_glass_25.name = "Window02Glass";
  if (endpoint_window_02_glass_25) {
    mesh_window_02_glass_25.position.copy(endpoint_window_02_glass_25.midpoint);
    mesh_window_02_glass_25.quaternion.copy(endpoint_window_02_glass_25.quaternion);
  }
  mesh_window_02_glass_25.castShadow = options.castShadow ?? true;
  mesh_window_02_glass_25.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_glass_25.userData.sculptComponent = {"id": "window-02-glass", "name": "Window02Glass", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 0, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glass_25.add(mesh_window_02_glass_25);
  meshes["window-02-glass"] = mesh_window_02_glass_25;
  colliders["window-02-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-glass"] ??= [];
  destructionGroups["window-02-glass"].push(node_window_02_glass_25);

  const endpoint_window_02_curtain_26 = makeAttachmentEndpoint(null);
  const node_window_02_curtain_26 = new THREE.Group();
  node_window_02_curtain_26.name = "Window02Curtain__pivot";
  node_window_02_curtain_26.scale.set(1, 1, 1);
  if (endpoint_window_02_curtain_26) {
    node_window_02_curtain_26.position.copy(endpoint_window_02_curtain_26.start);
    node_window_02_curtain_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_02_curtain_26.position.set(0.0, 0.05, 0.045);
    node_window_02_curtain_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_02_curtain_26.userData.sculptComponent = {"id": "window-02-curtain", "name": "Window02Curtain", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 0, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Curtain solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_curtain_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02"] ?? root).add(node_window_02_curtain_26);
  nodes["window-02-curtain"] = node_window_02_curtain_26;
  const mesh_window_02_curtain_26Geometry = endpoint_window_02_curtain_26
    ? new THREE.CylinderGeometry(endpoint_window_02_curtain_26.endRadius, endpoint_window_02_curtain_26.baseRadius, endpoint_window_02_curtain_26.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_curtain_26) {
    mesh_window_02_curtain_26Geometry.scale(0.44, 0.4, 0.015);
  }
  const mesh_window_02_curtain_26 = new THREE.Mesh(
    mesh_window_02_curtain_26Geometry,
    materialMap["curtain-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_curtain_26.name = "Window02Curtain";
  if (endpoint_window_02_curtain_26) {
    mesh_window_02_curtain_26.position.copy(endpoint_window_02_curtain_26.midpoint);
    mesh_window_02_curtain_26.quaternion.copy(endpoint_window_02_curtain_26.quaternion);
  }
  mesh_window_02_curtain_26.castShadow = options.castShadow ?? true;
  mesh_window_02_curtain_26.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_curtain_26.userData.sculptComponent = {"id": "window-02-curtain", "name": "Window02Curtain", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02", "attachment": {"parentId": "window-02", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 0, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Curtain solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_curtain_26.add(mesh_window_02_curtain_26);
  meshes["window-02-curtain"] = mesh_window_02_curtain_26;
  colliders["window-02-curtain"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-curtain"] ??= [];
  destructionGroups["window-02-curtain"].push(node_window_02_curtain_26);

  const endpoint_window_03_27 = makeAttachmentEndpoint(null);
  const node_window_03_27 = new THREE.Group();
  node_window_03_27.name = "Window03__pivot";
  node_window_03_27.scale.set(1, 1, 1);
  if (endpoint_window_03_27) {
    node_window_03_27.position.copy(endpoint_window_03_27.start);
    node_window_03_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_27.position.set(0.35, 0.0, 0.71);
    node_window_03_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_27.userData.sculptComponent = {"id": "window-03", "name": "Window03", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.35, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_03_27);
  nodes["window-03"] = node_window_03_27;
  const mesh_window_03_27Geometry = endpoint_window_03_27
    ? new THREE.CylinderGeometry(endpoint_window_03_27.endRadius, endpoint_window_03_27.baseRadius, endpoint_window_03_27.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_27) {
    mesh_window_03_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_03_27 = new THREE.Mesh(
    mesh_window_03_27Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_27.name = "Window03";
  if (endpoint_window_03_27) {
    mesh_window_03_27.position.copy(endpoint_window_03_27.midpoint);
    mesh_window_03_27.quaternion.copy(endpoint_window_03_27.quaternion);
  }
  mesh_window_03_27.castShadow = options.castShadow ?? true;
  mesh_window_03_27.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_27.visible = false; // 容器节点不渲染
  mesh_window_03_27.userData.sculptComponent = {"id": "window-03", "name": "Window03", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.35, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_27.add(mesh_window_03_27);
  meshes["window-03"] = mesh_window_03_27;
  colliders["window-03"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03"] ??= [];
  destructionGroups["window-03"].push(node_window_03_27);

  const endpoint_window_03_frame_28 = makeAttachmentEndpoint(null);
  const node_window_03_frame_28 = new THREE.Group();
  node_window_03_frame_28.name = "Window03Frame__pivot";
  node_window_03_frame_28.scale.set(1, 1, 1);
  if (endpoint_window_03_frame_28) {
    node_window_03_frame_28.position.copy(endpoint_window_03_frame_28.start);
    node_window_03_frame_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_frame_28.position.set(0.0, 0.0, 0.0);
    node_window_03_frame_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_frame_28.userData.sculptComponent = {"id": "window-03-frame", "name": "Window03Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_frame_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_frame_28);
  nodes["window-03-frame"] = node_window_03_frame_28;
  const mesh_window_03_frame_28Geometry = endpoint_window_03_frame_28
    ? new THREE.CylinderGeometry(endpoint_window_03_frame_28.endRadius, endpoint_window_03_frame_28.baseRadius, endpoint_window_03_frame_28.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_frame_28) {
    mesh_window_03_frame_28Geometry.scale(0.56, 0.62, 0.05);
  }
  const mesh_window_03_frame_28 = new THREE.Mesh(
    mesh_window_03_frame_28Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_frame_28.name = "Window03Frame";
  if (endpoint_window_03_frame_28) {
    mesh_window_03_frame_28.position.copy(endpoint_window_03_frame_28.midpoint);
    mesh_window_03_frame_28.quaternion.copy(endpoint_window_03_frame_28.quaternion);
  }
  mesh_window_03_frame_28.castShadow = options.castShadow ?? true;
  mesh_window_03_frame_28.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_frame_28.userData.sculptComponent = {"id": "window-03-frame", "name": "Window03Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_frame_28.add(mesh_window_03_frame_28);
  meshes["window-03-frame"] = mesh_window_03_frame_28;
  colliders["window-03-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-frame"] ??= [];
  destructionGroups["window-03-frame"].push(node_window_03_frame_28);

  const endpoint_window_03_glass_29 = makeAttachmentEndpoint(null);
  const node_window_03_glass_29 = new THREE.Group();
  node_window_03_glass_29.name = "Window03Glass__pivot";
  node_window_03_glass_29.scale.set(1, 1, 1);
  if (endpoint_window_03_glass_29) {
    node_window_03_glass_29.position.copy(endpoint_window_03_glass_29.start);
    node_window_03_glass_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_glass_29.position.set(0.0, 0.0, 0.03);
    node_window_03_glass_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_glass_29.userData.sculptComponent = {"id": "window-03-glass", "name": "Window03Glass", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 0, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glass_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_glass_29);
  nodes["window-03-glass"] = node_window_03_glass_29;
  const mesh_window_03_glass_29Geometry = endpoint_window_03_glass_29
    ? new THREE.CylinderGeometry(endpoint_window_03_glass_29.endRadius, endpoint_window_03_glass_29.baseRadius, endpoint_window_03_glass_29.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_glass_29) {
    mesh_window_03_glass_29Geometry.scale(0.48, 0.54, 0.01);
  }
  const mesh_window_03_glass_29 = new THREE.Mesh(
    mesh_window_03_glass_29Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_glass_29.name = "Window03Glass";
  if (endpoint_window_03_glass_29) {
    mesh_window_03_glass_29.position.copy(endpoint_window_03_glass_29.midpoint);
    mesh_window_03_glass_29.quaternion.copy(endpoint_window_03_glass_29.quaternion);
  }
  mesh_window_03_glass_29.castShadow = options.castShadow ?? true;
  mesh_window_03_glass_29.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_glass_29.userData.sculptComponent = {"id": "window-03-glass", "name": "Window03Glass", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 0, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glass_29.add(mesh_window_03_glass_29);
  meshes["window-03-glass"] = mesh_window_03_glass_29;
  colliders["window-03-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-glass"] ??= [];
  destructionGroups["window-03-glass"].push(node_window_03_glass_29);

  const endpoint_window_03_curtain_30 = makeAttachmentEndpoint(null);
  const node_window_03_curtain_30 = new THREE.Group();
  node_window_03_curtain_30.name = "Window03Curtain__pivot";
  node_window_03_curtain_30.scale.set(1, 1, 1);
  if (endpoint_window_03_curtain_30) {
    node_window_03_curtain_30.position.copy(endpoint_window_03_curtain_30.start);
    node_window_03_curtain_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_03_curtain_30.position.set(0.0, 0.05, 0.045);
    node_window_03_curtain_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_03_curtain_30.userData.sculptComponent = {"id": "window-03-curtain", "name": "Window03Curtain", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 0, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Curtain solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_curtain_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03"] ?? root).add(node_window_03_curtain_30);
  nodes["window-03-curtain"] = node_window_03_curtain_30;
  const mesh_window_03_curtain_30Geometry = endpoint_window_03_curtain_30
    ? new THREE.CylinderGeometry(endpoint_window_03_curtain_30.endRadius, endpoint_window_03_curtain_30.baseRadius, endpoint_window_03_curtain_30.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_curtain_30) {
    mesh_window_03_curtain_30Geometry.scale(0.44, 0.4, 0.015);
  }
  const mesh_window_03_curtain_30 = new THREE.Mesh(
    mesh_window_03_curtain_30Geometry,
    materialMap["curtain-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_curtain_30.name = "Window03Curtain";
  if (endpoint_window_03_curtain_30) {
    mesh_window_03_curtain_30.position.copy(endpoint_window_03_curtain_30.midpoint);
    mesh_window_03_curtain_30.quaternion.copy(endpoint_window_03_curtain_30.quaternion);
  }
  mesh_window_03_curtain_30.castShadow = options.castShadow ?? true;
  mesh_window_03_curtain_30.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_curtain_30.userData.sculptComponent = {"id": "window-03-curtain", "name": "Window03Curtain", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03", "attachment": {"parentId": "window-03", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 0, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Curtain solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_curtain_30.add(mesh_window_03_curtain_30);
  meshes["window-03-curtain"] = mesh_window_03_curtain_30;
  colliders["window-03-curtain"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-curtain"] ??= [];
  destructionGroups["window-03-curtain"].push(node_window_03_curtain_30);

  const endpoint_window_04_31 = makeAttachmentEndpoint(null);
  const node_window_04_31 = new THREE.Group();
  node_window_04_31.name = "Window04__pivot";
  node_window_04_31.scale.set(1, 1, 1);
  if (endpoint_window_04_31) {
    node_window_04_31.position.copy(endpoint_window_04_31.start);
    node_window_04_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_31.position.set(1.05, 0.0, 0.71);
    node_window_04_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_31.userData.sculptComponent = {"id": "window-04", "name": "Window04", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.05, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_04_31);
  nodes["window-04"] = node_window_04_31;
  const mesh_window_04_31Geometry = endpoint_window_04_31
    ? new THREE.CylinderGeometry(endpoint_window_04_31.endRadius, endpoint_window_04_31.baseRadius, endpoint_window_04_31.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_31) {
    mesh_window_04_31Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_04_31 = new THREE.Mesh(
    mesh_window_04_31Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_31.name = "Window04";
  if (endpoint_window_04_31) {
    mesh_window_04_31.position.copy(endpoint_window_04_31.midpoint);
    mesh_window_04_31.quaternion.copy(endpoint_window_04_31.quaternion);
  }
  mesh_window_04_31.castShadow = options.castShadow ?? true;
  mesh_window_04_31.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_31.visible = false; // 容器节点不渲染
  mesh_window_04_31.userData.sculptComponent = {"id": "window-04", "name": "Window04", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.05, 0, 0.71], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_31.add(mesh_window_04_31);
  meshes["window-04"] = mesh_window_04_31;
  colliders["window-04"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04"] ??= [];
  destructionGroups["window-04"].push(node_window_04_31);

  const endpoint_window_04_frame_32 = makeAttachmentEndpoint(null);
  const node_window_04_frame_32 = new THREE.Group();
  node_window_04_frame_32.name = "Window04Frame__pivot";
  node_window_04_frame_32.scale.set(1, 1, 1);
  if (endpoint_window_04_frame_32) {
    node_window_04_frame_32.position.copy(endpoint_window_04_frame_32.start);
    node_window_04_frame_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_frame_32.position.set(0.0, 0.0, 0.0);
    node_window_04_frame_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_frame_32.userData.sculptComponent = {"id": "window-04-frame", "name": "Window04Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_frame_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04"] ?? root).add(node_window_04_frame_32);
  nodes["window-04-frame"] = node_window_04_frame_32;
  const mesh_window_04_frame_32Geometry = endpoint_window_04_frame_32
    ? new THREE.CylinderGeometry(endpoint_window_04_frame_32.endRadius, endpoint_window_04_frame_32.baseRadius, endpoint_window_04_frame_32.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_frame_32) {
    mesh_window_04_frame_32Geometry.scale(0.56, 0.62, 0.05);
  }
  const mesh_window_04_frame_32 = new THREE.Mesh(
    mesh_window_04_frame_32Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_frame_32.name = "Window04Frame";
  if (endpoint_window_04_frame_32) {
    mesh_window_04_frame_32.position.copy(endpoint_window_04_frame_32.midpoint);
    mesh_window_04_frame_32.quaternion.copy(endpoint_window_04_frame_32.quaternion);
  }
  mesh_window_04_frame_32.castShadow = options.castShadow ?? true;
  mesh_window_04_frame_32.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_frame_32.userData.sculptComponent = {"id": "window-04-frame", "name": "Window04Frame", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_frame_32.add(mesh_window_04_frame_32);
  meshes["window-04-frame"] = mesh_window_04_frame_32;
  colliders["window-04-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-frame"] ??= [];
  destructionGroups["window-04-frame"].push(node_window_04_frame_32);

  const endpoint_window_04_glass_33 = makeAttachmentEndpoint(null);
  const node_window_04_glass_33 = new THREE.Group();
  node_window_04_glass_33.name = "Window04Glass__pivot";
  node_window_04_glass_33.scale.set(1, 1, 1);
  if (endpoint_window_04_glass_33) {
    node_window_04_glass_33.position.copy(endpoint_window_04_glass_33.start);
    node_window_04_glass_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_glass_33.position.set(0.0, 0.0, 0.03);
    node_window_04_glass_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_glass_33.userData.sculptComponent = {"id": "window-04-glass", "name": "Window04Glass", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 0, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glass_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04"] ?? root).add(node_window_04_glass_33);
  nodes["window-04-glass"] = node_window_04_glass_33;
  const mesh_window_04_glass_33Geometry = endpoint_window_04_glass_33
    ? new THREE.CylinderGeometry(endpoint_window_04_glass_33.endRadius, endpoint_window_04_glass_33.baseRadius, endpoint_window_04_glass_33.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_glass_33) {
    mesh_window_04_glass_33Geometry.scale(0.48, 0.54, 0.01);
  }
  const mesh_window_04_glass_33 = new THREE.Mesh(
    mesh_window_04_glass_33Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_glass_33.name = "Window04Glass";
  if (endpoint_window_04_glass_33) {
    mesh_window_04_glass_33.position.copy(endpoint_window_04_glass_33.midpoint);
    mesh_window_04_glass_33.quaternion.copy(endpoint_window_04_glass_33.quaternion);
  }
  mesh_window_04_glass_33.castShadow = options.castShadow ?? true;
  mesh_window_04_glass_33.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_glass_33.userData.sculptComponent = {"id": "window-04-glass", "name": "Window04Glass", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 0, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glass_33.add(mesh_window_04_glass_33);
  meshes["window-04-glass"] = mesh_window_04_glass_33;
  colliders["window-04-glass"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-glass"] ??= [];
  destructionGroups["window-04-glass"].push(node_window_04_glass_33);

  const endpoint_window_04_curtain_34 = makeAttachmentEndpoint(null);
  const node_window_04_curtain_34 = new THREE.Group();
  node_window_04_curtain_34.name = "Window04Curtain__pivot";
  node_window_04_curtain_34.scale.set(1, 1, 1);
  if (endpoint_window_04_curtain_34) {
    node_window_04_curtain_34.position.copy(endpoint_window_04_curtain_34.start);
    node_window_04_curtain_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_04_curtain_34.position.set(0.0, 0.05, 0.045);
    node_window_04_curtain_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_04_curtain_34.userData.sculptComponent = {"id": "window-04-curtain", "name": "Window04Curtain", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 0, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Curtain solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_curtain_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04"] ?? root).add(node_window_04_curtain_34);
  nodes["window-04-curtain"] = node_window_04_curtain_34;
  const mesh_window_04_curtain_34Geometry = endpoint_window_04_curtain_34
    ? new THREE.CylinderGeometry(endpoint_window_04_curtain_34.endRadius, endpoint_window_04_curtain_34.baseRadius, endpoint_window_04_curtain_34.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_curtain_34) {
    mesh_window_04_curtain_34Geometry.scale(0.44, 0.4, 0.015);
  }
  const mesh_window_04_curtain_34 = new THREE.Mesh(
    mesh_window_04_curtain_34Geometry,
    materialMap["curtain-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_curtain_34.name = "Window04Curtain";
  if (endpoint_window_04_curtain_34) {
    mesh_window_04_curtain_34.position.copy(endpoint_window_04_curtain_34.midpoint);
    mesh_window_04_curtain_34.quaternion.copy(endpoint_window_04_curtain_34.quaternion);
  }
  mesh_window_04_curtain_34.castShadow = options.castShadow ?? true;
  mesh_window_04_curtain_34.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_curtain_34.userData.sculptComponent = {"id": "window-04-curtain", "name": "Window04Curtain", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04", "attachment": {"parentId": "window-04", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 0, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Curtain solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_curtain_34.add(mesh_window_04_curtain_34);
  meshes["window-04-curtain"] = mesh_window_04_curtain_34;
  colliders["window-04-curtain"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-curtain"] ??= [];
  destructionGroups["window-04-curtain"].push(node_window_04_curtain_34);

  const endpoint_platform_left_35 = makeAttachmentEndpoint(null);
  const node_platform_left_35 = new THREE.Group();
  node_platform_left_35.name = "PlatformLeft__pivot";
  node_platform_left_35.scale.set(1, 1, 1);
  if (endpoint_platform_left_35) {
    node_platform_left_35.position.copy(endpoint_platform_left_35.start);
    node_platform_left_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_left_35.position.set(-1.75, 0.62, 0.0);
    node_platform_left_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_left_35.userData.sculptComponent = {"id": "platform-left", "name": "PlatformLeft", "level": "meso", "role": "platform", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.06, "depth": 1.2, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.75, 0.62, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.06, 1.2]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "PlatformLeft solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "platform-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_left_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "platform-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_platform_left_35);
  nodes["platform-left"] = node_platform_left_35;
  const mesh_platform_left_35Geometry = endpoint_platform_left_35
    ? new THREE.CylinderGeometry(endpoint_platform_left_35.endRadius, endpoint_platform_left_35.baseRadius, endpoint_platform_left_35.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_left_35) {
    mesh_platform_left_35Geometry.scale(0.5, 0.06, 1.2);
  }
  const mesh_platform_left_35 = new THREE.Mesh(
    mesh_platform_left_35Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_left_35.name = "PlatformLeft";
  if (endpoint_platform_left_35) {
    mesh_platform_left_35.position.copy(endpoint_platform_left_35.midpoint);
    mesh_platform_left_35.quaternion.copy(endpoint_platform_left_35.quaternion);
  }
  mesh_platform_left_35.castShadow = options.castShadow ?? true;
  mesh_platform_left_35.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_left_35.userData.sculptComponent = {"id": "platform-left", "name": "PlatformLeft", "level": "meso", "role": "platform", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.06, "depth": 1.2, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.75, 0.62, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.06, 1.2]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "PlatformLeft solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "platform-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_left_35.add(mesh_platform_left_35);
  meshes["platform-left"] = mesh_platform_left_35;
  colliders["platform-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["platform-left"] ??= [];
  destructionGroups["platform-left"].push(node_platform_left_35);

  const endpoint_stairs_left_36 = makeAttachmentEndpoint(null);
  const node_stairs_left_36 = new THREE.Group();
  node_stairs_left_36.name = "StairsLeft__pivot";
  node_stairs_left_36.scale.set(1, 1, 1);
  if (endpoint_stairs_left_36) {
    node_stairs_left_36.position.copy(endpoint_stairs_left_36.start);
    node_stairs_left_36.rotation.set(0.0, 0.0, -0.34907);
  } else {
    node_stairs_left_36.position.set(-0.25, -0.25, 0.0);
    node_stairs_left_36.rotation.set(0.0, 0.0, -0.34907);
  }
  node_stairs_left_36.userData.sculptComponent = {"id": "stairs-left", "name": "StairsLeft", "level": "meso", "role": "stairs", "importance": 0.6, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.5, "depth": 0.9, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.25, -0.25, 0], "rotation": [0, 0, -0.34907], "scale": [0.4, 0.5, 0.9]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "StairsLeft solid geometry attached to platform-left", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_stairs_left_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-left"] ?? root).add(node_stairs_left_36);
  nodes["stairs-left"] = node_stairs_left_36;
  const mesh_stairs_left_36Geometry = endpoint_stairs_left_36
    ? new THREE.CylinderGeometry(endpoint_stairs_left_36.endRadius, endpoint_stairs_left_36.baseRadius, endpoint_stairs_left_36.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_stairs_left_36) {
    mesh_stairs_left_36Geometry.scale(0.4, 0.5, 0.9);
  }
  const mesh_stairs_left_36 = new THREE.Mesh(
    mesh_stairs_left_36Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stairs_left_36.name = "StairsLeft";
  if (endpoint_stairs_left_36) {
    mesh_stairs_left_36.position.copy(endpoint_stairs_left_36.midpoint);
    mesh_stairs_left_36.quaternion.copy(endpoint_stairs_left_36.quaternion);
  }
  mesh_stairs_left_36.castShadow = options.castShadow ?? true;
  mesh_stairs_left_36.receiveShadow = options.receiveShadow ?? true;
  mesh_stairs_left_36.userData.sculptComponent = {"id": "stairs-left", "name": "StairsLeft", "level": "meso", "role": "stairs", "importance": 0.6, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.5, "depth": 0.9, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.25, -0.25, 0], "rotation": [0, 0, -0.34907], "scale": [0.4, 0.5, 0.9]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "StairsLeft solid geometry attached to platform-left", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_stairs_left_36.add(mesh_stairs_left_36);
  meshes["stairs-left"] = mesh_stairs_left_36;
  colliders["stairs-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["stairs-left"] ??= [];
  destructionGroups["stairs-left"].push(node_stairs_left_36);

  const endpoint_platform_right_37 = makeAttachmentEndpoint(null);
  const node_platform_right_37 = new THREE.Group();
  node_platform_right_37.name = "PlatformRight__pivot";
  node_platform_right_37.scale.set(1, 1, 1);
  if (endpoint_platform_right_37) {
    node_platform_right_37.position.copy(endpoint_platform_right_37.start);
    node_platform_right_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_right_37.position.set(1.75, 0.62, 0.0);
    node_platform_right_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_right_37.userData.sculptComponent = {"id": "platform-right", "name": "PlatformRight", "level": "meso", "role": "platform", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.06, "depth": 1.2, "units": "world", "confidence": 0.85}, "transform": {"position": [1.75, 0.62, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.06, 1.2]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "PlatformRight solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "platform-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_right_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "platform-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_platform_right_37);
  nodes["platform-right"] = node_platform_right_37;
  const mesh_platform_right_37Geometry = endpoint_platform_right_37
    ? new THREE.CylinderGeometry(endpoint_platform_right_37.endRadius, endpoint_platform_right_37.baseRadius, endpoint_platform_right_37.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_right_37) {
    mesh_platform_right_37Geometry.scale(0.5, 0.06, 1.2);
  }
  const mesh_platform_right_37 = new THREE.Mesh(
    mesh_platform_right_37Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_right_37.name = "PlatformRight";
  if (endpoint_platform_right_37) {
    mesh_platform_right_37.position.copy(endpoint_platform_right_37.midpoint);
    mesh_platform_right_37.quaternion.copy(endpoint_platform_right_37.quaternion);
  }
  mesh_platform_right_37.castShadow = options.castShadow ?? true;
  mesh_platform_right_37.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_right_37.userData.sculptComponent = {"id": "platform-right", "name": "PlatformRight", "level": "meso", "role": "platform", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.5, "height": 0.06, "depth": 1.2, "units": "world", "confidence": 0.85}, "transform": {"position": [1.75, 0.62, 0], "rotation": [0, 0, 0], "scale": [0.5, 0.06, 1.2]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "PlatformRight solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "platform-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_right_37.add(mesh_platform_right_37);
  meshes["platform-right"] = mesh_platform_right_37;
  colliders["platform-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["platform-right"] ??= [];
  destructionGroups["platform-right"].push(node_platform_right_37);

  const endpoint_stairs_right_38 = makeAttachmentEndpoint(null);
  const node_stairs_right_38 = new THREE.Group();
  node_stairs_right_38.name = "StairsRight__pivot";
  node_stairs_right_38.scale.set(1, 1, 1);
  if (endpoint_stairs_right_38) {
    node_stairs_right_38.position.copy(endpoint_stairs_right_38.start);
    node_stairs_right_38.rotation.set(0.0, 0.0, 0.34907);
  } else {
    node_stairs_right_38.position.set(0.25, -0.25, 0.0);
    node_stairs_right_38.rotation.set(0.0, 0.0, 0.34907);
  }
  node_stairs_right_38.userData.sculptComponent = {"id": "stairs-right", "name": "StairsRight", "level": "meso", "role": "stairs", "importance": 0.6, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.5, "depth": 0.9, "units": "world", "confidence": 0.8}, "transform": {"position": [0.25, -0.25, 0], "rotation": [0, 0, 0.34907], "scale": [0.4, 0.5, 0.9]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "StairsRight solid geometry attached to platform-right", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_stairs_right_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-right"] ?? root).add(node_stairs_right_38);
  nodes["stairs-right"] = node_stairs_right_38;
  const mesh_stairs_right_38Geometry = endpoint_stairs_right_38
    ? new THREE.CylinderGeometry(endpoint_stairs_right_38.endRadius, endpoint_stairs_right_38.baseRadius, endpoint_stairs_right_38.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_stairs_right_38) {
    mesh_stairs_right_38Geometry.scale(0.4, 0.5, 0.9);
  }
  const mesh_stairs_right_38 = new THREE.Mesh(
    mesh_stairs_right_38Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stairs_right_38.name = "StairsRight";
  if (endpoint_stairs_right_38) {
    mesh_stairs_right_38.position.copy(endpoint_stairs_right_38.midpoint);
    mesh_stairs_right_38.quaternion.copy(endpoint_stairs_right_38.quaternion);
  }
  mesh_stairs_right_38.castShadow = options.castShadow ?? true;
  mesh_stairs_right_38.receiveShadow = options.receiveShadow ?? true;
  mesh_stairs_right_38.userData.sculptComponent = {"id": "stairs-right", "name": "StairsRight", "level": "meso", "role": "stairs", "importance": 0.6, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.4, "height": 0.5, "depth": 0.9, "units": "world", "confidence": 0.8}, "transform": {"position": [0.25, -0.25, 0], "rotation": [0, 0, 0.34907], "scale": [0.4, 0.5, 0.9]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "StairsRight solid geometry attached to platform-right", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "stairs-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_stairs_right_38.add(mesh_stairs_right_38);
  meshes["stairs-right"] = mesh_stairs_right_38;
  colliders["stairs-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["stairs-right"] ??= [];
  destructionGroups["stairs-right"].push(node_stairs_right_38);

  const endpoint_chassis_39 = makeAttachmentEndpoint(null);
  const node_chassis_39 = new THREE.Group();
  node_chassis_39.name = "Chassis__pivot";
  node_chassis_39.scale.set(1, 1, 1);
  if (endpoint_chassis_39) {
    node_chassis_39.position.copy(endpoint_chassis_39.start);
    node_chassis_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chassis_39.position.set(0.0, 0.42, 0.0);
    node_chassis_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_chassis_39.userData.sculptComponent = {"id": "chassis", "name": "Chassis", "level": "meso", "role": "undercarriage", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.1, "height": 0.18, "depth": 1.2, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.42, 0], "rotation": [0, 0, 0], "scale": [3.1, 0.18, 1.2]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Chassis solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chassis_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["vintage-root"] ?? root).add(node_chassis_39);
  nodes["chassis"] = node_chassis_39;
  const mesh_chassis_39Geometry = endpoint_chassis_39
    ? new THREE.CylinderGeometry(endpoint_chassis_39.endRadius, endpoint_chassis_39.baseRadius, endpoint_chassis_39.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chassis_39) {
    mesh_chassis_39Geometry.scale(3.1, 0.18, 1.2);
  }
  const mesh_chassis_39 = new THREE.Mesh(
    mesh_chassis_39Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chassis_39.name = "Chassis";
  if (endpoint_chassis_39) {
    mesh_chassis_39.position.copy(endpoint_chassis_39.midpoint);
    mesh_chassis_39.quaternion.copy(endpoint_chassis_39.quaternion);
  }
  mesh_chassis_39.castShadow = options.castShadow ?? true;
  mesh_chassis_39.receiveShadow = options.receiveShadow ?? true;
  mesh_chassis_39.userData.sculptComponent = {"id": "chassis", "name": "Chassis", "level": "meso", "role": "undercarriage", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "vintage-root", "attachment": {"parentId": "vintage-root", "parentSocket": "vintage-root-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 3.1, "height": 0.18, "depth": 1.2, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0.42, 0], "rotation": [0, 0, 0], "scale": [3.1, 0.18, 1.2]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Chassis solid geometry attached to vintage-root", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "chassis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_chassis_39.add(mesh_chassis_39);
  meshes["chassis"] = mesh_chassis_39;
  colliders["chassis"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["chassis"] ??= [];
  destructionGroups["chassis"].push(node_chassis_39);

  const attachment_wheel_front_40 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_front_40 = makeAttachmentEndpoint(attachment_wheel_front_40);
  const node_wheel_front_40 = new THREE.Group();
  node_wheel_front_40.name = "WheelFront__pivot";
  node_wheel_front_40.scale.set(1, 1, 1);
  if (endpoint_wheel_front_40) {
    node_wheel_front_40.position.copy(endpoint_wheel_front_40.start);
    node_wheel_front_40.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_front_40.position.set(-0.9, 0.0, -0.5);
    node_wheel_front_40.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_front_40.userData.sculptComponent = {"id": "wheel-front", "name": "WheelFront", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.12, "depth": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.9, 0, -0.5], "rotation": [1.5708, 0, 0], "scale": [0.55, 0.12, 0.55]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Large spoked wheel", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_front_40);
  nodes["wheel-front"] = node_wheel_front_40;
  const mesh_wheel_front_40Geometry = endpoint_wheel_front_40
    ? new THREE.CylinderGeometry(endpoint_wheel_front_40.endRadius, endpoint_wheel_front_40.baseRadius, endpoint_wheel_front_40.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_front_40) {
    mesh_wheel_front_40Geometry.scale(0.55, 0.12, 0.55);
  }
  const mesh_wheel_front_40 = new THREE.Mesh(
    mesh_wheel_front_40Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_40.name = "WheelFront";
  if (endpoint_wheel_front_40) {
    mesh_wheel_front_40.position.copy(endpoint_wheel_front_40.midpoint);
    mesh_wheel_front_40.quaternion.copy(endpoint_wheel_front_40.quaternion);
  }
  mesh_wheel_front_40.castShadow = options.castShadow ?? true;
  mesh_wheel_front_40.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_40.userData.sculptComponent = {"id": "wheel-front", "name": "WheelFront", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.12, "depth": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.9, 0, -0.5], "rotation": [1.5708, 0, 0], "scale": [0.55, 0.12, 0.55]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Large spoked wheel", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_40.add(mesh_wheel_front_40);
  meshes["wheel-front"] = mesh_wheel_front_40;
  colliders["wheel-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-front"] ??= [];
  destructionGroups["wheel-front"].push(node_wheel_front_40);

  const attachment_wheel_front_far_41 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_front_far_41 = makeAttachmentEndpoint(attachment_wheel_front_far_41);
  const node_wheel_front_far_41 = new THREE.Group();
  node_wheel_front_far_41.name = "WheelFrontFar__pivot";
  node_wheel_front_far_41.scale.set(1, 1, 1);
  if (endpoint_wheel_front_far_41) {
    node_wheel_front_far_41.position.copy(endpoint_wheel_front_far_41.start);
    node_wheel_front_far_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_front_far_41.position.set(-0.9, 0.0, 0.0);
    node_wheel_front_far_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_front_far_41.userData.sculptComponent = {"id": "wheel-front-far", "name": "WheelFrontFar", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.9, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFrontFar solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_far_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_front_far_41);
  nodes["wheel-front-far"] = node_wheel_front_far_41;
  const mesh_wheel_front_far_41Geometry = endpoint_wheel_front_far_41
    ? new THREE.CylinderGeometry(endpoint_wheel_front_far_41.endRadius, endpoint_wheel_front_far_41.baseRadius, endpoint_wheel_front_far_41.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_front_far_41) {
    mesh_wheel_front_far_41Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wheel_front_far_41 = new THREE.Mesh(
    mesh_wheel_front_far_41Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_far_41.name = "WheelFrontFar";
  if (endpoint_wheel_front_far_41) {
    mesh_wheel_front_far_41.position.copy(endpoint_wheel_front_far_41.midpoint);
    mesh_wheel_front_far_41.quaternion.copy(endpoint_wheel_front_far_41.quaternion);
  }
  mesh_wheel_front_far_41.castShadow = options.castShadow ?? true;
  mesh_wheel_front_far_41.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_far_41.visible = false; // 容器节点不渲染
  mesh_wheel_front_far_41.userData.sculptComponent = {"id": "wheel-front-far", "name": "WheelFrontFar", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.9, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "WheelFrontFar solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_far_41.add(mesh_wheel_front_far_41);
  meshes["wheel-front-far"] = mesh_wheel_front_far_41;
  colliders["wheel-front-far"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-front-far"] ??= [];
  destructionGroups["wheel-front-far"].push(node_wheel_front_far_41);

  const attachment_wheel_rear_42 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_rear_42 = makeAttachmentEndpoint(attachment_wheel_rear_42);
  const node_wheel_rear_42 = new THREE.Group();
  node_wheel_rear_42.name = "WheelRear__pivot";
  node_wheel_rear_42.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_42) {
    node_wheel_rear_42.position.copy(endpoint_wheel_rear_42.start);
    node_wheel_rear_42.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_rear_42.position.set(0.9, 0.0, -0.5);
    node_wheel_rear_42.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_rear_42.userData.sculptComponent = {"id": "wheel-rear", "name": "WheelRear", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.12, "depth": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [0.9, 0, -0.5], "rotation": [1.5708, 0, 0], "scale": [0.55, 0.12, 0.55]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Large spoked wheel", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_rear_42);
  nodes["wheel-rear"] = node_wheel_rear_42;
  const mesh_wheel_rear_42Geometry = endpoint_wheel_rear_42
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_42.endRadius, endpoint_wheel_rear_42.baseRadius, endpoint_wheel_rear_42.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_rear_42) {
    mesh_wheel_rear_42Geometry.scale(0.55, 0.12, 0.55);
  }
  const mesh_wheel_rear_42 = new THREE.Mesh(
    mesh_wheel_rear_42Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_42.name = "WheelRear";
  if (endpoint_wheel_rear_42) {
    mesh_wheel_rear_42.position.copy(endpoint_wheel_rear_42.midpoint);
    mesh_wheel_rear_42.quaternion.copy(endpoint_wheel_rear_42.quaternion);
  }
  mesh_wheel_rear_42.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_42.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_42.userData.sculptComponent = {"id": "wheel-rear", "name": "WheelRear", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.12, "depth": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [0.9, 0, -0.5], "rotation": [1.5708, 0, 0], "scale": [0.55, 0.12, 0.55]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Large spoked wheel", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_42.add(mesh_wheel_rear_42);
  meshes["wheel-rear"] = mesh_wheel_rear_42;
  colliders["wheel-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-rear"] ??= [];
  destructionGroups["wheel-rear"].push(node_wheel_rear_42);

  const attachment_wheel_rear_far_43 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_rear_far_43 = makeAttachmentEndpoint(attachment_wheel_rear_far_43);
  const node_wheel_rear_far_43 = new THREE.Group();
  node_wheel_rear_far_43.name = "WheelRearFar__pivot";
  node_wheel_rear_far_43.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_far_43) {
    node_wheel_rear_far_43.position.copy(endpoint_wheel_rear_far_43.start);
    node_wheel_rear_far_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wheel_rear_far_43.position.set(0.9, 0.0, 0.0);
    node_wheel_rear_far_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_wheel_rear_far_43.userData.sculptComponent = {"id": "wheel-rear-far", "name": "WheelRearFar", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.8}, "transform": {"position": [0.9, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRearFar solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_far_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_rear_far_43);
  nodes["wheel-rear-far"] = node_wheel_rear_far_43;
  const mesh_wheel_rear_far_43Geometry = endpoint_wheel_rear_far_43
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_far_43.endRadius, endpoint_wheel_rear_far_43.baseRadius, endpoint_wheel_rear_far_43.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_rear_far_43) {
    mesh_wheel_rear_far_43Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wheel_rear_far_43 = new THREE.Mesh(
    mesh_wheel_rear_far_43Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_far_43.name = "WheelRearFar";
  if (endpoint_wheel_rear_far_43) {
    mesh_wheel_rear_far_43.position.copy(endpoint_wheel_rear_far_43.midpoint);
    mesh_wheel_rear_far_43.quaternion.copy(endpoint_wheel_rear_far_43.quaternion);
  }
  mesh_wheel_rear_far_43.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_far_43.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_far_43.visible = false; // 容器节点不渲染
  mesh_wheel_rear_far_43.userData.sculptComponent = {"id": "wheel-rear-far", "name": "WheelRearFar", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.8}, "transform": {"position": [0.9, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "WheelRearFar solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_far_43.add(mesh_wheel_rear_far_43);
  meshes["wheel-rear-far"] = mesh_wheel_rear_far_43;
  colliders["wheel-rear-far"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-rear-far"] ??= [];
  destructionGroups["wheel-rear-far"].push(node_wheel_rear_far_43);

  const attachment_coupler_left_44 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coupler_left_44 = makeAttachmentEndpoint(attachment_coupler_left_44);
  const node_coupler_left_44 = new THREE.Group();
  node_coupler_left_44.name = "CouplerLeft__pivot";
  node_coupler_left_44.scale.set(1, 1, 1);
  if (endpoint_coupler_left_44) {
    node_coupler_left_44.position.copy(endpoint_coupler_left_44.start);
    node_coupler_left_44.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_coupler_left_44.position.set(-1.68, 0.05, 0.0);
    node_coupler_left_44.rotation.set(0.0, 0.0, 1.5708);
  }
  node_coupler_left_44.userData.sculptComponent = {"id": "coupler-left", "name": "CouplerLeft", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.68, 0.05, 0], "rotation": [0, 0, 1.5708], "scale": [0.3, 0.08, 0.08]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerLeft solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_left_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_coupler_left_44);
  nodes["coupler-left"] = node_coupler_left_44;
  const mesh_coupler_left_44Geometry = endpoint_coupler_left_44
    ? new THREE.CylinderGeometry(endpoint_coupler_left_44.endRadius, endpoint_coupler_left_44.baseRadius, endpoint_coupler_left_44.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_coupler_left_44) {
    mesh_coupler_left_44Geometry.scale(0.3, 0.08, 0.08);
  }
  const mesh_coupler_left_44 = new THREE.Mesh(
    mesh_coupler_left_44Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coupler_left_44.name = "CouplerLeft";
  if (endpoint_coupler_left_44) {
    mesh_coupler_left_44.position.copy(endpoint_coupler_left_44.midpoint);
    mesh_coupler_left_44.quaternion.copy(endpoint_coupler_left_44.quaternion);
  }
  mesh_coupler_left_44.castShadow = options.castShadow ?? true;
  mesh_coupler_left_44.receiveShadow = options.receiveShadow ?? true;
  mesh_coupler_left_44.userData.sculptComponent = {"id": "coupler-left", "name": "CouplerLeft", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.68, 0.05, 0], "rotation": [0, 0, 1.5708], "scale": [0.3, 0.08, 0.08]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerLeft solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_left_44.add(mesh_coupler_left_44);
  meshes["coupler-left"] = mesh_coupler_left_44;
  colliders["coupler-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coupler-left"] ??= [];
  destructionGroups["coupler-left"].push(node_coupler_left_44);

  const attachment_coupler_right_45 = {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_coupler_right_45 = makeAttachmentEndpoint(attachment_coupler_right_45);
  const node_coupler_right_45 = new THREE.Group();
  node_coupler_right_45.name = "CouplerRight__pivot";
  node_coupler_right_45.scale.set(1, 1, 1);
  if (endpoint_coupler_right_45) {
    node_coupler_right_45.position.copy(endpoint_coupler_right_45.start);
    node_coupler_right_45.rotation.set(0.0, 0.0, 1.5708);
  } else {
    node_coupler_right_45.position.set(1.68, 0.05, 0.0);
    node_coupler_right_45.rotation.set(0.0, 0.0, 1.5708);
  }
  node_coupler_right_45.userData.sculptComponent = {"id": "coupler-right", "name": "CouplerRight", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [1.68, 0.05, 0], "rotation": [0, 0, 1.5708], "scale": [0.3, 0.08, 0.08]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerRight solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_right_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_coupler_right_45);
  nodes["coupler-right"] = node_coupler_right_45;
  const mesh_coupler_right_45Geometry = endpoint_coupler_right_45
    ? new THREE.CylinderGeometry(endpoint_coupler_right_45.endRadius, endpoint_coupler_right_45.baseRadius, endpoint_coupler_right_45.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_coupler_right_45) {
    mesh_coupler_right_45Geometry.scale(0.3, 0.08, 0.08);
  }
  const mesh_coupler_right_45 = new THREE.Mesh(
    mesh_coupler_right_45Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coupler_right_45.name = "CouplerRight";
  if (endpoint_coupler_right_45) {
    mesh_coupler_right_45.position.copy(endpoint_coupler_right_45.midpoint);
    mesh_coupler_right_45.quaternion.copy(endpoint_coupler_right_45.quaternion);
  }
  mesh_coupler_right_45.castShadow = options.castShadow ?? true;
  mesh_coupler_right_45.receiveShadow = options.receiveShadow ?? true;
  mesh_coupler_right_45.userData.sculptComponent = {"id": "coupler-right", "name": "CouplerRight", "level": "meso", "role": "coupling", "importance": 0.6, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.3, "height": 0.08, "depth": 0.08, "units": "world", "confidence": 0.85}, "transform": {"position": [1.68, 0.05, 0], "rotation": [0, 0, 1.5708], "scale": [0.3, 0.08, 0.08]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "CouplerRight solid geometry attached to chassis", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "coupler-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_coupler_right_45.add(mesh_coupler_right_45);
  meshes["coupler-right"] = mesh_coupler_right_45;
  colliders["coupler-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["coupler-right"] ??= [];
  destructionGroups["coupler-right"].push(node_coupler_right_45);

  const endpoint_platform_post_left_0_46 = makeAttachmentEndpoint(null);
  const node_platform_post_left_0_46 = new THREE.Group();
  node_platform_post_left_0_46.name = "PlatformPostLeft0__pivot";
  node_platform_post_left_0_46.scale.set(1, 1, 1);
  if (endpoint_platform_post_left_0_46) {
    node_platform_post_left_0_46.position.copy(endpoint_platform_post_left_0_46.start);
    node_platform_post_left_0_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_left_0_46.position.set(-0.18, 0.25, -0.55);
    node_platform_post_left_0_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_left_0_46.userData.sculptComponent = {"id": "platform-post-left-0", "name": "PlatformPostLeft0", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, -0.55], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_0_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-left"] ?? root).add(node_platform_post_left_0_46);
  nodes["platform-post-left-0"] = node_platform_post_left_0_46;
  const mesh_platform_post_left_0_46Geometry = endpoint_platform_post_left_0_46
    ? new THREE.CylinderGeometry(endpoint_platform_post_left_0_46.endRadius, endpoint_platform_post_left_0_46.baseRadius, endpoint_platform_post_left_0_46.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_left_0_46) {
    mesh_platform_post_left_0_46Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_left_0_46 = new THREE.Mesh(
    mesh_platform_post_left_0_46Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_left_0_46.name = "PlatformPostLeft0";
  if (endpoint_platform_post_left_0_46) {
    mesh_platform_post_left_0_46.position.copy(endpoint_platform_post_left_0_46.midpoint);
    mesh_platform_post_left_0_46.quaternion.copy(endpoint_platform_post_left_0_46.quaternion);
  }
  mesh_platform_post_left_0_46.castShadow = options.castShadow ?? true;
  mesh_platform_post_left_0_46.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_left_0_46.userData.sculptComponent = {"id": "platform-post-left-0", "name": "PlatformPostLeft0", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, -0.55], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_0_46.add(mesh_platform_post_left_0_46);
  meshes["platform-post-left-0"] = mesh_platform_post_left_0_46;
  colliders["platform-post-left-0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_left_0_46);

  const endpoint_platform_post_left_1_47 = makeAttachmentEndpoint(null);
  const node_platform_post_left_1_47 = new THREE.Group();
  node_platform_post_left_1_47.name = "PlatformPostLeft1__pivot";
  node_platform_post_left_1_47.scale.set(1, 1, 1);
  if (endpoint_platform_post_left_1_47) {
    node_platform_post_left_1_47.position.copy(endpoint_platform_post_left_1_47.start);
    node_platform_post_left_1_47.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_left_1_47.position.set(-0.18, 0.25, -0.275);
    node_platform_post_left_1_47.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_left_1_47.userData.sculptComponent = {"id": "platform-post-left-1", "name": "PlatformPostLeft1", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, -0.275], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_1_47.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-left"] ?? root).add(node_platform_post_left_1_47);
  nodes["platform-post-left-1"] = node_platform_post_left_1_47;
  const mesh_platform_post_left_1_47Geometry = endpoint_platform_post_left_1_47
    ? new THREE.CylinderGeometry(endpoint_platform_post_left_1_47.endRadius, endpoint_platform_post_left_1_47.baseRadius, endpoint_platform_post_left_1_47.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_left_1_47) {
    mesh_platform_post_left_1_47Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_left_1_47 = new THREE.Mesh(
    mesh_platform_post_left_1_47Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_left_1_47.name = "PlatformPostLeft1";
  if (endpoint_platform_post_left_1_47) {
    mesh_platform_post_left_1_47.position.copy(endpoint_platform_post_left_1_47.midpoint);
    mesh_platform_post_left_1_47.quaternion.copy(endpoint_platform_post_left_1_47.quaternion);
  }
  mesh_platform_post_left_1_47.castShadow = options.castShadow ?? true;
  mesh_platform_post_left_1_47.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_left_1_47.userData.sculptComponent = {"id": "platform-post-left-1", "name": "PlatformPostLeft1", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, -0.275], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_1_47.add(mesh_platform_post_left_1_47);
  meshes["platform-post-left-1"] = mesh_platform_post_left_1_47;
  colliders["platform-post-left-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_left_1_47);

  const endpoint_platform_post_left_2_48 = makeAttachmentEndpoint(null);
  const node_platform_post_left_2_48 = new THREE.Group();
  node_platform_post_left_2_48.name = "PlatformPostLeft2__pivot";
  node_platform_post_left_2_48.scale.set(1, 1, 1);
  if (endpoint_platform_post_left_2_48) {
    node_platform_post_left_2_48.position.copy(endpoint_platform_post_left_2_48.start);
    node_platform_post_left_2_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_left_2_48.position.set(-0.18, 0.25, 0.0);
    node_platform_post_left_2_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_left_2_48.userData.sculptComponent = {"id": "platform-post-left-2", "name": "PlatformPostLeft2", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, 0.0], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_2_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-left"] ?? root).add(node_platform_post_left_2_48);
  nodes["platform-post-left-2"] = node_platform_post_left_2_48;
  const mesh_platform_post_left_2_48Geometry = endpoint_platform_post_left_2_48
    ? new THREE.CylinderGeometry(endpoint_platform_post_left_2_48.endRadius, endpoint_platform_post_left_2_48.baseRadius, endpoint_platform_post_left_2_48.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_left_2_48) {
    mesh_platform_post_left_2_48Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_left_2_48 = new THREE.Mesh(
    mesh_platform_post_left_2_48Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_left_2_48.name = "PlatformPostLeft2";
  if (endpoint_platform_post_left_2_48) {
    mesh_platform_post_left_2_48.position.copy(endpoint_platform_post_left_2_48.midpoint);
    mesh_platform_post_left_2_48.quaternion.copy(endpoint_platform_post_left_2_48.quaternion);
  }
  mesh_platform_post_left_2_48.castShadow = options.castShadow ?? true;
  mesh_platform_post_left_2_48.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_left_2_48.userData.sculptComponent = {"id": "platform-post-left-2", "name": "PlatformPostLeft2", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, 0.0], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_2_48.add(mesh_platform_post_left_2_48);
  meshes["platform-post-left-2"] = mesh_platform_post_left_2_48;
  colliders["platform-post-left-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_left_2_48);

  const endpoint_platform_post_left_3_49 = makeAttachmentEndpoint(null);
  const node_platform_post_left_3_49 = new THREE.Group();
  node_platform_post_left_3_49.name = "PlatformPostLeft3__pivot";
  node_platform_post_left_3_49.scale.set(1, 1, 1);
  if (endpoint_platform_post_left_3_49) {
    node_platform_post_left_3_49.position.copy(endpoint_platform_post_left_3_49.start);
    node_platform_post_left_3_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_left_3_49.position.set(-0.18, 0.25, 0.275);
    node_platform_post_left_3_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_left_3_49.userData.sculptComponent = {"id": "platform-post-left-3", "name": "PlatformPostLeft3", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, 0.275], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_3_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-left"] ?? root).add(node_platform_post_left_3_49);
  nodes["platform-post-left-3"] = node_platform_post_left_3_49;
  const mesh_platform_post_left_3_49Geometry = endpoint_platform_post_left_3_49
    ? new THREE.CylinderGeometry(endpoint_platform_post_left_3_49.endRadius, endpoint_platform_post_left_3_49.baseRadius, endpoint_platform_post_left_3_49.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_left_3_49) {
    mesh_platform_post_left_3_49Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_left_3_49 = new THREE.Mesh(
    mesh_platform_post_left_3_49Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_left_3_49.name = "PlatformPostLeft3";
  if (endpoint_platform_post_left_3_49) {
    mesh_platform_post_left_3_49.position.copy(endpoint_platform_post_left_3_49.midpoint);
    mesh_platform_post_left_3_49.quaternion.copy(endpoint_platform_post_left_3_49.quaternion);
  }
  mesh_platform_post_left_3_49.castShadow = options.castShadow ?? true;
  mesh_platform_post_left_3_49.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_left_3_49.userData.sculptComponent = {"id": "platform-post-left-3", "name": "PlatformPostLeft3", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, 0.275], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_3_49.add(mesh_platform_post_left_3_49);
  meshes["platform-post-left-3"] = mesh_platform_post_left_3_49;
  colliders["platform-post-left-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_left_3_49);

  const endpoint_platform_post_left_4_50 = makeAttachmentEndpoint(null);
  const node_platform_post_left_4_50 = new THREE.Group();
  node_platform_post_left_4_50.name = "PlatformPostLeft4__pivot";
  node_platform_post_left_4_50.scale.set(1, 1, 1);
  if (endpoint_platform_post_left_4_50) {
    node_platform_post_left_4_50.position.copy(endpoint_platform_post_left_4_50.start);
    node_platform_post_left_4_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_left_4_50.position.set(-0.18, 0.25, 0.55);
    node_platform_post_left_4_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_left_4_50.userData.sculptComponent = {"id": "platform-post-left-4", "name": "PlatformPostLeft4", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, 0.55], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_4_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-left"] ?? root).add(node_platform_post_left_4_50);
  nodes["platform-post-left-4"] = node_platform_post_left_4_50;
  const mesh_platform_post_left_4_50Geometry = endpoint_platform_post_left_4_50
    ? new THREE.CylinderGeometry(endpoint_platform_post_left_4_50.endRadius, endpoint_platform_post_left_4_50.baseRadius, endpoint_platform_post_left_4_50.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_left_4_50) {
    mesh_platform_post_left_4_50Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_left_4_50 = new THREE.Mesh(
    mesh_platform_post_left_4_50Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_left_4_50.name = "PlatformPostLeft4";
  if (endpoint_platform_post_left_4_50) {
    mesh_platform_post_left_4_50.position.copy(endpoint_platform_post_left_4_50.midpoint);
    mesh_platform_post_left_4_50.quaternion.copy(endpoint_platform_post_left_4_50.quaternion);
  }
  mesh_platform_post_left_4_50.castShadow = options.castShadow ?? true;
  mesh_platform_post_left_4_50.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_left_4_50.userData.sculptComponent = {"id": "platform-post-left-4", "name": "PlatformPostLeft4", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.25, 0.55], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_left_4_50.add(mesh_platform_post_left_4_50);
  meshes["platform-post-left-4"] = mesh_platform_post_left_4_50;
  colliders["platform-post-left-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_left_4_50);

  const endpoint_platform_toprail_left_51 = makeAttachmentEndpoint(null);
  const node_platform_toprail_left_51 = new THREE.Group();
  node_platform_toprail_left_51.name = "PlatformTopRailLeft__pivot";
  node_platform_toprail_left_51.scale.set(1, 1, 1);
  if (endpoint_platform_toprail_left_51) {
    node_platform_toprail_left_51.position.copy(endpoint_platform_toprail_left_51.start);
    node_platform_toprail_left_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_toprail_left_51.position.set(-0.18, 0.49, 0.0);
    node_platform_toprail_left_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_toprail_left_51.userData.sculptComponent = {"id": "platform-toprail-left", "name": "PlatformTopRailLeft", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.04, "depth": 1.15, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.49, 0], "rotation": [0, 0, 0], "scale": [0.04, 0.04, 1.15]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Horizontal top rail connecting posts", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_toprail_left_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-left"] ?? root).add(node_platform_toprail_left_51);
  nodes["platform-toprail-left"] = node_platform_toprail_left_51;
  const mesh_platform_toprail_left_51Geometry = endpoint_platform_toprail_left_51
    ? new THREE.CylinderGeometry(endpoint_platform_toprail_left_51.endRadius, endpoint_platform_toprail_left_51.baseRadius, endpoint_platform_toprail_left_51.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_toprail_left_51) {
    mesh_platform_toprail_left_51Geometry.scale(0.04, 0.04, 1.15);
  }
  const mesh_platform_toprail_left_51 = new THREE.Mesh(
    mesh_platform_toprail_left_51Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_toprail_left_51.name = "PlatformTopRailLeft";
  if (endpoint_platform_toprail_left_51) {
    mesh_platform_toprail_left_51.position.copy(endpoint_platform_toprail_left_51.midpoint);
    mesh_platform_toprail_left_51.quaternion.copy(endpoint_platform_toprail_left_51.quaternion);
  }
  mesh_platform_toprail_left_51.castShadow = options.castShadow ?? true;
  mesh_platform_toprail_left_51.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_toprail_left_51.userData.sculptComponent = {"id": "platform-toprail-left", "name": "PlatformTopRailLeft", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-left", "attachment": {"parentId": "platform-left", "parentSocket": "platform-left-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.04, "depth": 1.15, "units": "world", "confidence": 0.8}, "transform": {"position": [-0.18, 0.49, 0], "rotation": [0, 0, 0], "scale": [0.04, 0.04, 1.15]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Horizontal top rail connecting posts", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_toprail_left_51.add(mesh_platform_toprail_left_51);
  meshes["platform-toprail-left"] = mesh_platform_toprail_left_51;
  colliders["platform-toprail-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_toprail_left_51);

  const endpoint_platform_post_right_0_52 = makeAttachmentEndpoint(null);
  const node_platform_post_right_0_52 = new THREE.Group();
  node_platform_post_right_0_52.name = "PlatformPostRight0__pivot";
  node_platform_post_right_0_52.scale.set(1, 1, 1);
  if (endpoint_platform_post_right_0_52) {
    node_platform_post_right_0_52.position.copy(endpoint_platform_post_right_0_52.start);
    node_platform_post_right_0_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_right_0_52.position.set(0.18, 0.25, -0.55);
    node_platform_post_right_0_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_right_0_52.userData.sculptComponent = {"id": "platform-post-right-0", "name": "PlatformPostRight0", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, -0.55], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_0_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-right"] ?? root).add(node_platform_post_right_0_52);
  nodes["platform-post-right-0"] = node_platform_post_right_0_52;
  const mesh_platform_post_right_0_52Geometry = endpoint_platform_post_right_0_52
    ? new THREE.CylinderGeometry(endpoint_platform_post_right_0_52.endRadius, endpoint_platform_post_right_0_52.baseRadius, endpoint_platform_post_right_0_52.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_right_0_52) {
    mesh_platform_post_right_0_52Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_right_0_52 = new THREE.Mesh(
    mesh_platform_post_right_0_52Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_right_0_52.name = "PlatformPostRight0";
  if (endpoint_platform_post_right_0_52) {
    mesh_platform_post_right_0_52.position.copy(endpoint_platform_post_right_0_52.midpoint);
    mesh_platform_post_right_0_52.quaternion.copy(endpoint_platform_post_right_0_52.quaternion);
  }
  mesh_platform_post_right_0_52.castShadow = options.castShadow ?? true;
  mesh_platform_post_right_0_52.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_right_0_52.userData.sculptComponent = {"id": "platform-post-right-0", "name": "PlatformPostRight0", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, -0.55], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_0_52.add(mesh_platform_post_right_0_52);
  meshes["platform-post-right-0"] = mesh_platform_post_right_0_52;
  colliders["platform-post-right-0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_right_0_52);

  const endpoint_platform_post_right_1_53 = makeAttachmentEndpoint(null);
  const node_platform_post_right_1_53 = new THREE.Group();
  node_platform_post_right_1_53.name = "PlatformPostRight1__pivot";
  node_platform_post_right_1_53.scale.set(1, 1, 1);
  if (endpoint_platform_post_right_1_53) {
    node_platform_post_right_1_53.position.copy(endpoint_platform_post_right_1_53.start);
    node_platform_post_right_1_53.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_right_1_53.position.set(0.18, 0.25, -0.275);
    node_platform_post_right_1_53.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_right_1_53.userData.sculptComponent = {"id": "platform-post-right-1", "name": "PlatformPostRight1", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, -0.275], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_1_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-right"] ?? root).add(node_platform_post_right_1_53);
  nodes["platform-post-right-1"] = node_platform_post_right_1_53;
  const mesh_platform_post_right_1_53Geometry = endpoint_platform_post_right_1_53
    ? new THREE.CylinderGeometry(endpoint_platform_post_right_1_53.endRadius, endpoint_platform_post_right_1_53.baseRadius, endpoint_platform_post_right_1_53.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_right_1_53) {
    mesh_platform_post_right_1_53Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_right_1_53 = new THREE.Mesh(
    mesh_platform_post_right_1_53Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_right_1_53.name = "PlatformPostRight1";
  if (endpoint_platform_post_right_1_53) {
    mesh_platform_post_right_1_53.position.copy(endpoint_platform_post_right_1_53.midpoint);
    mesh_platform_post_right_1_53.quaternion.copy(endpoint_platform_post_right_1_53.quaternion);
  }
  mesh_platform_post_right_1_53.castShadow = options.castShadow ?? true;
  mesh_platform_post_right_1_53.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_right_1_53.userData.sculptComponent = {"id": "platform-post-right-1", "name": "PlatformPostRight1", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, -0.275], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_1_53.add(mesh_platform_post_right_1_53);
  meshes["platform-post-right-1"] = mesh_platform_post_right_1_53;
  colliders["platform-post-right-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_right_1_53);

  const endpoint_platform_post_right_2_54 = makeAttachmentEndpoint(null);
  const node_platform_post_right_2_54 = new THREE.Group();
  node_platform_post_right_2_54.name = "PlatformPostRight2__pivot";
  node_platform_post_right_2_54.scale.set(1, 1, 1);
  if (endpoint_platform_post_right_2_54) {
    node_platform_post_right_2_54.position.copy(endpoint_platform_post_right_2_54.start);
    node_platform_post_right_2_54.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_right_2_54.position.set(0.18, 0.25, 0.0);
    node_platform_post_right_2_54.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_right_2_54.userData.sculptComponent = {"id": "platform-post-right-2", "name": "PlatformPostRight2", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, 0.0], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_2_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-right"] ?? root).add(node_platform_post_right_2_54);
  nodes["platform-post-right-2"] = node_platform_post_right_2_54;
  const mesh_platform_post_right_2_54Geometry = endpoint_platform_post_right_2_54
    ? new THREE.CylinderGeometry(endpoint_platform_post_right_2_54.endRadius, endpoint_platform_post_right_2_54.baseRadius, endpoint_platform_post_right_2_54.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_right_2_54) {
    mesh_platform_post_right_2_54Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_right_2_54 = new THREE.Mesh(
    mesh_platform_post_right_2_54Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_right_2_54.name = "PlatformPostRight2";
  if (endpoint_platform_post_right_2_54) {
    mesh_platform_post_right_2_54.position.copy(endpoint_platform_post_right_2_54.midpoint);
    mesh_platform_post_right_2_54.quaternion.copy(endpoint_platform_post_right_2_54.quaternion);
  }
  mesh_platform_post_right_2_54.castShadow = options.castShadow ?? true;
  mesh_platform_post_right_2_54.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_right_2_54.userData.sculptComponent = {"id": "platform-post-right-2", "name": "PlatformPostRight2", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, 0.0], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_2_54.add(mesh_platform_post_right_2_54);
  meshes["platform-post-right-2"] = mesh_platform_post_right_2_54;
  colliders["platform-post-right-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_right_2_54);

  const endpoint_platform_post_right_3_55 = makeAttachmentEndpoint(null);
  const node_platform_post_right_3_55 = new THREE.Group();
  node_platform_post_right_3_55.name = "PlatformPostRight3__pivot";
  node_platform_post_right_3_55.scale.set(1, 1, 1);
  if (endpoint_platform_post_right_3_55) {
    node_platform_post_right_3_55.position.copy(endpoint_platform_post_right_3_55.start);
    node_platform_post_right_3_55.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_right_3_55.position.set(0.18, 0.25, 0.275);
    node_platform_post_right_3_55.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_right_3_55.userData.sculptComponent = {"id": "platform-post-right-3", "name": "PlatformPostRight3", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, 0.275], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_3_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-right"] ?? root).add(node_platform_post_right_3_55);
  nodes["platform-post-right-3"] = node_platform_post_right_3_55;
  const mesh_platform_post_right_3_55Geometry = endpoint_platform_post_right_3_55
    ? new THREE.CylinderGeometry(endpoint_platform_post_right_3_55.endRadius, endpoint_platform_post_right_3_55.baseRadius, endpoint_platform_post_right_3_55.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_right_3_55) {
    mesh_platform_post_right_3_55Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_right_3_55 = new THREE.Mesh(
    mesh_platform_post_right_3_55Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_right_3_55.name = "PlatformPostRight3";
  if (endpoint_platform_post_right_3_55) {
    mesh_platform_post_right_3_55.position.copy(endpoint_platform_post_right_3_55.midpoint);
    mesh_platform_post_right_3_55.quaternion.copy(endpoint_platform_post_right_3_55.quaternion);
  }
  mesh_platform_post_right_3_55.castShadow = options.castShadow ?? true;
  mesh_platform_post_right_3_55.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_right_3_55.userData.sculptComponent = {"id": "platform-post-right-3", "name": "PlatformPostRight3", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, 0.275], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_3_55.add(mesh_platform_post_right_3_55);
  meshes["platform-post-right-3"] = mesh_platform_post_right_3_55;
  colliders["platform-post-right-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_right_3_55);

  const endpoint_platform_post_right_4_56 = makeAttachmentEndpoint(null);
  const node_platform_post_right_4_56 = new THREE.Group();
  node_platform_post_right_4_56.name = "PlatformPostRight4__pivot";
  node_platform_post_right_4_56.scale.set(1, 1, 1);
  if (endpoint_platform_post_right_4_56) {
    node_platform_post_right_4_56.position.copy(endpoint_platform_post_right_4_56.start);
    node_platform_post_right_4_56.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_post_right_4_56.position.set(0.18, 0.25, 0.55);
    node_platform_post_right_4_56.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_post_right_4_56.userData.sculptComponent = {"id": "platform-post-right-4", "name": "PlatformPostRight4", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, 0.55], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_4_56.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-right"] ?? root).add(node_platform_post_right_4_56);
  nodes["platform-post-right-4"] = node_platform_post_right_4_56;
  const mesh_platform_post_right_4_56Geometry = endpoint_platform_post_right_4_56
    ? new THREE.CylinderGeometry(endpoint_platform_post_right_4_56.endRadius, endpoint_platform_post_right_4_56.baseRadius, endpoint_platform_post_right_4_56.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_post_right_4_56) {
    mesh_platform_post_right_4_56Geometry.scale(0.03, 0.45, 0.03);
  }
  const mesh_platform_post_right_4_56 = new THREE.Mesh(
    mesh_platform_post_right_4_56Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_post_right_4_56.name = "PlatformPostRight4";
  if (endpoint_platform_post_right_4_56) {
    mesh_platform_post_right_4_56.position.copy(endpoint_platform_post_right_4_56.midpoint);
    mesh_platform_post_right_4_56.quaternion.copy(endpoint_platform_post_right_4_56.quaternion);
  }
  mesh_platform_post_right_4_56.castShadow = options.castShadow ?? true;
  mesh_platform_post_right_4_56.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_post_right_4_56.userData.sculptComponent = {"id": "platform-post-right-4", "name": "PlatformPostRight4", "level": "meso", "role": "railing", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.03, "height": 0.45, "depth": 0.03, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.25, 0.55], "rotation": [0, 0, 0], "scale": [0.03, 0.45, 0.03]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Thin vertical iron railing post", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_post_right_4_56.add(mesh_platform_post_right_4_56);
  meshes["platform-post-right-4"] = mesh_platform_post_right_4_56;
  colliders["platform-post-right-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_post_right_4_56);

  const endpoint_platform_toprail_right_57 = makeAttachmentEndpoint(null);
  const node_platform_toprail_right_57 = new THREE.Group();
  node_platform_toprail_right_57.name = "PlatformTopRailRight__pivot";
  node_platform_toprail_right_57.scale.set(1, 1, 1);
  if (endpoint_platform_toprail_right_57) {
    node_platform_toprail_right_57.position.copy(endpoint_platform_toprail_right_57.start);
    node_platform_toprail_right_57.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_platform_toprail_right_57.position.set(0.18, 0.49, 0.0);
    node_platform_toprail_right_57.rotation.set(0.0, 0.0, 0.0);
  }
  node_platform_toprail_right_57.userData.sculptComponent = {"id": "platform-toprail-right", "name": "PlatformTopRailRight", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.04, "depth": 1.15, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.49, 0], "rotation": [0, 0, 0], "scale": [0.04, 0.04, 1.15]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Horizontal top rail connecting posts", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_toprail_right_57.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["platform-right"] ?? root).add(node_platform_toprail_right_57);
  nodes["platform-toprail-right"] = node_platform_toprail_right_57;
  const mesh_platform_toprail_right_57Geometry = endpoint_platform_toprail_right_57
    ? new THREE.CylinderGeometry(endpoint_platform_toprail_right_57.endRadius, endpoint_platform_toprail_right_57.baseRadius, endpoint_platform_toprail_right_57.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_platform_toprail_right_57) {
    mesh_platform_toprail_right_57Geometry.scale(0.04, 0.04, 1.15);
  }
  const mesh_platform_toprail_right_57 = new THREE.Mesh(
    mesh_platform_toprail_right_57Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_platform_toprail_right_57.name = "PlatformTopRailRight";
  if (endpoint_platform_toprail_right_57) {
    mesh_platform_toprail_right_57.position.copy(endpoint_platform_toprail_right_57.midpoint);
    mesh_platform_toprail_right_57.quaternion.copy(endpoint_platform_toprail_right_57.quaternion);
  }
  mesh_platform_toprail_right_57.castShadow = options.castShadow ?? true;
  mesh_platform_toprail_right_57.receiveShadow = options.receiveShadow ?? true;
  mesh_platform_toprail_right_57.userData.sculptComponent = {"id": "platform-toprail-right", "name": "PlatformTopRailRight", "level": "meso", "role": "railing", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "platform-right", "attachment": {"parentId": "platform-right", "parentSocket": "platform-right-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.04, "height": 0.04, "depth": 1.15, "units": "world", "confidence": 0.8}, "transform": {"position": [0.18, 0.49, 0], "rotation": [0, 0, 0], "scale": [0.04, 0.04, 1.15]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Horizontal top rail connecting posts", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "roof-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_platform_toprail_right_57.add(mesh_platform_toprail_right_57);
  meshes["platform-toprail-right"] = mesh_platform_toprail_right_57;
  colliders["platform-toprail-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["roof-deck"] ??= [];
  destructionGroups["roof-deck"].push(node_platform_toprail_right_57);

  const endpoint_window_01m_58 = makeAttachmentEndpoint(null);
  const node_window_01m_58 = new THREE.Group();
  node_window_01m_58.name = "Window01Mirror__pivot";
  node_window_01m_58.scale.set(1, 1, 1);
  if (endpoint_window_01m_58) {
    node_window_01m_58.position.copy(endpoint_window_01m_58.start);
    node_window_01m_58.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01m_58.position.set(-1.05, 0.0, -0.71);
    node_window_01m_58.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01m_58.userData.sculptComponent = {"id": "window-01m", "name": "Window01Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.05, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01m_58.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_01m_58);
  nodes["window-01m"] = node_window_01m_58;
  const mesh_window_01m_58Geometry = endpoint_window_01m_58
    ? new THREE.CylinderGeometry(endpoint_window_01m_58.endRadius, endpoint_window_01m_58.baseRadius, endpoint_window_01m_58.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01m_58) {
    mesh_window_01m_58Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_01m_58 = new THREE.Mesh(
    mesh_window_01m_58Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01m_58.name = "Window01Mirror";
  if (endpoint_window_01m_58) {
    mesh_window_01m_58.position.copy(endpoint_window_01m_58.midpoint);
    mesh_window_01m_58.quaternion.copy(endpoint_window_01m_58.quaternion);
  }
  mesh_window_01m_58.castShadow = options.castShadow ?? true;
  mesh_window_01m_58.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01m_58.visible = false; // 容器节点不渲染
  mesh_window_01m_58.userData.sculptComponent = {"id": "window-01m", "name": "Window01Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-1.05, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window01 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01m_58.add(mesh_window_01m_58);
  meshes["window-01m"] = mesh_window_01m_58;
  colliders["window-01m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01"] ??= [];
  destructionGroups["window-01"].push(node_window_01m_58);

  const endpoint_window_01_framem_59 = makeAttachmentEndpoint(null);
  const node_window_01_framem_59 = new THREE.Group();
  node_window_01_framem_59.name = "Window01FrameMirror__pivot";
  node_window_01_framem_59.scale.set(1, 1, 1);
  if (endpoint_window_01_framem_59) {
    node_window_01_framem_59.position.copy(endpoint_window_01_framem_59.start);
    node_window_01_framem_59.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01_framem_59.position.set(0.0, 0.0, 0.0);
    node_window_01_framem_59.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01_framem_59.userData.sculptComponent = {"id": "window-01-framem", "name": "Window01FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_framem_59.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_01_framem_59);
  nodes["window-01-framem"] = node_window_01_framem_59;
  const mesh_window_01_framem_59Geometry = endpoint_window_01_framem_59
    ? new THREE.CylinderGeometry(endpoint_window_01_framem_59.endRadius, endpoint_window_01_framem_59.baseRadius, endpoint_window_01_framem_59.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_framem_59) {
    mesh_window_01_framem_59Geometry.scale(0.56, 0.62, 0.05);
  }
  const mesh_window_01_framem_59 = new THREE.Mesh(
    mesh_window_01_framem_59Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_framem_59.name = "Window01FrameMirror";
  if (endpoint_window_01_framem_59) {
    mesh_window_01_framem_59.position.copy(endpoint_window_01_framem_59.midpoint);
    mesh_window_01_framem_59.quaternion.copy(endpoint_window_01_framem_59.quaternion);
  }
  mesh_window_01_framem_59.castShadow = options.castShadow ?? true;
  mesh_window_01_framem_59.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_framem_59.userData.sculptComponent = {"id": "window-01-framem", "name": "Window01FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Frame solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_framem_59.add(mesh_window_01_framem_59);
  meshes["window-01-framem"] = mesh_window_01_framem_59;
  colliders["window-01-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-frame"] ??= [];
  destructionGroups["window-01-frame"].push(node_window_01_framem_59);

  const endpoint_window_01_glassm_60 = makeAttachmentEndpoint(null);
  const node_window_01_glassm_60 = new THREE.Group();
  node_window_01_glassm_60.name = "Window01GlassMirror__pivot";
  node_window_01_glassm_60.scale.set(1, 1, 1);
  if (endpoint_window_01_glassm_60) {
    node_window_01_glassm_60.position.copy(endpoint_window_01_glassm_60.start);
    node_window_01_glassm_60.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01_glassm_60.position.set(0.0, 0.0, 0.03);
    node_window_01_glassm_60.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01_glassm_60.userData.sculptComponent = {"id": "window-01-glassm", "name": "Window01GlassMirror", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 3.14159, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glassm_60.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_01_glassm_60);
  nodes["window-01-glassm"] = node_window_01_glassm_60;
  const mesh_window_01_glassm_60Geometry = endpoint_window_01_glassm_60
    ? new THREE.CylinderGeometry(endpoint_window_01_glassm_60.endRadius, endpoint_window_01_glassm_60.baseRadius, endpoint_window_01_glassm_60.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_glassm_60) {
    mesh_window_01_glassm_60Geometry.scale(0.48, 0.54, 0.01);
  }
  const mesh_window_01_glassm_60 = new THREE.Mesh(
    mesh_window_01_glassm_60Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_glassm_60.name = "Window01GlassMirror";
  if (endpoint_window_01_glassm_60) {
    mesh_window_01_glassm_60.position.copy(endpoint_window_01_glassm_60.midpoint);
    mesh_window_01_glassm_60.quaternion.copy(endpoint_window_01_glassm_60.quaternion);
  }
  mesh_window_01_glassm_60.castShadow = options.castShadow ?? true;
  mesh_window_01_glassm_60.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_glassm_60.userData.sculptComponent = {"id": "window-01-glassm", "name": "Window01GlassMirror", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 3.14159, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Glass solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_glassm_60.add(mesh_window_01_glassm_60);
  meshes["window-01-glassm"] = mesh_window_01_glassm_60;
  colliders["window-01-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-glass"] ??= [];
  destructionGroups["window-01-glass"].push(node_window_01_glassm_60);

  const endpoint_window_01_curtainm_61 = makeAttachmentEndpoint(null);
  const node_window_01_curtainm_61 = new THREE.Group();
  node_window_01_curtainm_61.name = "Window01CurtainMirror__pivot";
  node_window_01_curtainm_61.scale.set(1, 1, 1);
  if (endpoint_window_01_curtainm_61) {
    node_window_01_curtainm_61.position.copy(endpoint_window_01_curtainm_61.start);
    node_window_01_curtainm_61.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_01_curtainm_61.position.set(0.0, 0.05, 0.045);
    node_window_01_curtainm_61.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_01_curtainm_61.userData.sculptComponent = {"id": "window-01-curtainm", "name": "Window01CurtainMirror", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Curtain solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_curtainm_61.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-01m"] ?? root).add(node_window_01_curtainm_61);
  nodes["window-01-curtainm"] = node_window_01_curtainm_61;
  const mesh_window_01_curtainm_61Geometry = endpoint_window_01_curtainm_61
    ? new THREE.CylinderGeometry(endpoint_window_01_curtainm_61.endRadius, endpoint_window_01_curtainm_61.baseRadius, endpoint_window_01_curtainm_61.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_01_curtainm_61) {
    mesh_window_01_curtainm_61Geometry.scale(0.44, 0.4, 0.015);
  }
  const mesh_window_01_curtainm_61 = new THREE.Mesh(
    mesh_window_01_curtainm_61Geometry,
    materialMap["curtain-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_01_curtainm_61.name = "Window01CurtainMirror";
  if (endpoint_window_01_curtainm_61) {
    mesh_window_01_curtainm_61.position.copy(endpoint_window_01_curtainm_61.midpoint);
    mesh_window_01_curtainm_61.quaternion.copy(endpoint_window_01_curtainm_61.quaternion);
  }
  mesh_window_01_curtainm_61.castShadow = options.castShadow ?? true;
  mesh_window_01_curtainm_61.receiveShadow = options.receiveShadow ?? true;
  mesh_window_01_curtainm_61.userData.sculptComponent = {"id": "window-01-curtainm", "name": "Window01CurtainMirror", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-01m", "attachment": {"parentId": "window-01m", "parentSocket": "window-01-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window01Curtain solid geometry attached to window-01", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-01-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_01_curtainm_61.add(mesh_window_01_curtainm_61);
  meshes["window-01-curtainm"] = mesh_window_01_curtainm_61;
  colliders["window-01-curtainm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-01-curtain"] ??= [];
  destructionGroups["window-01-curtain"].push(node_window_01_curtainm_61);

  const endpoint_window_02m_62 = makeAttachmentEndpoint(null);
  const node_window_02m_62 = new THREE.Group();
  node_window_02m_62.name = "Window02Mirror__pivot";
  node_window_02m_62.scale.set(1, 1, 1);
  if (endpoint_window_02m_62) {
    node_window_02m_62.position.copy(endpoint_window_02m_62.start);
    node_window_02m_62.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02m_62.position.set(-0.35, 0.0, -0.71);
    node_window_02m_62.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02m_62.userData.sculptComponent = {"id": "window-02m", "name": "Window02Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.35, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02m_62.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_02m_62);
  nodes["window-02m"] = node_window_02m_62;
  const mesh_window_02m_62Geometry = endpoint_window_02m_62
    ? new THREE.CylinderGeometry(endpoint_window_02m_62.endRadius, endpoint_window_02m_62.baseRadius, endpoint_window_02m_62.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02m_62) {
    mesh_window_02m_62Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_02m_62 = new THREE.Mesh(
    mesh_window_02m_62Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02m_62.name = "Window02Mirror";
  if (endpoint_window_02m_62) {
    mesh_window_02m_62.position.copy(endpoint_window_02m_62.midpoint);
    mesh_window_02m_62.quaternion.copy(endpoint_window_02m_62.quaternion);
  }
  mesh_window_02m_62.castShadow = options.castShadow ?? true;
  mesh_window_02m_62.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02m_62.visible = false; // 容器节点不渲染
  mesh_window_02m_62.userData.sculptComponent = {"id": "window-02m", "name": "Window02Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.35, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window02 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02m_62.add(mesh_window_02m_62);
  meshes["window-02m"] = mesh_window_02m_62;
  colliders["window-02m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02"] ??= [];
  destructionGroups["window-02"].push(node_window_02m_62);

  const endpoint_window_02_framem_63 = makeAttachmentEndpoint(null);
  const node_window_02_framem_63 = new THREE.Group();
  node_window_02_framem_63.name = "Window02FrameMirror__pivot";
  node_window_02_framem_63.scale.set(1, 1, 1);
  if (endpoint_window_02_framem_63) {
    node_window_02_framem_63.position.copy(endpoint_window_02_framem_63.start);
    node_window_02_framem_63.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_framem_63.position.set(0.0, 0.0, 0.0);
    node_window_02_framem_63.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_framem_63.userData.sculptComponent = {"id": "window-02-framem", "name": "Window02FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_framem_63.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_framem_63);
  nodes["window-02-framem"] = node_window_02_framem_63;
  const mesh_window_02_framem_63Geometry = endpoint_window_02_framem_63
    ? new THREE.CylinderGeometry(endpoint_window_02_framem_63.endRadius, endpoint_window_02_framem_63.baseRadius, endpoint_window_02_framem_63.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_framem_63) {
    mesh_window_02_framem_63Geometry.scale(0.56, 0.62, 0.05);
  }
  const mesh_window_02_framem_63 = new THREE.Mesh(
    mesh_window_02_framem_63Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_framem_63.name = "Window02FrameMirror";
  if (endpoint_window_02_framem_63) {
    mesh_window_02_framem_63.position.copy(endpoint_window_02_framem_63.midpoint);
    mesh_window_02_framem_63.quaternion.copy(endpoint_window_02_framem_63.quaternion);
  }
  mesh_window_02_framem_63.castShadow = options.castShadow ?? true;
  mesh_window_02_framem_63.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_framem_63.userData.sculptComponent = {"id": "window-02-framem", "name": "Window02FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Frame solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_framem_63.add(mesh_window_02_framem_63);
  meshes["window-02-framem"] = mesh_window_02_framem_63;
  colliders["window-02-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-frame"] ??= [];
  destructionGroups["window-02-frame"].push(node_window_02_framem_63);

  const endpoint_window_02_glassm_64 = makeAttachmentEndpoint(null);
  const node_window_02_glassm_64 = new THREE.Group();
  node_window_02_glassm_64.name = "Window02GlassMirror__pivot";
  node_window_02_glassm_64.scale.set(1, 1, 1);
  if (endpoint_window_02_glassm_64) {
    node_window_02_glassm_64.position.copy(endpoint_window_02_glassm_64.start);
    node_window_02_glassm_64.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_glassm_64.position.set(0.0, 0.0, 0.03);
    node_window_02_glassm_64.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_glassm_64.userData.sculptComponent = {"id": "window-02-glassm", "name": "Window02GlassMirror", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 3.14159, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glassm_64.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_glassm_64);
  nodes["window-02-glassm"] = node_window_02_glassm_64;
  const mesh_window_02_glassm_64Geometry = endpoint_window_02_glassm_64
    ? new THREE.CylinderGeometry(endpoint_window_02_glassm_64.endRadius, endpoint_window_02_glassm_64.baseRadius, endpoint_window_02_glassm_64.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_glassm_64) {
    mesh_window_02_glassm_64Geometry.scale(0.48, 0.54, 0.01);
  }
  const mesh_window_02_glassm_64 = new THREE.Mesh(
    mesh_window_02_glassm_64Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_glassm_64.name = "Window02GlassMirror";
  if (endpoint_window_02_glassm_64) {
    mesh_window_02_glassm_64.position.copy(endpoint_window_02_glassm_64.midpoint);
    mesh_window_02_glassm_64.quaternion.copy(endpoint_window_02_glassm_64.quaternion);
  }
  mesh_window_02_glassm_64.castShadow = options.castShadow ?? true;
  mesh_window_02_glassm_64.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_glassm_64.userData.sculptComponent = {"id": "window-02-glassm", "name": "Window02GlassMirror", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 3.14159, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Glass solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_glassm_64.add(mesh_window_02_glassm_64);
  meshes["window-02-glassm"] = mesh_window_02_glassm_64;
  colliders["window-02-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-glass"] ??= [];
  destructionGroups["window-02-glass"].push(node_window_02_glassm_64);

  const endpoint_window_02_curtainm_65 = makeAttachmentEndpoint(null);
  const node_window_02_curtainm_65 = new THREE.Group();
  node_window_02_curtainm_65.name = "Window02CurtainMirror__pivot";
  node_window_02_curtainm_65.scale.set(1, 1, 1);
  if (endpoint_window_02_curtainm_65) {
    node_window_02_curtainm_65.position.copy(endpoint_window_02_curtainm_65.start);
    node_window_02_curtainm_65.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_02_curtainm_65.position.set(0.0, 0.05, 0.045);
    node_window_02_curtainm_65.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_02_curtainm_65.userData.sculptComponent = {"id": "window-02-curtainm", "name": "Window02CurtainMirror", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Curtain solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_curtainm_65.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-02m"] ?? root).add(node_window_02_curtainm_65);
  nodes["window-02-curtainm"] = node_window_02_curtainm_65;
  const mesh_window_02_curtainm_65Geometry = endpoint_window_02_curtainm_65
    ? new THREE.CylinderGeometry(endpoint_window_02_curtainm_65.endRadius, endpoint_window_02_curtainm_65.baseRadius, endpoint_window_02_curtainm_65.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_02_curtainm_65) {
    mesh_window_02_curtainm_65Geometry.scale(0.44, 0.4, 0.015);
  }
  const mesh_window_02_curtainm_65 = new THREE.Mesh(
    mesh_window_02_curtainm_65Geometry,
    materialMap["curtain-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_02_curtainm_65.name = "Window02CurtainMirror";
  if (endpoint_window_02_curtainm_65) {
    mesh_window_02_curtainm_65.position.copy(endpoint_window_02_curtainm_65.midpoint);
    mesh_window_02_curtainm_65.quaternion.copy(endpoint_window_02_curtainm_65.quaternion);
  }
  mesh_window_02_curtainm_65.castShadow = options.castShadow ?? true;
  mesh_window_02_curtainm_65.receiveShadow = options.receiveShadow ?? true;
  mesh_window_02_curtainm_65.userData.sculptComponent = {"id": "window-02-curtainm", "name": "Window02CurtainMirror", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-02m", "attachment": {"parentId": "window-02m", "parentSocket": "window-02-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window02Curtain solid geometry attached to window-02", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-02-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_02_curtainm_65.add(mesh_window_02_curtainm_65);
  meshes["window-02-curtainm"] = mesh_window_02_curtainm_65;
  colliders["window-02-curtainm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-02-curtain"] ??= [];
  destructionGroups["window-02-curtain"].push(node_window_02_curtainm_65);

  const endpoint_window_03m_66 = makeAttachmentEndpoint(null);
  const node_window_03m_66 = new THREE.Group();
  node_window_03m_66.name = "Window03Mirror__pivot";
  node_window_03m_66.scale.set(1, 1, 1);
  if (endpoint_window_03m_66) {
    node_window_03m_66.position.copy(endpoint_window_03m_66.start);
    node_window_03m_66.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03m_66.position.set(0.35, 0.0, -0.71);
    node_window_03m_66.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03m_66.userData.sculptComponent = {"id": "window-03m", "name": "Window03Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.35, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03m_66.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_03m_66);
  nodes["window-03m"] = node_window_03m_66;
  const mesh_window_03m_66Geometry = endpoint_window_03m_66
    ? new THREE.CylinderGeometry(endpoint_window_03m_66.endRadius, endpoint_window_03m_66.baseRadius, endpoint_window_03m_66.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03m_66) {
    mesh_window_03m_66Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_03m_66 = new THREE.Mesh(
    mesh_window_03m_66Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03m_66.name = "Window03Mirror";
  if (endpoint_window_03m_66) {
    mesh_window_03m_66.position.copy(endpoint_window_03m_66.midpoint);
    mesh_window_03m_66.quaternion.copy(endpoint_window_03m_66.quaternion);
  }
  mesh_window_03m_66.castShadow = options.castShadow ?? true;
  mesh_window_03m_66.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03m_66.visible = false; // 容器节点不渲染
  mesh_window_03m_66.userData.sculptComponent = {"id": "window-03m", "name": "Window03Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [0.35, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window03 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03m_66.add(mesh_window_03m_66);
  meshes["window-03m"] = mesh_window_03m_66;
  colliders["window-03m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03"] ??= [];
  destructionGroups["window-03"].push(node_window_03m_66);

  const endpoint_window_03_framem_67 = makeAttachmentEndpoint(null);
  const node_window_03_framem_67 = new THREE.Group();
  node_window_03_framem_67.name = "Window03FrameMirror__pivot";
  node_window_03_framem_67.scale.set(1, 1, 1);
  if (endpoint_window_03_framem_67) {
    node_window_03_framem_67.position.copy(endpoint_window_03_framem_67.start);
    node_window_03_framem_67.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_framem_67.position.set(0.0, 0.0, 0.0);
    node_window_03_framem_67.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_framem_67.userData.sculptComponent = {"id": "window-03-framem", "name": "Window03FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_framem_67.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_framem_67);
  nodes["window-03-framem"] = node_window_03_framem_67;
  const mesh_window_03_framem_67Geometry = endpoint_window_03_framem_67
    ? new THREE.CylinderGeometry(endpoint_window_03_framem_67.endRadius, endpoint_window_03_framem_67.baseRadius, endpoint_window_03_framem_67.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_framem_67) {
    mesh_window_03_framem_67Geometry.scale(0.56, 0.62, 0.05);
  }
  const mesh_window_03_framem_67 = new THREE.Mesh(
    mesh_window_03_framem_67Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_framem_67.name = "Window03FrameMirror";
  if (endpoint_window_03_framem_67) {
    mesh_window_03_framem_67.position.copy(endpoint_window_03_framem_67.midpoint);
    mesh_window_03_framem_67.quaternion.copy(endpoint_window_03_framem_67.quaternion);
  }
  mesh_window_03_framem_67.castShadow = options.castShadow ?? true;
  mesh_window_03_framem_67.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_framem_67.userData.sculptComponent = {"id": "window-03-framem", "name": "Window03FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Frame solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_framem_67.add(mesh_window_03_framem_67);
  meshes["window-03-framem"] = mesh_window_03_framem_67;
  colliders["window-03-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-frame"] ??= [];
  destructionGroups["window-03-frame"].push(node_window_03_framem_67);

  const endpoint_window_03_glassm_68 = makeAttachmentEndpoint(null);
  const node_window_03_glassm_68 = new THREE.Group();
  node_window_03_glassm_68.name = "Window03GlassMirror__pivot";
  node_window_03_glassm_68.scale.set(1, 1, 1);
  if (endpoint_window_03_glassm_68) {
    node_window_03_glassm_68.position.copy(endpoint_window_03_glassm_68.start);
    node_window_03_glassm_68.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_glassm_68.position.set(0.0, 0.0, 0.03);
    node_window_03_glassm_68.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_glassm_68.userData.sculptComponent = {"id": "window-03-glassm", "name": "Window03GlassMirror", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 3.14159, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glassm_68.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_glassm_68);
  nodes["window-03-glassm"] = node_window_03_glassm_68;
  const mesh_window_03_glassm_68Geometry = endpoint_window_03_glassm_68
    ? new THREE.CylinderGeometry(endpoint_window_03_glassm_68.endRadius, endpoint_window_03_glassm_68.baseRadius, endpoint_window_03_glassm_68.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_glassm_68) {
    mesh_window_03_glassm_68Geometry.scale(0.48, 0.54, 0.01);
  }
  const mesh_window_03_glassm_68 = new THREE.Mesh(
    mesh_window_03_glassm_68Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_glassm_68.name = "Window03GlassMirror";
  if (endpoint_window_03_glassm_68) {
    mesh_window_03_glassm_68.position.copy(endpoint_window_03_glassm_68.midpoint);
    mesh_window_03_glassm_68.quaternion.copy(endpoint_window_03_glassm_68.quaternion);
  }
  mesh_window_03_glassm_68.castShadow = options.castShadow ?? true;
  mesh_window_03_glassm_68.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_glassm_68.userData.sculptComponent = {"id": "window-03-glassm", "name": "Window03GlassMirror", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 3.14159, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Glass solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_glassm_68.add(mesh_window_03_glassm_68);
  meshes["window-03-glassm"] = mesh_window_03_glassm_68;
  colliders["window-03-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-glass"] ??= [];
  destructionGroups["window-03-glass"].push(node_window_03_glassm_68);

  const endpoint_window_03_curtainm_69 = makeAttachmentEndpoint(null);
  const node_window_03_curtainm_69 = new THREE.Group();
  node_window_03_curtainm_69.name = "Window03CurtainMirror__pivot";
  node_window_03_curtainm_69.scale.set(1, 1, 1);
  if (endpoint_window_03_curtainm_69) {
    node_window_03_curtainm_69.position.copy(endpoint_window_03_curtainm_69.start);
    node_window_03_curtainm_69.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_03_curtainm_69.position.set(0.0, 0.05, 0.045);
    node_window_03_curtainm_69.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_03_curtainm_69.userData.sculptComponent = {"id": "window-03-curtainm", "name": "Window03CurtainMirror", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Curtain solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_curtainm_69.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-03m"] ?? root).add(node_window_03_curtainm_69);
  nodes["window-03-curtainm"] = node_window_03_curtainm_69;
  const mesh_window_03_curtainm_69Geometry = endpoint_window_03_curtainm_69
    ? new THREE.CylinderGeometry(endpoint_window_03_curtainm_69.endRadius, endpoint_window_03_curtainm_69.baseRadius, endpoint_window_03_curtainm_69.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_03_curtainm_69) {
    mesh_window_03_curtainm_69Geometry.scale(0.44, 0.4, 0.015);
  }
  const mesh_window_03_curtainm_69 = new THREE.Mesh(
    mesh_window_03_curtainm_69Geometry,
    materialMap["curtain-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_03_curtainm_69.name = "Window03CurtainMirror";
  if (endpoint_window_03_curtainm_69) {
    mesh_window_03_curtainm_69.position.copy(endpoint_window_03_curtainm_69.midpoint);
    mesh_window_03_curtainm_69.quaternion.copy(endpoint_window_03_curtainm_69.quaternion);
  }
  mesh_window_03_curtainm_69.castShadow = options.castShadow ?? true;
  mesh_window_03_curtainm_69.receiveShadow = options.receiveShadow ?? true;
  mesh_window_03_curtainm_69.userData.sculptComponent = {"id": "window-03-curtainm", "name": "Window03CurtainMirror", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-03m", "attachment": {"parentId": "window-03m", "parentSocket": "window-03-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window03Curtain solid geometry attached to window-03", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-03-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_03_curtainm_69.add(mesh_window_03_curtainm_69);
  meshes["window-03-curtainm"] = mesh_window_03_curtainm_69;
  colliders["window-03-curtainm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-03-curtain"] ??= [];
  destructionGroups["window-03-curtain"].push(node_window_03_curtainm_69);

  const endpoint_window_04m_70 = makeAttachmentEndpoint(null);
  const node_window_04m_70 = new THREE.Group();
  node_window_04m_70.name = "Window04Mirror__pivot";
  node_window_04m_70.scale.set(1, 1, 1);
  if (endpoint_window_04m_70) {
    node_window_04m_70.position.copy(endpoint_window_04m_70.start);
    node_window_04m_70.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04m_70.position.set(1.05, 0.0, -0.71);
    node_window_04m_70.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04m_70.userData.sculptComponent = {"id": "window-04m", "name": "Window04Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.05, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04m_70.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-system"] ?? root).add(node_window_04m_70);
  nodes["window-04m"] = node_window_04m_70;
  const mesh_window_04m_70Geometry = endpoint_window_04m_70
    ? new THREE.CylinderGeometry(endpoint_window_04m_70.endRadius, endpoint_window_04m_70.baseRadius, endpoint_window_04m_70.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04m_70) {
    mesh_window_04m_70Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_04m_70 = new THREE.Mesh(
    mesh_window_04m_70Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04m_70.name = "Window04Mirror";
  if (endpoint_window_04m_70) {
    mesh_window_04m_70.position.copy(endpoint_window_04m_70.midpoint);
    mesh_window_04m_70.quaternion.copy(endpoint_window_04m_70.quaternion);
  }
  mesh_window_04m_70.castShadow = options.castShadow ?? true;
  mesh_window_04m_70.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04m_70.visible = false; // 容器节点不渲染
  mesh_window_04m_70.userData.sculptComponent = {"id": "window-04m", "name": "Window04Mirror", "level": "meso", "role": "window", "importance": 0.75, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-system", "attachment": {"parentId": "window-system", "parentSocket": "window-system-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "world", "confidence": 0.85}, "transform": {"position": [1.05, 0, -0.71], "rotation": [0, 3.14159, 0], "scale": [1, 1, 1]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window04 solid geometry attached to window-system", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04m_70.add(mesh_window_04m_70);
  meshes["window-04m"] = mesh_window_04m_70;
  colliders["window-04m"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04"] ??= [];
  destructionGroups["window-04"].push(node_window_04m_70);

  const endpoint_window_04_framem_71 = makeAttachmentEndpoint(null);
  const node_window_04_framem_71 = new THREE.Group();
  node_window_04_framem_71.name = "Window04FrameMirror__pivot";
  node_window_04_framem_71.scale.set(1, 1, 1);
  if (endpoint_window_04_framem_71) {
    node_window_04_framem_71.position.copy(endpoint_window_04_framem_71.start);
    node_window_04_framem_71.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04_framem_71.position.set(0.0, 0.0, 0.0);
    node_window_04_framem_71.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04_framem_71.userData.sculptComponent = {"id": "window-04-framem", "name": "Window04FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_framem_71.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04m"] ?? root).add(node_window_04_framem_71);
  nodes["window-04-framem"] = node_window_04_framem_71;
  const mesh_window_04_framem_71Geometry = endpoint_window_04_framem_71
    ? new THREE.CylinderGeometry(endpoint_window_04_framem_71.endRadius, endpoint_window_04_framem_71.baseRadius, endpoint_window_04_framem_71.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_framem_71) {
    mesh_window_04_framem_71Geometry.scale(0.56, 0.62, 0.05);
  }
  const mesh_window_04_framem_71 = new THREE.Mesh(
    mesh_window_04_framem_71Geometry,
    materialMap["frame-brown"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_framem_71.name = "Window04FrameMirror";
  if (endpoint_window_04_framem_71) {
    mesh_window_04_framem_71.position.copy(endpoint_window_04_framem_71.midpoint);
    mesh_window_04_framem_71.quaternion.copy(endpoint_window_04_framem_71.quaternion);
  }
  mesh_window_04_framem_71.castShadow = options.castShadow ?? true;
  mesh_window_04_framem_71.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_framem_71.userData.sculptComponent = {"id": "window-04-framem", "name": "Window04FrameMirror", "level": "meso", "role": "window-part", "importance": 0.7, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.56, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 3.14159, 0], "scale": [0.56, 0.62, 0.05]}, "material": "frame-brown", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Frame solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 74, 50, 1.0)", "secondaryAlbedo": "rgba(74, 52, 36, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_framem_71.add(mesh_window_04_framem_71);
  meshes["window-04-framem"] = mesh_window_04_framem_71;
  colliders["window-04-framem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-frame"] ??= [];
  destructionGroups["window-04-frame"].push(node_window_04_framem_71);

  const endpoint_window_04_glassm_72 = makeAttachmentEndpoint(null);
  const node_window_04_glassm_72 = new THREE.Group();
  node_window_04_glassm_72.name = "Window04GlassMirror__pivot";
  node_window_04_glassm_72.scale.set(1, 1, 1);
  if (endpoint_window_04_glassm_72) {
    node_window_04_glassm_72.position.copy(endpoint_window_04_glassm_72.start);
    node_window_04_glassm_72.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04_glassm_72.position.set(0.0, 0.0, 0.03);
    node_window_04_glassm_72.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04_glassm_72.userData.sculptComponent = {"id": "window-04-glassm", "name": "Window04GlassMirror", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 3.14159, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glassm_72.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04m"] ?? root).add(node_window_04_glassm_72);
  nodes["window-04-glassm"] = node_window_04_glassm_72;
  const mesh_window_04_glassm_72Geometry = endpoint_window_04_glassm_72
    ? new THREE.CylinderGeometry(endpoint_window_04_glassm_72.endRadius, endpoint_window_04_glassm_72.baseRadius, endpoint_window_04_glassm_72.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_glassm_72) {
    mesh_window_04_glassm_72Geometry.scale(0.48, 0.54, 0.01);
  }
  const mesh_window_04_glassm_72 = new THREE.Mesh(
    mesh_window_04_glassm_72Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_glassm_72.name = "Window04GlassMirror";
  if (endpoint_window_04_glassm_72) {
    mesh_window_04_glassm_72.position.copy(endpoint_window_04_glassm_72.midpoint);
    mesh_window_04_glassm_72.quaternion.copy(endpoint_window_04_glassm_72.quaternion);
  }
  mesh_window_04_glassm_72.castShadow = options.castShadow ?? true;
  mesh_window_04_glassm_72.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_glassm_72.userData.sculptComponent = {"id": "window-04-glassm", "name": "Window04GlassMirror", "level": "meso", "role": "window-part", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.48, "height": 0.54, "depth": 0.01, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0, 0.03], "rotation": [0, 3.14159, 0], "scale": [0.48, 0.54, 0.01]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Glass solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-glass", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_glassm_72.add(mesh_window_04_glassm_72);
  meshes["window-04-glassm"] = mesh_window_04_glassm_72;
  colliders["window-04-glassm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-glass"] ??= [];
  destructionGroups["window-04-glass"].push(node_window_04_glassm_72);

  const endpoint_window_04_curtainm_73 = makeAttachmentEndpoint(null);
  const node_window_04_curtainm_73 = new THREE.Group();
  node_window_04_curtainm_73.name = "Window04CurtainMirror__pivot";
  node_window_04_curtainm_73.scale.set(1, 1, 1);
  if (endpoint_window_04_curtainm_73) {
    node_window_04_curtainm_73.position.copy(endpoint_window_04_curtainm_73.start);
    node_window_04_curtainm_73.rotation.set(0.0, 3.14159, 0.0);
  } else {
    node_window_04_curtainm_73.position.set(0.0, 0.05, 0.045);
    node_window_04_curtainm_73.rotation.set(0.0, 3.14159, 0.0);
  }
  node_window_04_curtainm_73.userData.sculptComponent = {"id": "window-04-curtainm", "name": "Window04CurtainMirror", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Curtain solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_curtainm_73.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["window-04m"] ?? root).add(node_window_04_curtainm_73);
  nodes["window-04-curtainm"] = node_window_04_curtainm_73;
  const mesh_window_04_curtainm_73Geometry = endpoint_window_04_curtainm_73
    ? new THREE.CylinderGeometry(endpoint_window_04_curtainm_73.endRadius, endpoint_window_04_curtainm_73.baseRadius, endpoint_window_04_curtainm_73.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_04_curtainm_73) {
    mesh_window_04_curtainm_73Geometry.scale(0.44, 0.4, 0.015);
  }
  const mesh_window_04_curtainm_73 = new THREE.Mesh(
    mesh_window_04_curtainm_73Geometry,
    materialMap["curtain-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_04_curtainm_73.name = "Window04CurtainMirror";
  if (endpoint_window_04_curtainm_73) {
    mesh_window_04_curtainm_73.position.copy(endpoint_window_04_curtainm_73.midpoint);
    mesh_window_04_curtainm_73.quaternion.copy(endpoint_window_04_curtainm_73.quaternion);
  }
  mesh_window_04_curtainm_73.castShadow = options.castShadow ?? true;
  mesh_window_04_curtainm_73.receiveShadow = options.receiveShadow ?? true;
  mesh_window_04_curtainm_73.userData.sculptComponent = {"id": "window-04-curtainm", "name": "Window04CurtainMirror", "level": "meso", "role": "curtain", "importance": 0.65, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "parent": "window-04m", "attachment": {"parentId": "window-04m", "parentSocket": "window-04-socket", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.44, "height": 0.4, "depth": 0.015, "units": "world", "confidence": 0.8}, "transform": {"position": [0, 0.05, 0.045], "rotation": [0, 3.14159, 0], "scale": [0.44, 0.4, 0.015]}, "material": "curtain-cream", "evidenceRefs": ["full-object"], "topologyRationale": "Window04Curtain solid geometry attached to window-04", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 224, 204, 1.0)", "secondaryAlbedo": "rgba(208, 200, 176, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "window-04-curtain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_window_04_curtainm_73.add(mesh_window_04_curtainm_73);
  meshes["window-04-curtainm"] = mesh_window_04_curtainm_73;
  colliders["window-04-curtainm"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["window-04-curtain"] ??= [];
  destructionGroups["window-04-curtain"].push(node_window_04_curtainm_73);

  const attachment_wheel_front_b_74 = {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_front_b_74 = makeAttachmentEndpoint(attachment_wheel_front_b_74);
  const node_wheel_front_b_74 = new THREE.Group();
  node_wheel_front_b_74.name = "WheelFrontB__pivot";
  node_wheel_front_b_74.scale.set(1, 1, 1);
  if (endpoint_wheel_front_b_74) {
    node_wheel_front_b_74.position.copy(endpoint_wheel_front_b_74.start);
    node_wheel_front_b_74.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_front_b_74.position.set(-0.9, 0.0, 0.5);
    node_wheel_front_b_74.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_front_b_74.userData.sculptComponent = {"id": "wheel-front-b", "name": "WheelFrontB", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.12, "depth": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.9, 0, 0.5], "rotation": [1.5708, 0, 0], "scale": [0.55, 0.12, 0.55]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Large spoked wheel", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_b_74.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_front_b_74);
  nodes["wheel-front-b"] = node_wheel_front_b_74;
  const mesh_wheel_front_b_74Geometry = endpoint_wheel_front_b_74
    ? new THREE.CylinderGeometry(endpoint_wheel_front_b_74.endRadius, endpoint_wheel_front_b_74.baseRadius, endpoint_wheel_front_b_74.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_front_b_74) {
    mesh_wheel_front_b_74Geometry.scale(0.55, 0.12, 0.55);
  }
  const mesh_wheel_front_b_74 = new THREE.Mesh(
    mesh_wheel_front_b_74Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_front_b_74.name = "WheelFrontB";
  if (endpoint_wheel_front_b_74) {
    mesh_wheel_front_b_74.position.copy(endpoint_wheel_front_b_74.midpoint);
    mesh_wheel_front_b_74.quaternion.copy(endpoint_wheel_front_b_74.quaternion);
  }
  mesh_wheel_front_b_74.castShadow = options.castShadow ?? true;
  mesh_wheel_front_b_74.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_front_b_74.userData.sculptComponent = {"id": "wheel-front-b", "name": "WheelFrontB", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.12, "depth": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [-0.9, 0, 0.5], "rotation": [1.5708, 0, 0], "scale": [0.55, 0.12, 0.55]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Large spoked wheel", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_front_b_74.add(mesh_wheel_front_b_74);
  meshes["wheel-front-b"] = mesh_wheel_front_b_74;
  colliders["wheel-front-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-front"] ??= [];
  destructionGroups["wheel-front"].push(node_wheel_front_b_74);

  const attachment_wheel_rear_b_75 = {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]};
  const endpoint_wheel_rear_b_75 = makeAttachmentEndpoint(attachment_wheel_rear_b_75);
  const node_wheel_rear_b_75 = new THREE.Group();
  node_wheel_rear_b_75.name = "WheelRearB__pivot";
  node_wheel_rear_b_75.scale.set(1, 1, 1);
  if (endpoint_wheel_rear_b_75) {
    node_wheel_rear_b_75.position.copy(endpoint_wheel_rear_b_75.start);
    node_wheel_rear_b_75.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_wheel_rear_b_75.position.set(0.9, 0.0, 0.5);
    node_wheel_rear_b_75.rotation.set(1.5708, 0.0, 0.0);
  }
  node_wheel_rear_b_75.userData.sculptComponent = {"id": "wheel-rear-b", "name": "WheelRearB", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.12, "depth": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [0.9, 0, 0.5], "rotation": [1.5708, 0, 0], "scale": [0.55, 0.12, 0.55]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Large spoked wheel", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_b_75.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["chassis"] ?? root).add(node_wheel_rear_b_75);
  nodes["wheel-rear-b"] = node_wheel_rear_b_75;
  const mesh_wheel_rear_b_75Geometry = endpoint_wheel_rear_b_75
    ? new THREE.CylinderGeometry(endpoint_wheel_rear_b_75.endRadius, endpoint_wheel_rear_b_75.baseRadius, endpoint_wheel_rear_b_75.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_wheel_rear_b_75) {
    mesh_wheel_rear_b_75Geometry.scale(0.55, 0.12, 0.55);
  }
  const mesh_wheel_rear_b_75 = new THREE.Mesh(
    mesh_wheel_rear_b_75Geometry,
    materialMap["iron-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wheel_rear_b_75.name = "WheelRearB";
  if (endpoint_wheel_rear_b_75) {
    mesh_wheel_rear_b_75.position.copy(endpoint_wheel_rear_b_75.midpoint);
    mesh_wheel_rear_b_75.quaternion.copy(endpoint_wheel_rear_b_75.quaternion);
  }
  mesh_wheel_rear_b_75.castShadow = options.castShadow ?? true;
  mesh_wheel_rear_b_75.receiveShadow = options.receiveShadow ?? true;
  mesh_wheel_rear_b_75.userData.sculptComponent = {"id": "wheel-rear-b", "name": "WheelRearB", "level": "meso", "role": "wheel", "importance": 0.75, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "parent": "chassis", "attachment": {"parentId": "chassis", "parentSocket": "chassis-socket-r", "contactType": "embedded", "embedDepth": 0.01, "gapTolerance": 0.01, "localStart": [0, 0, 0], "localEnd": [0, 0, 0]}, "dimensions": {"width": 0.55, "height": 0.12, "depth": 0.55, "units": "world", "confidence": 0.85}, "transform": {"position": [0.9, 0, 0.5], "rotation": [1.5708, 0, 0], "scale": [0.55, 0.12, 0.55]}, "material": "iron-black", "evidenceRefs": ["full-object"], "topologyRationale": "Large spoked wheel", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 30, 32, 1.0)", "secondaryAlbedo": "rgba(42, 42, 46, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "source": "reference-image pixel sampling"}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "wheel-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}};
  node_wheel_rear_b_75.add(mesh_wheel_rear_b_75);
  meshes["wheel-rear-b"] = mesh_wheel_rear_b_75;
  colliders["wheel-rear-b"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["wheel-rear"] ??= [];
  destructionGroups["wheel-rear"].push(node_wheel_rear_b_75);

  // repetition system: window-repeat (InstancedMesh, radial, count=4, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["body-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
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

  // repetition system: clerestory-repeat (InstancedMesh, radial, count=5, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["body-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
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
    cluster.name = "clerestory-repeat";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "minimumTextureResolution": 1024, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7}}};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createVintageCaravanLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Vintage Caravan look-dev lights";
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
export function createVintageCaravanEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameVintageCaravanCamera(
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
export function createVintageCaravanPresentationComposer(
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

export function configureVintageCaravanRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createVintageCaravanInspectControls(
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
