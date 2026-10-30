'use client'

import React, { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Bounds, Environment, OrbitControls, useGLTF, useProgress } from '@react-three/drei'
import * as THREE from 'three'

const DEFAULT_MODEL_PATH = '/model.glb'

type Part = {
  object: THREE.Object3D
  home: THREE.Vector3   // 原始「局部」坐标，复位基准
  axis: THREE.Vector3   // 单位爆炸方向（世界空间）
  toLocal: THREE.Matrix3 // 世界位移 → 父级局部位移
  distance: number
}

const tmpDelta = new THREE.Vector3()
const tmpTarget = new THREE.Vector3()

function ExplodingModel({
  progress,
  spread = 1,
  modelUrl,
}: {
  progress: number
  spread?: number
  modelUrl: string
}) {
  const { scene } = useGLTF(modelUrl)
  const progressRef = useRef(progress)
  progressRef.current = progress

  const { parts, restore } = useMemo(() => {
    const scenePos = scene.position.clone()
    scene.updateMatrixWorld(true)

    // 1) 爆炸中心 = 模型整体包围盒中心，并把它搬到原点
    //    这样「页面视觉中心 == 爆炸中心」，散开才是真正向四周
    const bounds = new THREE.Box3().setFromObject(scene)
    const center = bounds.getCenter(new THREE.Vector3())
    const size = bounds.getSize(new THREE.Vector3())
    const radius = Math.max(size.length() * 0.5, 1e-4)
    scene.position.sub(center)
    scene.updateMatrixWorld(true)

    // 2) 只移动「顶层」mesh，避免父子嵌套导致位移叠加漂移
    const meshes: THREE.Mesh[] = []
    scene.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      let p = mesh.parent
      let nested = false
      while (p) {
        if ((p as THREE.Mesh).isMesh) { nested = true; break }
        p = p.parent
      }
      if (!nested) meshes.push(mesh)
    })

    const parts: Part[] = meshes.map((mesh, i) => {
      // console.log(mesh)
      // 3) 方向来自「零件自身的世界包围盒中心」，不是节点原点
      const meshBox = new THREE.Box3().setFromObject(mesh)
      const meshCenter = meshBox.isEmpty()
        ? mesh.getWorldPosition(new THREE.Vector3())
        : meshBox.getCenter(new THREE.Vector3())

      // 模型已居中，所以中心就是零件相对爆炸中心的向量
      const axis = meshCenter.clone()
      if (axis.lengthSq() < 1e-8) {
        // 退化情况（零件正好在中心）：用黄金角球面方向兜底
        const y = 1 - (i / Math.max(1, meshes.length - 1)) * 2
        const r = Math.sqrt(Math.max(0, 1 - y * y))
        const theta = Math.PI * (3 - Math.sqrt(5)) * i
        axis.set(Math.cos(theta) * r, y, Math.sin(theta) * r)
      }
      axis.normalize()

      // 4) 缓存父级世界矩阵的逆（只取旋转/缩放），位移换算不再受父级实时变换影响
      const toLocal = new THREE.Matrix3()
      if (mesh.parent) toLocal.setFromMatrix4(mesh.parent.matrixWorld).invert()

      return {
        object: mesh,
        home: mesh.position.clone(),
        axis,
        toLocal,
        distance: radius * (0.35 + Math.random() * 0.25),
      }
    })

    return {
      parts,
      restore: () => {
        scene.position.copy(scenePos)
        parts.forEach((p) => p.object.position.copy(p.home))
      },
    }
  }, [scene])

  // useGLTF 会缓存 scene，卸载时复位，避免二次挂载越跑越偏
  useEffect(() => restore, [restore])

  useFrame(() => {
    const t = progressRef.current
    for (const { object, home, axis, toLocal, distance } of parts) {
      tmpDelta.copy(axis).multiplyScalar(distance * t * spread).applyMatrix3(toLocal)
      tmpTarget.copy(home).add(tmpDelta)
      object.position.lerp(tmpTarget, 0.16) // 想要严格跟随滑杆就直接 copy(tmpTarget)
    }
  })

  return <primitive object={scene} />
}

function DemoAssembly() {
  const pieces = [
    { position: [0, 0.65, 0] as [number, number, number], scale: [0.9, 0.18, 0.9] as [number, number, number] },
    { position: [0, 0.25, 0] as [number, number, number], scale: [0.62, 0.24, 0.62] as [number, number, number] },
    { position: [0, -0.2, 0] as [number, number, number], scale: [0.4, 0.48, 0.4] as [number, number, number] },
    { position: [0, -0.78, 0] as [number, number, number], scale: [0.78, 0.12, 0.78] as [number, number, number] },
  ]
  return <group>{pieces.map((piece, index) => <mesh key={index} position={piece.position} scale={piece.scale} castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={index % 2 ? '#38bdf8' : '#dbeafe'} metalness={0.5} roughness={0.25} /></mesh>)}</group>
}

class ModelErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() { return this.state.hasError ? <DemoAssembly /> : this.props.children }
}

function LoadingOverlay() {
  const { active, progress } = useProgress()
  if (!active) return null // 原写法把 Suspense 放在 Canvas 外，永远不会 pending，loading 其实一直没显示
  return (
    <div className="absolute inset-0 grid place-items-center text-sm text-slate-400">
      <div className="flex flex-col items-center gap-3">
        <div className="h-1 w-36 overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-cyan-400 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <span>正在加载模型 {Math.round(progress)}%</span>
      </div>
    </div>
  )
}

export function ModelViewer({
  progress,
  modelUrl = DEFAULT_MODEL_PATH,
  spread = 1,
}: {
  progress: number
  modelUrl?: string
  spread?: number
}) {
  return (
    <div className="absolute inset-0">
      <Canvas shadows camera={{ position: [3.2, 2.1, 4.3], fov: 42 }} dpr={[1, 2]}>
        <color attach="background" args={['#0b1220']} />
        <ambientLight intensity={1.3} />
        <directionalLight castShadow position={[4, 6, 3]} intensity={3.2} color="#dff7ff" />
        <pointLight position={[-3, 1, -2]} intensity={18} distance={8} color="#2076ff" />
        <Suspense fallback={null}>
          <Environment preset="studio" environmentIntensity={0.65} />
          <Bounds fit clip observe margin={1.4}>
            <ModelErrorBoundary>
              <ExplodingModel progress={progress} spread={spread} modelUrl={modelUrl} />
            </ModelErrorBoundary>
          </Bounds>
        </Suspense>
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={1.5} maxDistance={10} />
      </Canvas>
      <LoadingOverlay />
    </div>
  )
}
