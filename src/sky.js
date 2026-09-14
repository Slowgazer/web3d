import * as THREE from 'three'

/**
 * 吉卜力风格卡通体积云天空穹顶
 *
 * 实现思路（与 Blender 三渲二 / 吉卜力背景美术相通的通用做法）：
 *  1. 视线方向投影到云层平面，产生体积透视感
 *  2. domain-warped FBM 噪声生成蓬松云形
 *  3. 朝太阳方向二次采样得到光照，按阶梯量化 → 卡通分层阴影
 *  4. 云轮廓朝太阳处染阳光色 → 银边效果
 * 内置「夏日蓝天 / 黄昏」两套预设，切换时颜色和太阳光照平滑过渡。
 */

// 参与过渡动画的 uniform 键
const COLOR_KEYS = [
  'uZenith', 'uMid', 'uHorizon',
  'uHorizonGlowColor', 'uSunColor',
  'uCloudLight', 'uCloudDark',
]
const FLOAT_KEYS = [
  'uHorizonGlowStrength', 'uSunGlow',
  'uCoverage', 'uCloudScale', 'uCloudSpeed', 'uCloudSoft', 'uShadeSteps',
]

// ---- 天空预设 ----
export const SKY_PRESETS = {
  summer: {
    label: '夏日蓝天',
    colors: {
      uZenith: '#2f7fd4',          // 天顶湛蓝
      uMid: '#7ec4ee',             // 中部浅蓝
      uHorizon: '#e8f4fc',         // 地平线近白
      uHorizonGlowColor: '#fff3d0',
      uSunColor: '#fff2bd',
      uCloudLight: '#ffffff',      // 云受光面
      uCloudDark: '#9cc2e6',       // 云背光面（淡蓝灰）
    },
    floats: {
      uHorizonGlowStrength: 0.35,
      uSunGlow: 1.1,
      uCoverage: 0.54,
      uCloudScale: 0.95,
      uCloudSpeed: 1.25,
      uCloudSoft: 0.13,
      uShadeSteps: 3,
    },
    sun: { position: [20, 24, 10], intensity: 2.5, color: '#fff8e6' },
  },
  dusk: {
    label: '黄昏',
    colors: {
      uZenith: '#3d4178',          // 紫蓝夜空前奏
      uMid: '#c96f9b',             // 粉紫过渡
      uHorizon: '#ffa25e',         // 地平线橙红
      uHorizonGlowColor: '#ffc46b',
      uSunColor: '#ffb347',
      uCloudLight: '#ffd9a8',      // 云被夕阳染成暖橙
      uCloudDark: '#6f5aa0',       // 云影偏紫
    },
    floats: {
      uHorizonGlowStrength: 1.0,
      uSunGlow: 1.8,
      uCoverage: 0.5,
      uCloudScale: 1.0,
      uCloudSpeed: 1.1,
      uCloudSoft: 0.16,
      uShadeSteps: 3,
    },
    sun: { position: [-26, 8, 14], intensity: 2.2, color: '#ffcf9e' },
  },
}

const VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;
void main() {
  // 用本地坐标当方向向量（穹顶跟随相机水平移动，局部方向即视线方向）
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uHorizonGlowColor;
uniform float uHorizonGlowStrength;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunGlow;
uniform float uCoverage;
uniform float uCloudScale;
uniform float uCloudSpeed;
uniform float uCloudSoft;
uniform float uShadeSteps;
uniform float uCurve;
uniform vec3 uCloudLight;
uniform vec3 uCloudDark;
uniform float uNightMode;
uniform vec3 uNightTop;
uniform vec3 uNightBot;
varying vec3 vDir;

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = ROT * p * 2.02; a *= 0.5; }
  return v;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // 三段式天空渐变
  float tMid = smoothstep(-0.05, 0.45, h);
  float tTop = smoothstep(0.25, 0.95, h);
  vec3 sky = mix(uHorizon, uMid, tMid);
  sky = mix(sky, uZenith, tTop);

  vec3 sunDir = normalize(uSunDir);
  float sunDot = max(dot(dir, sunDir), 0.0);

  // 地平线光晕（朝太阳侧更亮，黄昏氛围的关键）
  float band = exp(-abs(h) * 7.0);
  sky += uHorizonGlowColor * band * (0.25 + 0.75 * pow(sunDot, 3.0)) * uHorizonGlowStrength;

  // 太阳圆盘 + 辉光
  float disc = smoothstep(0.9992, 0.9997, sunDot);
  float glow = pow(sunDot, 20.0) * uSunGlow;
  sky += uSunColor * (disc * 2.5 + glow * 0.45);

  // ---- 卡通体积云 ----
  float cloudAlpha = 0.0;
  vec3 cloudCol = vec3(0.0);
  if (h > -0.02) {
    // 视线投影到云层平面；加一个弧面偏移 uCurve，使地平线附近也有云且不至于被拉伸成条纹
    float hcurv = max(h + uCurve, 0.035);
    vec2 uv = dir.xz / hcurv;
    uv *= uCloudScale * 1.4;
    uv += vec2(1.0, 0.25) * uTime * 0.030 * uCloudSpeed;

    // 远处（近地平线）只做很轻的淡出，让云一直铺到地平线
    float dist = length(uv);
    float distFade = 1.0 - smoothstep(28.0, 46.0, dist);
    float horizonFade = smoothstep(-0.02, 0.06, h);

    // domain warp：云形更蓬松自然
    vec2 q = vec2(fbm(uv * 0.6), fbm(uv * 0.6 + vec2(1.7, 9.2)));
    vec2 wuv = uv + 1.3 * q + vec2(uTime * 0.012 * uCloudSpeed, 0.0);
    float c = fbm(wuv);

    float cover = 1.0 - uCoverage;
    float dens = smoothstep(cover - uCloudSoft, cover + uCloudSoft, c);
    dens *= distFade * horizonFade;

    if (dens > 0.001) {
      // 朝太阳方向二次采样：差值 > 0 说明该侧是云的受光边缘
      vec2 sunUV = normalize(sunDir.xz + vec2(1e-4, 0.0)) * 0.12;
      float c2 = fbm(wuv + sunUV);
      float lit = clamp((c - c2) * 5.0 + 0.55, 0.0, 1.0);
      // 卡通分层量化
      float steps = max(uShadeSteps, 1.0);
      lit = floor(lit * steps + 0.5) / steps;
      cloudCol = mix(uCloudDark, uCloudLight, lit);
      // 银边：云轮廓朝太阳处染上阳光颜色
      float rim = pow(sunDot, 5.0);
      cloudCol += uSunColor * rim * 0.30 * smoothstep(0.15, 0.6, dens);
      cloudAlpha = dens * 0.92;
    }
  }
  vec3 col = mix(sky, cloudCol, cloudAlpha);

  // 夜晚混合
  vec3 night = mix(uNightBot, uNightTop, tTop);
  col = mix(col, night, uNightMode);

  gl_FragColor = vec4(col, 1.0);
}
`

/**
 * 创建卡通天空穹顶
 * @param {number} radius 穹顶半径
 * @param {THREE.DirectionalLight|null} sunLight 场景太阳灯，预设切换时会同步过渡其位置/颜色/强度
 */
export function createGhibliSky(radius = 1500, sunLight = null) {
  const uniforms = {
    uTime: { value: 0 },
    uZenith: { value: new THREE.Color() },
    uMid: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uHorizonGlowColor: { value: new THREE.Color() },
    uHorizonGlowStrength: { value: 0.35 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.5, 0.8).normalize() },
    uSunColor: { value: new THREE.Color() },
    uSunGlow: { value: 1.1 },
    uCoverage: { value: 0.5 },
    uCloudScale: { value: 1.0 },
    uCloudSpeed: { value: 1.0 },
    uCloudSoft: { value: 0.13 },
    uShadeSteps: { value: 3 },
    uCurve: { value: 0.2 },
    uCloudLight: { value: new THREE.Color() },
    uCloudDark: { value: new THREE.Color() },
    uNightMode: { value: 0.0 },
    uNightTop: { value: new THREE.Color('#0a0a1a') },
    uNightBot: { value: new THREE.Color('#1a1a3e') },
  }

  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat)
  mesh.frustumCulled = false

  let currentPreset = 'summer'
  let transition = null

  function snapshot() {
    const colors = {}
    const floats = {}
    COLOR_KEYS.forEach((k) => { colors[k] = uniforms[k].value.clone() })
    FLOAT_KEYS.forEach((k) => { floats[k] = uniforms[k].value })
    let sun = null
    if (sunLight) {
      sun = {
        position: sunLight.position.clone(),
        intensity: sunLight.intensity,
        color: sunLight.color.clone(),
      }
    }
    return { colors, floats, sun }
  }

  function targetOf(p) {
    const colors = {}
    for (const k of COLOR_KEYS) colors[k] = new THREE.Color(p.colors[k])
    const floats = {}
    for (const k of FLOAT_KEYS) floats[k] = p.floats[k]
    let sun = null
    if (sunLight && p.sun) {
      sun = {
        position: new THREE.Vector3(...p.sun.position),
        intensity: p.sun.intensity,
        color: new THREE.Color(p.sun.color),
      }
    }
    return { colors, floats, sun }
  }

  function applyBlend(from, to, k) {
    COLOR_KEYS.forEach((key) => uniforms[key].value.lerpColors(from.colors[key], to.colors[key], k))
    FLOAT_KEYS.forEach((key) => { uniforms[key].value = from.floats[key] + (to.floats[key] - from.floats[key]) * k })
    if (sunLight && from.sun && to.sun) {
      sunLight.position.lerpVectors(from.sun.position, to.sun.position, k)
      sunLight.intensity = from.sun.intensity + (to.sun.intensity - from.sun.intensity) * k
      sunLight.color.lerpColors(from.sun.color, to.sun.color, k)
    }
  }

  /** 切换预设，animate 为 true 时平滑过渡（dur 秒，默认 1.6） */
  function setPreset(name, animate = true, dur = 1.6) {
    const p = SKY_PRESETS[name]
    if (!p) return
    currentPreset = name
    const to = targetOf(p)
    if (!animate) {
      applyBlend(to, to, 1)
      transition = null
      return
    }
    transition = { t: 0, dur: Math.max(0.1, dur), from: snapshot(), to }
  }

  /** 每帧调用：推进时间并驱动预设过渡动画 */
  function update(dt) {
    uniforms.uTime.value += dt
    if (transition) {
      transition.t += dt
      const raw = Math.min(transition.t / transition.dur, 1)
      const k = raw * raw * (3 - 2 * raw) // smoothstep 缓动
      applyBlend(transition.from, transition.to, k)
      if (raw >= 1) transition = null
    }
  }

  setPreset('summer', false)

  return {
    mesh,
    uniforms,
    setPreset,
    update,
    presets: SKY_PRESETS,
    get currentPreset() { return currentPreset },
  }
}

// ============================================================
// 以下为旧版实现，保留给 editor.js 演示页使用（新代码请用 createGhibliSky）
// ============================================================
export function createSky() {
  const group = new THREE.Group()

  // 渐变天幕 - 使用大球体内表面
  const skyGeo = new THREE.SphereGeometry(95, 32, 32)
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uTopColor: { value: new THREE.Color('#a8d8ea') },
      uBottomColor: { value: new THREE.Color('#fae8c8') },
    },
    vertexShader: `
varying vec3 vWorldPosition;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
    fragmentShader: `
uniform vec3 uTopColor;
uniform vec3 uBottomColor;
varying vec3 vWorldPosition;
void main() {
  float h = normalize(vWorldPosition).y;
  h = clamp(h * 0.5 + 0.5, 0.0, 1.0);
  vec3 color = mix(uBottomColor, uTopColor, h);
  gl_FragColor = vec4(color, 1.0);
}
`,
  })
  const skyMesh = new THREE.Mesh(skyGeo, skyMat)
  group.add(skyMesh)

  // 云朵 - 多个半透球体组合
  const cloudMat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0.7,
    roughness: 1,
    metalness: 0,
    depthWrite: false,
  })

  const cloudPositions = [
    { x: -30, y: 18, z: -25, scale: 1.2 },
    { x: -15, y: 22, z: -30, scale: 0.9 },
    { x: 10, y: 20, z: -35, scale: 1.4 },
    { x: 35, y: 16, z: -28, scale: 1.0 },
    { x: -40, y: 15, z: -20, scale: 0.8 },
    { x: 20, y: 14, z: -40, scale: 1.1 },
    { x: -10, y: 25, z: -45, scale: 0.7 },
    { x: 45, y: 20, z: -32, scale: 0.9 },
    { x: -25, y: 12, z: -38, scale: 1.3 },
    { x: 30, y: 24, z: -42, scale: 0.6 },
  ]

  cloudPositions.forEach((pos) => {
    const cloudGroup = new THREE.Group()
    const count = 4 + Math.floor(Math.random() * 3)
    for (let i = 0; i < count; i++) {
      const r = 1.5 + Math.random() * 2.5
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(r, 8, 8),
        cloudMat.clone(),
      )
      sphere.position.set(
        (Math.random() - 0.5) * 4,
        (Math.random() - 0.5) * 1.5,
        (Math.random() - 0.5) * 2,
      )
      sphere.scale.y = 0.6
      cloudGroup.add(sphere)
    }
    cloudGroup.position.set(pos.x, pos.y, pos.z)
    cloudGroup.scale.set(pos.scale, pos.scale, pos.scale)
    group.add(cloudGroup)
  })

  return group
}
