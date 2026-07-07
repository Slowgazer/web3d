import * as THREE from 'three'

export function createSky() {
  const group = new THREE.Group()

  // 渐变天幕 - 使用大球体内表面
  const skyGeo = new THREE.SphereGeometry(95, 32, 32)
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uTopColor: { value: new THREE.Color('#a8d8ea') },
      uBottomColor: { value: new THREE.Color('#fae8c8') },
    },
    vertexShader: `
varying vec3 vWorldPosition;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
    fragmentShader: `
uniform vec3 uTopColor;
uniform vec3 uBottomColor;
varying vec3 vWorldPosition;
void main() {
  float h = normalize(vWorldPosition).y;
  h = clamp(h * 0.5 + 0.5, 0.0, 1.0);
  vec3 color = mix(uBottomColor, uTopColor, h);
  gl_FragColor = vec4(color, 1.0);
}
`,
  })
  const skyMesh = new THREE.Mesh(skyGeo, skyMat)
  group.add(skyMesh)

  // 云朵 - 多个半透球体组合
  const cloudMat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0.7,
    roughness: 1,
    metalness: 0,
    depthWrite: false,
  })

  const cloudPositions = [
    { x: -30, y: 18, z: -25, scale: 1.2 },
    { x: -15, y: 22, z: -30, scale: 0.9 },
    { x: 10, y: 20, z: -35, scale: 1.4 },
    { x: 35, y: 16, z: -28, scale: 1.0 },
    { x: -40, y: 15, z: -20, scale: 0.8 },
    { x: 20, y: 14, z: -40, scale: 1.1 },
    { x: -10, y: 25, z: -45, scale: 0.7 },
    { x: 45, y: 20, z: -32, scale: 0.9 },
    { x: -25, y: 12, z: -38, scale: 1.3 },
    { x: 30, y: 24, z: -42, scale: 0.6 },
  ]

  cloudPositions.forEach((pos) => {
    const cloudGroup = new THREE.Group()
    const count = 4 + Math.floor(Math.random() * 3)
    for (let i = 0; i < count; i++) {
      const r = 1.5 + Math.random() * 2.5
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(r, 8, 8),
        cloudMat.clone(),
      )
      sphere.position.set(
        (Math.random() - 0.5) * 4,
        (Math.random() - 0.5) * 1.5,
        (Math.random() - 0.5) * 2,
      )
      sphere.scale.y = 0.6
      cloudGroup.add(sphere)
    }
    cloudGroup.position.set(pos.x, pos.y, pos.z)
    cloudGroup.scale.set(pos.scale, pos.scale, pos.scale)
    group.add(cloudGroup)
  })

  return group
}
