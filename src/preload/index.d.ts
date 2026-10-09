import { ElectronAPI } from '@electron-toolkit/preload'
import type { AssistantAPI, WindowControlsAPI } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    assistant: AssistantAPI
    windowControls: WindowControlsAPI
  }
}
