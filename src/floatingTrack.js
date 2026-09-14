// ============================================================================
// 浮起搭路：列车行进时，前方轨道从水下浮起并逐段就位
// - 预建一段轨道模板，手动浅克隆成对象池（共享几何体/材质，省显存）
// - 每段固定在自己的世界槽位：可见时绝不移动；只有完全沉没后才被回收挪到最前方
//   （旧做法是整池随时间吸附网格，会集体瞬移一格 → 「一跳一跳」）
// - 高度由「与车头的距离」直接决定，无状态、无追赶，因此连续平滑
// - 上升用 easeOutQuad = 匀减速（起始速度最大，到轨道高度速度恰好为 0，不过冲）
//   下沉用 easeInQuad = 匀加速下落
// ============================================================================
import * as THREE from 'three'
import { createRailwayTrackSegmentModel } from './createTrackModel'

const SEG_LEN = 4        // 单段长度（与模型一致）
const POOL = 26          // 对象池段数（需覆盖 前导 + 保持 + 下沉 的总跨度）
const LEAD = 60          // 车头前方多远开始浮起（越长越慢越丝滑）
const APPEAR_END = 16    // 到这个距离已完全就位（越大 = 越早、越远就位）
const KEEP_BEHIND = 24   // 车尾后方保持就位的距离
const FALL = 14          // 之后下沉的距离
const SUBMERGE = 6.5     // 从水下多深处浮起来（越深，出现得越晚、越含蓄）
const UP_Y = 0.09        // 就位高度（使模型轨面与列车对齐）

const easeOutQuad = (x) => 1 - (1 - x) * (1 - x) // 匀减速
const easeInQuad = (x) => x * x                   // 匀加速（下落）
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

// 返回 0(完全在水下) → 1(就位) 的高度系数。纯距离函数：连续、无跳变。
function heightFactor(d) {
  if (d >= LEAD) return 0
  if (d >= APPEAR_END) return easeOutQuad(clamp01((LEAD - d) / (LEAD - APPEAR_END)))
  if (d >= -KEEP_BEHIND) return 1
  return 1 - easeInQuad(clamp01((-d - KEEP_BEHIND) / FALL))
}

export function createFloatingTrack(scene, options = {}) {
  const upY = options.upY ?? UP_Y

  // 只构建一次模板；克隆时手动复制网格与相对变换（共享 geometry/material/texture）。
  // 注意：不能用 Object3D.clone()，工厂把 sculptRuntime 写进了 userData，存在自引用会崩。
  const template = createRailwayTrackSegmentModel({ castShadow: true, receiveShadow: true })
  template.rotation.y = -Math.PI / 2 // 模型长度轴 +Z → 场景 +X
  template.updateMatrixWorld(true)

  const parts = []
  template.traverse((o) => {
    if (o.isMesh) parts.push({ geo: o.geometry, mat: o.material, m: o.matrixWorld.clone() })
  })

  function makeSegment() {
    const g = new THREE.Group()
    for (const p of parts) {
      const mesh = new THREE.Mesh(p.geo, p.mat)
      p.m.decompose(mesh.position, mesh.quaternion, mesh.scale)
      mesh.castShadow = true
      mesh.receiveShadow = true
      g.add(mesh)
    }
    return g
  }

  const group = new THREE.Group()
  group.name = 'floatingTrack'
  scene.add(group)

  // 未「arm」时全部沉在水下不可见 —— 用于开场「初始没有轨道」
  let armed = false
  let startRamp = 1 // 发车起步时从 0 缓慢升到 1：整段轨道一起从水下浮起

  // 一段 = 一个固定世界槽位
  const segments = []
  for (let i = 0; i < POOL; i++) {
    const mesh = makeSegment()
    mesh.visible = false
    group.add(mesh)
    segments.push({ mesh, x: 0 })
  }

  // 铺满 [trainX - (KEEP+FALL) - 余量, trainX + LEAD]，对齐到 4m 全局网格以便无缝拼接
  let prevTrainX = null
  function seed(trainX, startXOverride) {
    const startX = startXOverride != null
      ? startXOverride
      : Math.ceil((trainX - KEEP_BEHIND - FALL - SEG_LEN) / SEG_LEN) * SEG_LEN
    let x = startX
    for (const s of segments) {
      s.x = x
      x += SEG_LEN
      s.mesh.position.set(s.x, upY - SUBMERGE, 0)
      s.mesh.visible = false
    }
    prevTrainX = trainX
  }

  function update(trainX, dt) {
    if (!armed) {
      for (const s of segments) {
        s.mesh.position.set(s.x, upY - SUBMERGE, 0)
        s.mesh.visible = false
      }
      return
    }
    // 起步缓慢浮起：整段轨道一起从水下升起（比正常铺设更慢）
    if (startRamp < 1) startRamp = Math.min(1, startRamp + dt / 4.5)
    if (prevTrainX === null || Math.abs(trainX - prevTrainX) > SEG_LEN * 2) seed(trainX)
    prevTrainX = trainX

    // 回收：已完全沉没且落后过远的段 → 挪到当前最前方（水下挪动，不可见）
    let maxX = -Infinity
    for (const s of segments) if (s.x > maxX) maxX = s.x
    for (const s of segments) {
      if (s.x - trainX < -(KEEP_BEHIND + FALL) && heightFactor(s.x - trainX) <= 0) {
        maxX += SEG_LEN
        s.x = maxX
        s.mesh.position.x = s.x
      }
    }

    for (const s of segments) {
      const h = heightFactor(s.x - trainX) * startRamp
      s.mesh.position.y = upY - (1 - h) * SUBMERGE // h≤1 → 永不高于就位高度
      s.mesh.position.z = 0
      s.mesh.visible = h > 0.78 // 只在水面附近（即将破水而出）才渲染，避免水下段透过海水显形
    }
  }

  return { group, update, setArmed: (v) => { armed = !!v; startRamp = 1 }, arm: () => { armed = true; startRamp = 0 } }
}
