'use client'

import { useCallback, useMemo, useState } from 'react'
import type { Scenario, ScenarioStep } from './types'

/**
 * 场景步骤引擎：驱动「分步式 3D 演练」。
 * 职责：维护当前步骤指针，暴露下一步/上一步/跳转，并归一化每步的动作参数。
 * 3D 呈现（高亮/爆炸/机位/动画）由 StepPlayer 消费本 hook 的输出完成。
 */
export function useScenarioEngine(scenario: Scenario) {
  const [index, setIndex] = useState(0)
  const total = scenario.steps.length

  const step: ScenarioStep = useMemo(() => scenario.steps[Math.min(index, total - 1)], [scenario, index, total])

  const next = useCallback(() => setIndex((i) => Math.min(i + 1, total - 1)), [total])
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), [])
  const goto = useCallback((i: number) => setIndex(Math.max(0, Math.min(i, total - 1))), [total])
  const reset = useCallback(() => setIndex(0), [])

  return {
    index,
    total,
    step,
    isFirst: index === 0,
    isLast: index === total - 1,
    next,
    prev,
    goto,
    reset,
  }
}
