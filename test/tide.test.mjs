/**
 * dsh-liangwen-tide 离线自检。
 *
 * 直接加载真实的 lib/client.js（用假的 window/__ModuleLoader__ 接住注册），
 * 再取出它的 __internal 出口测峰谷数学——不复制规则，避免实现与测试漂移。
 *
 * 运行：node test/tide.test.mjs
 */

import assert from 'node:assert/strict'
import { BUILTIN_POLICY as hostBuiltin, samePolicy } from '../lib/policy.js'

// ── 假的浏览器外壳：接住 window.__ModuleLoader__.load 的注册 ────────────────

let registration
// 浏览器 API 桩：插件在弹窗倒计时里用 requestAnimationFrame，
// 测试里必须钉住它 —— 否则会退化到真实 setTimeout，模拟时钟让 delta 恒为 0，
// 变成永不停止的定时器链，进程直接不退出（踩过一次）。
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}

globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
  setInterval() {
    return 0
  },
  setTimeout() {
    return 0
  },
  clearInterval() {},
  clearTimeout() {},
}

// Node 26 自带一个需要 --localstorage-file 的 localStorage（会打警告），
// 这里换成内存桩：既安静，又能顺便验证「官方策略落到本机缓存」这条路。
const storedKeys = new Map()
globalThis.localStorage = {
  getItem: (key) => (storedKeys.has(key) ? storedKeys.get(key) : null),
  setItem: (key, value) => void storedKeys.set(key, String(value)),
  removeItem: (key) => void storedKeys.delete(key),
}

const fakeReact = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  createElement: (type, props, ...children) => ({ type, props, children }),
}

await import('../lib/client.js')

assert.ok(registration, 'bundle 必须调用 window.__ModuleLoader__.load 注册自己')
assert.equal(registration.id, 'dsh-liangwen-tide', 'bundle id 必须等于包名（模块图按包名索引）')

const bundle = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  if (specifier === 'react/jsx-runtime') return {}
  throw new Error(`未声明的外部依赖: ${specifier}`)
})

assert.equal(typeof bundle.apply, 'function', '必须导出 apply')
assert.deepEqual(bundle.inject, ['slots'], 'inject 只依赖 slots 服务')
assert.equal(typeof bundle.__internal, 'object', '必须导出 __internal 供自检')

const tide = bundle.__internal

// ── 时间基准自检：先把测试用到的星期几钉死 ─────────────────────────────────

const utc = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm)

assert.equal(new Date(utc(2026, 9, 11)).getUTCDay(), 5, '2026-09-11 应为周五')
assert.equal(new Date(utc(2026, 9, 12)).getUTCDay(), 6, '2026-09-12 应为周六')
assert.equal(new Date(utc(2026, 9, 13)).getUTCDay(), 0, '2026-09-13 应为周日')
assert.equal(new Date(utc(2026, 9, 14)).getUTCDay(), 1, '2026-09-14 应为周一')

// ── 档位判定（UTC 口径）────────────────────────────────────────────────────

const cases = [
  ['周五 00:30 谷', utc(2026, 9, 11, 0, 30), 'valley'],
  ['周五 01:00 峰（窗口左闭）', utc(2026, 9, 11, 1, 0), 'peak'],
  ['周五 03:59 峰', utc(2026, 9, 11, 3, 59), 'peak'],
  ['周五 04:00 谷（窗口右开）', utc(2026, 9, 11, 4, 0), 'valley'],
  ['周五 05:59 谷', utc(2026, 9, 11, 5, 59), 'valley'],
  ['周五 06:00 峰', utc(2026, 9, 11, 6, 0), 'peak'],
  ['周五 09:59 峰', utc(2026, 9, 11, 9, 59), 'peak'],
  ['周五 10:00 谷', utc(2026, 9, 11, 10, 0), 'valley'],
  ['周五 23:59 谷', utc(2026, 9, 11, 23, 59), 'valley'],
  ['周六 02:00 周末全天谷', utc(2026, 9, 12, 2, 0), 'valley'],
  ['周六 07:00 周末全天谷', utc(2026, 9, 12, 7, 0), 'valley'],
  ['周日 08:00 周末全天谷', utc(2026, 9, 13, 8, 0), 'valley'],
  ['周一 00:59 谷', utc(2026, 9, 14, 0, 59), 'valley'],
  ['周一 01:00 峰', utc(2026, 9, 14, 1, 0), 'peak'],
]

for (const [label, ms, expected] of cases) {
  assert.equal(tide.phaseAt(ms), expected, label)
}

// ── 下一次翻转 ─────────────────────────────────────────────────────────────

const flips = [
  ['周五 00:00 → 01:00', utc(2026, 9, 11, 0, 0), utc(2026, 9, 11, 1, 0)],
  ['周五 03:59 → 04:00', utc(2026, 9, 11, 3, 59), utc(2026, 9, 11, 4, 0)],
  ['周五 07:00 → 10:00', utc(2026, 9, 11, 7, 0), utc(2026, 9, 11, 10, 0)],
  ['周五 12:00 → 跨周末到周一 01:00', utc(2026, 9, 11, 12, 0), utc(2026, 9, 14, 1, 0)],
  ['周六 03:00 → 周一 01:00', utc(2026, 9, 12, 3, 0), utc(2026, 9, 14, 1, 0)],
  ['周日 23:00 → 周一 01:00', utc(2026, 9, 13, 23, 0), utc(2026, 9, 14, 1, 0)],
  ['周一 00:30 → 01:00', utc(2026, 9, 14, 0, 30), utc(2026, 9, 14, 1, 0)],
  ['周一 01:00 → 04:00', utc(2026, 9, 14, 1, 0), utc(2026, 9, 14, 4, 0)],
]

for (const [label, ms, expected] of flips) {
  assert.equal(tide.nextFlipAt(ms), expected, label)
}

// 翻转点必须是真正换挡的时刻
for (const [, ms] of flips) {
  const flip = tide.nextFlipAt(ms)
  assert.notEqual(tide.phaseAt(flip - 1), tide.phaseAt(flip), '翻转点前后档位必须不同')
}

// ── 文案与格式 ─────────────────────────────────────────────────────────────

assert.equal(tide.nameOf('peak'), '梁文峰', '峰时必须叫梁文峰')
assert.equal(tide.nameOf('valley'), '梁文谷', '谷时必须叫梁文谷')
assert.equal(tide.formatRemaining(0), '00:00')
assert.equal(tide.formatRemaining(90 * 1000), '01:30')
assert.equal(tide.formatRemaining(3600 * 1000 + 65 * 1000), '1:01:05')
assert.equal(tide.formatRemaining(-5), '00:00', '负数不出现负号')

// 规则形状：两个峰窗、周末全天谷、北京时间说明由策略推导
assert.equal(tide.BUILTIN_POLICY.windows.length, 2)
assert.deepEqual(tide.BUILTIN_POLICY.windows, [
  { start: 60, end: 240 },
  { start: 360, end: 600 },
])
assert.equal(tide.BUILTIN_POLICY.weekendAllValley, true)
assert.equal(tide.describeWindows(tide.BUILTIN_POLICY), '09:00–12:00、14:00–18:00')

// ── apply：注册两个 list 插槽 ──────────────────────────────────────────────

const registered = []
const injected = []
const slotsStub = {
  inject(key, callback) {
    injected.push(key)
    callback()
    return () => {}
  },
  register(options, component) {
    registered.push({ options, component })
    return () => {}
  },
}

bundle.apply({ get: (name) => (name === 'slots' ? slotsStub : undefined) })
bundle.apply({ get: () => undefined }) // slots 缺席时只告警，不抛

assert.deepEqual(
  registered.map((entry) => entry.options.name),
  ['conversation.session.header.utilities', 'sidebar.footer.action', 'shell.overlay'],
  '两个 list 插槽 + 换挡弹窗的悬浮层都要注册',
)
assert.deepEqual(injected, ['conversation.session.header.utilities', 'sidebar.footer.action', 'shell.overlay'])
for (const entry of registered) {
  // 前两个是 list 插槽（order 5），第三个是悬浮层里的换挡弹窗
  assert.ok(entry.options.id === 'liangwen-tide' || entry.options.id === 'liangwen-tide-celebration')
  assert.ok(entry.options.order === 5 || entry.options.order === 20)
  assert.equal(typeof entry.component, 'function')
}

// ── 渲染：真实时钟下胶囊文案必须是梁文峰/梁文谷之一 ────────────────────────

/** 深度收集渲染树里的文本子节点（函数组件就地求值，模拟 React 的递归渲染）。 */
function textsOf(node) {
  if (typeof node === 'string') return [node]
  if (node === null || typeof node !== 'object') return []
  if (typeof node.type === 'function') return textsOf(node.type(node.props))
  return (node.children ?? []).flatMap(textsOf)
}

const pill = registered[0].component()
const nowPhase = tide.phaseAt(Date.now())
const pillText = textsOf(pill).join(' ')
assert.ok(
  pillText.includes(tide.nameOf(nowPhase)),
  `胶囊文案应包含 ${tide.nameOf(nowPhase)}，实际：${pillText}`,
)
assert.equal(typeof pill.props.title, 'string', '胶囊必须带悬停说明')
assert.ok(pill.props.title.includes('峰时'), '悬停说明要含时段表')

const rail = registered[1].component({ wide: false })
assert.equal(textsOf(rail).length, 0, '侧栏轨道态只留状态点，不渲染文字')
const wide = registered[1].component({ wide: true })
assert.ok(textsOf(wide).join(' ').includes(tide.nameOf(nowPhase)), '侧栏宽态渲染完整胶囊')

// ── 自动更新：宿主下发的策略要能被采纳、驱动判定、并拒绝坏数据 ──────────────

assert.equal(tide.currentPolicy().source, 'builtin', '初始应为内置兜底')

// 官方来源：采纳
const served = {
  windows: [{ start: 120, end: 300 }], // UTC 02:00–05:00
  weekendAllValley: false,
  source: 'official:en+zh',
  fetchedAt: new Date(Date.now() - 60_000).toISOString(),
}
tide.adoptFromServer(served)
assert.deepEqual(tide.currentPolicy().windows, [{ start: 120, end: 300 }], '应换成宿主下发的窗口')
assert.equal(tide.currentPolicy().source, 'official:en+zh')
assert.equal(tide.phaseAt(utc(2026, 9, 11, 3, 0)), 'peak', '新窗口内为峰时')
assert.equal(tide.phaseAt(utc(2026, 9, 11, 1, 30)), 'valley', '旧窗口不再算峰时')
assert.equal(tide.phaseAt(utc(2026, 9, 12, 3, 0)), 'peak', 'weekendAllValley=false → 周六同规则')
assert.equal(tide.nextFlipAt(utc(2026, 9, 11, 3, 0)), utc(2026, 9, 11, 5, 0), '翻转点跟着新策略走')
assert.ok(tide.policyLabel(tide.currentPolicy()).includes('官方定价页'), '来源说明要写官方页')
assert.ok(tide.policyLabel(tide.currentPolicy()).includes('刚刚同步'), '来源说明要带新鲜度')

// 宿主只是内置兜底：不要覆盖手上的官方策略
tide.adoptFromServer({ windows: [{ start: 0, end: 60 }], weekendAllValley: true, source: 'builtin' })
assert.deepEqual(tide.currentPolicy().windows, [{ start: 120, end: 300 }], '内置兜底不得倒灌')

// 更旧的时间戳：不覆盖更新的缓存
tide.adoptFromServer({
  windows: [{ start: 600, end: 660 }],
  weekendAllValley: true,
  source: 'official:en',
  fetchedAt: new Date(Date.now() - 86_400_000).toISOString(),
})
assert.deepEqual(tide.currentPolicy().windows, [{ start: 120, end: 300 }], '旧策略不得覆盖新策略')

// 坏数据：一律拒绝，保持现状
for (const bad of [
  { windows: [], weekendAllValley: false, source: 'official:en' },
  { windows: [{ start: 60, end: 60 }], source: 'official:en' },
  { windows: [{ start: 60, end: 600 }, { start: 300, end: 700 }], source: 'official:en' },
  { windows: [{ start: 0, end: 1440 }], source: 'official:en' },
  { windows: 'nope', source: 'official:en' },
  { source: 'official:en' },
  null,
])
  tide.adoptFromServer(bad)
assert.deepEqual(tide.currentPolicy().windows, [{ start: 120, end: 300 }], '坏数据不得改变策略')
assert.equal(tide.normalizePolicy({ windows: [{ start: 0, end: 1440 }] }), null, '越界窗口非法')
assert.equal(tide.normalizePolicy({ windows: [{ start: 30, end: 990 }] }).windows.length, 1, '跨零点窗口合法')
assert.equal(tide.POLICY_ROUTE, '/liangwen-tide/policy')

// 内置兜底必须与宿主解析层的内置口径一致（两处常量漂移就报错）
assert.ok(
  samePolicy(hostBuiltin, tide.BUILTIN_POLICY),
  '浏览器半与宿主半的内置策略必须一致',
)
assert.equal(tide.policyLabel(tide.BUILTIN_POLICY), '内置默认（尚未取到官方定价页）')

// 官方策略要落进本机缓存（宿主重启/离线时靠它顶住）
const cached = JSON.parse(storedKeys.get(tide.POLICY_STORAGE_KEY) ?? 'null')
assert.deepEqual(cached.windows, [{ start: 120, end: 300 }], '缓存的应是官方窗口')
assert.equal(cached.source, 'official:en+zh', '缓存的应带官方来源')
assert.equal(storedKeys.has(tide.POLICY_STORAGE_KEY), true)

// ── 当日用量：显示、格式、坏数据 ───────────────────────────────────────────

assert.equal(tide.USAGE_ROUTE, '/liangwen-tide/usage')
assert.equal(tide.currentUsage(), null, '一开始没有用量数据')
assert.equal(tide.usageBadge(), null, '没有数据时不显示金额')

assert.equal(tide.formatMoney(3.4211, '¥'), '¥3.42')
assert.equal(tide.formatMoney(0.0042, '¥'), '¥0.004', '小钱多给一位，别显示成 ¥0.00')
assert.equal(tide.formatMoney(0, '¥'), '¥0.00')
assert.equal(tide.formatMoney(undefined, '$'), '$0.00')
assert.equal(tide.formatTokens(950), '950')
assert.equal(tide.formatTokens(120_400), '120.4k')
assert.equal(tide.formatTokens(2_500_000), '2.5M')

const usagePayload = {
  enabled: true,
  day: '2026-09-11',
  timezone: 'UTC+8',
  total: { calls: 12, cost: 3.4211, tokens: { hit: 120_400, miss: 34_000, out: 9_000 } },
  tiers: { peak: { cost: 2.1, calls: 3 }, valley: { cost: 1.3211, calls: 9 } },
  models: [
    { model: 'deepseek-v4-pro', cost: 2.1, calls: 3 },
    { model: 'deepseek-flash', cost: 1.3211, calls: 9 },
  ],
  unpriced: { calls: 0, models: [] },
  secondary: { currency: 'USD', symbol: '$', cost: 0.5014 },
  recent: [
    { day: '2026-09-11', cost: 3.4211, calls: 12 },
    { day: '2026-09-10', cost: 1.2, calls: 5 },
  ],
  pricing: { primary: { currency: 'CNY', symbol: '¥', source: 'official:zh', fetchedAt: new Date(Date.now() - 60_000).toISOString() } },
  backfill: { state: 'done' },
}
assert.equal(tide.applyUsage(usagePayload), true)
assert.equal(tide.usageBadge(), '今日 ¥3.42')

const lines = tide.usageLines()
assert.ok(lines[0].includes('今日（北京时间）¥3.42 · 12 次已结算调用'), `首行应含合计，实际：${lines[0]}`)
assert.ok(lines[1].includes('峰时 ¥2.10 · 谷时 ¥1.32'), `第二行应分峰谷，实际：${lines[1]}`)
assert.ok(lines[2].includes('输入命中 120.4k · 未命中 34.0k · 输出 9.0k'), `第三行应给 token，实际：${lines[2]}`)
assert.ok(lines.some((line) => line.includes('deepseek-v4-pro ¥2.10（3 次）')), '要列模型明细')
assert.ok(lines.some((line) => line.includes('对照：$0.50')), '要给对照币种')
assert.ok(lines.some((line) => line.startsWith('  价格：官方定价页（中文页）')), '要写清价格来源')
assert.ok(lines.some((line) => line.includes('昨日 ¥1.20')), '要带昨日对照')
assert.ok(tide.priceLabel(usagePayload.pricing.primary).includes('刚刚同步'))
assert.equal(tide.priceLabel({ source: 'builtin' }), '内置价格表（尚未取到官方定价页）')

// 胶囊与悬停提示都要带上金额
const pillWithCost = registered[0].component()
const pillTextWithCost = textsOf(pillWithCost).join(' ')
assert.ok(pillTextWithCost.includes('今日 ¥3.42'), `胶囊应显示今日金额，实际：${pillTextWithCost}`)
assert.ok(pillWithCost.props.title.includes('今日（北京时间）¥3.42'), '悬停提示应含用量段落')
assert.equal(textsOf(registered[1].component({ wide: false })).length, 0, '侧栏轨道态仍然只留点')

// 未匹配模型 + 补历史不可用 + 无对照币种
tide.applyUsage({
  ...usagePayload,
  unpriced: { calls: 4, models: ['mystery'] },
  secondary: undefined,
  pricing: { primary: { currency: 'CNY', symbol: '¥', source: 'builtin', fetchedAt: null } },
  backfill: { state: 'unavailable' },
})
const degraded = tide.usageLines()
assert.ok(degraded.some((line) => line.includes('4 次调用的模型没匹配到价格')), '未匹配模型要说明')
assert.ok(degraded.some((line) => line.includes('会话索引不可用')), '补历史不可用要说明')
assert.ok(!degraded.some((line) => line.includes('对照：')), '没有对照币种就不显示该行')

// 坏数据一律不采纳（保持上一份或什么都没有）
const before = tide.currentUsage()
for (const bad of [null, { enabled: false }, { total: {} }, { total: { cost: 'x', calls: 1 } }, { total: { cost: 1 } }, 'nope']) {
  assert.equal(tide.applyUsage(bad), false, `坏数据不该被采纳：${JSON.stringify(bad)}`)
}
assert.equal(tide.currentUsage(), before)

console.log(`dsh-liangwen-tide: ${cases.length + flips.length + 118} 项自检通过`)
