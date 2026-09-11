/**
 * dsh-liangwen-tide 峰谷策略解析层自检（lib/policy.js，纯函数，不联网）。
 *
 * 里面两段 HTML 是从官方定价页真实抓下来的片段（2026-09-11），
 * 其余是句式变体（换措辞/换时区/改成只说空闲时段/页面改版）。
 *
 * 运行：node test/policy.test.mjs
 */

import assert from 'node:assert/strict'
import {
  BUILTIN_POLICY,
  combineReports,
  describeWindows,
  normalizePolicy,
  parsePricingHtml,
  samePolicy,
  stripHtml,
} from '../lib/policy.js'

/** 官方英文页真实片段。 */
const EN_PAGE = `<p>(3) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak).</p><p>(4) For more details on concurrency limits, please refer to <a href="/quick_start/rate_limit">Rate Limit &amp; Isolation</a>.</p>`

/** 官方中文页真实片段。 */
const ZH_PAGE = `<p>(3) 空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。</p><p>(4) 更多并发限制细节，请参考<a href="/zh-cn/quick_start/rate_limit">限速与隔离</a>。</p>`

const PEAK = [
  { start: 60, end: 240 },
  { start: 360, end: 600 },
]

// ── stripHtml ──────────────────────────────────────────────────────────────

const stripped = stripHtml(EN_PAGE)
assert.ok(!stripped.includes('<'), '去标签要干净')
assert.ok(stripped.includes('Rate Limit & Isolation'), '实体要还原')
assert.ok(stripped.includes('Peak hours are'), '正文要留住')

// ── 真实两页都能解析，并且互相一致 ────────────────────────────────────────

const en = parsePricingHtml(EN_PAGE, { locale: 'en' })
const zh = parsePricingHtml(ZH_PAGE, { locale: 'zh' })

assert.ok(en !== null, '英文页必须解析出来')
assert.ok(zh !== null, '中文页必须解析出来')
assert.deepEqual(en.windows, PEAK, '英文页 → UTC 01:00–04:00、06:00–10:00')
assert.equal(en.weekendAllValley, true, 'Monday through Friday → 周末全天谷时')
assert.equal(en.timezone, 'UTC')
assert.equal(en.assumedTimezone, false, '句子里写了 UTC，不该是假定')
assert.deepEqual(zh.windows, PEAK, '中文页北京时间 9–12、14–18 → 同一组 UTC 窗口')
assert.equal(zh.weekendAllValley, true, '周一至周五 → 周末全天谷时')
assert.equal(zh.timezone, 'UTC+8')
assert.equal(zh.assumedTimezone, false)
assert.ok(samePolicy(en, zh), '中英文两页必须等价')

// ── 合成：两页一致 = 高置信 ───────────────────────────────────────────────

const combined = combineReports(en, zh, { now: Date.UTC(2026, 8, 11, 6, 0) })
assert.deepEqual(combined.windows, PEAK)
assert.equal(combined.source, 'official:en+zh')
assert.equal(combined.confidence, 'high')
assert.equal(combined.conflict, false)
assert.equal(combined.fetchedAt, '2026-09-11T06:00:00.000Z')

// 只有一页可用 = 中置信；两页打架 = 取英文页并标冲突；两页都不行 = null
assert.equal(combineReports(en, null).source, 'official:en')
assert.equal(combineReports(en, null).confidence, 'medium')
assert.equal(combineReports(null, zh).source, 'official:zh')
const conflictPage = `<p>Peak hours are 05:00 - 08:00 UTC, every day.</p>`
const conflicted = combineReports(en, parsePricingHtml(conflictPage, { locale: 'en' }))
assert.equal(conflicted.source, 'official:en')
assert.equal(conflicted.confidence, 'low')
assert.equal(conflicted.conflict, true)
assert.equal(combineReports(null, null), null)

// ── 句式变体 ───────────────────────────────────────────────────────────────

const variants = [
  {
    label: '冒号句式 + 每天（无周末特例）',
    html: '<p>Peak hours: 02:00–05:00, 07:00–11:00 UTC every day.</p>',
    windows: [{ start: 120, end: 300 }, { start: 420, end: 660 }],
    weekendAllValley: false,
  },
  {
    label: '全角冒号与「至」分隔',
    html: '<p>高峰时段：北京时间每天 10:00 至 12:00、15:00 至 17:00。</p>',
    windows: [{ start: 120, end: 240 }, { start: 420, end: 540 }],
    weekendAllValley: false,
  },
  {
    label: '反向句式：只说空闲时段（旧口径，取补集）',
    html: '<p>(3) Off-peak discounts are available from 16:30 - 00:30 UTC.</p>',
    windows: [{ start: 30, end: 990 }],
    weekendAllValley: false,
  },
  {
    label: '时区没写：中文页按北京时间假定',
    html: '<p>高峰时段为周一至周五 9:00 - 12:00、14:00 - 18:00。</p>',
    windows: PEAK,
    weekendAllValley: true,
    assumedTimezone: true,
  },
]

for (const variant of variants) {
  const report = parsePricingHtml(variant.html, { locale: variant.label.includes('中文') ? 'zh' : 'en' })
  assert.ok(report !== null, `${variant.label}：应解析成功`)
  assert.deepEqual(report.windows, variant.windows, `${variant.label}：窗口`)
  assert.equal(report.weekendAllValley, variant.weekendAllValley, `${variant.label}：周末规则`)
  if (variant.assumedTimezone !== undefined) {
    assert.equal(report.assumedTimezone, variant.assumedTimezone, `${variant.label}：时区假定标记`)
  }
}

// ── 不该解析成功的情况：一律 null，宁可继续用旧策略 ────────────────────────

const junk = [
  '<p>This page has no schedule at all.</p>',
  '<p>Peak hours are whenever demand is highest.</p>',
  '<p>Off-peak rates are half of the peak rates.</p>',
  '<p>Peak hours are 25:00 - 30:00 UTC.</p>',
  '<p>Peak hours are 01:00 - 01:00 UTC.</p>',
  '<p>Peak hours are 00:00 - 23:59 UTC, Monday through Friday.</p>',
  '',
  '<script>var peak = "01:00-04:00"</script>',
]
for (const html of junk) {
  assert.equal(parsePricingHtml(html, { locale: 'en' }), null, `不应解析出规则：${html.slice(0, 40)}`)
}

// ── normalizePolicy 的边界 ─────────────────────────────────────────────────

assert.deepEqual(normalizePolicy(BUILTIN_POLICY), {
  windows: PEAK,
  weekendAllValley: true,
})
assert.equal(normalizePolicy({ windows: [], weekendAllValley: true }), null, '空窗口非法')
assert.equal(normalizePolicy({ windows: [{ start: 60, end: 240 }, { start: 120, end: 300 }] }), null, '重叠非法')
assert.equal(normalizePolicy({ windows: [{ start: 0, end: 1440 }] }), null, '越界非法')
assert.equal(normalizePolicy({ windows: 'nope' }), null, '类型非法')
assert.equal(normalizePolicy(null), null)
assert.deepEqual(
  normalizePolicy({ windows: [{ start: 360, end: 600 }, { start: 60, end: 240 }] }).windows,
  PEAK,
  '乱序窗口应被排序',
)

// ── 展示文案 ───────────────────────────────────────────────────────────────

assert.equal(describeWindows(BUILTIN_POLICY), '09:00–12:00、14:00–18:00')
assert.equal(
  describeWindows({ windows: [{ start: 30, end: 990 }] }),
  '08:30–次日 00:30',
  '跨零点窗口要写「次日」',
)

// 内置兜底与当前官方口径一致（官改价时这里会先响）
assert.ok(samePolicy(BUILTIN_POLICY, en), '内置兜底应与官方当前口径一致')

console.log(`dsh-liangwen-tide: policy 自检 ${31 + variants.length * 3 + junk.length} 项通过`)
