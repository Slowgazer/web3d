import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'

const MODEL_PATH = '/models/CUPIC_OCEAN.obj'
const MTL_PATH = '/models/CUPIC_OCEAN.mtl'

export function loadSeaModel() {
  return new Promise((resolve, reject) => {
    const mtlLoader = new MTLLoader()
    mtlLoader.load(MTL_PATH, (materials) => {
      materials.preload()
      const objLoader = new OBJLoader()
      objLoader.setMaterials(materials)
      objLoader.load(
        MODEL_PATH,
        (object) => {
          // 海面模型是透明材质(d=0)，修改为不透明并着色
          object.traverse((child) => {
            if (child.isMesh && child.material) {
              child.material.transparent = false
              child.material.opacity = 1.0
              child.material.depthWrite = true
              child.material.side = THREE.DoubleSide

              // 吉卜力风格颜色 - 浅蓝到深蓝渐变无法直接用在单一颜色材质上
              // 改用标准材质并设定一个漂亮的海洋蓝
              child.material.color.set('#5bb8d8')
              child.material.roughness = 0.4
              child.material.metalness = 0.1
              child.material.envMapIntensity = 0.3
            }
          })

          // 缩小到合适大小（原始模型约 2000 单位宽）
          object.scale.set(0.05, 0.05, 0.05)

          // 定位到轨道下方
          object.position.y = -2.5

          resolve(object)
        },
        undefined,
        (err) => reject(err),
      )
    }, undefined, (err) => reject(err))
  })
}
