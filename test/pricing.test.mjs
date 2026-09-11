/**
 * dsh-liangwen-tide 价目表与计费自检（lib/pricing.js，纯函数，不联网）。
 *
 * 两张表是 2026-09-11 从官方定价页真实抓下来的表格片段（结构、数字、单位都是原文），
 * 其余是句式变体与坏数据。
 *
 * 运行：node test/pricing.test.mjs
 */

import assert from 'node:assert/strict'
import { EN_TABLE, ZH_TABLE } from './fixtures.mjs'
import {
  BUILTIN_PRICES,
  combinePriceTables,
  costOfTokens,
  describePrices,
  extractTableRows,
  normalizeModelKey,
  parsePriceTable,
  parsePriceValue,
  priceCall,
  resolvePriceModel,
  tokensOf,
} from '../lib/pricing.js'

// ── 原始解析件 ─────────────────────────────────────────────────────────────

assert.equal(parsePriceValue('$0.022'), 0.022)
assert.equal(parsePriceValue('1,234.5元'), 1234.5)
assert.equal(parsePriceValue('13.5元'), 13.5)
assert.equal(parsePriceValue('免费'), null)
assert.equal(parsePriceValue(''), null)

assert.equal(normalizeModelKey('deepseek-v4-flash'), 'deepseek-flash')
assert.equal(normalizeModelKey('deepseek-v4-flash-vision-exp'), 'deepseek-flash')
assert.equal(normalizeModelKey('deepseek-v4-pro'), 'deepseek-pro')
assert.equal(normalizeModelKey('deepseek-flash (1)'), 'deepseek-flash')
assert.equal(normalizeModelKey('deepseek-flash'), 'deepseek-flash')

const rows = extractTableRows(ZH_TABLE)
assert.equal(rows.length, 7, '中文表 7 行')
assert.equal(rows[0][0], '模型')
assert.equal(rows[0][1], 'deepseek-flash (1)', '列名里的脚注是上标（去标签后带空格）')

// ── 两张真实表都能解析出完整价目 ───────────────────────────────────────────

const zh = parsePriceTable(ZH_TABLE, { locale: 'zh', fetchedAt: '2026-09-11T06:00:00.000Z' })
const en = parsePriceTable(EN_TABLE, { locale: 'en', fetchedAt: '2026-09-11T06:00:00.000Z' })

assert.ok(zh !== null, '中文表要解析成功')
assert.equal(zh.currency, 'CNY')
assert.equal(zh.symbol, '¥')
assert.deepEqual(zh.models['deepseek-flash'].valley, { cacheHit: 0.02, cacheMiss: 1, output: 4 })
assert.deepEqual(zh.models['deepseek-flash'].peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 })
assert.deepEqual(zh.models['deepseek-v4-pro'].valley, { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 })
assert.deepEqual(zh.models['deepseek-v4-pro'].peak, { cacheHit: 0.3, cacheMiss: 9, output: 27 })

assert.ok(en !== null, '英文表要解析成功')
assert.equal(en.currency, 'USD')
assert.equal(en.symbol, '$')
assert.deepEqual(en.models['deepseek-flash'].valley, { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 })
assert.deepEqual(en.models['deepseek-v4-pro'].peak, { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 })

// 解析结果必须与内置兜底一致（官方改价时这里先响）
for (const [table, builtin] of [[zh, BUILTIN_PRICES.CNY], [en, BUILTIN_PRICES.USD]]) {
  for (const [model, tiers] of Object.entries(builtin.models)) {
    for (const tier of ['valley', 'peak']) {
      assert.deepEqual(table.models[model][tier], tiers[tier], `内置 ${builtin.currency} ${model}/${tier} 应与官方一致`)
    }
  }
}

// ── 主/对照口径 ────────────────────────────────────────────────────────────

const combined = combinePriceTables(zh, en, { fetchedAt: '2026-09-11T06:00:00.000Z' })
assert.equal(combined.primary.currency, 'CNY', '人民币优先')
assert.equal(combined.secondary.currency, 'USD')
assert.equal(combinePriceTables(null, en).primary.currency, 'USD', '只有英文页时用美元')
assert.equal(combinePriceTables(null, en).secondary, null)
assert.equal(combinePriceTables(null, null).primary, null)

// ── 模型 id → 列名 ─────────────────────────────────────────────────────────

assert.equal(resolvePriceModel(zh, 'deepseek-flash'), 'deepseek-flash')
assert.equal(resolvePriceModel(zh, 'deepseek-v4-flash'), 'deepseek-flash', 'DSH 的 v4-flash 归到 flash 列')
assert.equal(resolvePriceModel(zh, 'deepseek-v4-flash-vision-exp'), 'deepseek-flash')
assert.equal(resolvePriceModel(zh, 'deepseek-v4-pro'), 'deepseek-v4-pro')
assert.equal(resolvePriceModel(zh, 'deepseek-v5-flash-next'), 'deepseek-flash', '归一化后按前缀匹配')
assert.equal(resolvePriceModel(zh, 'some-unknown-model'), null, '认不出来就 null，不乱套价')
assert.equal(resolvePriceModel(zh, ''), null)
assert.equal(resolvePriceModel(null, 'deepseek-flash'), null)

// ── 计费 ───────────────────────────────────────────────────────────────────

// 谷时 flash：命中 1M、未命中 0.5M、输出 0.25M（互斥计数）
assert.deepEqual(
  priceCall({ inputTokens: 500_000, outputTokens: 250_000, cacheReadTokens: 1_000_000 }, 'deepseek-v4-flash', 'valley', zh),
  { priced: true, model: 'deepseek-flash', tokens: { hit: 1_000_000, miss: 500_000, out: 250_000 }, cost: 0.02 + 0.5 + 1 },
)
// 同一批 token 峰时正好翻倍
assert.equal(
  priceCall({ inputTokens: 500_000, outputTokens: 250_000, cacheReadTokens: 1_000_000 }, 'deepseek-v4-flash', 'peak', zh).cost,
  (0.02 + 0.5 + 1) * 2,
)
// 输出为主的一次 pro 调用
assert.equal(
  priceCall({ inputTokens: 10_000, outputTokens: 100_000 }, 'deepseek-v4-pro', 'peak', zh).cost,
  (10_000 * 9 + 100_000 * 27) / 1_000_000,
)
// 回归：inputTokens 与 cacheReadTokens 是互斥的两桶（宿主适配器已把命中从
// prompt_tokens 里减掉）。曾经按「input 含命中」剪过一次，结果命中量被吃掉一大截。
const disjoint = priceCall({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 9999 }, 'deepseek-flash', 'valley', zh)
assert.deepEqual(disjoint.tokens, { hit: 9999, miss: 100, out: 0 }, '两桶互不剪')
assert.equal(disjoint.cost, (9999 * 0.02 + 100 * 1) / 1_000_000)
// 未知模型：token 照记，金额 0，标记未计价
const unknown = priceCall({ inputTokens: 1000, outputTokens: 1000 }, 'mystery-model', 'valley', zh)
assert.equal(unknown.priced, false)
assert.equal(unknown.cost, 0)
assert.deepEqual(unknown.tokens, { hit: 0, miss: 1000, out: 1000 })
// 缺 usage 字段也不炸
assert.deepEqual(priceCall({}, 'deepseek-flash', 'valley', zh).tokens, { hit: 0, miss: 0, out: 0 })
assert.deepEqual(priceCall(undefined, 'deepseek-flash', 'valley', zh).tokens, { hit: 0, miss: 0, out: 0 })

assert.equal(costOfTokens({ hit: 1_000_000, miss: 0, out: 0 }, zh.models['deepseek-v4-pro'].peak), 0.3)
assert.deepEqual(tokensOf({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 11 }), { hit: 11, miss: 5, out: 7 })
assert.deepEqual(tokensOf({ inputTokens: -1, outputTokens: 'x', cacheReadTokens: null }), { hit: 0, miss: 0, out: 0 })
assert.deepEqual(tokensOf(undefined), { hit: 0, miss: 0, out: 0 })
assert.equal(
  describePrices(zh),
  '官方定价页（中文页） · 人民币/百万 tokens',
)
assert.equal(describePrices(BUILTIN_PRICES.USD), '内置价格表 · 美元/百万 tokens')
assert.equal(describePrices(null), '价格表不可用')

// ── 坏数据：整表不采信（宁可继续用内置价）─────────────────────────────────

const junk = [
  '<p>没有表格</p>',
  '<table><tr><td>模型</td><td>a</td><td>b</td></tr></table>',
  // 缺高峰行 → 每列的价格不齐
  '<table><tr><td>模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>'
    + '<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr></table>',
  // 只有两列值但表头有三列
  '<table><tr><td>模型</td><td>x</td><td>y</td><td>z</td></tr>'
    + '<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr></table>',
]
for (const html of junk) {
  assert.equal(parsePriceTable(html, { locale: 'zh' }), null, `不应解析出价目表：${html.slice(0, 50)}`)
}

console.log('dsh-liangwen-tide: pricing 自检 48 项通过')
