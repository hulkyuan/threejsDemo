import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'

/**
 * 模型库服务端存储：
 * - GLB 文件落盘到 <cwd>/data/models/
 * - 元数据注册表：<cwd>/data/models.json
 * 部署时把 data/ 目录挂载/备份即可，代码无状态。
 */

export interface ModelRecord {
  id: string
  /** 显示名（默认取原始文件名去扩展名） */
  name: string
  /** 磁盘文件名（id.glb） */
  fileName: string
  originalName: string
  size: number
  /** 关联 PSD 系统类型（可选，上传时指定） */
  systemType?: 'full' | 'half' | 'both'
  /** 备注（可选） */
  note?: string
  uploadedAt: string
}

const DATA_DIR = path.join(process.cwd(), 'data')
const MODELS_DIR = path.join(DATA_DIR, 'models')
const REGISTRY_PATH = path.join(DATA_DIR, 'models.json')

async function ensureDirs() {
  await fs.mkdir(MODELS_DIR, { recursive: true })
}

async function readRegistry(): Promise<ModelRecord[]> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeRegistry(list: ModelRecord[]) {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(list, null, 2), 'utf8')
}

export async function listModels(): Promise<ModelRecord[]> {
  await ensureDirs()
  const list = await readRegistry()
  return list.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
}

export async function getModel(id: string): Promise<ModelRecord | null> {
  const list = await readRegistry()
  return list.find((m) => m.id === id) ?? null
}

export async function getModelFilePath(id: string): Promise<string | null> {
  const rec = await getModel(id)
  if (!rec) return null
  return path.join(MODELS_DIR, rec.fileName)
}

export async function saveModel(opts: {
  file: File
  name?: string
  systemType?: ModelRecord['systemType']
  note?: string
}): Promise<ModelRecord> {
  await ensureDirs()
  const id = crypto.randomUUID()
  const originalName = opts.file.name
  const fallback = originalName.replace(/\.[^.]+$/, '') || '未命名模型'
  const record: ModelRecord = {
    id,
    name: (opts.name ?? '').trim() || fallback,
    fileName: `${id}.glb`,
    originalName,
    size: opts.file.size,
    systemType: opts.systemType,
    note: opts.note,
    uploadedAt: new Date().toISOString(),
  }
  const buffer = Buffer.from(await opts.file.arrayBuffer())
  await fs.writeFile(path.join(MODELS_DIR, record.fileName), buffer)
  const list = await readRegistry()
  list.push(record)
  await writeRegistry(list)
  return record
}

export async function removeModel(id: string): Promise<boolean> {
  const list = await readRegistry()
  const idx = list.findIndex((m) => m.id === id)
  if (idx === -1) return false
  const [rec] = list.splice(idx, 1)
  await writeRegistry(list)
  try {
    await fs.unlink(path.join(MODELS_DIR, rec.fileName))
  } catch {
    // 文件已不存在时忽略，注册表为准
  }
  return true
}

/** 更新模型元数据（目前支持改名 name，可附带 systemType / note） */
export async function updateModel(
  id: string,
  patch: { name?: string; systemType?: ModelRecord['systemType']; note?: string },
): Promise<ModelRecord | null> {
  const list = await readRegistry()
  const rec = list.find((m) => m.id === id)
  if (!rec) return null
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) return null
    rec.name = name
  }
  if (patch.systemType !== undefined) rec.systemType = patch.systemType
  if (patch.note !== undefined) rec.note = patch.note
  await writeRegistry(list)
  return rec
}
