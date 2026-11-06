'use client'

import { QuizRunner } from '@/components/cbt/quiz-runner'
import { useParams } from 'next/navigation'

export default function QuizPage() {
  const params = useParams<{ moduleId: string }>()
  return <QuizRunner moduleId={params.moduleId} />
}
