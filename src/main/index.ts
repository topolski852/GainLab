import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
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
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// IPC: save session to disk
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

// IPC: load session from disk
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
