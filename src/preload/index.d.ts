import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      saveSession: (data: string) => Promise<{ success: boolean; filePath?: string }>
      loadSession: () => Promise<{ success: boolean; data?: string }>
    }
  }
}
