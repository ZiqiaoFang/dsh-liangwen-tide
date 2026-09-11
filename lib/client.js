/**
 * dsh-liangwen-tide —— DeepSeek 峰谷指示器（浏览器端 bundle，经 __ModuleLoader__ 加载）。
 *
 * 一个梗：DeepSeek API 是峰谷分时计价，
 *   峰时 → 梁文峰（橙红点）
 *   谷时 → 梁文谷（青绿点）
 *
 * 挂载点（两个 list 插槽，同一份时钟）：
 *   - conversation.session.header.utilities —— 会话标题右侧的胶囊，
 *     显示「梁文峰 / 梁文谷 + 距下一次切换的倒计时 + 今日已用金额」；
 *   - sidebar.footer.action —— 侧栏底部（设置旁）的动作位；
 *     侧栏收成 56px 轨道时自动降级成一个状态点。
 *
 * 峰谷规则的来源（按新鲜度择优）：
 *   1. 宿主半从官方定价页抓取、解析、交叉校验后的策略
 *      （GET /liangwen-tide/policy，见 lib/index.js 与 lib/policy.js）；
 *   2. 本机 localStorage 里上次同步成功的官方策略
 *      —— 宿主机离线/重启时也不会退回旧口径；
 *   3. 内置兜底（与 lib/policy.js 的 BUILTIN_POLICY 一致，自检会比对）。
 * 悬停提示里会写明当前用的是哪一层、以及多久前同步的。
 *
 * 当日用量：宿主半的当日账本（GET /liangwen-tide/usage）——按北京时间自然日，
 * 按调用发生时刻的峰/谷档位、按模型分桶；金额用官方价目表算（¥ 主口径、$ 作对照）。
 * 胶囊上给一行 `今日 ¥x`，悬停展开 token 与模型明细。
 *
 * 依赖只有平台种子模块 `react`。样式全部走 --dsw-* 主题变量，跟随亮/暗主题。
 */

window.__ModuleLoader__.load({
  id: 'dsh-liangwen-tide',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useEffect, useState } = React
    const h = React.createElement

    // ── 策略来源 ──────────────────────────────────────────────────────────

    /** 宿主半的策略路由。 */
    const POLICY_ROUTE = '/liangwen-tide/policy'
    /** 宿主半的当日用量路由。 */
    const USAGE_ROUTE = '/liangwen-tide/usage'
    /** 页面存活期间向前端要策略的间隔（宿主自己另有抓取节流）。 */
    const POLICY_REFRESH_MS = 30 * 60 * 1000
    /** 页面存活期间刷新当日用量的间隔（调用在结算后才计入，所以近实时即可）。 */
    const USAGE_REFRESH_MS = 20 * 1000
    /** 本机缓存官方策略的 key。 */
    const POLICY_STORAGE_KEY = 'dsh.liangwen-tide.policy'

    const MINUTES_PER_DAY = 24 * 60

    /**
     * 内置兜底策略：官方 2026-08-17 起口径。
     * 峰 01:00–04:00、06:00–10:00 UTC；周六/周日（UTC 自然日）全天谷时。
     */
    const BUILTIN_POLICY = {
      windows: [
        { start: 1 * 60, end: 4 * 60 },
        { start: 6 * 60, end: 10 * 60 },
      ],
      weekendAllValley: true,
      source: 'builtin',
      fetchedAt: null,
    }

    const mod = (value, base) => ((value % base) + base) % base

    /**
     * 校验一份策略（宿主来的 JSON / localStorage / 测试注入）。
     * 形状不对或数值说不通就返回 null，调用方继续用现有策略。
     */
    function normalizePolicy(value) {
      if (value === null || typeof value !== 'object') return null
      const raw = value.windows
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 6) return null
      const windows = []
      for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') return null
        const start = Number(entry.start)
        const end = Number(entry.end)
        const valid = Number.isInteger(start) && Number.isInteger(end)
          && start >= 0 && start < MINUTES_PER_DAY && end >= 0 && end < MINUTES_PER_DAY
        if (!valid || start === end) return null
        windows.push({ start, end })
      }
      const total = windows.reduce((sum, window) => sum + mod(window.end - window.start, MINUTES_PER_DAY), 0)
      if (total <= 0 || total > 16 * 60) return null
      const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end)
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index].start <= sorted[index - 1].end) return null // 重叠：规则说不通
      }
      return {
        windows: sorted,
        weekendAllValley: value.weekendAllValley === true,
        source: typeof value.source === 'string' ? value.source : 'unknown',
        fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : null,
        conflict: value.conflict === true,
      }
    }

    /** 从 localStorage 取上次同步成功的官方策略（没有/坏了就 null）。 */
    function loadStoredPolicy() {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(POLICY_STORAGE_KEY)
        if (raw === null) return null
        const parsed = normalizePolicy(JSON.parse(raw))
        return parsed !== null && parsed.source.startsWith('official') ? parsed : null
      } catch {
        return null
      }
    }

    function storePolicy(policy) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(policy))
      } catch {
        // 隐私模式/配额满：缓存失败不影响使用。
      }
    }

    /** 当前生效的策略。 */
    let policy = loadStoredPolicy() ?? BUILTIN_POLICY

    // ── 峰谷判定（一律按 UTC 分钟，官方口径）──────────────────────────────

    /** 是否 UTC 周末自然日。 */
    function isWeekendUTC(date) {
      const day = date.getUTCDay()
      return day === 0 || day === 6
    }

    /** 某一时刻是否按峰时计价。 */
    function isPeakInstant(date) {
      if (policy.weekendAllValley && isWeekendUTC(date)) return false
      const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
      for (const window of policy.windows) {
        const inside = window.start < window.end
          ? minutes >= window.start && minutes < window.end
          : minutes >= window.start || minutes < window.end // 跨零点窗口
        if (inside) return true
      }
      return false
    }

    /** 'peak' | 'valley'。 */
    function phaseAt(ms) {
      return isPeakInstant(new Date(ms)) ? 'peak' : 'valley'
    }

    /**
     * 下一次档位翻转的时刻（毫秒）。按分钟步进扫描，最多看 4 天——
     * 最坏情况就是周六 00:00 UTC 看向下周一 01:00 UTC。
     */
    function nextFlipAt(ms) {
      const current = phaseAt(ms)
      let cursor = Math.floor(ms / 60000) * 60000 + 60000
      const limit = ms + 4 * 24 * 60 * 60000
      while (cursor <= limit) {
        if (phaseAt(cursor) !== current) return cursor
        cursor += 60000
      }
      return limit
    }

    // ── 展示文案 ──────────────────────────────────────────────────────────

    /** 当前档位的姓名梗：峰=梁文峰，谷=梁文谷。 */
    function nameOf(phase) {
      return phase === 'peak' ? '梁文峰' : '梁文谷'
    }

    function tierLabelOf(phase) {
      return phase === 'peak' ? '峰时' : '谷时'
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** 倒计时：不足 1 小时给 mm:ss，否则 h:mm:ss。 */
    function formatRemaining(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`
      return `${pad2(minutes)}:${pad2(seconds)}`
    }

    /** 北京时间 "HH:MM"。 */
    function beijingClock(ms) {
      const shifted = new Date(ms + 8 * 60 * 60000)
      return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`
    }

    /** 把策略窗口渲染成北京时间说明。 */
    function describeWindows(current) {
      const clock = (minutes) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`
      return current.windows
        .map((window) => {
          // 跨零点与否按北京时间看（UTC 16:30→00:30 正好是北京 00:30→08:30）。
          const start = mod(window.start + 8 * 60, MINUTES_PER_DAY)
          const end = mod(window.end + 8 * 60, MINUTES_PER_DAY)
          return end <= start ? `${clock(start)}–次日 ${clock(end)}` : `${clock(start)}–${clock(end)}`
        })
        .join('、')
    }

    /** "12 分钟前" / "3 小时前" / "2 天前"；没有时间戳给 null。 */
    function relativeAge(iso) {
      const at = Date.parse(iso ?? '')
      if (!Number.isFinite(at)) return null
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 90) return '刚刚同步'
      const minutes = Math.round(seconds / 60)
      if (minutes < 90) return `${minutes} 分钟前同步`
      const hours = Math.round(minutes / 60)
      if (hours < 36) return `${hours} 小时前同步`
      return `${Math.round(hours / 24)} 天前同步`
    }

    /** 策略来源的一句话说明（悬停提示用）。 */
    function policyLabel(current) {
      if (current.source === 'builtin') return '内置默认（尚未取到官方定价页）'
      const where = current.source === 'official:en+zh'
        ? '官方定价页（中英文一致）'
        : current.source === 'official:zh'
          ? '官方定价页（中文页）'
          : current.conflict
            ? '官方定价页（英文页；中英文口径不一致）'
            : '官方定价页（英文页）'
      const age = relativeAge(current.fetchedAt)
      return age === null ? where : `${where} · ${age}`
    }

    // ── 当日用量的文案与格式 ───────────────────────────────────────────────

    /** 金额：不足 0.01 时多给一位小数，免得显示成 ¥0.00。 */
    function formatMoney(value, symbol) {
      const amount = Number(value) || 0
      const text = amount > 0 && amount < 0.01 ? amount.toFixed(3) : amount.toFixed(2)
      return `${symbol ?? '¥'}${text}`
    }

    /** token 数：1.2M / 120.0k / 950。 */
    function formatTokens(value) {
      const count = Math.max(0, Number(value) || 0)
      if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
      if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
      return String(Math.round(count))
    }

    /** 价目表来源说明。 */
    function priceLabel(pricing) {
      if (pricing === null || pricing === undefined) return '内置价格表'
      if (pricing.source === 'builtin') return '内置价格表（尚未取到官方定价页）'
      const where = pricing.source === 'official:zh' ? '官方定价页（中文页）' : '官方定价页（英文页）'
      const age = relativeAge(pricing.fetchedAt)
      return age === null ? where : `${where} · ${age}`
    }

    /** 胶囊上那一行金额；没有用量数据时返回 null。 */
    function usageBadge() {
      if (usage === null) return null
      const symbol = usage.pricing?.primary?.symbol ?? '¥'
      return `今日 ${formatMoney(usage.total.cost, symbol)}`
    }

    /** 悬停提示里的当日用量段落（多行数组）。 */
    function usageLines() {
      if (usage === null) return ['今日用量：暂不可用']
      const symbol = usage.pricing?.primary?.symbol ?? '¥'
      const tokens = usage.total?.tokens ?? { hit: 0, miss: 0, out: 0 }
      const tiers = usage.tiers ?? {}
      const peakCost = tiers.peak?.cost ?? 0
      const valleyCost = tiers.valley?.cost ?? 0
      const lines = [
        `今日（北京时间）${formatMoney(usage.total.cost, symbol)} · ${usage.total.calls ?? 0} 次已结算调用`,
        `  峰时 ${formatMoney(peakCost, symbol)} · 谷时 ${formatMoney(valleyCost, symbol)}`,
        `  输入命中 ${formatTokens(tokens.hit)} · 未命中 ${formatTokens(tokens.miss)} · 输出 ${formatTokens(tokens.out)}`,
      ]
      const models = Array.isArray(usage.models) ? usage.models.slice(0, 4) : []
      if (models.length > 0) {
        const detail = models
          .map((entry) => `${entry.model} ${formatMoney(entry.cost, symbol)}（${entry.calls} 次）`)
          .join('、')
        lines.push(`  模型：${detail}`)
      }
      const secondary = usage.secondary
      if (secondary !== null && secondary !== undefined && secondary.symbol !== undefined) {
        lines.push(`  对照：${formatMoney(secondary.cost, secondary.symbol)}`)
      }
      const unpriced = usage.unpriced?.calls ?? 0
      if (unpriced > 0) lines.push(`  ${unpriced} 次调用的模型没匹配到价格，未计入金额`)
      lines.push(`  价格：${priceLabel(usage.pricing?.primary)}`)
      const previous = Array.isArray(usage.recent) ? usage.recent.find((entry) => entry.day !== usage.day) : undefined
      if (previous !== undefined) lines.push(`  昨日 ${formatMoney(previous.cost, symbol)}`)
      if (usage.backfill?.state === 'unavailable') lines.push('  （会话索引不可用，只统计本次运行内看到的调用）')
      return lines
    }

    /** 悬停提示（原生 title，多行）。 */
    function tooltipOf(state) {
      const nextName = nameOf(state.peak ? 'valley' : 'peak')
      const weekendLine = policy.weekendAllValley
        ? '谷时（北京时间）：其余时段，周六/周日全天'
        : '谷时（北京时间）：其余时段'
      const lines = [
        `DeepSeek API ${state.tierLabel} · ${state.name}`,
        `北京时间 ${beijingClock(state.now)}${state.weekend ? '（周末全天谷时）' : ''}`,
        '',
        `峰时（北京时间）：${describeWindows(policy)}`,
        weekendLine,
        `距${nextName}：${formatRemaining(state.remainingMs)}`,
        '',
        `策略：${policyLabel(policy)}`,
        '',
        ...usageLines(),
      ]
      return lines.join('\n')
    }

    // ── 时钟：一个共享的秒级快照，两个插槽共用 ────────────────────────────

    /** 全量快照（只有翻转或策略变化时才重算翻转点）。 */
    let anchor = null
    /** 最近一次发布的快照对象（React 靠它的引用变化触发重渲染）。 */
    let snapshot = null
    const listeners = new Set()

    function buildAnchor(ms) {
      const peak = phaseAt(ms)
      const flipAt = nextFlipAt(ms)
      return {
        peak,
        flipAt,
        weekend: policy.weekendAllValley && isWeekendUTC(new Date(ms)),
      }
    }

    function poll() {
      const ms = Date.now()
      if (anchor === null || ms >= anchor.flipAt) anchor = buildAnchor(ms)
      return {
        now: ms,
        peak: anchor.peak,
        weekend: anchor.weekend,
        name: nameOf(anchor.peak ? 'peak' : 'valley'),
        tierLabel: tierLabelOf(anchor.peak ? 'peak' : 'valley'),
        flipAt: anchor.flipAt,
        remainingMs: Math.max(0, anchor.flipAt - ms),
      }
    }

    snapshot = poll()

    function publish() {
      snapshot = poll()
      for (const listener of [...listeners]) listener(snapshot)
    }

    /**
     * 换用一份新策略（测试也走这里）。窗口变了就重算翻转点并广播。
     * @param next - 候选策略。
     * @param options - `persist` 为真时写入 localStorage。
     * @returns 是否真的换了。
     */
    function applyPolicy(next, options = {}) {
      const normalized = normalizePolicy(next)
      if (normalized === null) return false
      const same = normalized.weekendAllValley === policy.weekendAllValley
        && JSON.stringify(normalized.windows) === JSON.stringify(policy.windows)
      policy = normalized
      if (options.persist === true) storePolicy(normalized)
      if (!same) {
        anchor = null
        publish()
      }
      return !same
    }

    /** 采纳宿主下发的策略：只认官方来源，且不覆盖更新的本机缓存。 */
    function adoptFromServer(payload) {
      const next = normalizePolicy(payload)
      if (next === null || !next.source.startsWith('official')) return
      const servedAt = Date.parse(next.fetchedAt ?? '')
      const heldAt = Date.parse(policy.fetchedAt ?? '')
      if (Number.isFinite(heldAt) && Number.isFinite(servedAt) && servedAt < heldAt) return
      applyPolicy(next, { persist: true })
    }

    /** 向宿主要一次策略；失败静默（继续用现有策略）。 */
    async function syncPolicy() {
      try {
        const response = await fetch(`${POLICY_ROUTE}?refresh=1`, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!response.ok) return
        adoptFromServer(await response.json())
      } catch {
        // 宿主没起、离线、被围栏挡掉：都不是错误路径，保持现有策略。
      }
    }

    // ── 当日用量（宿主账本）────────────────────────────────────────────────

    /** 最近一次拿到的当日用量报表；null = 还没拿到。 */
    let usage = null

    /** 只接受形状可信的报表，坏数据当没拿到（不显示、不报错）。 */
    function normalizeUsage(payload) {
      if (payload === null || typeof payload !== 'object') return null
      if (payload.enabled === false) return null
      const total = payload.total
      if (total === null || typeof total !== 'object') return null
      if (!Number.isFinite(Number(total.cost)) || !Number.isFinite(Number(total.calls))) return null
      return payload
    }

    /** 换用一份用量报表（测试也走这里）。 */
    function applyUsage(payload) {
      const next = normalizeUsage(payload)
      if (next === null) return false
      usage = next
      publish()
      return true
    }

    /** 向宿主要一次当日用量；失败静默（保留上一份或什么都不显示）。 */
    async function syncUsage() {
      try {
        const response = await fetch(USAGE_ROUTE, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!response.ok) return
        applyUsage(await response.json())
      } catch {
        // 同上：拿不到就不显示金额，不影响峰谷指示。
      }
    }

    /** 秒级心跳：bundle 物化后常驻，插件卸载即随页面生命周期结束。 */
    if (typeof window.setInterval === 'function') window.setInterval(publish, 1000)
    if (typeof window.setTimeout === 'function') {
      window.setTimeout(() => void syncPolicy(), 0)
      window.setInterval(() => void syncPolicy(), POLICY_REFRESH_MS)
      window.setTimeout(() => void syncUsage(), 0)
      window.setInterval(() => void syncUsage(), USAGE_REFRESH_MS)
    }

    /** 订阅共享时钟 + 策略。 */
    function useTide() {
      const [state, setState] = useState(snapshot)
      useEffect(() => {
        listeners.add(setState)
        setState(poll())
        return () => {
          listeners.delete(setState)
        }
      }, [])
      return state
    }

    // ── 样式（全部内联，仅用 --dsw-* 主题变量，跟随亮/暗）──────────────────

    const FONT_STACK = 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)'
    const PEAK_COLOR = 'var(--dsw-alias-state-warn-primary, #d97706)'
    const VALLEY_COLOR = 'var(--dsw-alias-state-success-primary, #16a34a)'

    function tierColor(peak) {
      return peak ? PEAK_COLOR : VALLEY_COLOR
    }

    function dotStyle(peak, size) {
      const edge = size ?? 7
      return {
        width: `${edge}px`,
        height: `${edge}px`,
        flex: 'none',
        borderRadius: '50%',
        background: tierColor(peak),
        boxShadow: peak ? '0 0 0 3px rgba(217, 119, 6, 0.16)' : '0 0 0 3px rgba(22, 163, 74, 0.16)',
      }
    }

    function pillStyle() {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        boxSizing: 'border-box',
        height: '28px',
        padding: '0 10px',
        borderRadius: '14px',
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.28))',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontFamily: FONT_STACK,
        fontSize: '11px',
        fontWeight: 400,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        cursor: 'default',
        userSelect: 'none',
      }
    }

    const nameStyle = {
      fontWeight: 600,
      letterSpacing: '0.02em',
    }

    const countdownStyle = {
      color: 'var(--dsw-alias-label-secondary, inherit)',
      fontVariantNumeric: 'tabular-nums',
    }

    const costStyle = {
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontVariantNumeric: 'tabular-nums',
      fontWeight: 600,
    }

    const separatorStyle = {
      color: 'var(--dsw-alias-label-dimmed, inherit)',
      opacity: 0.6,
    }

    // ── 组件 ──────────────────────────────────────────────────────────────

    /** 会话标题右侧的胶囊：● 梁文峰 距谷 02:13:45 · 今日 ¥3.42。 */
    function TidePill() {
      const state = useTide()
      const badge = usageBadge()
      const children = [
        h('span', { key: 'dot', style: dotStyle(state.peak) }),
        h('span', { key: 'name', style: nameStyle }, state.name),
        h('span', { key: 'countdown', style: countdownStyle }, `距${state.peak ? '谷' : '峰'} ${formatRemaining(state.remainingMs)}`),
      ]
      if (badge !== null) {
        children.push(h('span', { key: 'sep', style: separatorStyle }, '·'))
        children.push(h('span', { key: 'cost', style: costStyle }, badge))
      }
      return h(
        'div',
        {
          style: pillStyle(),
          title: tooltipOf(state),
          'aria-label': `DeepSeek API ${state.tierLabel}，${state.name}${badge === null ? '' : `，${badge}`}`,
        },
        ...children,
      )
    }

    /** 侧栏底部动作位：宽侧栏给完整胶囊，56px 轨道给一个状态点。 */
    function SidebarTideAction(props) {
      const state = useTide()
      if (props !== undefined && props !== null && props.wide === false) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '28px',
              width: '28px',
              cursor: 'default',
            },
            title: tooltipOf(state),
            'aria-label': `DeepSeek API ${state.tierLabel}，${state.name}`,
          },
          h('span', { style: dotStyle(state.peak, 8) }),
        )
      }
      return h(TidePill)
    }

    // ── 插件主体 ──────────────────────────────────────────────────────────

    /** 只需要插槽注册表；两个插槽各自声明后再注册。 */
    const inject = ['slots']

    /**
     * 注册两个 list 插槽贡献。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) {
        console.warn('[dsh-liangwen-tide] slots 服务不可用，峰谷指示器未挂载')
        return
      }
      slots.inject('conversation.session.header.utilities', () =>
        slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'liangwen-tide',
            order: 5,
          },
          TidePill,
        ),
      )
      slots.inject('sidebar.footer.action', () =>
        slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'liangwen-tide',
            order: 5,
          },
          SidebarTideAction,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject

    /**
     * 离线自检出口（test/*.mjs 直接测这份真实代码，避免规则副本漂移）。
     * 运行时不消费它。
     */
    exports.__internal = {
      BUILTIN_POLICY,
      POLICY_ROUTE,
      USAGE_ROUTE,
      POLICY_STORAGE_KEY,
      normalizePolicy,
      applyPolicy,
      currentPolicy: () => policy,
      adoptFromServer,
      policyLabel,
      describeWindows,
      isWeekendUTC,
      isPeakInstant,
      phaseAt,
      nextFlipAt,
      nameOf,
      formatRemaining,
      // 当日用量
      applyUsage,
      currentUsage: () => usage,
      usageBadge,
      usageLines,
      normalizeUsage,
      formatMoney,
      formatTokens,
      priceLabel,
    }

    return module.exports
  },
})
