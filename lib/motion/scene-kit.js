// 场景层脚手架：建工程时把这三件拷进 <工程>/scene-kit/。
//
// 为什么是「拷贝」不是「引用」：Remotion 的 bundle 只解析工程目录里的相对路径，
// 跨包 import 会在打包期炸掉；而这三件又必须每个工程都能改。
//
// 为什么值得有：画质的一半不在插件里，在场景怎么写。同一件事（亚像素抖动到底
// 是居中抖还是右下角抖、弹簧是 9% 过冲还是 30% 过冲）让每个片子自己发明，
// 结果就是 15 种风格长出 15 种错法。放在这里 = 只有一份实现。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DET = `// 确定性随机：同一个 (frame, salt, index) 永远得到同一个值。
// 禁 Math.random()：帧渲染可能被并行、被重跑、被预取，随机数会让同一 t 出两种画面。
// 用法：const dx = detBetween(frame, 7, 0, -0.5, 0.5)

export function hash32(seed: number): number {
  let x = seed | 0
  x = (x ^ 61) ^ (x >>> 16)
  x = x + (x << 3)
  x = x ^ (x >>> 4)
  x = Math.imul(x, 0x27d4eb2d)
  x = x ^ (x >>> 15)
  return (x >>> 0) / 4294967296
}

export const det = (frame: number, salt = 0, index = 0): number =>
  hash32(Math.imul(frame + 1, 73856093) ^ Math.imul(salt + 1, 19349663) ^ Math.imul(index + 1, 83492791))

export const detBetween = (frame: number, salt: number, index: number, min: number, max: number): number =>
  min + (max - min) * det(frame, salt, index)

// 低差异序列：累积采样要用 Halton(2,3) 而不是均匀随机，
// 否则 8 个样本会扎堆，边缘反而更脏。
export function halton(index: number, base: number): number {
  let result = 0
  let fraction = 1 / base
  let i = index + 1
  while (i > 0) {
    result += (i % base) * fraction
    i = Math.floor(i / base)
    fraction /= base
  }
  return result
}

// 亚像素抖动偏移（单位：像素），居中在 [-0.5, 0.5]。
export const jitter = (sample: number, index: number): [number, number] =>
  [halton(index, 2) - 0.5, halton(index, 3) - 0.5]
`

const GROW = `// 等轴生长曲线：底面落位 → 立面 scaleY 拉起 → 屋顶延迟盖上。
// 三种曲线都是闭式解：给定 t 就能算，不依赖历史帧，所以任意帧可独立渲染。

export const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

export const easeOutCubic = (value: number): number => 1 - Math.pow(1 - clamp01(value), 3)
export const easeInOutCubic = (value: number): number => {
  const t = clamp01(value)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
export const easeOutBack = (value: number, overshoot = 1.70158): number => {
  const t = clamp01(value) - 1
  return 1 + (overshoot + 1) * t * t * t + overshoot * t * t
}

// 阻尼弹簧的闭式解。zeta=0.61 时过冲约 9%（e^(-pi*zeta/sqrt(1-zeta^2))≈0.089），
// 正好是「有生命、但不像卡通」的那一档；要更弹就降 zeta，要更硬就升。
export function spring(t: number, duration = 0.6, zeta = 0.61): number {
  if (t <= 0) return 0
  const wn = 10 / Math.max(duration, 0.01)
  const wd = wn * Math.sqrt(1 - zeta * zeta)
  return 1 - Math.exp(-zeta * wn * t) * (Math.cos(wd * t) + ((zeta * wn) / wd) * Math.sin(wd * t))
}

// 落体：加速下坠，触地一帧内挤压回弹（sy 从 0.7 弹回 1，40rad/s 的快振）。
export function drop(t: number, duration = 0.3): { y: number; sy: number; landed: boolean } {
  if (t <= 0) return { y: 1, sy: 1, landed: false }
  if (t < duration) {
    const x = clamp01(t / duration)
    return { y: 1 - x * x, sy: 1, landed: false }
  }
  const tau = t - duration
  return { y: 0, sy: 1 - 0.3 * Math.exp(-tau / 0.05) * Math.cos(40 * tau), landed: true }
}

// 立面：底座先落位，之后 scaleY 从 base 拉到 1。
export function wallScale(t: number, base = 0.1, duration = 0.6): number {
  if (t <= 0) return 0
  return base + (1 - base) * spring(t, duration)
}

// 屋顶：比墙晚 lag 秒盖上，用 3 帧的快速 pop。
export function roofAt(t: number, lag = 0.375, duration = 0.12): number {
  return clamp01((t - lag) / duration)
}

// 错峰：第 index 个物体晚 stagger 秒开始，整个梯队铺满 spread 秒。
export const stagger = (index: number, stagger = 0.04): number => index * stagger

// 冲击波：半径随 t 线性扩散（pulse_speed=15 是等轴岛上「刚好扫过半个岛」的速度）。
export const pulseRadius = (t: number, speed = 15, from = 1): number => from + speed * Math.max(0, t)
`

const LOOK = `// 画面质感三件：SSAA、软阴影、色调映射，外加一层确定性颗粒。
// 放在 <ThreeCanvas> 里面（Grain 放外面，覆盖在整幅画面上）。
//
// 关键：等轴场景满屏都是 30°/60° 斜边，1× 渲染出来的阶梯肉眼可见。
// 把绘制缓冲放大到 2× 再让浏览器缩小，就是最便宜的 SSAA —— 比任何 CSS 滤镜都真实。

import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect } from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'

type LookProps = {
  ssaa?: number          // 1 = 关；2 = 推荐；>2 收益递减
  shadow?: 'soft' | 'pcf' | 'basic'
  exposure?: number
  toneMapping?: 'aces' | 'neutral' | 'none'
}

export function Look({ ssaa = 2, shadow = 'soft', exposure = 1, toneMapping = 'aces' }: LookProps) {
  const { gl } = useThree()
  useLayoutEffect(() => {
    const ratio = gl.getPixelRatio()
    const type = gl.shadowMap.type
    const mode = gl.toneMapping
    const previousExposure = gl.toneMappingExposure
    gl.setPixelRatio(Math.min(2, Math.max(1, ssaa)))
    gl.shadowMap.type = shadow === 'basic' ? THREE.BasicShadowMap : shadow === 'pcf' ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap
    gl.shadowMap.needsUpdate = true
    gl.toneMapping = toneMapping === 'none' ? THREE.NoToneMapping : toneMapping === 'neutral' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping
    gl.toneMappingExposure = exposure
    return () => {
      gl.setPixelRatio(ratio)
      gl.shadowMap.type = type
      gl.toneMapping = mode
      gl.toneMappingExposure = previousExposure
    }
  }, [gl, ssaa, shadow, exposure, toneMapping])
  return null
}

// 颗粒：feTurbulence 是确定性的（同 seed 同图），不消耗逐帧随机数，
// 用来打散 8bit 渐变的色带——色带是被「平」出来的，颗粒就是把它重新打碎。
export function Grain({ opacity = 0.05, seed = 7 }: { opacity?: number; seed?: number }) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><filter id="n" x="0" y="0"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="' + seed + '"/><feColorMatrix type="saturate" values="0"/></filter><rect width="160" height="160" filter="url(#n)" opacity="1"/></svg>'
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity, mixBlendMode: 'multiply',
      backgroundImage: 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")',
      backgroundSize: '160px 160px' }} />
  )
}

// 暗角：只压四角，中间不动。等轴画面四角是空的，压下去反而更聚。
export function Vignette({ strength = 0.18 }: { strength?: number }) {
  return (
    <AbsoluteFill style={{ pointerEvents: 'none',
      background: 'radial-gradient(ellipse at 50% 48%, rgba(0,0,0,0) 52%, rgba(20,16,48,' + strength + ') 100%)' }} />
  )
}
`

export const SCENE_KIT = { 'det.ts': DET, 'grow.ts': GROW, 'look.tsx': LOOK }

export function sceneKitFiles() {
  return Object.keys(SCENE_KIT)
}

// 只写缺的文件：agent 改过的 scene-kit 不该在下一次 create 时被覆盖。
export function writeSceneKit(dir, options = {}) {
  const io = options.io || { join, dirname, existsSync, mkdirSync, writeFileSync }
  const written = []
  for (const [name, source] of Object.entries(SCENE_KIT)) {
    const file = io.join(dir, 'scene-kit', name)
    io.mkdirSync(io.dirname(file), { recursive: true })
    if (io.existsSync(file) && !options.overwrite) continue
    io.writeFileSync(file, source, 'utf8')
    written.push('scene-kit/' + name)
  }
  return written
}
