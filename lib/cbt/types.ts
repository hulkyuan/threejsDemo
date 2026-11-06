/**
 * PSD CBT 课程数据模型（与需求文档对应）
 *
 * 设计原则：
 * 1. 所有教学内容（场景步骤、题库、故障库）均为 JSON 数据，与代码解耦；
 *    新增课程只需新增 JSON 文件，不改代码。
 * 2. 全高 / 半高 PSD 通过 systemType 区分，同一套引擎渲染两种系统。
 */

/** PSD 系统类型：全高 / 半高 / 两者通用 */
export type SystemType = 'full' | 'half' | 'both'

/** 课程内一节课的形态 */
export type LessonKind =
  | 'scenario' // 3D 分步演练（步骤引擎驱动）
  | 'doc' // 图文 / 文档页（运营或维护信息文档）
  | 'video' // 视频课（旁白 + 动画）
  | 'quiz' // 子模块评估

export interface Lesson {
  id: string
  title: string
  kind: LessonKind
  /** 预计学习时长（分钟），全部 lesson 时长之和应凑满模块课时 */
  durationMin: number
  /** kind=scenario → scenario id；kind=doc → 文档资源路径；kind=video → 视频地址 */
  ref?: string
}

export interface Module {
  id: string
  /** 需求文档中的主题序号 */
  index: number
  title: string
  titleEn?: string
  systemType: SystemType
  summary?: string
  lessons: Lesson[]
}

export interface Course {
  id: string
  title: string
  version: string
  /** 需求：PSD-CBT 模块应为 20 小时 */
  totalHours: number
  modules: Module[]
}

/* -------------------------------------------------------------------------
 * 场景步骤引擎（装配/拆卸、开关门顺序、维护/测试、激活停用、故障排查共用）
 * ---------------------------------------------------------------------- */

export interface ScenarioStepAction {
  /** 高亮零件：按模型节点名做「忽略大小写子串」匹配 */
  highlight?: string[]
  /** 爆炸进度 0-100，用于装配 / 拆卸分步演示 */
  explode?: number
  /** 相机机位 [x, y, z]；缺省保持用户当前视角 */
  camera?: [number, number, number]
  /** glTF 动画 clip 名（如门开 / 门关动画），由步骤引擎触发播放 */
  animation?: string
}

export interface ScenarioStep {
  id: string
  title: string
  /** 旁白文本（后续可挂 audio 音频文件路径） */
  narration: string
  audio?: string
  /** 安全提示（安全程序、报警及事件处理主题） */
  safetyNote?: string
  action: ScenarioStepAction
}

export interface Scenario {
  id: string
  title: string
  systemType: SystemType
  /** 本场景使用的 GLB 模型（全高 / 半高各一份） */
  model: string
  description?: string
  /** 对应需求"分步激活与停用指南"的演练类别 */
  category: 'assembly' | 'operation' | 'maintenance' | 'testing' | 'fault'
  steps: ScenarioStep[]
}

/* -------------------------------------------------------------------------
 * 评估引擎（需求：每个子模块 20 题，表格汇总，颜色编码对错，显示得分）
 * ---------------------------------------------------------------------- */

export type QuestionType = 'single' | 'multi' | 'truefalse'

export interface QuizOption {
  id: string
  text: string
}

export interface QuizQuestion {
  id: string
  type: QuestionType
  stem: string
  options: QuizOption[]
  /** 正确选项 id（多选为数组） */
  answer: string[]
  explanation?: string
}

export interface QuizBank {
  moduleId: string
  title: string
  /** 每次评估抽取的题数（需求：20） */
  questionsPerAttempt: number
  questions: QuizQuestion[]
}

export interface QuizAttempt {
  id: string
  moduleId: string
  startedAt: string
  submittedAt: string
  /** 题目 id → 学员作答的选项 id */
  answers: Record<string, string[]>
  score: number
  total: number
  passed: boolean
}

/* -------------------------------------------------------------------------
 * 故障仿真引擎（需求：实用故障仿真、故障诊断与排除程序）
 * ---------------------------------------------------------------------- */

export interface FaultCase {
  id: string
  code: string
  title: string
  systemType: SystemType
  /** 故障现象 */
  symptom: string
  possibleCauses: string[]
  /** 分步排查指南（需求：故障与缺陷分步排查指南） */
  diagnosticSteps: {
    step: number
    action: string
    expected: string
  }[]
  correctiveAction: string
  safetyNote?: string
}

/* -------------------------------------------------------------------------
 * 进度存储（学员端本地 IndexedDB/localStorage，接口与后端 SQLite 对齐）
 * ---------------------------------------------------------------------- */

export interface LessonProgress {
  lessonKey: string // `${moduleId}/${lessonId}`
  status: 'not-started' | 'in-progress' | 'completed'
  updatedAt: string
}

export interface TraineeProfile {
  id: string
  name: string
  role: 'trainee' | 'instructor'
}
