'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Boxes, Trash2, ExternalLink, Loader2, Pencil, Check, X, Plus } from 'lucide-react'

interface ModelRecord {
  id: string
  name: string
  originalName: string
  size: number
  systemType?: string
  note?: string
  uploadedAt: string
  url: string
}

function fmtSize(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

/** 模型列表页：查询所有模型 + 改名 + 删除；上传在独立页 /models/upload */
export default function ModelLibraryPage() {
  const [models, setModels] = useState<ModelRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [keyword, setKeyword] = useState('')

  // 改名状态：正在编辑的模型 id 及其草稿名
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/models', { cache: 'no-store' })
      const data = await res.json()
      setModels(data.models ?? [])
    } catch {
      setMessage({ kind: 'err', text: '无法连接模型接口' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`确认删除模型「${name}」？文件将被移除，不可恢复。`)) return
    const res = await fetch(`/api/models/${id}`, { method: 'DELETE' })
    if (res.ok) {
      setMessage({ kind: 'ok', text: `已删除：${name}` })
      refresh()
    } else {
      setMessage({ kind: 'err', text: '删除失败' })
    }
  }

  function startRename(m: ModelRecord) {
    setEditingId(m.id)
    setDraftName(m.name)
  }

  function cancelRename() {
    setEditingId(null)
    setDraftName('')
  }

  async function saveRename(id: string) {
    const name = draftName.trim()
    if (!name) {
      setMessage({ kind: 'err', text: '名字不能为空' })
      return
    }
    setSavingId(id)
    try {
      const res = await fetch(`/api/models/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (res.ok) {
        setMessage({ kind: 'ok', text: '名字已更新' })
        setEditingId(null)
        refresh()
      } else {
        const data = await res.json().catch(() => null)
        setMessage({ kind: 'err', text: data?.error ?? '改名失败' })
      }
    } finally {
      setSavingId(null)
    }
  }

  const filtered = models.filter((m) => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return true
    return (
      m.name.toLowerCase().includes(kw) ||
      (m.note ?? '').toLowerCase().includes(kw) ||
      m.originalName.toLowerCase().includes(kw)
    )
  })

  return (
    <div className="min-h-screen bg-[#080d17] px-4 py-10 text-white md:px-10">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs text-cyan-200">
              <Boxes className="h-3.5 w-3.5" /> 模型库
            </div>
            <h1 className="text-2xl font-semibold">模型列表</h1>
            <p className="mt-2 text-xs text-slate-500">
              可按名字/备注搜索；支持改名与删除。模型文件通过{' '}
              <code className="text-slate-400">GET /api/models/:id/file</code> 加载。
            </p>
          </div>
          <Link
            href="/models/upload"
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-xs font-medium text-slate-950 transition hover:bg-sky-400"
          >
            <Plus className="h-3.5 w-3.5" /> 上传模型
          </Link>
        </header>

        {/* 搜索 */}
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="按名字 / 备注搜索…"
          className="mb-4 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-sky-400/60"
        />

        {message && (
          <p className={`mb-3 text-xs ${message.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>{message.text}</p>
        )}

        {loading ? (
          <div className="grid place-items-center rounded-xl border border-white/10 bg-white/[0.02] py-10 text-sm text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] py-10 text-center text-sm text-slate-500">
            {models.length === 0 ? '还没有模型，点击右上角「上传模型」开始' : '没有匹配的模型'}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3"
              >
                <div className="min-w-0 flex-1">
                  {editingId === m.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename(m.id)
                          if (e.key === 'Escape') cancelRename()
                        }}
                        autoFocus
                        maxLength={100}
                        className="flex-1 rounded-lg border border-sky-400/60 bg-white/10 px-2.5 py-1.5 text-sm text-slate-100 outline-none"
                      />
                      <button
                        onClick={() => saveRename(m.id)}
                        disabled={savingId === m.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1.5 text-xs font-medium text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                      >
                        {savingId === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        保存
                      </button>
                      <button
                        onClick={cancelRename}
                        className="inline-flex items-center rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-white/10"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="truncate text-sm font-medium text-slate-100">{m.name}</p>
                      <p className="truncate text-[11px] text-slate-500">
                        {fmtSize(m.size)} · {fmtDate(m.uploadedAt)}
                        {m.systemType ? ` · ${m.systemType === 'full' ? '全高' : m.systemType === 'half' ? '半高' : '通用'}` : ''}
                        {m.note ? ` · ${m.note}` : ''}
                      </p>
                    </>
                  )}
                </div>

                {editingId !== m.id && (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => startRename(m)}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/10"
                    >
                      <Pencil className="h-3.5 w-3.5" /> 改名
                    </button>
                    <a
                      href={`/?id=${m.id}`}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/10"
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> 查看
                    </a>
                    <button
                      onClick={() => handleDelete(m.id, m.name)}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-1.5 text-xs text-red-300 transition hover:bg-red-400/15"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> 删除
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <footer className="mt-10 flex gap-3 text-xs text-slate-600">
          <Link href="/" className="transition hover:text-slate-400">Model Lab 3D 查看器</Link>
          <span>·</span>
          <Link href="/cbt" className="transition hover:text-slate-400">PSD CBT 培训系统</Link>
        </footer>
      </div>
    </div>
  )
}
