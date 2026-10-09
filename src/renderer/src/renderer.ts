interface ChatModel {
  id: string
  providerID: string
  modelID: string
  name: string
  variants: string[]
  capabilities?: { input?: string[]; tools?: boolean }
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'error'
  content: string
  reasoning?: string
  sources?: { url: string; title: string }[]
  images?: { name: string; thumb?: string; path?: string }[]
}

interface Chat {
  id: string
  title: string
  sessionID: string
  model: string
  variant?: string
  messages: ChatMessage[]
  createdAt: number
}

interface Attachment {
  name: string
  content?: string
  path?: string
  preview?: string
  thumb?: string
  size?: number
  kind: 'text' | 'image' | 'video' | 'other'
}

function fmtSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function revokePreviews(): void {
  for (const a of attachments) {
    if (a.preview) {
      try {
        URL.revokeObjectURL(a.preview)
      } catch {
        // ignora
      }
      a.preview = undefined
    }
  }
}

const STORAGE_KEY = 'meu-assistente:chats:v1'
const MODEL_KEY = 'meu-assistente:model:v1'
const VARIANT_KEY = 'meu-assistente:variant:v1'
const DEFAULT_MODEL = 'opencode/big-pickle'

let chats: Chat[] = []
let activeChatId: string | null = null
let models: ChatModel[] = []
let modelsError = ''
let sending = false
let attachments: Attachment[] = []
let recognition: any = null
let searchArmed = false
let sendGen = 0

function requiredMedia(): '' | 'image' | 'video' {
  if (attachments.some((a) => a.kind === 'video')) return 'video'
  if (attachments.some((a) => a.kind === 'image')) return 'image'
  return ''
}

function requiredCaps(): string[] {
  const out: string[] = []
  const media = requiredMedia()
  if (media) out.push(media)
  if (searchArmed) out.push('tools')
  return out
}

const CAP_LABELS: Record<string, string> = { image: 'imagem', video: 'vídeo', tools: 'pesquisa web' }

function modelCapable(m: ChatModel, needs: string[]): boolean {
  for (const n of needs) {
    if (n === 'image' || n === 'video') {
      const caps = m.capabilities?.input
      if (caps && !caps.includes(n)) return false
    } else if (n === 'tools') {
      if (m.capabilities?.tools === false) return false
    }
  }
  return true
}

function ensureCapableModel(): void {
  const needs = requiredCaps()
  if (needs.length === 0) return
  const cur = currentModel()
  if (cur && modelCapable(cur, needs)) return
  const alt = models.find(
    (m) =>
      needs.every((n) =>
        n === 'tools' ? m.capabilities?.tools === true : m.capabilities?.input?.includes(n)
      ) && m.id !== getSelectedModel()
  )
  if (alt) setSelectedModel(alt.id)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function armSearch(): void {
  searchArmed = true
  ;($('#input') as HTMLTextAreaElement).placeholder = 'Pesquisar na web…'
  $('#btn-search').classList.add('on')
  renderChips()
  renderModelList()
  hidePopups()
  ;($('#input') as HTMLTextAreaElement).focus()
}

function disarmSearch(): void {
  searchArmed = false
  ;($('#input') as HTMLTextAreaElement).placeholder = 'Send a message...'
  $('#btn-search').classList.remove('on')
  renderChips()
  renderModelList()
}

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`elemento não encontrado: ${sel}`)
  return el
}

function uid(): string {
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function loadState(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) chats = JSON.parse(raw) as Chat[]
  } catch {
    chats = []
  }
}

function saveState(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats.slice(0, 100)))
  } catch {
    // ignora quota
  }
}

function getActiveChat(): Chat | null {
  return chats.find((c) => c.id === activeChatId) ?? null
}

function shortModel(id: string): string {
  const slash = id.indexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

function getSelectedModel(): string {
  return localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL
}

function currentModel(): ChatModel | undefined {
  return models.find((m) => m.id === getSelectedModel())
}

function prettyVariant(v: string): string {
  const map: Record<string, string> = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max'
  }
  return map[v] ?? (v.charAt(0).toUpperCase() + v.slice(1))
}

function defaultVariantFor(m: ChatModel | undefined): string {
  if (!m || m.variants.length === 0) return ''
  const prefs = ['medium', 'high', 'low', 'minimal', 'xhigh', 'max']
  for (const p of prefs) {
    if (m.variants.includes(p)) return p
  }
  return m.variants[0]
}

function getSelectedVariant(): string {
  const m = currentModel()
  if (!m || m.variants.length === 0) return ''
  const saved = localStorage.getItem(VARIANT_KEY) || ''
  if (saved && m.variants.includes(saved)) return saved
  return defaultVariantFor(m)
}

function setSelectedVariant(v: string): void {
  if (v) localStorage.setItem(VARIANT_KEY, v)
  else localStorage.removeItem(VARIANT_KEY)
  updateVariantUI()
  const chat = getActiveChat()
  if (chat) {
    chat.variant = v || undefined
    saveState()
    // aplica na sessão existente sem bloquear a UI
    if (chat.sessionID) {
      window.assistant.switchModel(chat.sessionID, chat.model, v || undefined).catch(() => {
        // será aplicado no próximo envio de qualquer forma
      })
    }
  }
}

function setSelectedModel(id: string): void {
  localStorage.setItem(MODEL_KEY, id)
  // ajusta variante para o novo modelo
  const m = models.find((x) => x.id === id)
  const dv = defaultVariantFor(m)
  if (dv) localStorage.setItem(VARIANT_KEY, dv)
  else localStorage.removeItem(VARIANT_KEY)
  updateModelLabel()
  renderModelList()
  updateVariantUI()
  const chat = getActiveChat()
  if (chat) {
    const prevVariant = chat.variant
    chat.model = id
    chat.variant = dv || undefined
    saveState()
    if (chat.sessionID && (chat.model !== id || prevVariant !== chat.variant)) {
      window.assistant.switchModel(chat.sessionID, id, dv || undefined).catch(() => {})
    }
  }
}

// ---------- markdown mínimo ----------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderInline(s: string): string {
  let out = escapeHtml(s)
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/`([^`]+?)`/g, '<code class="inline">$1</code>')
  out = out.replace(/\[([^\]]+?)\]\((https?:[^)]+?)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  return out
}

function renderMarkdown(src: string): string {
  const blocks: string[] = []
  const withPlaceholders = src.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (_m, _lang, code) => {
    const idx = blocks.length
    blocks.push(`<pre><code>${escapeHtml(String(code).replace(/\n$/, ''))}</code></pre>`)
    return `\u0000${idx}\u0000`
  })
  const lines = withPlaceholders.split('\n')
  let html = ''
  let inList: 'ul' | 'ol' | null = null
  const flush = (): void => {
    if (inList) {
      html += inList === 'ul' ? '</ul>' : '</ol>'
      inList = null
    }
  }
  for (const rawLine of lines) {
    const ph = rawLine.match(/^\u0000(\d+)\u0000$/)
    if (ph) {
      flush()
      html += blocks[Number(ph[1])]
      continue
    }
    const line = rawLine.trim()
    if (!line) {
      flush()
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      flush()
      html += `<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`
      continue
    }
    const ul = line.match(/^[-*]\s+(.*)$/)
    if (ul) {
      if (inList !== 'ul') {
        flush()
        html += '<ul>'
        inList = 'ul'
      }
      html += `<li>${renderInline(ul[1])}</li>`
      continue
    }
    const ol = line.match(/^\d+[.)]\s+(.*)$/)
    if (ol) {
      if (inList !== 'ol') {
        flush()
        html += '<ol>'
        inList = 'ol'
      }
      html += `<li>${renderInline(ol[1])}</li>`
      continue
    }
    flush()
    html += `<p>${renderInline(rawLine)}</p>`
  }
  flush()
  return html
}

// ---------- status / modelos ----------

function setStatus(state: 'loading' | 'ok' | 'err', text: string): void {
  $('#status-text').textContent = text
  const dot = $('#status-dot')
  dot.className = `status-dot${state === 'ok' ? ' ok' : state === 'err' ? ' err' : ''}`
}

function updateModelLabel(): void {
  const label = $('#model-label')
  if (models.length === 0) {
    label.textContent = modelsError ? 'Modelos indisponíveis' : 'Carregando modelos…'
    return
  }
  const sel = getSelectedModel()
  const found = models.find((m) => m.id === sel)
  label.textContent = shortModel(found?.id ?? sel)
  label.title = found ? `${found.name} (${found.id})` : sel
}

function renderModelList(): void {
  const box = $('#model-list')
  box.innerHTML = ''
  if (models.length === 0) {
    const div = document.createElement('div')
    div.className = `model-state${modelsError ? ' err' : ''}`
    div.textContent = modelsError ? `Erro: ${modelsError}` : 'Buscando modelos no OpenCode local…'
    box.appendChild(div)
    if (modelsError) {
      const btn = document.createElement('button')
      btn.className = 'inline-retry'
      btn.textContent = 'Tentar de novo'
      btn.addEventListener('click', () => void initModels())
      const wrap = document.createElement('div')
      wrap.className = 'model-state'
      wrap.appendChild(btn)
      box.appendChild(wrap)
    }
    return
  }
  const sel = getSelectedModel()
  const needs = requiredCaps()
  const needLabel = needs.map((n) => CAP_LABELS[n] ?? n).join(' e ')
  for (const m of models) {
    const capable = modelCapable(m, needs)
    const b = document.createElement('button')
    b.className = `model-item${m.id === sel ? ' selected' : ''}${capable ? '' : ' dimmed'}`
    const icon = document.createElement('span')
    icon.className = 'provider-icon'
    icon.innerHTML =
      '<svg width="16" height="16" viewBox="0 6 24 30" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M24 36H0V6H24V36ZM18 30H6V12H18V30Z" fill="currentColor"/></svg>'
    icon.title = m.providerID
    const name = document.createElement('span')
    name.className = 'm-name'
    const title = document.createElement('b')
    title.textContent = m.name || m.modelID
    const sub = document.createElement('small')
    if (!capable) {
      sub.textContent = `${m.id} • sem suporte a ${needLabel}`
    } else if (m.variants.length > 0) {
      sub.textContent = `${m.id} • ${m.variants.map(prettyVariant).join(', ')}`
    } else {
      sub.textContent = m.id
    }
    name.appendChild(title)
    name.appendChild(sub)
    const check = document.createElement('span')
    check.className = 'check'
    check.textContent = m.id === sel ? '✓' : ''
    b.appendChild(icon)
    b.appendChild(name)
    b.appendChild(check)
    b.title = capable ? m.id : 'Este modelo não suporta anexo de ' + needLabel
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!capable) return
      setSelectedModel(m.id)
    })
    box.appendChild(b)
  }
}

function updateVariantUI(): void {
  const label = $('#variant-label')
  const m = currentModel()
  if (!m || m.variants.length === 0) {
    label.textContent = models.length === 0 ? '…' : '—'
    label.title = 'Este modelo não tem níveis de pensamento'
  } else {
    const v = getSelectedVariant()
    label.textContent = prettyVariant(v)
    label.title = `Nível de pensamento: ${prettyVariant(v)}`
  }
  renderThinkingRow()
}

function renderThinkingRow(): void {
  const foot = $('#thinking-foot')
  const row = $('#thinking-row')
  row.innerHTML = ''
  const m = currentModel()
  if (!m || m.variants.length === 0) {
    foot.classList.add('hidden')
    return
  }
  foot.classList.remove('hidden')
  const sel = getSelectedVariant()
  for (const v of m.variants) {
    const b = document.createElement('button')
    b.className = `think-btn${v === sel ? ' on' : ''}`
    b.textContent = prettyVariant(v)
    b.title = v
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      setSelectedVariant(v)
    })
    row.appendChild(b)
  }
}

async function initModels(): Promise<void> {
  setStatus('loading', 'Conectando ao OpenCode…')
  updateModelLabel()
  renderModelList()
  try {
    if (!window.assistant) throw new Error('ponte com o Electron indisponível (preload). Recompile e reinicie.')
    models = await window.assistant.listModels()
    modelsError = ''
    const sel = getSelectedModel()
    if (!models.some((m) => m.id === sel)) {
      // mantém preferência se existir, senão usa o primeiro
      const fallback = models.find((m) => m.id === DEFAULT_MODEL) ?? models[0]
      localStorage.setItem(MODEL_KEY, fallback.id)
    }
    // valida o nível salvo contra as variantes reais do modelo
    const m = currentModel()
    if (m && m.variants.length > 0) {
      const saved = localStorage.getItem(VARIANT_KEY) || ''
      if (!m.variants.includes(saved)) {
        localStorage.setItem(VARIANT_KEY, defaultVariantFor(m))
      }
    } else {
      localStorage.removeItem(VARIANT_KEY)
    }
    const st = await window.assistant.getStatus().catch(() => null)
    setStatus('ok', st?.version ? `${models.length} modelos • ${st.version}` : `${models.length} modelos`)
  } catch (err: any) {
    models = []
    modelsError = err?.message ? String(err.message) : String(err)
    setStatus('err', 'OpenCode indisponível')
  }
  updateModelLabel()
  renderModelList()
  updateVariantUI()
}

// ---------- setup inicial ----------

interface AppConfig {
  userName: string
  chatsDir: string
  setupDone: boolean
  version: string
}

let appConfig: AppConfig | null = null
let setupEditing = false

function applyConfig(): void {
  const raw = (appConfig?.userName || '').trim()
  const name = raw || 'Você'
  $('#user-name').textContent = name
  $('#user-avatar').textContent = name.charAt(0).toUpperCase()
  $('#welcome-title').textContent = raw ? `Como posso ajudar, ${raw.split(/\s+/)[0]}?` : 'Como posso ajudar?'
}

function openSetup(editing: boolean): void {
  setupEditing = editing
  $('#setup-title').textContent = editing ? 'Editar perfil' : 'Bem-vindo ao OpenBean'
  ;($('#setup-name') as HTMLInputElement).value = appConfig?.userName ?? ''
  $('#setup-folder').textContent = appConfig?.chatsDir || '…'
  $('#setup-folder').title = appConfig?.chatsDir || ''
  ;($('#setup-save') as HTMLButtonElement).textContent = editing ? 'Salvar' : 'Começar →'
  $('#setup-error').classList.add('hidden')
  $('#setup-overlay').classList.remove('hidden')
  setTimeout(() => ($('#setup-name') as HTMLInputElement).focus(), 50)
}

function closeSetup(): void {
  $('#setup-overlay').classList.add('hidden')
}

async function initSetup(): Promise<void> {
  try {
    if (!window.assistant?.getConfig) {
      appConfig = { userName: '', chatsDir: '', setupDone: true, version: '' }
    } else {
      appConfig = await window.assistant.getConfig()
    }
  } catch {
    appConfig = { userName: '', chatsDir: '', setupDone: true, version: '' }
  }
  $('#setup-version').textContent = appConfig.version ? `OpenBean v${appConfig.version}` : 'OpenBean'
  if (!appConfig.setupDone) openSetup(false)
  else applyConfig()
}

async function saveSetup(): Promise<void> {
  const btn = $('#setup-save') as HTMLButtonElement
  const errBox = $('#setup-error')
  const name = (($('#setup-name') as HTMLInputElement).value || '').trim()
  const folder = ($('#setup-folder').textContent || '').trim()
  if (!name) {
    errBox.textContent = 'Informe seu nome para continuar.'
    errBox.classList.remove('hidden')
    return
  }
  btn.disabled = true
  errBox.classList.add('hidden')
  try {
    appConfig = await window.assistant.setConfig({ userName: name, chatsDir: folder })
    $('#setup-version').textContent = appConfig.version ? `OpenBean v${appConfig.version}` : 'OpenBean'
    closeSetup()
    applyConfig()
  } catch (err: any) {
    errBox.textContent = err?.message ? String(err.message) : 'Falha ao salvar. Tente de novo.'
    errBox.classList.remove('hidden')
  } finally {
    btn.disabled = false
  }
}

// ---------- histórico / chat ----------

function renderHistory(filter = ''): void {
  const box = $('#history')
  box.innerHTML = ''
  const q = filter.trim().toLowerCase()
  const list = [...chats]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((c) => !q || c.title.toLowerCase().includes(q))
  if (list.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = chats.length === 0 ? 'Nenhuma conversa.' : 'Sem resultados.'
    box.appendChild(empty)
    return
  }
  for (const c of list) {
    const btn = document.createElement('button')
    btn.className = `history-item${c.id === activeChatId ? ' active' : ''}`
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = c.title || 'Sem título'
    const del = document.createElement('span')
    del.className = 'del'
    del.textContent = '×'
    del.title = 'Excluir'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      void deleteChat(c.id)
    })
    btn.appendChild(title)
    btn.appendChild(del)
    btn.addEventListener('click', () => switchChat(c.id))
    box.appendChild(btn)
  }
}

function scrollToBottom(): void {
  const scroller = $('#chat-scroll')
  scroller.scrollTop = scroller.scrollHeight
}

function updateTopbar(): void {
  const chat = getActiveChat()
  $('#topbar-title').textContent = chat?.title && chat.messages.length > 0 ? chat.title : 'New chat'
}

function renderChat(): void {
  const chat = getActiveChat()
  const box = $('#chat')
  box.innerHTML = ''
  const isEmpty = chat === null || chat.messages.length === 0
  $('#empty-state').classList.toggle('hidden', !isEmpty)
  $('#suggestions-row').classList.toggle('hidden', !isEmpty)
  updateTopbar()
  if (!chat) {
    scrollToBottom()
    return
  }
  for (const m of chat.messages) {
    box.appendChild(messageEl(m.role, m.content, m.reasoning, m.sources, m.images))
  }
  scrollToBottom()
}

function messageEl(
  role: ChatMessage['role'],
  content: string,
  reasoning?: string,
  sources?: { url: string; title: string }[],
  images?: { name: string; thumb?: string; path?: string }[]
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = `msg ${role === 'error' ? 'assistant error' : role}`
  const who = document.createElement('div')
  who.className = 'who'
  who.textContent = role === 'user' ? 'Você' : role === 'error' ? 'Erro' : 'Assistente'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  if (images && images.length > 0) {
    const row = document.createElement('div')
    row.className = 'msg-images'
    for (const im of images.slice(0, 4)) {
      if (!im.thumb) continue
      const el = document.createElement('img')
      el.src = im.thumb
      el.alt = im.name
      el.title = `${im.name} — clique para abrir`
      el.addEventListener('click', () => {
        if (im.path) window.assistant.openFile(im.path).catch(() => {})
      })
      row.appendChild(el)
    }
    if (row.childElementCount > 0) bubble.appendChild(row)
  }
  if (reasoning) {
    const det = document.createElement('details')
    det.className = 'reasoning'
    const sum = document.createElement('summary')
    sum.textContent = 'Raciocínio'
    const pre = document.createElement('div')
    pre.textContent = reasoning
    det.appendChild(sum)
    det.appendChild(pre)
    bubble.appendChild(det)
  }
  const body = document.createElement('div')
  body.innerHTML = renderMarkdown(content)
  bubble.appendChild(body)
  if (sources && sources.length > 0) {
    const box = document.createElement('div')
    box.className = 'sources'
    const head = document.createElement('div')
    head.className = 'sources-head'
    head.textContent = 'Fontes'
    box.appendChild(head)
    for (const s of sources.slice(0, 5)) {
      const a = document.createElement('a')
      a.className = 'src-row'
      a.href = s.url
      a.target = '_blank'
      a.rel = 'noreferrer'
      a.title = s.url
      const fav = document.createElement('span')
      fav.className = 'fav-wrap'
      fav.textContent = '○'
      const img = document.createElement('img')
      img.alt = ''
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      const host = hostOf(s.url)
      const favSrcs = [
        `https://www.google.com/s2/favicons?domain=${host}&sz=64`,
        `https://icons.duckduckgo.com/ip3/${host}.ico`
      ]
      let favIdx = 0
      img.src = favSrcs[favIdx]
      img.addEventListener('error', () => {
        favIdx++
        if (favIdx < favSrcs.length) img.src = favSrcs[favIdx]
        else img.remove()
      })
      fav.appendChild(img)
      const t = document.createElement('span')
      t.className = 't'
      const b = document.createElement('b')
      b.textContent = s.title || hostOf(s.url)
      const small = document.createElement('small')
      small.textContent = hostOf(s.url)
      t.appendChild(b)
      t.appendChild(small)
      const go = document.createElement('span')
      go.className = 'go'
      go.textContent = '↗'
      a.appendChild(fav)
      a.appendChild(t)
      a.appendChild(go)
      box.appendChild(a)
    }
    bubble.appendChild(box)
  }
  if (role === 'error') {
    const row = document.createElement('div')
    row.className = 'retry-row'
    const btn = document.createElement('button')
    btn.className = 'inline-retry'
    btn.textContent = 'Tentar de novo'
    btn.addEventListener('click', () => void retryLast())
    row.appendChild(btn)
    bubble.appendChild(row)
  }
  wrap.appendChild(who)
  wrap.appendChild(bubble)
  return wrap
}

function showTyping(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'msg assistant'
  wrap.id = 'typing-row'
  const who = document.createElement('div')
  who.className = 'who'
  who.textContent = 'Assistente'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const t = document.createElement('div')
  t.className = 'typing'
  t.innerHTML = '<div class="dots"><span></span><span></span><span></span></div>'
  bubble.appendChild(t)
  wrap.appendChild(who)
  wrap.appendChild(bubble)
  $('#chat').appendChild(wrap)
  scrollToBottom()
  return wrap
}

function refreshSendBtn(): void {
  const input = $('#input') as HTMLTextAreaElement
  const send = $('#send') as HTMLButtonElement
  const hasText = input.value.trim().length > 0 || attachments.length > 0
  if (sending) {
    send.disabled = false
    send.className = 'send-btn stop'
    send.textContent = '■'
    send.title = 'Interromper'
    return
  }
  send.disabled = !hasText
  send.className = `send-btn${hasText ? ' ready' : ''}`
  send.textContent = '↑'
  send.title = 'Enviar'
}

function setSending(state: boolean): void {
  sending = state
  const input = $('#input') as HTMLTextAreaElement
  input.disabled = state
  refreshSendBtn()
  if (!state) input.focus()
}

// ---------- ações ----------

function newChat(): void {
  chats.unshift({
    id: uid(),
    title: 'Nova conversa',
    sessionID: '',
    model: getSelectedModel(),
    variant: getSelectedVariant() || undefined,
    messages: [],
    createdAt: Date.now()
  })
  activeChatId = chats[0].id
  saveState()
  renderHistory(($('#search') as HTMLInputElement).value)
  renderChat()
  autosize()
  refreshSendBtn()
  ;($('#input') as HTMLTextAreaElement).focus()
}

function switchChat(id: string): void {
  activeChatId = id
  const chat = getActiveChat()
  if (chat?.model) {
    localStorage.setItem(MODEL_KEY, chat.model)
    if (chat.variant) localStorage.setItem(VARIANT_KEY, chat.variant)
    else {
      const m = models.find((x) => x.id === chat.model)
      const dv = m ? defaultVariantFor(m) : ''
      if (dv) localStorage.setItem(VARIANT_KEY, dv)
      else localStorage.removeItem(VARIANT_KEY)
    }
    updateModelLabel()
    renderModelList()
    updateVariantUI()
  }
  saveState()
  renderHistory(($('#search') as HTMLInputElement).value)
  renderChat()
  refreshSendBtn()
}

async function deleteChat(id: string): Promise<void> {
  const chat = chats.find((c) => c.id === id)
  chats = chats.filter((c) => c.id !== id)
  if (chat?.sessionID) {
    try {
      await window.assistant.deleteSession(chat.sessionID)
    } catch {
      // ignora
    }
  }
  if (activeChatId === id) activeChatId = chats.length > 0 ? chats[0].id : null
  saveState()
  renderHistory(($('#search') as HTMLInputElement).value)
  renderChat()
  refreshSendBtn()
}

function firstTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 44 ? `${t.slice(0, 44)}…` : t || 'Nova conversa'
}

function buildPrompt(text: string): string {
  const texts = attachments.filter((a) => a.kind === 'text' && a.content)
  if (texts.length === 0) return text
  const ctx = texts
    .map((a) => `[Arquivo: ${a.name}]\n${(a.content ?? '').slice(0, 20000)}`)
    .join('\n\n')
  return `${ctx}\n\n---\n\n${text}`
}

async function retryLast(): Promise<void> {
  const chat = getActiveChat()
  if (!chat || sending) return
  // remove erro e reenvia última pergunta do usuário
  const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user')
  chat.messages = chat.messages.filter((m) => m.role !== 'error')
  renderChat()
  if (lastUser) await handleSend(lastUser.content, true)
}

async function handleSend(prefill?: string, isRetry = false): Promise<void> {
  if (sending) {
    // stop: invalida a geração atual, limpa a UI e interrompe no servidor
    const c0 = getActiveChat()
    sendGen++
    const sid0 = c0?.sessionID ?? ''
    setSending(false)
    document.querySelector('#typing-row')?.remove()
    renderChat()
    refreshSendBtn()
    if (sid0) window.assistant.interrupt(sid0).catch(() => {})
    return
  }
  const input = $('#input') as HTMLTextAreaElement
  const text = (prefill ?? input.value).trim()
  if (!text && attachments.length === 0) return
  let chat = getActiveChat()
  if (!chat) {
    newChat()
    chat = getActiveChat()
    if (!chat) return
  }
  if (models.length === 0) {
    chat.messages.push({ role: 'error', content: 'Erro: nenhum modelo carregado. Verifique o status na barra lateral e clique em ↻.' })
    saveState()
    renderChat()
    return
  }
  const model = getSelectedModel()
  const variant = getSelectedVariant()
  chat.model = model
  chat.variant = variant || undefined
  let prompt = buildPrompt(text)
  let sources: { url: string; title: string }[] | undefined
  const useSearch = searchArmed
  if (useSearch) disarmSearch()
  const pendingFiles = attachments.filter((a) => a.path).map((a) => ({ uri: a.path as string, name: a.name }))
  const pendingImages = attachments
    .filter((a) => a.kind === 'image' && (a.thumb || a.preview))
    .map((a) => ({ name: a.name, thumb: a.thumb ?? a.preview, path: a.path }))
  if (!isRetry) {
    if (chat.messages.length === 0) chat.title = firstTitle(text)
    chat.messages.push({
      role: 'user',
      content: text,
      images: pendingImages.length > 0 ? pendingImages : undefined
    })
  }
  input.value = ''
  revokePreviews()
  attachments = []
  renderChips()
  autosize()
  refreshSendBtn()
  saveState()
  renderHistory(($('#search') as HTMLInputElement).value)
  renderChat()
  const typing = showTyping()
  setSending(true)
  const myGen = ++sendGen
  if (useSearch) {
    try {
      const sr = await window.assistant.websearch(text)
      if (sr.results.length > 0) {
        const ctx = sr.results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`)
          .join('\n\n')
        prompt = `[Resultados da pesquisa na internet — use-os para responder e cite as URLs mais relevantes:]\n${ctx}\n\n---\n\n${prompt}`
        sources = sr.results.map((r) => ({ url: r.url, title: r.title }))
      }
    } catch (err: any) {
      typing.remove()
      setSending(false)
      searchArmed = true
      renderChips()
      ;($('#input') as HTMLTextAreaElement).placeholder = 'Pesquisar na web…'
      chat.messages.push({
        role: 'error',
        content: `Erro na pesquisa web: ${err?.message ? String(err.message) : 'falha ao pesquisar.'}`
      })
      saveState()
      renderHistory(($('#search') as HTMLInputElement).value)
      renderChat()
      refreshSendBtn()
      return
    }
  }
  // frase inicial em pt-BR para respostas em português
  const finalPrompt = chat.messages.filter((m) => m.role !== 'error').length <= 2
    ? `Responda em português brasileiro.\n\n${prompt}`
    : prompt
  try {
    const res = await window.assistant.send(chat.sessionID, finalPrompt, {
      title: chat.title,
      model,
      variant: variant || undefined,
      files: pendingFiles.length > 0 ? pendingFiles : undefined
    })
    if (myGen !== sendGen) return
    chat.sessionID = res.sessionID
    if (res.model && res.model !== chat.model) {
      // failover: o backend respondeu por outro modelo — reflete na UI
      chat.model = res.model
      localStorage.setItem(MODEL_KEY, res.model)
      const m = currentModel()
      const vv = getSelectedVariant()
      if (!m || (vv && m.variants.length > 0 && !m.variants.includes(vv))) {
        const dv = m ? defaultVariantFor(m) : ''
        if (dv) localStorage.setItem(VARIANT_KEY, dv)
        else localStorage.removeItem(VARIANT_KEY)
        chat.variant = dv || undefined
      }
      updateModelLabel()
      renderModelList()
      updateVariantUI()
    }
    chat.messages.push({ role: 'assistant', content: res.text, reasoning: res.reasoning, sources })
  } catch (err: any) {
    if (myGen !== sendGen) return
    chat.messages.push({ role: 'error', content: `Erro: ${err?.message ? String(err.message) : 'falha ao falar com o OpenCode local.'}` })
  } finally {
    if (myGen !== sendGen) return
    typing.remove()
    setSending(false)
    saveState()
    renderHistory(($('#search') as HTMLInputElement).value)
    renderChat()
    renderModelList()
    refreshSendBtn()
  }
}

function autosize(): void {
  const input = $('#input') as HTMLTextAreaElement
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`
}

// ---------- anexos / popups / mic ----------

function hidePopups(): void {
  $('#attach-menu').classList.add('hidden')
  $('#model-menu').classList.add('hidden')
}

function renderChips(): void {
  const box = $('#attach-chips')
  box.innerHTML = ''
  attachments.forEach((a, i) => {
    const chip = document.createElement('div')
    chip.className = 'chip preview'
    chip.title = a.name
    if (a.kind === 'image' && a.preview) {
      const thumb = document.createElement('span')
      thumb.className = 'thumb'
      const img = document.createElement('img')
      img.src = a.preview
      img.alt = a.name
      thumb.appendChild(img)
      chip.appendChild(thumb)
    } else {
      const icon = document.createElement('span')
      icon.className = 'doc-icon'
      icon.innerHTML =
        a.kind === 'video'
          ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="3.5" width="13" height="9" rx="2"/><path d="M6.5 6.5l3 2-3 2z" fill="currentColor" stroke="none"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h5.5l3.5 3.5v9.5h-9z"/><path d="M9 1.5V5h3.5M6 8h4M6 10.5h4"/></svg>'
      chip.appendChild(icon)
    }
    const meta = document.createElement('span')
    meta.className = 'meta'
    const label = document.createElement('b')
    label.textContent = a.name
    meta.appendChild(label)
    const size = fmtSize(a.size)
    if (size) {
      const sub = document.createElement('small')
      sub.textContent = a.kind === 'image' ? `Imagem • ${size}` : a.kind === 'video' ? `Vídeo • ${size}` : size
      meta.appendChild(sub)
    }
    chip.appendChild(meta)
    const x = document.createElement('button')
    x.textContent = '×'
    x.title = 'Remover'
    x.addEventListener('click', () => {
      const [removed] = attachments.splice(i, 1)
      if (removed?.preview) {
        try {
          URL.revokeObjectURL(removed.preview)
        } catch {
          // ignora
        }
      }
      renderChips()
      renderModelList()
      refreshSendBtn()
    })
    chip.appendChild(x)
    box.appendChild(chip)
  })
  refreshSendBtn()
}

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'yaml', 'yml', 'xml', 'csv', 'log', 'env', 'ini', 'toml'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi'])

function pushErrorToChat(text: string): void {
  let c = getActiveChat()
  if (!c) {
    newChat()
    c = getActiveChat()
  }
  c?.messages.push({ role: 'error', content: text })
  saveState()
  renderChat()
}

function fileToBase64(f: File): Promise<string> {
  return f.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf)
    let bin = ''
    const CHUNK = 32768
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(bin)
  })
}

function makeThumb(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const max = 320
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d')?.drawImage(img, 0, 0, w, h)
        resolve(c.toDataURL('image/jpeg', 0.7))
      } catch {
        reject(new Error('thumb'))
      }
    }
    img.onerror = () => reject(new Error('thumb'))
    img.src = src
  })
}

async function handleFiles(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files).slice(0, 3 - attachments.length)
  for (const f of arr) {
    const ext = (f.name.split('.').pop() ?? '').toLowerCase()
    const fpath = (f as unknown as { path?: string }).path
    const isImage = f.type.startsWith('image/') || IMAGE_EXT.has(ext)
    const isVideo = f.type.startsWith('video/') || VIDEO_EXT.has(ext)
    if (isImage || isVideo) {
      if (f.size > 25 * 1024 * 1024) {
        pushErrorToChat(`Erro: "${f.name}" é grande demais (máx 25 MB).`)
        continue
      }
      // preview imediato, sem precisar de caminho em disco
      let preview: string | undefined
      let thumb: string | undefined
      if (!isVideo) {
        try {
          preview = URL.createObjectURL(f)
          thumb = await makeThumb(preview).catch(() => undefined)
        } catch {
          preview = undefined
        }
      }
      // garante um caminho real pro envio (cola/arrasto nem sempre tem)
      let dest = fpath
      if (!dest) {
        try {
          dest = await window.assistant.saveUpload(f.name || 'imagem', await fileToBase64(f))
        } catch {
          if (preview) {
            try {
              URL.revokeObjectURL(preview)
            } catch {
              // ignora
            }
          }
          pushErrorToChat(`Erro: não consegui preparar "${f.name || 'a imagem'}" para envio. Tente selecionar o arquivo pela pasta.`)
          continue
        }
      }
      attachments.push({ name: f.name || 'imagem', path: dest, preview, thumb, size: f.size, kind: isVideo ? 'video' : 'image' })
      continue
    }
    if (!TEXT_EXT.has(ext) && !f.type.startsWith('text/')) {
      // tenta ler mesmo assim se for pequeno
      if (f.size > 200_000) continue
    }
    try {
      const content = (await f.text()).slice(0, 20000)
      attachments.push({ name: f.name, content, size: f.size, kind: 'text' })
    } catch {
      // ignora
    }
  }
  ensureCapableModel()
  renderChips()
  renderModelList()
  hidePopups()
  ;($('#input') as HTMLTextAreaElement).focus()
}

function initMic(): void {
  const btn = document.querySelector<HTMLButtonElement>('#btn-mic')
  if (!btn) return
  const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
  if (!SR) {
    btn.style.display = 'none'
    return
  }
  btn.addEventListener('click', () => {
    if (recognition) {
      recognition.stop()
      return
    }
    recognition = new SR()
    recognition.lang = 'pt-BR'
    recognition.interimResults = false
    btn.classList.add('rec')
    recognition.onresult = (e: any): void => {
      const text = e.results?.[0]?.[0]?.transcript ?? ''
      const input = $('#input') as HTMLTextAreaElement
      input.value = `${input.value}${input.value ? ' ' : ''}${text}`.trim()
      autosize()
      refreshSendBtn()
    }
    recognition.onend = (): void => {
      recognition = null
      btn.classList.remove('rec')
    }
    recognition.onerror = (): void => {
      recognition = null
      btn.classList.remove('rec')
    }
    try {
      recognition.start()
    } catch {
      recognition = null
      btn.classList.remove('rec')
    }
  })
}

function init(): void {
  loadState()
  if (chats.length > 0 && !activeChatId) activeChatId = chats[0].id

  const input = $('#input') as HTMLTextAreaElement
  const newBtn = $('#new-chat') as HTMLButtonElement
  const search = $('#search') as HTMLInputElement
  const searchBtn = $('#btn-search') as HTMLButtonElement
  const attachBtn = $('#btn-attach') as HTMLButtonElement
  const modelBtn = $('#btn-model') as HTMLButtonElement
  const fileInput = $('#file-input') as HTMLInputElement

  newBtn.addEventListener('click', newChat)
  $('#send').addEventListener('click', () => void handleSend())
  $('#user-card').addEventListener('click', () => {
    if (appConfig) openSetup(true)
  })
  $('#setup-pick').addEventListener('click', async () => {
    try {
      const picked = await window.assistant.pickFolder()
      if (picked) {
        $('#setup-folder').textContent = picked
        $('#setup-folder').title = picked
      }
    } catch {
      // ignora
    }
  })
  $('#setup-save').addEventListener('click', () => void saveSetup())
  ;($('#setup-name') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveSetup()
    }
  })
  $('#setup-overlay').addEventListener('click', (e) => {
    if (setupEditing && e.target === $('#setup-overlay')) closeSetup()
  })
  $('#win-min').addEventListener('click', () => void window.windowControls.minimize())
  $('#win-max').addEventListener('click', () => void window.windowControls.toggleMaximize())
  $('#win-close').addEventListener('click', () => void window.windowControls.close())
  window.windowControls.onMaxChanged((maximized) => {
    const b = $('#win-max')
    b.textContent = maximized ? '❐' : '☐'
    b.title = maximized ? 'Restaurar' : 'Maximizar'
  })
  $('#sidebar-toggle').addEventListener('click', () => {
    const sb = $('#sidebar')
    sb.style.display = sb.style.display === 'none' ? '' : 'none'
  })
  $('#status-retry').addEventListener('click', () => void initModels())
  $('#model-reload').addEventListener('click', (e) => {
    e.stopPropagation()
    void initModels()
  })
  search.addEventListener('input', () => renderHistory(search.value))

  searchBtn.addEventListener('click', () => {
    if (searchArmed) disarmSearch()
    else armSearch()
    ;($('#input') as HTMLTextAreaElement).focus()
  })

  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    $('#model-menu').classList.add('hidden')
    $('#attach-menu').classList.toggle('hidden')
  })

  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    $('#attach-menu').classList.add('hidden')
    $('#model-menu').classList.toggle('hidden')
  })

  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (!t.closest('#composer')) hidePopups()
  })

  document.querySelectorAll<HTMLButtonElement>('#attach-menu .popup-item').forEach((b) => {
    b.addEventListener('click', () => {
      const kind = b.getAttribute('data-attach')
      if (kind === 'search') {
        armSearch()
        return
      }
      if (kind === 'context') {
        const cur = input.value
        input.value = cur ? `${cur}\n[cole o contexto aqui]\n` : '[cole o contexto aqui]\n'
        autosize()
        refreshSendBtn()
        input.focus()
        hidePopups()
        return
      }
      fileInput.value = ''
      fileInput.click()
    })
  })

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) void handleFiles(fileInput.files)
  })

  input.addEventListener('input', () => {
    autosize()
    refreshSendBtn()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  })
  input.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files
    if (files && files.length > 0) void handleFiles(files)
  })

  document.querySelectorAll<HTMLButtonElement>('.suggestion').forEach((b) => {
    b.addEventListener('click', () => {
      void handleSend(b.getAttribute('data-prompt') ?? b.textContent ?? '')
    })
  })

  initMic()
  renderHistory('')
  renderChat()
  renderChips()
  autosize()
  refreshSendBtn()
  updateModelLabel()
  renderModelList()
  updateVariantUI()
  void initSetup()
  void initModels()
}

window.addEventListener('DOMContentLoaded', init)
