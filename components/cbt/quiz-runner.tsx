'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, XCircle, RotateCcw } from 'lucide-react'
import { buildAttemptQuestions, getQuizBank } from '@/lib/cbt/content'
import { saveAttempt } from '@/lib/cbt/progress'
import { markLesson } from '@/lib/cbt/progress'
import type { QuizQuestion } from '@/lib/cbt/types'

/**
 * 评估引擎 UI：
 * - 从题库随机抽题（需求：每子模块 20 题，题库不足时先抽全部）
 * - 单选/多选/判断，提交后生成颜色编码结果表（绿=对 红=错）并显示得分
 * - 支持重评模式（重新抽题再来一次），历史成绩存 progress
 */
export function QuizRunner({ moduleId }: { moduleId: string }) {
  const bank = useMemo(() => getQuizBank(moduleId), [moduleId])
  const [seed, setSeed] = useState(0)
  const questions = useMemo<QuizQuestion[]>(
    () => (bank ? buildAttemptQuestions(bank) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bank, seed],
  )

  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [submitted, setSubmitted] = useState(false)

  if (!bank) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#080d17] text-slate-300">
        <div className="text-center">
          <p className="mb-4">该模块的题库尚未录入（content/cbt/quizzes/{moduleId}.json）。</p>
          <Link href="/cbt" className="text-sky-300 underline">← 返回课程目录</Link>
        </div>
      </div>
    )
  }

  const toggle = (qid: string, oid: string, multi: boolean) => {
    if (submitted) return
    setAnswers((prev) => {
      const cur = prev[qid] ?? []
      if (!multi) return { ...prev, [qid]: [oid] }
      return { ...prev, [qid]: cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid] }
    })
  }

  const results = useMemo(() => {
    return questions.map((q) => {
      const picked = (answers[q.id] ?? []).slice().sort()
      const correct = q.answer.slice().sort()
      const ok = picked.length === correct.length && picked.every((v, i) => v === correct[i])
      return { q, picked, ok }
    })
  }, [questions, answers])

  const score = results.filter((r) => r.ok).length
  const total = questions.length
  const unanswered = questions.filter((q) => (answers[q.id] ?? []).length === 0).length

  function submit() {
    setSubmitted(true)
    saveAttempt({
      id: `${moduleId}-${Date.now()}`,
      moduleId,
      startedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
      submittedAt: new Date().toISOString(),
      answers,
      score,
      total,
      passed: score / Math.max(total, 1) >= 0.6,
    })
    markLesson(`${moduleId}/quiz`, 'completed')
  }

  function retry() {
    setAnswers({})
    setSubmitted(false)
    setSeed((s) => s + 1)
  }

  return (
    <div className="min-h-screen bg-[#080d17] px-4 py-10 text-white md:px-10">
      <div className="mx-auto max-w-3xl">
        <Link href={`/cbt/module/${moduleId}`} className="text-xs text-slate-400 transition hover:text-slate-200">
          ← 返回模块
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{bank.title}</h1>
        <p className="mt-1 text-xs text-slate-500">
          需求规定每模块评估 20 题；当前题库 {bank.questions.length} 题，本次抽取 {total} 题（题库补齐后自动抽满 20 题）。
        </p>

        {!submitted ? (
          <div className="mt-6 space-y-5">
            {questions.map((q, i) => {
              const multi = q.type === 'multi'
              return (
                <div key={q.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-sm font-medium text-slate-100">
                    {i + 1}. {q.stem}
                    {multi && <span className="ml-2 text-[11px] text-cyan-300">多选</span>}
                  </p>
                  <div className="mt-3 space-y-2">
                    {q.options.map((o) => {
                      const checked = (answers[q.id] ?? []).includes(o.id)
                      return (
                        <button
                          key={o.id}
                          onClick={() => toggle(q.id, o.id, multi)}
                          className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${
                            checked
                              ? 'border-sky-400/60 bg-sky-400/10 text-sky-100'
                              : 'border-white/10 bg-transparent text-slate-300 hover:bg-white/5'
                          }`}
                        >
                          <span
                            className={`grid h-4 w-4 shrink-0 place-items-center border text-[10px] ${
                              multi ? 'rounded' : 'rounded-full'
                            } ${checked ? 'border-sky-300 bg-sky-400 text-slate-950' : 'border-slate-500'}`}
                          >
                            {checked ? '✓' : ''}
                          </span>
                          {o.text}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            <div className="flex items-center justify-between pb-10">
              <span className="text-xs text-slate-500">{unanswered > 0 ? `还有 ${unanswered} 题未作答` : '全部题目已作答'}</span>
              <button
                onClick={submit}
                className="rounded-lg bg-sky-500 px-6 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-sky-400"
              >
                提交答卷
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-6 pb-10">
            {/* 成绩卡 */}
            <div className="rounded-xl border border-white/10 bg-white/[0.04] p-5">
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-xs uppercase tracking-widest text-slate-500">评估结果</p>
                  <p className="mt-1 text-3xl font-semibold">
                    <span className={score / Math.max(total, 1) >= 0.6 ? 'text-emerald-400' : 'text-red-400'}>{score}</span>
                    <span className="text-slate-500"> / {total}</span>
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs ${score / Math.max(total, 1) >= 0.6 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}
                >
                  {score / Math.max(total, 1) >= 0.6 ? '通过' : '未通过（60% 及格）'}
                </span>
              </div>
            </div>

            {/* 颜色编码结果汇总表（需求 30 条） */}
            <div className="mt-4 overflow-hidden rounded-xl border border-white/10">
              <table className="w-full text-left text-sm">
                <thead className="bg-white/[0.05] text-xs text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-normal">题号</th>
                    <th className="px-4 py-2 font-normal">状态</th>
                    <th className="px-4 py-2 font-normal">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={r.q.id} className="border-t border-white/5">
                      <td className="px-4 py-2 text-slate-300">{i + 1}</td>
                      <td className="px-4 py-2">
                        {r.ok ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="h-4 w-4" /> 正确
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-400">
                            <XCircle className="h-4 w-4" /> 错误
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-400">
                        {r.ok ? r.q.explanation ?? '—' : `正确答案：${r.q.answer.join('、')}${r.q.explanation ? ` · ${r.q.explanation}` : ''}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              onClick={retry}
              className="mt-5 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-5 py-2.5 text-sm text-slate-200 transition hover:bg-white/10"
            >
              <RotateCcw className="h-4 w-4" /> 重评模式（重新抽题）
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
