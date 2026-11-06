'use client'

import { useParams } from 'next/navigation'
import { StepPlayer } from '@/components/cbt/step-player'
import { getModule, getScenario } from '@/lib/cbt/content'

export default function LessonPage() {
  const params = useParams<{ moduleId: string; lessonId: string }>()
  const mod = getModule(params.moduleId)
  const lesson = mod?.lessons.find((l) => l.id === params.lessonId)
  const scenario = lesson?.ref ? getScenario(lesson.ref) : null

  if (!scenario) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#080d17] text-slate-300">
        <div className="text-center">
          <p className="mb-4">该课程的 3D 场景尚未录入（content/cbt/scenarios/ 下新增 JSON 并在 lib/cbt/content.ts 登记）。</p>
          <a href={`/cbt/module/${params.moduleId}`} className="text-sky-300 underline">← 返回模块</a>
        </div>
      </div>
    )
  }

  return <StepPlayer scenario={scenario} lessonKey={`${params.moduleId}/${lesson?.id ?? ''}`} />
}
