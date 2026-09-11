/**
 * dsh-liangwen-tide 安装器 / 卸载器。
 *
 * 两种登记方式，任选其一（脚本保证不会同时上两处，避免同一 id 被插入两次）：
 *
 *  · patch（默认）：把一行 insert 追加进 profile 自己的 cordis.patch.yml。
 *      profile 是 patchReload: live，所以运行中的 dsh web 会热重载这层补丁，
 *      浏览器刷新一次即可看到效果，不必重启 dsh。
 *      缺点：这一行记在「用户补丁层」里，不进入 profile 依赖清单，
 *      「设置 → 插件」页不会把它列为已安装依赖。
 *
 *  · bundle（--bundle）：等价于官方 `dsh plugin --profile web add link:<本包>`：
 *      在 node_modules 放软链，并把包名写进 profile package.json 的
 *      dependencies 与 dsh.profile.bundles（于是本包的 cordis.patch.yml
 *      成为一层装配层）。这是最「正规」的装法，但 bundle 列表在启动时结算，
 *      需要重启 dsh 才生效。
 *
 * 两种方式都先建 node_modules 软链——Loader 得靠它把 `dsh-liangwen-tide`
 * 解析到本包目录。
 *
 * 用法：
 *   node tools/install.mjs                    # patch 方式装进 web profile
 *   node tools/install.mjs --bundle           # bundle 方式装进 web profile
 *   node tools/install.mjs tui --bundle       # 指定 profile
 *   node tools/install.mjs --status           # 看现状
 *   node tools/install.mjs --uninstall        # 两种登记都撤掉
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const packageName = pluginManifest.name
if (typeof packageName !== 'string' || packageName === '') throw new Error('本包 package.json 缺少 name')

/** 宿主行 id：cordis.patch.yml 里的 loader 行。 */
const ROW_ID = 'liangwen-tide'
/** 补丁层托管块的首尾标记（卸载时按标记精确摘除）。 */
const BLOCK_BEGIN = `# ── ${packageName} (managed block; 由 tools/install.mjs 维护) ──`
const BLOCK_END = `# ── /${packageName} ──`
const BLOCK = `${BLOCK_BEGIN}\n- insert:\n    - id: ${ROW_ID}\n      name: ${packageName}\n${BLOCK_END}\n`

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((value) => value.startsWith('--')))
const rest = argv.filter((value) => !value.startsWith('--'))
const profile = rest[0] ?? 'web'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profile)
const profileManifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const link = join(profileDir, 'node_modules', packageName)

if (!existsSync(profileManifestPath)) {
  console.error(`找不到 profile ${JSON.stringify(profile)} 的清单：${profileManifestPath}`)
  console.error(`先跑一次 dsh --profile ${profile} 让 dsh 把 profile 建出来。`)
  process.exit(1)
}

const readProfileManifest = () => JSON.parse(readFileSync(profileManifestPath, 'utf8'))
const writeProfileManifest = (manifest) => writeFileSync(profileManifestPath, `${JSON.stringify(manifest, void 0, 2)}\n`)
/** 读补丁层；profile 里还没这个文件时给一份带表头的空列表。 */
const readPatchFile = () =>
  existsSync(patchPath)
    ? readFileSync(patchPath, 'utf8')
    : `# ${profile} profile 的用户补丁层：顶层 YAML 数组的 loader 补丁条目。\n[]\n`

/** 软链现状：undefined=不存在，false=同名实体目录，字符串=指向。 */
function linkTarget() {
  try {
    const stat = lstatSync(link)
    return stat.isSymbolicLink() ? readlinkSync(link) : false
  } catch {
    return undefined
  }
}

/** 摘掉托管块。 */
function stripBlock(text) {
  const start = text.indexOf(BLOCK_BEGIN)
  if (start === -1) return text
  const end = text.indexOf(BLOCK_END, start)
  if (end === -1) return text
  return text.slice(0, start) + text.slice(end + BLOCK_END.length)
}

/** 追加托管块（先把 `[]` 空列表占位去掉，避免解析出两个顶层值）。 */
function withBlock(text) {
  let base = stripBlock(text)
  base = base.replace(/^[ \t]*\[[ \t]*\][ \t]*\r?\n?/m, '')
  if (base !== '' && !base.endsWith('\n')) base += '\n'
  return `${base}${BLOCK}`
}

/** 摘干净后如果一行补丁都不剩，补回 `[]`（补丁文件必须是顶层数组）。 */
function withoutBlock(text) {
  const base = stripBlock(text)
  if (base.split('\n').some((line) => /^\s*-\s/.test(line))) return base
  return base.replace(/\s*$/, '\n\n[]\n')
}

const hasPatchBlock = existsSync(patchPath) && readFileSync(patchPath, 'utf8').includes(BLOCK_BEGIN)
const manifestNow = readProfileManifest()
const hasBundle = (manifestNow.dsh?.profile?.bundles ?? []).includes(packageName)
const target = linkTarget()

if (flags.has('--status')) {
  console.log(`profile      : ${profile} (${profileDir})`)
  console.log(`node_modules : ${target === undefined ? '（无软链）' : target === false ? '（同名实体目录，未接管）' : target}`)
  console.log(`patch 登记    : ${hasPatchBlock ? `已写入 ${patchPath}` : '未登记'}`)
  console.log(`bundle 登记   : ${hasBundle ? '已写入 package.json (dependencies + dsh.profile.bundles)' : '未登记'}`)
  process.exit(0)
}

if (flags.has('--uninstall')) {
  if (typeof target === 'string') rmSync(link, { force: true })
  if (hasPatchBlock) writeFileSync(patchPath, withoutBlock(readPatchFile()))
  const manifest = readProfileManifest()
  if (manifest.dependencies?.[packageName] !== undefined) delete manifest.dependencies[packageName]
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(packageName)) {
    manifest.dsh.profile.bundles = bundles.filter((value) => value !== packageName)
  }
  writeProfileManifest(manifest)
  console.log(`已卸载 ${packageName}（profile ${profile}）；浏览器刷新一次后胶囊消失`)
  process.exit(0)
}

// ── 安装 ────────────────────────────────────────────────────────────────────

/** 动手之前留一份 .bak（同一份只留最近一次，避免堆文件）。 */
function backup(pathToBackup) {
  if (!existsSync(pathToBackup)) return
  writeFileSync(`${pathToBackup}.bak-${packageName}`, readFileSync(pathToBackup))
}

// 1. node_modules 软链（幂等；绝不覆盖同名实体目录）
mkdirSync(dirname(link), { recursive: true })
if (target === false) {
  console.error(`拒绝覆盖实体目录：${link}（请先确认它是什么）`)
  process.exit(1)
}
if (target !== undefined) rmSync(link, { force: true })
symlinkSync(pluginDir, link, 'junction')

if (flags.has('--bundle')) {
  const manifest = readProfileManifest()
  manifest.dependencies = { ...manifest.dependencies, [packageName]: `link:${pluginDir}` }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(packageName)) bundles.push(packageName)
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles },
  }
  backup(profileManifestPath)
  writeProfileManifest(manifest)
  if (hasPatchBlock) writeFileSync(patchPath, withoutBlock(readPatchFile()))
  console.log(`已安装 ${packageName}（bundle 方式）`)
  console.log(`  软链   : ${link} -> ${pluginDir}`)
  console.log(`  依赖   : dependencies.${packageName} = link:${pluginDir}`)
  console.log(`  装配层 : dsh.profile.bundles = [${bundles.join(', ')}]`)
  console.log('  bundle 列表在启动时结算：重启 dsh（或下次启动）后生效。')
} else {
  backup(patchPath)
  writeFileSync(patchPath, withBlock(readPatchFile()))
  if (hasBundle) {
    const manifest = readProfileManifest()
    delete manifest.dependencies?.[packageName]
    const bundles = (manifest.dsh?.profile?.bundles ?? []).filter((value) => value !== packageName)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    writeProfileManifest(manifest)
    console.log('（原先的 bundle 登记已撤销，避免同一行被插入两次）')
  }
  console.log(`已安装 ${packageName}（patch 方式）`)
  console.log(`  软链   : ${link} -> ${pluginDir}`)
  console.log(`  补丁层 : ${patchPath}`)
  console.log(`  装配行 : - insert: [{ id: ${ROW_ID}, name: ${packageName} }]`)
  console.log('  profile 是 patchReload: live：补丁层会热重载，刷新浏览器页面即可看到峰谷胶囊。')
}
