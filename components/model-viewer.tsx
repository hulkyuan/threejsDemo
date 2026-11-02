'use client'

import React, { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bounds, Environment, OrbitControls, useGLTF, useProgress } from '@react-three/drei'
import * as THREE from 'three'

/* ===========================================================================
 * 代码内配置区（没有 UI 开关，直接改这里即可）
 * ========================================================================= */

const DEFAULT_MODEL_PATH = '/model.glb'

/** 结构树最多显示到第几层（第 1 层 = 模型最外层节点）。想只看 2 层就改成 2，想看 4 层就改成 4 */
const TREE_MAX_LEVEL = 3

/** 默认自动展开到第几层（节点层级 ≤ 该值时自动展开，其余手动点箭头） */
const TREE_DEFAULT_EXPAND_LEVEL = 1

/** 高亮配色的分组依据：按第几层节点分组。需求是「二级节点」，所以填 2 */
const COLOR_GROUP_LEVEL = 2

/**
 * 预置 10 个选中高亮色。
 * 规则：同一个二级节点下的零件选中后颜色一致；不同二级节点颜色不同；超过 10 组则循环复用。
 */
const SELECT_COLORS = [
  '#38bdf8', // 0 天空蓝
  '#f97316', // 1 橙
  '#22c55e', // 2 绿
  '#a855f7', // 3 紫
  '#ef4444', // 4 红
  '#eab308', // 5 黄
  '#06b6d4', // 6 青
  '#ec4899', // 7 粉
  '#84cc16', // 8 黄绿
  '#6366f1', // 9 靛蓝
]

const colorAt = (index: number) => SELECT_COLORS[index % SELECT_COLORS.length]

/* ===========================================================================
 * 类型
 * ========================================================================= */

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
  on?: string | null // 当前高亮色，null = 未高亮，undefined = 尚未初始化（强制首帧应用一次）
  chain: string[] // 自身 + 全部祖先节点 id（自身在前，根在后）
  color: string // 选中时使用的颜色（由所属二级节点决定）
}

export type PartMeta = {
  id: string
  name: string
  size: [number, number, number]
  triangles: number
  chain: string[]
  color: string
}

export type TreeNode = {
  id: string
  name: string
  depth: number // 第几层，从 1 开始
  parentId: string | null
  childIds: string[] // 直接子节点，已按 TREE_MAX_LEVEL 裁剪
  isMesh: boolean
  meshCount: number // 子树网格总数
  triangles: number // 子树三角面总数
  partCount: number // 子树「可爆炸零件」数量
  colorIndex: number | null // 该节点是否为配色分组（COLOR_GROUP_LEVEL 层）
  color: string | null
}

export type ModelTree = {
  nodes: TreeNode[] // DFS 先序：父节点一定排在子节点之前，可直接顺序遍历算继承关系
  roots: string[] // 第一层节点 id
  byId: Map<string, TreeNode>
  levelCounts: number[] // 下标 = 层级 - 1
  maxLevel: number
}

export type ModelData = {
  parts: PartMeta[]
  tree: ModelTree
}

export type ViewerApi = {
  focus: (id: string) => void
  measure: (id: string) => [number, number, number] | null
}

const tmpDelta = new THREE.Vector3()
const tmpTarget = new THREE.Vector3()

type OrbitLike = { target: THREE.Vector3; update: () => void; minDistance: number; maxDistance: number }

function countTriangles(root: THREE.Object3D): number {
  let total = 0
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry) return
    const g = m.geometry
    total += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3
  })
  return Math.round(total)
}

/**
 * 关键点：不能只改 emissive。
 * - MeshBasicMaterial（glTF 的 KHR_materials_unlit）没有 emissive，改了等于没改；
 * - 场景灯光很亮时 emissive 也不够醒目。
 * 所以直接改 color（真正"变成高亮色"），emissive 只作为附加辉光。
 * 颜色由外部传入：同一二级节点下一致，不同二级节点不同。
 */
function applyHighlight(part: Part, color: string | null) {
  if (part.on === color) return // 只在状态切换时写材质
  part.on = color
  part.materials.forEach((material, i) => {
    const b = part.backup[i]
    const m = material as THREE.MeshStandardMaterial

    // 1) 颜色：选中换成该分组的颜色，取消则还原（悬停不动颜色）
    if (color) m.color.set(color)
    else m.color.copy(b.color)

    // 2) 自发光：有就用，没有（Basic 材质）就跳过
    if (m.emissive) {
      if (color) {
        m.emissive.set(color)
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

/* ===========================================================================
 * 3D 模型：爆炸 + 选中高亮 + 整层/整枝显隐
 * ========================================================================= */

function ExplodingModel({
  progress,
  spread = 1,
  modelUrl,
  highlight,
  hiddenPartIds,
  hiddenNodeIds,
  onSelect,
  onHover,
  onModelLoaded,
  apiRef,
}: {
  progress: number
  spread?: number
  modelUrl: string
  highlight: Map<string, string> // 零件 id → 高亮色
  hiddenPartIds: Set<string> // 被隐藏的零件（含祖先被隐藏的）
  hiddenNodeIds: Set<string> // 实际被隐藏的结构树节点（含继承父级隐藏的）
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
  onModelLoaded: (data: ModelData) => void
  apiRef: React.MutableRefObject<ViewerApi | null>
}) {
  const { scene } = useGLTF(modelUrl)
  const progressRef = useRef(progress)
  progressRef.current = progress

  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null

  // 高亮/显隐同步在 useFrame 里做，用 ref 读取最新值，避免任何 effect 时序问题
  const highlightRef = useRef(highlight)
  const hiddenPartRef = useRef(hiddenPartIds)
  const hiddenNodeRef = useRef(hiddenNodeIds)
  const hoveredRef = useRef<string | null>(null)
  const appliedHiddenRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    highlightRef.current = highlight
    hiddenPartRef.current = hiddenPartIds
    hiddenNodeRef.current = hiddenNodeIds
  }, [highlight, hiddenPartIds, hiddenNodeIds])

  const model = useMemo(() => {
    scene.updateMatrixWorld(true)

    // 1) 爆炸中心 = 模型整体包围盒中心，并把它搬到原点（该操作是幂等的，重复执行无副作用）
    const bounds = new THREE.Box3().setFromObject(scene)
    const center = bounds.getCenter(new THREE.Vector3())
    const size = bounds.getSize(new THREE.Vector3())
    const radius = Math.max(size.length() * 0.5, 1e-4)
    scene.position.sub(center)
    scene.updateMatrixWorld(true)

    /* ---------------------------------------------------------------------
     * 2) 结构树：直接按 glTF 的节点层级生成，深度从 1 开始
     *    - childIds 会按 TREE_MAX_LEVEL 裁剪，超出层级的节点不再单独成行，
     *      但仍属于最近的可见祖先（隐藏祖先时它们一起隐藏）
     * ------------------------------------------------------------------- */
    const nodes: TreeNode[] = []
    const byId = new Map<string, TreeNode>()
    const objects = new Map<string, THREE.Object3D>()
    const depthOf = new Map<THREE.Object3D, number>()
    let anonymous = 0

    const walk = (obj: THREE.Object3D, depth: number, parentId: string | null): TreeNode => {
      const isMesh = (obj as THREE.Mesh).isMesh === true
      const rawName = (obj.name || '').trim()
      const node: TreeNode = {
        id: obj.uuid,
        name: rawName || `${isMesh ? '零件' : '组'} ${++anonymous}`,
        depth,
        parentId,
        childIds: [],
        isMesh,
        meshCount: isMesh ? 1 : 0,
        triangles: isMesh ? countTriangles(obj) : 0,
        partCount: 0,
        colorIndex: null,
        color: null,
      }
      nodes.push(node)
      byId.set(node.id, node)
      objects.set(node.id, obj)
      depthOf.set(obj, depth)

      for (const child of obj.children) {
        const c = walk(child, depth + 1, node.id)
        if (c.depth <= TREE_MAX_LEVEL) node.childIds.push(c.id) // 超过配置层级的不再展开成行
        node.meshCount += c.meshCount
        node.triangles += c.triangles
      }
      return node
    }

    const roots: string[] = []
    for (const child of scene.children) roots.push(walk(child, 1, null).id)

    const levelCounts: number[] = []
    for (const n of nodes) levelCounts[n.depth - 1] = (levelCounts[n.depth - 1] ?? 0) + 1

    // 3) 只移动「顶层」mesh，避免父子嵌套导致位移叠加漂移
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

    // 配色分组：按 COLOR_GROUP_LEVEL 层节点分组，出现的先后顺序决定颜色序号
    const colorIndex = new Map<string, number>()
    const colorIndexOf = (key: string) => {
      let i = colorIndex.get(key)
      if (i === undefined) {
        i = colorIndex.size
        colorIndex.set(key, i)
      }
      return i
    }

    const list: Part[] = meshes.map((mesh, i) => {
      // 4) 方向来自「零件自身的世界包围盒中心」，而不是节点原点
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

      // 5) 缓存父级世界矩阵的逆（只取旋转/缩放），位移换算不受父级实时变换影响
      const toLocal = new THREE.Matrix3()
      if (mesh.parent) toLocal.setFromMatrix4(mesh.parent.matrixWorld).invert()

      const cache = getMeshCache(mesh)

      // 6) 祖先链（自身 → 根），用于整层/整枝显隐与选中归属
      const chain: string[] = []
      let cur: THREE.Object3D | null = mesh
      while (cur) {
        if (depthOf.has(cur)) chain.push(cur.uuid)
        cur = cur.parent
      }

      // 7) 取链上第 COLOR_GROUP_LEVEL 层的祖先作为配色 key；
      //    模型不足该层级时退化为最外层祖先（一级节点）
      let colorKey = chain[0]
      for (let k = chain.length - 1; k >= 0; k--) {
        const n = byId.get(chain[k])
        if (n && n.depth === COLOR_GROUP_LEVEL) {
          colorKey = n.id
          break
        }
      }

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
        triangles: countTriangles(mesh),
        materials: cache.materials,
        backup: cache.backup,
        chain,
        color: colorAt(colorIndexOf(colorKey)),
        on: undefined, // 强制首帧应用一次
      }
    })

    // 把分组配色回写到对应节点，供结构树显示色点
    colorIndex.forEach((idx, id) => {
      const n = byId.get(id)
      if (n) {
        n.colorIndex = idx
        n.color = colorAt(idx)
      }
    })

    // 每个节点的「子树零件数」
    for (const p of list) {
      for (const id of p.chain) {
        const n = byId.get(id)
        if (n) n.partCount += 1
      }
    }

    // 任意子网格 → 顶层零件
    const map = new Map<THREE.Object3D, Part>()
    list.forEach((p) => p.object.traverse((o) => map.set(o, p)))

    const nodeItems = nodes.map((n) => ({ id: n.id, object: objects.get(n.id) as THREE.Object3D }))
    const tree: ModelTree = { nodes, roots, byId, levelCounts, maxLevel: TREE_MAX_LEVEL }

    return { parts: list, lookup: map, tree, nodeItems, objects }
  }, [scene])

  const { parts, lookup, tree, nodeItems, objects } = model

  // 零件元数据 + 结构树上报给外层面板
  const metas = useMemo<PartMeta[]>(
    () =>
      parts.map((p) => ({
        id: p.id,
        name: p.name,
        size: [p.size.x, p.size.y, p.size.z],
        triangles: p.triangles,
        chain: p.chain,
        color: p.color,
      })),
    [parts],
  )

  useEffect(() => {
    onModelLoaded({ parts: metas, tree })
  }, [metas, tree, onModelLoaded])

  const focusRef = useRef<{ target: THREE.Vector3; position: THREE.Vector3; minDistance: number } | null>(null)

  const boxOf = useCallback(
    (id: string) => {
      const obj = objects.get(id)
      if (!obj) return null
      scene.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(obj)
      return box.isEmpty() ? null : box
    },
    [objects, scene],
  )

  const focus = useCallback(
    (id: string) => {
      const box = boxOf(id)
      if (!box) return
      const center = box.getCenter(new THREE.Vector3())
      const r = Math.max(box.getSize(new THREE.Vector3()).length() * 1, 0.02) // 1 作为视角远近系数，越小离物体越近

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
    [boxOf, camera, controls],
  )

  const measure = useCallback(
    (id: string) => {
      const box = boxOf(id)
      if (!box) return null
      const s = box.getSize(new THREE.Vector3())
      return [s.x, s.y, s.z] as [number, number, number]
    },
    [boxOf],
  )

  useEffect(() => {
    apiRef.current = { focus, measure }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, focus, measure])

  const pick = useCallback(
    (e: ThreeEvent<PointerEvent | MouseEvent>) => {
      const part = lookup.get(e.object)
      // three 的 Raycaster 不会检查 visible，隐藏的零件要手动过滤
      if (!part || hiddenPartRef.current.has(part.id)) return null
      return part
    },
    [lookup],
  )

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      const part = pick(e)
      if (!part) return
      e.stopPropagation()
      // 再点一次同一个零件就取消选中（父级 handleSelect 里做幂等判断）
      onSelect(part.id)
    },
    [pick, onSelect],
  )

  // 悬停只用于「鼠标指针变成小手」，不会改变零件颜色
  const handleMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const part = pick(e)
      const id = part ? part.id : null
      if (id !== hoveredRef.current) {
        hoveredRef.current = id
        onHover(id)
      }
    },
    [pick, onHover],
  )

  const handleOut = useCallback(() => {
    hoveredRef.current = null
    onHover(null)
  }, [onHover])

  // 换了模型要强制重新写一遍节点可见性
  useEffect(() => {
    appliedHiddenRef.current = null
  }, [model])

  useFrame(() => {
    const t = progressRef.current
    const hl = highlightRef.current
    const hiddenParts = hiddenPartRef.current
    const hiddenNodes = hiddenNodeRef.current

    for (const part of parts) {
      // 高亮：只有「选中」才变色，颜色按二级节点分组；悬停不改颜色
      applyHighlight(part, hl.get(part.id) ?? null)

      // 零件自身的可见性（整体由节点可见性控制，这里仅兜底）
      const visible = !hiddenParts.has(part.id)
      if (part.object.visible !== visible) part.object.visible = visible

      // 爆炸位移
      tmpDelta.copy(part.axis).multiplyScalar(part.distance * t * spread).applyMatrix3(part.toLocal)
      tmpTarget.copy(part.home).add(tmpDelta)
      part.object.position.lerp(tmpTarget, 0.16) // 想严格跟随滑杆就改成 copy(tmpTarget)
    }

    // 结构树节点显隐：父节点隐藏时，three 会自动隐藏整棵子树，所以只需写每个节点自己的 visible
    // 集合是父级 useMemo 出来的新对象，用引用比较避免每帧遍历
    if (appliedHiddenRef.current !== hiddenNodes) {
      appliedHiddenRef.current = hiddenNodes
      for (const item of nodeItems) {
        const v = !hiddenNodes.has(item.id)
        if (item.object.visible !== v) item.object.visible = v
      }
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

/* ===========================================================================
 * 图标
 * ========================================================================= */

function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.7" />
      {off && <path d="M4 20 20 4" />}
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}

/* ===========================================================================
 * 结构树面板
 * ========================================================================= */

type TreeRowProps = {
  tree: ModelTree
  hiddenNodes: Set<string>
  selectedId: string | null
  isExpanded: (node: TreeNode) => boolean
  onToggleExpand: (id: string) => void
  onSelect: (id: string) => void
  onToggleNode: (id: string) => void
}

function TreeRows({
  tree,
  parentId,
  hiddenNodes,
  selectedId,
  isExpanded,
  onToggleExpand,
  onSelect,
  onToggleNode,
}: TreeRowProps & { parentId: string | null }) {
  const ids = parentId ? (tree.byId.get(parentId)?.childIds ?? []) : tree.roots

  return (
    <>
      {ids.map((id) => {
        const node = tree.byId.get(id)
        if (!node) return null

        const expandable = node.childIds.length > 0
        const open = expandable && isExpanded(node)
        const hidden = hiddenNodes.has(node.id)
        const active = selectedId === node.id

        return (
          <Fragment key={node.id}>
            <div
              className={`flex items-center gap-1 rounded-md py-[3px] pr-1 ${
                active ? 'bg-sky-500/15' : 'hover:bg-white/5'
              }`}
              style={{ paddingLeft: (node.depth - 1) * 12 + 2 }}
            >
              {expandable ? (
                <button
                  onClick={() => onToggleExpand(node.id)}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded text-slate-500 transition hover:bg-white/10 hover:text-slate-200"
                  title={open ? '折叠' : '展开'}
                >
                  <ChevronIcon open={open} />
                </button>
              ) : (
                <span className="h-4 w-4 shrink-0" />
              )}

              <button
                onClick={() => onSelect(node.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                title={node.name}
              >
                {node.color && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full ring-1 ring-white/25"
                    style={{ background: node.color }}
                    title={`选中色 ${node.color}`}
                  />
                )}
                <span
                  className={`truncate text-[13px] ${
                    active ? 'text-sky-300' : hidden ? 'text-slate-500 line-through' : 'text-slate-200'
                  }`}
                >
                  {node.name}
                </span>
                <span className="shrink-0 text-[10px] text-slate-500">{node.meshCount}</span>
              </button>

              <button
                onClick={() => onToggleNode(node.id)}
                className={`shrink-0 rounded p-1 transition ${
                  hidden ? 'text-amber-300/90 hover:bg-white/10' : 'text-slate-500 hover:bg-white/10 hover:text-slate-200'
                }`}
                title={hidden ? '显示该节点' : '隐藏该节点'}
              >
                <EyeIcon off={hidden} />
              </button>
            </div>

            {open && (
              <TreeRows
                tree={tree}
                parentId={node.id}
                hiddenNodes={hiddenNodes}
                selectedId={selectedId}
                isExpanded={isExpanded}
                onToggleExpand={onToggleExpand}
                onSelect={onSelect}
                onToggleNode={onToggleNode}
              />
            )}
          </Fragment>
        )
      })}
    </>
  )
}

function StructurePanel({
  tree,
  hiddenNodes,
  hiddenLevels,
  hiddenPartCount,
  selectedId,
  isExpanded,
  onToggleExpand,
  onSelect,
  onToggleNode,
  onToggleLevel,
  onShowAll,
}: {
  tree: ModelTree
  hiddenNodes: Set<string>
  hiddenLevels: Set<number>
  hiddenPartCount: number
  selectedId: string | null
  isExpanded: (node: TreeNode) => boolean
  onToggleExpand: (id: string) => void
  onSelect: (id: string) => void
  onToggleNode: (id: string) => void
  onToggleLevel: (level: number) => void
  onShowAll: () => void
}) {
  const levels = useMemo(() => Array.from({ length: tree.maxLevel }, (_, i) => i + 1), [tree.maxLevel])

  return (
    <div className="pointer-events-auto absolute left-4 top-4 flex max-h-[calc(100%-2rem)] w-80 flex-col rounded-xl border border-white/10 bg-slate-900/80 p-3 text-sm text-slate-200 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="font-medium">模型结构</div>
        <div className="text-[11px] text-slate-500">
          {tree.nodes.length} 节点 · 显示 {tree.maxLevel} 层
        </div>
      </div>

      {/* 整层显示 / 隐藏 */}
      <div className="mb-2 flex flex-wrap items-center gap-1 border-b border-white/10 pb-2">
        {levels.map((lv) => {
          const off = hiddenLevels.has(lv)
          return (
            <button
              key={lv}
              onClick={() => onToggleLevel(lv)}
              title={`${off ? '显示' : '隐藏'}第 ${lv} 层的全部节点`}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition ${
                off
                  ? 'border-amber-400/40 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20'
                  : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
              }`}
            >
              <EyeIcon off={off} />
              第 {lv} 层 · {tree.levelCounts[lv - 1] ?? 0}
            </button>
          )
        })}
        {hiddenPartCount > 0 && (
          <button
            onClick={onShowAll}
            className="ml-auto rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300 transition hover:bg-white/10"
          >
            全部显示
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tree.roots.length === 0 ? (
          <div className="px-1 py-2 text-xs text-slate-500">模型没有可展示的节点</div>
        ) : (
          <TreeRows
            tree={tree}
            parentId={null}
            hiddenNodes={hiddenNodes}
            selectedId={selectedId}
            isExpanded={isExpanded}
            onToggleExpand={onToggleExpand}
            onSelect={onSelect}
            onToggleNode={onToggleNode}
          />
        )}
      </div>

      {/* <div className="mt-2 border-t border-white/10 pt-2 text-[11px] text-slate-500">
        选中色按第 {COLOR_GROUP_LEVEL} 层节点分组（{SELECT_COLORS.length} 色循环）
      </div> */}
    </div>
  )
}

/* ===========================================================================
 * 其它 UI
 * ========================================================================= */

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
              color={active ? colorAt(index) : index % 2 ? '#38bdf8' : '#dbeafe'}
              emissive={active ? colorAt(index) : '#000000'}
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

type SelectionInfo = {
  id: string
  name: string
  level: number
  meshCount: number
  triangles: number
  partCount: number
  size: [number, number, number] | null
  color: string | null
}

function InfoPanel({
  info,
  hidden,
  onToggleVisible,
  onFocus,
  onClear,
  onShowAll,
  hiddenCount,
}: {
  info: SelectionInfo | null
  hidden: boolean
  onToggleVisible: () => void
  onFocus: () => void
  onClear: () => void
  onShowAll: () => void
  hiddenCount: number
}) {
  return (
    <div className="pointer-events-auto absolute right-4 top-4 w-72 rounded-xl border border-white/10 bg-slate-900/80 p-4 text-sm text-slate-200 shadow-2xl backdrop-blur">
      {!info ? (
        <div className="text-slate-400">
          <div className="mb-1 font-medium text-slate-200">节点信息</div>
          <div>点击模型或左侧结构树的任意节点查看详情</div>
          {hiddenCount > 0 && (
            <button
              onClick={onShowAll}
              className="mt-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-slate-200 transition hover:bg-white/10"
            >
              全部显示（已隐藏 {hiddenCount} 个零件）
            </button>
          )}
        </div>
      ) : (
        <div>
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="mb-0.5 text-xs uppercase tracking-wide text-slate-500">当前选中 · 第 {info.level} 层</div>
              <div className="flex items-center gap-1.5">
                {info.color && (
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/25" style={{ background: info.color }} />
                )}
                <div className="truncate text-base font-semibold text-sky-300" title={info.name}>
                  {info.name}
                </div>
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
              <dd className="text-slate-200">
                {info.size ? info.size.map((n) => n.toFixed(2)).join(' × ') : '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>网格数</dt>
              <dd className="text-slate-200">{info.meshCount.toLocaleString()}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>三角面数</dt>
              <dd className="text-slate-200">{info.triangles.toLocaleString()}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>包含零件</dt>
              <dd className="text-slate-200">{info.partCount.toLocaleString()}</dd>
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

/* ===========================================================================
 * 对外组件
 * ========================================================================= */

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
  const [tree, setTree] = useState<ModelTree | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [hiddenNodeIds, setHiddenNodeIds] = useState<Set<string>>(() => new Set()) // 手动隐藏的节点
  const [hiddenLevels, setHiddenLevels] = useState<Set<number>>(() => new Set()) // 整层隐藏
  const [expandOverride, setExpandOverride] = useState<Record<string, boolean>>({})
  const [selectedSize, setSelectedSize] = useState<[number, number, number] | null>(null)
  const apiRef = useRef<ViewerApi | null>(null)

  const onModelLoaded = useCallback((data: ModelData) => {
    setParts(data.parts)
    setTree(data.tree)
    setSelectedId(null)
    setHiddenNodeIds(new Set())
    setHiddenLevels(new Set())
    setExpandOverride({})
    setSelectedSize(null)
  }, [])

  /* ---- 派生状态 ---- */

  // 实际被隐藏的节点：整层隐藏 / 手动隐藏 / 祖先被隐藏
  const hiddenNodes = useMemo(() => {
    const set = new Set<string>()
    if (!tree) return set
    for (const node of tree.nodes) {
      // nodes 是 DFS 先序，父节点一定先算完
      if (hiddenLevels.has(node.depth) || hiddenNodeIds.has(node.id) || (node.parentId && set.has(node.parentId))) {
        set.add(node.id)
      }
    }
    return set
  }, [tree, hiddenLevels, hiddenNodeIds])

  // 被隐藏的零件：祖先链上任意节点被隐藏即隐藏
  const hiddenPartIds = useMemo(() => {
    const set = new Set<string>()
    for (const p of parts) {
      if (p.chain.some((id) => hiddenNodes.has(id))) set.add(p.id)
    }
    return set
  }, [parts, hiddenNodes])

  // 选中节点 → 其下所有零件的高亮色（颜色由各自的二级节点决定）
  const highlight = useMemo(() => {
    const map = new Map<string, string>()
    if (!selectedId) return map
    for (const p of parts) {
      if (p.chain.includes(selectedId)) map.set(p.id, p.color)
    }
    return map
  }, [parts, selectedId])

  const selectedNode = useMemo(() => (selectedId && tree ? tree.byId.get(selectedId) ?? null : null), [selectedId, tree])

  const selectionInfo = useMemo<SelectionInfo | null>(() => {
    if (!selectedNode) return null
    return {
      id: selectedNode.id,
      name: selectedNode.name,
      level: selectedNode.depth,
      meshCount: selectedNode.meshCount,
      triangles: selectedNode.triangles,
      partCount: selectedNode.partCount,
      size: selectedSize,
      color: selectedNode.color ?? highlight.values().next().value ?? null,
    }
  }, [selectedNode, selectedSize, highlight])

  // 选中变化时量一次包围盒尺寸
  useEffect(() => {
    if (!selectedId || !tree) {
      setSelectedSize(null)
      return
    }
    setSelectedSize(apiRef.current?.measure(selectedId) ?? null)
  }, [selectedId, tree])

  /* ---- 交互 ---- */

  const toggleNodeVisible = useCallback((id: string) => {
    setHiddenNodeIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleLevel = useCallback((level: number) => {
    setHiddenLevels((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }, [])

  const showAll = useCallback(() => {
    setHiddenNodeIds(new Set())
    setHiddenLevels(new Set())
  }, [])

  const toggleExpand = useCallback(
    (id: string) => {
      const node = tree?.byId.get(id)
      const current = node ? (expandOverride[id] ?? node.depth <= TREE_DEFAULT_EXPAND_LEVEL) : false
      setExpandOverride((prev) => ({ ...prev, [id]: !current }))
    },
    [tree, expandOverride],
  )

  const isExpanded = useCallback(
    (node: TreeNode) => expandOverride[node.id] ?? node.depth <= TREE_DEFAULT_EXPAND_LEVEL,
    [expandOverride],
  )

  const handleSelect = useCallback((id: string | null) => {
    setSelectedId((prev) => (id && id === prev ? null : id))
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
            <ModelErrorBoundary selectedId={selectedId} onSelect={handleSelect}>
              <ExplodingModel
                progress={progress}
                spread={spread}
                modelUrl={modelUrl}
                highlight={highlight}
                hiddenPartIds={hiddenPartIds}
                hiddenNodeIds={hiddenNodes}
                onSelect={handleSelect}
                onHover={setHoveredId}
                onModelLoaded={onModelLoaded}
                apiRef={apiRef}
              />
            </ModelErrorBoundary>
          </Bounds>
        </Suspense>
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={0.2} maxDistance={30} />
      </Canvas>

      <LoadingOverlay />

      <div className="pointer-events-none absolute inset-0">
        {tree && (
          <StructurePanel
            tree={tree}
            hiddenNodes={hiddenNodes}
            hiddenLevels={hiddenLevels}
            hiddenPartCount={hiddenPartIds.size}
            selectedId={selectedId}
            isExpanded={isExpanded}
            onToggleExpand={toggleExpand}
            onSelect={handleSelect}
            onToggleNode={toggleNodeVisible}
            onToggleLevel={toggleLevel}
            onShowAll={showAll}
          />
        )}

        <InfoPanel
          info={selectionInfo}
          hidden={selectedId ? hiddenNodes.has(selectedId) : false}
          onToggleVisible={() => selectedId && toggleNodeVisible(selectedId)}
          onFocus={() => selectedId && apiRef.current?.focus(selectedId)}
          onClear={() => setSelectedId(null)}
          onShowAll={showAll}
          hiddenCount={hiddenPartIds.size}
        />
      </div>
    </div>
  )
}
