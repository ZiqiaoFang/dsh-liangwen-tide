# dsh-liangwen-tide

> DeepSeek Harness 的 **峰谷指示器 + 当日用量**：峰时显示「**梁文峰**」，谷时显示「**梁文谷**」，
> 胶囊上还带一行**今日已用金额**。峰谷规则与价目表**自动跟随官方定价页更新**，不写死在代码里。

DeepSeek API 是峰谷分时计价，这个插件把当前档位做成一颗常驻小胶囊：

- **峰时** → 橙红点 + **梁文峰**（距谷 `h:mm:ss`）
- **谷时** → 青绿点 + **梁文谷**（距峰 `h:mm:ss`）
- 后面跟一行 **今日 ¥x**（当日已用，北京时间自然日，全部会话合计）
- 鼠标悬停出原生提示：北京时间、是否周末全天谷时、当前时段表、距下次换挡倒计时、策略来源与同步时间，
  以及当日用量的完整明细（峰/谷分档、命中/未命中/输出 token、分模型金额、美元对照、昨日对照、价格来源）

挂载在两个官方 list 插槽上（样式全部用 `--dsw-*` 主题变量，跟随亮/暗主题）：

| 插槽 | 位置 | 表现 |
| --- | --- | --- |
| `conversation.session.header.utilities` | 会话标题右侧 | 完整胶囊 |
| `sidebar.footer.action` | 侧栏底部（设置旁） | 宽侧栏=完整胶囊；56px 轨道=只有一个状态点 |

两个位置共用一个秒级时钟，所以无论有没有打开会话，都能看到现在是哪一"峰/谷"。

## 当日已用金额

「今日 ¥x」来自宿主半的当日账本，口径写清楚如下：

| 问题 | 口径 |
| --- | --- |
| 算哪些调用 | 会话事件流里**已结算**的 `assistant/message` 与 `assistant/attempt`（含失败/被重试的那次）；正在跑的那次在结算前不计 |
| token 从哪来 | 事件自带的 provider usage；`assistant/message` 优先用自己的 `data.usage`，缺失时取流里最后一个 usage chunk（与宿主 `tokenUsage` 投影同口径） |
| 命中/未命中怎么分 | 宿主是**互斥计数**：`inputTokens` 已经是「未命中」（适配器把 DeepSeek 的 `prompt_tokens` 减掉了命中部分），`cacheReadTokens` 是「命中」，两者不再互相剪 |
| 同一 step 重复报告 | 取最新一份**替换**而不是累加；`llm/retry-started` 之后重试的那次另算一笔（真实计费） |
| 按哪一档计价 | 按**调用发生时刻**的峰/谷档位逐次计价，跨峰谷切换不会漂移；周末全天按谷时 |
| 用哪套价格 | 官方定价页的中文页（人民币）为主口径，英文页（美元）作对照；都在同一次抓取里解析 |
| 哪一天 | 北京时间（UTC+8）自然日，按**事件时间**归档；重启后按事件时间重新归账 |
| 历史怎么补 | 启动时经 `ctx.sessionQuery` 列会话 + 读日志补一次（活着的会话直接读内存日志，零 IO）；补不到就只统计本次运行内发生的调用，并在提示里说明 |
| 会话日志 | 会话日志是 zstd 多帧容器，**不自己解析**，一律走宿主的 `sessionQuery.readSession` |

隐私：只读 token 计数与模型名，全部留在进程内存里——**不落盘、不外发**，也不写任何自定义存储。

与宿主自身口径的一致性：本插件的折叠逻辑对齐 `@deepseek-ai/dsh-token-meter` 的
`tokenUsage` 投影；实测拿真实会话日志跑，命中/未命中/输出三项与该投影缓存的差异 < 0.3%
（差异来自两次快照之间仍在追加的调用）。

悬停里还会写清当前金额是**按哪套价格**算的、以及有没有「没匹配到价格的模型」（这类调用只记
token、不计金额，并如实标注）。

## 自动更新峰谷策略与价目表

官方把规则写在定价页正文里（2026-09 的两语版本）：

> EN: `Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak).`
> ZH: `高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。`

插件按这条链路自动跟上：

```
宿主半（lib/index.js）
  ├─ 启动即抓 + 之后每 6 小时抓官方定价页中英文两版
  ├─ lib/policy.js 解析：按优先级试多种句式 → 识别时区/周末规则 → 归一化到 UTC 分钟
  ├─ 同一份页面里再解析价目表：人民币（中文页）主口径 + 美元（英文页）对照
  ├─ 交叉校验：两页一致=高置信；只有一页=中置信；两页打架=取英文页并标 conflict
  ├─ 任何一步失败（离线/超时/改版/解析不出）→ 保留上一次结果或内置兜底，只记错误
  ├─ 会话事件订阅 + 启动补历史 → 当日账本（lib/usage.js）
  └─ 两条只读路由（都过 composition 的信任围栏）：
       GET /liangwen-tide/policy   峰谷策略 + 价目表来源
       GET /liangwen-tide/usage    当日用量与金额
浏览器半（lib/client.js）
  ├─ 页面加载即取策略，之后每 30 分钟一次（宿主侧另有 10 分钟节流，不会反复打官方页）
  ├─ 页面加载即取用量，之后每 20 秒一次（宿主侧只读内存账本，不打网络）
  ├─ 官方策略落到 localStorage：宿主机离线/重启也不会退回旧口径
  └─ 全程取不到 → 峰谷用内置兜底（与 lib/policy.js 的 BUILTIN_POLICY 一致），金额不显示
```

安全性上刻意保守：解析只认「HH:MM - HH:MM」区间 + 明确的时区/周末措辞；
归一化后要求 1–6 个窗口、互不重叠、总覆盖 ≤ 16 小时；任何一项不满足就**不采纳**
（宁可继续用旧策略，也不吃进半懂不懂的规则）。悬停提示里能看到当前用的是哪一层、
多久前同步的、以及为什么没同步上。

### 关掉 / 调整

在 profile 自己的 `cordis.patch.yml` 里按行 id 覆写（profile 层在 bundle 层之后应用）：

```yaml
- id: liangwen-tide
  config:
    autoUpdate: false    # 关掉抓取，恒用内置策略/价格
    trackUsage: false    # 关掉当日用量账本与 /usage 路由（不读会话日志）
    refreshHours: 12     # 抓取间隔（默认 6，最小 0.25）
    timeoutMs: 15000     # 单次抓取超时毫秒（默认 10000）
    urls:                # 自定义文档地址
      en: https://api-docs.deepseek.com/quick_start/pricing
      zh: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
```

## 安装

```sh
# 推荐：patch 方式（profile 是 patchReload: live）
node tools/install.mjs

# 或者 bundle 方式（等价于官方 dsh plugin add，写进 profile 依赖+装配层；需重启 dsh）
node tools/install.mjs --bundle

# 看现状 / 卸载
node tools/install.mjs --status
node tools/install.mjs --uninstall
```

脚本做两件事（等价于 `dsh plugin --profile web add link:<本包目录>`，只是不依赖 pnpm）：

1. 在 `~/.dsh/profiles/web/node_modules/` 放一个指向本包的软链（Loader 靠它解析 `dsh-liangwen-tide`）；
2. 把装配行写进 `~/.dsh/profiles/web/cordis.patch.yml`（默认）或 profile 的 `dependencies` + `dsh.profile.bundles`（`--bundle`）。

写文件前会留一份 `*.bak-dsh-liangwen-tide`；两种方式互斥，脚本切换时自动撤销另一种。

> **注意**：装配层（patch）的增删是热生效的，但**插件代码本身不是**——
> 宿主半（抓取 + 路由）在 `dsh web` 进程启动时装载，改完宿主半要重启一次 `dsh web`；
> 只改浏览器半刷新页面即可。重启前浏览器半会走「内置兜底 / 本机缓存」，不会报错。

若机器上装了 pnpm，也可以直接用官方命令（从 GitHub 装）：

```sh
dsh plugin --profile web add github:ZiqiaoFang/dsh-liangwen-tide
```

本地目录：

```sh
dsh plugin --profile web add link:./dsh-liangwen-tide    # 相对路径按「你执行命令的目录」解析
```

## 给别人用

**运行时零依赖**：宿主半只用 Node 内建能力，浏览器半只用平台内置的 `react` 种子模块，
所以「要给别人什么」就是**一个包**——`npm pack` 出来 35KB、10 个文件：

```
dsh-liangwen-tide-1.2.0.tgz
└── package/
    ├── package.json        # dsh.bundle.patch + dsh.client + dshhub 元数据
    ├── cordis.patch.yml    # 装配行
    ├── lib/                # 宿主半、浏览器半、时段解析、价目表、账本
    ├── tools/install.mjs   # 没有 pnpm 时的安装兜底
    ├── README.md
    └── LICENSE
```

里面**不含**：你的会话数据、你的机器路径、任何凭据，也不含测试与开发依赖
（`package.json` 的 `files` 已过滤，`npm pack` 时再确认一次 `tar tzf` 即可）。

### 四条通道

1. **npm 包**：你 `npm publish`（包名 `dsh-liangwen-tide`）→ 对方
   `dsh plugin --profile web add dsh-liangwen-tide`。需要你有 npm 账号，对方有 pnpm + 网络。
2. **Git 仓库**：本包已开源在 <https://github.com/ZiqiaoFang/dsh-liangwen-tide> → 对方
   `dsh plugin --profile web add github:ZiqiaoFang/dsh-liangwen-tide`。
   本包没有 `prepare` 构建脚本，所以不需要 pnpm 的 allowBuilds。
3. **压缩包**：`npm pack` 得到 tgz，直接发给对方（微信/邮件都行）→ 对方
   `dsh plugin --profile web add ./dsh-liangwen-tide-1.2.0.tgz`。
4. **直接拷目录**（最省事，对方不需要 pnpm）：把整个目录给对方 → 对方在该目录里跑
   `node tools/install.mjs`。

通道 1–3 都走官方 `dsh plugin add`（内部是 pnpm + 自动把本包登记进 `dsh.profile.bundles`）；
通道 4 用本包自带的脚本做同样两件事（`node_modules` 软链 + 装配行），已在没有 pnpm 的机器上验证过。

### 对方需要什么

- **DeepSeek Harness，web profile**：这是 Web UI 插件，依赖 `dsh.client` 双半机制与
  `conversation.session.header.utilities` / `sidebar.footer.action` 两个官方插槽。
- **Node ≥ 20**；若走 `dsh plugin add` 则还需要 pnpm。
- **想看「今日金额」**：composition 里要有 `session-query`（官方 web profile 自带）。没有也能用——
  自动降级为「只统计本次运行内发生的调用」，峰谷指示完全不受影响。
- **联网**（可选）：用来抓官方定价页同步峰谷与价格；离线时用内置兜底，照样能用。

### 兼容与降级

实测环境：`@deepseek-ai/dsh 0.1.5-rc.2` 的 web profile。`package.json` 里
`dshhub.compatibility` 声明 `dsh >=0.1.5-rc.1`、`node >=20`。缺失能力一律降级、不报错：

| 缺什么 | 会怎样 |
| --- | --- |
| `connection` 服务 | 两条路由不上浏览器信任围栏（只读的公开数据） |
| `sessionQuery` 服务 | 用量只算实时，提示气泡里写明「会话索引不可用」 |
| 官方页面抓不到 / 改版 | 时段与价格退回上一次成功的或内置兜底，路由仍 200 |
| 插槽不存在 | `slots.inject` 等不到就不挂载，不抛错 |

### 想改个名字再发

包名出现在三处，必须同步改：`package.json` 的 `name`、`lib/client.js` 里
`window.__ModuleLoader__.load({ id })`、`cordis.patch.yml` 里的 `name`（浏览器半 bundle 的 id
必须等于包名，模块图按包名索引）。路由前缀 `lib/index.js` 的 `POLICY_ROUTE`/`USAGE_ROUTE`
与 `lib/client.js` 的两个同名字符串也要一起改。

## 文件结构

```
dsh-liangwen-tide
├── package.json        # dsh.bundle.patch（装配层）+ dsh.client.platform（浏览器半）
├── cordis.patch.yml    # 装配行 + 可用 config 说明
├── lib/
│   ├── index.js        # 宿主半：抓官方文档、解析时段+价格、订阅会话事件、挂两条只读路由
│   ├── policy.js       # 峰谷解析层：句式表 / 时区 / 周末规则 / 校验 / 交叉校验 / 定档
│   ├── pricing.js      # 价目表解析层：中英文表格 → 单价；token 约定与计费
│   ├── usage.js        # 当日账本：事件折叠（水位线/替换/重试）、补历史、出报表
│   └── client.js       # 浏览器半：__ModuleLoader__ bundle（时钟 + 两个插槽 + 策略/用量同步）
├── tools/install.mjs   # 安装/卸载/status
└── test/
    ├── fixtures.mjs      # 从官方页真实抓下来的规则句与价目表片段（各测试共用）
    ├── policy.test.mjs   # 峰谷解析自检（句式变体 + 非法输入）
    ├── pricing.test.mjs  # 价目表与计费自检（真实表格 + 互斥 token 约定 + 坏数据）
    ├── usage.test.mjs    # 账本自检（定档/日归档/替换/重试/补历史/上限/失败）
    ├── tide.test.mjs     # 浏览器半自检（判定/文案/注册/策略与用量采纳与拒绝/缓存）
    ├── host.test.mjs     # 宿主半自检（本地 stub 文档站：正常/故障/关停/节流/用量/降级）
    └── live-check.mjs    # 联网自检：真去抓官方页跑一遍完整解析链路
```

浏览器半只依赖平台内置种子模块 `react`，无第三方依赖；宿主半只用 Node 内建能力。

## 自检

```sh
npm test            # 离线全套（policy + pricing + usage + client + host，共 325 项）
npm run test:live   # 联网跑一次官方页面，顺便校验内置兜底（时段与价格）是否过期
```

## 已知限制

- 策略解析依赖官方页面「某句话的措辞」。官方大改写句式时，`test:live` 会先失败，
  这时按提示补 `lib/policy.js` 的句式表即可（内置兜底期间 UI 照常可用）。
- 宿主侧缓存只在内存：重启 `dsh web` 后要重新抓一次（首次请求可能先看到内置策略，
  一两秒后变成官方策略）；浏览器侧另有 localStorage 缓存顶着这段时间。
- 「设置 → 插件」页只列 profile 依赖，默认的 patch 方式不会出现在那里；想让它出现就用 `--bundle` 并重启 dsh。
- 当日金额是**按官方价目表推算**的账，不是 DeepSeek 账单；官方调价、未知模型、失败重试等边界下
  可能与实际扣费有差异（提示气泡里会标出「没匹配到价格」的调用）。
- 账本只在内存：重启 dsh 后靠补历史重建。补历史覆盖「活着的会话 + 近 36 小时内创建的会话」，
  更早创建、今天又被继续使用的会话可能漏算（提示气泡会写补历史的状态）。

---

仓库：<https://github.com/ZiqiaoFang/dsh-liangwen-tide> · MIT © 2026 ZF

