/**
 * 当日用量的账本（宿主侧 ESM，纯逻辑，无 IO，可离线自检）。
 *
 * 只做一件事：把会话事件流里的**已结算调用**折算成「北京时间哪一天、峰还是谷、
 * 哪个模型、命中/未命中/输出各多少 token」，金额在出报表时才按当时的价目表算
 * ——这样官方调价后，历史当天的账会跟着新价重算，不会留下旧价残值。
 *
 * 三个关键约定：
 *   1. **水位线去重**：每个会话记 `lastSeq`，只吃 `seq > lastSeq` 的事件。
 *      会话日志是 append-only 且 seq 连续，所以「补历史」和「实时订阅」重叠也不会重复计费。
 *   2. **按发生时刻定档**：用事件自带的 `time` 判峰/谷，跨峰谷切换的那次调用不会被错算。
 *   3. **只有结算事件计费**：`assistant/message` / `assistant/attempt` 才算一次调用
 *      （usage 优先取事件的 `data.usage`，缺失时取流里最后一个 usage chunk，
 *      与宿主 tokenUsage 投影同口径）；流式 chunk 不计，正在跑的那次调用在结算前不出现。
 *   4. **同一 step 替换而非累加**：一个 step 反复报告 usage 时取最新一份，
 *      `llm/retry-started` 之后重试的那次另算一笔（真实计费口径）。
 *   5. **token 是互斥计数**：`inputTokens` 已经不含缓存命中（见 lib/pricing.js）。
 *
 * @module dsh-liangwen-tide/usage
 */

import { costOfTokens, resolvePriceModel, tokensOf } from './pricing.js'

/** 账本保留天数（够看「今日」和最近几天对照）。 */
export const KEEP_DAYS = 7

const emptyBucket = () => ({ hit: 0, miss: 0, out: 0, calls: 0 })

/**
 * 一条结算事件里的 usage —— 与 `@deepseek-ai/dsh-token-meter` 的 `usageOf` 同口径：
 * `assistant/message` 优先用它自己的 `data.usage`；缺失时（以及所有 `assistant/attempt`）
 * 回落到流里最后一个 `usage` chunk。漏掉 attempt 就会少算失败/重试那几次调用的钱。
 */
export function usageOf(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  if (event.type === 'assistant/message' && data.usage !== undefined && data.usage !== null) return data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  if (!Array.isArray(data.stream)) return undefined
  for (let index = data.stream.length - 1; index >= 0; index -= 1) {
    const record = data.stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

const sameTokens = (left, right) => left.hit === right.hit && left.miss === right.miss && left.out === right.out

/** 空账本。 */
export function createLedger(options = {}) {
  const phaseAt = options.phaseAt
  const dayKeyOf = options.dayKeyOf
  const keepDays = options.keepDays ?? KEEP_DAYS
  if (typeof phaseAt !== 'function' || typeof dayKeyOf !== 'function') {
    throw new Error('createLedger: 需要 phaseAt 与 dayKeyOf')
  }
  /** dayKey -> { peak: Map<model, bucket>, valley: Map<model, bucket> } */
  const days = new Map()
  /**
   * sessionId -> `{ lastSeq, model, sample }`。
   * `sample` 是「当前 step 最近一次结算样本」：同一个 (turn, step) 再来一条就是
   * **替换**而不是累加——这是宿主 tokenUsage 投影的语义；重试时
   * `llm/retry-started` 清空这个槽位，于是重试那次另算一笔（真实计费口径）。
   */
  const sessions = new Map()
  /** 扫过的事件数（含 request/context 等非计费事件）。 */
  let scannedEvents = 0

  const dayOf = (key) => {
    let entry = days.get(key)
    if (entry === undefined) {
      entry = { peak: new Map(), valley: new Map() }
      days.set(key, entry)
      prune()
    }
    return entry
  }

  /** 只留最近 keepDays 天。 */
  function prune() {
    if (days.size <= keepDays) return
    for (const key of [...days.keys()].sort()) {
      if (days.size <= keepDays) break
      days.delete(key)
    }
  }

  /** 取/建某天某档某模型的三桶。 */
  function bucketOf(dayKey, tier, model) {
    const bucket = dayOf(dayKey)[tier]
    let slot = bucket.get(model)
    if (slot === undefined) {
      slot = emptyBucket()
      bucket.set(model, slot)
    }
    return slot
  }

  /** 按 `sign`（+1 记入 / −1 撤回）把一份样本记进它自己那天的账。 */
  function commit(ref, sign) {
    const slot = bucketOf(ref.dayKey, ref.tier, ref.model)
    slot.hit = Math.max(0, slot.hit + sign * ref.tokens.hit)
    slot.miss = Math.max(0, slot.miss + sign * ref.tokens.miss)
    slot.out = Math.max(0, slot.out + sign * ref.tokens.out)
    slot.calls = Math.max(0, slot.calls + sign)
    return slot
  }

  /** 吃一个事件；返回是否计入了一次调用。 */
  function ingest(sessionId, event) {
    if (sessionId === undefined || event === null || typeof event !== 'object') return false
    const seq = Number(event.seq)
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { lastSeq: -1, model: null, sample: null }
      sessions.set(sessionId, state)
    }
    if (Number.isFinite(seq) && seq <= state.lastSeq) return false
    if (Number.isFinite(seq)) state.lastSeq = seq
    scannedEvents += 1

    if (event.type === 'request/context') {
      const model = event.data?.model
      if (typeof model === 'string' && model !== '') state.model = model
      return false
    }
    // 重试开始：当前 step 的样本槽作废 —— 重试那次要另算一笔。
    if (event.type === 'llm/retry-started') {
      const turn = Number(event.data?.turn)
      const step = Number(event.data?.step)
      if (state.sample !== null && state.sample.turn === turn && state.sample.step === step) state.sample = null
      return false
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return false
    const usage = usageOf(event)
    if (usage === undefined || usage === null || typeof usage !== 'object') return false
    const tokens = tokensOf(usage)
    if (tokens.hit === 0 && tokens.miss === 0 && tokens.out === 0) return false

    const time = Number.isFinite(Number(event.time)) ? Number(event.time) : Date.now()
    const turn = Number(event.data?.turn)
    const step = Number(event.data?.step)
    const previous = state.sample !== null && state.sample.turn === turn && state.sample.step === step
      ? state.sample
      : null
    if (previous !== null && sameTokens(previous.tokens, tokens)) return false // 同一 step 的重复样本
    if (previous !== null) commit(previous, -1) // 先撤回旧样本，再记新的（替换而非累加）

    const ref = {
      turn,
      step,
      tokens,
      dayKey: dayKeyOf(time),
      tier: phaseAt(time) === 'peak' ? 'peak' : 'valley',
      model: state.model ?? 'unknown',
    }
    commit(ref, 1)
    state.sample = ref
    return true
  }

  /** 批量吃一个会话的日志（补历史用）。 */
  function ingestAll(sessionId, events) {
    let counted = 0
    for (const event of events ?? []) if (ingest(sessionId, event)) counted += 1
    return counted
  }

  return {
    ingest,
    ingestAll,
    /** 当前已吃进的会话数（补历史的进度参考）。 */
    sessionCount: () => sessions.size,
    /** 已扫过（过水位线）的事件数，含非计费事件。 */
    scannedEventCount: () => scannedEvents,
    has: (dayKey) => days.has(dayKey),
    /** 清空（策略变化要按新档位重算时用）。 */
    reset() {
      days.clear()
      sessions.clear()
      scannedEvents = 0
    },
    /** 某一天的原始 token 账（未计价）。 */
    day(dayKey) {
      const entry = days.get(dayKey)
      return entry === undefined ? null : entry
    },
    /**
     * 出报表：把某一天的 token 账按给定价目表折成金额。
     * @param dayKey - 北京时间自然日。
     * @param prices - 主价目表。
     * @param options - `secondary`（对照币种）、`recent`（要附带的天数）。
     * @returns JSON-safe 报表。
     */
    report(dayKey, prices, options = {}) {
      const empty = { calls: 0, cost: 0, tokens: { hit: 0, miss: 0, out: 0 } }
      const tiers = { peak: structuredClone(empty), valley: structuredClone(empty) }
      const byModel = new Map()
      let unpricedCalls = 0
      const unpricedModels = new Set()

      const entry = days.get(dayKey)
      if (entry !== undefined) {
        for (const tier of ['peak', 'valley']) {
          for (const [model, bucket] of entry[tier]) {
            const column = resolvePriceModel(prices, model)
            const row = column === null ? null : prices?.models?.[column]?.[tier] ?? null
            const cost = row === null ? 0 : costOfTokens(bucket, row)
            const priced = row !== null
            if (!priced) {
              unpricedCalls += bucket.calls
              unpricedModels.add(model)
            }
            tiers[tier].calls += bucket.calls
            tiers[tier].cost += cost
            tiers[tier].tokens.hit += bucket.hit
            tiers[tier].tokens.miss += bucket.miss
            tiers[tier].tokens.out += bucket.out
            const slot = byModel.get(model) ?? { model, column, priced, calls: 0, cost: 0, tokens: { hit: 0, miss: 0, out: 0 } }
            slot.calls += bucket.calls
            slot.cost += cost
            slot.tokens.hit += bucket.hit
            slot.tokens.miss += bucket.miss
            slot.tokens.out += bucket.out
            byModel.set(model, slot)
          }
        }
      }

      const total = structuredClone(empty)
      for (const tier of ['peak', 'valley']) {
        total.calls += tiers[tier].calls
        total.cost += tiers[tier].cost
        total.tokens.hit += tiers[tier].tokens.hit
        total.tokens.miss += tiers[tier].tokens.miss
        total.tokens.out += tiers[tier].tokens.out
      }

      // 对照币种：同一批 token 按另一套官方价目表再算一遍
      let secondary = null
      if (options.secondary !== null && options.secondary !== undefined && entry !== undefined) {
        let cost = 0
        for (const tier of ['peak', 'valley']) {
          for (const [model, bucket] of entry[tier]) {
            const column = resolvePriceModel(options.secondary, model)
            const row = column === null ? null : options.secondary.models[column]?.[tier] ?? null
            if (row !== null) cost += costOfTokens(bucket, row)
          }
        }
        secondary = { currency: options.secondary.currency, symbol: options.secondary.symbol, cost }
      }

      const recent = []
      for (let offset = 0; offset < (options.recent ?? 0); offset += 1) {
        const key = options.dayKeyShift === undefined ? null : options.dayKeyShift(dayKey, offset)
        if (key === null) break
        const dayEntry = days.get(key)
        if (dayEntry === undefined) continue
        let cost = 0
        let calls = 0
        for (const tier of ['peak', 'valley']) {
          for (const [model, bucket] of dayEntry[tier]) {
            calls += bucket.calls
            const column = resolvePriceModel(prices, model)
            const row = column === null ? null : prices?.models?.[column]?.[tier] ?? null
            if (row !== null) cost += costOfTokens(bucket, row)
          }
        }
        recent.push({ day: key, cost, calls })
      }

      return {
        day: dayKey,
        total,
        tiers,
        models: [...byModel.values()].sort((left, right) => right.cost - left.cost || right.calls - left.calls),
        unpriced: { calls: unpricedCalls, models: [...unpricedModels] },
        secondary,
        recent,
      }
    },
  }
}

/**
 * 补历史：把今天（以及昨天创建、可能跨越午夜）的会话日志吃进账本。
 *
 * 活着的会话直接读内存日志（零 IO）；不在内存里的持久化会话走 `readSession`
 * （有 IO，所以只挑创建时间够新的，并且有数量/事件上限兜底）。
 *
 * @param ledger - 账本。
 * @param sources - `{ listSessions, readSession, liveSessions }`。
 * @param options - `sinceMs`、`maxSessions`、`maxEvents`。
 * @returns `{ state, sessions, calls, skipped, errors }`（calls = 计入账本的调用数）。
 */
export async function backfillLedger(ledger, sources, options = {}) {
  const sinceMs = options.sinceMs ?? 0
  const maxSessions = options.maxSessions ?? 200
  const maxEvents = options.maxEvents ?? 200_000
  const result = { state: 'done', sessions: 0, calls: 0, skipped: 0, errors: [] }

  let records = []
  try {
    records = await sources.listSessions()
  } catch (error) {
    return { ...result, state: 'unavailable', errors: [String(error?.message ?? error)] }
  }

  const live = new Map()
  try {
    for (const session of sources.liveSessions()) live.set(String(session.id), session)
  } catch (error) {
    result.errors.push(String(error?.message ?? error))
  }

  for (const record of records) {
    if (result.sessions >= maxSessions || result.calls >= maxEvents) {
      result.skipped += 1
      continue
    }
    const id = String(record?.header?.id ?? record?.id ?? '')
    if (id === '') continue
    try {
      const liveSession = live.get(id)
      if (liveSession !== undefined) {
        result.calls += ledger.ingestAll(id, liveSession.snapshotEvents())
        result.sessions += 1
        continue
      }
      const createdAt = Number(record?.header?.createdAt ?? 0)
      if (!(createdAt >= sinceMs)) {
        result.skipped += 1
        continue
      }
      const snapshot = await sources.readSession(id)
      result.calls += ledger.ingestAll(id, snapshot?.events)
      result.sessions += 1
    } catch (error) {
      result.errors.push(`${id}: ${String(error?.message ?? error)}`)
    }
  }
  return result
}
