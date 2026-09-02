import type { GarminClient } from '../garmin/client.js'
import {
  RUNNING_SKILLS,
  TRAINING_PHILOSOPHIES,
  findSkills,
  findTrainingPhilosophies,
  formatSkillCard,
  formatSkillSummary,
  formatTrainingPhilosophy,
  type CoachingLanguage,
  type TrainingPhilosophy,
} from '../knowledge/running-skills.js'
import { asObject, formatActivity } from '../utils/format.js'
import type { GarminTool } from './types.js'

const MODES = ['explain', 'personalized'] as const
const PERFORMANCE_BASES = ['recent_race', 'time_trial', 'no_recent_benchmark'] as const
const LOAD_PREFERENCES = ['steady', 'hard_easy', 'mixed'] as const
const INTENSITY_PREFERENCES = ['pace', 'heart_rate', 'rpe', 'mixed'] as const

type Mode = typeof MODES[number]
type PerformanceBasis = typeof PERFORMANCE_BASES[number]
type LoadPreference = typeof LOAD_PREFERENCES[number]
type IntensityPreference = typeof INTENSITY_PREFERENCES[number]

const INTAKE_FIELDS = [
  'goal',
  'current_performance',
  'performance_basis',
  'training_background',
  'availability',
  'health_constraints',
  'has_warning_symptoms',
  'training_preference',
  'max_quality_sessions_per_week',
  'intensity_guidance_preference',
] as const

type IntakeField = typeof INTAKE_FIELDS[number]

interface RunningAdviceInput {
  mode: Mode
  query?: string
  includeRecentActivities: boolean
  language: CoachingLanguage
  goal?: string
  currentPerformance?: string
  performanceBasis?: PerformanceBasis
  trainingBackground?: string
  availability?: string
  healthConstraints?: string
  hasWarningSymptoms?: boolean
  trainingPreference?: LoadPreference
  maxQualitySessionsPerWeek?: number
  intensityGuidancePreference?: IntensityPreference
}

export function runningAdviceTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_running_advice',
      description:
        'Explain eight running workout types and the Hansons, Daniels, Norwegian-threshold, and polarized training philosophies. '
        + 'Use mode="personalized" for any athlete-specific recommendation or plan. Personalized mode requires the complete intake, '
        + 'returns focused questions for missing information, and stops without workout material when warning symptoms are reported.',
      inputSchema: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: {
            type: 'string',
            enum: [...MODES],
            description: 'explain describes concepts; personalized gates athlete-specific advice behind a complete safety intake.',
          },
          query: {
            type: 'string',
            description: 'Optional workout type or philosophy, such as threshold, Daniels, Hansons, Norwegian, or polarized.',
          },
          language: {
            type: 'string',
            enum: ['zh-CN', 'en'],
            description: 'Response language. Defaults to zh-CN.',
          },
          include_recent_activities: {
            type: 'boolean',
            description: 'After a complete intake, include up to ten recent Garmin running activities as supporting context.',
          },
          goal: {
            type: 'string',
            description: 'Target distance/event, future ISO YYYY-MM-DD date, and completion or ideal/minimum time goal.',
          },
          current_performance: {
            type: 'string',
            description: 'Representative race/time trial from the last two years: distance, result, ISO date, effort, and material conditions; or explicitly no benchmark.',
          },
          performance_basis: {
            type: 'string',
            enum: [...PERFORMANCE_BASES],
          },
          training_background: {
            type: 'string',
            description: 'Running history, recent 4-8 week average/peak volume, frequency, long run, quality work, and recent interruptions or load jumps.',
          },
          availability: {
            type: 'string',
            description: 'Available days/time, fixed rest and long-run days, terrain/facility limits, strength time, and whether double days are possible.',
          },
          health_constraints: {
            type: 'string',
            description: 'Current/past-year pain or injury, relevant disease or medication, sleep, stress, and recovery; explicitly state none where applicable.',
          },
          has_warning_symptoms: {
            type: 'boolean',
            description: 'True for current chest discomfort, unusual breathlessness with mild activity, fainting/dizziness, or abnormal palpitations.',
          },
          training_preference: {
            type: 'string',
            enum: [...LOAD_PREFERENCES],
            description: 'steady, clearly separated hard_easy, or mixed/no preference.',
          },
          max_quality_sessions_per_week: {
            type: 'integer',
            minimum: 0,
            maximum: 7,
            description: 'Athlete ceiling, not a prescription.',
          },
          intensity_guidance_preference: {
            type: 'string',
            enum: [...INTENSITY_PREFERENCES],
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async run(args) {
      const input = parseInput(args)
      return createRunningAdvice(client, input)
    },
  }
}

async function createRunningAdvice(
  client: GarminClient,
  input: RunningAdviceInput,
): Promise<Record<string, unknown>> {
  if (
    input.mode === 'personalized'
    && (
      input.hasWarningSymptoms === true
      || containsUnnegatedWarningSymptom(input.healthConstraints ?? '')
    )
  ) {
    return safetyStop(input.language)
  }

  if (input.mode === 'personalized') {
    const missingFields = missingIntakeFields(input)
    if (missingFields.length > 0) {
      return {
        requiresUserInput: true,
        mode: 'personalized',
        missingFields,
        questions: missingFields.map((field) => ({
          field,
          question: intakeQuestion(field, input.language),
        })),
        instruction: input.language === 'zh-CN'
          ? '请只询问上述缺失或矛盾信息。在用户回答前，不要生成逐日/逐周计划，也不要猜测训练量、VDOT、阈值配速或健康状况。'
          : 'Ask only for the missing or contradictory information. Do not generate a daily or weekly plan, or guess volume, VDOT, threshold pace, or health status, until the athlete answers.',
      }
    }
  }

  const skills = findSkills(input.query)
  const matchedSkills = input.mode === 'personalized'
    ? skills.map((skill) => formatSkillSummary(skill, input.language))
    : skills.map((skill) => formatSkillCard(skill, input.language))
  const philosophies = input.mode === 'personalized'
    ? orderedPhilosophies(input.trainingPreference!)
    : findTrainingPhilosophies(input.query)

  const result: Record<string, unknown> = {
    requiresUserInput: false,
    mode: input.mode,
    matchedSkills,
    trainingPhilosophies: philosophies.map((philosophy) => (
      formatTrainingPhilosophy(philosophy, input.language)
    )),
    totalSkillsInKnowledgeBase: RUNNING_SKILLS.length,
    totalPhilosophiesInKnowledgeBase: TRAINING_PHILOSOPHIES.length,
    evidenceLegend: input.language === 'zh-CN'
      ? {
          system_principle: '体系理念：用于说明该方法如何训练，不代表它优于其他体系。',
          research_evidence: '研究证据：结论受样本、项目、周期和结局指标限制。',
          application_inference: '应用推断：面向当前跑者的保守转化，并非原研究直接结论。',
        }
      : {
          system_principle: 'System principle: defines how a method trains, not proof that it is superior.',
          research_evidence: 'Research evidence: interpretation is limited by sample, sport, duration, and outcomes.',
          application_inference: 'Application inference: a conservative athlete-specific translation, not a direct study conclusion.',
        },
  }

  if (input.mode === 'explain') {
    result.instruction = input.language === 'zh-CN'
      ? '只解释所请求的概念，不要据此虚构个人训练计划；制定建议前改用 personalized 模式完成问询。'
      : 'Explain the requested concept without inventing a personal schedule; complete personalized intake before planning.'
    return result
  }

  result.athleteContext = {
    goal: input.goal!,
    currentPerformance: input.currentPerformance!,
    performanceBasis: input.performanceBasis!,
    trainingBackground: input.trainingBackground!,
    availability: input.availability!,
    healthConstraints: input.healthConstraints!,
    hasWarningSymptoms: input.hasWarningSymptoms!,
    trainingPreference: input.trainingPreference!,
    maxQualitySessionsPerWeek: input.maxQualitySessionsPerWeek!,
    intensityGuidancePreference: input.intensityGuidancePreference!,
  }
  result.planningInstructions = planningInstructions(input)

  if (input.includeRecentActivities) {
    try {
      const activities = await client.getActivities(0, 10)
      result.recentRunningActivities = activities
        .filter(isRunningActivity)
        .map((activity) => formatActivity(asObject(activity), 'compact'))
    } catch {
      result.recentRunningActivities = input.language === 'zh-CN'
        ? '近期 Garmin 跑步记录暂时不可用；不能用猜测补齐。'
        : 'Recent Garmin running activities are temporarily unavailable; do not replace them with guesses.'
    }
  }

  return result
}

function parseInput(args: Record<string, unknown>): RunningAdviceInput {
  const mode = enumValue(args.mode, MODES)
  if (!mode) throw new Error('mode must be explain or personalized.')
  const language = args.language === undefined ? 'zh-CN' : enumValue(args.language, ['zh-CN', 'en'] as const)
  if (!language) throw new Error('language must be zh-CN or en.')

  const includeRecentActivities = args.include_recent_activities === undefined
    ? false
    : args.include_recent_activities
  if (typeof includeRecentActivities !== 'boolean') {
    throw new Error('include_recent_activities must be a boolean.')
  }

  const query = textValue(args.query)
  return {
    mode,
    language,
    includeRecentActivities,
    ...(query ? { query } : {}),
    ...optionalTextProperty('goal', args.goal),
    ...optionalTextProperty('currentPerformance', args.current_performance),
    ...optionalEnumProperty('performanceBasis', args.performance_basis, PERFORMANCE_BASES),
    ...optionalTextProperty('trainingBackground', args.training_background),
    ...optionalTextProperty('availability', args.availability),
    ...optionalTextProperty('healthConstraints', args.health_constraints),
    ...(typeof args.has_warning_symptoms === 'boolean'
      ? { hasWarningSymptoms: args.has_warning_symptoms }
      : {}),
    ...optionalEnumProperty('trainingPreference', args.training_preference, LOAD_PREFERENCES),
    ...(typeof args.max_quality_sessions_per_week === 'number'
      ? { maxQualitySessionsPerWeek: args.max_quality_sessions_per_week }
      : {}),
    ...optionalEnumProperty(
      'intensityGuidancePreference',
      args.intensity_guidance_preference,
      INTENSITY_PREFERENCES,
    ),
  }
}

function missingIntakeFields(input: RunningAdviceInput): IntakeField[] {
  const missing: IntakeField[] = []
  if (!input.goal || !hasConcreteGoal(input.goal)) missing.push('goal')
  if (
    !input.performanceBasis
    || !input.currentPerformance
    || (input.performanceBasis !== 'no_recent_benchmark'
      && !hasRecentPerformance(input.currentPerformance))
    || (input.performanceBasis === 'no_recent_benchmark'
      && !explicitlyNoBenchmark(input.currentPerformance))
  ) {
    if (!missing.includes('current_performance')) {
      missing.push('current_performance')
    }
    if (!input.performanceBasis) missing.push('performance_basis')
  }
  if (!input.trainingBackground || !hasTrainingBackground(input.trainingBackground)) {
    missing.push('training_background')
  }
  if (!input.availability || !hasAvailability(input.availability)) missing.push('availability')

  const healthConflict = input.hasWarningSymptoms === false
    && containsUnnegatedWarningSymptom(input.healthConstraints ?? '')
  if (!input.healthConstraints || !hasHealthDetails(input.healthConstraints) || healthConflict) {
    missing.push('health_constraints')
  }
  if (typeof input.hasWarningSymptoms !== 'boolean' || healthConflict) {
    missing.push('has_warning_symptoms')
  }
  if (!input.trainingPreference) missing.push('training_preference')
  if (
    input.maxQualitySessionsPerWeek === undefined
    || !Number.isInteger(input.maxQualitySessionsPerWeek)
    || input.maxQualitySessionsPerWeek < 0
    || input.maxQualitySessionsPerWeek > 7
  ) {
    missing.push('max_quality_sessions_per_week')
  }
  if (!input.intensityGuidancePreference) missing.push('intensity_guidance_preference')
  return [...new Set(missing)]
}

function safetyStop(language: CoachingLanguage): Record<string, unknown> {
  return {
    requiresUserInput: false,
    mode: 'personalized',
    safetyStop: true,
    instruction: language === 'zh-CN'
      ? '用户报告了胸部不适、轻微活动异常气短、晕厥/眩晕或异常心悸等警示症状。不要读取 Garmin 活动来绕过此保护，不要生成高强度训练或逐日计划，也不要诊断；请建议暂停训练并先取得医疗专业人员许可。若症状正在发生、严重或加重，应寻求当地紧急医疗帮助。'
      : 'The athlete reported chest discomfort, unusual breathlessness with mild activity, fainting/dizziness, or abnormal palpitations. Do not fetch Garmin activities to bypass this guard, generate hard training or a daily plan, or diagnose. Advise pausing training and obtaining medical clearance first; seek local emergency help for current, severe, or worsening symptoms.',
  }
}

function planningInstructions(input: RunningAdviceInput): string[] {
  const zh = input.language === 'zh-CN'
  const instructions = zh
    ? [
        '强度必须锚定当前成绩、RPE/谈话测试和可恢复性，不能用目标成绩或手表预测反推训练配速。',
        '开头说明采用的配速/RPE/心率锚点或分区体系；同一计划不要混用不同体系的区间编号。',
        '说明借用了哪些训练体系原则、为什么适合，以及哪些部分没有采用；不要声称某体系普遍优于其他体系。',
        '给出周总量或总时长范围；每节课写明目的、强度、热身、冷身，并明确轻松日、恢复日和休息日。',
        '遵守用户的质量课上限，但该上限不是必须达到的数量。',
        '默认不安排双阈值；挪威阈值只借鉴受控、非力竭和困难/轻松日分离，除非跑者训练龄、跑量、恢复和监测条件都足够。',
        '每个调整周期只增加有限变量，不同时明显增加跑量、跑频、长跑和高强度。',
        '写明因疼痛、疾病、睡眠不足、异常疲劳、天气或比赛而降级/停止的规则，并在 2–4 周后复评。',
      ]
    : [
        'Anchor intensity to current performance, RPE/talk test, and recoverability; never reverse-engineer pace from a goal or watch prediction.',
        'Name the pace/RPE/heart-rate anchors or zone system at the start; do not mix zone numbers from different systems.',
        'State which system principles were borrowed, why they fit, and what was not used; do not claim universal superiority.',
        'Give a weekly volume or time range; state each session purpose, intensity, warm-up, cool-down, easy/recovery days, and rest days.',
        'Respect the athlete quality-session ceiling, but do not treat the ceiling as a target.',
        'Do not prescribe double threshold by default. Borrow controlled, non-exhaustive threshold and hard/easy separation unless training age, volume, recovery, and monitoring are sufficient.',
        'Change only a limited number of variables per cycle; do not simultaneously raise volume, frequency, long-run load, and intensity.',
        'Write downgrade/stop rules for pain, illness, sleep loss, unusual fatigue, weather, or racing, and reassess in 2–4 weeks.',
      ]
  if (input.performanceBasis === 'no_recent_benchmark') {
    instructions.unshift(zh
      ? '没有可信近期基准：先用轻松基础训练或低风险基准测试，不给出精确阈值/间歇配速或 VDOT。'
      : 'There is no trustworthy recent benchmark: begin with easy base work or a low-risk benchmark; do not prescribe exact threshold/interval pace or VDOT.')
  }
  return instructions
}

function intakeQuestion(field: IntakeField, language: CoachingLanguage): string {
  const questions: Record<IntakeField, Record<CoachingLanguage, string>> = {
    goal: {
      'zh-CN': '目标是什么？请给出比赛/距离、未来的 ISO YYYY-MM-DD 日期，以及完赛、理想和/或最低时间目标。',
      en: 'What is the goal? Give the event/distance, a future ISO YYYY-MM-DD date, and completion and/or ideal/minimum time goal.',
    },
    current_performance: {
      'zh-CN': '请给出近两年代表性比赛或计时测试的距离、成绩、不晚于今天的 ISO 日期、是否全力及天气/赛道/海拔影响；没有近期基准也请明确说明。',
      en: 'Give a representative race or time trial from the last two years: distance, result, non-future ISO date, whether all-out, and material weather/course/altitude effects; explicitly state if none exists.',
    },
    performance_basis: {
      'zh-CN': '当前水平依据是 recent_race、time_trial，还是 no_recent_benchmark？',
      en: 'Is the performance basis recent_race, time_trial, or no_recent_benchmark?',
    },
    training_background: {
      'zh-CN': '请说明跑龄、最近 4–8 周平均/最高周跑量或时长、每周跑步天数、最长跑、质量课，以及近三个月中断或负荷突增。',
      en: 'Describe running history, average/peak 4–8 week volume or time, days per week, longest run, quality work, and recent interruptions or load jumps.',
    },
    availability: {
      'zh-CN': '每周可跑几天、各天多久、固定休息日和长跑日是什么？还有哪些场地/器材限制、力量训练时间，是否具备双练条件？',
      en: 'How many days and how much time are available? State fixed rest/long-run days, terrain/facility limits, strength time, and whether double days are possible.',
    },
    health_constraints: {
      'zh-CN': '请说明当前疼痛/伤病、过去一年主要跑伤、相关心血管/代谢/肾脏疾病、影响心率的药物，以及睡眠、压力和恢复；没有也请逐项明确。若文字包含警示症状，请与布尔答案保持一致。',
      en: 'Describe current pain/injury, major injury in the past year, relevant cardiovascular/metabolic/kidney disease, medication affecting heart rate, and sleep/stress/recovery; explicitly state none where applicable. Keep warning-symptom text consistent with the boolean answer.',
    },
    has_warning_symptoms: {
      'zh-CN': '目前是否有胸部不适、轻微活动异常气短、晕厥/眩晕或异常心悸？请明确填写 true 或 false，并解决与健康描述的任何矛盾。',
      en: 'Are there current chest symptoms, unusual breathlessness with mild activity, fainting/dizziness, or abnormal palpitations? Answer true or false and resolve any conflict with the health text.',
    },
    training_preference: {
      'zh-CN': '偏好 steady（均匀稳定）、hard_easy（艰苦/轻松分明），还是 mixed（混合/无偏好）？',
      en: 'Do you prefer steady, clearly separated hard_easy, or mixed/no preference?',
    },
    max_quality_sessions_per_week: {
      'zh-CN': '每周最多愿意且有条件完成几次质量课？请给出 0–7 的整数；这是个人上限，不是处方。',
      en: 'What is the maximum quality sessions per week you can and will complete (integer 0–7)? This is a ceiling, not a prescription.',
    },
    intensity_guidance_preference: {
      'zh-CN': '执行强度更喜欢 pace、heart_rate、rpe 还是 mixed？',
      en: 'Do you prefer pace, heart_rate, rpe, or mixed intensity guidance?',
    },
  }
  return questions[field][language]
}

function hasConcreteGoal(value: string): boolean {
  const futureDate = validIsoDates(value).some((date) => date.getTime() > startOfToday())
  const hasEvent = /\b(?:3k|5k|10k|half|marathon|trail|ultra)\b|公里|千米|马拉松|半马|全马|越野|比赛|event/iu.test(value)
  const hasObjective = /完赛|目标|理想|最低|以内|小时|分钟|finish|goal|ideal|minimum|under|sub[- ]?\d/iu.test(value)
  return futureDate && hasEvent && hasObjective
}

function hasRecentPerformance(value: string): boolean {
  const now = startOfToday()
  const earliest = new Date(new Date(now).getFullYear() - 2, new Date(now).getMonth(), new Date(now).getDate()).getTime()
  const hasRecentDate = validIsoDates(value).some((date) => {
    const timestamp = date.getTime()
    return timestamp >= earliest && timestamp <= now
  })
  const hasDistance = /\b\d+(?:\.\d+)?\s*(?:km|k|m)\b|\d+(?:\.\d+)?\s*(?:公里|千米|米)/iu.test(value)
  const hasResult = /\b\d{1,2}:\d{2}(?::\d{2})?\b|\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b|\d+(?:\.\d+)?\s*(?:小时|分钟)/iu.test(value)
  return hasRecentDate && hasDistance && hasResult
}

function explicitlyNoBenchmark(value: string): boolean {
  return /no[_ -]?recent[_ -]?benchmark|no recent (?:race|time trial)|暂无.{0,6}(?:基准|比赛|测试)|没有.{0,6}(?:近期|最近).{0,6}(?:基准|比赛|测试)/iu.test(value)
}

function hasTrainingBackground(value: string): boolean {
  return value.trim().length >= 12
    && containsQuantity(value)
    && /周|week|跑龄|年|月|公里|km|小时|hour|long|最长|质量|间歇|阈值/iu.test(value)
}

function hasAvailability(value: string): boolean {
  return value.trim().length >= 8
    && containsQuantity(value)
    && /天|日|分钟|小时|days?|minutes?|hours?|rest|休息|长跑|long run/iu.test(value)
}

function hasHealthDetails(value: string): boolean {
  if (value.trim().length < 4) return false
  if (/^(?:none|no constraints?|无|没有|均无|无特殊情况)$/iu.test(value.trim())) return false
  return value.trim().length >= 8
    && /伤|痛|病|药|睡眠|压力|恢复|injur|pain|disease|medication|sleep|stress|recover|无|没有|否认|none|no /iu.test(value)
}

function containsUnnegatedWarningSymptom(value: string): boolean {
  if (!value.trim()) return false
  const terms = [
    /胸(?:部)?(?:痛|闷|不适)/giu,
    /(?:轻微|日常|低强度)?活动.{0,8}(?:异常)?气短/giu,
    /(?:异常)?(?:呼吸困难|喘不过气)/giu,
    /(?:晕厥|昏厥|眩晕)/giu,
    /异常心悸/giu,
    /chest (?:pain|pressure|tightness|discomfort)/giu,
    /unusual (?:breathlessness|shortness of breath)/giu,
    /(?:fainting|syncope|dizziness)/giu,
    /abnormal palpitations?/giu,
  ]
  for (const term of terms) {
    for (const match of value.matchAll(term)) {
      const index = match.index ?? 0
      const prefix = value.slice(Math.max(0, index - 18), index)
      if (!/(?:无|没有|否认|未出现|不存在|并无|no|denies|without)\s*[^，。；;,.]{0,10}$/iu.test(prefix)) {
        return true
      }
    }
  }
  return false
}

function validIsoDates(value: string): Date[] {
  const matches = value.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []
  const dates: Date[] = []
  for (const match of matches) {
    const [yearText, monthText, dayText] = match.split('-')
    const year = Number(yearText)
    const month = Number(monthText)
    const day = Number(dayText)
    const date = new Date(year, month - 1, day)
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      dates.push(date)
    }
  }
  return dates
}

function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function containsQuantity(value: string): boolean {
  return /\d|\b(?:one|two|three|four|five|six|seven)\b|[一二两三四五六七八九十]/iu.test(value)
}

function orderedPhilosophies(preference: LoadPreference): TrainingPhilosophy[] {
  const preferred = preference === 'steady'
    ? 'hansons'
    : preference === 'hard_easy'
      ? 'polarized'
      : 'daniels'
  return [...TRAINING_PHILOSOPHIES].sort((left, right) => (
    Number(right.id === preferred) - Number(left.id === preferred)
  ))
}

function isRunningActivity(value: unknown): boolean {
  const activity = asObject(value)
  const activityType = activity.activityType
  const type = typeof activityType === 'object' && activityType !== null
    ? asObject(activityType).typeKey
    : activityType
  const normalized = String(type ?? activity.type ?? '').toLowerCase()
  return normalized.includes('run') || normalized.includes('trail')
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalTextProperty<K extends string>(
  key: K,
  value: unknown,
): { [P in K]?: string } {
  const text = textValue(value)
  return text ? { [key]: text } as { [P in K]?: string } : {}
}

function optionalEnumProperty<K extends string, const T extends readonly string[]>(
  key: K,
  value: unknown,
  allowed: T,
): { [P in K]?: T[number] } {
  const parsed = enumValue(value, allowed)
  return parsed ? { [key]: parsed } as { [P in K]?: T[number] } : {}
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  return typeof value === 'string' && allowed.includes(value)
    ? value as T[number]
    : undefined
}
