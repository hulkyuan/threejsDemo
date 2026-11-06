'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { GraduationCap, Clock } from 'lucide-react'
import { course } from '@/lib/cbt/content'
import { getAllProgress, bestScoreByModule } from '@/lib/cbt/progress'

export default function CourseHome() {
  const [progress, setProgress] = useState<Record<string, { status: string }>>({})
  const [best, setBest] = useState<Record<string, number>>({})

  useEffect(() => {
    setProgress(getAllProgress())
    setBest(bestScoreByModule())
  }, [])

  return (
    <div className="min-h-screen bg-[#080d17] px-4 py-10 text-white md:px-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs text-cyan-200">
            <GraduationCap className="h-3.5 w-3.5" /> PSD CBT 培训系统
          </div>
          <h1 className="text-2xl font-semibold md:text-3xl">{course.title}</h1>
          <p className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <Clock className="h-3.5 w-3.5" /> 总课时 {course.totalHours} 小时 · {course.modules.length} 个模块 · 每模块含评估
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          {course.modules.map((m) => {
            const done = m.lessons.filter((l) => progress[`${m.id}/${l.id}`]?.status === 'completed').length
            const pct = m.lessons.length ? Math.round((done / m.lessons.length) * 100) : 0
            const bestPct = best[m.id] !== undefined ? Math.round(best[m.id] * 100) : null
            return (
              <Link
                key={m.id}
                href={`/cbt/module/${m.id}`}
                className="group rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-sky-400/40 hover:bg-white/[0.06]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] text-slate-500">模块 {String(m.index).padStart(2, '0')}</p>
                    <h3 className="mt-0.5 truncate text-sm font-medium text-slate-100 group-hover:text-sky-300">{m.title}</h3>
                    {m.titleEn && <p className="truncate text-[11px] text-slate-600">{m.titleEn}</p>}
                  </div>
                  <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-slate-400">
                    {m.systemType === 'both' ? '全高/半高' : m.systemType === 'full' ? '全高' : '半高'}
                  </span>
                </div>

                <div className="mt-3 flex items-center gap-3">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-500">{done}/{m.lessons.length}</span>
                  {bestPct !== null && (
                    <span className={`text-[10px] ${bestPct >= 60 ? 'text-emerald-400' : 'text-red-400'}`}>最高 {bestPct}%</span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>

        <footer className="mt-10 flex gap-3 text-xs text-slate-600">
          <Link href="/" className="transition hover:text-slate-400">Model Lab 3D 查看器</Link>
          <span>·</span>
          <span>课程内容位于 content/cbt/，新增课程无需改代码</span>
        </footer>
      </div>
    </div>
  )
}
