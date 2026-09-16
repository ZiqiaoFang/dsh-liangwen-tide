/**
 * 验证 title 修复：原生 tooltip 的文案不应该随时间每 tick 变化。
 *   node titlecheck.mjs <插件目录>
 * 模拟插件自己的秒级心跳（publish），比较「同一分钟内多 tick」的 title 是否稳定。
 */
import { createRequire } from 'node:module'
import Module from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const PLUGIN = resolve(process.argv[2] ?? '.')
if (!PLUGIN) { console.error('用法: node titlecheck.mjs <插件目录>'); process.exit(2) }

let fakeNow = Date.now()
Date.now = () => fakeNow

const document = {
  documentElement: {},
  head: { appendChild: () => {} },
  createElement: () => ({ dataset: {}, style: {}, textContent: '', classList: { add () {} } }),
  querySelector: () => null,
}
const window = { innerWidth: 1280, innerHeight: 800, setInterval: () => 0, setTimeout: () => 0, addEventListener: () => {} }
Object.assign(globalThis, {
  document, window,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => '#16a34a' }),
  fetch: async () => ({ ok: false, status: 401 }),
  localStorage: { getItem: () => null, setItem: () => {} },
})
globalThis.Image = class { constructor () { this.src = '' } }

const React = {
  createElement: (type, props, ...kids) => ({ type, props: props ?? {}, children: kids.flat().filter((k) => k !== null && k !== undefined && k !== false) }),
  useRef: () => ({ current: null }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
}
const bundles = {}
window.__ModuleLoader__ = { load: ({ id, factory }) => { bundles[id] = factory(require) } }
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'react') return React
  return origLoad.call(this, request, ...rest)
}
require(join(PLUGIN, 'lib', 'client.js'))
const client = bundles['dsh-liangwen-tide']
const I = client.__internal
const slots = { inject: (_s, fn) => fn(), register: (m, c) => { registered[m.name] = c; return () => {} } }
const registered = {}
client.apply({ get: (n) => (n === 'slots' ? slots : undefined) })

let failures = 0
const expect = (label, ok, extra = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}

/** 渲染胶囊，取出它这次的 title。 */
function titleNow () {
  const Pill = registered['conversation.session.header.utilities']
  const tree = Pill({})
  return tree?.props?.title ?? null
}

/**
 * 触发一次秒级心跳，模拟插件里 `window.setInterval(publish, 1000)` 的那一下。
 * 胶囊读的是模块内部的 snapshot，只有 publish() 会刷新它；
 * 单纯调 poll() 只返回新值、不会更新 snapshot。
 */
const beat = () => {
  if (typeof I.publish === 'function') I.publish()
  else if (typeof I.poll === 'function') I.poll()
  return titleNow()
}
if (typeof I.poll !== 'function' && typeof I.publish !== 'function') {
  console.log('注意：此版本未导出 poll/publish，第 1、5 项无法在离线环境复现秒级心跳；')
  console.log('      闪烁的实测证据见 lab.mjs + tooltiplab.mjs（真实浏览器，8 次/6 秒 → 0 次/80 秒）。')
}

console.log('1) 胶囊 title 在同一分钟内必须稳定（这是闪烁的根因）')
// 把时钟按 1 秒推进并触发秒级心跳，模拟插件真实运行
const titles = []
for (let i = 0; i < 5; i++) {
  fakeNow += 1000
  titles.push(beat())
}
const uniq = [...new Set(titles)]
expect('心跳推进 5 秒后 title 仍完全一致', uniq.length === 1, `得到 ${uniq.length} 种`)
if (uniq.length > 1) {
  console.log('    第一次:', JSON.stringify(uniq[0]?.split('\n').find((l) => l.includes('距'))))
  console.log('    最后一次:', JSON.stringify(uniq[uniq.length - 1]?.split('\n').find((l) => l.includes('距'))))
}

console.log('2) title 里不许再出现秒级倒计时')
const sample = titles[0] ?? ''
console.log('  当前 title:')
for (const line of sample.split('\n')) console.log('    | ' + line)
expect('不含 "距…：H:MM:SS" 形式的秒级倒计时', !/距[^：]*：\s*\d+:\d{2}:\d{2}/.test(sample))
expect('不含 "距…：MM:SS" 形式', !/距[^：]*：\s*\d{2}:\d{2}\s*$/m.test(sample))
expect('不再每行带实时时钟（"北京时间 HH:MM" 单独成行）', !/^北京时间 \d{2}:\d{2}/m.test(sample))

console.log('3) 仍然保留了有价值的口径信息')
expect('提到峰时窗口', /峰时（北京时间）/.test(sample))
expect('提到谷时口径', /谷时（北京时间）/.test(sample))
expect('给出下次换挡的绝对时刻', /距[^：]*：北京时间 \d{2}:\d{2}/.test(sample))

console.log('4) 界面上的秒级倒计时没被误伤（胶囊内联文字仍要每秒动）')
/** 深度收集渲染树里的文本。 */
function collectText (node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out }
  if (typeof node === 'object' && node.children) collectText(node.children, out)
  return out
}
const tree = registered['conversation.session.header.utilities']({})
const texts = collectText(tree?.children).join(' | ')
expect('胶囊内联文字里仍有 mm:ss 倒计时', /\d{1,2}:\d{2}/.test(texts), texts.slice(0, 140))

console.log('5) 界面倒计时确实随时间前进（对照：证明它是活的）')
const before = collectText(registered['conversation.session.header.utilities']({})?.children).join(' | ')
fakeNow += 5000
beat()
const after = collectText(registered['conversation.session.header.utilities']({})?.children).join(' | ')
expect('推进 5 秒后胶囊文字变了', before !== after, `before=${before.slice(0, 60)} after=${after.slice(0, 60)}`)

console.log('6) 已知残留：当日金额变化时 title 仍会变（低频，非每秒）')
const beforeUsage = titleNow()
I.applyUsage({
  day: '2026-09-15',
  pricing: { primary: { symbol: '¥', source: 'builtin' }, secondary: { symbol: '$', cost: 0.47 } },
  total: { cost: 3.42, calls: 12, tokens: { hit: 120000, miss: 45000, out: 8000 } },
  tiers: { peak: { cost: 1.1 }, valley: { cost: 2.32 } },
  models: [{ model: 'deepseek-flash', cost: 3.42, calls: 12 }],
  unpriced: { calls: 0 },
})
const afterUsage = titleNow()
expect('有金额后 title 确实会更新（这是可接受的低频变化）', beforeUsage !== afterUsage)
console.log('    金额行:', JSON.stringify(afterUsage.split('\n').find((l) => l.includes('今日'))))

console.log('7) 预览快捷键：避开浏览器冲突 + 精确匹配')
if (!Array.isArray(I.PREVIEW_SHORTCUTS)) {
  console.log('  SKIP 此版本未导出 PREVIEW_SHORTCUTS')
} else {
  const has = (b) => I.PREVIEW_SHORTCUTS.some((x) => x.key === b.key && x.shift === b.shift && x.alt === b.alt && x.ctrl === b.ctrl && x.meta === b.meta)
  expect('Ctrl+Shift+Alt+T 可用', has({ key: 't', ctrl: true, shift: true, alt: true, meta: false }))
  expect('⌘+Shift+Alt+T 可用（macOS）', has({ key: 't', ctrl: false, shift: true, alt: true, meta: true }))
  expect('旧组合 Ctrl+Shift+T 已不再占用（浏览器要用来恢复标签页）', !has({ key: 't', ctrl: true, shift: true, alt: false, meta: false }))
  expect('旧组合 ⌘+Shift+T 也未被占用', !has({ key: 't', ctrl: false, shift: true, alt: false, meta: true }))
  // 精确匹配意味着不会误触发
  const { PREVIEW_SHORTCUTS } = I
  const matches = (e) => PREVIEW_SHORTCUTS.some((b) => b.key === e.key && e.shiftKey === b.shift && e.altKey === b.alt && e.ctrlKey === b.ctrl && e.metaKey === b.meta)
  expect('Ctrl+Shift+T 事件不会命中', !matches({ key: 't', shiftKey: true, ctrlKey: true, altKey: false, metaKey: false }))
  expect('Ctrl+Shift+Alt+T 事件会命中', matches({ key: 't', shiftKey: true, ctrlKey: true, altKey: true, metaKey: false }))
}

console.log('8) 输入框里不抢快捷键')
expect('input 判定为可编辑', I.isEditableTarget?.({ tagName: 'INPUT' }) === true)
expect('textarea 判定为可编辑', I.isEditableTarget?.({ tagName: 'TEXTAREA' }) === true)
expect('contentEditable 判定为可编辑', I.isEditableTarget?.({ isContentEditable: true }) === true)
expect('普通 div 不算可编辑', I.isEditableTarget?.({ tagName: 'DIV' }) === false)

console.log('9) 悬停提示里的快捷键文案已更新')
expect('文案含新组合', /Ctrl\+Shift\+Alt\+T|Shift\+Option\+T/.test(sample), JSON.stringify(sample.split('\n').slice(-2)))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
