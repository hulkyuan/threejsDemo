'use client'

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bounds, Environment, OrbitControls, useGLTF, useProgress } from '@react-three/drei'
import * as THREE from 'three'

const DEFAULT_MODEL_PATH = '/model.glb'
const SELECT_COLOR = '#38bdf8' // 天空蓝：选中（悬停不改色，只切换鼠标指针形状）

type Backup = {
  color: THREE.Color
  emissive: THREE.Color | null
  emissiveIntensity: number
}

type Part = {
  id: string
  name: string
  object: THREE.Object3D
  home: THREE.Vector3 // 原始「局部」坐标，复位基准
  axis: THREE.Vector3 // 单位爆炸方向（世界空间）
  toLocal: THREE.Matrix3 // 世界位移 → 父级局部位移
  distance: number
  size: THREE.Vector3
  triangles: number
  materials: THREE.Material[] // clone 出来的独立材质（实际挂在 mesh 上）
  backup: Backup[]
  on: boolean | null // 当前高亮状态，null 表示尚未初始化（强制首帧应用一次）
}

export type PartMeta = {
  id: string
  name: string
  size: [number, number, number]
  triangles: number
}

export type ViewerApi = {
  focus: (id: string) => void
}

const tmpDelta = new THREE.Vector3()
const tmpTarget = new THREE.Vector3()

type OrbitLike = { target: THREE.Vector3; update: () => void; minDistance: number; maxDistance: number }

/**
 * 关键点：不能只改 emissive。
 * - MeshBasicMaterial（glTF 的 KHR_materials_unlit）没有 emissive，改了等于没改；
 * - 场景灯光很亮时 emissive 也不够醒目。
 * 所以直接改 color（真正"变成蓝色"），emissive 只作为附加辉光。
 */
function applyHighlight(part: Part, on: boolean) {
  if (part.on === on) return // 只在状态切换时写材质
  part.on = on
  part.materials.forEach((material, i) => {
    const b = part.backup[i]
    const m = material as THREE.MeshStandardMaterial

    // 1) 颜色：选中变天空蓝，取消则还原（悬停不动颜色）
    if (on) m.color.set(SELECT_COLOR)
    else m.color.copy(b.color)

    // 2) 自发光：有就用，没有（Basic 材质）就跳过
    if (m.emissive) {
      if (on) {
        m.emissive.set(SELECT_COLOR)
        m.emissiveIntensity = 0.85
      } else {
        if (b.emissive) m.emissive.copy(b.emissive)
        m.emissiveIntensity = b.emissiveIntensity
      }
    }
  })
}

/**
 * 材质 clone 必须是「幂等」的。
 * 原因：React StrictMode（Next.js 默认开启）会把 useMemo 执行两次、并在 mount 后立刻跑一次
 * effect cleanup。旧写法在 cleanup 里把 mesh.material 还原成原始材质并 dispose 掉 clone，
 * 导致 React 里保留的 materials 变成"死"对象 —— 高亮改了但屏幕上看不到任何变化。
 * 这里改成用 WeakMap 记录，clone 只做一次，且永不在 cleanup 中还原材质。
 */
type MeshCache = {
  home: THREE.Vector3
  materials: THREE.Material[]
  backup: Backup[]
}
const meshCache = new WeakMap<THREE.Mesh, MeshCache>()

function getMeshCache(mesh: THREE.Mesh): MeshCache {
  const cached = meshCache.get(mesh)
  if (cached) return cached

  const isArray = Array.isArray(mesh.material)
  const source = (isArray ? mesh.material : [mesh.material]) as THREE.Material[]
  // 必须 clone：glTF 常共享材质，否则高亮会让一批零件一起变色
  const materials = source.map((m) => m.clone())
  mesh.material = isArray ? materials : materials[0]

  const backup: Backup[] = materials.map((m) => {
    const std = m as THREE.MeshStandardMaterial
    return {
      color: std.color.clone(),
      emissive: std.emissive ? std.emissive.clone() : null,
      emissiveIntensity: std.emissiveIntensity ?? 1,
    }
  })

  const entry: MeshCache = { home: mesh.position.clone(), materials, backup }
  meshCache.set(mesh, entry)
  return entry
}

function ExplodingModel({
  progress,
  spread = 1,
  modelUrl,
  selectedId,
  hoveredId,
  hiddenIds,
  onSelect,
  onHover,
  onPartsLoaded,
  apiRef,
}: {
  progress: number
  spread?: number
  modelUrl: string
  selectedId: string | null
  hoveredId: string | null
  hiddenIds: Set<string>
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
  onPartsLoaded: (parts: PartMeta[]) => void
  apiRef: React.MutableRefObject<ViewerApi | null>
}) {
  const { scene } = useGLTF(modelUrl)
  const progressRef = useRef(progress)
  progressRef.current = progress

  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null

  // 高亮/显隐同步在 useFrame 里做，用 ref 读取最新值，避免任何 effect 时序问题
  const selectedRef = useRef<string | null>(selectedId)
  const hoveredRef = useRef<string | null>(hoveredId)
  const hiddenRef = useRef<Set<string>>(hiddenIds)
  useEffect(() => {
    selectedRef.current = selectedId
    hoveredRef.current = hoveredId
    hiddenRef.current = hiddenIds
  }, [selectedId, hoveredId, hiddenIds])

  const { parts, lookup } = useMemo(() => {
    scene.updateMatrixWorld(true)

    // 1) 爆炸中心 = 模型整体包围盒中心，并把它搬到原点（该操作是幂等的，重复执行无副作用）
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
        if ((p as THREE.Mesh).isMesh) {
          nested = true
          break
        }
        p = p.parent
      }
      if (!nested) meshes.push(mesh)
    })

    const list: Part[] = meshes.map((mesh, i) => {
      // 3) 方向来自「零件自身的世界包围盒中心」，而不是节点原点
      const meshBox = new THREE.Box3().setFromObject(mesh)
      const meshCenter = meshBox.isEmpty()
        ? mesh.getWorldPosition(new THREE.Vector3())
        : meshBox.getCenter(new THREE.Vector3())

      const axis = meshCenter.clone()
      if (axis.lengthSq() < 1e-8) {
        // 退化情况（零件正好落在中心）：黄金角球面方向兜底
        const y = 1 - (i / Math.max(1, meshes.length - 1)) * 2
        const r = Math.sqrt(Math.max(0, 1 - y * y))
        const theta = Math.PI * (3 - Math.sqrt(5)) * i
        axis.set(Math.cos(theta) * r, y, Math.sin(theta) * r)
      }
      axis.normalize()

      // 4) 缓存父级世界矩阵的逆（只取旋转/缩放），位移换算不受父级实时变换影响
      const toLocal = new THREE.Matrix3()
      if (mesh.parent) toLocal.setFromMatrix4(mesh.parent.matrixWorld).invert()

      const cache = getMeshCache(mesh)

      let triangles = 0
      mesh.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh || !m.geometry) return
        const g = m.geometry
        triangles += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3
      })

      const name = (mesh.name && mesh.name.trim()) || mesh.parent?.name || `零件 ${i + 1}`

      return {
        id: mesh.uuid,
        name,
        object: mesh,
        home: cache.home,
        axis,
        toLocal,
        distance: radius * (0.35 + Math.random() * 0.25),
        size: meshBox.getSize(new THREE.Vector3()),
        triangles: Math.round(triangles),
        materials: cache.materials,
        backup: cache.backup,
        on: null, // 强制首帧应用一次
      }
    })

    // 任意子网格 → 顶层零件
    const map = new Map<THREE.Object3D, Part>()
    list.forEach((p) => p.object.traverse((o) => map.set(o, p)))

    return { parts: list, lookup: map }
  }, [scene])

  // 零件元数据上报给外层信息面板
  useEffect(() => {
    onPartsLoaded(
      parts.map((p) => ({
        id: p.id,
        name: p.name,
        size: [p.size.x, p.size.y, p.size.z],
        triangles: p.triangles,
      })),
    )
  }, [parts, onPartsLoaded])

  const focusRef = useRef<{ target: THREE.Vector3; position: THREE.Vector3; minDistance: number } | null>(null)

  const focus = useCallback(
    (id: string) => {
      const part = parts.find((p) => p.id === id)
      if (!part || !part.object.visible) return
      scene.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(part.object)
      if (box.isEmpty()) return
      const center = box.getCenter(new THREE.Vector3())
      const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.02)

      const cam = camera as THREE.PerspectiveCamera
      const fov = ((cam.isPerspectiveCamera ? cam.fov : 45) * Math.PI) / 180
      const dist = Math.max((r / Math.tan(fov / 2)) * 1.6, r * 3)

      // 保持当前观察方向，只把镜头推到零件面前
      const from = controls ? controls.target.clone() : new THREE.Vector3()
      const dir = camera.position.clone().sub(from)
      if (dir.lengthSq() < 1e-8) dir.set(0, 0.35, 1)
      dir.normalize()

      focusRef.current = {
        target: center,
        position: center.clone().addScaledVector(dir, dist),
        minDistance: Math.min(0.2, dist * 0.4),
      }
    },
    [parts, camera, controls, scene],
  )

  useEffect(() => {
    apiRef.current = { focus }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, focus])

  const pick = useCallback(
    (e: ThreeEvent<PointerEvent | MouseEvent>) => {
      const part = lookup.get(e.object)
      // three 的 Raycaster 不会检查 visible，隐藏的零件要手动过滤
      if (!part || !part.object.visible) return null
      return part
    },
    [lookup],
  )

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      const part = pick(e)
      if (!part) return
      e.stopPropagation()
      onSelect(part.id === selectedRef.current ? null : part.id)
    },
    [pick, onSelect],
  )

  // 悬停只用于「鼠标指针变成小手」，不会改变零件颜色
  const handleMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const part = pick(e)
      const id = part ? part.id : null
      if (id !== hoveredRef.current) onHover(id)
    },
    [pick, onHover],
  )

  const handleOut = useCallback(() => onHover(null), [onHover])

  useFrame(() => {
    const t = progressRef.current
    const selId = selectedRef.current
    const hidden = hiddenRef.current

    for (const part of parts) {
      // 高亮：只有「选中」才变色；悬停不改颜色（每帧对齐一次，绝不依赖 effect 时序）
      applyHighlight(part, part.id === selId)

      // 显隐
      const visible = !hidden.has(part.id)
      if (part.object.visible !== visible) part.object.visible = visible

      // 爆炸位移
      tmpDelta.copy(part.axis).multiplyScalar(part.distance * t * spread).applyMatrix3(part.toLocal)
      tmpTarget.copy(part.home).add(tmpDelta)
      part.object.position.lerp(tmpTarget, 0.16) // 想严格跟随滑杆就改成 copy(tmpTarget)
    }

    // 聚焦动画：同时插值相机与 OrbitControls 的 target
    const f = focusRef.current
    if (f) {
      camera.position.lerp(f.position, 0.14)
      if (controls) {
        controls.target.lerp(f.target, 0.14)
        controls.minDistance = f.minDistance
        controls.update()
      }
      if (camera.position.distanceTo(f.position) < Math.max(f.minDistance * 0.02, 0.004)) {
        camera.position.copy(f.position)
        if (controls) {
          controls.target.copy(f.target)
          controls.update()
        }
        focusRef.current = null
      }
    }
  })

  return <primitive object={scene} onClick={handleClick} onPointerMove={handleMove} onPointerOut={handleOut} />
}

// 兜底模型：model.glb 加载失败时会显示它，这里也让它支持选中，方便验证交互链路
function DemoAssembly({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string | null) => void }) {
  const pieces = [
    { position: [0, 0.65, 0] as [number, number, number], scale: [0.9, 0.18, 0.9] as [number, number, number] },
    { position: [0, 0.25, 0] as [number, number, number], scale: [0.62, 0.24, 0.62] as [number, number, number] },
    { position: [0, -0.2, 0] as [number, number, number], scale: [0.4, 0.48, 0.4] as [number, number, number] },
    { position: [0, -0.78, 0] as [number, number, number], scale: [0.78, 0.12, 0.78] as [number, number, number] },
  ]
  return (
    <group>
      {pieces.map((piece, index) => {
        const id = `demo-${index}`
        const active = selectedId === id
        return (
          <mesh
            key={index}
            position={piece.position}
            scale={piece.scale}
            castShadow
            onClick={(e) => {
              e.stopPropagation()
              onSelect(active ? null : id)
            }}
          >
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial
              color={active ? SELECT_COLOR : index % 2 ? '#38bdf8' : '#dbeafe'}
              emissive={active ? SELECT_COLOR : '#000000'}
              emissiveIntensity={active ? 0.8 : 0}
              metalness={0.5}
              roughness={0.25}
            />
          </mesh>
        )
      })}
    </group>
  )
}

class ModelErrorBoundary extends React.Component<
  { children: React.ReactNode; selectedId: string | null; onSelect: (id: string | null) => void },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    return this.state.hasError ? (
      <DemoAssembly selectedId={this.props.selectedId} onSelect={this.props.onSelect} />
    ) : (
      this.props.children
    )
  }
}

// Environment 的 HDR 需要从 CDN 下载；单独包一层边界，
// 避免它挂起或失败时把模型一起拖下线（表现同样是"点了没反应"）
class EnvironmentBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    return this.state.hasError ? null : this.props.children
  }
}

function LoadingOverlay() {
  const { active, progress } = useProgress()
  if (!active) return null
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

function InfoPanel({
  meta,
  hidden,
  onToggleVisible,
  onFocus,
  onClear,
  onShowAll,
  hiddenCount,
}: {
  meta: PartMeta | null
  hidden: boolean
  onToggleVisible: () => void
  onFocus: () => void
  onClear: () => void
  onShowAll: () => void
  hiddenCount: number
}) {
  return (
    <div className="pointer-events-auto absolute right-4 top-4 w-72 rounded-xl border border-white/10 bg-slate-900/80 p-4 text-sm text-slate-200 shadow-2xl backdrop-blur">
      {!meta ? (
        <div className="text-slate-400">
          <div className="mb-1 font-medium text-slate-200">零件信息</div>
          <div>点击模型上的任意零件查看详情</div>
          {hiddenCount > 0 && (
            <button
              onClick={onShowAll}
              className="mt-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-slate-200 transition hover:bg-white/10"
            >
              全部显示（已隐藏 {hiddenCount}）
            </button>
          )}
        </div>
      ) : (
        <div>
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="mb-0.5 text-xs uppercase tracking-wide text-slate-500">当前选中</div>
              <div className="truncate text-base font-semibold text-sky-300" title={meta.name}>
                {meta.name}
              </div>
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                hidden ? 'bg-slate-700 text-slate-300' : 'bg-sky-500/20 text-sky-300'
              }`}
            >
              {hidden ? '已隐藏' : '可见'}
            </span>
          </div>

          <dl className="mb-4 space-y-1.5 text-xs text-slate-400">
            <div className="flex justify-between gap-2">
              <dt>尺寸</dt>
              <dd className="text-slate-200">{meta.size.map((n) => n.toFixed(2)).join(' × ')}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>三角面数</dt>
              <dd className="text-slate-200">{meta.triangles.toLocaleString()}</dd>
            </div>
          </dl>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onToggleVisible}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 transition hover:bg-white/10"
            >
              {hidden ? '显示' : '隐藏'}
            </button>
            <button
              onClick={onFocus}
              disabled={hidden}
              className="rounded-lg bg-sky-500 px-3 py-2 font-medium text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              聚焦
            </button>
            <button
              onClick={onClear}
              className="col-span-2 rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-xs text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
            >
              取消选中
            </button>
          </div>
        </div>
      )}
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
  const [parts, setParts] = useState<PartMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const apiRef = useRef<ViewerApi | null>(null)

  const onPartsLoaded = useCallback((list: PartMeta[]) => setParts(list), [])

  const selected = useMemo(() => parts.find((p) => p.id === selectedId) ?? null, [parts, selectedId])

  const toggleVisible = useCallback((id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 悬停到零件上时变成小手
  useEffect(() => {
    if (!hoveredId) return
    document.body.style.cursor = 'pointer'
    return () => {
      document.body.style.cursor = ''
    }
  }, [hoveredId])

  return (
    <div className="absolute inset-0">
      <Canvas
        shadows
        camera={{ position: [3.2, 2.1, 4.3], fov: 42 }}
        dpr={[1, 2]}
        onPointerMissed={() => setSelectedId(null)}
      >
        <color attach="background" args={['#0b1220']} />
        <ambientLight intensity={1.3} />
        <directionalLight castShadow position={[4, 6, 3]} intensity={3.2} color="#dff7ff" />
        <pointLight position={[-3, 1, -2]} intensity={18} distance={8} color="#2076ff" />
        <Suspense fallback={null}>
          <EnvironmentBoundary>
            {/* <Environment preset="studio" environmentIntensity={0.65} /> */}
            <Environment files="studio_small_03_1k.hdr" />
          </EnvironmentBoundary>
        </Suspense>
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.4}>
            <ModelErrorBoundary selectedId={selectedId} onSelect={setSelectedId}>
              <ExplodingModel
                progress={progress}
                spread={spread}
                modelUrl={modelUrl}
                selectedId={selectedId}
                hoveredId={hoveredId}
                hiddenIds={hiddenIds}
                onSelect={setSelectedId}
                onHover={setHoveredId}
                onPartsLoaded={onPartsLoaded}
                apiRef={apiRef}
              />
            </ModelErrorBoundary>
          </Bounds>
        </Suspense>
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={0.2} maxDistance={30} />
      </Canvas>

      <LoadingOverlay />

      <div className="pointer-events-none absolute inset-0">
        <InfoPanel
          meta={selected}
          hidden={selectedId ? hiddenIds.has(selectedId) : false}
          onToggleVisible={() => selectedId && toggleVisible(selectedId)}
          onFocus={() => selectedId && apiRef.current?.focus(selectedId)}
          onClear={() => setSelectedId(null)}
          onShowAll={() => setHiddenIds(new Set())}
          hiddenCount={hiddenIds.size}
        />
      </div>
    </div>
  )
}
