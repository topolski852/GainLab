import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Legacy
  saveSession: (data: string) => ipcRenderer.invoke('save-session', data),
  loadSession: () => ipcRenderer.invoke('load-session'),
  // Project
  openProject: (): Promise<{ success: boolean; filePath?: string; data?: string }> =>
    ipcRenderer.invoke('project:open'),
  openProjectByPath: (filePath: string): Promise<{ success: boolean; notFound?: boolean; filePath?: string; data?: string }> =>
    ipcRenderer.invoke('project:open-path', filePath),
  saveProject: (filePath: string, data: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('project:save', filePath, data),
  saveProjectAs: (data: string, name: string): Promise<{ success: boolean; filePath?: string }> =>
    ipcRenderer.invoke('project:save-as', data, name),
  getRecentProjects: (): Promise<{ filePath: string; name: string; motorCount: number; updatedAt: string }[]> =>
    ipcRenderer.invoke('recent:get'),
  addRecentProject: (entry: { filePath: string; name: string; motorCount: number; updatedAt: string }): Promise<void> =>
    ipcRenderer.invoke('recent:add', entry),
  removeRecentProject: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('recent:remove', filePath),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
