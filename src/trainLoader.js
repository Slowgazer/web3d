import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'

const MODEL_PATH = '/models/Train_1392.obj'
const MTL_PATH = '/models/Train_1392.mtl'

export function loadTrainModel() {
  return new Promise((resolve, reject) => {
    const mtlLoader = new MTLLoader()
    mtlLoader.load(MTL_PATH, (materials) => {
      materials.preload()
      const objLoader = new OBJLoader()
      objLoader.setMaterials(materials)
      objLoader.load(
        MODEL_PATH,
        (object) => {
          object.scale.set(0.06, 0.06, 0.06)

          const matList = []

          object.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = true
              child.receiveShadow = true

              if (child.material) {
                // 提取材质名称用于 GUI 控制
                const matName = child.material.name || 'unnamed'
                if (!matList.find((m) => m.name === matName)) {
                  matList.push({
                    name: matName,
                    material: child.material,
                  })
                }
              }
            }
          })

          // 返回模型和材质列表
          resolve({ object, materials: matList })
        },
        undefined,
        (err) => reject(err),
      )
    }, undefined, (err) => reject(err))
  })
}
