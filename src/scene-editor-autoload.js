// ============================================================
// scene-editor-autoload.js
// 极简接入：在你的入口文件里加【一行】即可
//
//     import './scene-editor-autoload.js'
//
// 它会在首次渲染时自动捕获 scene / camera / renderer
// （并尽力捕获 OrbitControls），无需手动传入任何引用。
// 随后按 Tab 即可进入编辑模式。
//
// 可选：通过全局对象传配置
//     window.__sceneEditorOptions = { storageKey: 'my-app:layout', unit: 'cm' }
// 使位置等配置生效；也可随时使用 window.__sceneEditor。
// ============================================================

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { SceneEditor } from './scene-editor.js'

const opts = (typeof window !== 'undefined' && window.__sceneEditorOptions) || {}
const autoRescan = opts.autoRescan !== false

let editor = null
const ctx = { scene: null, camera: null, renderer: null, controls: null }

function startRescan() {
  let left = 20
  const timer = setInterval(() => {
    if (!editor) { clearInterval(timer); return }
    editor.scan()
    if (--left <= 0) clearInterval(timer)
  }, 1500)
}

function attachIfReady() {
  if (editor || !ctx.scene || !ctx.camera || !ctx.renderer) return
  try {
    editor = new SceneEditor({
      ...opts,
      scene: ctx.scene,
      camera: ctx.camera,
      renderer: ctx.renderer,
      controls: ctx.controls,
    })
    if (typeof window !== 'undefined') window.__sceneEditor = editor
    console.log('%c🎛 场景编辑器已自动挂载：按 Tab 进入编辑模式', 'color:#4ea1ff')
    if (autoRescan) startRescan()
  } catch (err) {
    console.error('[scene-editor] 自动挂载失败', err)
  }
}

// 1) 尽力捕获 OrbitControls（用于拖动 gizmo 时自动禁用相机控制）
try {
  const origUpdate = OrbitControls.prototype.update
  OrbitControls.prototype.update = function (...args) {
    if (!ctx.controls) ctx.controls = this
    return origUpdate.apply(this, args)
  }
} catch { /* 忽略：宿主未使用 OrbitControls 时无碍 */ }

// 2) 从首次 render 调用中捕获 scene / camera / renderer
//    注意：three 的 WebGLRenderer.render 是「实例属性」（构造函数里 this.render = ...），
//    直接改原型无效；这里在原型上装 getter/setter，借构造函数赋值时把实例钩住。
try {
  const RendererProto = THREE.WebGLRenderer.prototype
  Object.defineProperty(RendererProto, 'render', {
    configurable: true,
    get() { return this.__scedRender },
    set(fn) {
      const self = this
      this.__scedRender = function () {
        if (!ctx.renderer) {
          ctx.renderer = self
          ctx.scene = arguments[0]
          ctx.camera = arguments[1]
        }
        attachIfReady()
        return fn.apply(self, arguments)
      }
    },
  })
} catch (err) {
  console.warn('[scene-editor] 挂钩 WebGLRenderer.render 失败', err)
}
