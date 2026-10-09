import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface ChatModel {
  id: string
  providerID: string
  modelID: string
  name: string
  variants: string[]
  capabilities?: { input: string[] }
}

export interface AppConfig {
  userName: string
  chatsDir: string
  setupDone: boolean
  version: string
}

export interface SendOptions {
  title?: string
  model?: string
  variant?: string
  mode?: 'chat' | 'agent'
  files?: { uri: string; name?: string }[]
}

export interface SearchResult {
  url: string
  title: string
  content: string
}

export interface WebSearchResponse {
  providerID: string
  results: SearchResult[]
}

export interface SendResult {
  sessionID: string
  text: string
  reasoning?: string
  model?: string
}

// Custom APIs for renderer
const assistant = {
  getStatus: (): Promise<{ ok: boolean; bin?: string; version?: string; cwd?: string; error?: string }> =>
    ipcRenderer.invoke('assistant:get-status'),
  listModels: (): Promise<ChatModel[]> => ipcRenderer.invoke('assistant:list-models'),
  createSession: (title: string, model?: string, variant?: string): Promise<string> =>
    ipcRenderer.invoke('assistant:create-session', title, model, variant),
  switchModel: (sessionID: string, model: string, variant?: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:switch-model', sessionID, model, variant),
  send: (sessionID: string, text: string, opts?: SendOptions): Promise<SendResult> =>
    ipcRenderer.invoke('assistant:send', sessionID, text, opts),
  getMessages: (sessionID: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> =>
    ipcRenderer.invoke('assistant:get-messages', sessionID),
  deleteSession: (sessionID: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:delete-session', sessionID),
  interrupt: (sessionID: string): Promise<boolean> => ipcRenderer.invoke('assistant:interrupt', sessionID),
  saveUpload: (name: string, base64: string): Promise<string> =>
    ipcRenderer.invoke('assistant:save-upload', name, base64),
  openFile: (filePath: string): Promise<boolean> => ipcRenderer.invoke('assistant:open-file', filePath),
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('assistant:get-config'),
  setConfig: (input: { userName: string; chatsDir: string }): Promise<AppConfig> =>
    ipcRenderer.invoke('assistant:set-config', input),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('assistant:pick-folder'),
  websearch: (query: string): Promise<WebSearchResponse> => ipcRenderer.invoke('assistant:websearch', query)
}

// Controles da janela frameless
const windowControls = {
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  onMaxChanged: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('window:max-changed', listener as never)
    return () => ipcRenderer.removeListener('window:max-changed', listener as never)
  }
}

export type WindowControlsAPI = typeof windowControls

export type AssistantAPI = typeof assistant

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', {})
    contextBridge.exposeInMainWorld('assistant', assistant)
    contextBridge.exposeInMainWorld('windowControls', windowControls)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = {}
  // @ts-ignore (define in dts)
  window.assistant = assistant
  // @ts-ignore (define in dts)
  window.windowControls = windowControls
}
