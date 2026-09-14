// ============================================================
// install-scene-editor.mjs
// 场景编辑器安装器（安全版 + 预检）
//
// 安装前先做「能不能用」的预检，明确告诉对方：
//   - 项目根：找到 / 没找到（没找到直接中止，不改任何东西）
//   - 构建工具：检测到 Vite/webpack/...  /  没检测到（警告）
//   - 入口文件：来自 index.html 的 <script type=module> / 扫描找到 / 没找到
//   - WebGLRenderer：源码里有 / 没有
//   - 全局 three：是否用 <script src=three.min.js> 的老式写法
// 判定「可能不适用」时直接中止，绝不修改项目。
//
// 用法：
//   - 双击「安装场景编辑器.cmd」(Windows) / install-scene-editor.command (macOS)
//   - 或：node install-scene-editor.mjs [可选：项目目录]
// ============================================================

import {
  readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, statSync,
} from 'node:fs'
import { join, dirname, resolve, relative, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KIT_DIR = __dirname
function inKit(p) {
  return p === KIT_DIR || p.startsWith(KIT_DIR + '\\') || p.startsWith(KIT_DIR + '/')
}
const SRC_FILES = ['scene-editor.js', 'scene-editor-autoload.js']
const IMPORT_PATH = './scene-editor-autoload.js'
const IMPORT_LINE = `import '${IMPORT_PATH}'`
const MARKER = '场景编辑器（按 Tab 进入编辑模式）'
const MANIFEST = '.scene-editor-install.json'

const color = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}
const log = (...a) => console.log(...a)
function readSafe(file) {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}
function readPkg(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return null }
}
function looksLikeProject(pkg) {
  if (!pkg) return false
  const d = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  return !!(d.three || d.vite || pkg.scripts?.dev)
}

function findProjectRoot(start) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (readPkg(dir)) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  dir = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'index.html')) || existsSync(join(dir, 'vite.config.js'))
      || existsSync(join(dir, 'vite.config.ts')) || existsSync(join(dir, MANIFEST))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  const found = []
  const stack = [start]
  let guard = 0
  while (stack.length && guard++ < 20000) {
    const d = stack.pop()
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      const pkg = readPkg(p)
      if (pkg) found.push({ dir: p, pkg })
      stack.push(p)
    }
  }
  const best = found.find((f) => looksLikeProject(f.pkg)) || found[0]
  return best ? best.dir : null
}

function collectHtml(root) {
  const out = []
  const stack = [root]
  let guard = 0
  while (stack.length && guard++ < 5000) {
    const d = stack.pop()
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (inKit(p)) continue
      if (e.isDirectory()) stack.push(p)
      else if (/\.html?$/i.test(e.name)) out.push(p)
    }
  }
  return out
}

function walk(root, acc = [], guard = { n: 0 }) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (guard.n++ > 50000) return acc
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(root, e.name)
    if (inKit(p)) continue
    if (e.isDirectory()) walk(p, acc, guard)
    else if (/\.(m?[jt]sx?|vue)$/i.test(e.name)) acc.push(p)
  }
  return acc
}

function findEntryFromHtml(htmls, root) {
  for (const h of htmls) {
    const text = readSafe(h)
    const m = text.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i)
      || text.match(/<script[^>]*src=["']([^"']+)["'][^>]*type=["']module["']/i)
    if (!m) continue
    const file = join(root, m[1].replace(/^\//, ''))
    if (existsSync(file)) return { entry: file, html: h }
  }
  return null
}

// 无打包器时，用 importmap 让浏览器能解析 `three`（与宿主共用同一份 three 实例）
const IMPORTMAP_MARK = 'data-scene-editor-importmap'
function threeCdnVersion(pkg) {
  const d = { ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) }
  const v = (d.three || '').replace(/^[^\d]*/, '')
  return /^\d/.test(v) ? v : '0.170.0'
}
function injectImportMap(htmlPath, pkg) {
  const text = readSafe(htmlPath)
  if (/<script[^>]*type=["']importmap["']/i.test(text)) return { text, added: false, reason: 'html 已有 importmap' }
  const ver = threeCdnVersion(pkg)
  const map = {
    imports: {
      three: `https://unpkg.com/three@${ver}/build/three.module.js`,
      'three/addons/': `https://unpkg.com/three@${ver}/examples/jsm/`,
      'three/examples/jsm/': `https://unpkg.com/three@${ver}/examples/jsm/`,
    },
  }
  const block = `<!-- ${MARKER}：自动注入 importmap -->\n`
    + `<script type="importmap" ${IMPORTMAP_MARK}>${JSON.stringify(map)}</script>\n`
  const m = text.match(/<script[^>]*type=["']module["']/i)
  if (m && typeof m.index === 'number') {
    return { text: text.slice(0, m.index) + block + text.slice(m.index), added: true, version: ver }
  }
  const head = text.match(/<\/head>/i)
  if (head) return { text: text.replace(/<\/head>/i, block + '</head>'), added: true, version: ver }
  return { text: block + text, added: true, version: ver }
}

function scoreEntry(file) {
  const text = readSafe(file)
  let score = 0
  if (/new\s+THREE\.WebGLRenderer|new\s+WebGLRenderer/.test(text)) score += 10
  if (/setAnimationLoop|requestAnimationFrame/.test(text)) score += 2
  const b = basename(file).toLowerCase()
  if (/^main\./.test(b)) score += 4
  if (/^index\./.test(b)) score += 3
  if (/install-scene-editor|uninstall-scene-editor/.test(b)) score = -1
  if (!/[\\/](engine|entities|systems|ui|effects|games|weapons|config)[\\/]/.test(file)) score += 2
  return score
}

const BUNDLER_DEPS = /(^|\/)(vite|webpack|rollup|parcel|esbuild|snowpack|next|nuxt|astro|@angular\/cli|@sveltejs\/kit|react-scripts|vue-cli-service|rspack|@rspack|@webpack|@rollup)/i
const BUNDLER_SCRIPTS = /(vite|webpack|rollup|parcel|esbuild|next|nuxt|astro|react-scripts|snowpack|rspack|ng\s)/i
const BUNDLER_CONFIGS = [
  'vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.cjs',
  'webpack.config.js', 'webpack.config.ts', 'rollup.config.js', 'rollup.config.mjs',
  '.parcelrc', 'next.config.js', 'next.config.mjs', 'nuxt.config.ts',
  'astro.config.mjs', 'angular.json', 'vue.config.js', 'svelte.config.js', 'rspack.config.js',
]
function detectBundler(root, pkg) {
  const deps = { ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) }
  const hit = Object.keys(deps).find((n) => BUNDLER_DEPS.test(n))
  if (hit) return { found: true, name: hit }
  const scripts = Object.values((pkg && pkg.scripts) || {}).join(' ')
  if (BUNDLER_SCRIPTS.test(scripts)) return { found: true, name: 'package.json scripts' }
  const cfg = BUNDLER_CONFIGS.find((f) => existsSync(join(root, f)))
  if (cfg) return { found: true, name: cfg }
  return { found: false, name: null }
}

function isOurFile(file, name) {
  const text = readSafe(file)
  if (name === 'scene-editor.js') return text.includes('export class SceneEditor')
  return text.includes('scene-editor-autoload.js') && text.includes('自动挂载')
}
function insertImport(text, file) {
  if (text.includes('scene-editor-autoload.js')) return { text, added: false, reason: '已存在' }
  const isTs = /\.(ts|tsx)$/i.test(file)
  const block = `// ${MARKER} —— 由安装器自动添加\n${isTs ? '// @ts-ignore 该模块为纯 JS，无类型声明\n' : ''}${IMPORT_LINE}\n`
  if (extname(file).toLowerCase() === '.vue') {
    const m = text.match(/<script[^>]*>/)
    if (!m) return { text, added: false, reason: '.vue 未找到 <script>' }
    const idx = m.index + m[0].length
    return { text: `${text.slice(0, idx)}\n${block}${text.slice(idx)}`, added: true }
  }
  if (/^#!.*\r?\n/.test(text)) {
    const nl = text.indexOf('\n') + 1
    return { text: `${text.slice(0, nl)}${block}${text.slice(nl)}`, added: true }
  }
  return { text: `${block}${text}`, added: true }
}

const ok = (s) => color.green(`✓ ${s}`)
const no = (s) => color.red(`✗ ${s}`)
const warn = (s) => color.yellow(`⚠ ${s}`)

function main() {
  const startDir = process.argv[2] ? resolve(process.argv[2]) : __dirname
  log(color.cyan('\n=== 场景编辑器安装器（最终版）===\n'))

  const projectRoot = findProjectRoot(startDir)
  if (!projectRoot) {
    log(no('没找到项目根（附近没有 package.json / index.html / vite.config）。'))
    log('  请把 scene-editor-kit 文件夹放进对方项目里再运行。')
    log(color.cyan('结论：不适用，已中止，未做任何修改。\n'))
    process.exitCode = 1
    return
  }

  const pkg = readPkg(projectRoot)
  const bundler = detectBundler(projectRoot, pkg)
  const htmls = collectHtml(projectRoot)
  const globalThree = htmls.some((h) => /<script[^>]*src=["'][^"']*three(\.min)?\.js/i.test(readSafe(h)))
  const fromHtmlInfo = findEntryFromHtml(htmls, projectRoot)
  const fromHtml = fromHtmlInfo ? fromHtmlInfo.entry : null
  const files = walk(projectRoot)
  const hasWebGL = files.some((f) => /new\s+(THREE\.)?WebGLRenderer/.test(readSafe(f)))

  let entry = fromHtml
  if (!entry) {
    let bestScore = 0
    for (const f of files) { const s = scoreEntry(f); if (s > bestScore) { bestScore = s; entry = f } }
  }

  // ---- 预检报告 ----
  log(color.bold('[预检]'))
  log(`  项目根：${ok(projectRoot)}`)
  log(`  构建工具：${bundler.found ? ok('检测到 ' + bundler.name) : warn('未在 package.json / 配置文件中检测到 Vite/webpack 等')}`)
  log(`  入口文件：${entry ? ok(relative(projectRoot, entry) + (fromHtml ? '（来自 html 的 type=module）' : '（扫描 WebGLRenderer 得到）')) : no('没找到')}`)
  log(`  WebGLRenderer：${hasWebGL ? ok('源码中已使用') : warn('未在任何源码里找到 new THREE.WebGLRenderer')}`)
  if (globalThree) log(`  ${warn('检测到用 <script src="...three.min.js"> 的全局写法（通常没走打包器）')}`)

  if (!entry) {
    log(color.red('\n结论：不适用（找不到入口文件）。'))
    log('  原因：既没有带 <script type="module"> 的 html，也没有源码使用 WebGLRenderer。')
    log(color.cyan('已中止，未对项目做任何修改。\n'))
    process.exitCode = 1
    return
  }

  const usable = bundler.found || (fromHtml && hasWebGL)
  if (!usable) {
    log(color.red('\n结论：可能不适用。'))
    if (!bundler.found) log('  原因1：没有检测到构建工具（Vite/webpack 等）。')
    if (!fromHtml) log('  原因2：入口不是来自 html 的 <script type="module">。')
    if (!hasWebGL) log('  原因3：源码里没有 new THREE.WebGLRenderer。')
    if (globalThree) log('  原因4：看起来用的是全局 <script src=three.min.js> 写法。')
    log('  这类项目（纯 script 标签 / 非 three 引擎）装上也无法工作。')
    log(color.cyan('已中止，未对项目做任何修改。\n'))
    process.exitCode = 1
    return
  }
  if (!bundler.found && fromHtml && hasWebGL) {
    log(warn('  未检测到构建工具，但入口是 ES module 且使用了 WebGLRenderer，通常可用，继续安装。'))
  }
  log(ok('  评估：可以使用，开始安装…\n'))

  // ---- 安装 ----
  const destDir = dirname(entry)
  for (const f of SRC_FILES) {
    const from = join(__dirname, f)
    if (!existsSync(from)) { log(no(`缺少文件：${f}`)); process.exitCode = 1; return }
    const to = join(destDir, f)
    if (existsSync(to) && !isOurFile(to, f)) {
      log(warn(`已存在同名且非本工具的文件，跳过不覆盖：${relative(projectRoot, to)}`))
      continue
    }
    copyFileSync(from, to)
    log(ok(`已复制：${relative(projectRoot, to)}`))
  }

  const original = readFileSync(entry, 'utf8')
  const { text: nextText, added, reason } = insertImport(original, entry)
  let backup = null
  if (added) {
    const backupPath = `${entry}.scene-editor-bak`
    if (!existsSync(backupPath)) { copyFileSync(entry, backupPath); backup = relative(projectRoot, backupPath) }
    writeFileSync(entry, nextText, 'utf8')
    log(ok(`已在入口加入：${IMPORT_LINE}`))
    if (backup) log(ok(`已备份入口：${backup}`))
  } else {
    log(warn(`未修改入口（${reason}）`))
  }

  // 无打包器：给 html 注入 importmap，让 `three` 能被解析（与宿主共用同一份）
  let importmap = null
  if (!bundler.found && fromHtmlInfo?.html) {
    const r = injectImportMap(fromHtmlInfo.html, pkg)
    if (r.added) {
      writeFileSync(fromHtmlInfo.html, r.text, 'utf8')
      importmap = { html: relative(projectRoot, fromHtmlInfo.html), three: r.version }
      log(ok(`已注入 importmap（three@${r.version}）到 ${relative(projectRoot, fromHtmlInfo.html)}`))
    } else {
      log(warn(`未注入 importmap（${r.reason}）`))
    }
  }

  const manifest = {
    tool: 'scene-editor',
    version: 1,
    installedAt: new Date().toISOString(),
    projectRoot,
    bundler: bundler.name,
    entry: relative(projectRoot, entry),
    importLine: IMPORT_LINE,
    marker: MARKER,
    copied: SRC_FILES.map((f) => relative(projectRoot, join(destDir, f))).filter((p) => existsSync(join(projectRoot, p))),
    backup,
    importmap,
  }
  writeFileSync(join(projectRoot, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')
  log(ok(`已写入安装记录：${MANIFEST}`))

  log(color.cyan('\n完成！接下来：'))
  log(`  1. cd "${projectRoot}"`)
  log('  2. npm run dev')
  log('  3. 打开页面，按 Tab 进入编辑模式')
  log(color.cyan('如需还原：双击「卸载场景编辑器.cmd」\n'))
}

main()
