'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { BookOpen, ClipboardCheck, FileText } from 'lucide-react'
import { getModule } from '@/lib/cbt/content'

const kindMeta: Record<string, { label: string; icon: typeof BookOpen }> = {
  scenario: { label: '3D 分步演练', icon: BookOpen },
  doc: { label: '图文文档', icon: FileText },
  video: { label: '视频课程', icon: BookOpen },
  quiz: { label: '子模块评估', icon: ClipboardCheck },
}

export default function ModulePage() {
  const params = useParams<{ moduleId: string }>()
  const mod = getModule(params.moduleId)

  if (!mod) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#080d17] text-slate-300">
        <p>未找到模块 {params.moduleId}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#080d17] px-4 py-10 text-white md:px-10">
      <div className="mx-auto max-w-3xl">
        <Link href="/cbt" className="text-xs text-slate-400 transition hover:text-slate-200">← 课程目录</Link>
        <p className="mt-4 text-[11px] text-slate-500">模块 {String(mod.index).padStart(2, '0')}</p>
        <h1 className="text-2xl font-semibold">{mod.title}</h1>
        {mod.titleEn && <p className="mt-1 text-xs text-slate-600">{mod.titleEn}</p>}
        {mod.summary && <p className="mt-3 text-sm leading-6 text-slate-400">{mod.summary}</p>}

        <div className="mt-6 space-y-3">
          {mod.lessons.map((l) => {
            const meta = kindMeta[l.kind] ?? kindMeta.doc
            const Icon = meta.icon
            const href =
              l.kind === 'scenario' && l.ref
                ? `/cbt/module/${mod.id}/lesson/${l.id}`
                : null
            const inner = (
              <>
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-slate-300">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-100">{l.title}</p>
                    <p className="text-[11px] text-slate-500">{meta.label} · 约 {l.durationMin} 分钟</p>
                  </div>
                </div>
                {!href && <span className="shrink-0 text-[11px] text-slate-600">内容待录入</span>}
              </>
            )
            return href ? (
              <Link
                key={l.id}
                href={href}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-sky-400/40 hover:bg-white/[0.06]"
              >
                {inner}
              </Link>
            ) : (
              <div
                key={l.id}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] p-3 opacity-70"
              >
                {inner}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
