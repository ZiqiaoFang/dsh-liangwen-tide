/**
 * dsh-liangwen-tide 换挡弹窗自检。
 *
 * 两件事各自独立验证：
 *   1. 纯函数：`placePopup`（按胶囊在 UI 里的实际位置决定方向/对齐）与
 *      `shouldCelebrate`（只在"真的刚过点"时弹）；
 *   2. 组件：把真实的 client.js bundle 跑起来，检查弹窗内容、资源地址、样式注入。
 *
 * 运行：node test/popup.test.mjs
 */

import assert from 'node:assert/strict'

const UTC = (day, hour, minute = 0, second = 0) => Date.UTC(2026, 8, day, hour, minute, second)

// ── 假浏览器 ─────────────────────────────────────────────────────────────
let registration
const styles = []
const prefetched = []
let clock = UTC(11, 15, 0)
Date.now = () => clock

globalThis.window = {
  __ModuleLoader__: { load: (value) => { registration = value } },
  setInterval: () => 1,
  setTimeout: () => 1,
  innerWidth: 1280,
  innerHeight: 800,
}
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.Image = class {
  constructor() { this.src = '' }
  set decoding(value) { this._decoding = value }
}
globalThis.document = {
  head: { appendChild: (node) => styles.push(node) },
  querySelector: () => null,
  createElement: (tag) => ({ tag, dataset: {}, textContent: '' }),
}

await import('../lib/client.js')

// 迷你 React：useState/useEffect 生效，useRef 提供 { current }
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
    return [slot.value, (value) => { slot.value = value }]
  },
  useEffect(fn) { if (!mounted.has(rendering)) { mounted.add(rendering); fn() } },
  useRef(initial) { return { current: initial ?? null } },
  createElement: (type, props, ...children) => ({ type, props, children }),
}

const bundle = registration.factory((spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return {}
  throw new Error(`未声明的外部依赖: ${spec}`)
})
const tide = bundle.__internal

const registered = []
bundle.apply({
  get: (name) => (name === 'slots'
    ? { inject: (key, callback) => { callback(); return () => {} }, register: (options, component) => { registered.push({ options, component }); return () => {} } }
    : undefined),
})

// ── 1. placePopup：按胶囊在界面里的位置决定方向 ───────────────────────────

const viewport = { width: 1280, height: 800 }
const popupSize = { width: 180, height: 300 } // 小尺寸人像 + 说明条

{
  // 真实场景：胶囊在会话标题栏右端（靠上、靠右）→ 向下弹、与胶囊右对齐
  const anchor = { top: 48, bottom: 76, left: 1180, right: 1264, width: 84, height: 28 }
  const placed = tide.placePopup(anchor, popupSize, viewport)
  assert.equal(placed.dir, 'down', '标题栏在上方 → 应当向下弹')
  assert.equal(placed.top, anchor.bottom + tide.CELEBRATION.gap, '上边应贴住胶囊下方留 gap')
  assert.equal(placed.left, anchor.right - popupSize.width, '应与胶囊右对齐（向左伸展）')
  assert.ok(placed.left + popupSize.width <= viewport.width - tide.CELEBRATION.margin, '不能超出右边缘')
}
{
  // 胶囊贴着窗口底边 → 翻到上方
  const anchor = { top: 740, bottom: 768, left: 1100, right: 1264, width: 84, height: 28 }
  const placed = tide.placePopup(anchor, popupSize, viewport)
  assert.equal(placed.dir, 'up', '下方放不下 → 应当翻到上方')
  assert.equal(placed.top, anchor.top - tide.CELEBRATION.gap - popupSize.height, '上边应贴住胶囊上方留 gap')
}
{
  // 胶囊在左侧（比如侧栏里的胶囊）→ 左边要夹进视口留白
  const anchor = { top: 300, bottom: 328, left: 12, right: 96, width: 84, height: 28 }
  const placed = tide.placePopup(anchor, popupSize, viewport)
  assert.equal(placed.dir, 'down')
  assert.equal(placed.left, tide.CELEBRATION.margin, '靠左时要夹到最小留白，不能露出视口外')
}
{
  // 视口比弹窗还窄 → 也要给一个非负坐标，别跑到屏幕外
  const placed = tide.placePopup({ top: 100, bottom: 128, left: 10, right: 94, width: 84, height: 28 }, { width: 600, height: 200 }, { width: 320, height: 400 })
  assert.ok(placed.left >= tide.CELEBRATION.margin, '窄视口下不能让弹窗跑到负坐标')
  assert.ok(placed.top >= tide.CELEBRATION.margin)
}
{
  // 上面也没空间时 top 仍夹在留白内（不会负值）
  const placed = tide.placePopup({ top: 4, bottom: 32, left: 100, right: 184, width: 84, height: 28 }, { width: 180, height: 700 }, { width: 1280, height: 300 })
  assert.ok(placed.top >= tide.CELEBRATION.margin)
}

// ── 2. shouldCelebrate：只在"真的刚过点"时弹 ─────────────────────────────

const boundary = UTC(11, 10, 0) // 周五 10:00 UTC = 峰→谷
{
  const previous = { phase: 'peak', flipAt: boundary, now: boundary - 1000 }
  assert.equal(tide.shouldCelebrate(previous, { phase: 'valley', now: boundary + 1000 }), true, '刚过点 1 秒 → 要弹')
  assert.equal(tide.shouldCelebrate(previous, { phase: 'valley', now: boundary + 59_000 }), true, '过点 59 秒 → 仍要弹')
  assert.equal(tide.shouldCelebrate(previous, { phase: 'valley', now: boundary + 61_000 }), false, '过点 61 秒（比如标签页挂起后恢复）→ 不补弹')
  assert.equal(tide.shouldCelebrate(previous, { phase: 'peak', now: boundary + 1000 }), false, '档位没变 → 不弹')
  assert.equal(tide.shouldCelebrate(null, { phase: 'valley', now: boundary + 1000 }), false, '页面刚打开（没有上一次快照）→ 不弹')
  assert.equal(tide.shouldCelebrate(previous, { phase: 'valley', now: boundary + 1000 }, { enabled: false }), false, '关掉弹窗时永不弹')
}

// ── 3. 组件：内容、资源地址、样式 ─────────────────────────────────────────

{
  const Celebration = registered.find((entry) => entry.options.name === 'shell.overlay').component

  // 没触发时不渲染
  assert.equal(tide.currentCelebration(), null)
  assert.equal(Celebration(), null, '没触发时应渲染 null（悬浮层里什么都不放）')

  // 触发一次
  tide.fireCelebration('peak', boundary)
  const active = tide.currentCelebration()
  assert.equal(active.phase, 'peak')
  assert.equal(active.boundaryAt, boundary)

  const tree = Celebration()
  const texts = []
  const images = []
  const walk = (node) => {
    if (typeof node === 'string') { texts.push(node); return }
    if (node === null || typeof node !== 'object') return
    if (typeof node.type === 'function') { const previous = rendering; rendering = node.type; walk(node.type(node.props)); rendering = previous; return }
    if (node.type === 'img') images.push(node.props.src)
    for (const child of node.children ?? []) walk(child)
  }
  rendering = Celebration
  walk(tree)
  rendering = null

  assert.equal(images.length, 1, '弹窗里应有一张人像')
  assert.ok(images[0].endsWith('/liangwen-tide/asset/peak'), `人像应来自宿主资源路由，实际：${images[0]}`)
  assert.ok(texts.includes('梁文峰') && texts.includes('峰时'), '弹窗要写清档位与名字')
  assert.ok(texts.some((t) => t.includes('全价')), '峰时要提示全价')
  assert.ok(texts.some((t) => t.includes('北京时间')), '说明条要写边界时刻')

  // 资源路由与配置
  assert.equal(tide.ASSET_ROUTE, '/liangwen-tide/asset')
  assert.equal(tide.CELEBRATION.height, 170, '尺寸按确认过的"小"')
  assert.equal(tide.CELEBRATION.glow, 0.75, '光芒按确认过的"中"')
  assert.equal(tide.CELEBRATION.seconds, 6)

  // 谷时用另一张图
  tide.fireCelebration('valley', boundary)
  const valleyTree = Celebration()
  const valleyImages = []
  const collectImages = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'img') valleyImages.push(node.props.src)
    for (const child of node.children ?? []) collectImages(child)
  }
  collectImages(valleyTree)
  assert.ok(valleyImages[0].endsWith('/liangwen-tide/asset/valley'), '谷时应取谷时那张')

  // 关闭
  tide.hideCelebration()
  assert.equal(tide.currentCelebration(), null, '关掉后状态应清空')
  assert.equal(Celebration(), null, '关掉后悬浮层应渲染 null')
}

// ── 4. 弹窗 CSS：光芒强度必须真的可控（别再被入场动画覆盖）───────────────

{
  const css = tide.POPUP_CSS
  assert.ok(css.includes('lwt-rays'), '样式里应有光芒层')
  const burstIn = css.match(/@keyframes lwt-burstin \{([^}]*)\}/)
  assert.ok(burstIn, '样式里应有入场关键帧')
  assert.ok(!/opacity/.test(burstIn[1]), '入场关键帧不能动 opacity —— 否则 --lwt-glow（光芒强度）会被覆盖')
  assert.ok(/opacity: calc\(var\(--lwt-glow\)/.test(css), '光芒透明度必须由 --lwt-glow 控制')
  assert.ok(/\.lwt-burst \{[^}]*z-index: 0/.test(css), '光芒层必须在人像后面')
  assert.ok(/\.lwt-figure \{[^}]*z-index: 1/.test(css), '人像要压在光芒之上')
  assert.ok(css.includes('prefers-reduced-motion'), '要照顾"减少动态效果"的系统设置')
  assert.ok(css.includes('mask-image: linear-gradient(to bottom'), '光芒底部要跟着人像淡出')
}

console.log('dsh-liangwen-tide: popup 自检 34 项通过（定位/触发/内容/资源/样式）')
