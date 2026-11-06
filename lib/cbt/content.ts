import type { Course, Scenario, QuizBank, FaultCase } from './types'
import courseData from '@/content/cbt/course.json'
import doorCycle from '@/content/cbt/scenarios/door-cycle.json'
import psdOverview from '@/content/cbt/scenarios/psd-overview.json'
import quizM01 from '@/content/cbt/quizzes/m01.json'
import faultsData from '@/content/cbt/faults/faults.json'

/**
 * 内容注册表：内容文件放在 content/cbt/ 下，在这里登记即可被课程引用。
 * 量大之后可以改为按 ref 动态 import（next/dynamic 或 fetch）。
 */
const scenarios: Record<string, Scenario> = {
  'door-cycle': doorCycle as unknown as Scenario,
  'psd-overview': psdOverview as unknown as Scenario,
}

const quizBanks: Record<string, QuizBank> = {
  m01: quizM01 as unknown as QuizBank,
}

export const course = courseData as unknown as Course

export const faults = (faultsData as { faults: FaultCase[] }).faults

export function getModule(moduleId: string) {
  return course.modules.find((m) => m.id === moduleId) ?? null
}

export function getScenario(scenarioId: string): Scenario | null {
  return scenarios[scenarioId] ?? null
}

export function getQuizBank(moduleId: string): QuizBank | null {
  return quizBanks[moduleId] ?? null
}

/** 从题库随机抽题组卷（每次评估抽 questionsPerAttempt 题） */
export function buildAttemptQuestions(bank: QuizBank) {
  const pool = [...bank.questions]
  const count = Math.min(bank.questionsPerAttempt, pool.length)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count)
}
