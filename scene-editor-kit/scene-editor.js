// ============================================================
// scene-editor.js
// 可移植的 Three.js 场景编辑器（单文件 / 零构建）
// 挂载到宿主场景，按 Tab 进入编辑模式，编辑「资产整体」的
// 位置 / 旋转 / 缩放，支持保存(localStorage)与 JSON 导入导出，
// 并可写回宿主游戏。
//
// 用法:
//   import { SceneEditor } from './scene-editor.js'
//   const editor = new SceneEditor({ scene, camera, renderer, controls })
// ============================================================

import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'

const STYLE_ID = 'sced-styles'
const HTML_VERSION = 1
const HISTORY_LIMIT = 100

const DEG = THREE.MathUtils.radToDeg
const RAD = THREE.MathUtils.degToRad

function sanitizeId(name) {
  const s = String(name || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return s || 'asset'
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}

// ============================================================
// 2D 界面（DOM）编辑器
// 让任意 HTML 元素可被拖拽移动 / 缩放，并按 id 持久化布局。
// 与 3D 编辑器相互独立，通过 scene-editor 的「界面」标签页使用。
// ============================================================
export class UIEditor {
  constructor(options = {}) {
    const { storageKey = 'scene-editor:ui-layout', onSelect = null, onChange = null } = options
    this.storageKey = storageKey
    this.onSelect = onSelect
    this.onChange = onChange
    this.items = new Map()   // id -> { el, id, name }
    this.selection = null
    this.enabled = false
    this._drag = null
    this._pending = null
    this._buildLayer()
    this._bind()
    this._maybeRestore()
  }

  _buildLayer() {
    const layer = document.createElement('div')
    layer.className = 'sced-drag-layer'
    layer.style.display = 'none'
    layer.innerHTML = `
      <div class="sced-ui-hit" style="display:none">
        <div class="sced-ui-label"></div>
        <div class="sced-ui-handle" data-dir="nw"></div>
        <div class="sced-ui-handle" data-dir="ne"></div>
        <div class="sced-ui-handle" data-dir="sw"></div>
        <div class="sced-ui-handle" data-dir="se"></div>
      </div>`
    document.body.appendChild(layer)
    this.layer = layer
    this.hit = layer.querySelector('.sced-ui-hit')
    this.label = layer.querySelector('.sced-ui-label')
  }

  _bind() {
    this._onDown = (e) => this._handleDown(e)
    this._onMove = (e) => this._handleMove(e)
    this._onUp = () => this._handleUp()
    document.addEventListener('pointerdown', this._onDown, true)
    document.addEventListener('pointermove', this._onMove, true)
    document.addEventListener('pointerup', this._onUp, true)
    window.addEventListener('scroll', () => this._syncHit(), true)
    window.addEventListener('resize', () => this._syncHit())
  }

  setEnabled(on) {
    this.enabled = !!on
    this.layer.style.display = on ? 'block' : 'none'
    if (!on) this.select(null)
    else this._syncHit()
  }

  /** 把一个 DOM 元素登记为可编辑界面 */
  register(el, meta = {}) {
    if (!el || el.nodeType !== 1) return null
    let id = meta.id || el.dataset.uiId
    if (!id) id = 'ui_' + Math.random().toString(36).slice(2, 8)
    el.dataset.uiId = id
    if (meta.name) el.dataset.uiName = meta.name
    const name = meta.name || el.dataset.uiName || id
    this.items.set(id, { el, id, name })
    return id
  }

  unregister(idOrEl) {
    const rec = typeof idOrEl === 'string' ? this.items.get(idOrEl)
      : this.list().find((r) => r.el === idOrEl)
    if (!rec) return this
    this.items.delete(rec.id)
    if (this.selection === rec.id) this.select(null)
    return this
  }

  /** 扫描页面：默认收拢带 data-ui-id 的元素；autoSelectors 可额外纳入选择器匹配的元素 */
  scan(root = document.body, options = {}) {
    root.querySelectorAll('[data-ui-id]').forEach((el) => {
      const id = el.dataset.uiId
      if (id && !this.items.has(id)) this.items.set(id, { el, id, name: el.dataset.uiName || id })
    })
    for (const sel of options.autoSelectors || []) {
      root.querySelectorAll(sel).forEach((el) => {
        if (!el.dataset.uiId) this.register(el, { name: el.dataset.uiName })
      })
    }
    return this.items.size
  }

  list() { return [...this.items.values()] }

  select(idOrEl) {
    const rec = typeof idOrEl === 'string' ? this.items.get(idOrEl)
      : this.list().find((r) => r.el === idOrEl)
    this.selection = rec?.id || null
    if (rec) this._applyDefaults(rec.el)
    this._syncHit()
    if (this.onSelect) this.onSelect(this.selection)
    return this
  }

  _applyDefaults(el) {
    const cs = getComputedStyle(el)
    if (cs.translate === 'none') el.style.translate = '0px 0px'
  }

  _readTranslate(el) {
    const t = getComputedStyle(el).translate
    if (!t || t === 'none') return { x: 0, y: 0 }
    const parts = t.split(' ').map((v) => parseFloat(v) || 0)
    return { x: parts[0] || 0, y: parts[1] || 0 }
  }

  _handleDown(e) {
    if (!this.enabled) return
    const handle = e.target.closest?.('.sced-ui-handle')
    const rec = this.selection ? this.items.get(this.selection) : null
    if (handle && rec) {
      e.preventDefault(); e.stopPropagation()
      const r = rec.el.getBoundingClientRect()
      this._drag = { mode: 'resize', dir: handle.dataset.dir, startX: e.clientX, startY: e.clientY,
        el: rec.el, w0: r.width, h0: r.height }
      return
    }
    const el = e.target.closest?.('[data-ui-id]')
    if (el && this.items.has(el.dataset.uiId)) {
      e.preventDefault(); e.stopPropagation()
      this.select(el.dataset.uiId)
      this._drag = { mode: 'move', startX: e.clientX, startY: e.clientY, el, t0: this._readTranslate(el) }
    } else {
      this.select(null)
    }
  }

  _handleMove(e) {
    if (!this.enabled || !this._drag) return
    const d = this._drag
    e.preventDefault(); e.stopPropagation()
    if (d.mode === 'move') {
      const x = Math.round(d.t0.x + (e.clientX - d.startX))
      const y = Math.round(d.t0.y + (e.clientY - d.startY))
      d.el.style.translate = `${x}px ${y}px`
    } else {
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      let w = d.w0, h = d.h0
      if (d.dir.includes('e')) w = d.w0 + dx
      if (d.dir.includes('w')) w = d.w0 - dx
      if (d.dir.includes('s')) h = d.h0 + dy
      if (d.dir.includes('n')) h = d.h0 - dy
      d.el.style.width = Math.max(8, Math.round(w)) + 'px'
      d.el.style.height = Math.max(8, Math.round(h)) + 'px'
    }
    this._syncHit()
  }

  _handleUp() {
    if (!this._drag) return
    this._drag = null
    this._syncHit()
    this.save()
    if (this.onChange) this.onChange()
  }

  _syncHit() {
    const rec = this.selection ? this.items.get(this.selection) : null
    if (!this.enabled || !rec || !rec.el.isConnected) { this.hit.style.display = 'none'; return }
    const r = rec.el.getBoundingClientRect()
    Object.assign(this.hit.style, {
      display: 'block', left: r.left + 'px', top: r.top + 'px',
      width: r.width + 'px', height: r.height + 'px',
    })
    this.label.textContent = rec.name
  }

  serialize() {
    const out = {}
    for (const rec of this.items.values()) {
      const cs = getComputedStyle(rec.el)
      const t = this._readTranslate(rec.el)
      out[rec.id] = {
        name: rec.name,
        x: Math.round(t.x), y: Math.round(t.y),
        width: cs.width, height: cs.height,
        fontSize: cs.fontSize,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden',
        zIndex: cs.zIndex,
      }
    }
    return out
  }

  applyLayout(data) {
    if (!data) return this
    for (const [id, entry] of Object.entries(data)) {
      const rec = this.items.get(id)
      if (!rec) continue
      const el = rec.el
      if (typeof entry.x === 'number' || typeof entry.y === 'number') {
        el.style.translate = `${entry.x || 0}px ${entry.y || 0}px`
      }
      if (entry.width && entry.width !== 'auto') el.style.width = entry.width
      if (entry.height && entry.height !== 'auto') el.style.height = entry.height
      if (entry.fontSize) el.style.fontSize = entry.fontSize
      if (typeof entry.visible === 'boolean') el.style.display = entry.visible ? '' : 'none'
      if (entry.zIndex && entry.zIndex !== 'auto') el.style.zIndex = entry.zIndex
    }
    return this
  }

  reset() {
    for (const rec of this.items.values()) {
      rec.el.style.translate = ''
      rec.el.style.width = ''
      rec.el.style.height = ''
      rec.el.style.fontSize = ''
    }
    return this
  }

  save() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.serialize())) } catch { /* ignore */ }
    return this
  }

  _maybeRestore() {
    try {
      const raw = localStorage.getItem(this.storageKey)
      if (raw) this._pending = JSON.parse(raw)
    } catch { /* ignore */ }
  }

  /** 元素登记完成后调用，应用上次保存的界面布局 */
  restore() {
    if (this._pending) { this.applyLayout(this._pending); this._pending = null }
    return this
  }
}

export class SceneEditor {
  constructor(options = {}) {
    const {
      scene, camera, renderer, controls = null,
      storageKey = 'scene-editor:' + (typeof location !== 'undefined' ? location.pathname : 'layout'),
      autoScan = true,
      autoRestore = true,
      locale = 'zh',
      normalizeImport = false,
      targetImportSize = 2,
      showGrid = true,
      gridSize = 40,
      gridDivisions = 40,
      unit = 'm',
      container = null,
      enableUIEditing = true,
      uiAutoSelectors = [],
    } = options

    if (!scene || !camera || !renderer) {
      throw new Error('[scene-editor] scene / camera / renderer 为必需参数')
    }

    this.scene = scene
    this.camera = camera
    this.renderer = renderer
    this.domElement = renderer.domElement
    this.controls = controls
    this.storageKey = storageKey
    this.locale = locale
    this.autoRestore = autoRestore
    this._restored = false
    this.normalizeImport = normalizeImport
    this.targetImportSize = targetImportSize
    this.showGrid = showGrid
    this.gridSize = gridSize
    this.gridDivisions = gridDivisions
    this.unit = unit === 'cm' ? 'cm' : 'm'
    this.unitFactor = this.unit === 'cm' ? 100 : 1

    this.listeners = new Map()
    this.assets = []
    this.byId = new Map()
    this.selection = []
    this.helpers = new Map()
    this.ignored = new WeakSet()

    this.editMode = false
    this.transformMode = 'translate'
    this.space = 'world'

    this.raycaster = new THREE.Raycaster()
    this._pointer = new THREE.Vector2()
    this._down = null
    this._dragBefore = null
    this._idCounter = 0

    this.history = { stack: [], index: -1, limit: HISTORY_LIMIT }

    // 2D 界面（DOM）编辑器
    this.uiAutoSelectors = uiAutoSelectors
    this.ui = enableUIEditing
      ? new UIEditor({
        storageKey: this.storageKey + ':ui',
        onSelect: () => this._refreshUIList(),
        onChange: () => this._refreshUIList(),
      })
      : null

    this._bind()
    this._injectStyles()
    this._buildUI(container)
    this._setupTransform()
    this._setupGrid()
    this._setEditModeUI()

    if (autoScan) this.scan()
    this._initHistory()
    this._maybeRestore()
  }

  // 便捷入口：自动从 window 或 window.__sceneEditorContext 中寻找
  // scene / camera / renderer / controls，省去逐项传入。
  static autoAttach(options = {}) {
    const win = typeof window !== 'undefined' ? window : {}
    const ctx = options.context || win.__sceneEditorContext || {}
    const scene = options.scene || ctx.scene || win.scene || win.SCENE
    const camera = options.camera || ctx.camera || win.camera || win.CAMERA
    const renderer = options.renderer || ctx.renderer || win.renderer || win.RENDERER
    const controls = options.controls ?? ctx.controls ?? win.controls ?? null
    if (!scene || !camera || !renderer) {
      console.warn('[scene-editor] autoAttach 未找到 scene/camera/renderer；请显式传入或先暴露到 window')
      return null
    }
    const { context, ...rest } = options
    const editor = new SceneEditor({ ...rest, scene, camera, renderer, controls })
    win.__sceneEditor = editor
    return editor
  }

  // ---------------------------------------------------------
  // 事件
  // ---------------------------------------------------------
  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(cb)
    return () => this.off(event, cb)
  }

  off(event, cb) {
    this.listeners.get(event)?.delete(cb)
  }

  _emit(event, payload) {
    this.listeners.get(event)?.forEach((cb) => {
      try { cb(payload) } catch (e) { console.error('[scene-editor] listener error', e) }
    })
  }

  _bind() {
    this._onKeyDown = (e) => this._handleKeyDown(e)
    this._onKeyUp = (e) => this._handleKeyUp(e)
    this._onResize = () => this._updateHelpers()
    this._onPointerDown = (e) => this._handlePointerDown(e)
    this._onPointerUp = (e) => this._handlePointerUp(e)
    this._onDrop = (e) => this._handleDrop(e)
    this._onDragOver = (e) => { if (this.editMode) e.preventDefault() }
    this._onBlur = () => { this._setSnap(false) }

    window.addEventListener('keydown', this._onKeyDown, true)
    window.addEventListener('keyup', this._onKeyUp, true)
    window.addEventListener('resize', this._onResize)
    window.addEventListener('blur', this._onBlur)
    window.addEventListener('dragover', this._onDragOver)
    window.addEventListener('drop', this._onDrop)
    this.domElement.addEventListener('pointerdown', this._onPointerDown)
    this.domElement.addEventListener('pointerup', this._onPointerUp)
  }

  // ---------------------------------------------------------
  // TransformControls
  // ---------------------------------------------------------
  _setupTransform() {
    this.tc = new TransformControls(this.camera, this.domElement)
    this.tc.setMode(this.transformMode)
    this.tc.setSpace(this.space)
    this.tc.setSize(0.9)
    this.tc.enabled = false
    this._tcHelper = this.tc.getHelper()
    this._tcHelper.visible = false
    this.scene.add(this._tcHelper)

    this.tc.addEventListener('dragging-changed', (e) => {
      if (this.controls) this.controls.enabled = !e.value
      if (e.value) this._beginDrag()
      else this._endDrag()
    })
    this.tc.addEventListener('objectChange', () => this._onObjectChange())
  }

  _setupGrid() {
    const grid = new THREE.GridHelper(this.gridSize, this.gridDivisions, 0x8fa0b4, 0x4a5563)
    grid.position.y = 0.002
    grid.visible = false
    grid.renderOrder = -1
    grid.userData.editorIgnore = true
    grid.raycast = () => {}
    this.scene.add(grid)
    this._grid = grid

    const group = new THREE.Group()
    group.visible = false
    group.userData.editorIgnore = true
    this._axisLabels = []
    const len = 2
    const axes = new THREE.AxesHelper(len)
    axes.userData.editorIgnore = true
    axes.raycast = () => {}
    group.add(axes)
    const L = len + 0.35
    const labels = [
      this._makeAxisLabel('X', '#ff5555', new THREE.Vector3(L, 0, 0)),
      this._makeAxisLabel('Y', '#5bff5b', new THREE.Vector3(0, L, 0)),
      this._makeAxisLabel('Z', '#6a8cff', new THREE.Vector3(0, 0, L)),
    ]
    for (const s of labels) { group.add(s); this._axisLabels.push(s) }
    this.scene.add(group)
    this._axesGroup = group
  }

  _makeAxisLabel(text, color, position) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = color
    ctx.font = 'bold 46px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 32, 36)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: false,
    }))
    sprite.position.copy(position)
    sprite.scale.setScalar(0.7)
    sprite.userData.editorIgnore = true
    sprite.raycast = () => {}
    return sprite
  }

  _beginDrag() {
    this._dragBefore = this.selection.map((root) => ({
      root,
      position: root.position.clone(),
      quaternion: root.quaternion.clone(),
      scale: root.scale.clone(),
    }))
  }

  _onObjectChange() {
    const primary = this.tc.object
    if (!primary || !this._dragBefore) return
    const before = this._dragBefore.find((d) => d.root === primary)
    if (!before) return

    const mode = this.tc.getMode()
    const dPos = primary.position.clone().sub(before.position)
    const dQuat = primary.quaternion.clone().multiply(before.quaternion.clone().invert())
    const dScale = new THREE.Vector3(
      before.scale.x ? primary.scale.x / before.scale.x : 1,
      before.scale.y ? primary.scale.y / before.scale.y : 1,
      before.scale.z ? primary.scale.z / before.scale.z : 1,
    )

    for (const d of this._dragBefore) {
      if (d.root === primary) continue
      if (mode === 'translate') {
        d.root.position.copy(d.position).add(dPos)
      } else if (mode === 'rotate') {
        d.root.quaternion.copy(dQuat).multiply(d.quaternion)
      } else if (mode === 'scale') {
        d.root.scale.set(d.scale.x * dScale.x, d.scale.y * dScale.y, d.scale.z * dScale.z)
      }
    }

    this._updateHelpers()
    this._syncInspector()
  }

  _endDrag() {
    this._dragBefore = null
    this._pushHistory()
  }

  setTransformMode(mode) {
    this.transformMode = mode
    this.tc.setMode(mode)
    this._refreshToolbar()
  }

  setSpace(space) {
    this.space = space
    this.tc.setSpace(space)
    this._refreshToolbar()
  }

  setUnit(unit) {
    this.unit = unit === 'cm' ? 'cm' : 'm'
    this.unitFactor = this.unit === 'cm' ? 100 : 1
    this._refreshToolbar()
    this._refreshGridHint()
    this._syncInspector()
    return this
  }

  _unitLabel() {
    return this.unit === 'cm' ? '厘米' : '米'
  }

  _refreshGridHint() {
    const hint = this.container?.querySelector('#sced-grid-hint')
    if (!hint) return
    const perCell = (this.gridSize / Math.max(this.gridDivisions, 1)) * this.unitFactor
    hint.textContent = `网格：1 格 = ${round3(perCell)} ${this._unitLabel()}`
  }

  _setSnap(on) {
    this.tc.translationSnap = on ? 0.5 : null
    this.tc.rotationSnap = on ? Math.PI / 12 : null
    this.tc.scaleSnap = on ? 0.1 : null
  }

  // ---------------------------------------------------------
  // 资产注册 / 扫描
  // ---------------------------------------------------------
  register(root, meta = {}) {
    if (!root || !root.isObject3D) return null
    if (this.ignored.has(root)) return null

    const prev = root.userData.editorAsset
    const name = meta.name || prev?.name || root.name || '资产'
    let id = meta.id || prev?.id
    if (!id) id = this._uniqueId(name)
    else if (this.byId.has(id) && this.byId.get(id).root !== root) id = this._uniqueId(name)

    const existing = this.byId.get(id)
    if (existing && existing.root === root) {
      existing.name = name
      existing.source = meta.source ?? existing.source
      root.userData.editorAsset = { id, name, source: existing.source }
      this._refreshOutliner()
      return existing
    }

    const source = meta.source ?? prev?.source ?? null
    root.userData.editorAsset = { id, name, source }
    const rec = this._makeRec(root, id, name, source)
    this.assets.push(rec)
    this.byId.set(id, rec)
    this._refreshOutliner()
    this._emit('change')
    return rec
  }

  markAsAsset(root, meta = {}) {
    return this.register(root, meta)
  }

  ignore(obj) {
    if (obj && obj.isObject3D) this.ignored.add(obj)
    return this
  }

  unregister(objOrId) {
    const rec = typeof objOrId === 'string'
      ? this.byId.get(objOrId)
      : this.assets.find((a) => a.root === objOrId)
    if (!rec) return this
    this.assets = this.assets.filter((a) => a !== rec)
    this.byId.delete(rec.id)
    this.selection = this.selection.filter((r) => r !== rec.root)
    this._removeHelper(rec.root)
    if (this.tc.object === rec.root) this.tc.detach()
    this._refreshOutliner()
    this._syncInspector()
    this._emit('change')
    return this
  }

  scan() {
    for (const child of [...this.scene.children]) {
      if (!this._isCandidate(child)) continue
      if (this._recByRoot(child)) continue
      this.register(child)
    }
    this._refreshOutliner()
    this._maybeRestore()
    return this
  }

  _isCandidate(obj) {
    if (!obj || !obj.isObject3D) return false
    if (obj === this._tcHelper) return false
    if (this.ignored.has(obj)) return false
    if (obj.userData.editorIgnore) return false
    if (obj.isLight || obj.isCamera) return false
    if (obj.isGridHelper || obj.isAxesHelper) return false
    let hasMesh = false
    obj.traverse((o) => { if (o.isMesh || o.isSprite) hasMesh = true })
    return hasMesh
  }

  _uniqueId(name) {
    const base = sanitizeId(name)
    let id = base
    let n = 1
    while (this.byId.has(id)) { n += 1; id = `${base}_${n}` }
    return id
  }

  _makeRec(root, id, name, source) {
    return {
      root, id, name, source,
      base: {
        p: root.position.toArray(),
        r: [root.rotation.x, root.rotation.y, root.rotation.z],
        s: root.scale.toArray(),
        v: root.visible,
      },
    }
  }

  _recByRoot(root) {
    return this.assets.find((a) => a.root === root) || null
  }

  _findAssetRoot(obj) {
    let o = obj
    while (o) {
      const meta = o.userData?.editorAsset
      if (meta && this.byId.get(meta.id)?.root === o) return o
      o = o.parent
    }
    return null
  }

  setAssetId(root, id) {
    const rec = this._recByRoot(root)
    if (!rec || !id) return this
    this.byId.delete(rec.id)
    rec.id = id
    root.userData.editorAsset.id = id
    this.byId.set(id, rec)
    this._refreshOutliner()
    return this
  }

  // ---------------------------------------------------------
  // 选择
  // ---------------------------------------------------------
  select(objOrId, additive = false) {
    let root = null
    if (typeof objOrId === 'string') {
      root = this.byId.get(objOrId)?.root
        || this.assets.find((a) => a.name === objOrId)?.root
        || null
    }
    else if (objOrId?.isObject3D) root = this._recByRoot(objOrId)?.root || this._findAssetRoot(objOrId) || null
    this._selectRoot(root, additive)
    return this
  }

  _selectRoot(root, additive = false) {
    if (!root) {
      if (!additive) this._setSelection([])
      return
    }
    if (additive) {
      const next = this.selection.slice()
      const i = next.indexOf(root)
      if (i >= 0) next.splice(i, 1)
      else next.push(root)
      this._setSelection(next)
    } else {
      this._setSelection([root])
    }
  }

  _setSelection(roots) {
    this.selection = roots.filter((r) => this._recByRoot(r))
    this._attachGizmo()
    this._refreshHelpers()
    this._refreshOutliner()
    this._syncInspector()
    this._emit('selectionchange', this.selection.slice())
  }

  clearSelection() {
    this._setSelection([])
    return this
  }

  _attachGizmo() {
    const primary = this.selection[this.selection.length - 1]
    if (primary && this.editMode) this.tc.attach(primary)
    else this.tc.detach()
  }

  // ---------------------------------------------------------
  // 选中高亮：随物体旋转的整体包围框（局部空间，挂在对象下）
  // ---------------------------------------------------------
  _refreshHelpers() {
    const wanted = new Set(this.selection)
    for (const [root, helper] of [...this.helpers]) {
      if (!wanted.has(root)) this._removeHelper(root)
    }
    for (const root of this.selection) {
      if (!this.helpers.has(root)) this.helpers.set(root, this._createOutline(root))
    }
  }

  _computeLocalBox(root) {
    root.updateWorldMatrix(true, true)
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert()
    const m = new THREE.Matrix4()
    const box = new THREE.Box3()
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry || o.userData.editorIgnore) return
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
      if (!o.geometry.boundingBox) return
      m.multiplyMatrices(inv, o.matrixWorld)
      const b = o.geometry.boundingBox.clone().applyMatrix4(m)
      if (!b.isEmpty()) box.union(b)
    })
    if (box.isEmpty()) {
      // 纯 2D（Sprite）资产：用 sprite 的缩放当尺寸
      const center = new THREE.Vector3()
      root.traverse((o) => {
        if (!o.isSprite || o.userData.editorIgnore) return
        const mm = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)
        const b = new THREE.Box3()
          .setFromCenterAndSize(center.clone(), new THREE.Vector3(1, 1, 0.02))
          .applyMatrix4(mm)
        if (!b.isEmpty()) box.union(b)
      })
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1))
    return box
  }

  _createOutline(root) {
    const box = this._computeLocalBox(root)
    const size = box.getSize(new THREE.Vector3())
    size.set(Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3))
    const center = box.getCenter(new THREE.Vector3())
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z))
    const mat = new THREE.LineBasicMaterial({ color: 0x4ea1ff, transparent: true, opacity: 0.95, depthTest: false })
    const outline = new THREE.LineSegments(geo, mat)
    outline.position.copy(center)
    outline.renderOrder = 999
    outline.userData.editorIgnore = true
    outline.raycast = () => {}
    root.add(outline)
    return outline
  }

  _updateHelper(root) {
    // 高亮框是 root 的子对象，会随 root 的位移/旋转/缩放自动跟随，无需更新
    const helper = this.helpers.get(root)
    if (helper) helper.visible = root.visible
  }

  _updateHelpers() {
    for (const root of this.selection) this._updateHelper(root)
  }

  _removeHelper(root) {
    const helper = this.helpers.get(root)
    if (!helper) return
    helper.geometry?.dispose()
    helper.material?.dispose()
    if (helper.parent) helper.parent.remove(helper)
    this.helpers.delete(root)
  }

  _clearHelpers() {
    for (const root of [...this.helpers.keys()]) this._removeHelper(root)
  }

  // ---------------------------------------------------------
  // 指针选取
  // ---------------------------------------------------------
  _handlePointerDown(e) {
    this._down = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }
  }

  _handlePointerUp(e) {
    const d = this._down
    this._down = null
    if (!this.editMode || !d || d.button !== 0) return
    if (this.tc.dragging) return
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y)
    if (moved > 5) return

    const rect = this.domElement.getBoundingClientRect()
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this._pointer, this.camera)

    const meshes = []
    for (const a of this.assets) {
      if (!a.root.visible) continue
      a.root.traverse((o) => { if ((o.isMesh || o.isSprite) && o.visible) meshes.push(o) })
    }
    const hits = this.raycaster.intersectObjects(meshes, false)
    const additive = d.shift || d.ctrl
    if (hits.length) {
      const root = this._findAssetRoot(hits[0].object)
      this._selectRoot(root, additive)
    } else {
      if (!additive) this._setSelection([])
    }
  }

  // ---------------------------------------------------------
  // 键盘
  // ---------------------------------------------------------
  _isTyping(e) {
    const t = e.target
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  }

  _handleKeyDown(e) {
    // 正在输入框里打字：放行，交给输入框
    if (this._isTyping(e)) return

    // 捕获阶段拦截编辑器占用的按键，避免与宿主项目的快捷键冲突
    const own = (code) => {
      e.preventDefault()
      e.stopPropagation()
      void code
    }

    if (e.key === 'Tab') {
      own()
      this.toggleEditMode()
      return
    }
    if (e.key === 'Control' || e.key === 'Meta') this._setSnap(true)

    if (!this.editMode) return

    const mod = e.ctrlKey || e.metaKey
    if (mod && e.code === 'KeyS') { own(); this.save(); this._toast('已保存到本地'); return }
    if (mod && e.code === 'KeyZ') { own(); e.shiftKey ? this.redo() : this.undo(); return }
    if (mod && e.code === 'KeyY') { own(); this.redo(); return }
    if (mod && e.code === 'KeyD') { own(); this.duplicateSelected(); return }

    switch (e.code) {
      case 'KeyW': own(); this.setTransformMode('translate'); break
      case 'KeyE': own(); this.setTransformMode('rotate'); break
      case 'KeyR': own(); this.setTransformMode('scale'); break
      case 'KeyQ': own(); this.setSpace(this.space === 'world' ? 'local' : 'world'); break
      case 'KeyF': own(); this.focusSelected(); break
      case 'Delete':
      case 'Backspace': own(); this.deleteSelected(); break
      case 'Escape': own(); this.clearSelection(); break
      default: break
    }
  }

  _handleKeyUp(e) {
    if (e.key === 'Control' || e.key === 'Meta') this._setSnap(false)
  }

  // ---------------------------------------------------------
  // 编辑 / 运行模式
  // ---------------------------------------------------------
  setEditMode(on) {
    this.editMode = !!on
    this._setEditModeUI()
    return this
  }

  toggleEditMode() {
    this.setEditMode(!this.editMode)
  }

  _setEditModeUI() {
    if (this.container) this.container.style.display = this.editMode ? 'block' : 'none'
    this.tc.enabled = this.editMode
    this._tcHelper.visible = this.editMode
    if (this.editMode) {
      this._attachGizmo()
      this._refreshHelpers()
    } else {
      this.tc.detach()
      this._clearHelpers()
    }
    if (this.controls) this.controls.enabled = true
    if (this.ui) this.ui.setEnabled(this.editMode)
    if (this._grid) this._grid.visible = this.editMode && this.showGrid
    if (this._axesGroup) this._axesGroup.visible = this.editMode
    this._refreshOutliner()
    this._syncInspector()
    this._emit('modechange', this.editMode)
  }

  // ---------------------------------------------------------
  // 操作：删除 / 复制 / 重置 / 聚焦
  // ---------------------------------------------------------
  deleteSelected() {
    if (!this.selection.length) return this
    for (const root of this.selection) {
      const rec = this._recByRoot(root)
      if (!rec) continue
      if (root.parent) root.parent.remove(root)
      this._removeHelper(root)
      this.assets = this.assets.filter((a) => a !== rec)
      this.byId.delete(rec.id)
    }
    this.selection = []
    this._attachGizmo()
    this._refreshHelpers()
    this._refreshOutliner()
    this._syncInspector()
    this._pushHistory()
    return this
  }

  duplicateSelected() {
    if (!this.selection.length) return this
    const clones = []
    for (const root of this.selection) {
      const rec = this._recByRoot(root)
      const clone = root.clone(true)
      const junk = []
      clone.traverse((o) => { if (o.userData.editorIgnore) junk.push(o) })
      for (const o of junk) o.parent?.remove(o)
      clone.position.x += 0.5
      clone.position.z += 0.5
      clone.userData.editorAsset = null
      this.scene.add(clone)
      this.register(clone, { name: (rec?.name || '资产') + ' 副本' })
      clones.push(clone)
    }
    this._setSelection(clones)
    this._pushHistory()
    return this
  }

  resetLayout() {
    for (const a of this.assets) {
      a.root.position.fromArray(a.base.p)
      a.root.rotation.set(a.base.r[0], a.base.r[1], a.base.r[2], 'XYZ')
      a.root.scale.fromArray(a.base.s)
      a.root.visible = a.base.v
    }
    this._refreshHelpers()
    this._syncInspector()
    this._pushHistory()
    return this
  }

  focusSelected() {
    const target = this.selection[this.selection.length - 1]
    const box = new THREE.Box3()
    if (target) box.setFromObject(target)
    else box.setFromObject(this.scene)
    if (box.isEmpty()) return this

    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.001)
    const dir = new THREE.Vector3()
    this.camera.getWorldDirection(dir)
    const fov = (this.camera.fov * Math.PI) / 180
    const dist = (radius / Math.sin(fov / 2)) * 1.4
    this.camera.position.copy(center).add(dir.multiplyScalar(-dist))
    if (this.controls && this.controls.target) {
      this.controls.target.copy(center)
      this.controls.update?.()
    } else {
      this.camera.lookAt(center)
    }
    return this
  }

  // ---------------------------------------------------------
  // 导入
  // ---------------------------------------------------------
  async importFile(file) {
    return this.importFiles([file])
  }

  async importFiles(fileList) {
    const files = [...fileList].filter(Boolean)
    if (!files.length) return null

    const urls = new Map()
    for (const f of files) {
      const u = URL.createObjectURL(f)
      urls.set(f.name.toLowerCase(), u)
      urls.set(f.name.split(/[\\/]/).pop().toLowerCase(), u)
    }
    const manager = new THREE.LoadingManager()
    manager.setURLModifier((url) => {
      const name = decodeURIComponent(String(url).split(/[\\/?]/).pop()).toLowerCase()
      return urls.get(name) || url
    })
    const resolve = (name) => urls.get(name)

    const pick = files.find((f) => /\.(glb|gltf)$/i.test(f.name))
      || files.find((f) => /\.fbx$/i.test(f.name))
      || files.find((f) => /\.obj$/i.test(f.name))
    if (!pick) { this._toast('不支持的文件类型'); return null }

    const baseName = pick.name.replace(/\.[^.]+$/, '')
    let object = null
    try {
      if (/\.(glb|gltf)$/i.test(pick.name)) {
        const gltf = await new GLTFLoader(manager).loadAsync(resolve(pick.name.toLowerCase()))
        object = gltf.scene || gltf.scenes?.[0]
      } else if (/\.fbx$/i.test(pick.name)) {
        object = await new FBXLoader(manager).loadAsync(resolve(pick.name.toLowerCase()))
      } else {
        const mtlFile = files.find((f) => /\.mtl$/i.test(f.name))
        const loader = new OBJLoader(manager)
        if (mtlFile) {
          const materials = await new MTLLoader(manager).loadAsync(resolve(mtlFile.name.toLowerCase()))
          materials.preload()
          loader.setMaterials(materials)
        }
        object = await loader.loadAsync(resolve(pick.name.toLowerCase()))
      }
    } catch (err) {
      console.error('[scene-editor] 导入失败', err)
      this._toast('导入失败：' + (err?.message || err))
      return null
    }

    if (!object) return null
    object.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true }
    })

    const root = object.isGroup ? object : new THREE.Group().add(object)
    root.name = baseName
    if (this.normalizeImport) this._normalize(root)

    this.scene.add(root)
    this.register(root, { name: baseName, source: pick.name })
    this._setSelection([root])
    this._pushHistory()
    this._toast('已导入：' + baseName)
    return root
  }

  _normalize(root) {
    const box = new THREE.Box3().setFromObject(root)
    const size = new THREE.Vector3()
    box.getSize(size)
    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim > 0) {
      const s = this.targetImportSize / maxDim
      root.scale.setScalar(s)
    }
  }

  _handleDrop(e) {
    if (!this.editMode) return
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (files && files.length) this.importFiles(files)
  }

  // ---------------------------------------------------------
  // 布局：序列化 / 应用 / 保存 / 导入导出
  // ---------------------------------------------------------
  serialize() {
    return {
      version: HTML_VERSION,
      generator: 'scene-editor',
      objects: this.assets.map((a) => ({
        id: a.id,
        name: a.name,
        source: a.source,
        position: a.root.position.toArray().map(round3),
        rotation: [DEG(a.root.rotation.x), DEG(a.root.rotation.y), DEG(a.root.rotation.z)].map(round3),
        scale: a.root.scale.toArray().map(round3),
        visible: a.root.visible,
      })),
      ui: this.ui ? this.ui.serialize() : undefined,
    }
  }

  getLayout() {
    return this.serialize()
  }

  applyLayout(data) {
    const objects = Array.isArray(data) ? data : (data?.objects || [])
    const missing = []
    let applied = 0
    for (const entry of objects) {
      const rec = this.byId.get(entry.id)
      if (!rec) { missing.push(entry.id); continue }
      applied += 1
      const r = rec.root
      if (Array.isArray(entry.position)) r.position.fromArray(entry.position)
      if (Array.isArray(entry.rotation)) r.rotation.set(RAD(entry.rotation[0]), RAD(entry.rotation[1]), RAD(entry.rotation[2]), 'XYZ')
      if (Array.isArray(entry.scale)) r.scale.fromArray(entry.scale)
      if (typeof entry.visible === 'boolean') r.visible = entry.visible
      if (entry.name) { rec.name = entry.name; r.userData.editorAsset.name = entry.name }
    }
    this._refreshHelpers()
    this._refreshOutliner()
    this._syncInspector()
    if (this.ui && data && data.ui) {
      this._pendingUILayout = data.ui
      this.ui.applyLayout(data.ui)
    }
    if (missing.length) console.warn('[scene-editor] applyLayout 未匹配到的 id:', missing)
    this._emit('layoutapplied', { missing })
    if (applied > 0) this._pushHistory()
    return { missing }
  }

  save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.serialize()))
      if (this.ui) this.ui.save() // 同步写 UI 键，两条恢复路径都能用
      return true
    } catch (err) {
      console.error('[scene-editor] 保存失败', err)
      this._toast('保存失败（本地存储不可用），请改用导出 JSON')
      return false
    }
  }

  loadSaved() {
    try {
      const raw = localStorage.getItem(this.storageKey)
      if (!raw) return false
      this.applyLayout(JSON.parse(raw))
      return true
    } catch (err) {
      console.error('[scene-editor] 读取本地存档失败', err)
      return false
    }
  }

  // 初次扫描/注册完成后，若开启 autoRestore 且存在存档，则自动套用一次
  _maybeRestore() {
    if (!this.autoRestore || this._restored) return false
    if (!this.assets.length) return false
    let raw = null
    try { raw = localStorage.getItem(this.storageKey) } catch { return false }
    if (!raw) return false
    this._restored = true
    const ok = this.loadSaved()
    if (ok) this._toast?.('已恢复上次保存的布局')
    return ok
  }

  exportJSON(filename = 'layout.json') {
    const blob = new Blob([JSON.stringify(this.serialize(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async importJSON(file) {
    const text = await file.text()
    return this.applyLayout(JSON.parse(text))
  }

  async loadLayoutFromURL(url) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      return this.applyLayout(data)
    } catch (err) {
      console.error('[scene-editor] 加载布局失败', err)
      return { missing: [], error: String(err) }
    }
  }

  // ---------------------------------------------------------
  // 历史（快照式）
  // ---------------------------------------------------------
  _captureState() {
    return this.assets.map((a) => ({
      root: a.root, id: a.id, name: a.name, source: a.source,
      base: { p: [...a.base.p], r: [...a.base.r], s: [...a.base.s], v: a.base.v },
      p: a.root.position.toArray(),
      r: [a.root.rotation.x, a.root.rotation.y, a.root.rotation.z],
      s: a.root.scale.toArray(),
      v: a.root.visible,
    }))
  }

  _restoreState(state) {
    const roots = new Set(state.map((s) => s.root))
    for (const a of this.assets) {
      if (!roots.has(a.root) && a.root.parent) a.root.parent.remove(a.root)
    }
    this.assets = state.map((s) => {
      if (s.root.parent !== this.scene) this.scene.add(s.root)
      s.root.position.fromArray(s.p)
      s.root.rotation.set(s.r[0], s.r[1], s.r[2], 'XYZ')
      s.root.scale.fromArray(s.s)
      s.root.visible = s.v
      s.root.userData.editorAsset = { id: s.id, name: s.name, source: s.source }
      return {
        root: s.root, id: s.id, name: s.name, source: s.source,
        base: { p: [...s.base.p], r: [...s.base.r], s: [...s.base.s], v: s.base.v },
      }
    })
    this.byId = new Map(this.assets.map((a) => [a.id, a]))
    this.selection = this.selection.filter((r) => roots.has(r))
    this._attachGizmo()
    this._refreshHelpers()
    this._refreshOutliner()
    this._syncInspector()
    this._emit('change')
  }

  _initHistory() {
    this.history.stack = [this._captureState()]
    this.history.index = 0
  }

  _pushHistory() {
    const snap = this._captureState()
    this.history.stack = this.history.stack.slice(0, this.history.index + 1)
    this.history.stack.push(snap)
    if (this.history.stack.length > this.history.limit) this.history.stack.shift()
    this.history.index = this.history.stack.length - 1
    this._emit('change')
  }

  undo() {
    if (this.history.index <= 0) return this
    this.history.index -= 1
    this._restoreState(this.history.stack[this.history.index])
    return this
  }

  redo() {
    if (this.history.index >= this.history.stack.length - 1) return this
    this.history.index += 1
    this._restoreState(this.history.stack[this.history.index])
    return this
  }

  // ---------------------------------------------------------
  // 样式
  // ---------------------------------------------------------
  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
      #sced-root { position: fixed; inset: 0; z-index: 99999; pointer-events: none;
        font-family: system-ui, "Microsoft YaHei", sans-serif; color: #e6e6e6; font-size: 12px; }
      #sced-root * { box-sizing: border-box; }
      .sced-panel { position: absolute; pointer-events: auto; background: rgba(24,26,32,.92);
        border: 1px solid rgba(255,255,255,.1); border-radius: 8px; backdrop-filter: blur(6px);
        box-shadow: 0 6px 24px rgba(0,0,0,.35); }
      .sced-toolbar { top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 4px;
        padding: 6px; align-items: center; max-width: calc(100vw - 24px); flex-wrap: wrap; }
      .sced-btn { background: rgba(255,255,255,.06); color: #e6e6e6; border: 1px solid rgba(255,255,255,.1);
        border-radius: 6px; padding: 5px 9px; cursor: pointer; font-size: 12px; line-height: 1; }
      .sced-btn:hover { background: rgba(78,161,255,.22); }
      .sced-btn.active { background: #4ea1ff; color: #fff; border-color: #4ea1ff; }
      .sced-sep { width: 1px; height: 20px; background: rgba(255,255,255,.14); margin: 0 3px; }
      .sced-sidebar { top: 60px; left: 12px; bottom: 12px; width: 288px; display: flex; flex-direction: column; }
      .sced-tabs { display: flex; gap: 2px; padding: 6px 6px 0; flex: none; }
      .sced-tab { flex: 1; background: rgba(255,255,255,.05); color: #aab0ba; border: 1px solid rgba(255,255,255,.1);
        border-bottom: none; border-radius: 6px 6px 0 0; padding: 6px 0; cursor: pointer; font-size: 12px; }
      .sced-tab.is-active { background: rgba(78,161,255,.28); color: #fff; }
      .sced-tabpanes { flex: 1; min-height: 0; border-top: 1px solid rgba(255,255,255,.1); }
      .sced-tabpane { display: none; height: 100%; overflow-y: auto; padding: 6px; }
      .sced-tabpane.is-active { display: block; }
      .sced-ui-actions { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 2px 8px; }
      .sced-btn.wide { display: block; width: 100%; margin: 4px 0; text-align: left; }
      .sced-drag-layer { position: fixed; inset: 0; z-index: 99998; pointer-events: none; }
      .sced-ui-hit { position: fixed; border: 1.5px solid #4ea1ff; background: rgba(78,161,255,.12);
        pointer-events: none; box-sizing: border-box; }
      .sced-ui-hit .sced-ui-handle { position: absolute; width: 9px; height: 9px; background: #4ea1ff;
        border: 1px solid #fff; border-radius: 2px; pointer-events: auto; }
      .sced-ui-hit .sced-ui-label { position: absolute; top: -18px; left: 0; background: #4ea1ff; color: #fff;
        font-size: 11px; padding: 1px 6px; border-radius: 3px; white-space: nowrap; }
      .sced-ui-handle[data-dir="nw"] { left: -5px; top: -5px; cursor: nwse-resize; }
      .sced-ui-handle[data-dir="ne"] { right: -5px; top: -5px; cursor: nesw-resize; }
      .sced-ui-handle[data-dir="sw"] { left: -5px; bottom: -5px; cursor: nesw-resize; }
      .sced-ui-handle[data-dir="se"] { right: -5px; bottom: -5px; cursor: nwse-resize; }
      .sced-title { font-weight: 600; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.1);
        color: #9ecbff; letter-spacing: .5px; }
      .sced-list { overflow-y: auto; padding: 6px; }
      .sced-item { padding: 6px 8px; border-radius: 5px; cursor: pointer; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .sced-item:hover { background: rgba(255,255,255,.06); }
      .sced-item.selected { background: rgba(78,161,255,.28); color: #fff; }
      .sced-empty { padding: 10px; color: #8a8f98; }
      .sced-group { margin-bottom: 10px; }
      .sced-group-title { color: #9ecbff; margin: 6px 0 4px; font-weight: 600; }
      .sced-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
      .sced-row label { width: 58px; color: #aab0ba; flex: none; }
      .sced-row input[type="number"], .sced-row input[type="text"] { flex: 1; min-width: 0;
        background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12); color: #e6e6e6;
        border-radius: 4px; padding: 3px 5px; font-size: 12px; }
      .sced-row input[type="checkbox"] { flex: none; }
      .sced-overlay { left: 12px; bottom: 12px; padding: 8px 10px; line-height: 1.6; max-width: 320px; }
      .sced-hint { color: #aab0ba; }
      .sced-toast { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: rgba(20,22,28,.95); border: 1px solid rgba(78,161,255,.5); color: #fff;
        padding: 8px 14px; border-radius: 6px; pointer-events: none; opacity: 0;
        transition: opacity .2s; }
      .sced-toast.show { opacity: 1; }
    `
    document.head.appendChild(style)
  }

  // ---------------------------------------------------------
  // UI
  // ---------------------------------------------------------
  _buildUI(parent) {
    const root = document.createElement('div')
    root.id = 'sced-root'
    root.style.display = 'none'
    root.innerHTML = `
      <div class="sced-panel sced-toolbar">
        <button class="sced-btn" data-act="import">导入</button>
        <button class="sced-btn" data-act="save">保存</button>
        <button class="sced-btn" data-act="export">导出JSON</button>
        <button class="sced-btn" data-act="import-json">导入JSON</button>
        <div class="sced-sep"></div>
        <button class="sced-btn" data-mode="translate">移动</button>
        <button class="sced-btn" data-mode="rotate">旋转</button>
        <button class="sced-btn" data-mode="scale">缩放</button>
        <button class="sced-btn" data-act="space">世界</button>
        <button class="sced-btn" data-act="unit">单位 m</button>
        <div class="sced-sep"></div>
        <button class="sced-btn" data-act="undo">撤销</button>
        <button class="sced-btn" data-act="redo">回退撤销</button>
        <button class="sced-btn" data-act="duplicate">复制</button>
        <button class="sced-btn" data-act="delete">删除</button>
        <button class="sced-btn" data-act="reset">重置</button>
        <button class="sced-btn" data-act="focus">聚焦</button>
      </div>
      <div class="sced-panel sced-sidebar">
        <div class="sced-tabs">
          <button class="sced-tab is-active" data-tab="objects">对象</button>
          <button class="sced-tab" data-tab="ui">界面</button>
          <button class="sced-tab" data-tab="props">属性</button>
          <button class="sced-tab" data-tab="layout">布局</button>
        </div>
        <div class="sced-tabpanes">
          <div class="sced-tabpane is-active" data-pane="objects">
            <div class="sced-list" id="sced-list"></div>
          </div>
          <div class="sced-tabpane" data-pane="ui">
            <div class="sced-ui-actions">
              <button class="sced-btn" data-uiact="scan">扫描界面</button>
              <button class="sced-btn" data-uiact="save">保存界面</button>
              <button class="sced-btn" data-uiact="export">导出JSON</button>
              <button class="sced-btn" data-uiact="import">导入JSON</button>
            </div>
            <div class="sced-list" id="sced-ui-list"></div>
          </div>
          <div class="sced-tabpane" data-pane="props">
            <div id="sced-inspector"></div>
          </div>
          <div class="sced-tabpane" data-pane="layout">
            <div class="sced-list">
              <button class="sced-btn wide" data-act="save">保存布局（3D + 界面）</button>
              <button class="sced-btn wide" data-act="export">导出 JSON</button>
              <button class="sced-btn wide" data-act="import-json">导入 JSON</button>
              <button class="sced-btn wide" data-act="reset">重置 3D 布局</button>
            </div>
          </div>
        </div>
      </div>
      <div class="sced-panel sced-overlay">
        <div><b>编辑模式</b> · Tab 退出</div>
        <div class="sced-hint" id="sced-grid-hint"></div>
        <div class="sced-hint">W 移动 / E 旋转 / R 缩放 / Q 坐标 / F 聚焦</div>
        <div class="sced-hint">Ctrl 吸附 · Ctrl+Z 撤销 · Ctrl+S 保存 · Ctrl+D 复制</div>
      </div>
      <div class="sced-toast" id="sced-toast"></div>
    `

    const host = parent || document.body
    host.appendChild(root)
    this.container = root

    this._list = root.querySelector('#sced-list')
    this._inspector = root.querySelector('#sced-inspector')
    this._toastEl = root.querySelector('#sced-toast')
    this._refreshGridHint()

    this._list.addEventListener('click', (e) => {
      const item = e.target.closest('.sced-item')
      if (!item || !item.dataset.id) return
      const root = this.byId.get(item.dataset.id)?.root || null
      this._selectRoot(root, e.ctrlKey || e.metaKey || e.shiftKey)
    })
    this._list.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.sced-item')
      if (!item || !item.dataset.id) return
      this.select(item.dataset.id)
      this.focusSelected()
    })

    root.querySelector('.sced-toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button')
      if (!btn) return
      const mode = btn.dataset.mode
      if (mode) { this.setTransformMode(mode); return }
      this._runToolbarAction(btn.dataset.act)
    })

    // 侧边栏标签页
    this._tabsEl = root.querySelector('.sced-tabs')
    this._panesEl = root.querySelector('.sced-tabpanes')
    this._tabsEl.addEventListener('click', (e) => {
      const t = e.target.closest('.sced-tab')
      if (t) this.setSidebarTab(t.dataset.tab)
    })
    root.querySelector('.sced-tabpane[data-pane="layout"]').addEventListener('click', (e) => {
      const btn = e.target.closest('button')
      if (btn) this._runToolbarAction(btn.dataset.act)
    })

    // 界面标签页（DOM UI 编辑）
    this._uiList = root.querySelector('#sced-ui-list')
    root.querySelector('.sced-tabpane[data-pane="ui"]').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.uiact
      if (act) { this._runUIAction(act); return }
      const item = e.target.closest('.sced-item')
      if (item?.dataset.id) { this.ui?.select(item.dataset.id); this._refreshUIList() }
    })
    this._uiJsonInput = document.createElement('input')
    this._uiJsonInput.type = 'file'
    this._uiJsonInput.accept = '.json'
    this._uiJsonInput.style.display = 'none'
    this._uiJsonInput.addEventListener('change', () => {
      const f = this._uiJsonInput.files?.[0]
      if (f) {
        const rd = new FileReader()
        rd.onload = () => {
          try { this.ui?.applyLayout(JSON.parse(rd.result)); this._refreshUIList() } catch { this._toast('界面 JSON 解析失败') }
        }
        rd.readAsText(f)
      }
      this._uiJsonInput.value = ''
    })
    root.appendChild(this._uiJsonInput)
    this._refreshUIList()

    this._fileInput = document.createElement('input')
    this._fileInput.type = 'file'
    this._fileInput.multiple = true
    this._fileInput.accept = '.obj,.mtl,.gltf,.glb,.fbx'
    this._fileInput.style.display = 'none'
    this._fileInput.addEventListener('change', () => {
      if (this._fileInput.files?.length) this.importFiles(this._fileInput.files)
      this._fileInput.value = ''
    })
    root.appendChild(this._fileInput)

    this._jsonInput = document.createElement('input')
    this._jsonInput.type = 'file'
    this._jsonInput.accept = '.json'
    this._jsonInput.style.display = 'none'
    this._jsonInput.addEventListener('change', () => {
      if (this._jsonInput.files?.[0]) this.importJSON(this._jsonInput.files[0])
      this._jsonInput.value = ''
    })
    root.appendChild(this._jsonInput)

    this._refreshToolbar()
  }

  _openFilePicker() { this._fileInput.click() }
  _openJSONPicker() { this._jsonInput.click() }

  _runToolbarAction(act) {
    switch (act) {
      case 'import': this._openFilePicker(); break
      case 'save': this._toast(this.save() ? '已保存到本地' : '保存失败'); break
      case 'export': this.exportJSON(); break
      case 'import-json': this._openJSONPicker(); break
      case 'space': this.setSpace(this.space === 'world' ? 'local' : 'world'); break
      case 'unit': this.setUnit(this.unit === 'm' ? 'cm' : 'm'); break
      case 'undo': this.undo(); break
      case 'redo': this.redo(); break
      case 'duplicate': this.duplicateSelected(); break
      case 'delete': this.deleteSelected(); break
      case 'reset': this.resetLayout(); break
      case 'focus': this.focusSelected(); break
      default: break
    }
  }

  setSidebarTab(name) {
    if (!this._tabsEl) return
    this._tabsEl.querySelectorAll('.sced-tab').forEach((t) => {
      t.classList.toggle('is-active', t.dataset.tab === name)
    })
    this._panesEl.querySelectorAll('.sced-tabpane').forEach((p) => {
      p.classList.toggle('is-active', p.dataset.pane === name)
    })
    this.activeTab = name
    return this
  }

  // ---------------------------------------------------------
  // 界面（DOM UI）编辑
  // ---------------------------------------------------------
  scanUI(selectors = null) {
    if (!this.ui) return 0
    const n = this.ui.scan(document.body, { autoSelectors: selectors || this.uiAutoSelectors })
    this.ui.restore()
    // 主布局里带的 UI 布局（在 3D scan 时元素还没登记）在这里补应用
    if (this._pendingUILayout) this.ui.applyLayout(this._pendingUILayout)
    this._refreshUIList()
    return n
  }

  registerUI(el, meta = {}) {
    if (!this.ui) return null
    const id = this.ui.register(el, meta)
    if (this._pendingUILayout) this.ui.applyLayout(this._pendingUILayout)
    this._refreshUIList()
    return id
  }

  _runUIAction(act) {
    if (!this.ui) return
    switch (act) {
      case 'scan': {
        const n = this.scanUI()
        this._toast(`扫描到 ${n} 个界面元素`)
        break
      }
      case 'save':
        this.ui.save()
        this._toast('界面布局已保存')
        break
      case 'export': {
        const blob = new Blob([JSON.stringify({ version: HTML_VERSION, ui: this.ui.serialize() }, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'ui-layout.json'
        a.click()
        URL.revokeObjectURL(a.href)
        break
      }
      case 'import':
        this._uiJsonInput?.click()
        break
      default: break
    }
  }

  _refreshUIList() {
    if (!this._uiList) return
    if (!this.ui) {
      this._uiList.innerHTML = '<div class="sced-empty">界面编辑未启用</div>'
      return
    }
    const items = this.ui.list()
    if (!items.length) {
      this._uiList.innerHTML = '<div class="sced-empty">未登记界面元素<br>点「扫描界面」，或用 editor.registerUI(el)</div>'
      return
    }
    this._uiList.innerHTML = items.map((r) => {
      const sel = this.ui.selection === r.id ? ' selected' : ''
      return `<div class="sced-item${sel}" data-id="${escapeHtml(r.id)}">${escapeHtml(r.name)}</div>`
    }).join('')
  }

  _toast(msg) {
    if (!this._toastEl) return
    this._toastEl.textContent = msg
    this._toastEl.classList.add('show')
    clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => this._toastEl.classList.remove('show'), 1600)
  }

  _refreshToolbar() {
    if (!this.container) return
    this.container.querySelectorAll('.sced-toolbar [data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === this.transformMode)
    })
    const spaceBtn = this.container.querySelector('.sced-toolbar [data-act="space"]')
    if (spaceBtn) spaceBtn.textContent = this.space === 'world' ? '世界' : '本地'
    const unitBtn = this.container.querySelector('.sced-toolbar [data-act="unit"]')
    if (unitBtn) unitBtn.textContent = `单位 ${this.unit}`
  }

  _refreshOutliner() {
    if (!this._list) return
    if (!this.assets.length) {
      this._list.innerHTML = '<div class="sced-empty">场景中没有可编辑资产</div>'
      return
    }
    this._list.innerHTML = this.assets.map((a) => {
      const sel = this.selection.includes(a.root) ? ' selected' : ''
      return `<div class="sced-item${sel}" data-id="${escapeHtml(a.id)}" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>`
    }).join('')
  }

  _syncInspector() {
    if (!this._inspector) return
    const root = this.selection[this.selection.length - 1]
    if (!root) {
      this._inspector.innerHTML = '<div class="sced-title">检查器</div><div class="sced-empty">未选中资产</div>'
      return
    }
    const rec = this._recByRoot(root)
    const g = (v) => round3(v)
    const num = (label, prop, val, step) => `
      <div class="sced-row"><label>${label}</label>
      <input type="number" step="${step}" data-prop="${prop}" value="${g(val)}"></div>`
    this._inspector.innerHTML = `
      <div class="sced-title">检查器 · ${escapeHtml(rec?.name || '')}</div>
      <div class="sced-group">
        <div class="sced-group-title">位置 (${this._unitLabel()})</div>
        ${num('X', 'px', root.position.x * this.unitFactor, this.unit === 'cm' ? 1 : 0.1)}
        ${num('Y', 'py', root.position.y * this.unitFactor, this.unit === 'cm' ? 1 : 0.1)}
        ${num('Z', 'pz', root.position.z * this.unitFactor, this.unit === 'cm' ? 1 : 0.1)}
      </div>
      <div class="sced-group">
        <div class="sced-group-title">旋转 (°)</div>
        ${num('X', 'rx', DEG(root.rotation.x), 1)}
        ${num('Y', 'ry', DEG(root.rotation.y), 1)}
        ${num('Z', 'rz', DEG(root.rotation.z), 1)}
      </div>
      <div class="sced-group">
        <div class="sced-group-title">缩放</div>
        ${num('X', 'sx', root.scale.x, 0.1)}
        ${num('Y', 'sy', root.scale.y, 0.1)}
        ${num('Z', 'sz', root.scale.z, 0.1)}
      </div>
      <div class="sced-group">
        <div class="sced-row"><label>名称</label>
          <input type="text" data-prop="name" value="${escapeHtml(rec?.name || '')}"></div>
        <div class="sced-row"><label>可见</label>
          <input type="checkbox" data-prop="visible" ${root.visible ? 'checked' : ''}></div>
      </div>
    `

    this._inspector.querySelectorAll('input[data-prop]').forEach((input) => {
      const prop = input.dataset.prop
      input.addEventListener('input', () => this._applyInspector(
        root,
        prop,
        input.type === 'checkbox' ? input.checked : input.value,
      ))
      input.addEventListener('change', () => this._pushHistory())
    })
  }

  _applyInspector(root, prop, value) {
    switch (prop) {
      case 'px': root.position.x = (parseFloat(value) || 0) / this.unitFactor; break
      case 'py': root.position.y = (parseFloat(value) || 0) / this.unitFactor; break
      case 'pz': root.position.z = (parseFloat(value) || 0) / this.unitFactor; break
      case 'rx': root.rotation.x = RAD(parseFloat(value) || 0); break
      case 'ry': root.rotation.y = RAD(parseFloat(value) || 0); break
      case 'rz': root.rotation.z = RAD(parseFloat(value) || 0); break
      case 'sx': root.scale.x = parseFloat(value) || 0; break
      case 'sy': root.scale.y = parseFloat(value) || 0; break
      case 'sz': root.scale.z = parseFloat(value) || 0; break
      case 'name': {
        const rec = this._recByRoot(root)
        if (rec) { rec.name = value; root.userData.editorAsset.name = value }
        this._refreshOutliner()
        break
      }
      case 'visible': root.visible = !!value; break
      default: break
    }
    this._updateHelpers()
  }

  // ---------------------------------------------------------
  // 销毁
  // ---------------------------------------------------------
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown, true)
    window.removeEventListener('keyup', this._onKeyUp, true)
    window.removeEventListener('resize', this._onResize)
    window.removeEventListener('blur', this._onBlur)
    window.removeEventListener('dragover', this._onDragOver)
    window.removeEventListener('drop', this._onDrop)
    this.domElement.removeEventListener('pointerdown', this._onPointerDown)
    this.domElement.removeEventListener('pointerup', this._onPointerUp)

    this._clearHelpers()
    if (this._grid) { this._grid.parent?.remove(this._grid); this._grid.geometry?.dispose(); this._grid.material?.dispose?.() }
    for (const s of this._axisLabels || []) {
      s.material?.map?.dispose()
      s.material?.dispose()
    }
    if (this._axesGroup) this._axesGroup.parent?.remove(this._axesGroup)
    if (this._tcHelper?.parent) this._tcHelper.parent.remove(this._tcHelper)
    this.tc.dispose()

    document.getElementById(STYLE_ID)?.remove()
    this.container?.remove()
    this.listeners.clear()
  }
}

export default SceneEditor
