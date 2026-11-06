import { NextRequest } from 'next/server'
import { getModelFilePath } from '@/lib/models/store'
import { createReadStream } from 'fs'
import { Readable } from 'stream'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/models/:id/file —— 提供 GLB 文件下载（供 3D 查看器加载） */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  
  const filePath = await getModelFilePath(id)
  if (!filePath) {
    return new Response(JSON.stringify({ error: '模型不存在' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
  return new Response(stream, {
    headers: {
      'content-type': 'model/gltf-binary',
      'cache-control': 'public, max-age=3600',
    },
  })
}
