// ============================================================================
// 剧情流程：
//   开场黑屏 → 列车员对白 → 选项 → 选车厢 → 倒计时 → 球形揭示发车
//   → 一直向前行驶（不再回头、不再抵达某处）
//   → 蓝天/黄昏/夜晚(星环)/回到蓝天 循环
//   相机：位置跟随车厢，角度完全交给鼠标（OrbitControls）
// ============================================================================
import './vn-dialog.css'
import './story.css'
import * as THREE from 'three'
import { VNDialogue } from './vn-dialog.js'

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
  const { train, floatingTrack, gui } = ctx
  hideUI(gui)
  hideOldScene(ctx)       // 原场景不要了
  floatingTrack.setArmed(false) // 初始没有轨道

  const black = document.createElement('div')
  black.id = 'story-black'
  document.body.appendChild(black)

  const dialog = new VNDialogue({ spriteSrc: '/ui/conductor.png', typeSpeed: 34 })

  const waitChoice = () => new Promise((res) => { dialog.o.onChoice = (c, i) => res({ c, i }) })
  const waitComplete = () => new Promise((res) => { dialog.o.onComplete = () => res() })

  async function run() {
    dialog.play(RULES, { speaker: '列车员' })
    await waitComplete()

    dialog.play(REPLY_CHOICES, { speaker: '' })
    await waitChoice()
    dialog.play(REPLY_AFTER, { speaker: '列车员' })
    await waitComplete()

    dialog.play('接下来，选择你的列车。', { speaker: '列车员' })
    await waitComplete()
    dialog.close()
    await wait(400)

    const chosen = await showCarriageSelect()
    await startBgm(chosen)

    dialog.play('嗯，那么接下来准备发车了。', { speaker: '列车员' })
    await waitComplete()
    dialog.close()
    await wait(350)

    await countdown(['3', '2', '1'])
    await revealSphere()
    ctx.setCarriage?.(chosen.id)   // 换成所选车厢的模型

    // 先让玩家看清自己的列车、把话说完，再启动
    dialog.play('（列车在海上跑？）（嗯？路呢？）', { speaker: '我' })
    await waitChoice()
    dialog.play('你会习惯的。；路，一直都在你脚下。', { speaker: '列车员' })
    await waitComplete()
    await wait(600)
    dialog.close()

    // 缓慢启动 + 轨道从水下缓慢浮起，随后进入正常铺设
    createDriver(ctx)
    floatingTrack.arm()

    timeline(ctx)
  }

  run().catch((e) => console.error('剧情流程出错:', e))
}

// 原场景整体隐藏（不再展示、不再出现）
function hideOldScene(ctx) {
  ;(ctx.land || []).forEach((o) => { if (o) o.visible = false })
  if (ctx.displayGroup) ctx.displayGroup.visible = false
  const ame = ctx.scene.getObjectByName('smolAme')
  if (ame) ame.visible = false
}

// ---- 选车厢 ----
function showCarriageSelect() {
  return new Promise((resolve) => {
    const panel = document.createElement('div')
    panel.id = 'carriage-select'
    panel.classList.add('show')
    panel.innerHTML = '<h2>选择你的列车</h2><div class="cs-row"></div>'
    const row = panel.querySelector('.cs-row')
    let preview = null
    CARRIAGES.forEach((c) => {
      const b = document.createElement('button')
      b.className = 'cs-item'
      b.innerHTML = `<span class="swatch" style="background:${c.swatch}"></span>
        <span>${c.name}</span><span class="song">♪ ${c.song}</span>`
      b.addEventListener('mouseenter', () => {
        if (preview) { preview.pause(); preview.currentTime = 0 }
        preview = new Audio(c.audio)
        preview.volume = 0.5
        preview.play().catch(() => {})
      })
      b.addEventListener('mouseleave', () => { if (preview) { preview.pause(); preview = null } })
      b.addEventListener('click', () => {
        if (preview) { preview.pause(); preview = null }
        row.querySelectorAll('.cs-item').forEach((x) => x.classList.remove('picked'))
        b.classList.add('picked')
        setTimeout(() => { panel.remove(); resolve(c) }, 320)
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

// ---- 行驶：一直向前；相机只跟随位置，角度交给鼠标 ----
function createDriver(ctx) {
  const { camera, controls, train, sun } = ctx
  const SPEED_MAX = 15
  const ACCEL = 2.5               // 缓慢启动：约 6s 加速到全速
  const camOffset = new THREE.Vector3(8.5, 4.4, 11.5)  // 相机相对车厢的初始偏移（更远一点）
  const lookOffset = new THREE.Vector3(0, 3.8, 0)      // 视点抬高 → 视线接近水平，天空占更多画面

  camera.position.copy(train.position).add(camOffset)
  controls.target.copy(train.position).add(lookOffset)
  controls.enabled = true

  let prevX = train.position.x
  let speed = 0
  window.__storyUpdate = (dt) => {
    speed = Math.min(SPEED_MAX, speed + ACCEL * dt) // 由慢到快
    train.position.x += speed * dt
    const dx = train.position.x - prevX
    prevX = train.position.x
    camera.position.x += dx
    controls.target.x += dx
    if (sun) { sun.target.position.x = train.position.x; sun.target.updateMatrixWorld() }
  }
}

// ---- 时间循环：蓝天 → 黄昏 → 夜(星环) → 蓝天 → … ----
async function timeline(ctx) {
  const { sky, skyUniforms, starUniforms } = ctx
  const cov = skyUniforms.uCoverage.value

  for (;;) {
    await wait(12000)                       // 蓝天行驶
    sky.setPreset('dusk', true, 7)          // → 黄昏（长过渡，云继续流动）
    await wait(12000)
    await tween(3.5, (k) => { skyUniforms.uCoverage.value = lerp(cov, 0, k) }) // 云淡出
    await tween(5, (k) => { skyUniforms.uNightMode.value = k })               // 变暗
    starUniforms.uSwirlMode.value = 1       // 星环
    starUniforms.uTrailTime.value = 0
    await wait(10000)
    starUniforms.uSwirlMode.value = 0
    sky.setPreset('summer', true, 6)        // → 回到蓝天
    await tween(6, (k) => {
      skyUniforms.uNightMode.value = 1 - k
      skyUniforms.uCoverage.value = lerp(0, cov, k)
    })
  }
}
