import * as THREE from 'three'

const vertexShader = `
uniform float uTime;
uniform float uWaveHeight;
uniform float uWaveFreq;

varying float vElevation;
varying vec2 vUv;

// 伪随机函数用于浪花变化
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vUv = uv;
  vec3 pos = position;

  // 多层波浪叠加，模拟吉卜力风格的柔和海面
  float w1 = sin(pos.x * uWaveFreq + uTime * 0.8) * uWaveHeight;
  float w2 = sin(pos.y * uWaveFreq * 0.7 + uTime * 1.1) * uWaveHeight * 0.6;
  float w3 = sin((pos.x + pos.y) * uWaveFreq * 0.4 + uTime * 0.5) * uWaveHeight * 0.3;
  float w4 = sin(pos.x * uWaveFreq * 1.3 - uTime * 0.6) * uWaveHeight * 0.2;
  float w5 = sin(pos.y * uWaveFreq * 1.1 - uTime * 0.9) * uWaveHeight * 0.15;

  pos.z = w1 + w2 + w3 + w4 + w5;
  vElevation = pos.z;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`

const fragmentShader = `
uniform float uTime;
uniform vec3 uColorShallow;
uniform vec3 uColorMid;
uniform vec3 uColorDeep;
uniform vec3 uColorFoam;
uniform float uFoamOffset;
uniform vec3 uFogNearColor;
uniform vec3 uFogFarColor;

varying float vElevation;
varying vec2 vUv;

void main() {
  // 基于高度进行三层渐变（吉卜力风格色带）
  float h = (vElevation + 1.5) / 3.0;
  h = clamp(h, 0.0, 1.0);

  vec3 color;
  if (h < 0.4) {
    color = mix(uColorDeep, uColorMid, h / 0.4);
  } else {
    color = mix(uColorMid, uColorShallow, (h - 0.4) / 0.6);
  }

  // 浪花（波峰白色泡沫）
  float foam = smoothstep(uFoamOffset, uFoamOffset + 0.15, vElevation);
  color = mix(color, uColorFoam, foam * 0.8);

  // 在波浪之间添加微弱的白色线条
  float foamLine = smoothstep(0.3, 0.5, fract(vElevation * 3.0 + uTime * 0.2));
  color = mix(color, uColorFoam, foamLine * 0.15);

  // 简单雾效
  float depth = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = smoothstep(30.0, 80.0, depth);
  color = mix(color, uFogFarColor, fogFactor);

  gl_FragColor = vec4(color, 1.0);
}
`

export function createOcean() {
  const geometry = new THREE.PlaneGeometry(200, 200, 200, 200)
  geometry.rotateX(-Math.PI / 2)

  const uniforms = {
    uTime: { value: 0 },
    uWaveHeight: { value: 0.6 },
    uWaveFreq: { value: 0.15 },
    uColorShallow: { value: new THREE.Color('#88d8d8') },
    uColorMid: { value: new THREE.Color('#4a9fc5') },
    uColorDeep: { value: new THREE.Color('#1a3d5c') },
    uColorFoam: { value: new THREE.Color('#f5fcff') },
    uFoamOffset: { value: 0.15 },
    uFogNearColor: { value: new THREE.Color('#b5dff5') },
    uFogFarColor: { value: new THREE.Color('#8fc9e8') },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    transparent: false,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = -1.5
  mesh.receiveShadow = true

  return { mesh, uniforms }
}
