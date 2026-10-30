'use client'

import React, { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Bounds, Environment, OrbitControls, useGLTF, useProgress } from '@react-three/drei'
import * as THREE from 'three'

const DEFAULT_MODEL_PATH = '/model.glb'

type Part = {
  object: THREE.Object3D
  origin: THREE.Vector3
  direction: THREE.Vector3
  distance: number
}

function ExplodingModel({ progress, modelUrl }: { progress: number; modelUrl: string }) {
  const { scene } = useGLTF(modelUrl)
  const group = useRef<THREE.Group>(null)
  const parts = useMemo<Part[]>(() => {
    const meshes: THREE.Mesh[] = []
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true
        child.receiveShadow = true
        meshes.push(child)
      }
    })

    const bounds = new THREE.Box3().setFromObject(scene)
    const center = bounds.getCenter(new THREE.Vector3())
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.26, 0.1)

    return meshes.map((mesh) => {
      const origin = mesh.getWorldPosition(new THREE.Vector3())
      const direction = origin.clone().sub(center)
      if (direction.lengthSq() < 0.001) direction.set(0, 1, 0)
      direction.normalize()
      return { 
        object: mesh, 
        origin, direction, 
        distance: radius * (0.8 + Math.random() * 0.55) 
      }
    })
  }, [scene])

  useEffect(() => {
    parts.forEach(({ object, origin }) => {
      object.position.copy(origin)
    })
  }, [parts])

  useFrame(() => {
    parts.forEach(({ object, origin, direction, distance }) => {
      const target = origin.clone().addScaledVector(direction, distance * progress*4)
      const worldTarget = object.parent?.worldToLocal(target) ?? target
      object.position.lerp(worldTarget, 0.16)



    })
  })

  return <primitive ref={group} object={scene} />
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

function LoadingState() {
  const { progress } = useProgress()
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

export function ModelViewer({ progress, modelUrl = DEFAULT_MODEL_PATH }: { progress: number; modelUrl?: string }) {
  return (
    <div className="absolute inset-0">
      <Canvas shadows camera={{ position: [3.2, 2.1, 4.3], fov: 42 }} dpr={[1, 2]}>
        <color attach="background" args={['#0b1220']} />
        <ambientLight intensity={1.3} />
        <directionalLight castShadow position={[4, 6, 3]} intensity={3.2} color="#dff7ff" />
        <pointLight position={[-3, 1, -2]} intensity={18} distance={8} color="#2076ff" />
        <Suspense fallback={null}>
          <Environment preset="studio" environmentIntensity={0.65} />
          <Bounds fit clip observe margin={1.2}>
            <ModelErrorBoundary>
              <ExplodingModel progress={progress} modelUrl={modelUrl} />
            </ModelErrorBoundary>
          </Bounds>
        </Suspense>
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={1.5} maxDistance={10} />
      </Canvas>
      <Suspense fallback={<LoadingState />} />
    </div>
  )
}

