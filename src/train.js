import * as THREE from 'three'

export function createTrain() {
  const group = new THREE.Group()

  // ---- 颜色定义 ----
  const colors = {
    body: '#c0392b',
    roof: '#2c3e50',
    accent: '#f39c12',
    wheel: '#34495e',
    rim: '#7f8c8d',
    boiler: '#cd6155',
    chimney: '#1a1a2e',
    smoke: '#d5d8dc',
  }

  // ---- 主体 ----
  const bodyMat = new THREE.MeshStandardMaterial({
    color: colors.body,
    roughness: 0.6,
    metalness: 0.1,
  })

  // 主车身
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.5, 5.0), bodyMat)
  body.position.set(0, 1.2, 0.5)
  body.castShadow = true
  group.add(body)

  // 驾驶室
  const cabinMat = new THREE.MeshStandardMaterial({
    color: colors.roof,
    roughness: 0.7,
    metalness: 0.1,
  })
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.2, 1.5), cabinMat)
  cabin.position.set(0, 2.0, -1.8)
  cabin.castShadow = true
  group.add(cabin)

  // 驾驶室屋顶（圆弧形）
  const roofMat = new THREE.MeshStandardMaterial({
    color: colors.roof,
    roughness: 0.7,
    metalness: 0.1,
  })
  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.3, 1.6, 8, 1, true),
    roofMat,
  )
  roof.rotation.x = Math.PI / 2
  roof.position.set(0, 2.65, -1.8)
  roof.scale.set(1, 1, 0.7)
  roof.castShadow = true
  group.add(roof)

  // 驾驶室窗户
  const windowMat = new THREE.MeshStandardMaterial({
    color: '#85c1e9',
    roughness: 0.1,
    metalness: 0.3,
    transparent: true,
    opacity: 0.6,
  })
  const windowGeo = new THREE.PlaneGeometry(0.8, 0.6)
  for (let i = -1; i <= 1; i += 2) {
    const win = new THREE.Mesh(windowGeo, windowMat)
    win.position.set(i * 0.55, 2.1, -2.5)
    win.rotation.y = i > 0 ? -Math.PI / 2 : Math.PI / 2
    group.add(win)
  }

  // ---- 锅炉 ----
  const boilerMat = new THREE.MeshStandardMaterial({
    color: colors.boiler,
    roughness: 0.5,
    metalness: 0.2,
  })
  const boiler = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.0, 3.0, 12),
    boilerMat,
  )
  boiler.rotation.x = Math.PI / 2
  boiler.position.set(0, 1.2, 2.0)
  boiler.castShadow = true
  group.add(boiler)

  // 锅炉前盖
  const frontMat = new THREE.MeshStandardMaterial({
    color: colors.chimney,
    roughness: 0.8,
    metalness: 0.1,
  })
  const front = new THREE.Mesh(
    new THREE.SphereGeometry(1.0, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    frontMat,
  )
  front.rotation.x = -Math.PI / 2
  front.position.set(0, 1.2, 3.5)
  group.add(front)

  // ---- 烟囱 ----
  const chimneyMat = new THREE.MeshStandardMaterial({
    color: colors.chimney,
    roughness: 0.8,
    metalness: 0.1,
  })
  const chimney = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.4, 0.8, 8),
    chimneyMat,
  )
  chimney.position.set(0, 1.9, 2.8)
  chimney.castShadow = true
  group.add(chimney)

  // 烟囱顶
  const chimneyTop = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.25, 0.15, 8),
    chimneyMat,
  )
  chimneyTop.position.set(0, 2.3, 2.8)
  group.add(chimneyTop)

  // ---- 前灯 ----
  const lightMat = new THREE.MeshStandardMaterial({
    color: colors.accent,
    roughness: 0.3,
    metalness: 0.5,
    emissive: colors.accent,
    emissiveIntensity: 0.3,
  })
  const headlight = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 8, 8),
    lightMat,
  )
  headlight.position.set(0, 1.4, 4.05)
  group.add(headlight)

  // ---- 车轮 ----
  const wheelMat = new THREE.MeshStandardMaterial({
    color: colors.wheel,
    roughness: 0.7,
    metalness: 0.3,
  })
  const rimMat = new THREE.MeshStandardMaterial({
    color: colors.rim,
    roughness: 0.5,
    metalness: 0.6,
  })

  const wheelPositions = [
    [-0.9, 0.3, -1.0],
    [0.9, 0.3, -1.0],
    [-0.9, 0.3, 0.5],
    [0.9, 0.3, 0.5],
    [-0.9, 0.3, 2.0],
    [0.9, 0.3, 2.0],
  ]

  const wheels = []
  wheelPositions.forEach((pos) => {
    const wheelGroup = new THREE.Group()

    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 0.12, 12),
      wheelMat,
    )
    wheel.rotation.z = -Math.PI / 2
    wheelGroup.add(wheel)

    // 轮缘
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.35, 0.04, 6, 12),
      rimMat,
    )
    rim.rotation.z = -Math.PI / 2
    wheelGroup.add(rim)

    // 轮辐（用十字交叉的细条模拟）
    const spokeMat = new THREE.MeshStandardMaterial({
      color: colors.rim,
      roughness: 0.5,
      metalness: 0.6,
    })
    for (let a = 0; a < 4; a++) {
      const spoke = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.3, 0.02),
        spokeMat,
      )
      const angle = (a / 4) * Math.PI
      spoke.position.set(Math.sin(angle) * 0.2, 0, Math.cos(angle) * 0.2)
      wheelGroup.add(spoke)
    }

    wheelGroup.position.set(pos[0], pos[1], pos[2])
    group.add(wheelGroup)
    wheels.push(wheelGroup)
  })

  // ---- 连接杆（车轮之间的装饰条） ----
  const rodMat = new THREE.MeshStandardMaterial({
    color: colors.rim,
    roughness: 0.5,
    metalness: 0.6,
  })
  for (let side = -1; side <= 1; side += 2) {
    const rod = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 3.0),
      rodMat,
    )
    rod.position.set(side * 0.9, 0.3, 0.5)
    group.add(rod)
  }

  // ---- 排障器（前面的三角结构） ----
  const cowcatcherMat = new THREE.MeshStandardMaterial({
    color: colors.chimney,
    roughness: 0.8,
    metalness: 0.1,
  })
  const cowcatcher = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.5, 0.5),
    cowcatcherMat,
  )
  cowcatcher.position.set(0, 0.2, 4.0)
  cowcatcher.rotation.x = 0.3
  cowcatcher.castShadow = true
  group.add(cowcatcher)

  // ---- 蒸汽粒子（装饰，在烟囱上方） ----
  const smokeMat = new THREE.MeshStandardMaterial({
    color: colors.smoke,
    transparent: true,
    opacity: 0.5,
    roughness: 1,
    metalness: 0,
    depthWrite: false,
  })

  const smokePuffs = []
  for (let i = 0; i < 6; i++) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(0.2 + Math.random() * 0.2, 6, 6),
      smokeMat.clone(),
    )
    puff.position.set(
      (Math.random() - 0.5) * 0.3,
      2.5 + Math.random() * 0.5,
      2.8 + Math.random() * 0.3,
    )
    puff.userData = {
      speed: 0.3 + Math.random() * 0.3,
      offset: Math.random() * Math.PI * 2,
      baseY: puff.position.y,
      baseScale: 0.5 + Math.random() * 0.5,
    }
    group.add(puff)
    smokePuffs.push(puff)
  }

  // 缩放火车到合适大小
  group.scale.set(0.8, 0.8, 0.8)

  return { group, wheels, smokePuffs }
}

export function updateTrainAnimation(trainObj, time) {
  const { wheels, smokePuffs } = trainObj

  // 车轮旋转
  const wheelSpeed = 2.0
  wheels.forEach((wheel) => {
    wheel.children.forEach((child) => {
      if (child.isMesh) {
        child.rotation.x += 0.05 * wheelSpeed
      }
    })
  })

  // 蒸汽动画（缩放+上浮+淡出）
  smokePuffs.forEach((puff) => {
    const s = puff.userData
    const phase = (time * s.speed + s.offset) % (Math.PI * 2)
    const rise = Math.sin(phase) * 0.4
    puff.position.y = s.baseY + rise
    puff.position.x += Math.sin(phase * 1.3) * 0.003
    const scaleFactor = 1 + Math.sin(phase) * 0.5
    puff.scale.set(scaleFactor, scaleFactor, scaleFactor)
    puff.material.opacity = 0.5 - Math.sin(phase) * 0.3
  })
}
