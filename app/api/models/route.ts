import { NextResponse } from 'next/server'
import { listModels } from '@/lib/models/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/models —— 查询所有已上传模型 */
export async function GET() {
  try {
    const models = await listModels()
    return NextResponse.json({
      total: models.length,
      models: models.map((m) => ({ ...m, url: `/api/models/${m.id}/file` })),
    })
  } catch (err) {
    return NextResponse.json({ error: '读取模型列表失败', detail: String(err) }, { status: 500 })
  }
}
