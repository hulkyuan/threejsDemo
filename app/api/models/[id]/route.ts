import { NextRequest, NextResponse } from 'next/server'
import { getModel, removeModel, updateModel, type ModelRecord } from '@/lib/models/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SYSTEM_TYPES = new Set(['full', 'half', 'both'])

/** GET /api/models/:id —— 查询单个模型元数据 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const record = await getModel(id)
  if (!record) return NextResponse.json({ error: '模型不存在' }, { status: 404 })
  return NextResponse.json({ ...record, url: `/api/models/${record.id}/file` })
}

/** PATCH /api/models/:id —— 修改模型信息（名字 / systemType / note） */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const body = (await req.json()) as { name?: string; systemType?: string; note?: string }
    const patch: { name?: string; systemType?: ModelRecord['systemType']; note?: string } = {}

    if (typeof body.name === 'string') {
      if (!body.name.trim()) {
        return NextResponse.json({ error: '名字不能为空' }, { status: 400 })
      }
      patch.name = body.name
    }
    if (typeof body.systemType === 'string' && SYSTEM_TYPES.has(body.systemType)) {
      patch.systemType = body.systemType as ModelRecord['systemType']
    }
    if (typeof body.note === 'string') patch.note = body.note

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 })
    }

    const record = await updateModel(id, patch)
    if (!record) return NextResponse.json({ error: '模型不存在或名字为空' }, { status: 404 })
    return NextResponse.json({ ...record, url: `/api/models/${record.id}/file` })
  } catch (err) {
    return NextResponse.json({ error: '更新失败', detail: String(err) }, { status: 500 })
  }
}

/** DELETE /api/models/:id —— 删除模型（文件 + 注册表） */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ok = await removeModel(id)
  if (!ok) return NextResponse.json({ error: '模型不存在' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
