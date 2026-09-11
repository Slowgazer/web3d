// ============================================================
// uninstall-scene-editor.mjs
// 场景编辑器卸载 / 还原脚本（安全版）
//   只删除「能确认是本工具加的东西」：
//     - 入口文件里由安装器插入的那段 import
//     - 由安装器复制进来、且内容仍是本工具的 scene-editor*.js
//   绝不删除其它文件、不改 package.json。
//
// 用法：
//   - 双击「卸载场景编辑器.cmd」(Windows) / uninstall-scene-editor.command (macOS)
//   - 或：node uninstall-scene-editor.mjs [可选：项目目录]
// ============================================================

import {
  readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync,
} from 'node:fs'
import { join, dirname, resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST = '.scene-editor-install.json'
const TARGET_FILES = ['scene-editor.js', 'scene-editor-autoload.js']

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
function findProjectRoot(start) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (readPkg(dir)) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}
function findManifest(start, root) {
  const candidates = []
  let dir = start
  for (let i = 0; i < 12; i++) {
    candidates.push(join(dir, MANIFEST))
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  if (root) candidates.push(join(root, MANIFEST))
  // 向下找
  const stack = [root || start]
  let guard = 0
  while (stack.length && guard++ < 20000) {
    const d = stack.pop()
    candidates.push(join(d, MANIFEST))
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue
      stack.push(join(d, e.name))
    }
  }
  return candidates.find((p) => existsSync(p)) || null
}
function isOurFile(file) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return false }
  const name = basename(file)
  if (name === 'scene-editor.js') return text.includes('export class SceneEditor')
  return text.includes('scene-editor-autoload.js') && text.includes('自动挂载')
}
function removeImportBlock(text) {
  const re = /[ \t]*\/\/\s*场景编辑器（按 Tab 进入编辑模式）[^\n]*\r?\n(?:[ \t]*\/\/\s*@ts-ignore[^\n]*\r?\n)?[ \t]*import\s+['"]\.\/scene-editor-autoload\.js['"];?[ \t]*\r?\n/
  if (re.test(text)) return { text: text.replace(re, ''), removed: true }
  const re2 = /[ \t]*import\s+['"]\.\/scene-editor-autoload\.js['"];?[ \t]*\r?\n/
  if (re2.test(text)) return { text: text.replace(re2, ''), removed: true }
  return { text, removed: false }
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

function main() {
  const startDir = process.argv[2] ? resolve(process.argv[2]) : __dirname
  log(color.cyan('\n=== 场景编辑器卸载 / 还原 ===\n'))

  const projectRoot = findProjectRoot(startDir) || startDir
  const manifestPath = findManifest(startDir, projectRoot)

  const removedEntries = []
  const removedFiles = []
  const keptFiles = []

  if (manifestPath) {
    const root = dirname(manifestPath)
    let manifest = {}
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch {}
    log(`依据安装记录：${relative(process.cwd(), manifestPath) || manifestPath}`)

    if (manifest.entry) {
      const entry = join(root, manifest.entry)
      if (existsSync(entry)) {
        const text = readFileSync(entry, 'utf8')
        const { text: out, removed } = removeImportBlock(text)
        if (removed) { writeFileSync(entry, out, 'utf8'); removedEntries.push(relative(root, entry)) }
      }
    }
    for (const rel of manifest.copied || []) {
      const f = join(root, rel)
      if (!existsSync(f)) continue
      if (isOurFile(f)) { unlinkSync(f); removedFiles.push(rel) }
      else keptFiles.push(rel)
    }
    try { unlinkSync(manifestPath) } catch {}
    if (manifest.backup) {
      log(color.yellow(`• 原入口备份保留在：${manifest.backup}（确认无误后可自行删除）`))
    }
  } else {
    // 没有安装记录：按精确标记/签名尽力清理，绝不误伤
    log(color.yellow('未找到安装记录，改为按标记做尽力清理（只处理本工具的文件）。'))
    for (const f of walk(projectRoot)) {
      const name = basename(f)
      if (TARGET_FILES.includes(name) && isOurFile(f)) {
        unlinkSync(f); removedFiles.push(relative(projectRoot, f)); continue
      }
      let text = ''
      try { text = readFileSync(f, 'utf8') } catch { continue }
      if (!text.includes('scene-editor-autoload.js')) continue
      const { text: out, removed } = removeImportBlock(text)
      if (removed) { writeFileSync(f, out, 'utf8'); removedEntries.push(relative(projectRoot, f)) }
    }
  }

  log('')
  if (removedEntries.length) removedEntries.forEach((p) => log(color.green(`✓ 已移除入口 import：${p}`)))
  if (removedFiles.length) removedFiles.forEach((p) => log(color.green(`✓ 已删除本工具文件：${p}`)))
  if (keptFiles.length) keptFiles.forEach((p) => log(color.yellow(`⚠ 保留（内容已被改动，非本工具原版）：${p}`)))
  if (!removedEntries.length && !removedFiles.length) log(color.yellow('没有需要清理的内容。'))
  log(color.cyan('\n完成。你的项目已恢复到安装前的状态（除保留的备份文件外）。\n'))
}

main()
