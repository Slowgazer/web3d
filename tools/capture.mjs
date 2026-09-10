// 渲染验证截图工具：配合 tools/preview/ 使用
// 用法: node tools/capture.mjs --url "http://localhost:5173/tools/preview/?model=..." --out shots/pass1.png
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
function arg(name, def) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : def
}

const url = arg('url')
if (!url) { console.error('缺少 --url'); process.exit(1) }
const out = arg('out', 'shots/capture.png')

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
})
try {
  const page = await browser.newPage()
  await page.setViewport({
    width: parseInt(arg('width', '1024')),
    height: parseInt(arg('height', '768')),
  })
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 })
  await page.waitForFunction('window.__ready === true || window.__error', { timeout: 60000 })
  const err = await page.evaluate('window.__error')
  if (err) { console.error('页面加载失败:', err); process.exit(2) }
  mkdirSync(dirname(out), { recursive: true })
  await page.screenshot({ path: out })
  console.log('OK', out)
} finally {
  await browser.close()
}
