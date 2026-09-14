// ============================================================================
// 视觉小说对话框
// 标记约定：； 分句 / “xxx” 红字 / （xxx） 选项
// ============================================================================
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ESC[c])

export class VNDialogue {
  constructor(options = {}) {
    this.o = {
      typeSpeed: 34,
      onChoice: null,
      onComplete: null,
      spriteSrc: '/ui/conductor.png',
      ...options,
    }
    this._queue = []
    this._i = -1
    this._shown = 0
    this._typing = false
    this._acc = 0
    this._last = performance.now()
    this._build()
    this._raf = requestAnimationFrame((t) => this._loop(t))
  }

  _build() {
    const root = document.createElement('div')
    root.id = 'vn-root'
    root.innerHTML = `
      <img id="vn-sprite" alt="" />
      <div id="vn-box">
        <div id="vn-name"><span></span></div>
        <div id="vn-text"></div>
        <div id="vn-choices" style="display:none"></div>
        <div id="vn-next"></div>
      </div>`
    document.body.appendChild(root)
    this.root = root
    this.sprite = root.querySelector('#vn-sprite')
    this.box = root.querySelector('#vn-box')
    this.nameEl = root.querySelector('#vn-name')
    this.nameText = this.nameEl.querySelector('span')
    this.textEl = root.querySelector('#vn-text')
    this.choicesEl = root.querySelector('#vn-choices')
    this.sprite.src = this.o.spriteSrc

    this.box.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.choicesEl.style.display === 'none') this.next()
    })
  }

  // ---- 解析：； → 页；“” → 红字；（…） → 选项 ----
  parse(raw) {
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

  // 把 “…” 拆成 [{ch, red}]
  _chars(text) {
    const out = []
    let red = false
    for (const ch of String(text)) {
      if (ch === '“') { red = true; continue }
      if (ch === '”') { red = false; continue }
      out.push({ ch, red })
    }
    return out
  }

  _html(chars, n) {
    let html = ''
    let open = false
    for (let i = 0; i < n; i++) {
      const c = chars[i]
      if (c.red && !open) { html += '<span class="red">'; open = true }
      else if (!c.red && open) { html += '</span>'; open = false }
      html += escapeHtml(c.ch)
    }
    if (open) html += '</span>'
    return html
  }

  // ---- 播放一组页；遇到选项页会停下等待 onChoice ----
  play(raw, { speaker } = {}) {
    if (speaker !== undefined) this.setSpeaker(speaker)
    this._queue = this.parse(raw)
    this._i = -1
    this.root.classList.add('show')
    this.sprite.classList.add('show')
    this.box.classList.add('show')
    this.next()
    return this
  }

  setSpeaker(name) {
    if (name) { this.nameEl.style.display = ''; this.nameText.textContent = name }
    else this.nameEl.style.display = 'none'
  }

  next() {
    if (this._typing) { this._finishTyping(); return }
    this._i += 1
    if (this._i >= this._queue.length) { this.o.onComplete?.(); return }
    this._showPage(this._queue[this._i])
  }

  _showPage(page) {
    this.root.classList.remove('ready')
    if (page.type === 'choice') {
      this._typing = false
      this.textEl.innerHTML = ''
      this.choicesEl.style.display = 'flex'
      this.choicesEl.innerHTML = ''
      page.choices.forEach((c, idx) => {
        const b = document.createElement('button')
        b.className = 'vn-choice'
        b.textContent = c
        b.addEventListener('click', (e) => {
          e.stopPropagation()
          this.choicesEl.style.display = 'none'
          this.choicesEl.innerHTML = ''
          this.o.onChoice?.(c, idx)
        })
        this.choicesEl.appendChild(b)
      })
      return
    }
    this.choicesEl.style.display = 'none'
    this._chars_ = this._chars(page.text)
    this._shown = 0
    this._acc = 0
    this._typing = true
    this.textEl.innerHTML = ''
  }

  _finishTyping() {
    this._typing = false
    this._shown = this._chars_.length
    this.textEl.innerHTML = this._html(this._chars_, this._shown)
    this.root.classList.add('ready')
  }

  _loop(ts) {
    const dt = Math.min(0.05, (ts - this._last) / 1000 || 0)
    this._last = ts
    if (this._typing) {
      this._acc += dt * this.o.typeSpeed
      const n = Math.min(this._chars_.length, Math.floor(this._acc))
      if (n !== this._shown) {
        this._shown = n
        this.textEl.innerHTML = this._html(this._chars_, n)
      }
      if (n >= this._chars_.length) {
        this._typing = false
        this.root.classList.add('ready')
      }
    }
    this._raf = requestAnimationFrame((t) => this._loop(t))
  }

  setSprite(src) { this.sprite.src = src }

  close() {
    this.box.classList.remove('show')
    this.sprite.classList.remove('show')
    setTimeout(() => { this.root.classList.remove('show') }, 300)
  }

  destroy() {
    cancelAnimationFrame(this._raf)
    this.root.remove()
  }
}
