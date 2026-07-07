import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { createOcean } from './ocean.js'
import { createSky } from './sky.js'
import { createTrack } from './track.js'

// 可用模型列表
const MODEL_REGISTRY = [
  { id: 'Train', name: '🚂 火车', path: '/models/Train/Train_1392.obj', mtl: '/models/Train/Train_1392.mtl', type: 'obj' },
  { id: 'Ocean', name: '🌊 海面', path: '/models/Ocean/CUPIC_OCEAN.obj', mtl: '/models/Ocean/CUPIC_OCEAN.mtl', type: 'obj' },
  { id: 'Railway', name: '🛤️ 铁路', path: '/models/Railway/model.obj', mtl: '/models/Railway/materials.mtl', type: 'obj' },
  { id: 'VR-Mobil', name: '🚗 汽车', path: '/models/VR-Mobil/model.obj', mtl: '/models/VR-Mobil/materials.mtl', type: 'obj' },
  { id: 'Building', name: '🏠 建筑', path: '/models/Building/building_A.fbx', type: 'fbx' },
  { id: 'DesertMarigold', name: '🌼 金盏花', path: '/models/DesertMarigold/DesertMarigold.obj', mtl: '/models/DesertMarigold/DesertMarigold.mtl', type: 'obj' },
  { id: 'Sunflower', name: '🌻 向日葵', path: '/models/Sunflower/PUSHILIN_sunflower.obj', mtl: '/models/Sunflower/PUSHILIN_sunflower.mtl', type: 'obj' },
]

export class SceneEditor {
  constructor() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#fae8c8')
    this.scene.fog = new THREE.Fog(0xa8d8ea, 50, 90)

    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200)
    this.camera.position.set(25, 15, 30)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.2
    document.body.appendChild(this.renderer.domElement)

    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement)
    this.orbitControls.enableDamping = true
    this.orbitControls.dampingFactor = 0.08
    this.orbitControls.maxPolarAngle = Math.PI / 2.1
    this.orbitControls.minDistance = 5
    this.orbitControls.maxDistance = 80
    this.orbitControls.target.set(0, 1, 0)
    this.orbitControls.update()

    this.transformMode = 'translate'
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement)
    this.transformControls.addEventListener('dragging-changed', (e) => {
      this.orbitControls.enabled = !e.value
    })
    this.scene.add(this.transformControls)

    this.selectedObject = null
    this.sceneObjects = []
    this.loadedModels = {} // id -> Promise<Group>
    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()

    this._setupLights()
    this._buildScene()
    this._buildUI()
    this._setupEvents()
    this._preloadModels()
  }

  _setupLights() {
    this.scene.add(new THREE.AmbientLight('#ffeedd', 0.8))
    this.scene.add(new THREE.HemisphereLight('#87ceeb', '#d4a574', 0.7))
    const sun = new THREE.DirectionalLight('#fff5e6', 2.0)
    sun.position.set(40, 30, 20)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    this.scene.add(sun)
    this.scene.add(new THREE.DirectionalLight('#8ecae6', 0.5).position.set(-20, 10, -30))
    this.scene.add(new THREE.DirectionalLight('#fff0d0', 0.7).position.set(-30, 5, 30))
  }

  _buildScene() {
    const sky = createSky(); this.scene.add(sky)
    const { mesh: ocean } = createOcean(); this.scene.add(ocean)
    this._addIslands()
    this._addLighthouse()
  }

  _addIslands() {
    const dark = new THREE.MeshStandardMaterial({ color: '#5a7a4a', roughness: 0.9 })
    const light = new THREE.MeshStandardMaterial({ color: '#7a9a5a', roughness: 0.9 })
    const g = new THREE.Group()
    ;[
      { x: -50, z: -40, s: 3 }, { x: 55, z: -30, s: 2 },
      { x: -45, z: 45, s: 2.5 }, { x: 60, z: 35, s: 2 },
    ].forEach(({ x, z, s }) => {
      const h = new THREE.Mesh(new THREE.SphereGeometry(s, 8, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), dark)
      h.position.set(x, -1.5 + s * 0.3, z); h.scale.y = 0.6; g.add(h)
      const t = new THREE.Mesh(new THREE.SphereGeometry(s * 0.5, 8, 6), light)
      t.position.set(x, -1.5 + s * 0.7, z); t.scale.y = 0.3; g.add(t)
    })
    this.scene.add(g)
  }

  _addLighthouse() {
    const g = new THREE.Group()
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 2.5, 8), new THREE.MeshStandardMaterial({ color: '#e8e0d0', roughness: 0.8 }))
    b.position.y = 1.25; g.add(b)
    const r = new THREE.Mesh(new THREE.ConeGeometry(0.7, 0.6, 6), new THREE.MeshStandardMaterial({ color: '#c0392b', roughness: 0.7 }))
    r.position.y = 2.8; g.add(r)
    g.position.set(-50, -1.5, 35); g.scale.set(1.5, 1.5, 1.5)
    this.scene.add(g)
  }

  async _loadSingleModel(reg) {
    try {
      let object
      if (reg.type === 'fbx') {
        const loader = new FBXLoader()
        object = await new Promise((res, rej) => loader.load(reg.path, res, undefined, rej))
      } else {
        const mtlLoader = new MTLLoader()
        const materials = await new Promise((res, rej) => mtlLoader.load(reg.mtl, res, undefined, rej))
        materials.preload()
        const objLoader = new OBJLoader()
        objLoader.setMaterials(materials)
        object = await new Promise((res, rej) => objLoader.load(reg.path, res, undefined, rej))
      }

      object.traverse((c) => {
        if (c.isMesh) { c.castShadow = true; c.receiveShadow = true }
      })

      // 自动缩放以适应场景
      const box = new THREE.Box3().setFromObject(object)
      const size = new THREE.Vector3()
      box.getSize(size)
      const maxDim = Math.max(size.x, size.y, size.z)
      if (maxDim > 0) {
        const targetSize = 5
        const s = targetSize / maxDim
        object.scale.set(s, s, s)
      }

      // 默认放到原点
      object.position.set(0, 0, 0)

      return object
    } catch (err) {
      console.error(`加载 ${reg.name} 失败:`, err)
      return null
    }
  }

  _preloadModels() {
    MODEL_REGISTRY.forEach((reg) => {
      this.loadedModels[reg.id] = this._loadSingleModel(reg)
    })
  }

  async addModelToScene(modelId) {
    const reg = MODEL_REGISTRY.find((r) => r.id === modelId)
    if (!reg) return

    if (!this.loadedModels[reg.id]) {
      this.loadedModels[reg.id] = this._loadSingleModel(reg)
    }

    const template = await this.loadedModels[reg.id]
    if (!template) return

    // 克隆模型，保留材质
    const clone = template.clone(true)
    clone.traverse((c) => {
      if (c.isMesh) { c.castShadow = true; c.receiveShadow = true }
    })

    // 随机偏移防止重叠
    const angle = Math.random() * Math.PI * 2
    const dist = 2 + Math.random() * 4
    clone.position.set(Math.cos(angle) * dist, 0, Math.sin(angle) * dist)

    clone.userData.modelId = modelId
    clone.userData.modelName = reg.name

    this.scene.add(clone)
    this.sceneObjects.push(clone)
    this._refreshSceneList()

    return clone
  }

  removeSelected() {
    if (!this.selectedObject) return
    this.transformControls.detach()
    this.scene.remove(this.selectedObject)
    this.sceneObjects = this.sceneObjects.filter((o) => o !== this.selectedObject)
    this.selectedObject = null
    this._refreshSceneList()
    this._hideProperties()
  }

  selectObject(obj) {
    if (this.selectedObject === obj) return
    this.selectedObject = obj
    if (obj) {
      this.transformControls.attach(obj)
      this._showProperties(obj)
    } else {
      this.transformControls.detach()
      this._hideProperties()
    }
  }

  setTransformMode(mode) {
    this.transformMode = mode
    this.transformControls.setMode(mode)
  }

  // ---- 点击选择 ----
  _onPointerDown(event) {
    this.pointer.x = (event.clientX / innerWidth) * 2 - 1
    this.pointer.y = -(event.clientY / innerHeight) * 2 + 1
  }

  _onPointerUp(event) {
    const dx = (event.clientX / innerWidth) * 2 - 1 - this.pointer.x
    const dy = -(event.clientY / innerHeight) * 2 + 1 - this.pointer.y
    // 只有鼠标移动很小时才算点击（不是拖拽）
    if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) return

    this.raycaster.setFromCamera(
      new THREE.Vector2((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1),
      this.camera,
    )

    const meshes = []
    this.sceneObjects.forEach((obj) => {
      obj.traverse((c) => { if (c.isMesh) meshes.push(c) })
    })

    const intersects = this.raycaster.intersectObjects(meshes, false)
    if (intersects.length > 0) {
      let target = intersects[0].object
      // 找到所属的场景对象（最外层 userData 有 modelId 的父级）
      while (target.parent && !target.parent.userData?.modelId) {
        target = target.parent
      }
      const sceneObj = target.parent?.userData?.modelId ? target.parent : intersects[0].object
      // 找到 sceneObjects 中对应的顶层 Group
      let selected = null
      for (const obj of this.sceneObjects) {
        if (obj === sceneObj || obj === target.parent) { selected = obj; break }
        let found = false
        obj.traverse((c) => { if (c === intersects[0].object) found = true })
        if (found) { selected = obj; break }
      }
      this.selectObject(selected || intersects[0].object)
    } else {
      this.selectObject(null)
    }
  }

  // ---- UI ----
  _buildUI() {
    // 侧边栏容器
    const sidebar = document.createElement('div')
    sidebar.id = 'editor-sidebar'
    sidebar.innerHTML = `
      <div class="sidebar-header">🎮 场景编辑器</div>
      <div class="sidebar-section">
        <div class="section-title">📦 模型库</div>
        <div id="model-library" class="model-library"></div>
      </div>
      <div class="sidebar-section">
        <div class="section-title">📋 场景对象</div>
        <div id="scene-list" class="scene-list"></div>
      </div>
      <div id="properties-panel" class="sidebar-section" style="display:none">
        <div class="section-title">⚙️ 属性</div>
        <div id="properties-content"></div>
      </div>
      <div class="sidebar-section mode-switch">
        <button data-mode="translate" class="active">↕ 移动</button>
        <button data-mode="rotate">↻ 旋转</button>
        <button data-mode="scale">⇔ 缩放</button>
        <button id="delete-btn">🗑 删除</button>
      </div>
    `
    document.body.appendChild(sidebar)

    // 模型库按钮
    const lib = document.getElementById('model-library')
    MODEL_REGISTRY.forEach((reg) => {
      const btn = document.createElement('button')
      btn.className = 'model-btn'
      btn.innerHTML = reg.name
      btn.addEventListener('click', () => {
        this.addModelToScene(reg.id)
      })
      lib.appendChild(btn)
    })

    // 模式切换
    sidebar.querySelectorAll('.mode-switch button[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sidebar.querySelectorAll('.mode-switch button').forEach((b) => b.classList.remove('active'))
        btn.classList.add('active')
        this.setTransformMode(btn.dataset.mode)
      })
    })

    // 删除
    document.getElementById('delete-btn').addEventListener('click', () => this.removeSelected())

    // 键盘事件
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') this.removeSelected()
    })
  }

  _refreshSceneList() {
    const list = document.getElementById('scene-list')
    list.innerHTML = ''
    this.sceneObjects.forEach((obj, idx) => {
      const item = document.createElement('div')
      item.className = 'scene-item'
      if (obj === this.selectedObject) item.classList.add('selected')
      item.innerHTML = `${obj.userData.modelName || '对象'} #${idx + 1}`
      item.addEventListener('click', () => this.selectObject(obj))
      list.appendChild(item)
    })
  }

  _showProperties(obj) {
    const panel = document.getElementById('properties-panel')
    panel.style.display = 'block'
    const content = document.getElementById('properties-content')

    const data = {
      px: obj.position.x,
      py: obj.position.y,
      pz: obj.position.z,
      rx: THREE.MathUtils.radToDeg(obj.rotation.x),
      ry: THREE.MathUtils.radToDeg(obj.rotation.y),
      rz: THREE.MathUtils.radToDeg(obj.rotation.z),
      sx: obj.scale.x,
      sy: obj.scale.y,
      sz: obj.scale.z,
    }

    content.innerHTML = `
      <label>位置 X <input type="range" min="-30" max="30" step="0.1" value="${data.px}" data-prop="px"></label>
      <label>位置 Y <input type="range" min="-10" max="30" step="0.1" value="${data.py}" data-prop="py"></label>
      <label>位置 Z <input type="range" min="-30" max="30" step="0.1" value="${data.pz}" data-prop="pz"></label>
      <label>旋转 X° <input type="range" min="-180" max="180" step="1" value="${data.rx}" data-prop="rx"></label>
      <label>旋转 Y° <input type="range" min="-180" max="180" step="1" value="${data.ry}" data-prop="ry"></label>
      <label>旋转 Z° <input type="range" min="-180" max="180" step="1" value="${data.rz}" data-prop="rz"></label>
      <label>缩放 X <input type="range" min="0.1" max="10" step="0.1" value="${data.sx}" data-prop="sx"></label>
      <label>缩放 Y <input type="range" min="0.1" max="10" step="0.1" value="${data.sy}" data-prop="sy"></label>
      <label>缩放 Z <input type="range" min="0.1" max="10" step="0.1" value="${data.sz}" data-prop="sz"></label>
    `

    content.querySelectorAll('input[data-prop]').forEach((input) => {
      input.addEventListener('input', () => {
        const v = parseFloat(input.value)
        const prop = input.dataset.prop
        switch (prop) {
          case 'px': obj.position.x = v; break
          case 'py': obj.position.y = v; break
          case 'pz': obj.position.z = v; break
          case 'rx': obj.rotation.x = THREE.MathUtils.degToRad(v); break
          case 'ry': obj.rotation.y = THREE.MathUtils.degToRad(v); break
          case 'rz': obj.rotation.z = THREE.MathUtils.degToRad(v); break
          case 'sx': obj.scale.x = v; break
          case 'sy': obj.scale.y = v; break
          case 'sz': obj.scale.z = v; break
        }
      })
    })

    // 材质参数
    const mats = []
    obj.traverse((c) => {
      if (c.isMesh && c.material) {
        const mat = c.material
        const name = mat.name || `材质 ${mats.length + 1}`
        if (!mats.find((m) => m.name === name)) {
          mats.push({ name, material: mat })
        }
      }
    })

    if (mats.length > 0) {
      const matHtml = mats.map((m) => {
        const colorHex = '#' + m.material.color.getHexString()
        return `<div class="mat-section">
          <div class="mat-title">${m.name}</div>
          <label>颜色 <input type="color" value="${colorHex}" data-mat-name="${m.name}" data-mat-prop="color"></label>
          <label>粗糙度 <input type="range" min="0" max="1" step="0.01" value="${m.material.roughness ?? 0.5}" data-mat-name="${m.name}" data-mat-prop="roughness"></label>
          <label>金属感 <input type="range" min="0" max="1" step="0.01" value="${m.material.metalness ?? 0}" data-mat-name="${m.name}" data-mat-prop="metalness"></label>
        </div>`
      }).join('')
      content.innerHTML += `<div class="section-title">🎨 材质</div>${matHtml}`

      content.querySelectorAll('input[data-mat-prop]').forEach((input) => {
        input.addEventListener('input', () => {
          const name = input.dataset.matName
          const prop = input.dataset.matProp
          const mat = mats.find((m) => m.name === name)?.material
          if (!mat) return
          if (prop === 'color') { mat.color.set(input.value) }
          else if (prop === 'roughness') { mat.roughness = parseFloat(input.value) }
          else if (prop === 'metalness') { mat.metalness = parseFloat(input.value) }
        })
      })
    }
  }

  _hideProperties() {
    document.getElementById('properties-panel').style.display = 'none'
  }

  _setupEvents() {
    this.renderer.domElement.addEventListener('pointerdown', (e) => this._onPointerDown(e))
    this.renderer.domElement.addEventListener('pointerup', (e) => this._onPointerUp(e))

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(innerWidth, innerHeight)
    })
  }

  animate() {
    const loop = () => {
      requestAnimationFrame(loop)
      this.orbitControls.update()
      this.renderer.render(this.scene, this.camera)
    }
    loop()
  }
}
