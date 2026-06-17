import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      saveSession: (data: string) => Promise<{ success: boolean; filePath?: string }>
      loadSession: () => Promise<{ success: boolean; data?: string }>
      openProject: () => Promise<{ success: boolean; filePath?: string; data?: string }>
      openProjectByPath: (filePath: string) => Promise<{ success: boolean; notFound?: boolean; filePath?: string; data?: string }>
      saveProject: (filePath: string, data: string) => Promise<{ success: boolean }>
      saveProjectAs: (data: string, name: string) => Promise<{ success: boolean; filePath?: string }>
      getRecentProjects: () => Promise<{ filePath: string; name: string; motorCount: number; updatedAt: string }[]>
      addRecentProject: (entry: { filePath: string; name: string; motorCount: number; updatedAt: string }) => Promise<void>
      removeRecentProject: (filePath: string) => Promise<void>
    }
  }
}
