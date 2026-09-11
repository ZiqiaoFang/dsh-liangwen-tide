/**
 * 从官方定价页真实抓下来的片段（2026-09-11），供各测试共用：
 *   · 峰谷规则句（中/英）
 *   · 价目表表格（中/英）
 * 测试断言「解析结果必须与内置兜底一致」，所以官方一改口径，这里会先失败。
 */

/** 官方英文页的峰谷规则句（连同上下文）。 */
export const EN_RULE_HTML = '<p>(3) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak).</p><p>(4) For more details on concurrency limits, please refer to <a href="/quick_start/rate_limit">Rate Limit &amp; Isolation</a>.</p>'

/** 官方中文页的峰谷规则句（连同上下文）。 */
export const ZH_RULE_HTML = '<p>(3) 空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。</p><p>(4) 更多并发限制细节，请参考<a href="/zh-cn/quick_start/rate_limit">限速与隔离</a>。</p>'

/** 官方中文页价目表片段（人民币/百万 tokens）。 */
export const ZH_PRICE_TABLE =
  '<table><tr><td colspan="3" style="text-align:center">模型</td><td>deepseek-flash<sup>(1)</sup></td><td'
  + '>deepseek-v4-pro<sup>(2)</sup></td></tr><tr><td rowspan="6">价格<sup>(3)</sup></td><td rowspan="2">百万t'
  + 'okens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr><tr><td>高峰时段</td><td>0.04元</td><'
  + 'td>0.30元</td></tr><tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td'
  + '></tr><tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr><tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td>'
  + '<td>4元</td><td>13.5元</td></tr><tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr></table>'

/** 官方英文页价目表片段（美元/百万 tokens）。 */
export const EN_PRICE_TABLE =
  '<table><tr><td colspan="3" style="text-align:center">MODEL</td><td>deepseek-flash<sup>(1)</sup></td>'
  + '<td>deepseek-v4-pro<sup>(2)</sup></td></tr><tr><td colspan="3" style="text-align:center">MODEL VERSI'
  + 'ON</td><td>DeepSeek-V4.1-Flash</td><td>DeepSeek-V4-Pro-0813</td></tr><tr><td rowspan="6">PRICING<sup'
  + '>(3)</sup></td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><t'
  + 'd>$0.022</td></tr><tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr><tr><td rowspan="2">1M INPUT T'
  + 'OKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr><tr><td>PEAK</td><td>$0.'
  + '3</td><td>$1.32</td></tr><tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>'
  + '$1.98</td></tr><tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr></table>'

/** 一整页的近似形态：规则句 + 价目表（stub 文档站与离线自检共用）。 */
export const EN_PAGE = EN_RULE_HTML + EN_PRICE_TABLE
export const ZH_PAGE = ZH_RULE_HTML + ZH_PRICE_TABLE

/** 价目表片段（与上面的页共用同一份字符串，测试里用更短的名字）。 */
export const EN_TABLE = EN_PRICE_TABLE
export const ZH_TABLE = ZH_PRICE_TABLE
