// ============================================================================
// 动漫风格 Voronoi 海面（参考 cortiz2894/water-anime-shader）
// 主场景与调参场景共用同一套代码，保证「调参 = 游戏里生效」。
// ============================================================================
import * as THREE from 'three'

export const OCEAN_DEFAULTS = {
  uScale: 0.2,
  uSmoothness: 0.5,
  uEdgeThreshold: 0.1,
  uEdgeSoftness: 0.09,
  uFlowX: 0.1,
  uFlowZ: -0.23,
  uCellSpeed: 0.55,
  uNoiseScale: 0.88,
  uNoiseFlowSpeed: 0.11,
  uDistortAmount: 0.3,
  uDeepColor: '#92c6f2',
  uMidColor: '#a4ddff',
  uMidPos: 0.31,
  uHighlight: '#d4edff',
  uOpacity: 1.0,
  uDeepOpacity: 1.0,
  uFadeDistance: 700,
  uFadeStrength: 0.8,
  uWaveHeight: 0.55,
  uWaveFreq: 0.3,
  uWaveSpeed: 0.5,
}

// 昼夜海面预设（游戏与调参场景共用）：白天几乎不透明且鲜艳；黄昏/夜晚偏半透明
export const OCEAN_PRESETS = {
  day: { uDeepColor: '#92c6f2', uMidColor: '#a4ddff', uHighlight: '#d4edff', uOpacity: 1.0, uDeepOpacity: 1.0, uWaveHeight: 0.55 },
  dusk: { uDeepColor: '#3a7aa5', uMidColor: '#59c0e8', uHighlight: '#ffffff', uOpacity: 1.0, uDeepOpacity: 0.7, uWaveHeight: 0.08 },
}

export function createAnimeOcean(options = {}) {
  const cfg = { ...OCEAN_DEFAULTS, ...options }
  const u = {
    uTime: { value: 0 },
    uScale: { value: cfg.uScale },
    uSmoothness: { value: cfg.uSmoothness },
    uEdgeThreshold: { value: cfg.uEdgeThreshold },
    uEdgeSoftness: { value: cfg.uEdgeSoftness },
    uFlowX: { value: cfg.uFlowX },
    uFlowZ: { value: cfg.uFlowZ },
    uCellSpeed: { value: cfg.uCellSpeed },
    uNoiseScale: { value: cfg.uNoiseScale },
    uNoiseFlowSpeed: { value: cfg.uNoiseFlowSpeed },
    uDistortAmount: { value: cfg.uDistortAmount },
    uDeepColor: { value: new THREE.Color(cfg.uDeepColor) },
    uMidColor: { value: new THREE.Color(cfg.uMidColor) },
    uMidPos: { value: cfg.uMidPos },
    uHighlight: { value: new THREE.Color(cfg.uHighlight) },
    uOpacity: { value: cfg.uOpacity },
    uDeepOpacity: { value: cfg.uDeepOpacity },
    uFadeDistance: { value: cfg.uFadeDistance },
    uFadeStrength: { value: cfg.uFadeStrength },
    uCamXZ: { value: new THREE.Vector2() },
    uWaveHeight: { value: cfg.uWaveHeight },
    uWaveFreq: { value: cfg.uWaveFreq },
    uWaveSpeed: { value: cfg.uWaveSpeed },
  }

  const geo = new THREE.PlaneGeometry(cfg.planeSize ?? 3000, cfg.planeSize ?? 3000, cfg.planeSegments ?? 200, cfg.planeSegments ?? 200)
  geo.rotateX(-Math.PI / 2)

  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      uniform float uTime;
      uniform float uWaveHeight;
      uniform float uWaveFreq;
      uniform float uWaveSpeed;
      varying vec2 vWorldPos;

      void main() {
        vec3 pos = position;
        float w = sin(pos.x * uWaveFreq + pos.z * uWaveFreq * 0.7 + uTime * uWaveSpeed) * uWaveHeight
                + sin(pos.x * uWaveFreq * 0.5 - pos.z * uWaveFreq * 0.3 + uTime * uWaveSpeed * 0.6) * uWaveHeight * 0.5;
        pos.y = w;
        vec4 worldPos = modelMatrix * vec4(pos, 1.0);
        vWorldPos = worldPos.xz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uScale;
      uniform float uSmoothness;
      uniform float uEdgeThreshold;
      uniform float uEdgeSoftness;
      uniform float uFlowX;
      uniform float uFlowZ;
      uniform float uCellSpeed;
      uniform float uNoiseScale;
      uniform float uNoiseFlowSpeed;
      uniform float uDistortAmount;
      uniform vec3 uDeepColor;
      uniform vec3 uMidColor;
      uniform float uMidPos;
      uniform vec3 uHighlight;
      uniform float uOpacity;
      uniform float uDeepOpacity;
      uniform float uFadeDistance;
      uniform float uFadeStrength;
      uniform vec2 uCamXZ;
      varying vec2 vWorldPos;

      vec2 hash2(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
      }

      float smin(float a, float b, float k) {
        float h = max(k - abs(a - b), 0.0) / k;
        return min(a, b) - h * h * h * k / 6.0;
      }

      vec2 cellPt(vec2 seed) {
        return 0.5 + 0.5 * sin(uTime * uCellSpeed + 6.2831 * seed);
      }

      vec2 voronoiF1Pair(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        float md = 8.0;
        float res = 8.0;
        for (int y = -1; y <= 1; y++)
          for (int x = -1; x <= 1; x++) {
            vec2 n = vec2(float(x), float(y));
            vec2 pt = cellPt(hash2(i + n));
            float d = length(n + pt - f);
            md = min(md, d);
            res = smin(res, d, uSmoothness);
          }
        return vec2(md, res);
      }

      float nHash(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(nHash(i), nHash(i + vec2(1.0, 0.0)), f.x),
          mix(nHash(i + vec2(0.0, 1.0)), nHash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 2; i++) { v += a * vnoise(p); p *= 2.0; a *= 0.5; }
        return v;
      }

      void main() {
        vec2 noiseUV = vWorldPos * uNoiseScale + vec2(uTime * uNoiseFlowSpeed, 0.0);
        float noiseFac = fbm(noiseUV);
        vec2 distort = vec2(noiseFac - 0.5) * uDistortAmount;

        vec2 uv = vWorldPos * uScale + vec2(uFlowX, uFlowZ) * uTime + distort;

        vec2 f1Pair = voronoiF1Pair(uv);
        float f1 = f1Pair.x;
        float sf1 = f1Pair.y;
        float edge = f1 - sf1;

        float t = smoothstep(uEdgeThreshold - uEdgeSoftness, uEdgeThreshold + uEdgeSoftness, edge);

        float safeMP = max(uMidPos, 0.001);
        float seg0 = clamp(t / safeMP, 0.0, 1.0);
        float seg1 = clamp((t - safeMP) / max(1.0 - safeMP, 0.001), 0.0, 1.0);
        float inSeg1 = step(safeMP, t);
        vec3 color = mix(
          mix(uDeepColor, uMidColor, seg0),
          mix(uMidColor, uHighlight, seg1),
          inSeg1
        );

        float dist = length(vWorldPos - uCamXZ);
        float fade = 1.0 - pow(clamp(dist / uFadeDistance, 0.0, 1.0), uFadeStrength);

        float alpha = mix(uDeepOpacity, 1.0, t) * uOpacity * fade;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  })

  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.y = cfg.y ?? -0.3
  return { mesh, uniforms: u, material: mat }
}
