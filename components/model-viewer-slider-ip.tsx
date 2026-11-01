'use client'

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bounds, Environment, OrbitControls, useGLTF, useProgress } from '@react-three/drei'
import * as THREE from 'three'

const DEFAULT_MODEL_PATH = '/model.glb'
const SELECT_COLOR = '#38bdf8' // 天空蓝：选中（悬停不改色，只切换鼠标指针形状）

/* ------------------------------------------------------------------ *
 * 门扇白名单：把模型里「左门扇」「右门扇」的节点名填进来即可
 * ------------------------------------------------------------------ */

/**
 * 左门扇的名字列表。名字 = glTF 节点名（通常就是 Blender / 建模软件里的对象名）。
 *
 * 匹配规则：不区分大小写，忽略空格 / 下划线 / 连字符 / 点；
 * 先精确匹配，再退化为「零件名包含关键字」，还支持通配符 '门扇_L*'。
 *
 * ★ 一樘门常常由「门框 + 玻璃 + 门板 + 门扇附件」等多个 mesh 组成，
 *   这种情况下白名单里填它们**共同的父节点名**即可，代码会把这一组零件
 *   全部收进来并作为一扇门整体平移。
 *
 * 两个数组按【索引一一对应】配对：LEFT[0] ↔ RIGHT[0] 是同一樘门的两扇。
 * 填了白名单就完全按白名单走，几何推断不再参与。
 *
 * 不知道名字？运行后点面板上的「打印零件名」，或看控制台的
 * __MODEL_VIEWER_PARTS__，直接复制粘贴过来即可。
 */
export const LEFT_DOOR_NAMES: string[] = [
  // '门扇_L_01',
  // '滑动门左',
]

/** 右门扇的名字列表，与 LEFT_DOOR_NAMES 索引一一对应 */
export const RIGHT_DOOR_NAMES: string[] = [
  // '门扇_R_01',
  // '滑动门右',
]

/** 滑动轴：'auto' = 按门扇包围盒自动推断（高 > 宽 > 厚 里的「宽」）；不准就手动指定 */
export type SlideAxis = 'auto' | 'x' | 'y' | 'z'
export const DOOR_SLIDE_AXIS: SlideAxis = 'auto'

/** 行程 = 门扇宽度 × 该比例；0.95 = 留一点余量，避免两扇完全重叠时 Z-fighting 闪烁 */
export const DOOR_TRAVEL_RATIO = 0.95

type Backup = {
  color: THREE.Color
  emissive: THREE.Color | null
  emissiveIntensity: number
}

/** 门扇配置：沿 axisLocal 平移 travel 即为「完全打开」 */
type DoorConfig = {
  axisLocal: THREE.Vector3 // 开门方向（父级局部空间，单位向量）
  travel: number // 行程（通常 = 门扇宽度）
  groupId: number // 所属对开组
}

type Part = {
  id: string
  name: string
  aliases: string[] // 白名单匹配用的名字候选：自身名 + 各级父节点名
  object: THREE.Object3D
  home: THREE.Vector3 // 原始「局部」坐标，复位基准
  axis: THREE.Vector3 // 单位爆炸方向（世界空间）
  toLocal: THREE.Matrix3 // 世界位移 → 父级局部位移
  distance: number
  center: THREE.Vector3 // 零件中心（模型空间，原点 = 模型中心）
  size: THREE.Vector3
  door: DoorConfig | null
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

export type DoorStats = {
  groups: number // 对开组数
  doors: number // 参与开门的零件数
  candidates: number // 薄板候选数（仅几何推断模式下有意义）
  doorIds: string[] // 当前所有门扇 id（面板据此判定按钮文案）
  source: 'whitelist' | 'auto' // 门扇来源：白名单 / 几何推断
  matched: number // 白名单命中的「樘数」（项数）
  unmatched: { input: string; suggest: string | null; duplicate?: boolean }[] // 白名单里没匹配上的名字 + 最相似的零件名
  doorNames: { id: string; name: string; side: 'L' | 'R' | '-'; group: number }[] // 命中明细
}

export type ViewerApi = {
  focus: (id: string) => void
  markDoor: (id: string) => void // 手动把某个零件设为/取消门扇（兜底）
  clearDoors: () => void
  printNames: () => void // 把所有零件名打到控制台，方便填白名单
}

/** 白名单配置 */
export type DoorWhitelist = {
  left: string[]
  right: string[]
  axis: SlideAxis
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

/* ------------------------------------------------------------------ *
 * 门扇识别
 *   1) 白名单（优先）：按名字精确指定左/右门扇 —— 最可靠
 *   2) 几何推断（兜底）：白名单为空时，靠「薄板 + 紧邻配对」猜
 *   3) 手动标记（最后手段）：面板上点选某个零件强行设为门扇
 * ------------------------------------------------------------------ */

const AXES = ['x', 'y', 'z'] as const

/** 手动覆盖：按 mesh.uuid 记录（模块级，避免 StrictMode 重算丢失） */
const doorOverride = new Map<string, boolean>()

/**
 * 名字归一化：去掉空格/下划线/连字符/点，再转小写。
 * 这样「滑动门 左」「滑动门_左」「滑动门-左」「Sliding Door L」这类写法都能对上，
 * 手写白名单时不用纠结分隔符和大小写。
 */
function normalizeName(s: string) {
  return s.replace(/[\s_\-.]+/g, '').toLowerCase()
}

/**
 * 按名字找零件，**可能一次找到多个** —— 一樘门常由「门框 + 玻璃 + 门板 + 门扇附件」
 * 等多个 mesh 组成，白名单里填它们共同的父节点名，就能一次把这樘门的全部零件收进来，
 * 它们会作为一组一起平移（看起来就是一整扇门在动）。
 *
 * 三级匹配，命中即停：
 *   1) 精确相等（自身名或任一父级名）—— 多命中时全部返回
 *   2) 零件名包含关键字（关键字 ≥2 字）
 *   3) 关键字包含零件名（零件名 ≥4 字，且排除纯数字前缀关系，避免 Object_1 误配 Object_12）
 *
 * 另外支持通配符：'门扇_L*' 会匹配所有归一化后以「门扇l」开头的名字。
 * 已被占用的零件会跳过，防止两个白名单项抢同一个 mesh。
 */
function findPartsByName(parts: Part[], raw: string, taken: Set<string>): Part[] {
  const key = normalizeName(raw)
  if (!key) return []
  const pool = parts.filter((p) => !taken.has(p.id))

  // 0) 通配符
  if (key.includes('*')) {
    const pattern = key
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    const rx = new RegExp('^' + pattern + '$')
    return pool.filter((p) => p.aliases.some((a) => rx.test(normalizeName(a))))
  }

  // 1) 精确相等
  const exact = pool.filter((p) => p.aliases.some((a) => normalizeName(a) === key))
  if (exact.length) return exact

  // 2) 零件名包含关键字
  if (key.length >= 2) {
    const contains = pool.filter((p) => p.aliases.some((a) => normalizeName(a).includes(key)))
    if (contains.length) return contains
  }

  // 3) 关键字包含零件名
  return pool.filter((p) =>
    p.aliases.some((a) => {
      const n = normalizeName(a)
      if (n.length < 4 || !key.includes(n)) return false
      // 前缀关系（Object_1 vs Object_12）极易误配，排除
      const rest = key.slice(n.length)
      return !/^\d/.test(rest)
    }),
  )
}

/** 白名单填错时的纠错提示：按最长公共子串比例挑最像的零件名（跳过已被占用的） */
function suggestName(parts: Part[], raw: string, taken?: Set<string>): string | null {
  const key = normalizeName(raw)
  if (!key) return null
  let best: { name: string; score: number } | null = null
  for (const p of parts) {
    if (taken && taken.has(p.id)) continue
    const n = normalizeName(p.name)
    let score = 0
    for (let i = 0; i < n.length; i++) {
      for (let j = i + 1; j <= n.length; j++) {
        const sub = n.slice(i, j)
        if (key.includes(sub) && sub.length > score) score = sub.length
      }
    }
    score = score / Math.max(n.length, key.length)
    if (!best || score > best.score) best = { name: p.name, score }
  }
  return best && best.score >= 0.3 ? best.name : null
}

/** 滑动轴：手动指定优先，否则取包围盒「中间那根」（屏蔽门 高 > 宽 > 厚） */
function resolveSlideAxis(part: Part, axis: SlideAxis): 'x' | 'y' | 'z' {
  if (axis !== 'auto') return axis
  return AXES[boardProfile(part.size).widthIdx]
}

/**
 * 一组零件（同一樘门的多个部件）在某轴上的中心：取各零件中心的平均
 */
function groupCenter(group: Part[], w: 'x' | 'y' | 'z') {
  return group.reduce((s, p) => s + p.center[w], 0) / group.length
}

/**
 * 一组零件在某轴上的宽度：取最大值
 * （门框 / 玻璃 / 门板 通常同宽，取最大值最接近真实门宽，行程才不会偏小）
 */
function groupWidth(group: Part[], w: 'x' | 'y' | 'z') {
  return group.reduce((m, p) => Math.max(m, p.size[w]), 0)
}

/**
 * 写入开门运动：沿世界轴 w 走 sign 方向，行程 travel。
 * 注意不能 normalize —— 世界方向经父级矩阵逆变换后，长度会随父级缩放变化，
 * 保持原长度才能让「世界空间实际位移 == travel」。
 */
function applyDoorMotion(
  part: Part,
  w: 'x' | 'y' | 'z',
  sign: number,
  travel: number,
  groupId: number,
) {
  const dir = new THREE.Vector3()
  dir[w] = sign
  part.door = { axisLocal: dir.applyMatrix3(part.toLocal), travel, groupId }
}

/** 薄板判定 + 取出「厚度轴 / 宽度轴(滑动方向) / 高度轴」 */
function boardProfile(size: THREE.Vector3) {
  const arr = [size.x, size.y, size.z]
  const sorted = [0, 1, 2].sort((a, b) => arr[a] - arr[b])
  const thinIdx = sorted[0]
  const widthIdx = sorted[1] // 门宽：中间那根（屏蔽门 高 > 宽 > 厚）
  const heightIdx = sorted[2]
  const ratio = arr[widthIdx] > 1e-6 ? arr[thinIdx] / arr[widthIdx] : 1
  return { arr, thinIdx, widthIdx, heightIdx, ratio }
}

/** 给单个零件按「薄板」推断开门方向：往远离模型中心的一侧滑 */
function assignSingleDoor(part: Part, ratio: number, groupId: number) {
  const p = boardProfile(part.size)
  const key = AXES[p.widthIdx]
  const dir = new THREE.Vector3()
  dir[key] = Math.sign(part.center[key]) || 1
  part.door = {
    axisLocal: dir.applyMatrix3(part.toLocal),
    travel: p.arr[p.widthIdx] * ratio,
    groupId,
  }
}

/**
 * 【兜底】几何推断「对开滑动门」：
 *  1) 先筛薄板候选（厚度 < 宽度的 1/4，排除立柱、顶箱、门框这类块状件）
 *  2) 再两两配对：尺寸相近 + 沿宽度轴紧邻 + 高度对齐 + 在同一平面
 *  3) 方向 = 相对配对中心朝外（左扇往左、右扇往右），行程 = 门扇宽度
 * 只在白名单为空 / 一个都没命中时使用。
 */
function autoDetectDoors(parts: Part[], travelRatio: number) {
  const profiles = parts.map((part) => ({ part, ...boardProfile(part.size) }))
  const candidates = profiles.filter((m) => m.ratio < 0.25)

  // 先收集所有满足条件的候选配对
  type Pair = { a: (typeof candidates)[number]; b: (typeof candidates)[number]; gapDiff: number }
  const pairs: Pair[] = []

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]

      // 尺寸相近（各轴相对差 < 12%）——排除固定门、立柱等不同规格的件
      let sizeOk = true
      for (let k = 0; k < 3; k++) {
        const ref = Math.max(a.arr[k], b.arr[k])
        if (ref > 1e-6 && Math.abs(a.arr[k] - b.arr[k]) / ref > 0.12) {
          sizeOk = false
          break
        }
      }
      if (!sizeOk) continue

      const w = AXES[a.widthIdx]
      const h = AXES[a.heightIdx]
      const t = AXES[a.thinIdx]

      // 沿宽度轴紧邻：对开门之间只有胶条缝隙，比例极接近 1；固定门之间还隔着立柱，比例明显更大
      const gap = Math.abs(b.part.center[w] - a.part.center[w])
      const expect = (a.arr[a.widthIdx] + b.arr[b.widthIdx]) / 2
      const ratioToExpect = gap / expect
      if (ratioToExpect < 0.85 || ratioToExpect > 1.15) continue

      // 高度对齐、厚度方向基本在同一平面
      if (Math.abs(a.part.center[h] - b.part.center[h]) > a.arr[a.heightIdx] * 0.2) continue
      if (Math.abs(a.part.center[t] - b.part.center[t]) > Math.max(a.arr[a.thinIdx] * 3, 0.02)) continue

      pairs.push({ a, b, gapDiff: Math.abs(gap - expect) })
    }
  }

  // 关键：按「紧邻程度」排序后占用，真正的对开门缝隙最小，会优先配对成功，
  // 避免固定门抢先把滑动门配走
  pairs.sort((p, q) => p.gapDiff - q.gapDiff)

  const used = new Set<string>()
  const groups: { memberIds: string[] }[] = []

  for (const { a, b } of pairs) {
    if (used.has(a.part.id) || used.has(b.part.id)) continue
    used.add(a.part.id)
    used.add(b.part.id)

    const w = AXES[a.widthIdx]
    const mid = (a.part.center[w] + b.part.center[w]) / 2
    const travel = ((a.arr[a.widthIdx] + b.arr[b.widthIdx]) / 2) * travelRatio
    const groupId = groups.length

    // 方向：相对配对中心朝外（左扇往左、右扇往右），行程 = 门扇宽度
    for (const m of [a, b]) {
      const dir = new THREE.Vector3()
      dir[w] = Math.sign(m.part.center[w] - mid) || 1
      m.part.door = { axisLocal: dir.applyMatrix3(m.part.toLocal), travel, groupId }
    }
    groups.push({ memberIds: [a.part.id, b.part.id] })
  }

  return {
    groups: groups.length,
    candidates: candidates.length,
    debug: groups.map((g) => g.memberIds),
  }
}

/**
 * 门扇总入口：白名单优先 → 几何推断兜底 → 手动覆盖最终裁决。
 */
function analyzeDoors(
  parts: Part[],
  opts: { travelRatio: number; whitelist: DoorWhitelist },
): DoorStats {
  const { travelRatio } = opts
  const { left, right, axis } = opts.whitelist

  // Part 对象是复用的（同一份 scene），每次重算必须先清空上一次的结果
  parts.forEach((p) => {
    p.door = null
  })

  const unmatched: DoorStats['unmatched'] = []
  const taken = new Set<string>()
  let sideGroup = new Map<string, { side: 'L' | 'R' | '-'; group: number }>()

  /**
   * 按白名单顺序解析出零件；保持索引位置（没匹配到就用 null 占位，不影响配对）。
   * 每个白名单项可能命中多个零件 —— 那是「同一樘门的不同部件」，会作为一组一起动。
   */
  const resolve = (names: string[], side: 'L' | 'R') =>
    names.map((raw): Part[] | null => {
      if (!raw || !raw.trim()) return null
      const found = findPartsByName(parts, raw, taken)
      if (!found.length) {
        // 区分两种失败：填错了（给相似名建议） vs 重复填写（该零件已被前面的项占用）
        const dup = findPartsByName(parts, raw, new Set())
        unmatched.push({
          input: raw,
          suggest: dup[0]?.name ?? suggestName(parts, raw, taken),
          duplicate: dup.length > 0,
        })
        return null
      }
      found.forEach((p) => {
        taken.add(p.id) // 防止两个白名单项抢同一个 mesh
        sideGroup.set(p.id, { side, group: -1 })
      })
      return found
    })

  const L = resolve(left, 'L')
  const R = resolve(right, 'R')
  const matched = L.filter(Boolean).length + R.filter(Boolean).length

  let groups = 0

  // 索引一一配对：L[i] ↔ R[i] 是同一樘门的两扇
  for (let i = 0; i < Math.max(L.length, R.length); i++) {
    const a = L[i]
    const b = R[i]

    if (a && b) {
      const w = resolveSlideAxis(a[0], axis)
      // 以两樘的中点为界，各自朝外滑（几何算方向，哪怕左右填反了也是朝外开）
      const ca = groupCenter(a, w)
      const cb = groupCenter(b, w)
      const mid = (ca + cb) / 2
      const travel = ((groupWidth(a, w) + groupWidth(b, w)) / 2) * travelRatio
      const gid = groups++
      a.forEach((p) => applyDoorMotion(p, w, Math.sign(ca - mid) || -1, travel, gid))
      b.forEach((p) => applyDoorMotion(p, w, Math.sign(cb - mid) || 1, travel, gid))
      a.forEach((p) => sideGroup.set(p.id, { side: 'L', group: gid }))
      b.forEach((p) => sideGroup.set(p.id, { side: 'R', group: gid }))
    } else {
      // 只有一侧：直接按侧别决定正负（左扇往轴负向、右扇往轴正向）
      for (const item of [
        { parts: a, side: 'L' as const },
        { parts: b, side: 'R' as const },
      ]) {
        if (!item.parts) continue
        const w = resolveSlideAxis(item.parts[0], axis)
        const travel = groupWidth(item.parts, w) * travelRatio
        item.parts.forEach((p) => applyDoorMotion(p, w, item.side === 'L' ? -1 : 1, travel, -1))
      }
    }
  }

  const useWhitelist = (left.length > 0 || right.length > 0) && matched > 0
  const source: DoorStats['source'] = useWhitelist ? 'whitelist' : 'auto'
  let candidates = 0

  if (!useWhitelist) {
    // 白名单为空或全没命中 → 回退几何推断
    groups = 0
    sideGroup = new Map()
    const auto = autoDetectDoors(parts, travelRatio)
    groups = auto.groups
    candidates = auto.candidates
    auto.debug.forEach((ids, gid) => {
      ids.forEach((id) => sideGroup.set(id, { side: '-', group: gid }))
    })
  }

  // 手动覆盖优先级最高（面板上点选指定）
  doorOverride.forEach((isDoor, id) => {
    const part = parts.find((p) => p.id === id)
    if (!part) return
    if (isDoor) {
      if (!part.door) assignSingleDoor(part, travelRatio, -1)
      if (!sideGroup.has(id)) sideGroup.set(id, { side: '-', group: -1 })
    } else {
      part.door = null
      sideGroup.delete(id)
    }
  })

  const doorIds = parts.filter((p) => p.door).map((p) => p.id)

  return {
    groups,
    doors: doorIds.length,
    candidates,
    doorIds,
    source,
    matched,
    unmatched,
    doorNames: doorIds.map((id) => {
      const part = parts.find((p) => p.id === id)!
      const meta = sideGroup.get(id)
      return {
        id,
        name: part.name,
        side: meta?.side ?? '-',
        group: part.door?.groupId ?? -1,
      }
    }),
  }
}

function ExplodingModel({
  progress,
  spread = 1,
  openness = 0,
  travelRatio = DOOR_TRAVEL_RATIO,
  leftDoorNames = LEFT_DOOR_NAMES,
  rightDoorNames = RIGHT_DOOR_NAMES,
  slideAxis = DOOR_SLIDE_AXIS,
  modelUrl,
  selectedId,
  hoveredId,
  hiddenIds,
  onSelect,
  onHover,
  onPartsLoaded,
  onDoorStats,
  apiRef,
}: {
  progress: number
  spread?: number
  openness?: number // 开门目标进度 0~1（内部会平滑逼近）
  travelRatio?: number // 行程相对门扇宽度的比例
  leftDoorNames?: string[] // 左门扇名字白名单
  rightDoorNames?: string[] // 右门扇名字白名单（与左门索引一一对应）
  slideAxis?: SlideAxis // 滑动轴，'auto' = 按包围盒推断
  modelUrl: string
  selectedId: string | null
  hoveredId: string | null
  hiddenIds: Set<string>
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
  onPartsLoaded: (parts: PartMeta[]) => void
  onDoorStats: (stats: DoorStats) => void
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

  // 开门：openness 是「目标值」，openRef 是「当前值」，每帧逼近 → 得到平滑的开/关门动画
  const openTargetRef = useRef(openness)
  const openRef = useRef(0)
  useEffect(() => {
    openTargetRef.current = openness
  }, [openness])

  // 白名单：用 useMemo 包一层，避免父级传字面量数组时每次渲染都重算整个场景
  const whitelist = useMemo<DoorWhitelist>(
    () => ({ left: leftDoorNames, right: rightDoorNames, axis: slideAxis }),
    [leftDoorNames, rightDoorNames, slideAxis],
  )

  const { parts, lookup, analysis } = useMemo(() => {
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

      // 名字候选：自身名 + 各级父节点名 —— 白名单里填「父组名」或「子网格名」都能命中
      const aliases: string[] = []
      let node: THREE.Object3D | null = mesh
      while (node) {
        const n = node.name && node.name.trim()
        if (n && !aliases.includes(n)) aliases.push(n)
        node = node.parent
      }
      const name = aliases[0] || `零件 ${i + 1}`

      return {
        id: mesh.uuid,
        name,
        aliases,
        object: mesh,
        home: cache.home,
        axis,
        toLocal,
        distance: radius * (0.35 + Math.random() * 0.25),
        center: meshCenter, // 已居中的模型空间坐标
        size: meshBox.getSize(new THREE.Vector3()),
        door: null, // 由 analyzeDoors 填充
        triangles: Math.round(triangles),
        materials: cache.materials,
        backup: cache.backup,
        on: null, // 强制首帧应用一次
      }
    })

    // 任意子网格 → 顶层零件
    const map = new Map<THREE.Object3D, Part>()
    list.forEach((p) => p.object.traverse((o) => map.set(o, p)))

    // 6) 门扇：白名单优先，没命中才回退几何推断
    const analysis = analyzeDoors(list, { travelRatio, whitelist })
    // 调试用：控制台输入 __MODEL_VIEWER_DOORS__ / __MODEL_VIEWER_PARTS__ 查看明细
    if (typeof window !== 'undefined') {
      const w = window as unknown as Record<string, unknown>
      w.__MODEL_VIEWER_DOORS__ = analysis
      w.__MODEL_VIEWER_PARTS__ = list.map((p) => ({
        name: p.name,
        id: p.id,
        aliases: p.aliases,
        size: [p.size.x, p.size.y, p.size.z],
      }))
    }

    return { parts: list, lookup: map, analysis }
  }, [scene, travelRatio, whitelist])

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

  // 手动标记会改变「哪些零件是门扇」，所以 analysis 可能被重跑替换，用 ref 持有最新值
  const analysisRef = useRef(analysis)
  analysisRef.current = analysis

  // 每次上报都按 parts 的当前状态重算门扇列表，
  // 只从 analysis 里取白名单相关的元信息（来源 / 命中 / 未命中）
  const reportDoorStats = useCallback(() => {
    const an = analysisRef.current
    const ids = parts.filter((p) => p.door).map((p) => p.id)
    onDoorStats({
      groups: an.groups,
      doors: ids.length,
      candidates: an.candidates,
      doorIds: ids,
      source: an.source,
      matched: an.matched,
      unmatched: an.unmatched,
      doorNames: ids.map((id) => {
        const part = parts.find((x) => x.id === id)!
        const meta = an.doorNames.find((d) => d.id === id)
        return {
          id,
          name: part.name,
          side: meta?.side ?? '-',
          group: part.door?.groupId ?? -1,
        }
      }),
    })
  }, [onDoorStats, parts])

  useEffect(() => {
    reportDoorStats()
  }, [reportDoorStats])

  // 白名单/自动识别都不准时的兜底：手动把某个零件设为/取消门扇
  const markDoor = useCallback(
    (id: string) => {
      const part = parts.find((p) => p.id === id)
      if (!part) return
      const next = !part.door
      doorOverride.set(id, next)
      if (next) assignSingleDoor(part, travelRatio, -1)
      else part.door = null
      reportDoorStats()
    },
    [parts, travelRatio, reportDoorStats],
  )

  /** 把所有零件名打到控制台 —— 填白名单时直接复制 */
  const printNames = useCallback(() => {
    const rows = parts.map((p) => ({
      名称: p.name,
      别名: p.aliases.join(' / '),
      尺寸: [p.size.x, p.size.y, p.size.z].map((n) => n.toFixed(3)).join(' × '),
      是门扇: p.door ? '是' : '',
    }))
    console.log(
      '[ModelViewer] 共 %d 个零件。把门扇名字填进 LEFT_DOOR_NAMES / RIGHT_DOOR_NAMES：',
      parts.length,
    )
    console.table(rows)
    console.log(
      '[ModelViewer] 可直接复制的名字数组：\n' +
        JSON.stringify(
          parts.map((p) => p.name),
          null,
          2,
        ),
    )
  }, [parts])

  const clearDoors = useCallback(() => {
    doorOverride.clear()
    // 重跑一次，恢复为白名单（或几何推断）的结果
    analysisRef.current = analyzeDoors(parts, { travelRatio, whitelist })
    reportDoorStats()
  }, [parts, travelRatio, whitelist, reportDoorStats])

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
    apiRef.current = { focus, markDoor, clearDoors, printNames }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, focus, markDoor, clearDoors, printNames])

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

    // 开门进度平滑逼近目标（0.1 的衰减系数 ≈ 0.3~0.5s 完成一次开关门）
    const openTarget = openTargetRef.current
    openRef.current += (openTarget - openRef.current) * 0.1
    if (Math.abs(openTarget - openRef.current) < 0.001) openRef.current = openTarget
    const openNow = openRef.current

    for (const part of parts) {
      // 高亮：只有「选中」才变色；悬停不改颜色（每帧对齐一次，绝不依赖 effect 时序）
      applyHighlight(part, part.id === selId)

      // 显隐
      const visible = !hidden.has(part.id)
      if (part.object.visible !== visible) part.object.visible = visible

      // 爆炸位移 + 开门位移（两者在同一父级空间里叠加，互不覆盖）
      tmpDelta.copy(part.axis).multiplyScalar(part.distance * t * spread).applyMatrix3(part.toLocal)
      tmpTarget.copy(part.home).add(tmpDelta)
      if (part.door) tmpTarget.addScaledVector(part.door.axisLocal, part.door.travel * openNow)
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
  isDoor,
  openness,
  doorStats,
  onToggleVisible,
  onFocus,
  onClear,
  onShowAll,
  onOpenness,
  onMarkDoor,
  onResetDoors,
  onPrintNames,
  hiddenCount,
}: {
  meta: PartMeta | null
  hidden: boolean
  isDoor: boolean
  openness: number
  doorStats: DoorStats
  onToggleVisible: () => void
  onFocus: () => void
  onClear: () => void
  onShowAll: () => void
  onOpenness: (v: number) => void
  onMarkDoor: () => void
  onResetDoors: () => void
  onPrintNames: () => void
  hiddenCount: number
}) {
  return (
    <div className="pointer-events-auto absolute right-4 top-4 max-h-[calc(100vh-2rem)] w-72 overflow-y-auto rounded-xl border border-white/10 bg-slate-900/80 p-4 text-sm text-slate-200 shadow-2xl backdrop-blur">
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

      {/* 滑动门：开关门控制 */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-medium text-slate-200">滑动门</span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
              doorStats.source === 'whitelist'
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            }`}
          >
            {doorStats.source === 'whitelist'
              ? `白名单 ${doorStats.matched} 樘 / ${doorStats.doors} 件`
              : `几何推断 ${doorStats.groups} 组`}
          </span>
        </div>

        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={openness}
          onChange={(e) => onOpenness(Number(e.target.value))}
          className="w-full accent-sky-400"
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            onClick={() => onOpenness(0)}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 transition hover:bg-white/10"
          >
            关门
          </button>
          <button
            onClick={() => onOpenness(1)}
            className="rounded-lg bg-sky-500 px-3 py-1.5 font-medium text-slate-950 transition hover:bg-sky-400"
          >
            开门
          </button>
        </div>

        {meta && (
          <button
            onClick={onMarkDoor}
            className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs transition hover:bg-white/10"
          >
            {isDoor ? '取消门扇标记' : '把选中零件标为门扇'}
          </button>
        )}

        {doorStats.unmatched.length > 0 && (
          <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2 text-[11px] leading-relaxed text-amber-200">
            <div className="mb-1 font-medium">白名单中有 {doorStats.unmatched.length} 个名字没匹配到：</div>
            <ul className="space-y-0.5">
              {doorStats.unmatched.slice(0, 5).map((u, i) => (
                <li key={i} className="truncate" title={u.input}>
                  「{u.input}」
                  {u.duplicate
                    ? ` 重复填写（${u.suggest ?? '该零件'} 已被前面的项占用）`
                    : u.suggest
                      ? ` → 是否想填「${u.suggest}」？`
                      : ' （未找到匹配零件）'}
                </li>
              ))}
            </ul>
            {doorStats.unmatched.length > 5 && (
              <div className="mt-1 text-amber-300/70">…还有 {doorStats.unmatched.length - 5} 个，见控制台</div>
            )}
          </div>
        )}

        {doorStats.doors === 0 && (
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            {doorStats.source === 'whitelist'
              ? '白名单一个都没命中，已回退几何推断（薄板候选 ' +
                doorStats.candidates +
                ' 个）。点下面的按钮打印全部零件名，复制后填进 LEFT_DOOR_NAMES / RIGHT_DOOR_NAMES。'
              : '未识别到对开门（薄板候选 ' +
                doorStats.candidates +
                ' 个）。可选中一扇门后点上面的按钮手动指定。'}
          </p>
        )}

        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            onClick={onPrintNames}
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-slate-300 transition hover:bg-white/10"
          >
            打印零件名
          </button>
          <button
            onClick={onResetDoors}
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-slate-300 transition hover:bg-white/10"
          >
            重置门扇
          </button>
        </div>
      </div>
    </div>
  )
}

export function ModelViewer({
  progress,
  modelUrl = DEFAULT_MODEL_PATH,
  spread = 1,
  leftDoorNames = LEFT_DOOR_NAMES,
  rightDoorNames = RIGHT_DOOR_NAMES,
  slideAxis = DOOR_SLIDE_AXIS,
}: {
  progress: number
  modelUrl?: string
  spread?: number
  leftDoorNames?: string[] // 左门扇名字白名单（也可直接改文件顶部常量）
  rightDoorNames?: string[] // 右门扇名字白名单，与左门索引一一对应
  slideAxis?: SlideAxis
}) {
  const [parts, setParts] = useState<PartMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const [openness, setOpenness] = useState(0)
  const [doorStats, setDoorStats] = useState<DoorStats>({
    groups: 0,
    doors: 0,
    candidates: 0,
    doorIds: [],
    source: 'auto',
    matched: 0,
    unmatched: [],
    doorNames: [],
  })
  const apiRef = useRef<ViewerApi | null>(null)

  const onPartsLoaded = useCallback((list: PartMeta[]) => setParts(list), [])
  const onDoorStats = useCallback((stats: DoorStats) => setDoorStats(stats), [])

  const selected = useMemo(() => parts.find((p) => p.id === selectedId) ?? null, [parts, selectedId])
  const isDoor = useMemo(
    () => (selectedId ? doorStats.doorIds.includes(selectedId) : false),
    [selectedId, doorStats.doorIds],
  )

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
            <Environment preset="studio" environmentIntensity={0.65} />
          </EnvironmentBoundary>
        </Suspense>
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.4}>
            <ModelErrorBoundary selectedId={selectedId} onSelect={setSelectedId}>
              <ExplodingModel
                progress={progress}
                spread={spread}
                openness={openness}
                leftDoorNames={leftDoorNames}
                rightDoorNames={rightDoorNames}
                slideAxis={slideAxis}
                modelUrl={modelUrl}
                selectedId={selectedId}
                hoveredId={hoveredId}
                hiddenIds={hiddenIds}
                onSelect={setSelectedId}
                onHover={setHoveredId}
                onPartsLoaded={onPartsLoaded}
                onDoorStats={onDoorStats}
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
          isDoor={isDoor}
          openness={openness}
          doorStats={doorStats}
          onToggleVisible={() => selectedId && toggleVisible(selectedId)}
          onFocus={() => selectedId && apiRef.current?.focus(selectedId)}
          onClear={() => setSelectedId(null)}
          onShowAll={() => setHiddenIds(new Set())}
          onOpenness={setOpenness}
          onMarkDoor={() => selectedId && apiRef.current?.markDoor(selectedId)}
          onResetDoors={() => apiRef.current?.clearDoors()}
          onPrintNames={() => apiRef.current?.printNames()}
          hiddenCount={hiddenIds.size}
        />
      </div>
    </div>
  )
}
