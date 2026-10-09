import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename } from 'path'
import { tmpdir, homedir } from 'os'
import { mkdir, writeFile, readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  listModels,
  createSession,
  sendMessage,
  getSessionMessages,
  deleteSession,
  interruptSession,
  switchSessionModel,
  abortWait,
  isUpstreamError,
  FALLBACK_MODELS,
  webSearch,
  setWorkdir,
  getStatus
} from './opencode-backend'

export interface AppConfig {
  userName: string
  chatsDir: string
  setupDone: boolean
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function defaultChatsDir(): string {
  return join(homedir(), 'OpenBean')
}

async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    const userName = String(parsed.userName ?? '').trim()
    const chatsDir = String(parsed.chatsDir ?? '').trim() || defaultChatsDir()
    return { userName, chatsDir, setupDone: userName.length > 0 }
  } catch {
    return { userName: '', chatsDir: defaultChatsDir(), setupDone: false }
  }
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'OpenBean',
    frame: false,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:max-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:max-changed', false)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.openbean.app')

  // pasta dos chats (tela inicial) vira o diretório do OpenCode
  try {
    const cfg = await loadConfig()
    setWorkdir(cfg.chatsDir)
  } catch {
    // segue com o padrão
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Controles da janela (header customizado, janela frameless)
  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Assistente IA via OpenCode local
  ipcMain.handle('assistant:get-status', async () => {
    try {
      return { ok: true, ...(await getStatus()) }
    } catch (err: any) {
      console.error('[assistant:get-status]', err?.message)
      return { ok: false, error: err?.message ?? String(err) }
    }
  })
  ipcMain.handle('assistant:list-models', async () => {
    try {
      const models = await listModels()
      console.log(`[assistant:list-models] ${models.length} modelos`)
      return models
    } catch (err: any) {
      console.error('[assistant:list-models]', err?.message)
      throw err
    }
  })
  ipcMain.handle('assistant:create-session', async (_e, title: string, model?: string, variant?: string) => {
    return await createSession(title, model, variant)
  })
  ipcMain.handle('assistant:switch-model', async (_e, sessionID: string, model: string, variant?: string) => {
    await switchSessionModel(sessionID, model, variant)
    return true
  })
  ipcMain.handle(
    'assistant:send',
    async (
      _e,
      sessionID: string,
      text: string,
      opts?: {
        title?: string
        model?: string
        variant?: string
        mode?: 'chat' | 'agent'
        files?: { uri: string; name?: string }[]
      }
    ) => {
      const variant = opts?.variant
      const requested = opts?.model
      let prompt = text
      if (opts?.mode === 'agent') {
        prompt = `[Modo agente: use as ferramentas e o contexto do projeto quando for útil para resolver a tarefa.]\n\n${text}`
      }
      // tenta o modelo pedido e, se o provedor estiver fora do ar, cai para reservas
      const candidates = [...new Set([requested, ...FALLBACK_MODELS].filter(Boolean) as string[])]
      let sid = sessionID
      let lastErr: unknown = null
      let attempt = 0
      for (const cand of candidates) {
        // variante só no modelo pedido; reservas vão no padrão pra maximizar chance
        const v = cand === requested ? variant : undefined
        try {
          if (!sid) {
            sid = await createSession(opts?.title ?? text.slice(0, 60), cand, v)
          } else if (attempt === 0 ? !!requested : true) {
            // 1ª tentativa: mantém comportamento original (só troca se modelo pedido).
            // failover: troca a sessão para a reserva antes de enviar.
            try {
              await switchSessionModel(sid, cand, v)
            } catch (err: any) {
              console.warn('[assistant:send] switchModel falhou:', err?.message)
            }
          }
          const res = await sendMessage(sid, prompt, opts?.files)
          if (cand !== requested) {
            console.log(`[assistant:send] failover: ${requested} -> ${cand}`)
          }
          return { ...res, model: cand }
        } catch (err: any) {
          if (!isUpstreamError(err)) throw err
          console.warn(`[assistant:send] upstream falhou em ${cand}, tentando próximo`)
          lastErr = err
        }
        attempt++
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error('Todos os modelos estão indisponíveis no momento. Tente de novo em instantes.')
    }
  )
  ipcMain.handle('assistant:get-messages', async (_e, sessionID: string) => {
    return await getSessionMessages(sessionID)
  })
  ipcMain.handle('assistant:delete-session', async (_e, sessionID: string) => {
    await deleteSession(sessionID)
    return true
  })
  ipcMain.handle('assistant:interrupt', async (_e, sessionID: string) => {
    // libera a espera local de imediato e interrompe a geração no servidor
    abortWait(sessionID)
    if (sessionID) {
      try {
        await interruptSession(sessionID)
      } catch (err: any) {
        console.warn('[assistant:interrupt]', err?.message)
      }
    }
    return true
  })
  ipcMain.handle('assistant:websearch', async (_e, query: string) => {
    try {
      return await webSearch(query)
    } catch (err: any) {
      console.error('[assistant:websearch]', err?.message)
      throw err
    }
  })
  ipcMain.handle('assistant:save-upload', async (_e, name: string, base64: string) => {
    // salva mídia colada/arrastada (sem caminho em disco) num temp e devolve o caminho
    const dir = join(tmpdir(), 'meu-assistente-uploads')
    await mkdir(dir, { recursive: true })
    const safe = basename(String(name || 'arquivo')).replace(/[^\w.\-() ]+/g, '_').slice(0, 80) || 'arquivo'
    const dest = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`)
    await writeFile(dest, Buffer.from(base64, 'base64'))
    return dest
  })
  ipcMain.handle('assistant:open-file', async (_e, filePath: string) => {
    if (typeof filePath === 'string' && filePath.length > 0) {
      await shell.openPath(filePath)
    }
    return true
  })
  ipcMain.handle('assistant:get-config', async () => {
    const cfg = await loadConfig()
    return { ...cfg, version: app.getVersion() }
  })
  ipcMain.handle('assistant:set-config', async (_e, input: { userName?: string; chatsDir?: string }) => {
    const userName = String(input?.userName ?? '').trim().slice(0, 60)
    if (!userName) throw new Error('Informe seu nome para continuar.')
    const chatsDir = String(input?.chatsDir ?? '').trim() || defaultChatsDir()
    await mkdir(chatsDir, { recursive: true })
    const cfg: AppConfig = { userName, chatsDir, setupDone: true }
    await writeFile(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
    setWorkdir(chatsDir)
    return { ...cfg, version: app.getVersion() }
  })
  ipcMain.handle('assistant:pick-folder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const current = (await loadConfig().catch(() => null))?.chatsDir ?? defaultChatsDir()
    const opts = {
      title: 'Escolher pasta dos chats',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
