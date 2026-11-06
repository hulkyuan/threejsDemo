'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { Upload, Loader2, CheckCircle2, ListOrdered } from 'lucide-react'

/**
 * 模型上传页（与列表页分开）：
 * - 名字为必填表单项，作为后期查找/检索的显示名
 * - 可选：系统类型（全高/半高/通用）、备注
 */
export default function ModelUploadPage() {
  const [name, setName] = useState('')
  const [systemType, setSystemType] = useState('both')
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function pickFile(f: File | null | undefined) {
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.glb')) {
      setMessage({ kind: 'err', text: '仅支持 .glb 文件' })
      return
    }
    setFile(f)
    setMessage(null)
  }

  function submit() {
    if (!name.trim()) {
      setMessage({ kind: 'err', text: '请填写模型名字' })
      return
    }
    if (!file) {
      setMessage({ kind: 'err', text: '请选择要上传的 .glb 文件' })
      return
    }

    setUploading(true)
    setProgress(0)
    setMessage(null)

    const form = new FormData()
    form.append('file', file)
    form.append('name', name.trim())
    form.append('systemType', systemType)
    if (note.trim()) form.append('note', note.trim())

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/models/upload')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      setUploading(false)
      if (xhr.status === 201) {
        setMessage({ kind: 'ok', text: `上传成功：「${name.trim()}」已入库` })
        setFile(null)
        setName('')
        setNote('')
      } else {
        let err = '上传失败'
        try {
          err = JSON.parse(xhr.responseText).error ?? err
        } catch {}
        setMessage({ kind: 'err', text: err })
      }
    }
    xhr.onerror = () => {
      setUploading(false)
      setMessage({ kind: 'err', text: '网络错误，上传中断' })
    }
    xhr.send(form)
  }

  const inputCls =
    'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-sky-400/60'

  return (
    <div className="min-h-screen bg-[#080d17] px-4 py-10 text-white md:px-10">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">上传模型</h1>
            <p className="mt-2 text-xs text-slate-500">仅支持 .glb 文件，最大 300MB。名字用于后期查找与课程引用。</p>
          </div>
          <Link
            href="/models"
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/10"
          >
            <ListOrdered className="h-3.5 w-3.5" /> 模型列表
          </Link>
        </header>

        <div className="space-y-5 rounded-xl border border-white/10 bg-white/[0.03] p-5">
          {/* 名字 */}
          <div>
            <label className="mb-1.5 block text-xs text-slate-400">
              模型名字 <span className="text-red-400">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：全高 PSD 门体总成 v2"
              className={inputCls}
              maxLength={100}
            />
          </div>

          {/* 系统类型 */}
          <div>
            <label className="mb-1.5 block text-xs text-slate-400">系统类型</label>
            <div className="flex gap-2">
              {[
                { v: 'both', label: '通用' },
                { v: 'full', label: '全高 PSD' },
                { v: 'half', label: '半高 PSD' },
              ].map((o) => (
                <button
                  key={o.v}
                  onClick={() => setSystemType(o.v)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                    systemType === o.v
                      ? 'border-sky-400/60 bg-sky-400/10 text-sky-200'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* 文件 */}
          <div>
            <label className="mb-1.5 block text-xs text-slate-400">
              模型文件（.glb）<span className="text-red-400">*</span>
            </label>
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                pickFile(e.dataTransfer.files?.[0])
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition ${
                dragOver ? 'border-cyan-300/60 bg-cyan-300/5' : 'border-white/15 hover:border-white/30'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".glb,model/gltf-binary"
                className="sr-only"
                onChange={(e) => {
                  pickFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
              {file ? (
                <p className="text-sm text-sky-300">
                  {file.name}（{(file.size / 1024 / 1024).toFixed(1)} MB）
                </p>
              ) : (
                <p className="inline-flex items-center gap-2 text-sm text-slate-400">
                  <Upload className="h-4 w-4" /> 点击选择或拖拽 .glb 文件到此处
                </p>
              )}
            </div>
          </div>

          {/* 备注 */}
          <div>
            <label className="mb-1.5 block text-xs text-slate-400">备注（可选）</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：来源 Blender 4.x 导出，含开门动画"
              className={inputCls}
              maxLength={200}
            />
          </div>

          {uploading && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}

          {message && (
            <p
              className={`inline-flex items-center gap-1.5 text-xs ${message.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}
            >
              {message.kind === 'ok' && <CheckCircle2 className="h-3.5 w-3.5" />}
              {message.text}
              {message.kind === 'ok' && (
                <Link href="/models" className="ml-1 underline">
                  去列表查看
                </Link>
              )}
            </p>
          )}

          <button
            onClick={submit}
            disabled={uploading}
            className="w-full rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> 上传中 {progress}%
              </span>
            ) : (
              '开始上传'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
