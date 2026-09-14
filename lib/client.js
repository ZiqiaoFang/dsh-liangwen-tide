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
    /** 换挡弹窗的人像资源（宿主半下发，带 alpha 的抠像）。 */
    const ASSET_ROUTE = '/liangwen-tide/asset'
    /** 弹窗默认参数：原图抠像、光芒中、小尺寸（按确认过的方案）。 */
    const CELEBRATION = {
      seconds: 6,        // 停留时长（悬停暂停，点图/✕ 立即关）
      height: 170,       // 人像高度（"小"）
      glow: 0.75,        // 光芒强度（"中"）
      gap: 10,           // 与胶囊的间距
      margin: 8,         // 距视口边缘的最小留白
      maxAgeMs: 60_000,  // 只在"刚过点"时才补弹（挂起后恢复不会突然蹦出几小时前的图）
    }
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

    /**
     * 倒计时的「分钟粒度」写法：不带秒。
     * 专供胶囊的原生 title 使用 —— 秒级倒计时会让 title 每秒变化一次，
     * 而浏览器（Chromium/Edge）在 tooltip 已弹出时改写 title 会让它反复重弹
     * （表现为悬停时一闪一闪；Safari 不跟随属性更新，所以那儿看不出问题）。
     * 界面上（胶囊内联文字、换挡弹窗）仍然用秒级 formatRemaining。
     */
    function formatRemainingRounded(ms) {
      const totalSeconds = Math.max(0, Math.floor(ms / 1000))
      const totalMinutes = Math.round(totalSeconds / 60)
      const hours = Math.floor(totalMinutes / 60)
      const minutes = totalMinutes % 60
      if (hours > 0) return `${hours} 小时 ${pad2(minutes)} 分`
      return `${minutes} 分钟`
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
      // 换挡时刻是「绝对时间」，不随时间流逝而变 —— 可以安全地放进这张卡里。
      // （曾经这里放的是「距换挡还有 8:38:17」这类秒级倒计时，那才是闪烁的根源。）
      const flipClock = beijingClock(state.flipAt)
      const lines = [
        `DeepSeek API ${state.tierLabel} · ${state.name}`,
        // 这里以前是「北京时间 HH:MM」+ 秒级倒计时：两者都让 title 周期性变化，
        // 而浏览器在 tooltip 已弹出时改写 title 会让它反复重弹（悬停一闪一闪）。
        // 现在这张卡只放不随时间变的口径信息 —— 实时倒计时胶囊上本来就有。
        ...(state.weekend ? ['（周末全天谷时）'] : []),
        '',
        `峰时（北京时间）：${describeWindows(policy)}`,
        weekendLine,
        `距${nextName}：北京时间 ${flipClock}`,
        '',
        `策略：${policyLabel(policy)}`,
        '',
        ...usageLines(),
        '',
        `${previewShortcutLabel()} 预览换挡提示`,
      ]
      return lines.join('\n')
    }

    // ── 换挡弹窗：样式 + 智能定位 + 触发判定 ──────────────────────────────

    /** 弹窗样式：类名统一 lwt- 前缀；只用 --dsw-* 主题变量，跟随亮/暗。 */
    const POPUP_CSS = `
.lwt-pop { position: absolute; display: flex; flex-direction: column; align-items: center;
  /* 整块弹窗都要吃鼠标事件：悬停暂停与点击关闭都以这个矩形为准。
     曾经这里是 none（只有说明条 auto），结果鼠标压在「人像 / 光芒」上时
     hovering 不会置位，弹窗会在用户明明悬停着的时候自己关掉。 */
  pointer-events: auto; --lwt-glow: .75; }
.lwt-burst { position: absolute; left: 50%; top: calc(var(--lwt-h) / 2); width: 158%; height: calc(var(--lwt-h) * 1.02);
  transform: translate(-50%, -50%); pointer-events: none; z-index: 0;
  -webkit-mask-image: linear-gradient(to bottom, #000 74%, transparent 97%);
  mask-image: linear-gradient(to bottom, #000 74%, transparent 97%); }
.lwt-halo, .lwt-rays, .lwt-rays2, .lwt-ring { position: absolute; left: 50%; top: 50%; border-radius: 50%; }
.lwt-halo { width: 96%; height: 96%; filter: blur(20px); opacity: var(--lwt-glow);
  background: radial-gradient(closest-side, var(--lwt-soft) 10%, rgba(255,255,255,.06) 42%, transparent 72%); }
.lwt-rays { width: 150%; height: 150%; filter: blur(1.7px); opacity: calc(var(--lwt-glow) * .42);
  background: repeating-conic-gradient(from 0deg, var(--lwt-strong) 0deg 1.1deg, transparent 1.1deg 8.6deg);
  -webkit-mask-image: radial-gradient(closest-side, transparent 6%, rgba(0,0,0,.75) 24%, rgba(0,0,0,.32) 54%, transparent 78%);
  mask-image: radial-gradient(closest-side, transparent 6%, rgba(0,0,0,.75) 24%, rgba(0,0,0,.32) 54%, transparent 78%); }
.lwt-rays2 { width: 176%; height: 176%; filter: blur(5px); opacity: calc(var(--lwt-glow) * .6);
  background: repeating-conic-gradient(from 7deg, var(--lwt-soft) 0deg 2.4deg, transparent 2.4deg 26deg);
  -webkit-mask-image: radial-gradient(closest-side, transparent 12%, rgba(0,0,0,.55) 34%, rgba(0,0,0,.2) 62%, transparent 84%);
  mask-image: radial-gradient(closest-side, transparent 12%, rgba(0,0,0,.55) 34%, rgba(0,0,0,.2) 62%, transparent 84%); }
.lwt-ring { width: 62%; height: 62%; border: 2px solid var(--lwt-strong); opacity: 0; }
.lwt-figure { position: relative; z-index: 1; height: var(--lwt-h); width: auto; display: block; opacity: 0;
  filter: drop-shadow(0 12px 20px rgba(0,0,0,.42)) drop-shadow(0 2px 4px rgba(0,0,0,.25));
  -webkit-mask-image: linear-gradient(to bottom, #000 79%, rgba(0,0,0,.5) 92%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 79%, rgba(0,0,0,.5) 92%, transparent 100%); pointer-events: none; } /* 装饰层不吃事件，交给 .lwt-pop 统一判定 */
.lwt-cap { position: relative; z-index: 3; margin-top: 4px; padding: 7px 11px 8px; border-radius: 11px;
  border: .5px solid var(--dsw-alias-border-l4); width: max-content; max-width: 214px; text-align: left;
  /* 主题自适配：不猜 data-* 属性名（DSH 用的是 data-ds-dark-theme），直接用主题变量 */
  background: var(--dsw-alias-bg-layer-2, rgba(42,42,46,.92));
  background: color-mix(in srgb, var(--dsw-alias-tooltip-bg, var(--dsw-alias-bg-layer-2, #2a2a2e)) 90%, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: var(--dsw-elevation-prominent, 0 10px 26px rgba(0,0,0,.35)); pointer-events: none; } /* 同 figure：不再是唯一的命中目标 */
.lwt-cap-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.lwt-cap-head b { font-size: 11.5px; letter-spacing: .02em; }
.lwt-cap-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: .5px solid var(--dsw-alias-border-l4); color: var(--dsw-alias-label-secondary); }
.lwt-cap-sub { margin-top: 3px; font-size: 10.5px; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.lwt-cap-sub em { font-style: normal; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.lwt-bar { margin-top: 6px; height: 2px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-border-l2); }
.lwt-bar > i { display: block; height: 100%; width: 100%; transform-origin: 0 50%; }
.lwt-close { position: absolute; top: -8px; right: -8px; width: 22px; height: 22px; border-radius: 50%; z-index: 4;
  border: 0; cursor: pointer; color: #fff; background: rgba(0,0,0,.5); font-size: 13px; line-height: 1;
  display: grid; place-items: center; pointer-events: auto; }
.lwt-show .lwt-figure { animation: lwt-in .36s cubic-bezier(.22,1.2,.34,1) both, lwt-bob 4.6s ease-in-out .36s infinite; }
.lwt-show .lwt-halo { animation: lwt-breathe 3.8s ease-in-out infinite, lwt-burstin .55s cubic-bezier(.2,1,.3,1) both; }
.lwt-show .lwt-rays { animation: lwt-spin 26s linear infinite, lwt-burstin .55s cubic-bezier(.2,1,.3,1) both; }
.lwt-show .lwt-rays2 { animation: lwt-spinrev 40s linear infinite, lwt-burstin .7s cubic-bezier(.2,1,.3,1) both; }
.lwt-show .lwt-ring { animation: lwt-ringflash .62s cubic-bezier(.2,.8,.2,1) both; }
@keyframes lwt-in { 0% { opacity: 0; transform: translateY(-12px) scale(.86) } 62% { opacity: 1; transform: translateY(0) scale(1.025) } 100% { opacity: 1; transform: none } }
@keyframes lwt-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
@keyframes lwt-breathe { 0%,100% { transform: translate(-50%,-50%) scale(.94) } 50% { transform: translate(-50%,-50%) scale(1.06) } }
@keyframes lwt-burstin { from { transform: translate(-50%,-50%) scale(.55) } to { transform: translate(-50%,-50%) scale(1) } }
@keyframes lwt-spin { to { transform: translate(-50%,-50%) rotate(360deg) } }
@keyframes lwt-spinrev { to { transform: translate(-50%,-50%) rotate(-360deg) } }
@keyframes lwt-ringflash { 0% { transform: translate(-50%,-50%) scale(.34); opacity: .9 } 100% { transform: translate(-50%,-50%) scale(1.55); opacity: 0 } }
@media (prefers-reduced-motion: reduce) {
  .lwt-show .lwt-figure, .lwt-show .lwt-halo, .lwt-show .lwt-rays, .lwt-show .lwt-rays2, .lwt-show .lwt-ring { animation: none }
  .lwt-show .lwt-figure { opacity: 1 }
}
`

    /** 注入一次样式（标签带 data-plugin，DSH 的 HMR 会认这两组属性）。 */
    function ensurePopupStyles() {
      const id = 'dsh-liangwen-tide/Celebration.css'
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-liangwen-tide'
      tag.dataset.pluginCss = id
      tag.textContent = POPUP_CSS
      document.head.appendChild(tag)
    }

    /**
     * 弹窗定位（纯函数，便于自检）。
     *
     * 胶囊在**会话标题栏右端**：上面就是窗口顶边、右边就是窗口右边缘，
     * 所以默认向下弹（下方是对话区，空间足），放不下才翻到上方；
     * 水平方向与胶囊**右对齐**（向左伸展），再夹进视口留白内。
     *
     * @param anchor - 胶囊的 getBoundingClientRect（视口坐标）
     * @param size - 弹窗尺寸
     * @param viewport - 视口尺寸
     * @returns `{ dir, left, top }`（仍是视口坐标，调用方减去悬浮层原点）
     */
    function placePopup(anchor, size, viewport) {
      const { gap, margin } = CELEBRATION
      const roomBelow = viewport.height - anchor.bottom - gap - margin
      const dir = roomBelow >= size.height ? 'down' : 'up'
      const top = dir === 'down' ? anchor.bottom + gap : anchor.top - gap - size.height
      const maxLeft = Math.max(margin, viewport.width - size.width - margin)
      const left = Math.min(Math.max(margin, anchor.right - size.width), maxLeft)
      return { dir, left, top: Math.max(margin, top) }
    }

    /**
     * 取主题变量的**具体色值**：rgba() 需要能拆开的颜色，
     * 而主题变量本身是 `var(--dsw-...)`，直接拆会得到 NaN（踩过这个坑）。
     * @param peak - true 取峰时色，false 取谷时色
     * @returns 形如 `#22c55e` / `rgb(34,197,94)` 的具体色值
     */
    function themeColor(peak) {
      const name = peak ? '--dsw-alias-state-warn-primary' : '--dsw-alias-state-success-primary'
      const fallback = peak ? '#d97706' : '#16a34a'
      try {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
        if (value !== '') return value
      } catch {
        // 拿不到就退回兜底色
      }
      return fallback
    }

    /**
     * 给具体色值加透明度。认不出来的写法（例如仍是 var(...)）原样返回 ——
     * 宁可不透明，也不要拼出 `rgba(NaN, NaN, NaN, .5)` 这种无效值。
     */
    function rgba(color, alpha) {
      const text = String(color).trim()
      if (text.startsWith('#')) {
        const hex = text.slice(1)
        const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
        if (full.length < 6) return text
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
        if ([r, g, b].some((value) => !Number.isFinite(value))) return text
        return `rgba(${r}, ${g}, ${b}, ${alpha})`
      }
      const match = /^rgba?\(([^)]+)\)/.exec(text)
      if (match !== null) {
        const parts = match[1].split(',').map((value) => parseFloat(value))
        if (parts.length >= 3 && parts.slice(0, 3).every((value) => Number.isFinite(value))) {
          return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`
        }
      }
      return text
    }

    /**
     * 把定位结果写到弹窗元素上，并让它可见。
     *
     * 为什么要单独一个函数：定位必须在**挂载后**量尺寸（那时才知道实际大小），
     * 而"可见/播入场动画"如果依赖渲染时的字段，effect 里改字段不会重渲染 ——
     * 结果就是弹窗永远 `visibility: hidden`（实际插件上踩过这个坑）。
     * 所以这里直接写 DOM：left/top + visibility + 入场 class。
     *
     * @param box - 弹窗根元素
     * @param anchorRect - 胶囊的 getBoundingClientRect（视口坐标）
     * @param layerRect - 悬浮层的 getBoundingClientRect（弹窗坐标以它为原点）
     * @param viewport - 视口尺寸
     * @returns 定位结果，或 null（没量到）
     */
    function applyPlacement(box, anchorRect, layerRect, viewport) {
      if (box === null || box === undefined || anchorRect === null || anchorRect === undefined) return null
      const size = { width: box.offsetWidth || 200, height: box.offsetHeight || 260 }
      const placement = placePopup(anchorRect, size, viewport)
      box.style.left = `${placement.left - (layerRect?.left ?? 0)}px`
      box.style.top = `${placement.top - (layerRect?.top ?? 0)}px`
      box.style.visibility = 'visible'
      if (typeof box.classList?.add === 'function') box.classList.add('lwt-show')
      return placement
    }

    /**
     * 是否该弹（纯函数，便于自检）。只在**真的刚过点**时弹：
     * 页面刚打开不弹（lastPhase 为 null），标签页被挂起后恢复也不补弹（超过 maxAgeMs）。
     * @param previous - 上一次 tick 的快照（含 phase 与即将到来的 flipAt）
     * @param current - 本次快照
     * @param options - `{ enabled, maxAgeMs }`
     */
    function shouldCelebrate(previous, current, options = {}) {
      const enabled = options.enabled ?? true
      const maxAge = options.maxAgeMs ?? CELEBRATION.maxAgeMs
      if (!enabled || previous === null || previous === undefined) return false
      if (previous.phase === current.phase) return false
      return current.now - previous.flipAt <= maxAge && current.now - previous.flipAt >= -1000
    }

    // ── 时钟：一个共享的秒级快照，两个插槽共用 ────────────────────────────

    /** 全量快照（只有翻转或策略变化时才重算翻转点）。 */
    let anchor = null
    /** 最近一次发布的快照对象（React 靠它的引用变化触发重渲染）。 */
    let snapshot = null
    const listeners = new Set()

    function buildAnchor(ms) {
      // 存 phase 字符串（'peak' | 'valley'），折成布尔只在下游做一次 ——
      // 曾经这里直接把字符串当布尔往下传，而 'valley' 是 truthy，
      // 于是胶囊永远显示「峰」。类型边界只保留一个，别在这里混用。
      const phase = phaseAt(ms)
      const flipAt = nextFlipAt(ms)
      return {
        phase,
        flipAt,
        weekend: policy.weekendAllValley && isWeekendUTC(new Date(ms)),
      }
    }

    function poll() {
      const ms = Date.now()
      if (anchor === null || ms >= anchor.flipAt) anchor = buildAnchor(ms)
      const peak = anchor.phase === 'peak'
      return {
        now: ms,
        phase: anchor.phase,
        peak,
        weekend: anchor.weekend,
        name: nameOf(anchor.phase),
        tierLabel: tierLabelOf(anchor.phase),
        flipAt: anchor.flipAt,
        remainingMs: Math.max(0, anchor.flipAt - ms),
      }
    }

    snapshot = poll()

    function publish() {
      snapshot = poll()
      // 换挡判定：用上一次 tick 的 flipAt 当"刚跨过的边界"，避免猜
      if (shouldCelebrate(previousTick, snapshot, { enabled: CELEBRATION.enabled !== false })) {
        fireCelebration(snapshot.phase, previousTick.flipAt)
      }
      previousTick = snapshot
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

    // ── 换挡弹窗：状态机 ──────────────────────────────────────────────────

    /** 当前弹窗状态（根级悬浮层组件读它渲染）。 */
    let celebration = null
    /** 指针监听的拆除函数：弹窗收起或组件卸载时都要摘掉。 */
    let pointerWatchCleanup = null
    /** 自动关闭用的 rAF 句柄。 */
    let celebrationRaf = 0
    /** rAF 兜底：自检环境/极老浏览器没有 requestAnimationFrame 时退化到定时器。 */
    const scheduleFrame = typeof requestAnimationFrame === 'function'
      ? (fn) => requestAnimationFrame(fn)
      : (fn) => setTimeout(() => fn(Date.now()), 200)
    const cancelFrame = typeof cancelAnimationFrame === 'function'
      ? (id) => cancelAnimationFrame(id)
      : (id) => { if (typeof clearTimeout === 'function') clearTimeout(id) }
    /** 胶囊的 DOM 节点：弹窗据此定位（在 UI 里的实际位置）。
     *  标题栏那颗优先；没开会话时标题栏不渲染，就用侧栏底部那颗兜底。 */
    let headerAnchor = null
    let sidebarAnchor = null
    const anchorNode = () => headerAnchor ?? sidebarAnchor
    /** 上一次 tick 的快照，用来识别"刚刚换挡"。 */
    let previousTick = null
    /** 人像资源（懒加载后缓存；失败就静默不弹）。 */
    const assetCache = new Map()

    const celebrationListeners = new Set()
    const notifyCelebration = () => {
      for (const listener of [...celebrationListeners]) listener(celebration)
    }

    /** 预取人像：两张小图，页面空闲时先拉好，换挡那一下不会白屏。 */
    function prefetchAssets() {
      if (typeof Image === 'undefined') return
      for (const name of ['valley', 'peak']) {
        if (assetCache.has(name)) continue
        const image = new Image()
        image.decoding = 'async'
        image.src = `${ASSET_ROUTE}/${name}`
        assetCache.set(name, image)
      }
    }

    /**
     * 自动关闭的倒计时循环：每帧扣掉经过的时间（悬停时暂停），
     * 顺带把进度条缩到对应比例；到点就关。
     * 弹窗只活几秒，一次 rAF 循环足够便宜。
     */
    function tickCelebration(timestamp) {
      const active = celebration
      if (active === null) { celebrationRaf = 0; return }
      const delta = active.lastTick === 0 ? 0 : timestamp - active.lastTick
      active.lastTick = timestamp
      if (!active.hovering) active.hideAt -= delta
      const total = Math.max(1, CELEBRATION.seconds * 1000)
      const progress = Math.max(0, Math.min(1, active.hideAt / total))
      const bar = active.barNode
      if (bar !== null && bar !== undefined) bar.style.transform = `scaleX(${progress})`
      if (active.hideAt <= 0) {
        hideCelebration()
        return
      }
      celebrationRaf = scheduleFrame(tickCelebration)
    }

    /** 关掉弹窗。 */
    function hideCelebration() {
      if (celebrationRaf !== 0) {
        cancelFrame(celebrationRaf)
        celebrationRaf = 0
      }
      if (celebration === null) return
      celebration = null
      notifyCelebration()
      // React 的重渲染会走到指针监听 effect 的 cleanup；这里再兜一次，
      // 避免在没有渲染器的环境下把监听留在 document 上。
      if (typeof pointerWatchCleanup === 'function') {
        pointerWatchCleanup()
        pointerWatchCleanup = null
      }
    }

    /**
     * 用「鼠标相对弹窗真实矩形」的位置来定 hovering，而不是靠子元素上的
     * mouseenter/mouseleave —— 这是「悬停时弹窗明明被指着却自己消失」的修复点。
     *
     * 为什么不能靠事件：
     *   挂在事件上的元素一旦是 pointer-events:none，鼠标压在人像/光芒那一片时
     *   浏览器不做命中测试，事件根本不来；而鼠标在「说明条 ↔ 人像」之间挪动时
     *   enter/leave 会交替触发，hovering 跟着抖，倒计时时而暂停时而继续。
     *
     * 另外弹窗可能就弹在鼠标正下方（鼠标没动 → 不会补发 mouseenter），
     * 所以每次用当前指针坐标算一遍，天然覆盖这种情形。
     *
     * @param active - 当前弹窗状态对象。
     * @param pointer - 可选，鼠标视口坐标；不传则跳过。
     */
    function syncHoverFromPointer(active, pointer) {
      const box = active?.boxNode
      if (box === null || box === undefined || pointer === undefined || pointer === null) return
      const rect = typeof box.getBoundingClientRect === 'function' ? box.getBoundingClientRect() : null
      if (rect === null || (rect.width === 0 && rect.height === 0)) return
      const inside = pointer.x >= rect.left && pointer.x <= rect.right
        && pointer.y >= rect.top && pointer.y <= rect.bottom
      active.hovering = inside
    }

    /**
     * 弹一次换挡提示。
     * @param phase - 'peak' | 'valley'
     * @param boundaryAt - 刚跨过的边界时刻（毫秒）
     * @param options - `preview: true` 表示手动预览（说明条会写明"手动预览"）
     */
    function fireCelebration(phase, boundaryAt, options = {}) {
      prefetchAssets()
      ensurePopupStyles()
      // 复位：每次弹出都要重新量尺寸、重播入场动画
      const previousBox = typeof document !== 'undefined' ? document.querySelector('.lwt-pop') : null
      if (previousBox !== null && previousBox !== undefined) {
        previousBox.style.visibility = 'hidden'
        previousBox.classList?.remove?.('lwt-show')
      }
      celebration = {
        phase,
        preview: options.preview === true,
        boundaryAt: boundaryAt ?? Date.now(),
        endsAt: null,
        barNode: null,
        boxNode: null,
        lastPointer: null,
        hideAt: CELEBRATION.seconds * 1000, // 到点自动关（悬停暂停）
        hovering: false,
        raf: 0,
        lastTick: 0,
        dir: 'down',
        left: 0,
        top: 0,
        placed: false,
      }
      notifyCelebration()
      // 每次都重新起一次倒计时（连按/连续触发时不会叠加多个循环）
      if (celebrationRaf !== 0) { cancelFrame(celebrationRaf); celebrationRaf = 0 }
      if (CELEBRATION.seconds > 0) celebrationRaf = scheduleFrame(tickCelebration)
    }

    // ── 组件 ──────────────────────────────────────────────────────────────

    /** 会话标题右侧的胶囊：● 梁文峰 距谷 02:13:45 · 今日 ¥3.42。 */
    function TidePill(props) {
      const state = useTide()
      const badge = usageBadge()
      // 记下胶囊的 DOM 节点：弹窗要按它在界面里的实际位置决定方向/对齐。
      // 注意：ref 是**提交后**才挂上的，渲染期间读它永远是 null —— 必须在 effect 里取。
      const anchorRef = React.useRef === undefined ? null : React.useRef(null)
      const anchorSlot = props !== null && props !== undefined && props.anchorSlot === 'sidebar' ? 'sidebar' : 'header'
      useEffect(() => {
        const node = anchorRef === null ? null : anchorRef.current
        if (node === null) return
        if (anchorSlot === 'sidebar') sidebarAnchor = node
        else headerAnchor = node
      }, [])
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
          ...(anchorRef === null ? {} : { ref: anchorRef }),
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
      const anchorRef = React.useRef === undefined ? null : React.useRef(null)
      if (anchorRef !== null && anchorRef.current !== null) sidebarAnchor = anchorRef.current
      const refProp = anchorRef === null ? {} : { ref: anchorRef }
      useEffect(() => {
        const node = anchorRef === null ? null : anchorRef.current
        if (node !== null) sidebarAnchor = node
      }, [])
      if (props !== undefined && props !== null && props.wide === false) {
        return h(
          'div',
          {
            ...refProp,
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
      return h(TidePill, { anchorSlot: 'sidebar' })
    }

    /**
     * 弹窗活着的时候，在 document 上跟一下指针：无论鼠标落在弹窗的哪一层、
     * 还是挪到了弹窗外，都用同一个判据更新 hovering。
     * 用捕获阶段，避免任何一层 stopPropagation 把事件吃掉。
     * @param event - pointermove 事件。
     */
    function trackPointer(event) {
      const active = celebration
      if (active === null) return
      active.lastPointer = { x: event.clientX, y: event.clientY }
      syncHoverFromPointer(active, active.lastPointer)
    }

    /** 根级悬浮层里的换挡弹窗（渲染在 shell.overlay，不会被标题栏裁切）。 */
    function TideCelebration() {
      const [active, setActive] = useState(celebration)
      const boxRef = React.useRef === undefined ? null : React.useRef(null)

      useEffect(() => {
        celebrationListeners.add(setActive)
        return () => { celebrationListeners.delete(setActive) }
      }, [])

      // 指针跟随：只在弹窗存在时挂着，收起就摘掉。
      useEffect(() => {
        if (active === null) return
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
        window.addEventListener('pointermove', trackPointer, true)
        pointerWatchCleanup = () => window.removeEventListener?.('pointermove', trackPointer, true)
        return () => {
          pointerWatchCleanup = null
          window.removeEventListener?.('pointermove', trackPointer, true)
        }
      }, [active])

      useEffect(() => {
        if (active === null) return
        active.boxNode = boxRef.current ?? null
        prefetchAssets()
        // 量出弹窗与锚点，再决定往哪个方向弹
        const anchor = anchorNode()
        if (anchor === null || typeof anchor.getBoundingClientRect !== 'function') return
        const viewport = {
          width: window.innerWidth ?? document.documentElement?.clientWidth ?? 1280,
          height: window.innerHeight ?? document.documentElement?.clientHeight ?? 800,
        }
        const box = boxRef.current
        if (box === null || box === undefined) return
        // 悬浮层原点：layout 给 overlayLayer 打了 data-shell-overlay
        const layer = box.closest?.('[data-shell-overlay]') ?? box.parentElement
        const placement = applyPlacement(box, anchor.getBoundingClientRect(), layer?.getBoundingClientRect?.() ?? null, viewport)
        if (placement !== null) {
          active.dir = placement.dir
          active.placed = true
        }
        active.barNode = box.querySelector?.('.lwt-bar > i') ?? null
        // 弹窗可能正好弹在鼠标下面（指针没动 → 不会有 mouseenter）：
        // 拿最近一次已知的指针位置立刻判一次。
        if (active.lastPointer !== null && active.lastPointer !== undefined) {
          syncHoverFromPointer(active, active.lastPointer)
        }
      }, [active])

      if (active === null) return null
      // 注意：这里要"具体色值"，不能用 var(...)，否则 rgba() 拆不出来
      const color = themeColor(active.phase === 'peak')
      const image = assetCache.get(active.phase)
      return h(
        'div',
        {
          ref: boxRef,
          className: 'lwt-pop',
          style: {
            '--lwt-h': `${CELEBRATION.height}px`,
            '--lwt-glow': CELEBRATION.glow,
            '--lwt-strong': rgba(color, 0.95),
            '--lwt-soft': rgba(color, 0.4),
            left: `${active.left}px`,
            top: `${active.top}px`,
            visibility: 'hidden', // 由 applyPlacement 在量完尺寸后打开（顺带播入场动画）
          },
          onMouseEnter: (event) => { syncHoverFromPointer(active, { x: event.clientX, y: event.clientY }) },
          onMouseLeave: (event) => { syncHoverFromPointer(active, { x: event.clientX, y: event.clientY }) },
          onMouseMove: (event) => { syncHoverFromPointer(active, { x: event.clientX, y: event.clientY }) },
          onClick: () => hideCelebration(),
        },
        h('div', { className: 'lwt-burst' },
          h('div', { className: 'lwt-halo' }),
          h('div', { className: 'lwt-rays2' }),
          h('div', { className: 'lwt-rays' }),
          h('div', { className: 'lwt-ring' })),
        image === undefined ? null : h('img', { className: 'lwt-figure', src: image.src, alt: '', draggable: false }),
        h('button', { className: 'lwt-close', type: 'button', title: '关闭', onClick: (event) => { event.stopPropagation(); hideCelebration() } }, '✕'),
        h('div', { className: 'lwt-cap' },
          h('div', { className: 'lwt-cap-head' },
            h('span', { style: dotStyle(active.phase === 'peak') }),
            h('b', null, nameOf(active.phase)),
            h('span', { className: 'lwt-cap-tag' }, tierLabelOf(active.phase))),
          h('div', { className: 'lwt-cap-sub' },
            `${active.preview ? '手动预览' : `北京时间 ${beijingClock(active.boundaryAt)} 起`} · ${tierLabelOf(active.phase)}${active.phase === 'valley' ? '半价' : '全价'}`),
          h('div', { className: 'lwt-bar' }, h('i', { style: { background: color } }))),
      )
    }

    /**
     * 手动预览：等真换挡可能要几小时，所以给一个当场演示的入口。
     * 控制台：`__liangwenTide.preview('peak')` / `preview('valley')` / `preview()`（取相反档）
     * 快捷键：Ctrl/Cmd + Shift + T —— 在峰/谷之间交替弹一次，方便连着看两遍。
     * 只影响这一张提示，不动真实档位与倒计时。
     */
    function previewCelebration(requested) {
      // 交替的基准是"上一次预览过的档位"，不是"真实档位" ——
      // 真实档位不会因为你按了键而变，拿它当基准会导致每次按都弹同一张。
      const base = lastPreviewPhase ?? snapshot?.phase ?? phaseAt(Date.now())
      const phase = requested === 'peak' || requested === 'valley'
        ? requested
        : (base === 'peak' ? 'valley' : 'peak')
      lastPreviewPhase = phase
      fireCelebration(phase, Date.now(), { preview: true })
      return phase
    }

    /** 装上预览入口（幂等）。 */
    function installPreviewHook() {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
      if (window.__liangwenTide === undefined) {
        window.__liangwenTide = {
          preview: previewCelebration,
          hide: hideCelebration,
          state: () => ({
            phase: snapshot?.phase ?? null,
            flipAt: snapshot?.flipAt ?? null,
            celebrating: celebration !== null,
            policy: policy.source,
            // 诊断用：锚点有没有量到、弹窗有没有定好位
            anchors: { header: headerAnchor !== null, sidebar: sidebarAnchor !== null },
            placed: celebration?.placed ?? false,
            dir: celebration?.dir ?? null,
          }),
        }
      }
      if (previewHookInstalled) return
      previewHookInstalled = true
      window.addEventListener('keydown', (event) => {
        if (event.repeat === true) return         // 长按不连发（连发会反复重建弹窗）
        if (isEditableTarget(event.target)) return // 正在输入框里打字时别抢
        const key = String(event.key).toLowerCase()
        const matched = PREVIEW_SHORTCUTS.some((b) => b.key === key
          && event.shiftKey === b.shift
          && event.altKey === b.alt
          && event.ctrlKey === b.ctrl
          && event.metaKey === b.meta)
        if (!matched) return
        event.preventDefault()
        previewCelebration()
      })
    }

    let previewHookInstalled = false
    /** 上一次预览过的档位：快捷键连按要靠它交替，否则永远弹同一张。 */
    let lastPreviewPhase = null

    /**
     * 预览快捷键。**刻意避开浏览器已占用的组合**：
     *   · Ctrl/Cmd+Shift+T —— 浏览器「重新打开刚关闭的标签页」，而且浏览器先吃到事件、
     *     页面 preventDefault 也拦不住，按一下既弹窗又重开标签页（Windows/Chrome 的实际冲突）；
     *   · Ctrl+Shift+P —— VS Code / 部分编辑器的命令面板；
     *   · Ctrl+Shift+I / J / C —— DevTools；Ctrl+Shift+N —— 无痕窗口；
     *   · Ctrl+Alt+T —— Windows 终端、多数 Linux 桌面。
     * 所以主组合改成 Ctrl+Shift+Alt+T（Mac 上额外认 Cmd+Shift+Alt+T），
     * 这一族没有任何浏览器或系统默认绑定。
     * 每一项都是精确匹配：shift/alt/ctrl/meta 必须与声明完全一致，
     * 因此旧的「Ctrl+Shift+T」不会再被匹配到（正是要的效果，把它还给浏览器）。
     */
    const PREVIEW_SHORTCUTS = [
      { key: 't', ctrl: true, shift: true, alt: true, meta: false }, // Windows / Linux
      { key: 't', ctrl: false, shift: true, alt: true, meta: true }, // macOS：⌘⇧⌥T
    ]

    /** 焦点在输入框/可编辑区域时不抢快捷键。 */
    function isEditableTarget(target) {
      if (target === null || target === undefined || typeof target !== 'object') return false
      if (target.isContentEditable === true) return true
      const tag = String(target.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      const role = target.getAttribute?.('role')
      return role === 'textbox' || role === 'searchbox'
    }

    /** 悬停提示里展示的快捷键文案（跟随平台）。 */
    function previewShortcutLabel() {
      const mac = typeof navigator !== 'undefined' && /mac/i.test(String(navigator.platform ?? navigator.userAgent ?? ''))
      return mac ? '⌘+Shift+Option+T' : 'Ctrl+Shift+Alt+T'
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
      // 换挡弹窗挂在根级悬浮层：会话标题栏有 overflow 裁切，弹窗必须挂在它的祖先之外，
      // 再用 getBoundingClientRect() 贴住胶囊（方向由 placePopup 按实际位置算）。
      if (CELEBRATION.enabled !== false) {
        slots.inject('shell.overlay', () =>
          slots.register(
            {
              name: 'shell.overlay',
              id: 'liangwen-tide-celebration',
              order: 20,
            },
            TideCelebration,
          ),
        )
        prefetchAssets()
      }
      ensurePopupStyles()
      installPreviewHook()
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
      // 换挡弹窗
      CELEBRATION,
      ASSET_ROUTE,
      placePopup,
      applyPlacement,
      rgba,
      themeColor,
      shouldCelebrate,
      fireCelebration,
      hideCelebration,
      previewCelebration,
      tickCelebration,
      poll,
      publish,
      syncHoverFromPointer,
      PREVIEW_SHORTCUTS,
      isEditableTarget,
      previewShortcutLabel,
      formatRemainingRounded,
      currentCelebration: () => celebration,
      POPUP_CSS,
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
