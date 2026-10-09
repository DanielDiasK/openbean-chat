import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const execFileAsync = promisify(execFile)

const OPENCODE_TIMEOUT_MS = 600_000

// pasta onde os chats/sessões vivem (configurável na tela inicial)
let workdir = homedir() || process.cwd()

export function setWorkdir(dir: string): void {
  if (typeof dir === 'string' && dir.trim().length > 0) workdir = dir
}

let cachedBin: string | null = null

function candidateBins(): string[] {
  const list: string[] = []
  if (process.env.OPENCODE_BIN && process.env.OPENCODE_BIN.trim()) {
    list.push(process.env.OPENCODE_BIN.trim())
  }
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      list.push(join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'))
    }
    if (process.env.LOCALAPPDATA) {
      list.push(join(process.env.LOCALAPPDATA, 'opencode', 'opencode.exe'))
    }
    list.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'))
  } else {
    list.push('/usr/local/bin/opencode')
    list.push('/opt/homebrew/bin/opencode')
    list.push(join(homedir(), '.opencode', 'bin', 'opencode'))
    list.push(join(homedir(), '.local', 'bin', 'opencode'))
    list.push('opencode')
  }
  return [...new Set(list)]
}

async function tryBin(bin: string): Promise<boolean> {
  // sem shell: evita que o cmd.exe quebre o JSON do -d
  if (bin !== 'opencode' && !existsSync(bin)) return false
  try {
    await execFileAsync(bin, ['--version'], { timeout: 15_000, shell: false })
    return true
  } catch {
    return false
  }
}

export async function resolveBin(): Promise<string> {
  if (cachedBin) return cachedBin
  for (const bin of candidateBins()) {
    if (await tryBin(bin)) {
      cachedBin = bin
      console.log(`[opencode] binário em uso: ${bin}`)
      return bin
    }
  }
  throw new Error(
    'OpenCode não encontrado. Instale com "npm i -g @opencode/cli" ou defina a variável OPENCODE_BIN com o caminho do executável.'
  )
}

export async function getStatus(): Promise<{ bin: string; version: string; cwd: string }> {
  const bin = await resolveBin()
  const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 15_000, shell: false })
  return { bin, version: stdout.trim(), cwd: workdir }
}

async function runApi(operation: string, data?: unknown, params?: Record<string, string>): Promise<any> {
  const bin = await resolveBin()
  const args = ['api', operation]
  if (data !== undefined) {
    args.push('-d', JSON.stringify(data))
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      args.push('--param', `${k}=${v}`)
    }
  }
  return execApi(bin, args)
}

function execApi(bin: string, args: string[], signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: OPENCODE_TIMEOUT_MS,
        signal,
        shell: false,
        maxBuffer: 32 * 1024 * 1024,
        cwd: workdir
      },
      (err, stdout) => {
        if (err) {
          const stdoutText = (err as any)?.stdout ? String((err as any).stdout).slice(0, 4000) : ''
          const stderrText = (err as any)?.stderr ? String((err as any).stderr).slice(0, 2000) : ''
          let detail = ''
          try {
            const parsed = JSON.parse(stdoutText.trim())
            detail = String(parsed.message ?? parsed.error ?? stdoutText)
          } catch {
            detail = stdoutText || stderrText || err?.message || 'erro desconhecido'
          }
          if (/timed out|timeout/i.test(String(err?.message ?? ''))) {
            reject(new Error('Tempo esgotado aguardando o OpenCode. Tente novamente.'))
            return
          }
          reject(Object.assign(new Error(detail), { aborted: (err as any)?.name === 'AbortError' }))
          return
        }
        const trimmed = (stdout ?? '').trim()
        if (!trimmed) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(trimmed))
        } catch {
          reject(new Error('Resposta inválida do OpenCode.'))
        }
      }
    )
  })
}

const waitControllers = new Map<string, AbortController>()

async function waitForIdle(sessionID: string): Promise<void> {
  const bin = await resolveBin()
  const controller = new AbortController()
  waitControllers.set(sessionID, controller)
  try {
    await execApi(bin, ['api', 'experimental.session.wait', '-d', '{}', '--param', `sessionID=${sessionID}`], controller.signal)
  } finally {
    if (waitControllers.get(sessionID) === controller) waitControllers.delete(sessionID)
  }
}

export function abortWait(sessionID: string): void {
  waitControllers.get(sessionID)?.abort()
}

export interface ChatModel {
  id: string // "opencode/big-pickle"
  providerID: string
  modelID: string
  name: string
  variants: string[]
  capabilities?: { input: string[]; tools?: boolean }
}

function toChatModel(entry: any): ChatModel {
  const providerID = entry.providerID ?? 'opencode'
  const modelID = entry.modelID ?? entry.id
  const rawVariants: any[] = Array.isArray(entry.variants) ? entry.variants : []
  const variants = rawVariants
    .map((v) => (typeof v === 'string' ? v : v?.id))
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  const rawInput = entry?.capabilities?.input
  const rawTools = entry?.capabilities?.tools
  const capabilities =
    Array.isArray(rawInput) || typeof rawTools === 'boolean'
      ? {
          input: Array.isArray(rawInput) ? rawInput.filter((x): x is string => typeof x === 'string') : [],
          ...(typeof rawTools === 'boolean' ? { tools: rawTools } : {})
        }
      : undefined
  return {
    id: `${providerID}/${modelID}`,
    providerID,
    modelID,
    name: entry.name ?? modelID,
    variants,
    capabilities
  }
}

function parseModelRef(model: string): { providerID: string; id: string; variant?: string } {
  const hashIdx = model.indexOf('#')
  const variant = hashIdx >= 0 ? model.slice(hashIdx + 1) || undefined : undefined
  const core = hashIdx >= 0 ? model.slice(0, hashIdx) : model
  const slashIdx = core.indexOf('/')
  if (slashIdx >= 0) {
    return { providerID: core.slice(0, slashIdx), id: core.slice(slashIdx + 1), variant }
  }
  return { providerID: 'opencode', id: core, variant }
}

async function listModelsViaApi(): Promise<ChatModel[]> {
  const res = await runApi('model.list')
  const data = res?.data ?? []
  if (!Array.isArray(data) || data.length === 0) throw new Error('OpenCode retornou 0 modelos.')
  return data.map(toChatModel)
}

async function listModelsViaCli(): Promise<ChatModel[]> {
  const bin = await resolveBin()
  const { stdout } = await execFileAsync(bin, ['models'], {
    timeout: 30_000,
    shell: false,
    cwd: workdir
  })
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) throw new Error('Nenhum modelo retornado pelo CLI.')
  return lines.map((line) => {
    // formato "opencode/big-pickle"
    const slash = line.indexOf('/')
    if (slash >= 0) {
      const providerID = line.slice(0, slash)
      const modelID = line.split('#')[0].slice(slash + 1)
      return {
        id: `${providerID}/${modelID}`,
        providerID,
        modelID,
        name: modelID,
        variants: [] as string[],
        capabilities: undefined
      }
    }
    return {
      id: `opencode/${line}`,
      providerID: 'opencode',
      modelID: line,
      name: line,
      variants: [] as string[],
      capabilities: undefined
    }
  })
}

export async function listModels(): Promise<ChatModel[]> {
  try {
    return await listModelsViaApi()
  } catch (apiErr: any) {
    console.warn('[opencode] model.list falhou, tentando "opencode models":', apiErr?.message)
    try {
      return await listModelsViaCli()
    } catch (cliErr: any) {
      throw new Error(`Falha ao listar modelos: ${apiErr?.message ?? apiErr} | fallback: ${cliErr?.message ?? cliErr}`)
    }
  }
}

export async function createSession(title: string, model?: string, variant?: string): Promise<string> {
  const body: any = {}
  if (title) body.title = title.slice(0, 80)
  if (model) {
    const ref = parseModelRef(model)
    const v = variant ?? ref.variant
    body.model = v
      ? { providerID: ref.providerID, id: ref.id, variant: v }
      : { providerID: ref.providerID, id: ref.id }
  }
  const res = await runApi('session.create', body)
  const id = res?.data?.id
  if (!id) throw new Error('OpenCode não retornou sessionID')
  return id as string
}

export async function switchSessionModel(sessionID: string, model: string, variant?: string): Promise<void> {
  const ref = parseModelRef(model)
  const v = variant ?? ref.variant
  const payload = v
    ? { model: { providerID: ref.providerID, id: ref.id, variant: v } }
    : { model: { providerID: ref.providerID, id: ref.id } }
  await runApi('session.switchModel', payload, { sessionID })
}

export function isUpstreamError(err: any): boolean {
  const msg = String(err?.message ?? err ?? '')
  return /upstream|unavailable|503|endpoint|failed|drain|overloaded|rate.?limit|429/i.test(msg)
}

// modelos de reserva quando o selecionado estiver fora do ar
export const FALLBACK_MODELS = ['opencode/big-pickle', 'opencode/space-bunny-free', 'opencode/exo-free']

export interface SendResult {
  sessionID: string
  text: string
  reasoning?: string
}

function extractAssistantText(listRes: any, afterMs?: number): { text: string; reasoning?: string } {
  const items: any[] = listRes?.data ?? []
  const assistants = items.filter((m) => m?.type === 'assistant')
  assistants.sort((a, b) => (b?.time?.created ?? 0) - (a?.time?.created ?? 0))
  for (const a of assistants) {
    if (afterMs && (a?.time?.created ?? 0) < afterMs - 5000) continue
    const parts: any[] = a?.content ?? []
    const texts = parts.filter((p) => p?.type === 'text' && typeof p?.text === 'string').map((p) => p.text)
    const reasoning = parts
      .filter((p) => p?.type === 'reasoning' && typeof p?.text === 'string')
      .map((p) => p.text)
      .join('\n')
    if (texts.length > 0) {
      return { text: texts.join('\n'), reasoning: reasoning || undefined }
    }
  }
  const idle = items.find((m) => m?.type === 'idle')
  if (idle?.outcome === 'failed') {
    throw new Error('O modelo falhou (upstream indisponível). Troque de modelo ou tente de novo.')
  }
  throw new Error('Nenhuma resposta do assistente encontrada na sessão.')
}

export interface PromptFile {
  uri: string
  name?: string
}

export function toFileUri(p: string): string {
  if (/^file:\/\//i.test(p)) return p
  const fwd = p.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(fwd)) return `file:///${fwd}`
  if (fwd.startsWith('/')) return `file://${fwd}`
  return p
}

export async function sendMessage(sessionID: string, text: string, files?: PromptFile[]): Promise<SendResult> {
  const before = Date.now()
  const body: any = { text }
  if (files && files.length > 0) {
    body.files = files.map((f) => ({ uri: toFileUri(f.uri), name: f.name ?? undefined }))
  }
  await runApi('session.prompt', body, { sessionID })
  await waitForIdle(sessionID)
  const list = await runApi('session.message.list', undefined, { sessionID })
  const { text: answer, reasoning } = extractAssistantText(list, before)
  return { sessionID, text: answer, reasoning }
}

export async function interruptSession(sessionID: string): Promise<void> {
  try {
    await runApi('session.interrupt', {}, { sessionID })
  } catch (err) {
    console.warn('[opencode] interrupt falhou:', (err as Error)?.message)
  }
}

export async function getSessionMessages(sessionID: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const list = await runApi('session.message.list', undefined, { sessionID })
  const items: any[] = list?.data ?? []
  items.sort((a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0))
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of items) {
    if (m?.type === 'user' && typeof m?.text === 'string') {
      out.push({ role: 'user', content: m.text })
    } else if (m?.type === 'assistant') {
      const parts: any[] = m?.content ?? []
      const text = parts
        .filter((p) => p?.type === 'text' && typeof p?.text === 'string')
        .map((p) => p.text)
        .join('\n')
      if (text) out.push({ role: 'assistant', content: text })
    }
  }
  return out
}

export interface SearchResult {
  url: string
  title: string
  content: string
}

export async function listSearchProviders(): Promise<{ id: string; name: string }[]> {
  const res = await runApi('websearch.providers')
  return (res?.data ?? []) as { id: string; name: string }[]
}

export async function webSearch(
  query: string,
  providerID?: string
): Promise<{ providerID: string; results: SearchResult[] }> {
  let provider = providerID
  if (!provider) {
    const providers = await listSearchProviders()
    if (providers.length === 0) throw new Error('Nenhum provedor de pesquisa web configurado no OpenCode.')
    provider = providers[0].id
  }
  const res = await runApi('websearch.query', { query, providerID: provider })
  const raw: any[] = res?.data?.results ?? []
  const results = raw
    .filter((r) => r?.url)
    .slice(0, 5)
    .map((r) => ({
      url: String(r.url),
      title: String(r.title ?? r.url),
      content: String(r.content ?? '').slice(0, 1200)
    }))
  return { providerID: provider, results }
}

export async function deleteSession(sessionID: string): Promise<void> {
  try {
    await runApi('session.delete', undefined, { sessionID })
  } catch {
    // nem toda versão tem delete; sessão local é descartada de qualquer forma
  }
}
