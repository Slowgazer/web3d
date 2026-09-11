// 把编辑器源码同步到一键安装包 scene-editor-kit/
// 用法：node tools/build-editor-kit.mjs
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const kit = join(root, 'scene-editor-kit')
mkdirSync(kit, { recursive: true })

for (const f of ['scene-editor.js', 'scene-editor-autoload.js']) {
  copyFileSync(join(root, 'src', f), join(kit, f))
  console.log('已同步', f, '->', join('scene-editor-kit', f))
}
