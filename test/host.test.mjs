/**
 * dsh-liangwen-tide 宿主半自检（lib/index.js）。
 *
 * 用一个本地 stub 文档服务器充当「官方定价页」，覆盖：
 *   1. 正常路径：抓到 → 解析时段与价目表 → 路由返回 official 策略；
 *   2. 故障路径：站点挂了/页面改版 → 路由仍然 200，返回内置兜底 + error，
 *      插件不抛、不阻塞、不影响 UI；
 *   3. autoUpdate:false → 一次网络请求都不发；
 *   4. 当日用量：补历史（sessionQuery）→ /usage 报表 → 实时事件继续累加。
 *
 * 运行：node test/host.test.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { apply, POLICY_ROUTE, USAGE_ROUTE } from '../lib/index.js'
import { BUILTIN_POLICY, phaseAt, samePolicy } from '../lib/policy.js'
import { BUILTIN_PRICES, priceCall } from '../lib/pricing.js'
import { EN_PAGE, ZH_PAGE } from './fixtures.mjs'

/** 起一个 stub 文档站，返回给定的两页（null 表示该路径 500）。 */
async function startDocsServer() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url)
    const body = req.url === '/en' ? EN_PAGE : req.url === '/zh' ? ZH_PAGE : null
    if (body === null) {
      res.writeHead(500)
      res.end('boom')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, hits, port: server.address().port }
}

/** 极简 ctx：只要 effect / get / on / logger / webServer.register / sessionQuery / sessions。 */
function makeCtx(options = {}) {
  let route = null
  const routes = new Map()
  const handlers = new Map()
  const ctx = {
    get: (name) => {
      if (name === 'sessionQuery') return options.sessionQuery
      if (name === 'sessions') return options.sessions ?? { list: () => [] }
      return undefined
    },
    inject: (deps, callback) => {
      if (deps.includes('sessionQuery') && options.sessionQuery === undefined) return () => {}
      callback(ctx)
      return () => {}
    },
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
      return () => {}
    },
    webServer: {
      register: (value) => {
        route = value
        routes.set(value.path, value)
        return () => {}
      },
    },
    sessionQuery: options.sessionQuery,
    sessions: options.sessions ?? { list: () => [] },
  }
  return {
    ctx,
    routeOf: () => routes.get(POLICY_ROUTE),
    routeAt: (path) => routes.get(path),
    emit: (name, ...args) => {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
  }
}

/** 直接调用注册进来的路由处理函数，收集响应。 */
function callRoute(route, { method = 'GET', url = POLICY_ROUTE } = {}) {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body) {
      this.body = body ?? ''
    },
  }
  route.handler({ method, url, headers: {} }, res)
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body, // 二进制资源（人像 webp）也要能断言
    json: () => JSON.parse(res.body === '' ? 'null' : res.body),
  }
}

/** 等策略状态稳定（宿主是 fire-and-forget 抓取）。 */
async function settle(route, { tries = 60 } = {}) {
  for (let index = 0; index < tries; index += 1) {
    const payload = callRoute(route).json()
    if (payload.refreshing === false) return payload
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('宿主策略一直处于 refreshing，未收敛')
}

// ── 1. 正常路径 ────────────────────────────────────────────────────────────

const docs = await startDocsServer()
{
  const { ctx, routeOf } = makeCtx()
  apply(ctx, {
    urls: { en: `http://127.0.0.1:${docs.port}/en`, zh: `http://127.0.0.1:${docs.port}/zh` },
    timeoutMs: 4000,
    refreshHours: 0.25,
  })
  const route = routeOf()
  assert.equal(route.path, POLICY_ROUTE)
  assert.equal(route.kind, 'exact')
  const payload = await settle(route)
  assert.equal(payload.source, 'official:en+zh', `应合成官方策略，实际 ${payload.source}`)
  assert.equal(payload.confidence, 'high')
  assert.equal(payload.conflict, false)
  assert.equal(payload.error, null)
  assert.ok(samePolicy(payload, BUILTIN_POLICY), '解析结果应与内置口径一致')
  assert.ok(typeof payload.fetchedAt === 'string' && Number.isFinite(Date.parse(payload.fetchedAt)))
  assert.ok(String(payload.evidence).includes('Peak hours are'))
  assert.ok(docs.hits.includes('/en') && docs.hits.includes('/zh'), '中英文两页都要抓')
  assert.equal(callRoute(route, { method: 'POST' }).status, 405)
  assert.equal(callRoute(route, { method: 'HEAD' }).status, 200)
  // 同一份页面里的价目表也要解析出来：人民币主口径 + 美元对照
  assert.equal(payload.pricingError, null, `价目表解析不该报错：${payload.pricingError}`)
  assert.equal(payload.pricing.currency, 'CNY')
  assert.equal(payload.pricing.source, 'official:zh')
  assert.deepEqual(payload.pricing.models, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(payload.pricingSecondary.currency, 'USD')
  assert.equal(payload.pricingSecondary.source, 'official:en')
  console.log('  1) 正常路径：official:en+zh + 中英文价目表，都抓都解析 ✓')
}
docs.server.close()

// ── 2. 故障路径：站点全挂 ──────────────────────────────────────────────────

{
  const { ctx, routeOf } = makeCtx()
  apply(ctx, {
    urls: { en: 'http://127.0.0.1:9/en', zh: 'http://127.0.0.1:9/zh' },
    timeoutMs: 1200,
    refreshHours: 0.25,
  })
  const route = routeOf()
  const payload = await settle(route, { tries: 120 })
  assert.equal(payload.source, 'builtin', '抓不到就退回内置兜底')
  assert.ok(typeof payload.error === 'string' && payload.error.length > 0, '错误要如实回报')
  assert.ok(samePolicy(payload, BUILTIN_POLICY), '兜底策略必须仍然可用')
  assert.equal(callRoute(route).status, 200, '路由永远 200 —— UI 不能因为网络问题坏掉')
  console.log('  2a) 站点不可达：退回内置兜底 + error，路由仍 200 ✓')
}

// ── 2b. 页面改版：200 但解析不出规则 ───────────────────────────────────────

{
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<p>Peak hours are whenever demand is highest.</p>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const { ctx, routeOf } = makeCtx()
  apply(ctx, { urls: { en: `http://127.0.0.1:${port}/en`, zh: `http://127.0.0.1:${port}/zh` }, timeoutMs: 2000 })
  const payload = await settle(routeOf())
  assert.equal(payload.source, 'builtin')
  assert.ok(String(payload.error).includes('没有解析到'), `错误应说明是解析问题，实际：${payload.error}`)
  server.close()
  console.log('  2b) 页面改版：解析不出 → 内置兜底 + 说明，不抛 ✓')
}

// ── 3. autoUpdate:false：一次请求都不发 ────────────────────────────────────

{
  const server = createServer((req, res) => {
    throw new Error('不该有请求')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const { ctx, routeOf } = makeCtx()
  apply(ctx, { autoUpdate: false, urls: { en: `http://127.0.0.1:${port}/en`, zh: `http://127.0.0.1:${port}/zh` } })
  const payload = callRoute(routeOf()).json()
  assert.equal(payload.source, 'builtin', '关闭自动更新后恒为内置策略')
  assert.equal(payload.refreshing, false)
  assert.equal(payload.checkedAt, null)
  await new Promise((resolve) => setTimeout(resolve, 100))
  server.close()
  console.log('  3) autoUpdate:false：不发网络请求，恒用内置策略 ✓')
}

// ── 4. 路由节流：refresh=1 不会每次都打官方页 ──────────────────────────────

{
  const docs2 = await startDocsServer()
  const { ctx, routeOf } = makeCtx()
  apply(ctx, {
    urls: { en: `http://127.0.0.1:${docs2.port}/en`, zh: `http://127.0.0.1:${docs2.port}/zh` },
    timeoutMs: 2000,
  })
  const route = routeOf()
  await settle(route)
  const before = docs2.hits.length
  for (let index = 0; index < 5; index += 1) callRoute(route, { url: `${POLICY_ROUTE}?refresh=1` })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(docs2.hits.length, before, '节流窗口内不得重复抓取')
  docs2.server.close()
  console.log('  4) refresh=1 节流：连续 5 次请求 0 次外呼 ✓')
}

// ── 5. 当日用量：补历史 + 实时累加 ─────────────────────────────────────────

/** 等用量路由的补历史收敛。 */
async function settleUsage(route, { tries = 80 } = {}) {
  for (let index = 0; index < tries; index += 1) {
    const payload = callRoute(route, { url: USAGE_ROUTE }).json()
    if (payload.backfill !== null && payload.backfill.state !== 'pending') return payload
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('补历史一直没收敛')
}

{
  const now = Date.now()
  const events = [
    { type: 'request/context', seq: 0, time: now, data: { model: 'deepseek-v4-pro' } },
    { type: 'assistant/message', seq: 1, time: now, data: { usage: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 400_000 } } },
  ]
  const stored = [{ header: { id: 'session-a', createdAt: now }, live: false, persisted: true }]
  const { ctx, routeOf, routeAt, emit } = makeCtx({
    sessionQuery: {
      listSessions: async () => stored,
      readSession: async (id) => {
        assert.equal(id, 'session-a')
        return { events }
      },
    },
  })
  // autoUpdate:false：不联网，策略用内置 —— 档位由事件时刻决定
  apply(ctx, { autoUpdate: false })
  const usageRoute = routeAt(USAGE_ROUTE)
  assert.ok(usageRoute !== undefined, '用量路由必须注册')
  assert.equal(usageRoute.path, USAGE_ROUTE)

  const payload = await settleUsage(usageRoute)
  assert.equal(payload.enabled, true)
  assert.equal(payload.timezone, 'UTC+8')
  assert.equal(payload.backfill.state, 'done')
  assert.equal(payload.backfill.sessions, 1)
  assert.equal(payload.total.calls, 1)
  assert.deepEqual(payload.total.tokens, { hit: 400_000, miss: 1_000_000, out: 500_000 }, '命中与未命中是互斥两桶')

  // 金额与 lib/pricing.js 的口径逐位对齐（主口径人民币）
  const tier = phaseAt(BUILTIN_POLICY, now)
  const expected = priceCall({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 400_000 }, 'deepseek-v4-pro', tier, BUILTIN_PRICES.CNY)
  assert.equal(payload.total.cost, expected.cost)
  assert.equal(payload.tiers[tier].cost, expected.cost)
  assert.equal(payload.models[0].model, 'deepseek-v4-pro')
  assert.equal(payload.pricing.primary.currency, 'CNY')
  assert.equal(payload.pricing.error, null, 'autoUpdate:false 时不报价格同步错误')
  assert.equal(payload.recent[0].day, payload.day)

  // 实时事件继续累加（同一会话，seq 前进）
  emit('session/event', { id: 'session-a' }, { type: 'assistant/message', seq: 2, time: now, data: { usage: { inputTokens: 0, outputTokens: 1_000_000 } } })
  const afterLive = callRoute(usageRoute, { url: USAGE_ROUTE }).json()
  assert.equal(afterLive.total.calls, 2, '实时事件要立刻进账本')
  assert.ok(afterLive.total.cost > payload.total.cost)

  // 重复的 seq 不会再算一次
  emit('session/event', { id: 'session-a' }, { type: 'assistant/message', seq: 2, time: now, data: { usage: { inputTokens: 0, outputTokens: 1_000_000 } } })
  assert.equal(callRoute(usageRoute, { url: USAGE_ROUTE }).json().total.calls, 2)

  assert.equal(callRoute(usageRoute, { method: 'POST', url: USAGE_ROUTE }).status, 405)
  console.log('  5) 当日用量：补历史 + 实时累加 + 去重，金额与价目表口径一致 ✓')
}

// ── 6. 用量账本的降级路径 ──────────────────────────────────────────────────

{
  // 没有 sessionQuery：实时订阅照常，历史补不了，如实回报
  const { ctx, routeAt, emit } = makeCtx()
  apply(ctx, { autoUpdate: false })
  const route = routeAt(USAGE_ROUTE)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const payload = callRoute(route, { url: USAGE_ROUTE }).json()
  assert.equal(payload.enabled, true)
  assert.equal(payload.backfill.state, 'unavailable')
  assert.match(payload.backfill.errors[0], /sessionQuery/)
  assert.equal(payload.total.calls, 0)
  emit('session/event', { id: 'session-x' }, { type: 'assistant/message', seq: 0, time: Date.now(), data: { usage: { inputTokens: 1000 } } })
  assert.equal(callRoute(route, { url: USAGE_ROUTE }).json().total.calls, 1, '补不了历史也不影响实时记账')
}

{
  // trackUsage:false：路由明说没开
  const { ctx, routeAt } = makeCtx()
  apply(ctx, { autoUpdate: false, trackUsage: false })
  const payload = callRoute(routeAt(USAGE_ROUTE), { url: USAGE_ROUTE }).json()
  assert.deepEqual(payload, { enabled: false })
  console.log('  6) 降级路径：无 sessionQuery 只算实时；trackUsage:false 明说没开 ✓')
}

// ── 7. 换挡弹窗的人像资源路由 ─────────────────────────────────────────────

{
  const { ctx, routeAt } = makeCtx()
  apply(ctx, { autoUpdate: false })
  const route = routeAt('/liangwen-tide/asset')
  assert.ok(route !== undefined, '应注册人像资源路由')
  assert.equal(route.kind, 'prefix')

  const ok = callRoute(route, { url: '/liangwen-tide/asset/valley' })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'image/webp')
  assert.equal(ok.headers['cache-control'], 'public, max-age=86400')
  const packed = readFileSync(new URL('../lib/assets/tide-valley.webp', import.meta.url))
  assert.equal(ok.body.length, packed.byteLength, '下发的字节数应与包内文件一致')
  assert.ok(Buffer.compare(Buffer.from(ok.body), packed) === 0, '下发的应该就是包里那张抠像')
  assert.ok(packed.byteLength > 10_000, '人像资源应是几十 KB 的 webp')

  assert.equal(callRoute(route, { url: '/liangwen-tide/asset/peak' }).status, 200)
  assert.equal(callRoute(route, { url: '/liangwen-tide/asset/nope' }).status, 404, '白名单之外要 404')
  assert.equal(callRoute(route, { url: '/liangwen-tide/asset/../../package.json' }).status, 404, '目录穿越要 404')
  assert.equal(callRoute(route, { method: 'POST', url: '/liangwen-tide/asset/valley' }).status, 405)
  const head = callRoute(route, { method: 'HEAD', url: '/liangwen-tide/asset/peak' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '', 'HEAD 不带 body')

  // celebrate:false 时整条路由都不该注册
  const off = makeCtx()
  apply(off.ctx, { autoUpdate: false, celebrate: false })
  assert.equal(off.routeAt('/liangwen-tide/asset'), undefined, 'celebrate:false 不该注册资源路由')
  console.log('  7) 换挡弹窗资源：白名单 + 字节一致 + 404/405/HEAD + 可关闭 ✓')
}

// ── 8. live 事件的模型兜底（插件是会话中途才加载的情况）───────────────────

{
  const { ctx, routeAt, emit } = makeCtx()
  apply(ctx, { autoUpdate: false })
  const usageRoute = routeAt(USAGE_ROUTE)
  // 等第一次补历史收敛（没有 sessionQuery → unavailable）
  await new Promise((resolve) => setTimeout(resolve, 30))

  // 会话自己的路由快照里有模型；事件流里**没有** request/context
  const session = { id: 'session-live', requestContext: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash' }) }
  emit('session/event', session, {
    type: 'assistant/message', seq: 7, time: Date.now(),
    data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 100_000 } },
  })
  const payload = callRoute(usageRoute, { url: USAGE_ROUTE }).json()
  assert.equal(payload.total.calls, 1)
  assert.equal(payload.unpriced.calls, 0, '有兜底模型就不该记成"未匹配价格"（这就是用户看到的"模型获取失败"）')
  assert.equal(payload.models[0].model, 'deepseek-v4-flash')
  assert.ok(payload.total.cost > 0, '应当算出金额')
  console.log('  8) live 兜底模型：会话中途加载也能定价（不再未匹配）✓')
}

console.log('dsh-liangwen-tide: host 自检 57 项通过')
