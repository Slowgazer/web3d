// ============================================================================
// 海鸥（Sketchfab 模型，带骨骼动画）
// 资源：Low-Poly Seagull (with Animation & Rigged) by simonaskLDE · CC BY
//   https://sketchfab.com/3d-models/low-poly-seagull-with-animation-rigged-985024328902444c8270c0f09acc897e
// 用 SkeletonUtils.clone 复制骨骼网格，各自独立动画。
// ============================================================================
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'

const MODEL_URL = '/models/seagull/seagull.glb'

export async function spawnSeagulls(scene, options = {}) {
  const {
    count = 6,
    radius = 60,                                   // 盘旋半径
    center = new THREE.Vector3(0, 16, -120),       // 盘旋中心
    size = 1.4,                                    // 期望最大尺寸（米）
    speed = 0.3,
  } = options

  const gltf = await new GLTFLoader().loadAsync(MODEL_URL)
  const template = gltf.scene
  const clip = gltf.animations && gltf.animations[0]

  // 按包围盒自动算缩放，避免依赖模型原始单位
  const box = new THREE.Box3().setFromObject(template)
  const dim = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(dim.x, dim.y, dim.z) || 1
  const s = size / maxDim

  const birds = []
  const mixers = []
  for (let i = 0; i < count; i++) {
    const model = skeletonClone(template)
    model.scale.setScalar(s)
    model.rotation.y = Math.PI / 2 // 模型朝向 → +X 切向
    const holder = new THREE.Group()
    holder.add(model)
    holder.userData = {
      r: radius * (0.55 + Math.random() * 0.8),
      a: Math.random() * Math.PI * 2,
      y: center.y + (Math.random() - 0.5) * 8,
      spd: speed * (0.8 + Math.random() * 0.7),
    }
    scene.add(holder)
    birds.push(holder)

    if (clip) {
      const mixer = new THREE.AnimationMixer(model)
      const action = mixer.clipAction(clip)
      action.play()
      action.time = Math.random() * clip.duration
      mixer.timeScale = 0.85 + Math.random() * 0.5
      mixers.push(mixer)
    }
  }

  return {
    birds,
    mixers,
    update(dt) {
      for (const mx of mixers) mx.update(dt)
      for (const h of birds) {
        const d = h.userData
        d.a += d.spd * dt
        h.position.set(
          center.x + Math.cos(d.a) * d.r,
          d.y,
          center.z + Math.sin(d.a) * d.r,
        )
        h.rotation.y = -d.a // 朝切向
      }
    },
  }
}
