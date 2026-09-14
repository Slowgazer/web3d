// ============================================================================
// 浮起搭路：列车行进时，前方轨道从水下浮起并逐段就位
// - 预建一段轨道模板，手动浅克隆成对象池（共享几何体/材质，省显存）
// - 每段固定在自己的世界槽位：可见时绝不移动；只有完全沉没后才被回收挪到最前方
// - 高度由「与车头的距离」直接决定，无状态、无追赶，因此连续平滑
// - 上升 easeOutQuad（匀减速、不过冲），下沉 easeInQuad（匀加速）
// - 参数集中在 P（可用 options.params 覆盖 / 运行时 setParams 调整），供调参场景使用
// ============================================================================
import * as THREE from 'three'
import { createRailwayTrackSegmentModel } from './createTrackModel'

export const TRACK_DEFAULTS = {
  SEG_LEN: 4,          // 单段长度（与模型一致，改动需重载）
  POOL: 26,            // 对象池段数（改动需重载）
  LEAD: 60,            // 车头前方多远开始浮起
  APPEAR_END: 16,      // 到这个距离已完全就位
  KEEP_BEHIND: 24,     // 车尾后方保持就位的距离
  FALL: 14,            // 之后下沉的距离
  SUBMERGE: 6.5,       // 从水下多深处浮起来
  UP_Y: 0.09,          // 就位高度（使模型轨面与列车对齐）
  START_RAMP: 4.5,     // 起步整体浮起的时长（秒）
  VISIBLE_H: 0.78,     // 低于此高度系数不渲染（避免水下段显形）
}

const easeOutQuad = (x) => 1 - (1 - x) * (1 - x) // 匀减速
const easeInQuad = (x) => x * x                   // 匀加速（下落）
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

// 返回 0(完全在水下) → 1(就位) 的高度系数。纯距离函数：连续、无跳变。
function heightFactor(d, P) {
  const { LEAD, APPEAR_END, KEEP_BEHIND, FALL } = P
  if (d >= LEAD) return 0
  if (d >= APPEAR_END) return easeOutQuad(clamp01((LEAD - d) / Math.max(LEAD - APPEAR_END, 1e-3)))
  if (d >= -KEEP_BEHIND) return 1
  return 1 - easeInQuad(clamp01((-d - KEEP_BEHIND) / Math.max(FALL, 1e-3)))
}

export function createFloatingTrack(scene, options = {}) {
  const P = { ...TRACK_DEFAULTS, ...(options.params || {}) }
  if (options.upY != null) P.UP_Y = options.upY
  const SEG_LEN = P.SEG_LEN

  // 只构建一次模板；克隆时手动复制网格与相对变换（共享 geometry/material/texture）。
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

  let armed = false
  let startRamp = 1

  const segments = []
  for (let i = 0; i < P.POOL; i++) {
    const mesh = makeSegment()
    mesh.visible = false
    group.add(mesh)
    segments.push({ mesh, x: 0 })
  }

  let prevTrainX = null
  function seed(trainX, startXOverride) {
    const startX = startXOverride != null
      ? startXOverride
      : Math.ceil((trainX - P.KEEP_BEHIND - P.FALL - SEG_LEN) / SEG_LEN) * SEG_LEN
    let x = startX
    for (const s of segments) {
      s.x = x
      x += SEG_LEN
      s.mesh.position.set(s.x, P.UP_Y - P.SUBMERGE, 0)
      s.mesh.visible = false
    }
    prevTrainX = trainX
  }

  function update(trainX, dt) {
    if (!armed) {
      for (const s of segments) {
        s.mesh.position.set(s.x, P.UP_Y - P.SUBMERGE, 0)
        s.mesh.visible = false
      }
      return
    }
    if (startRamp < 1) startRamp = Math.min(1, startRamp + dt / Math.max(P.START_RAMP, 0.01))
    if (prevTrainX === null || Math.abs(trainX - prevTrainX) > SEG_LEN * 2) seed(trainX)
    prevTrainX = trainX

    // 回收：已完全沉没且落后过远的段 → 挪到当前最前方（水下挪动，不可见）
    let maxX = -Infinity
    for (const s of segments) if (s.x > maxX) maxX = s.x
    for (const s of segments) {
      if (s.x - trainX < -(P.KEEP_BEHIND + P.FALL) && heightFactor(s.x - trainX, P) <= 0) {
        maxX += SEG_LEN
        s.x = maxX
        s.mesh.position.x = s.x
      }
    }

    for (const s of segments) {
      const h = heightFactor(s.x - trainX, P) * startRamp
      s.mesh.position.y = P.UP_Y - (1 - h) * P.SUBMERGE
      s.mesh.position.z = 0
      s.mesh.visible = h > P.VISIBLE_H
    }
  }

  return {
    group,
    update,
    params: P,
    setParams: (patch) => Object.assign(P, patch),
    setArmed: (v) => { armed = !!v; startRamp = 1 },
    arm: () => { armed = true; startRamp = 0 },
  }
}
