import * as THREE from 'three'

export function createTrack() {
  const group = new THREE.Group()

  // 定义椭圆形轨道路径
  const pathPoints = [
    new THREE.Vector3(-18, 0, -8),
    new THREE.Vector3(-22, 0, 0),
    new THREE.Vector3(-18, 0, 8),
    new THREE.Vector3(0, 0, 12),
    new THREE.Vector3(18, 0, 8),
    new THREE.Vector3(22, 0, 0),
    new THREE.Vector3(18, 0, -8),
    new THREE.Vector3(0, 0, -12),
  ]
  const curve = new THREE.CatmullRomCurve3(pathPoints, true)

  // ---- 路基（隆起的路面） ----
  // 沿路径放置矩形路段，形成抬高路面
  const roadSegments = 80
  const roadWidth = 3.2
  const roadHeight = 1.8
  const roadMat = new THREE.MeshStandardMaterial({
    color: '#d4c5a9',
    roughness: 0.9,
    metalness: 0,
  })

  // 侧面材质略深
  const roadSideMat = new THREE.MeshStandardMaterial({
    color: '#b8a88a',
    roughness: 1,
    metalness: 0,
  })

  for (let i = 0; i < roadSegments; i++) {
    const t = i / roadSegments
    const tNext = (i + 1) / roadSegments
    const p = curve.getPoint(t)
    const pNext = curve.getPoint(tNext)
    const tangent = curve.getTangent(t)
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(tangent, up).normalize()

    // 计算两段之间的中点方向和距离，用于旋转角度
    const dir = new THREE.Vector3().copy(pNext).sub(p)
    const mid = new THREE.Vector3().copy(p).add(dir.clone().multiplyScalar(0.5))
    const length = dir.length()
    const angle = Math.atan2(dir.x, dir.z)

    // 路面顶段
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(roadWidth, 0.2, length),
      roadMat,
    )
    top.position.copy(mid)
    top.position.y = roadHeight
    top.rotation.y = angle
    top.receiveShadow = true
    top.castShadow = true
    group.add(top)

    // 路基主体
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(roadWidth * 0.9, roadHeight, length),
      roadSideMat,
    )
    body.position.copy(mid)
    body.position.y = roadHeight * 0.5
    body.rotation.y = angle
    body.receiveShadow = true
    body.castShadow = true
    group.add(body)
  }

  // ---- 铁轨（两条平行细条） ----
  const railMat = new THREE.MeshStandardMaterial({
    color: '#8a8a8a',
    roughness: 0.4,
    metalness: 0.7,
  })

  const railWidth = 2.0
  const railSegments = 100

  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < railSegments; i++) {
      const t = i / railSegments
      const tNext = (i + 1) / railSegments
      const p = curve.getPoint(t)
      const pNext = curve.getPoint(tNext)
      const tangent = curve.getTangent(t)
      const up = new THREE.Vector3(0, 1, 0)
      const right = new THREE.Vector3().crossVectors(tangent, up).normalize()

      const offset = right.clone().multiplyScalar(side * railWidth * 0.5)
      const p1 = p.clone().add(offset)
      const p2 = pNext.clone().add(offset)
      const mid = new THREE.Vector3().copy(p1).add(p2).multiplyScalar(0.5)
      const dir = new THREE.Vector3().copy(p2).sub(p1)
      const length = dir.length()
      const angle = Math.atan2(dir.x, dir.z)

      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.15, length),
        railMat,
      )
      rail.position.copy(mid)
      rail.position.y = roadHeight + 0.1
      rail.rotation.y = angle
      group.add(rail)
    }
  }

  // ---- 枕木 ----
  const sleeperMat = new THREE.MeshStandardMaterial({
    color: '#6b4c3b',
    roughness: 1,
    metalness: 0,
  })

  const sleeperCount = 60
  for (let i = 0; i < sleeperCount; i++) {
    const t = i / sleeperCount
    const p = curve.getPoint(t)
    const tangent = curve.getTangent(t)
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(tangent, up).normalize()
    const angle = Math.atan2(tangent.x, tangent.z)

    const sleeper = new THREE.Mesh(
      new THREE.BoxGeometry(railWidth + 0.5, 0.08, 0.2),
      sleeperMat,
    )
    sleeper.position.copy(p)
    sleeper.position.y = roadHeight + 0.05
    sleeper.rotation.y = angle
    group.add(sleeper)
  }

  return { group, curve }
}
