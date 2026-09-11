/**
 * dsh-liangwen-tide 联网自检：真的去抓官方定价页，走一遍宿主侧的真实解析链路
 * （峰谷时段 + 价目表），并和内置兜底对一遍。
 *
 * 需要网络（离线时请跑 npm test，那套用真实页面片段做离线自检）。
 *
 * 运行：node test/live-check.mjs
 */

import { BUILTIN_POLICY, PRICING_URLS, combineReports, describeWindows, parseRule, samePolicy, stripHtml } from '../lib/policy.js'
import { BUILTIN_PRICES, combinePriceTables, parsePriceTable } from '../lib/pricing.js'

const timeoutMs = 15_000

async function fetchPage(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en,zh-CN;q=0.9' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

const [enHtml, zhHtml] = await Promise.all([fetchPage(PRICING_URLS.en), fetchPage(PRICING_URLS.zh)])
const en = parseRule(stripHtml(enHtml), { locale: 'en' })
const zh = parseRule(stripHtml(zhHtml), { locale: 'zh' })
const combined = combineReports(en, zh)
const prices = combinePriceTables(
  parsePriceTable(zhHtml, { locale: 'zh' }),
  parsePriceTable(enHtml, { locale: 'en' }),
  { fetchedAt: new Date().toISOString() },
)

console.log('英文页:', en === null ? '解析失败' : `${en.strategy} → ${JSON.stringify(en.windows)} 周末全天谷=${String(en.weekendAllValley)}`)
console.log('中文页:', zh === null ? '解析失败' : `${zh.strategy} → ${JSON.stringify(zh.windows)} 周末全天谷=${String(zh.weekendAllValley)}`)
console.log('合成  :', combined === null ? '失败' : `${combined.source} / ${combined.confidence} / 冲突=${String(combined.conflict)}`)
console.log('北京时间峰时:', combined === null ? '-' : describeWindows(combined))
console.log('证据  :', combined?.evidence ?? '-')
console.log('价目表:', prices.primary === null ? '解析失败' : `${prices.primary.currency}（${prices.primary.source}）`)
if (prices.primary !== null) {
  for (const [model, tiers] of Object.entries(prices.primary.models)) {
    console.log(`  ${model}: 谷 ${JSON.stringify(tiers.valley)} / 峰 ${JSON.stringify(tiers.peak)}`)
  }
}
console.log('对照  :', prices.secondary === null ? '无' : `${prices.secondary.currency}（${prices.secondary.source}）`)

let failed = false
if (combined === null) {
  console.error('\n✗ 官方页面里没解析出峰谷规则 —— 页面结构可能改了，需要更新 lib/policy.js 的句式表（内置兜底仍在生效）')
  failed = true
} else if (!samePolicy(combined, BUILTIN_POLICY)) {
  console.error('\n✗ 官方峰谷口径与内置兜底已经不一致 —— 请把 lib/policy.js / lib/client.js 的 BUILTIN 常量同步成上面的结果')
  failed = true
}
if (prices.primary === null) {
  console.error('\n✗ 官方页面里没解析出完整价目表 —— 需要更新 lib/pricing.js 的表解析（内置价仍在生效）')
  failed = true
} else {
  const builtin = BUILTIN_PRICES[prices.primary.currency]
  for (const [model, tiers] of Object.entries(builtin.models)) {
    for (const tier of ['valley', 'peak']) {
      const live = prices.primary.models[model]?.[tier]
      if (live === undefined || JSON.stringify(live) !== JSON.stringify(tiers[tier])) {
        console.error(`\n✗ ${model}/${tier} 官方价格（${JSON.stringify(live)}）与内置价（${JSON.stringify(tiers[tier])}）不一致 —— 请同步 lib/pricing.js 的 BUILTIN_PRICES`)
        failed = true
      }
    }
  }
}
if (failed) process.exit(1)
console.log('\n✓ 官方峰谷口径 + 价目表都与内置兜底一致，自动更新链路可用')
