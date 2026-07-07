import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import GUI from 'lil-gui'

const SUNFLOWER_PATH = '/models/Sunflower/PUSHILIN_sunflower.obj'
const SUNFLOWER_MTL = '/models/Sunflower/PUSHILIN_sunflower.mtl'
const MARIGOLD_PATH = '/models/DesertMarigold/DesertMarigold.obj'
const MARIGOLD_MTL = '/models/DesertMarigold/DesertMarigold.mtl'
const BUILDING_PATH = '/models/Building/building_A.fbx'
const VRMOBIL_PATH = '/models/VR-Mobil/model.obj'
const VRMOBIL_MTL = '/models/VR-Mobil/materials.mtl'

// ---- 持久化存储 ----
const STORAGE_KEY = 'grass_scene_state'
function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {} } catch { return {} }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    flowerDensity: state.flowerDensity,
    flowerSizeMin: state.flowerSizeMin,
    flowerSizeMax: state.flowerSizeMax,
    flowerRange: state.flowerRange,
    cloudDensity: state.cloudDensity,
    buildingState: { ...buildingState },
    carState: { ...carState },
    sunPos: { x: sun.position.x, y: sun.position.y, z: sun.position.z },
    sunIntensity: sun.intensity,
  }))
}

// ---- 加载器 ----
function loadOBJ(path, mtlPath, targetHeight) {
  return new Promise((res, rej) => {
    new MTLLoader().load(mtlPath, (materials) => {
      materials.preload()
      new OBJLoader().setMaterials(materials).load(path, (obj) => {
        obj.traverse((c) => {
          if (c.isMesh) {
            c.castShadow = true; c.receiveShadow = true
            if (c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material]
              mats.forEach((m) => {
                m.transparent = false; m.opacity = 1; m.depthWrite = true
                if (m.color) {
                  m.color.r = Math.min(m.color.r * 2 + 0.15, 1)
                  m.color.g = Math.min(m.color.g * 2 + 0.15, 1)
                  m.color.b = Math.min(m.color.b * 2 + 0.15, 1)
                }
              })
            }
          }
        })
        const box = new THREE.Box3().setFromObject(obj)
        const size = new THREE.Vector3(); box.getSize(size)
        const factor = targetHeight / Math.max(size.x, size.y, size.z)
        obj.scale.set(factor, factor, factor)
        obj.userData.bboxBottom = box.min.y * factor
        obj.userData.bboxSize = Math.max(size.x, size.y, size.z) * factor
        res(obj)
      }, undefined, rej)
    }, undefined, rej)
  })
}

function loadFBX(path, targetHeight) {
  return new Promise((res, rej) => {
    new FBXLoader().load(path, (obj) => {
      obj.traverse((c) => {
        if (c.isMesh) {
          c.castShadow = true; c.receiveShadow = true
          if (c.material) {
            const mats = Array.isArray(c.material) ? c.material : [c.material]
            mats.forEach((m) => {
              m.transparent = false; m.opacity = 1; m.depthWrite = true
              if (m.color) {
                m.color.r = Math.min(m.color.r * 1.5 + 0.2, 1)
                m.color.g = Math.min(m.color.g * 1.5 + 0.2, 1)
                m.color.b = Math.min(m.color.b * 1.5 + 0.2, 1)
              }
            })
          }
        }
      })
      const box = new THREE.Box3().setFromObject(obj)
      const size = new THREE.Vector3(); box.getSize(size)
      const factor = targetHeight / Math.max(size.x, size.y, size.z)
      obj.scale.set(factor, factor, factor)
      obj.userData.bboxBottom = box.min.y * factor
      res(obj)
    }, undefined, rej)
  })
}

// ---- 场景初始化 ----
const scene = new THREE.Scene()
scene.background = new THREE.Color('#87ceeb')
scene.fog = new THREE.Fog('#cde4f0', 30, 120)

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 150)
camera.position.set(15, 10, 20)
camera.lookAt(0, 2, 0)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.2
document.body.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true; controls.dampingFactor = 0.08
controls.maxPolarAngle = Math.PI / 2.2; controls.minDistance = 5
controls.maxDistance = 50; controls.target.set(0, 2, 0); controls.update()

// ---- 草地 ----
const groundGeo = new THREE.PlaneGeometry(60, 60, 60, 60)
const posArr = groundGeo.attributes.position.array
const colArr = new Float32Array(posArr.length)
for (let i = 2; i < posArr.length; i += 3) {
  posArr[i] += (Math.random() - 0.5) * 0.15
  const shade = 0.85 + Math.random() * 0.15
  colArr[i - 2] = 0.2 * shade
  colArr[i - 1] = 0.55 * shade
  colArr[i] = 0.15 * shade
}
groundGeo.setAttribute('color', new THREE.BufferAttribute(colArr, 3))
groundGeo.computeVertexNormals()

const grassMesh = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({
  roughness: 0.9, metalness: 0, vertexColors: true,
}))
grassMesh.rotation.x = -Math.PI / 2
grassMesh.receiveShadow = true
scene.add(grassMesh)

// 天空球
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: { uTop: { value: new THREE.Color('#7cb7d8') }, uBot: { value: new THREE.Color('#e8f0d8') } },
  vertexShader: `varying vec3 p; void main() { vec4 w=modelMatrix*vec4(position,1.0); p=w.xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 uTop,uBot; varying vec3 p; void main() { float h=normalize(p).y*.5+.5; gl_FragColor=vec4(mix(uBot,uTop,h),1.0); }`,
})
scene.add(new THREE.Mesh(new THREE.SphereGeometry(70, 32, 32), skyMat))

// ---- 海洋（动漫风格 Voronoi 水面 - 参考 cortiz2894/water-anime-shader） ----
const oUniforms = {
  uTime: { value: 0 },
  uScale: { value: 0.23 },
  uSmoothness: { value: 0.46 },
  uEdgeThreshold: { value: 0.09 },
  uEdgeSoftness: { value: 0.01 },
  uFlowX: { value: 0.07 },
  uFlowZ: { value: -0.23 },
  uCellSpeed: { value: 0.55 },
  uNoiseScale: { value: 0.87 },
  uNoiseFlowSpeed: { value: 0.11 },
  uDistortAmount: { value: 0.26 },
  uDeepColor: { value: new THREE.Color('#27a3d8') },
  uMidColor: { value: new THREE.Color('#59c0e8') },
  uMidPos: { value: 0.31 },
  uHighlight: { value: new THREE.Color('#ffffff') },
  uOpacity: { value: 1.0 },
  uDeepOpacity: { value: 0.37 },
  uFadeDistance: { value: 275 },
  uFadeStrength: { value: 1.3 },
  uCamXZ: { value: new THREE.Vector2() },
  uWaveHeight: { value: 0.08 },
  uWaveFreq: { value: 0.3 },
  uWaveSpeed: { value: 0.5 },
}
const oGeo = new THREE.PlaneGeometry(600, 600, 200, 200)
oGeo.rotateX(-Math.PI / 2)
const oMat = new THREE.ShaderMaterial({
  uniforms: oUniforms,
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

    float voronoiF1(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float md = 8.0;
      for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
          vec2 n = vec2(float(x), float(y));
          vec2 pt = cellPt(hash2(i + n));
          md = min(md, length(n + pt - f));
        }
      return md;
    }

    float voronoiSF1(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float res = 8.0;
      for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
          vec2 n = vec2(float(x), float(y));
          vec2 pt = cellPt(hash2(i + n));
          res = smin(res, length(n + pt - f), uSmoothness);
        }
      return res;
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

      float f1 = voronoiF1(uv);
      float sf1 = voronoiSF1(uv);
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
const ocean = new THREE.Mesh(oGeo, oMat)
ocean.position.y = -0.3
scene.add(ocean)

// ---- 光照 ----
scene.add(new THREE.AmbientLight('#ffeedd', 0.4))
scene.add(new THREE.HemisphereLight('#87ceeb', '#6a8a4a', 0.5))
const sun = new THREE.DirectionalLight('#fff8e6', 2.5)
sun.position.set(20, 20, 10)
sun.castShadow = true
sun.shadow.mapSize.set(4096, 4096)
sun.shadow.camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.5, 130)
sun.shadow.bias = -0.0005
scene.add(sun)
scene.add(new THREE.DirectionalLight('#a0c8e8', 0.3).position.set(-15, 8, -10))

// ---- 坐标轴 ----
const axes = new THREE.AxesHelper(25)
axes.position.set(0, 0.05, 0)
scene.add(axes)

// ---- 土路 ----
const pathGroup = new THREE.Group()
scene.add(pathGroup)

function createDirtPath() {
  // 清除旧路
  while (pathGroup.children.length) pathGroup.remove(pathGroup.children[0])

  // 从建筑门口蜿蜒向外
  const pts = [
    new THREE.Vector3(0, 0.01, -1.5),
    new THREE.Vector3(1, 0.01, 2),
    new THREE.Vector3(-0.5, 0.01, 5),
    new THREE.Vector3(2, 0.01, 8),
    new THREE.Vector3(0, 0.01, 12),
    new THREE.Vector3(1.5, 0.01, 16),
  ]
  const curve = new THREE.CatmullRomCurve3(pts)
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 40, 0.6, 6, false),
    new THREE.MeshStandardMaterial({ color: '#c4a35a', roughness: 0.9, metalness: 0 }),
  )
  tube.receiveShadow = true
  // 压扁成路面
  tube.scale.y = 0.15
  pathGroup.add(tube)

  // 路面两侧的细小边缘（加深立体感）
  for (let side = -1; side <= 1; side += 2) {
    const edgePts = pts.map((p) => p.clone().add(new THREE.Vector3(side * 0.55, 0, 0)))
    const edgeCurve = new THREE.CatmullRomCurve3(edgePts)
    const edge = new THREE.Mesh(
      new THREE.TubeGeometry(edgeCurve, 40, 0.04, 4, false),
      new THREE.MeshStandardMaterial({ color: '#8b6914', roughness: 0.8 }),
    )
    edge.receiveShadow = true
    edge.scale.y = 0.15
    pathGroup.add(edge)
  }
}
createDirtPath()

// ---- 花朵 ----
const flowerGroup = new THREE.Group()
scene.add(flowerGroup)
let sunflowerTpl, marigoldTpl
const flowerInstances = []
const saved = loadState()

const state = {
  flowerDensity: saved.flowerDensity ?? 50,
  flowerSizeMin: saved.flowerSizeMin ?? 0.6,
  flowerSizeMax: saved.flowerSizeMax ?? 1.4,
  flowerRange: saved.flowerRange ?? 12,
  cloudDensity: saved.cloudDensity ?? 15,
}

async function initFlowers() {
  sunflowerTpl = await loadOBJ(SUNFLOWER_PATH, SUNFLOWER_MTL, 4)
  marigoldTpl = await loadOBJ(MARIGOLD_PATH, MARIGOLD_MTL, 4)
  rebuildFlowers()
}

function rebuildFlowers() {
  flowerInstances.forEach((f) => flowerGroup.remove(f))
  flowerInstances.length = 0

  const total = 250
  const range = state.flowerRange

  for (let i = 0; i < total; i++) {
    const angle = Math.random() * Math.PI * 2
    const dist = 3 + Math.random() * range
    const x = Math.cos(angle) * dist
    const z = Math.sin(angle) * dist

    // 建筑和路前方留空地
    if (Math.abs(x) < 2.5 && z > -1.5 && z < 3) continue
    if (Math.abs(x) < 1.2 && z > 2 && z < Math.min(17, range + 5)) continue

    const template = Math.random() < 0.5 ? sunflowerTpl : marigoldTpl
    const flower = template.clone(true)
    const s = state.flowerSizeMin + Math.random() * (state.flowerSizeMax - state.flowerSizeMin)
    flower.scale.multiplyScalar(s)

    const bboxBottom = template.userData.bboxBottom * s
    flower.position.set(x, -bboxBottom, z)
    flower.rotation.y = Math.random() * Math.PI * 2
    flower.visible = false
    flowerGroup.add(flower)
    flowerInstances.push(flower)
  }
  updateFlowerDensity(state.flowerDensity)
}

function updateFlowerDensity(count) {
  const n = Math.min(count, flowerInstances.length)
  for (let i = 0; i < flowerInstances.length; i++) {
    flowerInstances[i].visible = i < n
  }
}

// ---- 建筑 ----
let building = null
const buildingState = saved.buildingState ?? { px: 0, py: 0, pz: 0, sx: 1, sy: 1, sz: 1, opacity: 1 }
async function initBuilding() {
  building = await loadFBX(BUILDING_PATH, 5)
  building.position.set(buildingState.px, buildingState.py - building.userData.bboxBottom, buildingState.pz)
  buildingState.py = buildingState.py || -building.userData.bboxBottom
  scene.add(building)
  updateBuildingTransform()
}

function updateBuildingTransform() {
  if (!building) return
  building.position.set(buildingState.px, buildingState.py, buildingState.pz)
  building.scale.set(buildingState.sx, buildingState.sy, buildingState.sz)
  building.traverse((c) => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material]
      mats.forEach((m) => {
        m.transparent = buildingState.opacity < 1
        m.opacity = buildingState.opacity
        m.depthWrite = buildingState.opacity > 0.99
      })
    }
  })
}

// ---- 汽车 ----
let car = null
const carState = saved.carState ?? { px: 0, py: 0, pz: 6, sx: 1, sy: 1, sz: 1, opacity: 1 }
async function initCar() {
  car = await loadOBJ(VRMOBIL_PATH, VRMOBIL_MTL, 3)
  car.position.set(carState.px, carState.py - car.userData.bboxBottom, carState.pz)
  carState.py = carState.py || -car.userData.bboxBottom
  scene.add(car)
  updateCarTransform()
}

function updateCarTransform() {
  if (!car) return
  car.position.set(carState.px, carState.py, carState.pz)
  car.scale.set(carState.sx, carState.sy, carState.sz)
  car.traverse((c) => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material]
      mats.forEach((m) => {
        m.transparent = carState.opacity < 1
        m.opacity = carState.opacity
        m.depthWrite = carState.opacity > 0.99
      })
    }
  })
}

// ---- 体积云（球体簇） ----
const cloudGroup = new THREE.Group()
scene.add(cloudGroup)
let cloudPuffs = []

function createVolumetricClouds(count) {
  cloudPuffs.forEach((g) => cloudGroup.remove(g))
  cloudPuffs = []
  for (let i = 0; i < count; i++) {
    const g = new THREE.Group()
    const size = 2 + Math.random() * 4
    const n = 6 + Math.floor(Math.random() * 10)
    for (let j = 0; j < n; j++) {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(size * (0.3 + Math.random() * 0.7), 7, 6),
        new THREE.MeshStandardMaterial({
          color: '#ffffff',
          transparent: true,
          opacity: 0.5 + Math.random() * 0.3,
          roughness: 1,
          depthWrite: false,
        }),
      )
      s.position.set(
        (Math.random() - 0.5) * size * 2.5,
        (Math.random() - 0.5) * size * 0.6,
        (Math.random() - 0.5) * size * 1.8,
      )
      s.scale.y = 0.4 + Math.random() * 0.3
      g.add(s)
    }
    g.position.set(
      (Math.random() - 0.5) * 35,
      12 + Math.random() * 10,
      (Math.random() - 0.5) * 35,
    )
    cloudGroup.add(g)
    cloudPuffs.push(g)
  }
}
createVolumetricClouds(state.cloudDensity)

// 恢复太阳位置
if (saved.sunPos) { sun.position.set(saved.sunPos.x, saved.sunPos.y, saved.sunPos.z) }
if (saved.sunIntensity) { sun.intensity = saved.sunIntensity }

// ---- 上方小屋场景 ----
const DIST_Y = 25
const S = 2  // 放大倍数
const distScene = new THREE.Group()
distScene.position.set(0, DIST_Y, 0)
distScene.scale.setScalar(S)
scene.add(distScene)

// 远处地面
const distGround = new THREE.Mesh(
  new THREE.PlaneGeometry(12, 8),
  new THREE.MeshStandardMaterial({ color: '#7cb342', roughness: 0.9 }),
)
distGround.rotation.x = -Math.PI / 2
distGround.receiveShadow = true
distScene.add(distGround)

// 房屋
const houseMat = new THREE.MeshStandardMaterial({ color: '#f5deb3', roughness: 0.7 })
const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 1.4), houseMat)
body.position.set(0, 0.45, 0)
body.castShadow = true; body.receiveShadow = true
distScene.add(body)

const roofMat = new THREE.MeshStandardMaterial({ color: '#c0392b', roughness: 0.6 })
const roof = new THREE.Mesh(new THREE.ConeGeometry(1.0, 0.55, 4), roofMat)
roof.position.set(0, 0.9 + 0.275, 0)
roof.rotation.y = Math.PI / 4
roof.castShadow = true; roof.receiveShadow = true
distScene.add(roof)

// 门（+Z 面）
const doorMat = new THREE.MeshStandardMaterial({ color: '#5d4037', roughness: 0.8 })
const door = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 0.45), doorMat)
door.position.set(0, 0.225, 0.701)
distScene.add(door)

// 窗户（+Z 面）
const windowMat = new THREE.MeshStandardMaterial({
  color: '#81d4fa', emissive: '#4fc3f7', emissiveIntensity: 0.2,
})
const win = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.15), windowMat)
win.position.set(0, 0.6, 0.701)
distScene.add(win)
// 窗框十字
const frameMat = new THREE.MeshStandardMaterial({ color: '#3e2723' })
const fh = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.015), frameMat)
fh.position.set(0, 0.6, 0.702); distScene.add(fh)
const fv = new THREE.Mesh(new THREE.PlaneGeometry(0.015, 0.15), frameMat)
fv.position.set(0, 0.6, 0.702); distScene.add(fv)

// 路灯（黑圆柱 + 黄色发光正方体）
const lampPole = new THREE.Mesh(
  new THREE.CylinderGeometry(0.04, 0.06, 1.0),
  new THREE.MeshStandardMaterial({ color: '#222222', roughness: 0.7 }),
)
lampPole.position.set(1.8, 0.5, 1.5)
lampPole.castShadow = true
distScene.add(lampPole)

const lampMat = new THREE.MeshStandardMaterial({ color: '#ffdd44', emissive: '#ffdd44', emissiveIntensity: 0 })
const lampCube = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), lampMat)
lampCube.position.set(1.8, 1.0, 1.5)
lampCube.castShadow = true
distScene.add(lampCube)

const lampLight = new THREE.PointLight('#ffdd44', 0, 3)
lampLight.position.set(1.8, 1.0, 1.5)
distScene.add(lampLight)

// 下面建筑前侧方路灯
const mainLampPole = new THREE.Mesh(
  new THREE.CylinderGeometry(0.06, 0.08, 3.0),
  new THREE.MeshStandardMaterial({ color: '#222222', roughness: 0.7 }),
)
mainLampPole.position.set(3, 1.5, 7)
mainLampPole.castShadow = true
scene.add(mainLampPole)

const mainLampMat = new THREE.MeshStandardMaterial({ color: '#ffdd44', emissive: '#ffdd44', emissiveIntensity: 0 })
const mainLampCube = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mainLampMat)
mainLampCube.position.set(3, 3.0, 7)
mainLampCube.castShadow = true
scene.add(mainLampCube)

const mainLampTop = new THREE.Mesh(
  new THREE.ConeGeometry(0.38, 0.4, 4),
  new THREE.MeshStandardMaterial({ color: '#222222', roughness: 0.7 }),
)
mainLampTop.position.set(3, 3.45, 7)
mainLampTop.castShadow = true
scene.add(mainLampTop)

const mainLampLight = new THREE.PointLight('#ffdd44', 0, 7)
mainLampLight.position.set(3, 3.0, 7)
scene.add(mainLampLight)

// 加载动画模型（房子左边）
const animMixers = []
const gltfLoader = new GLTFLoader()
gltfLoader.load('/models/smol_ame/scene.gltf', (gltf) => {
  const model = gltf.scene
  model.scale.setScalar(0.8)
  model.position.set(0, 5.0, 0)
  model.rotation.y = 0
  model.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
  scene.add(model)

  if (gltf.animations && gltf.animations.length > 0) {
    const mixer = new THREE.AnimationMixer(model)
    gltf.animations.forEach((clip) => mixer.clipAction(clip).play())
    animMixers.push(mixer)
  }
})

// 门前黄色小路（CatmullRom 曲线）
const pathPts = [
  new THREE.Vector3(0, 0.01, 0.7),
  new THREE.Vector3(0.4, 0.01, 1.3),
  new THREE.Vector3(-0.3, 0.01, 2.0),
  new THREE.Vector3(0.6, 0.01, 2.8),
]
const pathCurve = new THREE.CatmullRomCurve3(pathPts)
const pathMesh = new THREE.Mesh(
  new THREE.TubeGeometry(pathCurve, 30, 0.08, 4, false),
  new THREE.MeshStandardMaterial({ color: '#fdd835', roughness: 0.7 }),
)
pathMesh.scale.y = 0.3
pathMesh.receiveShadow = true
distScene.add(pathMesh)

// 上方三朵椭球云
function addCloud(x, y, z, sx, sy, sz) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 12, 12),
    new THREE.MeshStandardMaterial({
      color: '#ffffff', transparent: true, opacity: 0.7, roughness: 0.6, depthWrite: false,
    }),
  )
  m.position.set(x, y, z)
  m.scale.set(sx, sy, sz)
  m.castShadow = false
  distScene.add(m)
}
addCloud(-2.5, 7.0, 0, 1.2, 0.5, 0.8)
addCloud(0, 7.5, 1.8, 1.4, 0.55, 0.9)
addCloud(2.8, 7.2, -1.0, 1.1, 0.45, 0.7)

// 远处树木
function distTree(x, z, s) {
  const g = new THREE.Group()
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 0.7),
    new THREE.MeshStandardMaterial({ color: '#795548' }),
  )
  trunk.position.y = 0.35; trunk.castShadow = true
  g.add(trunk)
  const leafMat = new THREE.MeshStandardMaterial({
    color: ['#4caf50', '#66bb6a', '#388e3c'][Math.floor(Math.random() * 3)],
    roughness: 0.8,
  })
  const l1 = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), leafMat)
  l1.position.y = 0.85; l1.castShadow = true; g.add(l1)
  const l2 = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.3, 8), leafMat)
  l2.position.y = 1.1; l2.castShadow = true; g.add(l2)
  const l3 = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.25, 8), leafMat)
  l3.position.y = 1.35; l3.castShadow = true; g.add(l3)
  g.position.set(x, 0, z)
  g.scale.setScalar(s)
  distScene.add(g)
}
const trees = [
  [-2.0, -1.5, 0.9], [2.2, -1.2, 0.85],
  [-1.8, 2.0, 0.95], [2.5, 1.5, 1.0],
]
trees.forEach(([x, z, s]) => distTree(x, z, s))

// ---- GUI ----
const gui = new GUI({ title: '🌼 场景控制' })

const ff = gui.addFolder('🌻 花海')
ff.add(state, 'flowerDensity', 0, 250, 1).name('花朵数量').onChange((v) => { updateFlowerDensity(v); saveState() })
ff.add(state, 'flowerSizeMin', 0.2, 3, 0.1).name('最小尺寸').onChange(() => { rebuildFlowers(); saveState() })
ff.add(state, 'flowerSizeMax', 0.2, 3, 0.1).name('最大尺寸').onChange(() => { rebuildFlowers(); saveState() })
ff.add(state, 'flowerRange', 3, 25, 0.5).name('分布半径').onChange(() => { rebuildFlowers(); saveState() })
ff.add(state, 'cloudDensity', 0, 30, 1).name('云密度').onChange((v) => { createVolumetricClouds(v); saveState() })

const bf = gui.addFolder('🏠 建筑')
bf.add(buildingState, 'px', -10, 10, 0.1).name('位置 X').onChange(() => { updateBuildingTransform(); saveState() })
bf.add(buildingState, 'py', -2, 8, 0.1).name('位置 Y').onChange(() => { updateBuildingTransform(); saveState() })
bf.add(buildingState, 'pz', -10, 10, 0.1).name('位置 Z').onChange(() => { updateBuildingTransform(); saveState() })
bf.add(buildingState, 'sx', 0.1, 3, 0.01).name('缩放 X').onChange(() => { updateBuildingTransform(); saveState() })
bf.add(buildingState, 'sy', 0.1, 3, 0.01).name('缩放 Y').onChange(() => { updateBuildingTransform(); saveState() })
bf.add(buildingState, 'sz', 0.1, 3, 0.01).name('缩放 Z').onChange(() => { updateBuildingTransform(); saveState() })
bf.add(buildingState, 'opacity', 0.1, 1, 0.01).name('不透明度').onChange(() => { updateBuildingTransform(); saveState() })

const cf = gui.addFolder('🚗 汽车')
cf.add(carState, 'px', -10, 10, 0.1).name('位置 X').onChange(() => { updateCarTransform(); saveState() })
cf.add(carState, 'py', -2, 8, 0.1).name('位置 Y').onChange(() => { updateCarTransform(); saveState() })
cf.add(carState, 'pz', -10, 10, 0.1).name('位置 Z').onChange(() => { updateCarTransform(); saveState() })
cf.add(carState, 'sx', 0.1, 3, 0.01).name('缩放 X').onChange(() => { updateCarTransform(); saveState() })
cf.add(carState, 'sy', 0.1, 3, 0.01).name('缩放 Y').onChange(() => { updateCarTransform(); saveState() })
cf.add(carState, 'sz', 0.1, 3, 0.01).name('缩放 Z').onChange(() => { updateCarTransform(); saveState() })
cf.add(carState, 'opacity', 0.1, 1, 0.01).name('不透明度').onChange(() => { updateCarTransform(); saveState() })

const lf = gui.addFolder('☀️ 光照')
lf.add(sun, 'intensity', 0.5, 5).name('阳光强度').onChange(saveState)
lf.add(sun.position, 'x', -30, 30).name('太阳 X').onChange(saveState)
lf.add(sun.position, 'y', 5, 40).name('太阳 Y').onChange(saveState)
lf.add(sun.position, 'z', -30, 30).name('太阳 Z').onChange(saveState)

const of = gui.addFolder('🌊 海洋（动漫 Voronoi）')
of.add(oUniforms.uScale, 'value', 0.01, 1.5, 0.01).name('细胞大小')
of.add(oUniforms.uSmoothness, 'value', 0, 2, 0.01).name('细胞平滑')
of.add(oUniforms.uEdgeThreshold, 'value', 0, 0.3, 0.005).name('边缘阈值')
of.add(oUniforms.uEdgeSoftness, 'value', 0, 0.1, 0.005).name('边缘柔和')
of.add(oUniforms.uFlowX, 'value', -0.5, 0.5, 0.01).name('流动 X')
of.add(oUniforms.uFlowZ, 'value', -0.5, 0.5, 0.01).name('流动 Z')
of.add(oUniforms.uCellSpeed, 'value', 0, 3, 0.05).name('细胞动画速度')
of.add(oUniforms.uNoiseScale, 'value', 0.1, 10, 0.01).name('噪声缩放')
of.add(oUniforms.uNoiseFlowSpeed, 'value', 0, 2, 0.01).name('噪声流速')
of.add(oUniforms.uDistortAmount, 'value', 0, 3, 0.01).name('扭曲量')
of.addColor(oUniforms.uDeepColor, 'value').name('深水颜色')
of.addColor(oUniforms.uMidColor, 'value').name('中间颜色')
of.add(oUniforms.uMidPos, 'value', 0.001, 0.999, 0.001).name('中间位置')
of.addColor(oUniforms.uHighlight, 'value').name('高光颜色')
of.add(oUniforms.uOpacity, 'value', 0, 1, 0.01).name('透明度')
of.add(oUniforms.uDeepOpacity, 'value', 0, 1, 0.01).name('深水透明度')
of.add(oUniforms.uFadeDistance, 'value', 10, 300, 5).name('淡出距离')
of.add(oUniforms.uFadeStrength, 'value', 0.1, 5, 0.1).name('淡出强度')
of.add(oUniforms.uWaveHeight, 'value', 0, 0.5, 0.005).name('波浪高度')
of.add(oUniforms.uWaveFreq, 'value', 0.05, 2, 0.01).name('波浪频率')
of.add(oUniforms.uWaveSpeed, 'value', 0, 2, 0.05).name('波浪速度')

// ---- 随机形状生成 ----
const shapeColors = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf39c12, 0x9b59b6, 0x1abc9c, 0xe67e22]
const shapeTypes = ['Box', 'Sphere', 'Cone', 'Cylinder', 'Torus', 'TorusKnot', 'Dodecahedron', 'Icosahedron']
let nightMode = false
const origBg = scene.background.clone()
const origFog = scene.fog
const origSunIntensity = sun.intensity
const origAmbientIntensity = 0.4
const origHemisphereIntensity = 0.5

const shapeMeshes = []
let selectedShape = null
let shapeOutline = null

function createRandomShape() {
  const type = shapeTypes[Math.floor(Math.random() * shapeTypes.length)]
  const color = shapeColors[Math.floor(Math.random() * shapeColors.length)]
  const size = 0.3 + Math.random() * 0.5
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.3 + Math.random() * 0.5, metalness: Math.random() * 0.3 })
  let geo
  switch (type) {
    case 'Box': geo = new THREE.BoxGeometry(size, size, size); break
    case 'Sphere': geo = new THREE.SphereGeometry(size * 0.5, 16, 16); break
    case 'Cone': geo = new THREE.ConeGeometry(size * 0.4, size, 16); break
    case 'Cylinder': geo = new THREE.CylinderGeometry(size * 0.4, size * 0.4, size, 16); break
    case 'Torus': geo = new THREE.TorusGeometry(size * 0.35, size * 0.12, 12, 24); break
    case 'TorusKnot': geo = new THREE.TorusKnotGeometry(size * 0.35, size * 0.12, 32, 12); break
    case 'Dodecahedron': geo = new THREE.DodecahedronGeometry(size * 0.45); break
    case 'Icosahedron': geo = new THREE.IcosahedronGeometry(size * 0.45); break
    default: geo = new THREE.BoxGeometry(size, size, size)
  }
  const mesh = new THREE.Mesh(geo, mat)
  const angle = Math.random() * Math.PI * 2
  const dist = 1 + Math.random() * 4
  mesh.position.set(Math.cos(angle) * dist, 5 + Math.random() * 6, Math.sin(angle) * dist)
  mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)
  mesh.castShadow = true; mesh.receiveShadow = true
  mesh.userData.origScale = 1
  scene.add(mesh)
  shapeMeshes.push(mesh)
}

// 所有可选中物体
const selectables = []

// 收集 distScene 中的 Mesh
distScene.traverse((c) => { if (c.isMesh) selectables.push(c) })

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const colorPicker = document.getElementById('color-picker')
const colorInput = document.getElementById('shape-color-input')
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1
  pointer.y = -(e.clientY / innerHeight) * 2 + 1
})
renderer.domElement.addEventListener('pointerup', (e) => {
  const dx = (e.clientX / innerWidth) * 2 - 1 - pointer.x
  const dy = -(e.clientY / innerHeight) * 2 + 1 - pointer.y
  if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) return

  const mouse = new THREE.Vector2(
    (e.clientX / innerWidth) * 2 - 1,
    -(e.clientY / innerHeight) * 2 + 1,
  )
  raycaster.setFromCamera(mouse, camera)
  const allMeshes = [...shapeMeshes, ...selectables]
  const intersects = raycaster.intersectObjects(allMeshes, false)

  // 复原上一个选中
  if (selectedShape) {
    selectedShape.scale.setScalar(selectedShape.userData.origScale)
    if (shapeOutline) { selectedShape.remove(shapeOutline); shapeOutline = null }
    selectedShape = null
    colorPicker.style.display = 'none'
  }

  if (intersects.length > 0) {
    const hit = intersects[0].object
    selectedShape = hit
    hit.userData.origScale = hit.scale.x
    hit.scale.multiplyScalar(1.5)
    const edges = new THREE.EdgesGeometry(hit.geometry)
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false }))
    hit.add(line)
    shapeOutline = line
    colorInput.value = '#' + hit.material.color.getHexString()
    colorPicker.style.display = 'block'
  }
})

colorInput.addEventListener('input', () => {
  if (selectedShape) selectedShape.material.color.set(colorInput.value)
})

document.getElementById('btn-delete-selected').addEventListener('click', () => {
  if (!selectedShape) return
  if (shapeOutline) { selectedShape.remove(shapeOutline); shapeOutline = null }
  scene.remove(selectedShape)
  const i1 = shapeMeshes.indexOf(selectedShape)
  if (i1 !== -1) shapeMeshes.splice(i1, 1)
  const i2 = selectables.indexOf(selectedShape)
  if (i2 !== -1) selectables.splice(i2, 1)
  selectedShape = null
  colorPicker.style.display = 'none'
})

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedShape) {
    document.getElementById('btn-delete-selected').click()
  }
})

// 星空粒子
const starCount = 300
const starGeo = new THREE.BufferGeometry()
const starPos = new Float32Array(starCount * 3)
const starCol = new Float32Array(starCount * 3)
for (let i = 0; i < starCount; i++) {
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(0.3 + Math.random() * 0.7)
  const r = 40 + Math.random() * 15
  starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
  starPos[i * 3 + 1] = r * Math.cos(phi)
  starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
  const b = 0.6 + Math.random() * 0.4
  starCol[i * 3] = b; starCol[i * 3 + 1] = b; starCol[i * 3 + 2] = 0.8 + Math.random() * 0.2
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3))
const starMat2 = new THREE.PointsMaterial({
  size: 1.2, transparent: true, opacity: 1, sizeAttenuation: true,
  vertexColors: true,
})
const stars = new THREE.Points(starGeo, starMat2)
stars.visible = false
scene.add(stars)

// ---- 雪效 ----
let snowing = false
const SNOW_COUNT = 2000
const snowGeo = new THREE.BufferGeometry()
const snowPos = new Float32Array(SNOW_COUNT * 3)
const snowVel = new Float32Array(SNOW_COUNT)
for (let i = 0; i < SNOW_COUNT; i++) {
  snowPos[i * 3] = (Math.random() - 0.5) * 60
  snowPos[i * 3 + 1] = Math.random() * 30
  snowPos[i * 3 + 2] = (Math.random() - 0.5) * 60
  snowVel[i] = 1.5 + Math.random() * 2
}
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3))

// 雪花圆形纹理
const snowCanvas = document.createElement('canvas')
snowCanvas.width = 32; snowCanvas.height = 32
const sctx = snowCanvas.getContext('2d')
const sgrd = sctx.createRadialGradient(16, 16, 0, 16, 16, 16)
sgrd.addColorStop(0, 'rgba(255,255,255,1)')
sgrd.addColorStop(0.4, 'rgba(255,255,255,0.8)')
sgrd.addColorStop(1, 'rgba(255,255,255,0)')
sctx.fillStyle = sgrd; sctx.fillRect(0, 0, 32, 32)
const snowTexture = new THREE.CanvasTexture(snowCanvas)

const snowMat = new THREE.PointsMaterial({
  map: snowTexture, size: 0.6, transparent: true, opacity: 0.8,
  depthWrite: false, blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
})
const snowSystem = new THREE.Points(snowGeo, snowMat)
snowSystem.visible = false
scene.add(snowSystem)

function toggleSnow() {
  snowing = !snowing
  snowSystem.visible = snowing
  document.getElementById('btn-snow').textContent = snowing ? '☀️ 停雪' : '❄️ 下雪'
}

document.getElementById('btn-snow').addEventListener('click', toggleSnow)

// ---- 下雨（GLTF 模型） ----
let rainModel = null
let rainVisible = false
const rainBtn = document.getElementById('btn-rain')
new GLTFLoader().load('/models/rain_2/scene.gltf', (gltf) => {
  rainModel = gltf.scene
  rainModel.position.y = 8
  rainModel.scale.setScalar(0.3)
  rainModel.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = false; c.receiveShadow = false
      if (c.material) {
        const mats = Array.isArray(c.material) ? c.material : [c.material]
        mats.forEach((m) => {
          m.transparent = true; m.opacity = 0.9; m.depthWrite = false
          m.emissive = new THREE.Color('#aaccff')
          m.emissiveIntensity = 5
          m.blending = THREE.AdditiveBlending
        })
      }
    }
  })
  rainModel.visible = false
  scene.add(rainModel)
  console.log('✅ 雨模型加载完成')
}, undefined, (err) => console.error('❌ 雨模型加载失败:', err))

rainBtn.addEventListener('click', () => {
  if (!rainModel) return
  rainVisible = !rainVisible
  rainModel.visible = rainVisible
  rainBtn.textContent = rainVisible ? '☀️ 停雨' : '🌧 下雨'
})

function toggleDayNight() {
  nightMode = !nightMode
  if (nightMode) {
    scene.background = new THREE.Color('#0a0a1a')
    scene.fog = new THREE.Fog('#0a0a1a', 15, 40)
    sun.intensity = 0.3
    scene.children.forEach((c) => {
      if (c.isAmbientLight) c.intensity = 0.15
      if (c.isHemisphereLight) c.intensity = 0.15
    })
    skyMat.uniforms.uTop.value.set('#0a0a2e')
    skyMat.uniforms.uBot.value.set('#1a1a3e')
    stars.visible = true
    lampLight.intensity = 2
    lampMat.emissiveIntensity = 2
    mainLampLight.intensity = 2
    mainLampMat.emissiveIntensity = 2
    document.getElementById('btn-daynight').textContent = '☀️ 白天'
  } else {
    scene.background = origBg
    scene.fog = origFog
    sun.intensity = origSunIntensity
    scene.children.forEach((c) => {
      if (c.isAmbientLight) c.intensity = origAmbientIntensity
      if (c.isHemisphereLight) c.intensity = origHemisphereIntensity
    })
    skyMat.uniforms.uTop.value.set('#7cb7d8')
    skyMat.uniforms.uBot.value.set('#e8f0d8')
    stars.visible = false
    lampLight.intensity = 0
    lampMat.emissiveIntensity = 0
    mainLampLight.intensity = 0
    mainLampMat.emissiveIntensity = 0
    document.getElementById('btn-daynight').textContent = '🌓 黑夜'
  }
}

document.getElementById('btn-random-shape').addEventListener('click', createRandomShape)
document.getElementById('btn-daynight').addEventListener('click', toggleDayNight)

Promise.all([initFlowers(), initBuilding(), initCar()]).then(() => {
  updateBuildingTransform()
  updateCarTransform()
  console.log('✅ 场景加载完成')
}).catch((err) => console.error('加载失败:', err))

// ---- WASD 移动视角 ----
const keyState = { w: false, a: false, s: false, d: false, q: false, e: false }
const moveSpeed = 0.25
addEventListener('keydown', (e) => {
  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault()
    gui.domElement.style.display = gui.domElement.style.display === 'none' ? '' : 'none'
  }
  switch (e.key.toLowerCase()) {
    case 'w': keyState.w = true; break
    case 'a': keyState.a = true; break
    case 's': keyState.s = true; break
    case 'q': keyState.q = true; break
    case 'e': keyState.e = true; break
    case 'd': keyState.d = true; break
  }
})
addEventListener('keyup', (e) => {
  switch (e.key.toLowerCase()) {
    case 'w': keyState.w = false; break
    case 'a': keyState.a = false; break
    case 's': keyState.s = false; break
    case 'q': keyState.q = false; break
    case 'e': keyState.e = false; break
    case 'd': keyState.d = false; break
  }
})

// ---- 动画 ----
const moveDir = new THREE.Vector3()
function animate() {
  if (keyState.w || keyState.s || keyState.a || keyState.d || keyState.q || keyState.e) {
    moveDir.set(0, 0, 0)
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    forward.y = 0; forward.normalize()
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    right.y = 0; right.normalize()
    if (keyState.w) moveDir.add(forward)
    if (keyState.s) moveDir.sub(forward)
    if (keyState.a) moveDir.sub(right)
    if (keyState.d) moveDir.add(right)
    if (keyState.q) moveDir.y -= 1
    if (keyState.e) moveDir.y += 1
    moveDir.normalize().multiplyScalar(moveSpeed)
    controls.target.add(moveDir)
    camera.position.add(moveDir)
  }
  controls.update()
  ocean.position.x = camera.position.x
  ocean.position.z = camera.position.z
  oUniforms.uCamXZ.value.set(camera.position.x, camera.position.z)
  oUniforms.uTime.value += 0.016
  for (const mixer of animMixers) mixer.update(0.016)
  if (snowing) {
    const pos = snowSystem.geometry.attributes.position.array
    for (let i = 0; i < SNOW_COUNT; i++) {
      pos[i * 3 + 1] -= snowVel[i] * 0.016
      pos[i * 3] += Math.sin(Date.now() * 0.001 + i) * 0.008
      pos[i * 3 + 2] += Math.cos(Date.now() * 0.0013 + i * 0.7) * 0.008
      if (pos[i * 3 + 1] < 0) {
        pos[i * 3 + 1] = 25 + Math.random() * 5
        pos[i * 3] = (Math.random() - 0.5) * 60
        pos[i * 3 + 2] = (Math.random() - 0.5) * 60
      }
    }
    snowSystem.geometry.attributes.position.needsUpdate = true
  }
  renderer.render(scene, camera)
  requestAnimationFrame(animate)
}
animate()

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

addEventListener('beforeunload', saveState)

console.log('🏡 草地场景 — 加载中...')
