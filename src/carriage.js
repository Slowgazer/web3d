import * as THREE from 'three'
import { createSummerCaravanModel } from './createSummerCaravan'
import { createBlackCatCaravanModel } from './createBlackCatModel'
import { createVintageCaravanModel } from './createVintageModel'
import { createOceanCaravanModel } from './createOceanModel'
import { createStarryCaravanModel } from './createStarryModel'

// ============ 夏日幻想车厢（主车厢）—— Pipeline 生成版 ============
export function createCarriage() {
  const model = createCarriageModelById('summer')
  return { group: model }
}

// 按车厢 id 生成主列车模型（与展示车厢同一批工厂，主列车缩放 1.5）
const CARRIAGE_FACTORY = {
  summer: createSummerCaravanModel,
  blackcat: createBlackCatCaravanModel,
  vintage: createVintageCaravanModel,
  ocean: createOceanCaravanModel,
  starry: createStarryCaravanModel,
}

export function createCarriageModelById(id) {
  const factory = CARRIAGE_FACTORY[id] || createSummerCaravanModel
  const model = factory({ qualityPriority: 'gameplay', castShadow: true, receiveShadow: true })
  model.scale.set(1.5, 1.5, 1.5)
  return model
}

// ============ 以下为旧手写代码（保留参考） ============
function _legacyCreateCarriage() {
  const group = new THREE.Group()
  const L = 7.5, H = 2.4, W = 2.1

  // ---- 车身主体（高段数圆角盒） ----
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#e8a87c', roughness: 0.72, metalness: 0.0 })

  // 中段
  const body = new THREE.Mesh(new THREE.BoxGeometry(L * 0.85, H, W, 8, 8, 8), bodyMat)
  body.position.set(0, H / 2 + 0.35, 0)
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  // 前后圆弧封头
  const capMat = new THREE.MeshStandardMaterial({ color: '#e0a070', roughness: 0.72 })
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(W / 2, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2), capMat)
    cap.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2
    cap.position.set(s * L * 0.425, H / 2 + 0.35, 0)
    cap.scale.set(0.35, 1, 1)
    cap.castShadow = true
    group.add(cap)
  }

  // 顶部弧形屋顶
  const roofGeo = new THREE.CylinderGeometry(W / 2 + 0.08, W / 2 + 0.08, L * 0.85, 20, 1, true)
  const roofMat = new THREE.MeshStandardMaterial({ color: '#d89868', roughness: 0.7, side: THREE.DoubleSide })
  const roof = new THREE.Mesh(roofGeo, roofMat)
  roof.rotation.z = Math.PI / 2
  roof.rotation.x = Math.PI / 2
  roof.position.set(0, H + 0.35, 0)
  roof.castShadow = true
  group.add(roof)

  // 屋顶盖板
  const roofCap = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.85, 0.06, W + 0.16),
    new THREE.MeshStandardMaterial({ color: '#c88858', roughness: 0.75 }),
  )
  roofCap.position.set(0, H + 0.35, 0)
  group.add(roofCap)

  // ---- 渐变色带（4层，模拟水彩） ----
  const bands = [
    { color: '#e88a8a', y: 0 },
    { color: '#e8b07a', y: 1 },
    { color: '#e8d87a', y: 2 },
    { color: '#8ac88a', y: 3 },
  ]
  bands.forEach(({ color, y }) => {
    const bandH = H / 4
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(L * 0.85 + 0.03, bandH, W + 0.03),
      new THREE.MeshStandardMaterial({ color, roughness: 0.78, transparent: true, opacity: 0.35 }),
    )
    band.position.set(0, 0.35 + bandH / 2 + y * bandH, 0)
    group.add(band)
  })

  // ---- 烟囱（多段，带底座） ----
  const chimneyMat = new THREE.MeshStandardMaterial({ color: '#7a6a5a', roughness: 0.75 })
  // 底座
  const chimBase = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.15, 10), chimneyMat)
  chimBase.position.set(-L * 0.28, H + 0.42, 0)
  group.add(chimBase)
  // 烟囱身
  const chimBody = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.55, 10), chimneyMat)
  chimBody.position.set(-L * 0.28, H + 0.75, 0)
  chimBody.castShadow = true
  group.add(chimBody)
  // 烟囱顶帽
  const chimCap = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.14, 0.12, 10), chimneyMat)
  chimCap.position.set(-L * 0.28, H + 1.08, 0)
  group.add(chimCap)

  // ---- 窗户（3扇，精致木框） ----
  const winCount = 3, winW = 0.95, winH = 0.8, winGap = 1.9
  const winStartX = -(winCount - 1) * winGap / 2
  const winY = H / 2 + 0.45

  const glassMat = new THREE.MeshStandardMaterial({
    color: '#f8e8a0', roughness: 0.15, metalness: 0.05,
    emissive: '#f0c860', emissiveIntensity: 0.45,
    transparent: true, opacity: 0.92,
  })
  const frameMat = new THREE.MeshStandardMaterial({ color: '#8b6b42', roughness: 0.55, metalness: 0.15 })
  const frameDarkMat = new THREE.MeshStandardMaterial({ color: '#6a5030', roughness: 0.6 })

  for (const side of [-1, 1]) {
    const sz = side * (W / 2 + 0.01)
    for (let i = 0; i < winCount; i++) {
      const wx = winStartX + i * winGap

      // 外框（上下左右四条）
      const fw = 0.08, fd = 0.06
      // 上
      const ft = new THREE.Mesh(new THREE.BoxGeometry(winW + fw * 2, fw, fd), frameMat)
      ft.position.set(wx, winY + winH / 2 + fw / 2, sz + side * 0.005)
      group.add(ft)
      // 下
      const fb = new THREE.Mesh(new THREE.BoxGeometry(winW + fw * 2, fw, fd), frameMat)
      fb.position.set(wx, winY - winH / 2 - fw / 2, sz + side * 0.005)
      group.add(fb)
      // 左
      const fl = new THREE.Mesh(new THREE.BoxGeometry(fw, winH + fw * 2, fd), frameMat)
      fl.position.set(wx - winW / 2 - fw / 2, winY, sz + side * 0.005)
      group.add(fl)
      // 右
      const fr = new THREE.Mesh(new THREE.BoxGeometry(fw, winH + fw * 2, fd), frameMat)
      fr.position.set(wx + winW / 2 + fw / 2, winY, sz + side * 0.005)
      group.add(fr)

      // 玻璃
      const gl = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), glassMat)
      gl.position.set(wx, winY, sz + side * 0.01)
      gl.rotation.y = side > 0 ? 0 : Math.PI
      group.add(gl)

      // 十字分隔条
      const hb = new THREE.Mesh(new THREE.BoxGeometry(winW, 0.045, 0.04), frameDarkMat)
      hb.position.set(wx, winY, sz + side * 0.018)
      group.add(hb)
      const vb = new THREE.Mesh(new THREE.BoxGeometry(0.045, winH, 0.04), frameDarkMat)
      vb.position.set(wx, winY, sz + side * 0.018)
      group.add(vb)

      // 窗台（凸出）
      const sill = new THREE.Mesh(
        new THREE.BoxGeometry(winW + fw * 2 + 0.08, 0.07, 0.15),
        frameMat,
      )
      sill.position.set(wx, winY - winH / 2 - fw - 0.03, sz + side * 0.06)
      group.add(sill)

      // 窗户上方弧形装饰
      const archSegs = 8
      for (let a = 0; a < archSegs; a++) {
        const ang = (a / (archSegs - 1)) * Math.PI
        const ax = wx + Math.cos(ang) * (winW / 2 + fw / 2)
        const ay = winY + winH / 2 + fw + Math.sin(ang) * 0.1
        const ab = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, 0.04, fd),
          frameDarkMat,
        )
        ab.position.set(ax, ay, sz + side * 0.005)
        group.add(ab)
      }
    }
  }

  // ---- 花朵藤蔓（每侧5条茎，每条带花和叶） ----
  const vineMat = new THREE.MeshStandardMaterial({ color: '#4a7a3a', roughness: 0.75 })
  const flowerPalette = ['#e88a8a', '#f0a0c0', '#f0c878', '#c8a0e0', '#f09090']

  for (const side of [-1, 1]) {
    const sz = side * (W / 2 + 0.025)
    const vineXs = [-L * 0.32, -L * 0.12, L * 0.08, L * 0.28, L * 0.0]

    vineXs.forEach((vx, vi) => {
      const vineH = 1.4 + Math.random() * 0.9
      const segs = 10
      // 藤蔓（分段弯曲）
      for (let s = 0; s < segs; s++) {
        const t1 = s / segs, t2 = (s + 1) / segs
        const y1 = 0.35 + t1 * vineH, y2 = 0.35 + t2 * vineH
        const x1 = vx + Math.sin(t1 * 3 + vi) * 0.08
        const x2 = vx + Math.sin(t2 * 3 + vi) * 0.08
        const segLen = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
        const seg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.012, 0.018, segLen, 4),
          vineMat,
        )
        seg.position.set((x1 + x2) / 2, (y1 + y2) / 2, sz)
        seg.rotation.z = Math.atan2(x2 - x1, y2 - y1)
        group.add(seg)
      }

      // 花朵（3-5朵）
      const flowerCount = 3 + Math.floor(Math.random() * 3)
      for (let f = 0; f < flowerCount; f++) {
        const fy = 0.6 + f * 0.35 + Math.random() * 0.2
        const fx = vx + Math.sin(fy * 2.5 + vi) * 0.1
        const fColor = flowerPalette[Math.floor(Math.random() * flowerPalette.length)]

        // 花瓣（5片）
        const petalMat = new THREE.MeshStandardMaterial({ color: fColor, roughness: 0.6 })
        for (let p = 0; p < 5; p++) {
          const pa = (p / 5) * Math.PI * 2
          const petal = new THREE.Mesh(
            new THREE.SphereGeometry(0.04, 6, 6),
            petalMat,
          )
          petal.position.set(
            fx + Math.cos(pa) * 0.04,
            fy + Math.sin(pa) * 0.04,
            sz + side * 0.04,
          )
          petal.scale.set(1, 0.6, 0.5)
          group.add(petal)
        }
        // 花蕊
        const center = new THREE.Mesh(
          new THREE.SphereGeometry(0.025, 6, 6),
          new THREE.MeshStandardMaterial({ color: '#f8e880', roughness: 0.5 }),
        )
        center.position.set(fx, fy, sz + side * 0.05)
        group.add(center)
      }

      // 叶子
      for (let l = 0; l < 4; l++) {
        const ly = 0.5 + l * 0.4 + Math.random() * 0.2
        const lx = vx + (l % 2 === 0 ? 0.07 : -0.07) + Math.sin(ly * 2 + vi) * 0.05
        const leaf = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, 0.045, 0.015),
          vineMat,
        )
        leaf.position.set(lx, ly, sz + side * 0.03)
        leaf.rotation.z = l % 2 === 0 ? 0.5 : -0.5
        group.add(leaf)
        // 叶脉
        const vein = new THREE.Mesh(
          new THREE.BoxGeometry(0.08, 0.008, 0.016),
          new THREE.MeshStandardMaterial({ color: '#3a6a2a', roughness: 0.8 }),
        )
        vein.position.set(lx, ly, sz + side * 0.032)
        vein.rotation.z = l % 2 === 0 ? 0.5 : -0.5
        group.add(vein)
      }
    })
  }

  // ---- 车轮（2组双轮，带辐条和轮缘） ----
  const wheelMat = new THREE.MeshStandardMaterial({ color: '#5a4a3a', roughness: 0.75 })
  const hubMat = new THREE.MeshStandardMaterial({ color: '#8a7a6a', roughness: 0.55, metalness: 0.3 })
  const spokeMat = new THREE.MeshStandardMaterial({ color: '#6a5a4a', roughness: 0.6 })

  for (const sx of [-1, 1]) {
    const wx = sx * L * 0.28
    for (const sz of [-0.55, 0.55]) {
      const wg = new THREE.Group()

      // 轮胎
      const tire = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.06, 10, 20), wheelMat)
      tire.rotation.x = Math.PI / 2
      wg.add(tire)

      // 轮毂
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 10), hubMat)
      hub.rotation.x = Math.PI / 2
      wg.add(hub)

      // 辐条（6根）
      for (let a = 0; a < 6; a++) {
        const ang = (a / 6) * Math.PI * 2
        const spoke = new THREE.Mesh(
          new THREE.BoxGeometry(0.02, 0.02, 0.22),
          spokeMat,
        )
        spoke.position.set(Math.cos(ang) * 0.12, Math.sin(ang) * 0.12, 0)
        spoke.rotation.z = ang
        wg.add(spoke)
      }

      wg.position.set(wx, 0.18, sz)
      wg.castShadow = true
      group.add(wg)
    }
  }

  // ---- 车钩（两端，带缓冲弹簧细节） ----
  const hookMat = new THREE.MeshStandardMaterial({ color: '#555566', roughness: 0.65, metalness: 0.45 })
  for (const s of [-1, 1]) {
    // 钩身
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.45), hookMat)
    hook.position.set(s * (L * 0.425 + 0.18), 0.3, 0)
    group.add(hook)
    // 缓冲圆盘
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.04, 10),
      new THREE.MeshStandardMaterial({ color: '#444455', roughness: 0.6, metalness: 0.5 }),
    )
    disc.rotation.z = Math.PI / 2
    disc.position.set(s * (L * 0.425 + 0.36), 0.3, 0)
    group.add(disc)
  }

  // ---- 底部横梁 ----
  const beamMat = new THREE.MeshStandardMaterial({ color: '#4a3a2a', roughness: 0.8 })
  for (const sz of [-0.6, 0.6]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(L * 0.7, 0.08, 0.06), beamMat)
    beam.position.set(0, 0.12, sz)
    group.add(beam)
  }

  group.scale.set(0.75, 0.75, 0.75)
  return { group }
}

export function updateCarriageAnimation() {}


// ============ 展示用车厢（精细化） ============

function makeWheel(radius, width, segments) {
  const g = new THREE.Group()
  const tireMat = new THREE.MeshStandardMaterial({ color: '#3a3a3a', roughness: 0.75 })
  const hubMat = new THREE.MeshStandardMaterial({ color: '#7a7a7a', roughness: 0.5, metalness: 0.4 })
  const spokeMat = new THREE.MeshStandardMaterial({ color: '#5a5a5a', roughness: 0.6 })

  const tire = new THREE.Mesh(new THREE.TorusGeometry(radius, width, 12, segments), tireMat)
  tire.rotation.x = Math.PI / 2
  g.add(tire)

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.25, radius * 0.25, width * 1.2, 10), hubMat)
  hub.rotation.x = Math.PI / 2
  g.add(hub)

  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2
    const spoke = new THREE.Mesh(
      new THREE.BoxGeometry(0.015, 0.015, radius * 0.7),
      spokeMat,
    )
    spoke.position.set(Math.cos(ang) * radius * 0.4, Math.sin(ang) * radius * 0.4, 0)
    spoke.rotation.z = ang
    g.add(spoke)
  }
  return g
}

// ---- 黑猫车厢 ----
// ============ 黑猫展示车厢 —— Pipeline 生成版 ============
export function createBlackCatDisplay() {
  const model = createBlackCatCaravanModel({ qualityPriority: 'gameplay', castShadow: true, receiveShadow: true })
  model.scale.set(1.2, 1.2, 1.2)
  return model
}

// ============ 以下为旧手写代码（保留参考） ============
function _legacyBlackCatDisplay() {
  const g = new THREE.Group()
  const furMat = new THREE.MeshStandardMaterial({ color: '#1a1a22', roughness: 0.88 })

  // 车身（方盒+前后圆弧）
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.3, 1.5, 6, 6, 6), furMat)
  body.position.y = 0.7
  body.castShadow = true
  g.add(body)

  // 前后圆弧
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.75, 14, 14, 0, Math.PI * 2, 0, Math.PI / 2), furMat)
    cap.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2
    cap.position.set(s * 1.6, 0.7, 0)
    cap.scale.set(0.3, 1, 1)
    g.add(cap)
  }

  // 猫头（球体）
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.72, 16, 16), furMat)
  head.position.set(2.0, 0.85, 0)
  head.scale.set(0.9, 0.95, 0.9)
  g.add(head)

  // 耳朵
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 4), furMat)
    ear.position.set(2.0, 1.55, s * 0.35)
    ear.rotation.z = s * 0.1
    g.add(ear)
    // 内耳
    const inner = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.28, 4),
      new THREE.MeshStandardMaterial({ color: '#3a2855', roughness: 0.7 }),
    )
    inner.position.set(2.0, 1.48, s * 0.35)
    inner.rotation.z = s * 0.1
    g.add(inner)
  }

  // 眼睛
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#f0e8c8', emissive: '#f0e8c8', emissiveIntensity: 0.35, roughness: 0.3 })
  const pupilMat = new THREE.MeshStandardMaterial({ color: '#111111', roughness: 0.4 })
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 12), eyeMat)
    eye.position.set(2.45, 0.9, s * 0.42)
    eye.scale.set(0.5, 1, 0.4)
    g.add(eye)
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), pupilMat)
    pupil.position.set(2.52, 0.9, s * 0.47)
    pupil.scale.set(0.4, 1.3, 0.3)
    g.add(pupil)
  }

  // 鼻子
  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 8, 8),
    new THREE.MeshStandardMaterial({ color: '#cc8888', roughness: 0.5 }),
  )
  nose.position.set(2.52, 0.72, 0)
  nose.scale.set(1, 0.7, 0.5)
  g.add(nose)

  // 窗户（每侧5扇）
  const gMat = new THREE.MeshStandardMaterial({ color: '#f0e0b0', emissive: '#f0c860', emissiveIntensity: 0.3, transparent: true, opacity: 0.88 })
  const fMat = new THREE.MeshStandardMaterial({ color: '#8b6b42', roughness: 0.55, metalness: 0.15 })
  for (const s of [-1, 1]) {
    const sz = s * 0.76
    for (let i = 0; i < 5; i++) {
      const x = -1.1 + i * 0.55
      // 四边框
      for (const [dx, dy, dw, dh] of [[0, 0.28, 0.48, 0.06], [0, -0.28, 0.48, 0.06], [-0.24, 0, 0.06, 0.56], [0.24, 0, 0.06, 0.56]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(dw, dh, 0.04), fMat)
        bar.position.set(x, 0.78 + dy, sz + s * 0.005)
        g.add(bar)
      }
      const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.46), gMat)
      gl.position.set(x, 0.78, sz + s * 0.01)
      gl.rotation.y = s > 0 ? 0 : Math.PI
      g.add(gl)
    }
  }

  // 腿
  const legMat = new THREE.MeshStandardMaterial({ color: '#1a1a22', roughness: 0.85 })
  const lPos = [[-1.0, -0.65], [-1.0, 0.65], [1.0, -0.65], [1.0, 0.65]]
  lPos.forEach(([x, z]) => {
    const lg = new THREE.Group()
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.45, 8), legMat)
    leg.position.y = -0.05
    lg.add(leg)
    const paw = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 8, 8),
      new THREE.MeshStandardMaterial({ color: '#222230', roughness: 0.8 }),
    )
    paw.position.y = -0.3
    paw.scale.y = 0.5
    lg.add(paw)
    // 脚趾
    for (let t = -1; t <= 1; t++) {
      const toe = new THREE.Mesh(
        new THREE.BoxGeometry(0.01, 0.05, 0.1),
        new THREE.MeshStandardMaterial({ color: '#0a0a10' }),
      )
      toe.position.set(0, -0.28, t * 0.06)
      lg.add(toe)
    }
    lg.position.set(x, 0.1, z)
    g.add(lg)
  })

  // 尾巴
  const tail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.15, 0.4, 8),
    furMat,
  )
  tail.rotation.z = Math.PI / 2
  tail.position.set(-1.8, 0.75, 0)
  g.add(tail)

  g.scale.setScalar(0.5)
  return g
}

// ---- 星空车厢 ----
// ============ 星空展示车厢 —— Pipeline 生成版 ============
export function createStarryDisplay() {
  const model = createStarryCaravanModel({ qualityPriority: 'gameplay', castShadow: true, receiveShadow: true })
  model.scale.set(1.2, 1.2, 1.2)
  return model
}

// ============ 以下为旧手写代码（保留参考） ============
function _legacyStarryDisplay() {
  const g = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#1a2050', roughness: 0.75 })

  const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 1.4, 6, 6, 6), bodyMat)
  body.position.y = 0.7
  body.castShadow = true
  g.add(body)

  // 弧形顶
  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.72, 3.4, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: '#2a3070', roughness: 0.7, side: THREE.DoubleSide }),
  )
  roof.rotation.z = Math.PI / 2
  roof.position.y = 1.45
  g.add(roof)

  // 顶盖板
  const roofPlate = new THREE.Mesh(
    new THREE.BoxGeometry(3.4, 0.05, 1.44),
    new THREE.MeshStandardMaterial({ color: '#222860', roughness: 0.75 }),
  )
  roofPlate.position.y = 1.45
  g.add(roofPlate)

  // 窗户（每侧4扇）
  const gMat = new THREE.MeshStandardMaterial({ color: '#f0c870', emissive: '#f0a040', emissiveIntensity: 0.45, transparent: true, opacity: 0.92 })
  const fMat = new THREE.MeshStandardMaterial({ color: '#5a4030', roughness: 0.55 })
  for (const s of [-1, 1]) {
    const sz = s * 0.71
    for (let i = 0; i < 4; i++) {
      const x = -1.05 + i * 0.7
      for (const [dx, dy, dw, dh] of [[0, 0.3, 0.52, 0.05], [0, -0.3, 0.52, 0.05], [-0.26, 0, 0.05, 0.62], [0.26, 0, 0.05, 0.62]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(dw, dh, 0.04), fMat)
        bar.position.set(x, 0.8 + dy, sz + s * 0.005)
        g.add(bar)
      }
      const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.5), gMat)
      gl.position.set(x, 0.8, sz + s * 0.01)
      gl.rotation.y = s > 0 ? 0 : Math.PI
      g.add(gl)
    }
  }

  // 门
  const doorMat = new THREE.MeshStandardMaterial({ color: '#151840', roughness: 0.75 })
  for (const s of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 0.05), doorMat)
    door.position.set(-1.5, 0.6, s * 0.71)
    g.add(door)
    // 门把手
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.12, 6),
      new THREE.MeshStandardMaterial({ color: '#888899', metalness: 0.6 }),
    )
    handle.position.set(-1.45, 0.6, s * 0.74)
    g.add(handle)
  }

  // 星星粒子
  const sg = new THREE.BufferGeometry()
  const sp = new Float32Array(80 * 3)
  for (let i = 0; i < 80; i++) {
    sp[i * 3] = (Math.random() - 0.5) * 3.2
    sp[i * 3 + 1] = Math.random() * 1.4 + 0.1
    sp[i * 3 + 2] = (Math.random() - 0.5) * 1.3
  }
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3))
  g.add(new THREE.Points(sg, new THREE.PointsMaterial({
    color: '#ffee88', size: 0.055, transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  })))

  // 顶部小灯（5个，带杆）
  const lMat = new THREE.MeshStandardMaterial({ color: '#ffee88', emissive: '#ffee88', emissiveIntensity: 1.5 })
  const poleMat = new THREE.MeshStandardMaterial({ color: '#667788', roughness: 0.6, metalness: 0.3 })
  for (let i = 0; i < 5; i++) {
    const x = -1.2 + i * 0.6
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.3, 4), poleMat)
    pole.position.set(x, 1.62, 0)
    g.add(pole)
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), lMat)
    bulb.position.set(x, 1.8, 0)
    g.add(bulb)
    g.add(new THREE.PointLight('#ffee88', 0.2, 2).translateX(x).translateY(1.8))
  }

  // 车轮
  for (const sx of [-1, 1]) {
    const w = makeWheel(0.22, 0.08, 14)
    w.position.set(sx * 1.1, 0.15, 0)
    g.add(w)
  }

  g.scale.setScalar(0.5)
  return g
}

// ---- 复古车厢 ----
// ============ 复古展示车厢 —— Pipeline 生成版 ============
export function createVintageDisplay() {
  const model = createVintageCaravanModel({ qualityPriority: 'gameplay', castShadow: true, receiveShadow: true })
  model.scale.set(1.2, 1.2, 1.2)
  return model
}

// ============ 以下为旧手写代码（保留参考） ============
function _legacyVintageDisplay() {
  const g = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#2a5a3a', roughness: 0.68 })

  const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.5, 1.4, 6, 6, 6), bodyMat)
  body.position.y = 0.75
  body.castShadow = true
  g.add(body)

  // 金色边框线
  const goldMat = new THREE.MeshStandardMaterial({ color: '#c8a840', roughness: 0.35, metalness: 0.55 })
  for (const y of [0.15, 1.45]) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(3.22, 0.035, 1.42), goldMat)
    line.position.y = y
    g.add(line)
  }
  // 竖向金线
  for (const x of [-1.55, 1.55]) {
    const vline = new THREE.Mesh(new THREE.BoxGeometry(0.035, 1.35, 1.42), goldMat)
    vline.position.set(x, 0.8, 0)
    g.add(vline)
  }

  // 车顶（弧形）
  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.72, 3.2, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: '#3a3a3a', roughness: 0.7, side: THREE.DoubleSide }),
  )
  roof.rotation.z = Math.PI / 2
  roof.position.y = 1.55
  g.add(roof)

  // 车顶盖板
  const roofPlate = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 0.06, 1.44),
    new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.75 }),
  )
  roofPlate.position.y = 1.55
  g.add(roofPlate)

  // 行李架
  const rackMat = new THREE.MeshStandardMaterial({ color: '#c8a840', roughness: 0.45, metalness: 0.45 })
  const rack = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.035, 0.9), rackMat)
  rack.position.y = 1.7
  g.add(rack)
  // 栏杆
  for (const z of [-0.45, 0.45]) {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.4, 4), rackMat)
    rail.rotation.z = Math.PI / 2
    rail.position.set(0, 1.82, z)
    g.add(rail)
  }
  // 支架
  for (const x of [-1.1, 0, 1.1]) {
    for (const z of [-0.4, 0.4]) {
      const support = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.15, 4), rackMat)
      support.position.set(x, 1.63, z)
      g.add(support)
    }
  }

  // 窗户（每侧4扇 + 窗帘）
  const gMat = new THREE.MeshStandardMaterial({ color: '#f0e8d0', transparent: true, opacity: 0.88 })
  const fMat = new THREE.MeshStandardMaterial({ color: '#6b3a20', roughness: 0.55 })
  const cMat = new THREE.MeshStandardMaterial({ color: '#f0e8d0', roughness: 0.78, side: THREE.DoubleSide })
  for (const s of [-1, 1]) {
    const sz = s * 0.71
    for (let i = 0; i < 4; i++) {
      const x = -0.9 + i * 0.6
      // 四边框
      for (const [dx, dy, dw, dh] of [[0, 0.3, 0.48, 0.06], [0, -0.3, 0.48, 0.06], [-0.24, 0, 0.06, 0.62], [0.24, 0, 0.06, 0.62]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(dw, dh, 0.04), fMat)
        bar.position.set(x, 0.85 + dy, sz + s * 0.005)
        g.add(bar)
      }
      const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.5), gMat)
      gl.position.set(x, 0.85, sz + s * 0.01)
      gl.rotation.y = s > 0 ? 0 : Math.PI
      g.add(gl)
      // 窗帘
      for (const cs of [-1, 1]) {
        const curtain = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.5, 0.015), cMat)
        curtain.position.set(x + cs * 0.17, 0.87, sz + s * 0.015)
        curtain.rotation.z = cs * 0.12
        g.add(curtain)
      }
      // 窗帘绑带
      const tie = new THREE.Mesh(
        new THREE.TorusGeometry(0.04, 0.008, 4, 8),
        new THREE.MeshStandardMaterial({ color: '#c8a840', roughness: 0.5 }),
      )
      tie.position.set(x, 0.65, sz + s * 0.02)
      g.add(tie)
    }
  }

  // 车轮
  for (const sx of [-1, 1]) {
    for (const sz of [-0.5, 0.5]) {
      const w = makeWheel(0.25, 0.07, 16)
      w.position.set(sx * 1.1, 0.15, sz)
      g.add(w)
    }
  }

  // 车钩
  const hookMat = new THREE.MeshStandardMaterial({ color: '#444455', roughness: 0.6, metalness: 0.5 })
  for (const s of [-1, 1]) {
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.35), hookMat)
    hook.position.set(s * 1.75, 0.3, 0)
    g.add(hook)
  }

  g.scale.setScalar(0.5)
  return g
}

// ---- 海浪车厢 ----
// ============ 海浪展示车厢 —— Pipeline 生成版 ============
export function createOceanDisplay() {
  const model = createOceanCaravanModel({ qualityPriority: 'gameplay', castShadow: true, receiveShadow: true })
  model.scale.set(1.2, 1.2, 1.2)
  return model
}

// ============ 以下为旧手写代码（保留参考） ============
function _legacyOceanDisplay() {
  const g = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({ color: '#3a8ab8', roughness: 0.68 })

  const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.4, 1.4, 6, 6, 6), bodyMat)
  body.position.y = 0.7
  body.castShadow = true
  g.add(body)

  // 木质横条纹
  const plankMat = new THREE.MeshStandardMaterial({ color: '#2a7aa8', roughness: 0.72 })
  for (let i = 0; i < 6; i++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(3.22, 0.025, 1.42), plankMat)
    plank.position.y = 0.2 + i * 0.22
    g.add(plank)
  }

  // 顶部船舷
  const rimMat = new THREE.MeshStandardMaterial({ color: '#4a9ac8', roughness: 0.65 })
  for (const s of [-1, 1]) {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 0.06), rimMat)
    rim.position.set(0, 1.45, s * 0.7)
    g.add(rim)
  }
  const rimFront = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 1.4), rimMat)
  rimFront.position.set(1.6, 1.45, 0)
  g.add(rimFront)
  const rimBack = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 1.4), rimMat)
  rimBack.position.set(-1.6, 1.45, 0)
  g.add(rimBack)

  // 船帆
  const sailMat = new THREE.MeshStandardMaterial({ color: '#e8e0d0', roughness: 0.75, side: THREE.DoubleSide })
  const mastMat = new THREE.MeshStandardMaterial({ color: '#8b6b42', roughness: 0.65 })
  for (const sx of [-0.5, 0.5]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 1.2, 6), mastMat)
    mast.position.set(sx, 1.8, 0)
    g.add(mast)
    // 横杆
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.6, 4), mastMat)
    yard.rotation.z = Math.PI / 2
    yard.position.set(sx, 2.2, 0)
    g.add(yard)
    // 帆布
    const sail = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.65, 4, 4), sailMat)
    sail.position.set(sx + 0.22, 1.95, 0)
    sail.rotation.y = 0.25
    g.add(sail)
  }

  // 圆窗（舷窗）
  const gMat = new THREE.MeshStandardMaterial({ color: '#7ac8e8', emissive: '#4090b0', emissiveIntensity: 0.25 })
  const ringMat = new THREE.MeshStandardMaterial({ color: '#c8a840', roughness: 0.45, metalness: 0.5 })
  for (const s of [-1, 1]) {
    const sz = s * 0.71
    for (let i = 0; i < 4; i++) {
      const x = -0.9 + i * 0.6
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.025, 8, 16), ringMat)
      ring.position.set(x, 0.8, sz + s * 0.01)
      ring.rotation.y = s > 0 ? 0 : Math.PI
      g.add(ring)
      const gl = new THREE.Mesh(new THREE.CircleGeometry(0.13, 12), gMat)
      gl.position.set(x, 0.8, sz + s * 0.015)
      gl.rotation.y = s > 0 ? 0 : Math.PI
      g.add(gl)
      // 十字
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.01), ringMat)
      h.position.set(x, 0.8, sz + s * 0.018)
      g.add(h)
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.24, 0.01), ringMat)
      v.position.set(x, 0.8, sz + s * 0.018)
      g.add(v)
    }
  }

  // 珊瑚装饰
  const coralColors = ['#e87a8a', '#8ac87a', '#c87ae0', '#f0a060']
  for (let i = 0; i < 6; i++) {
    const coral = new THREE.Mesh(
      new THREE.ConeGeometry(0.05 + Math.random() * 0.03, 0.2 + Math.random() * 0.1, 6),
      new THREE.MeshStandardMaterial({ color: coralColors[i % 4], roughness: 0.7 }),
    )
    coral.position.set(-1.3 + i * 0.5, 1.52, (Math.random() - 0.5) * 0.5)
    coral.rotation.z = (Math.random() - 0.5) * 0.4
    g.add(coral)
  }

  // 海草
  const seaweedMat = new THREE.MeshStandardMaterial({ color: '#4a9a5a', roughness: 0.75 })
  for (let i = 0; i < 4; i++) {
    const sw = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.025, 0.3, 4),
      seaweedMat,
    )
    sw.position.set(-1.0 + i * 0.7, 1.55, (Math.random() - 0.5) * 0.4)
    sw.rotation.z = (Math.random() - 0.5) * 0.3
    g.add(sw)
  }

  // 鱼
  const fishMat = new THREE.MeshStandardMaterial({ color: '#f09060', roughness: 0.6 })
  for (let i = 0; i < 2; i++) {
    const fish = new THREE.Group()
    const fBody = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), fishMat)
    fBody.scale.set(1.5, 0.8, 0.5)
    fish.add(fBody)
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.08, 4), fishMat)
    tail.rotation.z = Math.PI / 2
    tail.position.x = -0.1
    fish.add(tail)
    fish.position.set(-0.8 + i * 1.6, 0.3, (i === 0 ? -1 : 1) * 0.75)
    fish.rotation.y = i === 0 ? 0.3 : -0.3
    g.add(fish)
  }

  // 车轮
  for (const sx of [-1, 1]) {
    const w = makeWheel(0.22, 0.08, 14)
    w.position.set(sx * 1.1, 0.15, 0)
    g.add(w)
  }

  g.scale.setScalar(0.5)
  return g
}
