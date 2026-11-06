'use client'

import type { LessonProgress, QuizAttempt } from './types'

/**
 * 进度与成绩存储。
 * 当前实现：浏览器 localStorage（离线可用，满足单机培训场景）。
 * 升级到 LAN 服务器（SQLite）时，仅需把本模块换成 fetch API 实现，签名不变。
 */

const KEY_PROGRESS = 'cbt:progress:v1'
const KEY_ATTEMPTS = 'cbt:attempts:v1'

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(value))
}

export function getAllProgress(): Record<string, LessonProgress> {
  return readJSON(KEY_PROGRESS, {})
}

export function markLesson(lessonKey: string, status: LessonProgress['status']) {
  const all = getAllProgress()
  all[lessonKey] = { lessonKey, status, updatedAt: new Date().toISOString() }
  writeJSON(KEY_PROGRESS, all)
}

export function getAllAttempts(): QuizAttempt[] {
  return readJSON(KEY_ATTEMPTS, [] as QuizAttempt[])
}

export function saveAttempt(attempt: QuizAttempt) {
  const all = getAllAttempts()
  all.push(attempt)
  writeJSON(KEY_ATTEMPTS, all)
}

/** 讲师端汇总：按模块取最高分 */
export function bestScoreByModule(): Record<string, number> {
  const best: Record<string, number> = {}
  for (const a of getAllAttempts()) {
    const ratio = a.total > 0 ? a.score / a.total : 0
    if (!best[a.moduleId] || ratio > best[a.moduleId]) best[a.moduleId] = ratio
  }
  return best
}
