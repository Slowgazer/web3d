// ============================================================
// install-scene-editor.mjs
// 场景编辑器安装器（安全版）
//   - 只新增文件、只在入口加一行 import；不删除、不改 package.json
//   - 不覆盖同名但「不是本工具」的文件
//   - 修改入口前先备份为 <入口>.scene-editor-bak
//   - 写入安装记录 .scene-editor-install.json，供卸载脚本精确还原
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
}
const log = (...a) => console.log(...a)

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
  // 向上找 Web 项目标记
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
function walk(root, acc = [], guard = { n: 0 }) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (guard.n++ > 50000) return acc
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(root, e.name)
    if (e.isDirectory()) walk(p, acc, guard)
    else if (/\.(m?[jt]sx?|vue)$/i.test(e.name)) acc.push(p)
  }
  return acc
}
function findEntryFromHtml(root) {
  const htmls = []
  const stack = [root]
  let guard = 0
  while (stack.length && guard++ < 5000) {
    const d = stack.pop()
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (/\.html?$/i.test(e.name)) htmls.push(p)
    }
  }
  for (const h of htmls) {
    let text
    try { text = readFileSync(h, 'utf8') } catch { continue }
    const m = text.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i)
      || text.match(/<script[^>]*src=["']([^"']+)["'][^>]*type=["']module["']/i)
    if (!m) continue
    const file = join(root, m[1].replace(/^\//, ''))
    if (existsSync(file)) return file
  }
  return null
}
function scoreEntry(file) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return -1 }
  let score = 0
  if (/new\s+THREE\.WebGLRenderer|new\s+WebGLRenderer/.test(text)) score += 10
  if (/setAnimationLoop|requestAnimationFrame/.test(text)) score += 2
  const b = basename(file).toLowerCase()
  if (/^main\./.test(b)) score += 4
  if (/^index\./.test(b)) score += 3
  if (/install-scene-editor|uninstall-scene-editor/.test(b)) score = -1 // 别把自己当入口
  if (!/[\\/](engine|entities|systems|ui|effects|games|weapons|config)[\\/]/.test(file)) score += 2
  return score
}
function isOurFile(file, name) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return false }
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

function main() {
  const startDir = process.argv[2] ? resolve(process.argv[2]) : __dirname
  log(color.cyan('\n=== 场景编辑器安装器（安全版）===\n'))

  const projectRoot = findProjectRoot(startDir)
  if (!projectRoot) {
    log(color.red('✗ 没找到项目根（附近找不到 package.json）。'))
    process.exitCode = 1
    return
  }
  log(`项目根：${projectRoot}`)

  let entry = findEntryFromHtml(projectRoot)
  if (entry) log(`入口文件（来自 index.html）：${relative(projectRoot, entry)}`)
  else {
    const files = walk(projectRoot)
    let bestScore = 0
    for (const f of files) { const s = scoreEntry(f); if (s > bestScore) { bestScore = s; entry = f } }
    if (entry) log(`入口文件（扫描 WebGLRenderer）：${relative(projectRoot, entry)}`)
  }
  if (!entry) { log(color.yellow('⚠ 没找到入口文件，已中止（不做任何修改）。')); process.exitCode = 1; return }

  const destDir = dirname(entry)
  const copied = []
  const skipped = []
  for (const f of SRC_FILES) {
    const from = join(__dirname, f)
    if (!existsSync(from)) { log(color.red(`✗ 缺少文件：${f}`)); process.exitCode = 1; return }
    const to = join(destDir, f)
    if (existsSync(to) && !isOurFile(to, f)) {
      skipped.push(relative(projectRoot, to))
      log(color.yellow(`⚠ 已存在同名且非本工具的文件，跳过不覆盖：${relative(projectRoot, to)}`))
      continue
    }
    copyFileSync(from, to)
    copied.push(relative(projectRoot, to))
    log(color.green(`✓ 已复制：${relative(projectRoot, to)}`))
  }

  const original = readFileSync(entry, 'utf8')
  const { text: nextText, added, reason } = insertImport(original, entry)
  let backup = null
  if (added) {
    const backupPath = `${entry}.scene-editor-bak`
    if (!existsSync(backupPath)) { copyFileSync(entry, backupPath); backup = relative(projectRoot, backupPath) }
    writeFileSync(entry, nextText, 'utf8')
    log(color.green(`✓ 已在入口加入：${IMPORT_LINE}`))
    if (backup) log(color.green(`✓ 已备份入口：${backup}`))
  } else {
    log(color.yellow(`• 未修改入口（${reason}）`))
  }

  const manifest = {
    tool: 'scene-editor',
    version: 1,
    installedAt: new Date().toISOString(),
    projectRoot,
    entry: relative(projectRoot, entry),
    importLine: IMPORT_LINE,
    marker: MARKER,
    copied,
    skipped,
    backup,
  }
  writeFileSync(join(projectRoot, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')
  log(color.green(`✓ 已写入安装记录：${MANIFEST}（卸载脚本据此精确还原）`))

  log(color.cyan('\n完成！接下来：'))
  log(`  1. cd "${projectRoot}"`)
  log('  2. npm run dev')
  log('  3. 打开页面，按 Tab 进入编辑模式')
  log(color.cyan('如需还原：双击「卸载场景编辑器.cmd」\n'))
}

main()
