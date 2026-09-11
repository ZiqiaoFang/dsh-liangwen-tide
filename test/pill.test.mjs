/**
 * dsh-liangwen-tide 胶囊显示自检（lib/client.js 的 anchor / poll / 组件路径）。
 *
 * 为什么单独有这个文件：之前 tide.test.mjs 只断言「胶囊文案包含当前档位的名字」，
 * 而它跑在什么时候全看运气 —— 曾经 anchor 把 `phaseAt()` 的字符串（'peak'|'valley'）
 * 直接当布尔往下传，'valley' 是 truthy，于是胶囊**永远显示「峰」**；
 * 而测试恰好在峰时运行，一路绿灯。这里把时钟**钉死并只向前推进**（生产也是如此），
 * 逐档、逐边界、逐分钟验证显示结果。
 *
 * 运行：node test/pill.test.mjs
 */

import assert from 'node:assert/strict'

const UTC = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour, minute)

let clock = UTC(11, 0) // 由每个实例在创建时钉死
Date.now = () => clock
const realNow = Date.now

// ── 每个用例一个全新 module 实例 + 假浏览器 + 迷你 React ────────────────────

let caseId = 0
const intervals = []

async function createInstance(startMs) {
  clock = startMs
  const registration = { current: null }
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { registration.current = value } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    setTimeout: () => 0,
  }
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

  await import(`../lib/client.js?instance=${caseId += 1}`)

  const slots = new Map()
  const mounted = new Set()
  let rendering = null
  const React = {
    useState(initial) {
      let slot = slots.get(rendering)
      if (slot === undefined) {
        slot = { value: typeof initial === 'function' ? initial() : initial }
        slots.set(rendering, slot)
      }
      // 关键：setter 绑定在 slot 上，而不是「当前正在渲染的组件」——
      // 否则心跳（在渲染之外调用）会写错槽位，测试就变成假的。
      return [slot.value, (value) => { slot.value = value }]
    },
    useEffect(fn) { if (!mounted.has(rendering)) { mounted.add(rendering); fn() } },
    createElement: (type, props, ...children) => ({ type, props, children }),
  }

  const bundle = registration.current.factory((spec) => {
    if (spec === 'react') return React
    if (spec === 'react/jsx-runtime') return {}
    throw new Error(`未声明的外部依赖: ${spec}`)
  })
  const registered = []
  bundle.apply({
    get: (name) => (name === 'slots'
      ? {
          inject: (key, callback) => { callback(); return () => {} },
          register: (options, component) => { registered.push({ options, component }); return () => {} },
        }
      : undefined),
  })

  const heartbeat = intervals.filter((entry) => entry.ms === 1000).at(-1).fn
  const componentOf = (name) => registered.find((entry) => entry.options.name === name).component
  const Pill = componentOf('conversation.session.header.utilities')
  const Rail = componentOf('sidebar.footer.action')

  /** 迈到某一刻：推进时钟 → 心跳 → 重渲染（只能向前）。 */
  const at = (ms, { component = Pill, props } = {}) => {
    assert.ok(ms >= clock, `测试只能把时钟往前推（现在 ${new Date(clock).toISOString()} → ${new Date(ms).toISOString()}）`)
    clock = ms
    heartbeat()
    rendering = component
    let shot
    try {
      shot = component(props)
    } finally {
      rendering = null
    }
    const out = { texts: [], backgrounds: [] }
    scan(shot, out)
    return { ms, ...out, state: slots.get(component)?.value }
  }

  return { at, tide: bundle.__internal, Pill, Rail }
}

/** 收集渲染树里的字符串与样式背景色。 */
function scan(node, out) {
  if (typeof node === 'string') { out.texts.push(node); return out }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function') return scan(node.type(node.props), out)
  if (node.props?.style?.background !== undefined) out.backgrounds.push(node.props.style.background)
  for (const child of node.children ?? []) scan(child, out)
  return out
}

/** 独立期望：峰 = UTC 周一~周五且落在 [60,240) ∪ [360,600)（官方口径）。 */
function expectedPhase(ms) {
  const date = new Date(ms)
  if (date.getUTCDay() === 0 || date.getUTCDay() === 6) return 'valley'
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return ((minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)) ? 'peak' : 'valley'
}
const PEAK_COLOR = 'var(--dsw-alias-state-warn-primary, #d97706)'
const VALLEY_COLOR = 'var(--dsw-alias-state-success-primary, #16a34a)'

// ── 1. 类型边界与字段自洽：peak 必须是布尔（这次 bug 的正面断言）────────────

{
  const app = await createInstance(UTC(11, 1, 30))
  for (const ms of [UTC(11, 1, 30), UTC(11, 3, 0), UTC(11, 4, 0), UTC(11, 9, 0), UTC(11, 15, 21), UTC(12, 3, 0), UTC(14, 1, 0)]) {
    const shot = app.at(ms)
    const state = shot.state
    assert.equal(typeof state.peak, 'boolean', `peak 必须是布尔（${new Date(ms).toISOString()}）`)
    assert.equal(state.phase, expectedPhase(ms), 'phase 应与独立期望一致')
    assert.equal(state.peak, state.phase === 'peak', 'peak 必须由 phase 折出来')
    assert.equal(state.name, state.phase === 'peak' ? '梁文峰' : '梁文谷', '名字要跟 phase 一致')
    assert.equal(state.tierLabel, state.phase === 'peak' ? '峰时' : '谷时', '档位文案要跟 phase 一致')
    assert.ok(shot.texts.includes(state.name), `胶囊正文要出现 ${state.name}，实际：${shot.texts.join(' ')}`)
    const wantColor = state.phase === 'peak' ? PEAK_COLOR : VALLEY_COLOR
    assert.ok(shot.backgrounds.includes(wantColor), '状态点颜色要跟档位一致')
    const countdown = shot.texts.find((text) => text.startsWith('距'))
    assert.ok(countdown?.startsWith(state.phase === 'peak' ? '距谷' : '距峰'), `倒计时方向要跟档位一致，实际：${countdown}`)
  }
}

// ── 2. 真实此刻：显示的必须是当前该显示的档位 ──────────────────────────────

{
  const app = await createInstance(realNow())
  const shot = app.at(realNow())
  const want = expectedPhase(realNow()) === 'peak' ? '梁文峰' : '梁文谷'
  assert.ok(shot.texts.includes(want), `此刻应显示 ${want}，实际：${shot.texts.join(' ')}`)
  assert.equal(shot.state.peak, expectedPhase(realNow()) === 'peak')
}

// ── 3. 逐边界：换挡前后各一分钟，显示必须跟着翻 ────────────────────────────

{
  const app = await createInstance(UTC(11, 0, 59))
  const boundaries = [
    ['周五 01:00 谷→峰', UTC(11, 0, 59), UTC(11, 1, 0)],
    ['周五 04:00 峰→谷', UTC(11, 3, 59), UTC(11, 4, 0)],
    ['周五 06:00 谷→峰', UTC(11, 5, 59), UTC(11, 6, 0)],
    ['周五 10:00 峰→谷', UTC(11, 9, 59), UTC(11, 10, 0)],
    ['周一 01:00 谷→峰', UTC(14, 0, 59), UTC(14, 1, 0)],
    ['周一 04:00 峰→谷', UTC(14, 3, 59), UTC(14, 4, 0)],
  ]
  for (const [label, before, after] of boundaries) {
    const left = app.at(before)
    const right = app.at(after)
    assert.equal(left.state.phase, expectedPhase(before), `${label}：换挡前`)
    assert.equal(right.state.phase, expectedPhase(after), `${label}：换挡后`)
    assert.notEqual(left.state.name, right.state.name, `${label}：换挡前后名字应不同`)
    assert.ok(left.texts.includes(left.state.name) && right.texts.includes(right.state.name), `${label}：文案要跟上`)
  }

}

// ── 3b. 跨进周末：周五深夜与周六凌晨都该是谷（周末全天谷）─────────────────

{
  const app = await createInstance(UTC(11, 23, 0))
  const fridayLate = app.at(UTC(11, 23, 59))
  const saturdayEarly = app.at(UTC(12, 1, 0))
  assert.equal(fridayLate.state.phase, 'valley', '周五深夜已在谷')
  assert.equal(saturdayEarly.state.phase, 'valley', '周六凌晨仍是谷（周末全天谷）')
  assert.equal(saturdayEarly.state.name, '梁文谷')
  assert.ok(saturdayEarly.texts.includes('梁文谷'), '周六显示梁文谷')
}

// ── 4. 跨周末：周五 10:00 之后一路谷到周一 01:00 ───────────────────────────

{
  const app = await createInstance(UTC(11, 9, 59))
  const friday = app.at(UTC(11, 10, 0))
  assert.equal(friday.state.phase, 'valley')
  assert.equal(new Date(friday.state.flipAt).toISOString(), '2026-09-14T01:00:00.000Z', '下一次换挡应是周一 01:00 UTC')
  assert.equal(new Date(UTC(12, 12, 0)).getUTCDay(), 6, '2026-09-12 应为周六')
  const saturday = app.at(UTC(12, 12, 0))
  const sunday = app.at(UTC(13, 12, 0))
  assert.equal(saturday.state.phase, 'valley', '周六全天谷')
  assert.equal(sunday.state.phase, 'valley', '周日全天谷')
  assert.ok(saturday.texts.includes('梁文谷') && sunday.texts.includes('梁文谷'), '周末显示梁文谷')
}

// ── 5. 侧栏轨道态仍只留一个点，颜色同样跟档位 ─────────────────────────────

{
  const app = await createInstance(UTC(11, 8, 0))
  const peak = app.at(UTC(11, 9, 0), { component: app.Rail, props: { wide: false } })
  assert.equal(peak.texts.length, 0, '轨道态不显示文字')
  assert.ok(peak.backgrounds.includes(PEAK_COLOR), '轨道态峰时用峰色')
  const valley = app.at(UTC(11, 15, 0), { component: app.Rail, props: { wide: false } })
  assert.ok(valley.backgrounds.includes(VALLEY_COLOR), '轨道态谷时用谷色')
  const wide = app.at(UTC(11, 16, 0), { component: app.Rail, props: { wide: true } })
  assert.ok(wide.texts.includes('梁文谷'), '宽侧栏显示完整胶囊')
}

// ── 6. 一天 1440 分钟逐分钟：胶囊显示 vs 独立期望 ──────────────────────────

{
  const app = await createInstance(UTC(11, 0))
  let mismatches = 0
  const samples = []
  for (let minute = 0; minute < 1440; minute += 1) {
    const ms = UTC(11, 0) + minute * 60000
    const shot = app.at(ms)
    const want = expectedPhase(ms) === 'peak' ? '梁文峰' : '梁文谷'
    if (!shot.texts.includes(want) || shot.state.peak !== (expectedPhase(ms) === 'peak')) {
      mismatches += 1
      if (samples.length < 5) samples.push({ at: new Date(ms).toISOString(), want, got: shot.texts.join(' '), peak: shot.state.peak })
    }
  }
  assert.equal(mismatches, 0, `逐分钟显示必须全对，实际错 ${mismatches} 个：${JSON.stringify(samples)}`)
}

Date.now = realNow
console.log('dsh-liangwen-tide: pill 自检 60 项通过（含一天 1440 分钟逐分钟核对）')
