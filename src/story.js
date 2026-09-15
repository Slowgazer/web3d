// ============================================================================
// 剧情流程：
//   开场黑屏 → 对白(P5R 动态框，立绘仅对话时显示) → 选项 → 选车厢 → 倒计时
//   → 球形揭示 → 轨道缓慢浮起就位 → 列车缓慢启动
//   → 蓝天/黄昏/夜晚(星环)/回到蓝天 循环
//   + 随机事件：概率遇到一大群海鸥；右上角「召唤海鸥」按钮便于演示
// ============================================================================
import './story.css'
import './p5r-dialog.css'
import * as THREE from 'three'
import { P5RDialogue } from './p5r-dialog.js'
import { OCEAN_PRESETS } from './ocean.js'
import { spawnGullBurst } from './seagull.js'

const CARRIAGES = [
  { id: 'summer', name: '夏日幻想', song: '夏日肖像', swatch: '#e0a94a', audio: '/audio/summer.m4a' },
  { id: 'ocean', name: '海浪', song: '老人与海', swatch: '#3f8fbf', audio: '/audio/ocean.m4a' },
  { id: 'blackcat', name: '黑猫', song: '嘘月', swatch: '#2b2b33', audio: '/audio/blackcat.m4a' },
  { id: 'starry', name: '星空', song: 'ノーチラス', swatch: '#4a49a8', audio: '/audio/starry.m4a' },
  { id: 'vintage', name: '复古', song: '春泥棒', swatch: '#c9a27a', audio: '/audio/vintage.m4a' },
]

const RULES =
  '……；啊，你终于醒了，列车长；你或许有许多疑问，但那不重要；你现在只需要记住这几条规则：；' +
  '1. 列车是单程票，和时间一样，“无法返程”；' +
  '2. 这趟旅途你会见到许多奇观，但是每一种奇观你只能见到“一次”；' +
  '3. 你会遇到形形色色的人，他们都有自己的“目的”；' +
  '4. 列车不会停下，之后在特殊站点短暂停留；……；至少对你，对我来说是这样的；' +
  '5. 最重要的始终只有“你的意志”；记住了吗？'

const REPLY_CHOICES = '（记，记住了。）（额，啥？）'
const REPLY_AFTER = '……；算了。'

// 海鸥事件对白（占位，内容之后细化）
const GULL_EVENT_LINES = '（一大群海鸥突然从海面涌起，围着车厢盘旋。）；整点薯条的海鸥。；……别喂它们，列车长。'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const lerp = (a, b, k) => a + (b - a) * k

function tween(dur, fn) {
  return new Promise((res) => {
    const start = performance.now()
    const step = (now) => {
      const k = Math.min(1, (now - start) / (dur * 1000))
      fn(k)
      if (k < 1) requestAnimationFrame(step)
      else res()
    }
    requestAnimationFrame(step)
  })
}

// 海面：白天几乎不透明且鲜艳；黄昏 / 夜晚回到半透明（预设来自 ocean.js）
function presetToOcean(p) {
  return {
    deep: new THREE.Color(p.uDeepColor),
    mid: new THREE.Color(p.uMidColor),
    high: new THREE.Color(p.uHighlight),
    opacity: p.uOpacity,
    deepOpacity: p.uDeepOpacity,
    wave: p.uWaveHeight,
  }
}
const OCEAN_DAY = presetToOcean(OCEAN_PRESETS.day)
const OCEAN_DUSK = presetToOcean(OCEAN_PRESETS.dusk)

function applyOcean(u, p) {
  u.uDeepColor.value.copy(p.deep)
  u.uMidColor.value.copy(p.mid)
  u.uHighlight.value.copy(p.high)
  u.uOpacity.value = p.opacity
  u.uDeepOpacity.value = p.deepOpacity
  u.uWaveHeight.value = p.wave
}

function oceanTo(u, to, dur) {
  const from = {
    deep: u.uDeepColor.value.clone(), mid: u.uMidColor.value.clone(), high: u.uHighlight.value.clone(),
    opacity: u.uOpacity.value, deepOpacity: u.uDeepOpacity.value, wave: u.uWaveHeight.value,
  }
  return tween(dur, (k) => {
    u.uDeepColor.value.lerpColors(from.deep, to.deep, k)
    u.uMidColor.value.lerpColors(from.mid, to.mid, k)
    u.uHighlight.value.lerpColors(from.high, to.high, k)
    u.uOpacity.value = lerp(from.opacity, to.opacity, k)
    u.uDeepOpacity.value = lerp(from.deepOpacity, to.deepOpacity, k)
    u.uWaveHeight.value = lerp(from.wave, to.wave, k)
  })
}

function hideUI(gui) {
  ;['scene-tools', 'demo-links', 'color-picker', 'info'].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.style.display = 'none'
  })
  if (gui && gui.domElement) gui.domElement.style.display = 'none'
  document.querySelectorAll('button').forEach((b) => {
    if ((b.textContent || '').toUpperCase().includes('VR')) b.style.display = 'none'
  })
}

export function initStory(ctx) {
  const { train, floatingTrack, gui, oUniforms } = ctx
  hideUI(gui)
  hideOldScene(ctx)
  floatingTrack.setArmed(false)
  if (oUniforms) applyOcean(oUniforms, OCEAN_DAY)

  // 黑屏 + 左侧立绘（立绘只在对话时显示）
  const black = document.createElement('div')
  black.id = 'story-black'
  document.body.appendChild(black)
  const sprite = document.createElement('img')
  sprite.id = 'story-sprite'
  sprite.src = '/ui/conductor.png'
  sprite.alt = ''
  document.body.appendChild(sprite)
  const showSprite = () => sprite.classList.add('show')
  const hideSprite = () => sprite.classList.remove('show')

  const dialog = new P5RDialogue({ typeSpeed: 34 })
  let dialogBusy = false

  const waitChoice = () => new Promise((res) => { dialog.o.onChoice = (c, i) => res({ c, i }) })
  const waitComplete = () => new Promise((res) => { dialog.o.onEnd = () => res() })

  // 台词：显示立绘 → 播完隐藏
  async function say(raw, speaker) {
    dialogBusy = true
    showSprite()
    dialog.play(raw, { speaker })
    await waitComplete()
    hideSprite()
    dialogBusy = false
  }

  // 海鸥群
  const fx = { gullBurst: null, gullCenter: new THREE.Vector3(6, 12, 0) }
  async function triggerGullFlock({ talk = true } = {}) {
    if (fx.gullBurst && fx.gullBurst.alive) return
    try {
      fx.gullBurst = await spawnGullBurst(ctx.scene, { anchor: fx.gullCenter, count: 26, duration: 24 })
    } catch (e) {
      console.warn('海鸥加载失败：', e)
      return
    }
    if (talk && !dialogBusy) say(GULL_EVENT_LINES, '列车员')
  }

  // 右上角「召唤海鸥」按钮（发车后显示）
  const gullBtn = document.createElement('button')
  gullBtn.id = 'btn-summon-gulls'
  gullBtn.textContent = '🕊 召唤海鸥'
  gullBtn.style.display = 'none'
  gullBtn.addEventListener('click', (e) => { e.stopPropagation(); triggerGullFlock({ talk: true }) })
  document.body.appendChild(gullBtn)

  async function run() {
    await say(RULES, '列车员')

    dialogBusy = true
    showSprite()
    dialog.play(REPLY_CHOICES, { speaker: '' })
    await waitChoice()
    dialog.play(REPLY_AFTER, { speaker: '列车员' })
    await waitComplete()
    hideSprite()
    dialogBusy = false

    await say('接下来，选择你的列车。', '列车员')
    dialog.hide()
    await wait(400)

    const chosen = await showCarriageSelect()
    ctx.setCarriage?.(chosen.id)
    await startBgm(chosen)

    await say('嗯，那么接下来准备发车了。', '列车员')
    dialog.hide()
    await wait(350)

    await countdown(['3', '2', '1'])
    await revealSphere()

    // 轨道先缓慢浮起并全部就位，列车再启动
    floatingTrack.arm()
    await wait(5200)

    createDriver(ctx, fx)
    gullBtn.style.display = ''
    startRandomEvents(triggerGullFlock)
    await wait(600)

    dialogBusy = true
    showSprite()
    dialog.play('（列车在海上跑？）（嗯？路呢？）', { speaker: '我' })
    await waitChoice()
    dialog.play('你会习惯的。；路，一直都在你脚下。', { speaker: '列车员' })
    await waitComplete()
    hideSprite()
    dialogBusy = false
    await wait(600)
    dialog.hide()

    timeline(ctx)
  }

  run().catch((e) => console.error('剧情流程出错:', e))
}

// 随机事件：每隔 25–60 秒有概率遇到一群海鸥
function startRandomEvents(trigger) {
  const tick = () => {
    const delay = 25000 + Math.random() * 35000
    setTimeout(() => { trigger({ talk: true }); tick() }, delay)
  }
  tick()
}

function hideOldScene(ctx) {
  ;(ctx.land || []).forEach((o) => { if (o) o.visible = false })
  if (ctx.displayGroup) ctx.displayGroup.visible = false
  const ame = ctx.scene.getObjectByName('smolAme')
  if (ame) ame.visible = false
}

// ---- 选车厢：点击展开并试听；再次点击该选项才算确认 ----
function showCarriageSelect() {
  return new Promise((resolve) => {
    const panel = document.createElement('div')
    panel.id = 'carriage-select'
    panel.classList.add('show')
    panel.innerHTML = '<h2>选择你的列车</h2><div class="cs-row"></div>'
    const row = panel.querySelector('.cs-row')
    let picked = null
    let preview = null

    CARRIAGES.forEach((c) => {
      const b = document.createElement('button')
      b.className = 'cs-item'
      b.dataset.id = c.id
      b.innerHTML = `<span class="swatch" style="background:${c.swatch}"></span>
        <span>${c.name}</span><span class="song">♪ ${c.song}</span>
        <span class="song" style="opacity:.55">点击试听 · 再点确认</span>`
      b.addEventListener('click', () => {
        if (picked !== c.id) {
          picked = c.id
          row.querySelectorAll('.cs-item').forEach((x) => x.classList.remove('picked'))
          b.classList.add('picked')
          if (preview) { preview.pause(); preview.currentTime = 0 }
          preview = new Audio(c.audio)
          preview.volume = 0.6
          preview.play().catch(() => {})
          return
        }
        if (preview) { preview.pause(); preview = null }
        setTimeout(() => { panel.remove(); resolve(c) }, 260)
      })
      row.appendChild(b)
    })
    document.body.appendChild(panel)
  })
}

async function startBgm(carriage) {
  const audio = new Audio(carriage.audio)
  audio.loop = true
  audio.volume = 0.55
  try { await audio.play() } catch { /* 音频缺失时忽略 */ }
  return audio
}

async function countdown(items) {
  const el = document.createElement('div')
  el.id = 'story-count'
  el.className = 'show'
  document.body.appendChild(el)
  for (const n of items) {
    el.innerHTML = `<span class="num">${n}</span>`
    await wait(900)
  }
  el.remove()
}

async function revealSphere() {
  const black = document.getElementById('story-black')
  if (black) black.remove()
  const rev = document.createElement('div')
  rev.id = 'story-reveal'
  document.body.appendChild(rev)
  await tween(1.5, (k) => { rev.style.setProperty('--r', `${(k * 165).toFixed(1)}%`) })
  rev.remove()
}

// ---- 行驶：缓慢启动；相机只跟随位置，角度交给鼠标 ----
function createDriver(ctx, fx) {
  const { camera, controls, train, sun } = ctx
  const SPEED_MAX = 15
  const ACCEL = 2.5
  const camOffset = new THREE.Vector3(8.5, 4.4, 11.5)
  const lookOffset = new THREE.Vector3(0, 3.8, 0)

  camera.position.copy(train.position).add(camOffset)
  controls.target.copy(train.position).add(lookOffset)
  controls.enabled = true

  let prevX = train.position.x
  let speed = 0
  window.__storyUpdate = (dt) => {
    speed = Math.min(SPEED_MAX, speed + ACCEL * dt)
    train.position.x += speed * dt
    const dx = train.position.x - prevX
    prevX = train.position.x
    camera.position.x += dx
    controls.target.x += dx
    if (sun) { sun.target.position.x = train.position.x; sun.target.updateMatrixWorld() }

    // 海鸥群跟随车厢
    if (fx) {
      fx.gullCenter.set(train.position.x + 6, train.position.y + 11, 0)
      if (fx.gullBurst) {
        fx.gullBurst.update(dt)
        if (!fx.gullBurst.alive) fx.gullBurst = null
      }
    }
  }
}

// ---- 时间循环 + 海面昼夜 ----
async function timeline(ctx) {
  const { sky, skyUniforms, starUniforms, oUniforms } = ctx
  const cov = skyUniforms.uCoverage.value

  for (;;) {
    await wait(12000)
    sky.setPreset('dusk', true, 7)
    if (oUniforms) oceanTo(oUniforms, OCEAN_DUSK, 7)
    await wait(12000)
    await tween(3.5, (k) => { skyUniforms.uCoverage.value = lerp(cov, 0, k) })
    await tween(5, (k) => { skyUniforms.uNightMode.value = k })
    starUniforms.uSwirlMode.value = 1
    starUniforms.uTrailTime.value = 0
    await wait(10000)
    starUniforms.uSwirlMode.value = 0
    sky.setPreset('summer', true, 6)
    if (oUniforms) oceanTo(oUniforms, OCEAN_DAY, 6)
    await tween(6, (k) => {
      skyUniforms.uNightMode.value = 1 - k
      skyUniforms.uCoverage.value = lerp(0, cov, k)
    })
  }
}
