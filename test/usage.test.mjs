/**
 * dsh-liangwen-tide 用量账本自检（lib/usage.js，纯逻辑，不联网）。
 *
 * 覆盖：事件折叠、水位线去重、按事件时刻定档、按北京日归档、补历史（含上限与
 * 失败路径）、报表折算（含对照币种与未匹配模型）。
 *
 * 运行：node test/usage.test.mjs
 */

import assert from 'node:assert/strict'
import { BUILTIN_POLICY, dayKeyOf, phaseAt } from '../lib/policy.js'
import { BUILTIN_PRICES } from '../lib/pricing.js'
import { backfillLedger, createLedger } from '../lib/usage.js'

const CNY = BUILTIN_PRICES.CNY
const USD = BUILTIN_PRICES.USD

const newLedger = () => createLedger({ phaseAt: (ms) => phaseAt(BUILTIN_POLICY, ms), dayKeyOf })

const utc = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm)

/** 一条带 usage 的 assistant/message 事件（默认每个 seq 各自一个 step）。 */
const message = (seq, time, usage, step = seq) => ({ type: 'assistant/message', seq, time, data: { turn: 1, step, usage } })
/** 一条 assistant/attempt 事件：usage 只在流里（失败/被重试的那次调用）。 */
const attempt = (seq, time, usage, step = seq) => ({
  type: 'assistant/attempt',
  seq,
  time,
  data: { turn: 1, step, stream: usage === undefined ? [] : [{ type: 'chunk', chunk: { type: 'usage', usage } }] },
})
/** 同一 step 的重试开始。 */
const retry = (seq, time, step) => ({ type: 'llm/retry-started', seq, time, data: { turn: 1, step } })
/** 一条 route 变更事件。 */
const route = (seq, time, model) => ({ type: 'request/context', seq, time, data: { model } })

// ── 折叠：模型、档位、日归档 ───────────────────────────────────────────────

{
  const ledger = newLedger()
  // 周五 02:00 UTC = 峰时；北京 10:00 = 同一天
  ledger.ingest('s1', route(0, utc(2026, 9, 11, 1, 0), 'deepseek-v4-pro'))
  assert.equal(ledger.ingest('s1', message(1, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000, outputTokens: 0 })), true)
  // 周五 05:00 UTC = 谷时，同一天
  assert.equal(ledger.ingest('s1', message(2, utc(2026, 9, 11, 5, 0), { inputTokens: 0, outputTokens: 1_000_000 })), true)
  // 周五 16:30 UTC = 北京周六 00:30 → 归到 09-12 那个北京日（且周末全天谷）
  assert.equal(ledger.ingest('s1', message(3, utc(2026, 9, 11, 16, 30), { inputTokens: 0, outputTokens: 1_000_000 })), true)

  assert.equal(dayKeyOf(utc(2026, 9, 11, 2, 0)), '2026-09-11')
  assert.equal(dayKeyOf(utc(2026, 9, 11, 16, 30)), '2026-09-12', '北京日边界在 UTC 16:00')

  const report = ledger.report('2026-09-11', CNY, { secondary: USD, recent: 2, dayKeyShift: (key, offset) => (offset === 0 ? key : '2026-09-12') })
  assert.equal(report.day, '2026-09-11')
  assert.equal(report.total.calls, 2)
  // 峰：1M 输入未命中 × ¥9 = ¥9；谷：1M 输出 × ¥13.5 = ¥13.5
  assert.equal(report.tiers.peak.cost.toFixed(2), '9.00')
  assert.equal(report.tiers.valley.cost.toFixed(2), '13.50')
  assert.equal(report.total.cost.toFixed(2), '22.50')
  assert.deepEqual(report.models.map((entry) => entry.model), ['deepseek-v4-pro'])
  assert.equal(report.models[0].calls, 2)
  // 对照：美元表 1.32 + 1.98 = 3.30
  assert.equal(report.secondary.currency, 'USD')
  assert.equal(report.secondary.cost.toFixed(2), '3.30')
  // 第二天（周六全天谷）单独成账
  const nextDay = ledger.report('2026-09-12', CNY, {
    recent: 2,
    dayKeyShift: (key, offset) => (offset === 0 ? '2026-09-12' : '2026-09-05'),
  })
  assert.equal(nextDay.total.calls, 1)
  assert.equal(nextDay.tiers.valley.cost.toFixed(2), '13.50')
  assert.equal(nextDay.tiers.peak.calls, 0)
  assert.equal(nextDay.recent.length, 1, 'recent 只回有账的那天')
  assert.equal(report.recent.length, 2, '今日 + 次日两天都有账')
}

// ── 水位线：seq 不前进就不重复计费 ─────────────────────────────────────────

{
  const ledger = newLedger()
  const event = message(5, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 })
  assert.equal(ledger.ingest('s1', event), true)
  assert.equal(ledger.ingest('s1', event), false, '同一事件不能吃两次')
  assert.equal(ledger.ingest('s1', message(4, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 })), false, '更小的 seq 不回放')
  assert.equal(ledger.ingest('s1', message(6, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 })), true)
  // 另一个会话有自己的水位线
  assert.equal(ledger.ingest('s2', message(1, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 })), true)
  const report = ledger.report('2026-09-11', CNY)
  assert.equal(report.total.calls, 3)
  assert.equal(ledger.sessionCount(), 2)
}

// ── 脏数据与空事件 ─────────────────────────────────────────────────────────

{
  const ledger = newLedger()
  assert.equal(ledger.ingest('s1', route(0, utc(2026, 9, 11, 1, 0), 'deepseek-flash')), false, 'route 变更本身不算一次调用')
  assert.equal(ledger.ingest('s1', message(1, utc(2026, 9, 11, 2, 0), undefined)), false, '没有 usage 不计费')
  assert.equal(ledger.ingest('s1', message(2, utc(2026, 9, 11, 2, 0), { inputTokens: 0, outputTokens: 0 })), false, '零 token 不计费')
  assert.equal(ledger.ingest('s1', message(3, utc(2026, 9, 11, 2, 0), { inputTokens: 100, outputTokens: 0, cacheReadTokens: 999 })), true)
  assert.equal(ledger.ingest('s1', { type: 'user/message', seq: 4, time: Date.now(), data: {} }), false)
  assert.equal(ledger.ingest('s1', null), false)
  const report = ledger.report('2026-09-11', CNY)
  assert.equal(report.total.calls, 1)
  assert.deepEqual(report.total.tokens, { hit: 999, miss: 100, out: 0 }, '命中与未命中是互斥两桶，各自照记')
  // s2 没走过 route，模型未知：token 照记，金额 0 且标记未匹配
  assert.equal(ledger.ingest('s2', message(0, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 })), true)
  const withUnknown = ledger.report('2026-09-11', CNY)
  assert.equal(withUnknown.unpriced.calls, 1)
  assert.deepEqual(withUnknown.unpriced.models, ['unknown'])
  assert.equal(withUnknown.total.cost.toFixed(6), '0.000240', '999 命中 + 100 未命中（峰时 flash）= ¥0.00024')
}

// ── attempt 事件、流内 usage、同 step 替换、重试另算 ───────────────────────

{
  const ledger = newLedger()
  const time = utc(2026, 9, 11, 2, 0) // 峰时
  ledger.ingest('s1', route(0, time, 'deepseek-flash'))

  // 1) assistant/attempt 只有流里带 usage —— 必须也计费（曾经漏掉）
  assert.equal(ledger.ingest('s1', attempt(1, time, { inputTokens: 1000, cacheReadTokens: 5000, outputTokens: 200 }, 7)), true)
  let report = ledger.report('2026-09-11', CNY)
  assert.equal(report.total.calls, 1)
  assert.deepEqual(report.total.tokens, { hit: 5000, miss: 1000, out: 200 })

  // 2) 同一个 step 完全相同的样本：重复报告，不重复计
  assert.equal(ledger.ingest('s1', attempt(2, time, { inputTokens: 1000, cacheReadTokens: 5000, outputTokens: 200 }, 7)), false)
  assert.equal(ledger.report('2026-09-11', CNY).total.tokens.hit, 5000)

  // 3) 同一个 step 换了一份样本：替换而不是累加（流式先给一半、结算再给全量）
  assert.equal(ledger.ingest('s1', message(3, time, { inputTokens: 2000, cacheReadTokens: 9000, outputTokens: 400 }, 7)), true)
  report = ledger.report('2026-09-11', CNY)
  assert.equal(report.total.calls, 1, '替换不额外增加调用次数')
  assert.deepEqual(report.total.tokens, { hit: 9000, miss: 2000, out: 400 })

  // 4) 重试：槽位作废，重试那次另算一笔
  assert.equal(ledger.ingest('s1', retry(4, time, 7)), false)
  assert.equal(ledger.ingest('s1', message(5, time, { inputTokens: 3000, cacheReadTokens: 100, outputTokens: 50 }, 7)), true)
  report = ledger.report('2026-09-11', CNY)
  assert.equal(report.total.calls, 2, '重试后是两笔')
  assert.deepEqual(report.total.tokens, { hit: 9100, miss: 5000, out: 450 })
  // 金额按当前价目表折算：命中 9100×0.04 + 未命中 5000×2 + 输出 450×8 = ¥0.01399 + ...
  const flashPeak = CNY.models['deepseek-flash'].peak
  assert.equal(report.total.cost, (9100 * flashPeak.cacheHit + 5000 * flashPeak.cacheMiss + 450 * flashPeak.output) / 1e6)

  // 5) 不同 step 各算一笔
  assert.equal(ledger.ingest('s1', message(6, time, { inputTokens: 10, outputTokens: 10 }, 8)), true)
  assert.equal(ledger.report('2026-09-11', CNY).total.calls, 3)

  // 6) assistant/message 优先用自己的 data.usage；缺失时回落到流里
  assert.equal(ledger.ingest('s1', {
    type: 'assistant/message', seq: 7, time,
    data: { turn: 1, step: 9, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 77 } } }] },
  }), true)
  assert.equal(ledger.ingest('s1', {
    type: 'assistant/message', seq: 8, time,
    data: {
      turn: 1, step: 10,
      usage: { inputTokens: 1, outputTokens: 2 },
      stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 999 } } }],
    },
  }), true)
  const tokens = ledger.report('2026-09-11', CNY).total.tokens
  assert.equal(tokens.miss, 5000 + 10 + 77 + 1, '缺失时回落到流内 usage；有 data.usage 时以它为准')
}

// ── reset：换档位要能清干净重来 ────────────────────────────────────────────

{
  const ledger = newLedger()
  ledger.ingest('s1', message(0, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 }))
  assert.equal(ledger.report('2026-09-11', CNY).total.calls, 1)
  ledger.reset()
  assert.equal(ledger.report('2026-09-11', CNY).total.calls, 0)
  assert.equal(ledger.sessionCount(), 0)
  assert.equal(ledger.scannedEventCount(), 0)
  // reset 之后同一事件可以重新吃进去（水位线也清了）
  assert.equal(ledger.ingest('s1', message(0, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 })), true)
}

// ── 补历史 ─────────────────────────────────────────────────────────────────

/** 造一份假的事件来源。 */
function makeSources({ stored = [], live = [], failRead = [], listError = null } = {}) {
  const read = []
  return {
    read,
    sources: {
      listSessions: async () => {
        if (listError !== null) throw new Error(listError)
        return stored.map((session) => ({ header: { id: session.id, createdAt: session.createdAt }, live: false, persisted: true }))
      },
      readSession: async (id) => {
        read.push(id)
        if (failRead.includes(id)) throw new Error('读不出来')
        const session = stored.find((entry) => entry.id === id)
        return { events: session.events }
      },
      liveSessions: () => live.map((session) => ({ id: session.id, snapshotEvents: () => session.events })),
    },
  }
}

{
  const ledger = newLedger()
  const events = [
    route(0, utc(2026, 9, 11, 1, 0), 'deepseek-flash'),
    message(1, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 }),
  ]
  const { sources, read } = makeSources({
    stored: [
      { id: 'live-1', createdAt: utc(2026, 9, 11), events },
      { id: 'old-1', createdAt: utc(2026, 8, 1), events },
      { id: 'today-1', createdAt: utc(2026, 9, 11), events },
    ],
    live: [{ id: 'live-1', events }],
  })
  const report = await backfillLedger(ledger, sources, { sinceMs: utc(2026, 9, 10) })
  assert.equal(report.state, 'done')
  assert.equal(report.sessions, 2, '活着的 + 今天创建的')
  assert.equal(report.skipped, 1, '8 月的老会话跳过（超出 sinceMs）')
  assert.deepEqual(read, ['today-1'], '活着的会话直接读内存日志，只有持久化会话才走 readSession')
  assert.equal(ledger.report('2026-09-11', CNY).total.calls, 2)
  assert.equal(ledger.scannedEventCount(), 4, '两个会话各折叠 2 个事件')

  // 补完历史后，实时再来一条只加一次
  assert.equal(ledger.ingest('live-1', message(2, utc(2026, 9, 11, 5, 0), { outputTokens: 1_000_000 })), true)
  assert.equal(ledger.report('2026-09-11', CNY).total.calls, 3)
}

{
  // 持久化会话走 readSession（有 IO），且失败只记错误不中断
  const ledger = newLedger()
  const { sources, read } = makeSources({
    stored: [
      { id: 'today-1', createdAt: utc(2026, 9, 11), events: [message(0, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 })] },
      { id: 'today-2', createdAt: utc(2026, 9, 11), events: [] },
      { id: 'today-3', createdAt: utc(2026, 9, 11), events: [message(0, utc(2026, 9, 11, 2, 0), { inputTokens: 2_000_000 })] },
    ],
    failRead: ['today-2'],
  })
  const report = await backfillLedger(ledger, sources, { sinceMs: utc(2026, 9, 10) })
  assert.equal(report.state, 'done')
  assert.deepEqual(read, ['today-1', 'today-2', 'today-3'])
  assert.equal(report.sessions, 2, '读失败的会话不计入已折叠数，但会记进 errors')
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0], /today-2/)
  assert.equal(ledger.report('2026-09-11', CNY).total.calls, 2)
}

{
  // 上限：会话数封顶
  const ledger = newLedger()
  const stored = Array.from({ length: 5 }, (_, index) => ({
    id: `s${index}`,
    createdAt: utc(2026, 9, 11),
    events: [message(0, utc(2026, 9, 11, 2, 0), { inputTokens: 1_000_000 })],
  }))
  const { sources } = makeSources({ stored })
  const report = await backfillLedger(ledger, sources, { sinceMs: utc(2026, 9, 10), maxSessions: 2 })
  assert.equal(report.sessions, 2)
  assert.equal(report.skipped, 3)
  assert.equal(ledger.report('2026-09-11', CNY).total.calls, 2)
}

{
  // 会话索引不可用：如实回报，不抛
  const ledger = newLedger()
  const { sources } = makeSources({ listError: '没有 sessionQuery' })
  const report = await backfillLedger(ledger, sources, {})
  assert.equal(report.state, 'unavailable')
  assert.equal(report.sessions, 0)
  assert.match(report.errors[0], /sessionQuery/)
}

console.log('dsh-liangwen-tide: usage 自检 46 项通过')
