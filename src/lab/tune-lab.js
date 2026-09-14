// ============================================================================
// 纯调参场景：只有 天空 / 海面 / 轨道 / 列车，没有游戏逻辑
// 右上角 lil-gui 可实时调参；调好后点「导出参数」，把 JSON 给我即可写进游戏。
// 访问： /tune.html
// ============================================================================
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import GUI from 'lil-gui'
import { createGhibliSky } from '../sky.js'
import { createAnimeOcean, OCEAN_PRESETS } from '../ocean.js'
import { createFloatingTrack } from '../floatingTrack'
import { createCarriageModelById } from '../carriage.js'

export function bootTuneLab() {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  document.body.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#cde4f0')
  scene.fog = new THREE.Fog('#cde4f0', 70, 1700)

  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 4000)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.target.set(0, 2, 0)

  scene.add(new THREE.AmbientLight('#ffeedd', 0.4))
  scene.add(new THREE.HemisphereLight('#87ceeb', '#6a8a4a', 0.5))
  const sun = new THREE.DirectionalLight('#fff8e6', 2.5)
  sun.position.set(20, 20, 10)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.5, 130)
  scene.add(sun)

  const sky = createGhibliSky(1500, sun)
  scene.add(sky.mesh)

  const { mesh: ocean, uniforms: oU } = createAnimeOcean()
  scene.add(ocean)

  // 用游戏当前（白天）参数起步
  const applyOceanPreset = (p) => {
    oU.uDeepColor.value.set(p.uDeepColor)
    oU.uMidColor.value.set(p.uMidColor)
    oU.uHighlight.value.set(p.uHighlight)
    oU.uOpacity.value = p.uOpacity
    oU.uDeepOpacity.value = p.uDeepOpacity
    oU.uWaveHeight.value = p.uWaveHeight
  }
  applyOceanPreset(OCEAN_PRESETS.day)

  const floatingTrack = createFloatingTrack(scene)
  floatingTrack.arm()

  const train = new THREE.Group()
  train.add(createCarriageModelById('summer'))
  train.position.set(0, 1.0, 0)
  scene.add(train)

  // 相机跟车厢（可开关）
  const state = {
    follow: true, speed: 6, moving: true, trainY: 1.0,
    preset: sky.currentPreset,
  }
  const camOffset = new THREE.Vector3(8.5, 4.4, 11.5)
  const lookOffset = new THREE.Vector3(0, 3.8, 0)
  const placeCamera = () => {
    camera.position.copy(train.position).add(camOffset)
    controls.target.copy(train.position).add(lookOffset)
  }
  placeCamera()
  state.resetCam = placeCamera

  const gui = new GUI({ title: '🎛 调参（Tune）' })
  gui.domElement.style.zIndex = '999'

  // ---- 天空 ----
  const sf = gui.addFolder('☁️ 天空')
  sf.add(state, 'preset', { 夏日蓝天: 'summer', 黄昏: 'dusk' }).name('预设').onChange((v) => sky.setPreset(v, true, 2))
  sf.add(sky.uniforms.uCoverage, 'value', 0, 1, 0.01).name('云覆盖度')
  sf.add(sky.uniforms.uCloudScale, 'value', 0.2, 3, 0.01).name('云缩放')
  sf.add(sky.uniforms.uCloudSpeed, 'value', 0, 4, 0.05).name('云速度')
  sf.add(sky.uniforms.uCloudSoft, 'value', 0.02, 0.4, 0.005).name('云柔和')
  sf.add(sky.uniforms.uCurve, 'value', 0, 0.6, 0.01).name('云弧面')
  sf.addColor(sky.uniforms.uZenith, 'value').name('天顶色')
  sf.addColor(sky.uniforms.uMid, 'value').name('中部色')
  sf.addColor(sky.uniforms.uHorizon, 'value').name('地平线色')
  sf.addColor(sky.uniforms.uCloudLight, 'value').name('云受光色')
  sf.addColor(sky.uniforms.uCloudDark, 'value').name('云背光色')
  sf.add(sky.uniforms.uShadeSteps, 'value', 1, 6, 1).name('卡通分层')

  // ---- 海面 ----
  const of = gui.addFolder('🌊 海面')
  const OCEAN_LABELS = {
    uScale: '细胞大小',
    uSmoothness: '细胞平滑',
    uEdgeThreshold: '边缘阈值',
    uEdgeSoftness: '边缘柔和',
    uFlowX: '流动 X',
    uFlowZ: '流动 Z',
    uCellSpeed: '细胞动画速度',
    uNoiseScale: '噪声缩放',
    uNoiseFlowSpeed: '噪声流速',
    uDistortAmount: '扭曲量',
    uMidPos: '中间色位置',
    uOpacity: '总体不透明度',
    uDeepOpacity: '深水不透明度',
    uFadeDistance: '淡出距离',
    uFadeStrength: '淡出强度',
    uWaveHeight: '波浪高度',
    uWaveFreq: '波浪频率',
    uWaveSpeed: '波浪速度',
  }
  Object.keys(OCEAN_LABELS).forEach((k) => of.add(oU[k], 'value', undefined, undefined, 0.01).name(OCEAN_LABELS[k]))
  of.addColor(oU.uDeepColor, 'value').name('深水颜色')
  of.addColor(oU.uMidColor, 'value').name('中间颜色')
  of.addColor(oU.uHighlight, 'value').name('高光颜色')
  of.add({ day: () => applyOceanPreset(OCEAN_PRESETS.day) }, 'day').name('· 载入白天参数')
  of.add({ dusk: () => applyOceanPreset(OCEAN_PRESETS.dusk) }, 'dusk').name('· 载入黄昏/夜晚参数')

  // ---- 轨道 ----
  const tf = gui.addFolder('🛤 轨道（段长/段数改动需刷新）')
  const TRACK_LABELS = {
    LEAD: '起始浮起距离',
    APPEAR_END: '完全就位距离',
    KEEP_BEHIND: '车尾保持距离',
    FALL: '下沉距离',
    SUBMERGE: '起始水深',
    UP_Y: '就位高度',
    START_RAMP: '起步浮起时长(s)',
    VISIBLE_H: '出现高度阈值',
  }
  Object.keys(TRACK_LABELS).forEach((k) => {
    tf.add(floatingTrack.params, k, 0, 120, 0.1).name(TRACK_LABELS[k])
  })

  // ---- 列车 ----
  const cf = gui.addFolder('🚂 列车')
  cf.add(state, 'trainY', 0, 3, 0.01).name('高度 Y').onChange((v) => { train.position.y = v })
  cf.add(state, 'speed', 0, 30, 0.5).name('速度')
  cf.add(state, 'moving').name('前进')
  cf.add(state, 'follow').name('相机跟随')

  // ---- 视图 ----
  const vf = gui.addFolder('📐 视图')
  vf.add(state, 'resetCam').name('重设机位').onChange(() => placeCamera())
  const view = { fogNear: 70, fogFar: 1700, exposure: 1.2 }
  vf.add(view, 'fogNear', 5, 3000, 1).name('雾开始').onChange((v) => { scene.fog.near = v })
  vf.add(view, 'fogFar', 50, 4000, 5).name('雾完全').onChange((v) => { scene.fog.far = v })
  vf.add(view, 'exposure', 0.2, 2.5, 0.01).name('曝光').onChange((v) => { renderer.toneMappingExposure = v })

  // ---- 导出参数 ----
  const hex = (c) => '#' + c.getHexString()
  function collect() {
    const ocean = {}
    Object.keys(oU).forEach((k) => {
      const v = oU[k].value
      ocean[k] = (v && v.isColor) ? hex(v) : v
    })
    const skyU = {}
    Object.keys(sky.uniforms).forEach((k) => {
      const v = sky.uniforms[k].value
      if (v && v.isColor) skyU[k] = hex(v)
      else if (typeof v === 'number') skyU[k] = v
    })
    return {
      ocean, sky: { preset: sky.currentPreset, uniforms: skyU },
      track: { ...floatingTrack.params },
      train: { y: train.position.y },
      fog: { near: scene.fog.near, far: scene.fog.far },
    }
  }
  const actions = {
    export() {
      const data = collect()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'tune-params.json'
      a.click()
      URL.revokeObjectURL(a.href)
      console.log('TUNE PARAMS >>>', JSON.stringify(data))
    },
    copy() {
      const text = JSON.stringify(collect())
      navigator.clipboard?.writeText(text)
      console.log('TUNE PARAMS >>>', text)
    },
  }
  gui.add(actions, 'export').name('⬇ 导出参数 JSON')
  gui.add(actions, 'copy').name('📋 复制参数到剪贴板')

  window.__tune = { scene, camera, renderer, sky, oU, floatingTrack, train, collect }

  const clock = new THREE.Clock()
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05)
    oU.uTime.value += dt
    sky.update(dt)
    if (state.moving) {
      const prevX = train.position.x
      train.position.x += state.speed * dt
      const dx = train.position.x - prevX
      if (state.follow) { camera.position.x += dx; controls.target.x += dx }
    }
    floatingTrack.update(train.position.x, dt)
    sun.target.position.set(train.position.x, 0, 0)
    sun.target.updateMatrixWorld()
    oU.uCamXZ.value.set(camera.position.x, camera.position.z)
    sky.mesh.position.set(camera.position.x, 0, camera.position.z)
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
