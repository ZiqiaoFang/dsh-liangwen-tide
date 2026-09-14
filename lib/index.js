/**
 * dsh-liangwen-tide 宿主半 —— 峰谷策略的自动更新 + 当日用量账本。
 *
 * 三件事，都不改宿主其它状态：
 *   1. 定期（默认每 6 小时）抓官方定价页中英文两版；
 *   2. 从同一份页面里解析出峰谷时段（lib/policy.js）与价目表（lib/pricing.js），
 *      解析失败就保留上一次结果；
 *   3. 把当前策略与当日用量（lib/usage.js：只算已结算的 assistant 调用，按事件时刻
 *      定档、按模型分桶）挂成只读路由给浏览器半：
 *        GET /liangwen-tide/policy         峰谷策略 + 价目表来源
 *        GET /liangwen-tide/usage          当日（北京时间）用量与金额
 *        GET /liangwen-tide/asset/<name>   换挡弹窗的人像（抠像后的 webp）
 *
 * 网络失败、页面改版、没有 sessionQuery 服务——一律不抛、不阻塞启动、不影响 UI：
 * 策略/价格退回「上一次成功的」或内置默认，用量退回「只统计本次进程内看到的调用」。
 *
 * 隐私：只读会话日志里的 token 计数与模型名，全部留在进程内存里（不落盘、不外发）。
 *
 * 可用 config（在 profile 的 cordis.patch.yml 里按 id 覆写本行）：
 *   autoUpdate:   false 关掉自动抓取（默认 true）
 *   refreshHours: 抓取间隔小时数（默认 6，最小 0.25）
 *   timeoutMs:    单次抓取超时毫秒（默认 10000）
 *   urls:         { en, zh } 自定义文档地址（默认官方定价页）
 *   trackUsage:   false 关掉当日用量账本与 /usage 路由（默认 true）
 *   celebrate:    false 关掉换挡弹窗（默认 true）
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BUILTIN_POLICY, PRICING_URLS, combineReports, dayKeyOf, parseRule, phaseAt as phaseAtOf, stripHtml } from './policy.js'
import { BUILTIN_PRICES, combinePriceTables, parsePriceTable } from './pricing.js'
import { backfillLedger, createLedger } from './usage.js'

/** Cordis 函数插件名（与装配行 id 一致，纯为可读性）。 */
export const name = 'liangwen-tide'

/** 两条只读路由都挂在 web carrier 上；connection 在请求时按需取。 */
export const inject = ['webServer']

/** 浏览器半从这里取峰谷策略。 */
export const POLICY_ROUTE = '/liangwen-tide/policy'
/** 浏览器半从这里取当日用量。 */
export const USAGE_ROUTE = '/liangwen-tide/usage'
/** 换挡弹窗的人像资源（抠像后的 webp），浏览器半按需取。 */
export const ASSET_ROUTE = '/liangwen-tide/asset'
/** 允许下发的资源白名单：抠像结果（不是原图，避免整张照片被搬来搬去）。 */
const ASSETS = {
  valley: 'tide-valley.webp',
  peak: 'tide-peak.webp',
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_REFRESH_HOURS = 6
const MIN_REFRESH_HOURS = 0.25
/** 浏览器点名要刷新时的最小间隔，免得每次刷新页面都去打官方文档。 */
const MIN_REQUEST_REFRESH_MS = 10 * 60 * 1000
/** 补历史时往回看多久（覆盖跨午夜的会话）。 */
const BACKFILL_LOOKBACK_MS = 36 * 3600_000
/** 报表里附带前几天（含今日）。 */
const RECENT_DAYS = 3

/** 把 config 收成一份带默认值的设置（config 不合法也不抛，退回默认）。 */
function readSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const hours = Number(raw.refreshHours)
  const timeout = Number(raw.timeoutMs)
  const urls = raw.urls !== null && typeof raw.urls === 'object' ? raw.urls : {}
  return {
    autoUpdate: raw.autoUpdate !== false,
    trackUsage: raw.trackUsage !== false,
    celebrate: raw.celebrate !== false,
    refreshHours: Number.isFinite(hours) && hours >= MIN_REFRESH_HOURS ? hours : DEFAULT_REFRESH_HOURS,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : DEFAULT_TIMEOUT_MS,
    urls: {
      en: typeof urls.en === 'string' && urls.en !== '' ? urls.en : PRICING_URLS.en,
      zh: typeof urls.zh === 'string' && urls.zh !== '' ? urls.zh : PRICING_URLS.zh,
    },
  }
}

/** 价目表对外摘要（不逐个下发单价，够浏览器写清来源即可）。 */
function publicPrices(prices) {
  if (prices === null || prices === undefined) return null
  return {
    currency: prices.currency,
    symbol: prices.symbol,
    source: prices.source,
    fetchedAt: prices.fetchedAt ?? null,
    models: Object.keys(prices.models),
  }
}

/** 当前策略的对外快照（JSON-safe，不含任何宿主内部对象）。 */
function publicPolicy(state) {
  return {
    windows: state.policy.windows,
    weekendAllValley: state.policy.weekendAllValley,
    source: state.policy.source,
    confidence: state.policy.confidence ?? null,
    conflict: state.policy.conflict === true,
    timezone: state.policy.timezone ?? null,
    assumedTimezone: state.policy.assumedTimezone === true,
    strategy: state.policy.strategy ?? null,
    evidence: state.policy.evidence ?? null,
    fetchedAt: state.policy.fetchedAt ?? null,
    checkedAt: state.checkedAt,
    refreshing: state.refreshing !== null,
    error: state.error,
    pricing: publicPrices(state.prices.primary),
    pricingSecondary: publicPrices(state.prices.secondary),
    pricingError: state.pricingError,
  }
}

function sendJson(res, status, payload, method) {
  const body = `${JSON.stringify(payload)}\n`
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  if (method === 'HEAD') {
    res.setHeader('content-length', Buffer.byteLength(body))
    res.end()
    return
  }
  res.end(body)
}

/**
 * 宿主插件体：建立策略/价格/用量状态，挂路由，按间隔抓取，订阅会话事件。
 * @param ctx - 宿主根上下文。
 * @param config - 本行的 config（见文件头）。
 */
export function apply(ctx, config) {
  const settings = readSettings(config)
  const state = {
    policy: { ...BUILTIN_POLICY },
    prices: {
      primary: { ...BUILTIN_PRICES.CNY, source: 'builtin', fetchedAt: null },
      secondary: { ...BUILTIN_PRICES.USD, source: 'builtin', fetchedAt: null },
    },
    pricingError: null,
    checkedAt: null,
    lastAttemptAt: 0,
    refreshing: null,
    error: null,
    backfill: settings.trackUsage ? { state: 'pending', sessions: 0, events: 0, skipped: 0, errors: [] } : null,
  }

  /** 当日账本：token 记账与价格解耦，出报表时才按当时价目表折金额。 */
  const ledger = settings.trackUsage
    ? createLedger({ phaseAt: (ms) => phaseAtOf(state.policy, ms), dayKeyOf })
    : null

  // ── 补历史 / 重建（档位变化时要按新档位重算）──────────────────────────────

  /** 重建期间到达的实时事件先缓冲，补完历史再按水位线去重吃进去。 */
  let rebuilding = false
  let buffered = []

  async function rebuildLedger(reason) {
    if (ledger === null || rebuilding) return
    rebuilding = true
    buffered = []
    ledger.reset()
    const stamp = { at: new Date().toISOString(), reason }
    // 可选服务一律用 ctx.get 拿（不能直接 ctx.sessionQuery —— cordis 要求先 inject）：
    // 没有会话索引服务时补不了历史，如实回报，实时订阅照常工作。
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
      rebuilding = false
      state.backfill = {
        state: 'unavailable',
        sessions: 0,
        calls: 0,
        skipped: 0,
        errors: ['sessionQuery 服务不可用（只统计本次运行内发生的调用）'],
        ...stamp,
      }
      ctx.logger?.warn?.('liangwen-tide: sessionQuery 不可用，当日用量只统计本次运行内发生的调用')
      return
    }
    const sessions = ctx.get('sessions')
    const sources = {
      listSessions: () => sessionQuery.listSessions(),
      readSession: (id) => sessionQuery.readSession(id),
      liveSessions: () => (sessions?.list?.() ?? []).map((session) => ({
        id: session.id,
        snapshotEvents: () => session.snapshotEvents(),
      })),
    }
    let report
    try {
      report = await backfillLedger(ledger, sources, { sinceMs: Date.now() - BACKFILL_LOOKBACK_MS })
    } catch (error) {
      report = { state: 'error', sessions: 0, calls: 0, skipped: 0, errors: [String(error?.message ?? error)] }
    }
    const pending = buffered
    buffered = []
    rebuilding = false
    for (const [sessionId, event, fallback] of pending) ledger.ingest(sessionId, event, fallback)
    state.backfill = { ...report, ...stamp }
    if (report.state !== 'done') {
      ctx.logger?.warn?.(`liangwen-tide: 当日用量补历史未完成（${report.state}）：${report.errors.join('; ') || '未知原因'}`)
    }
  }

  // 订阅实时事件：只有带 usage 的 assistant/message 会进账本。
  // 兜底模型：插件是会话中途才加载时，那次调用的 request/context 在插件启动前就写进日志了，
  // 于是从会话自己的路由快照里取当前模型（不然这些调用会被记成"未匹配价格"）。
  const modelOf = (session) => {
    try {
      const context = typeof session?.requestContext === 'function' ? session.requestContext() : undefined
      return typeof context?.model === 'string' ? context.model : undefined
    } catch {
      return undefined
    }
  }
  if (ledger !== null) {
    ctx.on('session/event', (session, event) => {
      if (session === null || session === undefined) return
      const sessionId = String(session.id)
      const fallback = modelOf(session)
      if (rebuilding) {
        buffered.push([sessionId, event, fallback])
        return
      }
      ledger.ingest(sessionId, event, fallback)
    })
  }

  // ── 抓取官方页面：时段 + 价格 ─────────────────────────────────────────────

  /** 抓一页 HTML（带超时；失败抛错，由 refresh 统一兜住）。 */
  async function fetchPage(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en,zh-CN;q=0.9',
          'user-agent': 'dsh-liangwen-tide/1.2 (+peak-policy & price sync)',
        },
      })
      if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
      return await response.text()
    } finally {
      clearTimeout(timer)
    }
  }

  /** 抓取 + 解析（时段与价格）+ 合成。永远 resolve；失败只更新 state.error。 */
  async function refresh(reason) {
    if (state.refreshing !== null) return state.refreshing
    state.refreshing = (async () => {
      state.lastAttemptAt = Date.now()
      const errors = []
      const priceErrors = []
      const grab = (url, locale) => fetchPage(url).then(
        (html) => ({ html, locale }),
        (error) => {
          errors.push(`${locale}: ${String(error?.message ?? error)}`)
          return null
        },
      )
      const [enPage, zhPage] = await Promise.all([grab(settings.urls.en, 'en'), grab(settings.urls.zh, 'zh')])

      const enReport = enPage === null ? null : parseRule(stripHtml(enPage.html), { locale: 'en' })
      const zhReport = zhPage === null ? null : parseRule(stripHtml(zhPage.html), { locale: 'zh' })
      const enPrices = enPage === null ? null : parsePriceTable(enPage.html, { locale: 'en' })
      const zhPrices = zhPage === null ? null : parsePriceTable(zhPage.html, { locale: 'zh' })
      const combined = combineReports(enReport, zhReport)
      const prices = combinePriceTables(zhPrices, enPrices, { fetchedAt: new Date().toISOString() })

      if (prices.primary === null) priceErrors.push('页面里没有解析到完整价目表')
      else if (prices.secondary === null) priceErrors.push('只有一侧价目表可用')
      if (enReport === null && zhReport === null && enPage !== null && zhPage !== null) {
        priceErrors.push('页面里没有解析到峰谷时段')
      }

      state.checkedAt = new Date().toISOString()
      state.pricingError = priceErrors.length > 0 ? priceErrors.join('; ') : null
      if (prices.primary !== null) state.prices = prices

      if (combined === null) {
        state.error = errors.length > 0 ? errors.join('; ') : '官方页面里没有解析到峰谷时段'
        ctx.logger?.warn?.(`liangwen-tide: 峰谷策略同步失败（沿用 ${state.policy.source}）：${state.error}`)
        return
      }

      const previous = state.policy
      const tierChanged = previous.weekendAllValley !== combined.weekendAllValley
        || JSON.stringify(previous.windows) !== JSON.stringify(combined.windows)
      const changed = previous.source !== combined.source || tierChanged
      state.policy = combined
      state.error = errors.length > 0 ? errors.join('; ') : null
      ctx.logger?.info?.(`liangwen-tide: 峰谷策略已同步（${combined.source}${changed ? '，有变化' : ''}）`)
      // 档位变了 → 已记的 token 要按新档位重新归档。
      if (tierChanged) void rebuildLedger('policy-changed')
    })().catch((error) => {
      state.error = String(error?.message ?? error)
      ctx.logger?.warn?.(`liangwen-tide: 峰谷策略同步异常：${state.error}`)
    }).finally(() => {
      state.refreshing = null
    })
    if (reason !== undefined) ctx.logger?.debug?.(`liangwen-tide: refresh (${reason})`)
    return state.refreshing
  }

  // ── 路由 ──────────────────────────────────────────────────────────────────

  /** 和官方插件一样先过 composition 的信任围栏（Host/Origin 防 DNS rebinding + 浏览器登录 cookie）。 */
  const rejected = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** 注册一条只读 JSON 路由。 */
  const registerRoute = (path, build) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }
        const url = new URL(String(req.url ?? path), 'http://dsh.invalid')
        sendJson(res, 200, build(url), req.method)
      },
    }), `liangwen-tide: GET ${path}`)
  }

  registerRoute(POLICY_ROUTE, (url) => {
    const wantsRefresh = settings.autoUpdate
      && url.searchParams.get('refresh') === '1'
      && Date.now() - state.lastAttemptAt >= MIN_REQUEST_REFRESH_MS
    if (wantsRefresh) void refresh('request')
    return publicPolicy(state)
  })

  registerRoute(USAGE_ROUTE, () => {
    if (ledger === null) return { enabled: false }
    const now = Date.now()
    const day = dayKeyOf(now)
    const report = ledger.report(day, state.prices.primary, {
      secondary: state.prices.secondary,
      recent: RECENT_DAYS,
      dayKeyShift: (key, offset) => (offset === 0 ? key : dayKeyOf(now - offset * 86_400_000)),
    })
    return {
      enabled: true,
      timezone: 'UTC+8',
      ...report,
      pricing: {
        primary: publicPrices(state.prices.primary),
        secondary: publicPrices(state.prices.secondary),
        error: state.pricingError,
      },
      policy: {
        windows: state.policy.windows,
        weekendAllValley: state.policy.weekendAllValley,
        source: state.policy.source,
        fetchedAt: state.policy.fetchedAt ?? null,
      },
      backfill: state.backfill,
      ledger: { sessions: ledger.sessionCount(), scannedEvents: ledger.scannedEventCount() },
      asOf: new Date(now).toISOString(),
    }
  })

  /** 起账本：注册「会话索引迟到」的补历史触发器，然后立刻补一次。 */
  const startLedger = () => {
    if (ledger === null) return
    if (ctx.get('sessionQuery') === undefined) {
      ctx.inject(['sessionQuery'], () => void rebuildLedger('session-query-ready'))
    }
    void rebuildLedger('boot')
  }

  // 人像资源：只读、白名单、进程内缓存（文件只有几十 KB，读一次就够）
  const assetCache = new Map()
  const readAsset = (name) => {
    const file = ASSETS[name]
    if (file === undefined) return null
    let bytes = assetCache.get(name)
    if (bytes === undefined) {
      try {
        bytes = readFileSync(fileURLToPath(new URL(`./assets/${file}`, import.meta.url)))
      } catch (error) {
        ctx.logger?.warn?.(`liangwen-tide: 读不到人像资源 ${file}：${String(error?.message ?? error)}`)
        bytes = null
      }
      assetCache.set(name, bytes)
    }
    return bytes
  }

  if (settings.celebrate) {
    // 注意：webserver 的前缀匹配是 pathname.startsWith(prefix + '/')，
    // 所以 prefix 不能带尾斜杠，否则永远匹配不上（踩过一次）。
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: ASSET_ROUTE,
      handler: (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }
        const name = new URL(String(req.url ?? '/'), 'http://dsh.invalid').pathname.slice(ASSET_ROUTE.length).replace(/^\//, '')
        const bytes = readAsset(name)
        if (bytes === null) {
          res.statusCode = 404
          res.end()
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'image/webp')
        res.setHeader('cache-control', 'public, max-age=86400')
        res.setHeader('content-length', bytes.byteLength)
        if (req.method === 'HEAD') res.end()
        else res.end(bytes)
      },
    }), `liangwen-tide: GET ${ASSET_ROUTE}/<name>`)
  }

  if (!settings.autoUpdate) {
    ctx.logger?.info?.('liangwen-tide: 已按 config 关闭官方策略/价格自动更新，使用内置口径')
    startLedger()
    return
  }

  // 启动即抓一次（不 await，不阻塞 boot），随后按间隔刷新；
  // 补历史也立刻开始（先用内置口径，官方口径到了且档位不同才重建）。
  void refresh('boot')
  startLedger()
  const timer = setInterval(() => void refresh('interval'), settings.refreshHours * 3600_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'liangwen-tide: policy refresh timer')
}
