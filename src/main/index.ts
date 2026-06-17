import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import path from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import fs from 'fs'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.team1507.gainlab')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  createWindow()
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Legacy session IPC (kept for backwards compat) ────────────────────────────

ipcMain.handle('save-session', async (_event, data: string) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save GainLab Session',
    defaultPath: 'gainlab-session.json',
    filters: [{ name: 'GainLab Session', extensions: ['json'] }]
  })
  if (filePath) {
    fs.writeFileSync(filePath, data, 'utf-8')
    return { success: true, filePath }
  }
  return { success: false }
})

ipcMain.handle('load-session', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Open GainLab Session',
    filters: [{ name: 'GainLab Session', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (filePaths[0]) {
    const data = fs.readFileSync(filePaths[0], 'utf-8')
    return { success: true, data }
  }
  return { success: false }
})

// ── Project IPC ───────────────────────────────────────────────────────────────

interface RecentEntry {
  filePath: string
  name: string
  motorCount: number
  updatedAt: string
}

interface Settings {
  recentProjects: RecentEntry[]
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'gainlab-settings.json')
}

function readSettings(): Settings {
  try {
    const p = settingsPath()
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) as Settings
  } catch {}
  return { recentProjects: [] }
}

function writeSettings(s: Settings): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf-8')
  } catch {}
}

ipcMain.handle('project:open', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Open GainLab Project',
    filters: [{ name: 'GainLab Project', extensions: ['gainlab'] }],
    properties: ['openFile']
  })
  if (!filePaths[0]) return { success: false }
  try {
    const data = fs.readFileSync(filePaths[0], 'utf-8')
    return { success: true, filePath: filePaths[0], data }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

ipcMain.handle('project:save', async (_event, filePath: string, data: string) => {
  try {
    fs.writeFileSync(filePath, data, 'utf-8')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

ipcMain.handle('project:save-as', async (_event, data: string, suggestedName: string) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save GainLab Project',
    defaultPath: (suggestedName || 'project') + '.gainlab',
    filters: [{ name: 'GainLab Project', extensions: ['gainlab'] }]
  })
  if (!filePath) return { success: false }
  try {
    fs.writeFileSync(filePath, data, 'utf-8')
    return { success: true, filePath }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

ipcMain.handle('project:open-path', (_event, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) return { success: false, notFound: true }
    const data = fs.readFileSync(filePath, 'utf-8')
    return { success: true, filePath, data }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

ipcMain.handle('recent:get', () => readSettings().recentProjects)

ipcMain.handle('recent:add', (_event, entry: RecentEntry) => {
  const s = readSettings()
  s.recentProjects = [
    entry,
    ...s.recentProjects.filter(r => r.filePath !== entry.filePath)
  ].slice(0, 10)
  writeSettings(s)
})

ipcMain.handle('recent:remove', (_event, filePath: string) => {
  const s = readSettings()
  s.recentProjects = s.recentProjects.filter(r => r.filePath !== filePath)
  writeSettings(s)
})
