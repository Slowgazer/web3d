// ============================================================================
// P5R 风格对话框 —— 可复用组件
// 边框用 SVG 多边形，逐帧对「边中点」沿外法线做轻微形变，实现动态效果。
// 用法：
//   const dlg = new P5RDialogue()
//   dlg.show([{ name: '列车员', text: '……到站了。' }, { text: '下一句' }])
//   dlg.next()   // 推进：打字中则立即显示全文，否则进入下一句
// ============================================================================

const DEFAULTS = {
  width: 1000,        // SVG 逻辑宽
  height: 300,        // SVG 逻辑高
  margin: 18,         // 边框到画布内边距
  corner: 34,         // 转角切角
  skew: 24,           // 整体倾斜（P5 的斜切感）
  wobble: 5.5,        // 边缘形变基础振幅（px）
  speed: 1.7,         // 形变速度
  shadow: [12, 14],   // 朱红投影偏移 [dx, dy]
  typeSpeed: 26,      // 打字机速度（字/秒）
  defaultName: '',    // 未指定说话人时的默认名
  clickToAdvance: true, // 点击对话框自身是否推进
  container: null,    // 挂载点，默认 document.body
  onEnd: null,        // 全部台词播完的回调
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ESC[c])

export class P5RDialogue {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options }
    this._queue = []
    this._index = -1
    this._typing = false
    this._acc = 0
    this._shown = 0
    this._fullText = ''
    this._kick = 0

    this._build()
    this._computeBase()

    this._t = 0
    this._last = performance.now()
    this._raf = requestAnimationFrame((ts) => this._loop(ts))
  }

  // ---- DOM 构建 ----
  _build() {
    const { width, height, container } = this.o
    const host = container || document.body

    this.el = document.createElement('div')
    this.el.className = 'p5r-dialog is-hidden'
    this.el.innerHTML = `
      <div class="p5r-stage">
        <svg class="p5r-svg" viewBox="0 0 ${width} ${height}"
             preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <defs>
            <pattern id="p5r-dots" width="16" height="16"
                     patternUnits="userSpaceOnUse" patternTransform="rotate(18)">
              <circle cx="3.5" cy="3.5" r="2.4" fill="currentColor" />
            </pattern>
          </defs>
          <path class="p5r-shadow" d="" />
          <path class="p5r-body" d="" />
          <path class="p5r-halftone" fill="url(#p5r-dots)" d="" />
        </svg>
        <div class="p5r-content">
          <div class="p5r-name"><span></span></div>
          <div class="p5r-text"></div>
          <div class="p5r-choices" id="p5r-choices" style="display:none"></div>
          <div class="p5r-next" aria-hidden="true"></div>
        </div>
      </div>`
    host.appendChild(this.el)

    this.$shadow = this.el.querySelector('.p5r-shadow')
    this.$body = this.el.querySelector('.p5r-body')
    this.$halftone = this.el.querySelector('.p5r-halftone')
    this.$name = this.el.querySelector('.p5r-name')
    this.$nameText = this.el.querySelector('.p5r-name span')
    this.$text = this.el.querySelector('.p5r-text')
    this.$choices = this.el.querySelector('#p5r-choices')

    // 组件自带点击推进：这样接到任何页面都能用，无需外部再绑事件
    if (this.o.clickToAdvance) {
      this.el.addEventListener('click', (e) => {
        e.stopPropagation() // 避免与外层「点击任意处推进」重复触发
        if (this.$choices && this.$choices.style.display !== 'none') return
        this.advance()
      })
    }
    // 空格 / 回车推进
    this._onKey = (e) => {
      if (e.code !== 'Space' && e.code !== 'Enter') return
      if (this.el.classList.contains('is-hidden')) return
      if (this.$choices && this.$choices.style.display !== 'none') {
        // 选项页：回车选第一个
        if (e.code === 'Enter') {
          const first = this.$choices.querySelector('.p5r-choice')
          if (first) { e.preventDefault(); first.click() }
        }
        return
      }
      e.preventDefault()
      this.advance()
    }
    window.addEventListener('keydown', this._onKey)
  }

  // ---- 计算基础轮廓点（带外法线，供逐帧形变） ----
  _computeBase() {
    const { width: W, height: H, margin: m, corner: c, skew } = this.o
    const x0 = m, y0 = m, x1 = W - m, y1 = H - m
    const cx = W / 2, cy = H / 2

    // 八边形基础角点（顺时针）
    const corners = [
      [x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c],
      [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c],
    ]

    const raw = []
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i]
      const b = corners[(i + 1) % corners.length]
      raw.push({ x: a[0], y: a[1], corner: true })

      // 长边按 ~90px 一段细分，保证形变是平滑起伏而非折角
      const ex = b[0] - a[0], ey = b[1] - a[1]
      const len = Math.hypot(ex, ey)
      const seg = Math.max(1, Math.round(len / 90))

      // 边外法线
      let nx = ey / len, ny = -ex / len
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny }

      for (let s = 1; s < seg; s++) {
        raw.push({
          x: a[0] + (ex * s) / seg,
          y: a[1] + (ey * s) / seg,
          corner: false, nx, ny,
        })
      }
    }

    // 统一斜切 + 生成相位
    this._base = raw.map((p) => ({
      x: p.x + (1 - p.y / H) * skew,
      y: p.y,
      nx: p.nx || 0,
      ny: p.ny || 0,
      corner: !!p.corner,
      ph: Math.random() * 6.283,
      ph2: Math.random() * 6.283,
    }))

    // 静态网点区域（右下角），一次算好即可
    const hx0 = W * 0.60, hy0 = H * 0.5
    const hx1 = W - m - 26, hy1 = H - m - 22
    const hc = 18
    const hy = [
      [hx0 + hc, hy0], [hx1 - hc, hy0], [hx1, hy0 + hc], [hx1, hy1 - hc],
      [hx1 - hc, hy1], [hx0 + hc, hy1], [hx0, hy1 - hc], [hx0, hy0 + hc],
    ].map(([x, y]) => ({ x, y }))
    this.$halftone.setAttribute('d', this._path(hy))
  }

  _path(pts, dx = 0, dy = 0) {
    let d = `M ${(pts[0].x + dx).toFixed(2)} ${(pts[0].y + dy).toFixed(2)}`
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${(pts[i].x + dx).toFixed(2)} ${(pts[i].y + dy).toFixed(2)}`
    }
    return d + ' Z'
  }

  // ---- 主循环 ----
  _loop(ts) {
    const dt = Math.min(0.05, (ts - this._last) / 1000 || 0)
    this._last = ts
    this._t += dt * this.o.speed
    if (this._kick > 0) this._kick = Math.max(0, this._kick - dt * 2.6)

    this._typeTick(dt)
    this._updateShape()
    this._raf = requestAnimationFrame((t) => this._loop(t))
  }

  // 逐帧形变：边中点沿外法线做两段正弦叠加，推进时 kick 放大振幅
  _updateShape() {
    const amp = this.o.wobble * (1 + this._kick * 2.2)
    const t = this._t
    const [sx, sy] = this.o.shadow

    const pts = this._base.map((p) => {
      if (p.corner) return p
      const w = Math.sin(t + p.ph) * 0.6 + Math.sin(t * 2.3 + p.ph2) * 0.4
      return { x: p.x + p.nx * w * amp, y: p.y + p.ny * w * amp }
    })

    this.$shadow.setAttribute('d', this._path(pts, sx, sy))
    this.$body.setAttribute('d', this._path(pts, 0, 0))
  }

  // ---- 标记解析：； 分页 / “” 红字 / （） 选项 ----
  _toChars(text) {
    const out = []
    let red = false
    for (const ch of String(text)) {
      if (ch === '“') { red = true; continue }
      if (ch === '”') { red = false; continue }
      out.push({ ch, red })
    }
    return out
  }

  _htmlOf(chars, n) {
    let html = ''
    let open = false
    for (let i = 0; i < Math.min(n, chars.length); i++) {
      const c = chars[i]
      if (c.red && !open) { html += '<span class="red">'; open = true }
      else if (!c.red && open) { html += '</span>'; open = false }
      html += esc(c.ch)
    }
    if (open) html += '</span>'
    return html
  }

  parsePages(raw) {
    const pages = []
    for (let seg of String(raw).split('；')) {
      seg = seg.trim()
      if (!seg) continue
      const choices = [...seg.matchAll(/（([^）]*)）/g)].map((m) => m[1].trim())
      if (choices.length) pages.push({ type: 'choice', choices })
      else pages.push({ type: 'text', text: seg })
    }
    return pages
  }

  // ---- 打字机 ----
  _typeTick(dt) {
    if (!this._typing) return
    this._acc += dt * this.o.typeSpeed
    const n = Math.min(this._charsArr.length, Math.floor(this._acc))
    if (n !== this._shown) {
      this._shown = n
      this.$text.innerHTML = this._htmlOf(this._charsArr, n)
    }
    if (n >= this._charsArr.length) {
      this._typing = false
      this.el.classList.remove('is-typing')
      this.el.classList.add('is-ready')
    }
  }

  _finishTyping() {
    this._typing = false
    this._shown = this._charsArr.length
    this.$text.innerHTML = this._htmlOf(this._charsArr, this._shown)
    this.el.classList.remove('is-typing')
    this.el.classList.add('is-ready')
  }

  _setSpeaker(name) {
    if (name) { this.$name.style.display = ''; this.$nameText.textContent = name }
    else this.$name.style.display = 'none'
  }

  _showPage(page) {
    this.el.classList.remove('is-ready')
    if (this.$choices) { this.$choices.style.display = 'none'; this.$choices.innerHTML = '' }
    if (page.type === 'choice') {
      this._typing = false
      this.$text.innerHTML = ''
      if (this.$choices) {
        this.$choices.style.display = 'flex'
        page.choices.forEach((c, idx) => {
          const b = document.createElement('button')
          b.className = 'p5r-choice'
          b.textContent = c
          b.addEventListener('click', (e) => {
            e.stopPropagation()
            this.$choices.style.display = 'none'
            this.$choices.innerHTML = ''
            this.o.onChoice?.(c, idx)
          })
          this.$choices.appendChild(b)
        })
      }
      return
    }
    this._setSpeaker(page.name ?? this.o.defaultName)
    this._charsArr = this._toChars(page.text || '')
    this._shown = 0
    this._acc = 0
    this._typing = true
    this.el.classList.add('is-typing')
    this.$text.innerHTML = ''
  }

  // ---- 对外 API ----
  /** 显示一组台词。lines: [{ name?, text }] 或字符串 */
  show(lines) {
    this._queue = (Array.isArray(lines) ? lines : [{ text: String(lines) }])
      .map((l) => ({ type: 'text', text: l.text ?? String(l), name: l.name }))
    this._index = -1
    this.el.classList.remove('is-hidden')
    this.el.classList.add('is-open')
    this.next()
    return this
  }

  /** 播放带标记的脚本：；分句 / “”红字 / （）选项 */
  play(raw, { speaker } = {}) {
    this._queue = this.parsePages(raw)
    if (speaker !== undefined) this.o.defaultName = speaker
    this._index = -1
    this.el.classList.remove('is-hidden')
    this.el.classList.add('is-open')
    this.next()
    return this
  }

  advance() { this.next() }

  /** 推进：打字中 → 立即显示全文；否则进入下一句，播完自动隐藏 */
  next() {
    if (this._typing) { this._finishTyping(); return }
    this._index++
    if (this._index < 0 || this._index >= this._queue.length) {
      this.hide()
      this.o.onEnd?.()
      return
    }
    this._kick = 1
    this._showPage(this._queue[this._index])
  }

  hide() {
    this.el.classList.add('is-hidden')
    this.el.classList.remove('is-open', 'is-ready', 'is-typing')
  }

  destroy() {
    cancelAnimationFrame(this._raf)
    window.removeEventListener('keydown', this._onKey)
    this.el.remove()
  }
}
