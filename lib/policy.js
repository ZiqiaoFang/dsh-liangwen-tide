/**
 * 官方峰谷策略的解析层（宿主侧 ESM，纯函数，无 IO，可离线自检）。
 *
 * DeepSeek 官方定价页里那句话就是唯一权威口径，例如 2026-09 的两语版本：
 *   EN: "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday
 *        (all other hours are off-peak)."
 *   ZH: "高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。"
 *
 * 解析策略是「按优先级试几种句式」，任何一种都要同时满足：
 *   · 句子里能找到至少一个 HH:MM - HH:MM 区间；
 *   · 能判断时区（UTC / 北京时间），判断不了就按语种假定，并标记 assumed；
 *   · 归一化到 UTC 分钟后是 1..6 个区间、互不重叠、总覆盖不超过 16 小时。
 * 任一不满足就返回 null —— 宁可继续用内置/上次的旧策略，也不要吃进半懂不懂的规则。
 *
 * 另外支持「反向句式」（官方若改成只说空闲时段）：off-peak 区间取补集当峰时。
 *
 * @module dsh-liangwen-tide/policy
 */

/**
 * 内置兜底策略：与官方 2026-08-17 起的口径一致。
 * 浏览器半 lib/client.js 里有一份等价常量（离线首帧用），自检会比对两者。
 */
export const BUILTIN_POLICY = {
  windows: [
    { start: 1 * 60, end: 4 * 60 },
    { start: 6 * 60, end: 10 * 60 },
  ],
  weekendAllValley: true,
  source: 'builtin',
}

/** 官方定价页（两种语言各取一份，用来交叉校验）。 */
export const PRICING_URLS = {
  en: 'https://api-docs.deepseek.com/quick_start/pricing',
  zh: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
}

const MINUTES_PER_DAY = 24 * 60
/** 峰时总覆盖的合理上限：一天最多 16 小时（旧口径的 00:30–16:30 正好 16 小时）。 */
const MAX_PEAK_MINUTES = 16 * 60
/** 峰时窗口数量的合理上限（官方是两个）。 */
const MAX_WINDOWS = 6

/** 六种「时间区间」写法：01:00 - 04:00 / 01:00–04:00 / 01:00至04:00 / 01:00 to 04:00 … */
const TIME_RANGE = /(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:-|‐|–|—|−|~|～|至|到|to)\s*(\d{1,2})\s*[:：]\s*(\d{2})/gi

/**
 * 按优先级排列的句式。`invert: true` 表示句子里列的是**空闲**时段，
 * 需要取补集才是峰时。
 */
const STRATEGIES = [
  { id: 'en-peak', locale: 'en', invert: false, re: /peak hours?\s*(?:are|is|[:：])?\s*([^.]{0,300})/i },
  { id: 'zh-peak', locale: 'zh', invert: false, re: /高峰时段\s*(?:为|是|[:：])?\s*([^。]{0,300})/ },
  { id: 'en-off-peak', locale: 'en', invert: true, re: /off-?peak[^.]{0,160}/i },
  { id: 'zh-off-peak', locale: 'zh', invert: true, re: /(?:空闲时段|错峰时段|低谷时段|优惠时段)[^。]{0,200}/ },
]

/** 周末全天谷时的说法。 */
const WEEKEND_CLAUSE = /(?:monday|mon\.?)\s*(?:through|thru|to|until|~|-|–|—)\s*(?:friday|fri\.?)|weekdays?\b|周一至周五|周一至週五|星期一至星期五|工作日/i
/** 明确「每天/全周」的说法。 */
const ALL_DAYS_CLAUSE = /(?:every|all)\s*days?|\bdaily\b|\b7\s*days\b|每天|每日|全周|七天|一周七天|所有日期/i
/** 时区说法。 */
const BEIJING_CLAUSE = /北京时间|北京時間|beijing|\bCST\b|\bUTC\s*\+\s*8\b/i
const UTC_CLAUSE = /\bUTC\b|\bGMT\b|世界标准时间|协调世界时/i

/** 去掉标签，压缩空白，解掉最常见的一小撮实体。 */
export function stripHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x27|39);/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

const mod = (value, base) => ((value % base) + base) % base

/** 取一天内的补集（支持跨零点窗口）。 */
function complement(windows) {
  const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end)
  const gaps = []
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]
    const next = sorted[(index + 1) % sorted.length]
    gaps.push({ start: current.end, end: next.start })
  }
  return gaps
}

function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const window of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && window.start <= last.end) {
      last.end = Math.max(last.end, window.end)
      continue
    }
    merged.push({ ...window })
  }
  return merged
}

/** 一天内的分钟数是否合法（0..1439，起止不能相同）。 */
const minute = (value) => Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY

/**
 * 校验并归一化一份策略。任何不合规都返回 null。
 * @param value - 未知形状的候选（来自解析、JSON、localStorage）。
 * @returns 归一化后的 `{ windows, weekendAllValley }`，或 null。
 */
export function normalizePolicy(value) {
  if (value === null || typeof value !== 'object') return null
  const rawWindows = value.windows
  if (!Array.isArray(rawWindows) || rawWindows.length === 0 || rawWindows.length > MAX_WINDOWS) return null
  const windows = []
  for (const entry of rawWindows) {
    if (entry === null || typeof entry !== 'object') return null
    const start = Number(entry.start)
    const end = Number(entry.end)
    if (!minute(start) || !minute(end) || start === end) return null
    windows.push({ start, end })
  }
  const total = windows.reduce((sum, window) => sum + mod(window.end - window.start, MINUTES_PER_DAY), 0)
  if (total <= 0 || total > MAX_PEAK_MINUTES) return null
  const merged = mergeWindows(windows)
  if (merged.length !== windows.length) return null // 有重叠：规则本身说不通
  return {
    windows: merged,
    weekendAllValley: value.weekendAllValley === true,
  }
}

/** 两个策略是否等价（窗口集合 + 周末规则）。 */
export function samePolicy(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) return false
  if (left.weekendAllValley !== right.weekendAllValley) return false
  const key = (value) => value.windows.map((window) => `${window.start}-${window.end}`).sort().join(',')
  return key(left) === key(right)
}

/**
 * 从一页（已去标签的）正文里解析峰谷规则。
 * @param text - stripHtml 之后的页面正文。
 * @param options - `locale`（'en' | 'zh'）与时区缺省假定。
 * @returns `{ windows, weekendAllValley, timezone, assumedTimezone, strategy, invert, evidence }` 或 null。
 */
export function parseRule(text, options = {}) {
  const locale = options.locale ?? 'en'
  const body = String(text)
  for (const strategy of STRATEGIES) {
    // 同一页里关键词可能出现多次（中文页的「空闲时段价格为高峰时段价格的一半」
    // 就先命中一次高峰时段），所以每种句式都要把全部出现位置试完。
    const source = strategy.re.source
    const flags = strategy.re.flags.includes('g') ? strategy.re.flags : `${strategy.re.flags}g`
    for (const match of body.matchAll(new RegExp(source, flags))) {
      const evidence = match[0].trim()
      const ranges = [...evidence.matchAll(TIME_RANGE)]
      if (ranges.length === 0) continue
      const report = buildReport(ranges, evidence, { ...strategy, locale })
      if (report !== null) return report
    }
  }
  return null
}

function buildReport(ranges, evidence, strategy) {
  const offset = BEIJING_CLAUSE.test(evidence)
    ? 8 * 60
    : UTC_CLAUSE.test(evidence)
      ? 0
      : undefined
  // 句子里没写时区：英文页按 UTC、中文页按北京时间（官方两种写法本来就等价）。
  const assumed = offset === undefined
  const resolvedOffset = offset ?? (strategy.locale === 'zh' ? 8 * 60 : 0)

  /** 时钟读数 → 一天内分钟数；越界（25:00、12:99）返回 null，不做取模兜底。 */
  const clock = (hour, minute) => {
    const h = Number(hour)
    const m = Number(minute)
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null
    if (h < 0 || h > 24 || m < 0 || m > 59 || (h === 24 && m !== 0)) return null
    return mod(h * 60 + m, MINUTES_PER_DAY) // 24:00 视作 00:00
  }

  const inZone = []
  for (const range of ranges) {
    const start = clock(range[1], range[2])
    const end = clock(range[3], range[4])
    if (start === null || end === null) return null
    if (start === end) return null
    inZone.push({ start, end })
  }
  if (inZone.length === 0) return null

  const utcWindows = inZone.map((window) => ({
    start: mod(window.start - resolvedOffset, MINUTES_PER_DAY),
    end: mod(window.end - resolvedOffset, MINUTES_PER_DAY),
  }))
  const peak = strategy.invert ? complement(utcWindows) : utcWindows

  const weekendAllValley = WEEKEND_CLAUSE.test(evidence) && !ALL_DAYS_CLAUSE.test(evidence)
  const normalized = normalizePolicy({ windows: peak, weekendAllValley })
  if (normalized === null) return null
  return {
    ...normalized,
    timezone: resolvedOffset === 0 ? 'UTC' : 'UTC+8',
    assumedTimezone: assumed,
    strategy: strategy.id,
    invert: strategy.invert === true,
    evidence: evidence.slice(0, 240),
  }
}

/**
 * 解析一页官方文档 HTML。
 * @param html - 页面 HTML。
 * @param options - `locale`。
 * @returns 策略报告或 null。
 */
export function parsePricingHtml(html, options = {}) {
  return parseRule(stripHtml(html), options)
}

/**
 * 交叉校验中英文两页，合成一份可下发的策略。
 * 两页都有且一致 → 高置信；只有一页 → 中置信；两页打架 → 取英文页并标 conflict。
 * @param en - 英文页报告（或 null）。
 * @param zh - 中文页报告（或 null）。
 * @param options - `now`（毫秒时间戳）。
 * @returns 策略对象或 null。
 */
export function combineReports(en, zh, options = {}) {
  const now = options.now ?? Date.now()
  const fetchedAt = new Date(now).toISOString()
  const base = (report, source, confidence, conflict) => ({
    windows: report.windows,
    weekendAllValley: report.weekendAllValley,
    source,
    confidence,
    conflict,
    strategy: report.strategy,
    timezone: report.timezone,
    assumedTimezone: report.assumedTimezone === true,
    evidence: report.evidence,
    fetchedAt,
  })
  if (en !== null && zh !== null) {
    if (samePolicy(en, zh)) return base(en, 'official:en+zh', 'high', false)
    return base(en, 'official:en', 'low', true)
  }
  if (en !== null) return base(en, 'official:en', 'medium', false)
  if (zh !== null) return base(zh, 'official:zh', 'medium', false)
  return null
}

/** 把策略渲染成人类可读的北京时间时段说明（提示气泡用）。 */
export function describeWindows(policy) {
  const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  return policy.windows
    .map((window) => {
      // 跨零点与否要按北京时间看：UTC 的 16:30→00:30 正好落在北京 00:30→08:30。
      const start = mod(window.start + 8 * 60, MINUTES_PER_DAY)
      const end = mod(window.end + 8 * 60, MINUTES_PER_DAY)
      return end <= start ? `${clock(start)}–次日 ${clock(end)}` : `${clock(start)}–${clock(end)}`
    })
    .join('、')
}

/** 某一时刻在给定策略下是否按峰时计价（宿主侧计费用；浏览器半有一份等价实现）。 */
export function isPeakAt(policy, date) {
  if (policy.weekendAllValley && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) return false
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  for (const window of policy.windows) {
    const inside = window.start < window.end
      ? minutes >= window.start && minutes < window.end
      : minutes >= window.start || minutes < window.end // 跨零点窗口
    if (inside) return true
  }
  return false
}

/** `'peak' | 'valley'`。 */
export function phaseAt(policy, ms) {
  return isPeakAt(policy, new Date(ms)) ? 'peak' : 'valley'
}

/** 北京时间（UTC+8）的自然日 key：`YYYY-MM-DD`。计费按事件发生的那个北京日归档。 */
export function dayKeyOf(ms, offsetMinutes = 8 * 60) {
  const shifted = new Date(ms + offsetMinutes * 60_000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}
