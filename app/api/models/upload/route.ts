import { NextRequest, NextResponse } from 'next/server'
import { saveModel, type ModelRecord } from '@/lib/models/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_SIZE = 300 * 1024 * 1024 // 300MB
const SYSTEM_TYPES = new Set(['full', 'half', 'both'])

/** POST /api/models/upload —— 上传 GLB 模型（multipart/form-data） */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少 file 字段（multipart/form-data）' }, { status: 400 })
    }
    if (!file.name.toLowerCase().endsWith('.glb')) {
      return NextResponse.json({ error: '仅支持 .glb 文件' }, { status: 400 })
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: `文件超过大小限制（${Math.round(MAX_SIZE / 1024 / 1024)}MB）` }, { status: 413 })
    }

    const name = typeof form.get('name') === 'string' ? (form.get('name') as string) : undefined
    const note = typeof form.get('note') === 'string' ? (form.get('note') as string) : undefined
    const systemTypeRaw = form.get('systemType')
    const systemType =
      typeof systemTypeRaw === 'string' && SYSTEM_TYPES.has(systemTypeRaw)
        ? (systemTypeRaw as ModelRecord['systemType'])
        : undefined

    const record = await saveModel({ file, name, systemType, note })
    return NextResponse.json({ ...record, url: `/api/models/${record.id}/file` }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: '上传失败', detail: String(err) }, { status: 500 })
  }
}
