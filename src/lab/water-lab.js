// ============================================================================
// 试验场景：风格化水面（参考 Uber Stylized Water 的技法，用 GLSL ShaderMaterial
// 在现有 WebGL 管线里重写；不依赖 WebGPU/TSL，也不改动主场景）
// 访问： /water-lab.html
// ============================================================================
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createGhibliSky } from '../sky.js'
import { createCarriageModelById } from '../carriage.js'
import { createRailwayTrackSegmentModel } from '../createTrackModel'
import { spawnSeagulls } from '../seagull.js'

// ---------- 风格化水面 ----------
const WATER_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHeight; // 归一化波高：0 波谷 → 1 波峰
varying float vFoam;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p = wp.xz;
  float t = uTime;

  vec2 d1 = normalize(vec2(1.0, 0.30));
  vec2 d2 = normalize(vec2(-0.5, 1.0));
  vec2 d3 = normalize(vec2(0.75, -0.7));
  float w1 = 90.0, w2 = 55.0, w3 = 36.0;
  float a1 = 1.0, a2 = 0.5, a3 = 0.25;
  float s1 = 0.8, s2 = 1.15, s3 = 1.5;
  float k1 = 6.2831853 / w1, k2 = 6.2831853 / w2, k3 = 6.2831853 / w3;
  float c1 = sqrt(9.8 / k1) * s1, c2 = sqrt(9.8 / k2) * s2, c3 = sqrt(9.8 / k3) * s3;

  float f1 = k1 * dot(d1, p) + t * c1 * k1;
  float f2 = k2 * dot(d2, p) + t * c2 * k2;
  float f3 = k3 * dot(d3, p) + t * c3 * k3;

  float dhdx = a1 * k1 * d1.x * cos(f1) + a2 * k2 * d2.x * cos(f2) + a3 * k3 * d3.x * cos(f3);
  float dhdz = a1 * k1 * d1.y * cos(f1) + a2 * k2 * d2.y * cos(f2) + a3 * k3 * d3.y * cos(f3);
  float h = a1 * sin(f1) + a2 * sin(f2) + a3 * sin(f3);

  vNormalW = normalize(vec3(-dhdx, 1.0, -dhdz));
  wp.xyz += vec3(0.0, h, 0.0);
  vWorld = wp.xyz;
  vHeight = clamp(h / (a1 + a2 + a3) * 0.5 + 0.5, 0.0, 1.0);
  vFoam = clamp(smoothstep(0.6, 0.95, sin(f1)) + smoothstep(0.75, 1.0, sin(f3)), 0.0, 1.0);

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const WATER_FRAG = /* glsl */ `
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uCrest;
uniform vec3 uFoam;
uniform vec3 uFog;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHeight;
varying float vFoam;

float hash(vec2 p) { p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  float dist = length(cameraPosition.xz - vWorld.xz);
  vec3 S = normalize(uSunDir);

  // 片元级细波纹（两个方向）→ 近处也有起伏 + 细碎高光
  vec2 rp = vWorld.xz;
  vec2 dd1 = normalize(vec2(1.0, 0.30));
  vec2 dd2 = normalize(vec2(-0.40, 1.0));
  float g1 = cos(dot(dd1, rp) * 6.2831853 / 7.0 + uTime * 1.7);
  float g2 = cos(dot(dd2, rp) * 6.2831853 / 4.0 + uTime * 2.3);
  N = normalize(N + vec3(dd1.x * g1 * 0.14 + dd2.x * g2 * 0.09, 0.0,
                         dd1.y * g1 * 0.14 + dd2.y * g2 * 0.09));

  // 深度：以距离为主，噪声只做轻微深浅交错
  float n = vnoise(vWorld.xz * 0.0025);
  float depth = clamp(dist / 1500.0 + (n - 0.5) * 0.28, 0.0, 1.0);
  vec3 col = mix(uShallow, uDeep, smoothstep(0.0, 1.0, depth));

  // 波峰提亮 / 波谷压暗（弱一点，避免横向条纹感）
  float band = smoothstep(0.40, 0.95, vHeight);
  col = mix(col, uCrest, band * 0.28);

  // 柔和太阳高光（塑形，不要死白）
  vec3 H = normalize(S + V);
  float spec = pow(max(dot(N, H), 0.0), 90.0);
  spec = smoothstep(0.25, 0.85, spec);
  col += uSunColor * spec * 0.9;

  // 太阳光路（glitter）：朝太阳方向的水平角 + 细波纹打断
  vec2 Vxz = normalize(V.xz + vec2(1e-4));
  vec2 Sxz = normalize(S.xz + vec2(1e-4));
  float toward = pow(max(dot(Vxz, Sxz), 0.0), 5.0);
  float gn = vnoise(rp * 0.9 + uTime * 0.6);
  float glitter = toward * smoothstep(0.55, 1.0, gn) * smoothstep(0.2, 0.85, spec);
  col += uSunColor * glitter * 1.6;

  // 波峰泡沫（噪声打断，避免整条白线）
  float fn = vnoise(vWorld.xz * 0.08 + uTime * 0.05);
  float foam = smoothstep(0.5, 1.0, vFoam) * smoothstep(0.4, 0.85, fn);
  col = mix(col, uFoam, foam * 0.9);

  // 边缘菲涅尔 + 地平线雾
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col = mix(col, uFog, fres * 0.3);
  col = mix(col, uFog, smoothstep(uFogNear, uFogFar, dist) * 0.95);

  gl_FragColor = vec4(col, 1.0);
}
`

function createWater(sun) {
  const uniforms = {
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color('#2fb6cd') },
    uDeep: { value: new THREE.Color('#0a4f86') },
    uCrest: { value: new THREE.Color('#7fe0ee') },
    uFoam: { value: new THREE.Color('#ffffff') },
    uFog: { value: new THREE.Color('#cfe8f5') },
    uSunColor: { value: new THREE.Color('#fff6dc') },
    uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.5).normalize() },
    uFogNear: { value: 600 },
    uFogFar: { value: 2400 },
  }
  const geo = new THREE.PlaneGeometry(5000, 5000, 500, 500)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  return { mesh, uniforms }
}

// ---------- 场景 ----------
export function bootWaterLab() {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1
  document.body.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog('#cfe8f5', 500, 2600)

  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 6000)
  camera.position.set(9, 6, 13)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.target.set(0, 1.5, 0)

  scene.add(new THREE.AmbientLight('#cfe6ff', 0.55))
  scene.add(new THREE.HemisphereLight('#bfe3ff', '#6a8a9a', 0.5))
  const sun = new THREE.DirectionalLight('#fff4d8', 2.4)
  sun.position.set(30, 40, 20)
  scene.add(sun)

  const sky = createGhibliSky(3000, sun)
  scene.add(sky.mesh)
  // 大块柔和的云（更接近吉卜力手绘）
  sky.uniforms.uCoverage.value = 0.6
  sky.uniforms.uCloudSoft.value = 0.22
  sky.uniforms.uCloudScale.value = 0.7

  const water = createWater(sun)
  scene.add(water.mesh)

  // 远景小岛（低模，落在雾里做层次）
  function makeIsland(radius, height, seed) {
    const g = new THREE.Group()
    const rockMat = new THREE.MeshStandardMaterial({ color: '#6f747c', roughness: 1, flatShading: true })
    const grassMat = new THREE.MeshStandardMaterial({ color: '#5f8f4a', roughness: 1, flatShading: true })
    const rock = new THREE.Mesh(new THREE.ConeGeometry(radius, height, 7, 1), rockMat)
    rock.position.y = height / 2
    rock.rotation.y = seed
    const grass = new THREE.Mesh(new THREE.ConeGeometry(radius * 1.06, height * 0.62, 7, 1), grassMat)
    grass.position.y = height * 0.72
    grass.rotation.y = seed + 0.3
    g.add(rock, grass)
    return g
  }
  const islandDefs = [
    { x: -420, z: -900, r: 90, h: 70 },
    { x: 380, z: -1250, r: 130, h: 95 },
    { x: -1100, z: -700, r: 70, h: 55 },
    { x: 950, z: -820, r: 60, h: 48 },
    { x: 120, z: -1700, r: 170, h: 120 },
  ]
  islandDefs.forEach((d, i) => {
    const isl = makeIsland(d.r, d.h, i * 1.7)
    isl.position.set(d.x, -9, d.z)
    scene.add(isl)
  })

  // 海鸥（Sketchfab 骨骼动画模型）
  let seagulls = null
  spawnSeagulls(scene, { count: 6, center: new THREE.Vector3(0, 13, -55), radius: 40, size: 1.6 })
    .then((c) => { seagulls = c })
    .catch((e) => console.warn('海鸥加载失败：', e))

  // 车厢 + 一段轨道（给水面做参照）
  const train = new THREE.Group()
  train.position.set(0, 1.0, 0)
  train.add(createCarriageModelById('summer'))
  scene.add(train)

  const seg = createRailwayTrackSegmentModel({ castShadow: true, receiveShadow: true })
  seg.rotation.y = -Math.PI / 2
  seg.position.set(0, 0.09, 0)
  scene.add(seg)

  const clock = new THREE.Clock()
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = performance.now() * 0.001
    water.uniforms.uTime.value += dt
    sky.uniforms.uTime.value += dt
    sky.update(dt)
    // 海鸥盘旋 + 骨骼动画
    if (seagulls) seagulls.update(dt)
    controls.update()
    renderer.render(scene, camera)
  })

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })

  window.__ready = true
}
