'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, CheckCircle2, RotateCcw, AlertTriangle } from 'lucide-react'
import { ModelViewer } from '@/components/model-viewer'
import { useScenarioEngine } from '@/lib/cbt/scenario-engine'
import type { Scenario } from '@/lib/cbt/types'
import { markLesson } from '@/lib/cbt/progress'

/**
 * 步骤播放器：3D 视口（复用 ModelViewer：爆炸 + 名称高亮）
 * + 右侧步骤面板（旁白 / 安全提示 / 上一步·下一步）。
 * 场景内容全部来自 JSON，本组件不感知具体课程。
 */
export function StepPlayer({
  scenario,
  lessonKey,
}: {
  scenario: Scenario
  lessonKey: string
}) {
  const { index, total, step, isFirst, isLast, next, prev, goto, reset } = useScenarioEngine(scenario)

  const explode = useMemo(() => (step.action.explode ?? 0) / 100, [step])
  const highlight = useMemo(() => step.action.highlight, [step])

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#080d17] text-white">
      <section className="relative min-h-screen">
        <ModelViewer progress={explode} modelUrl={scenario.model} highlightNameFilter={highlight} />

        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,transparent_0%,rgba(8,13,23,0.08)_40%,rgba(8,13,23,0.72)_100%)]" />

        <header className="absolute left-0 right-0 top-0 flex items-center justify-between px-6 py-4 md:px-10">
          <div className="pointer-events-auto flex items-center gap-3">
            <Link
              href="/cbt"
              className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-slate-300 backdrop-blur transition hover:bg-white/10"
            >
              ← 课程目录
            </Link>
            <div>
              <p className="text-sm font-semibold text-slate-100">{scenario.title}</p>
              <p className="text-[11px] text-slate-500">
                {scenario.systemType === 'both' ? '全高 / 半高通用' : scenario.systemType === 'full' ? '全高 PSD' : '半高 PSD'}
                {' · '}
                {scenario.category === 'fault'
                  ? '故障排查'
                  : scenario.category === 'maintenance'
                    ? '维护'
                    : scenario.category === 'assembly'
                      ? '装配/拆卸'
                      : scenario.category === 'testing'
                        ? '测试'
                        : '运行操作'}
              </p>
            </div>
          </div>
          <div className="pointer-events-auto rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-slate-300 backdrop-blur">
            步骤 {index + 1} / {total}
          </div>
        </header>

        {/* 步骤面板 */}
        <aside className="absolute bottom-6 left-6 right-6 rounded-2xl border border-white/10 bg-[#0b1422]/85 p-4 shadow-2xl backdrop-blur-xl md:left-auto md:top-24 md:bottom-6 md:w-[380px]">
          <ol className="mb-3 flex flex-wrap gap-1.5">
            {scenario.steps.map((s, i) => (
              <li key={s.id}>
                <button
                  onClick={() => goto(i)}
                  className={`h-1.5 rounded-full transition-all ${i === index ? 'w-8 bg-cyan-300' : i < index ? 'w-4 bg-cyan-300/50' : 'w-4 bg-white/15'}`}
                  aria-label={`跳转到步骤 ${i + 1}`}
                />
              </li>
            ))}
          </ol>

          <h3 className="text-base font-semibold text-sky-300">{step.title}</h3>
          <p className="mt-2 max-h-40 overflow-y-auto text-sm leading-6 text-slate-300">{step.narration}</p>

          {step.safetyNote && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5 text-xs leading-5 text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{step.safetyNote}</span>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/10 pt-3">
            <button
              onClick={prev}
              disabled={isFirst}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> 上一步
            </button>
            <button
              onClick={reset}
              className="flex items-center gap-1 rounded-lg px-2 py-2 text-xs text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
            >
              <RotateCcw className="h-4 w-4" /> 重来
            </button>
            {isLast ? (
              <button
                onClick={() => {
                  markLesson(lessonKey, 'completed')
                  next()
                }}
                className="flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950 transition hover:bg-emerald-400"
              >
                <CheckCircle2 className="h-4 w-4" /> 完成学习
              </button>
            ) : (
              <button
                onClick={next}
                className="flex items-center gap-1 rounded-lg bg-sky-500 px-3 py-2 text-xs font-medium text-slate-950 transition hover:bg-sky-400"
              >
                下一步 <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </aside>
      </section>
    </div>
  )
}
