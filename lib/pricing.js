/**
 * 官方价目表的解析与计费（宿主侧 ESM，纯函数，无 IO，可离线自检）。
 *
 * 和峰谷时段同一页，官方还挂着价目表（每百万 tokens，分峰/谷两档）：
 *   ZH: 百万tokens输入（缓存命中） 空闲时段 0.02元 高峰时段 0.04元 …（人民币）
 *   EN: 1M INPUT TOKENS (CACHE HIT) OFF-PEAK $0.003 PEAK $0.006 …（美元）
 * 中英文两版都解析：中文页给人民币口径，英文页给美元口径，两边互为交叉校验，
 * 也省掉任何汇率假设。
 *
 * 计费口径（与官方扣费规则一致）：
 *   输入命中 = usage.cacheReadTokens
 *   输入未命中 = usage.inputTokens   ← 宿主口径已是「未命中」，不能再减命中
 *   输出 = usage.outputTokens（思考 token 已计入输出）
 *   费用 = (命中×命中价 + 未命中×未命中价 + 输出×输出价) / 1e6
 * 按**调用发生时刻**的档位计价：同一次会话跨峰谷切换不会漂移。
 *
 * @module dsh-liangwen-tide/pricing
 */

const PER_MILLION = 1_000_000

/** 价目表里没提到、或页面解析失败时的兜底价（官方 2026-08 口径）。 */
export const BUILTIN_PRICES = {
  CNY: {
    currency: 'CNY',
    symbol: '¥',
    source: 'builtin',
    models: {
      'deepseek-flash': {
        valley: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      },
      'deepseek-v4-pro': {
        valley: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
        peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
      },
    },
  },
  USD: {
    currency: 'USD',
    symbol: '$',
    source: 'builtin',
    models: {
      'deepseek-flash': {
        valley: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
        peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
      },
      'deepseek-v4-pro': {
        valley: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
        peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      },
    },
  },
}

/** DSH 用的模型 id → 官方价目表列名（拿不准时还有归一化匹配兜底）。 */
const MODEL_ALIASES = {
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
}

const stripHtmlText = (value) => String(value)
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/\s+/g, ' ')
  .trim()

/** 抽出页面里所有表格的行/单元格文本。 */
export function extractTableRows(html) {
  const tables = [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map((match) => match[0])
  const rows = []
  for (const table of tables) {
    for (const row of table.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...row[0].matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map((cell) => stripHtmlText(cell[0]))
      if (cells.length > 0) rows.push(cells)
    }
  }
  return rows
}

/** 价格数值：去掉货币符号、千分位、全角字符后取数；不是数字返回 null。 */
export function parsePriceValue(text) {
  const match = /-?\d+(?:[.,]\d+)*/.exec(String(text).replace(/[，、\s]/g, ''))
  if (match === null) return null
  const value = Number(match[0].replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

/** 官方价目表的列名 → 归一化 key：去脚注、版本号、vision/exp 等修饰词。 */
export function normalizeModelKey(value) {
  return String(value).toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, ' ')
    .replace(/\bv?\d+(?:\.\d+)*\b/g, ' ')
    .replace(/\b(exp|experimental|preview|vision|thinking|non-thinking|latest)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 指标识别：先看未命中，再看命中，最后输出。 */
function metricOf(text) {
  const value = String(text)
  if (/cache\s*miss|未命中|未命中|cache\s*miss\s*tokens/i.test(value)) return 'cacheMiss'
  if (/cache\s*hit|命中/i.test(value)) return 'cacheHit'
  if (/output|输出/i.test(value)) return 'output'
  return null
}

/** 档位识别：空闲/off-peak 先判，免得 OFF-PEAK 里的 PEAK 把高峰吃掉。 */
function tierOf(text) {
  const value = String(text)
  if (/off-?peak|空闲|低谷|错峰/i.test(value)) return 'valley'
  if (/peak|高峰/i.test(value)) return 'peak'
  return null
}

/** 行里的货币符号。 */
function currencyOf(cells) {
  const joined = cells.join(' ')
  if (/元|￥|¥|CNY|RMB|人民币/i.test(joined)) return 'CNY'
  if (/\$|USD|美元/i.test(joined)) return 'USD'
  return null
}

/**
 * 解析一张官方价目表。
 * @param html - 页面 HTML。
 * @param options - `locale`（'zh' | 'en'，仅用于兜底判货币）与 `fetchedAt`。
 * @returns `{ currency, symbol, source, models, evidence }` 或 null。
 */
export function parsePriceTable(html, options = {}) {
  const rows = extractTableRows(html)
  if (rows.length === 0) return null

  // 表头：第一格是「模型 / MODEL」，其余是各模型列名。
  const header = rows.find((cells) => /^(模型|model)$/i.test(cells[0] ?? ''))
  if (header === undefined || header.length < 3) return null
  const columns = header.slice(1).map((cell) => String(cell).replace(/\s*[(（]\d+[)）]\s*$/, '').trim())
  if (columns.length === 0 || columns.some((column) => column === '')) return null

  const models = {}
  let currency = null
  let metric = null
  let priced = 0
  for (const cells of rows) {
    if (cells === header) continue
    for (const cell of cells) {
      const found = metricOf(cell)
      if (found !== null) metric = found
    }
    const tierIndex = cells.findIndex((cell) => tierOf(cell) !== null)
    if (tierIndex === -1 || metric === null) continue
    const tier = tierOf(cells[tierIndex])
    currency ??= currencyOf(cells)
    const values = cells.slice(tierIndex + 1)
    if (values.length === 0) continue
    for (const [index, column] of columns.entries()) {
      const price = parsePriceValue(values[index] ?? '')
      if (price === null) continue
      models[column] ??= { valley: {}, peak: {} }
      models[column][tier][metric] = price
      priced += 1
    }
  }
  if (priced === 0) return null

  // 完整性：每列三档价格都要齐（缺一个就整表不采信，免得半张表算出假账）。
  for (const column of columns) {
    const entry = models[column]
    for (const tier of ['valley', 'peak']) {
      for (const key of ['cacheHit', 'cacheMiss', 'output']) {
        if (typeof entry?.[tier]?.[key] !== 'number') return null
      }
    }
  }
  currency ??= options.locale === 'zh' ? 'CNY' : 'USD'
  return {
    currency,
    symbol: currency === 'CNY' ? '¥' : '$',
    source: `official:${options.locale ?? 'en'}`,
    fetchedAt: options.fetchedAt ?? null,
    models,
    evidence: columns.join(', '),
  }
}

/**
 * 挑一份「主口径」价目表：人民币优先（中文页是元，用户看的就是它），美元留作对照。
 * @param zh - 中文页价表（或 null）。
 * @param en - 英文页价表（或 null）。
 * @param options - `fetchedAt`。
 * @returns `{ primary, secondary }`，两者都可能为 null。
 */
export function combinePriceTables(zh, en, options = {}) {
  const stamp = { fetchedAt: options.fetchedAt ?? null }
  const primary = zh !== null ? { ...zh, ...stamp } : en !== null ? { ...en, ...stamp } : null
  const secondary = primary === null
    ? null
    : zh !== null && primary.currency === 'CNY'
      ? (en !== null ? { ...en, ...stamp } : null)
      : (zh !== null ? { ...zh, ...stamp } : null)
  return { primary, secondary }
}

/**
 * 模型 id → 价目表列名。先查别名表，再按归一化 key 精确匹配，
 * 最后按 token 重合度挑最像的一列；都挑不出来返回 null。
 * @param prices - 一份价目表。
 * @param model - DSH 会话里的模型 id。
 * @returns 列名或 null。
 */
export function resolvePriceModel(prices, model) {
  if (prices === null || prices === undefined || typeof model !== 'string' || model === '') return null
  const columns = Object.keys(prices.models)
  if (columns.length === 0) return null
  if (columns.includes(model)) return model

  const alias = MODEL_ALIASES[model]
  if (alias !== undefined && columns.includes(alias)) return alias

  const wanted = normalizeModelKey(model)
  const normalized = new Map(columns.map((column) => [normalizeModelKey(column), column]))
  if (normalized.has(wanted)) return normalized.get(wanted)

  // 归一化后互相包含（deepseek-flash ⊆ deepseek-flash-exp 之类）取最长的
  let best = null
  for (const [key, column] of normalized) {
    if (key === '' || wanted === '') continue
    if (key.startsWith(wanted) || wanted.startsWith(key)) {
      if (best === null || key.length > best.key.length) best = { key, column }
    }
  }
  if (best !== null) return best.column

  // 兜底：按 '-' 切词取重合最多的那一列
  const tokens = new Set(wanted.split('-').filter(Boolean))
  let scored = null
  for (const [key, column] of normalized) {
    const overlap = key.split('-').filter((part) => tokens.has(part)).length
    if (overlap > 0 && (scored === null || overlap > scored.overlap)) scored = { overlap, column }
  }
  return scored?.column ?? null
}

/**
 * usage → 三桶 token（互不重叠，与宿主 `TokenUsage` 约定一致）。
 *
 * 关键：宿主口径是**互斥计数**——适配器把 DeepSeek 的 `prompt_tokens`
 * 减掉了缓存命中部分再放进 `inputTokens`（`inputTokens = prompt_tokens − 命中`），
 * 所以 `inputTokens` 就是「未命中」，`cacheReadTokens` 就是「命中」，
 * 两者不能再互相剪（剪了会把命中的量错记成未命中，并凭空吃掉一大截命中量）。
 * `reasoningTokens` 已计入 `outputTokens`，不单独计费。
 *
 * @param usage - `{ inputTokens, outputTokens, cacheReadTokens? }`。
 * @returns `{ hit, miss, out }`。
 */
export function tokensOf(usage) {
  const safe = (value) => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : 0
  }
  return {
    hit: safe(usage?.cacheReadTokens),
    miss: safe(usage?.inputTokens),
    out: safe(usage?.outputTokens),
  }
}

/**
 * 三桶 token × 一档单价 → 金额。
 * @param tokens - `{ hit, miss, out }`。
 * @param row - `{ cacheHit, cacheMiss, output }`（每百万 tokens）。
 * @returns 金额（与价目表同币种）。
 */
export function costOfTokens(tokens, row) {
  return (
    Math.max(0, tokens.hit) * row.cacheHit
    + Math.max(0, tokens.miss) * row.cacheMiss
    + Math.max(0, tokens.out) * row.output
  ) / PER_MILLION
}

/**
 * 给一次调用的 usage 计价。
 * @param usage - `{ inputTokens, outputTokens, cacheReadTokens? }`（互斥计数）。
 * @param model - 会话里的模型 id。
 * @param tier - `'peak' | 'valley'`（按事件发生时刻判定）。
 * @param prices - 一份价目表。
 * @returns `{ priced, model, tokens: { hit, miss, out }, cost }`。
 */
export function priceCall(usage, model, tier, prices) {
  const tokens = tokensOf(usage)
  const column = resolvePriceModel(prices, model)
  if (column === null) return { priced: false, model: null, tokens, cost: 0 }
  const row = prices.models[column]?.[tier === 'peak' ? 'peak' : 'valley']
  if (row === undefined) return { priced: false, model: column, tokens, cost: 0 }
  return { priced: true, model: column, tokens, cost: costOfTokens(tokens, row) }
}

/** 价目表 → 展示用摘要（提示气泡里写清用的哪套价格）。 */
export function describePrices(prices) {
  if (prices === null || prices === undefined) return '价格表不可用'
  const where = prices.source === 'builtin' ? '内置价格表' : `官方定价页（${prices.source === 'official:zh' ? '中文页' : '英文页'}）`
  return `${where} · ${prices.currency === 'CNY' ? '人民币' : '美元'}/百万 tokens`
}
