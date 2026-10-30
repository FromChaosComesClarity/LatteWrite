import { app, shell, BrowserWindow, Menu, ipcMain, dialog, session, clipboard, nativeImage } from 'electron'
const IS_MAC = process.platform === 'darwin'
import { join, dirname, resolve, basename, extname, relative, isAbsolute } from 'path'
import { spawn } from 'child_process'
import fs from 'fs'
import AdmZip from 'adm-zip'
import store, { dataPath } from './store.js'
import { startAuthFlow, signOut, isAuthenticated, checkConnection } from './auth.js'
import { syncBundle as gdriveSync, removeRemote as gdriveRemove, renameRemote as gdriveRename, twoWaySync as gdriveTwoWay } from './drive.js'
import { syncBundle as onedriveSync } from './onedrive.js'
import { readBundle } from './bundle.js'
import { saveDocument, mirrorPathFor } from './autosave.js'
import { listRecoverable, restoreFile, listSnapshots } from './recovery.js'
import { exportHTML, exportMarkdown, exportDocx } from './export.js'
import { loadFontCss, fontCatalog } from './fonts.js'
import { available as dictateAvailable, setListening as dictateSet, shutdown as dictateShutdown } from './dictate.js'
import { docsPath } from './paths.js'

const FILTERS = [{ name: 'LatteWrite', extensions: ['latte'] }]

// A .latte passed on the command line (file association / "open with"). Consumed
// once by the renderer on startup.
let initialFile = process.argv.slice(1).find(a => a.endsWith('.latte') && fs.existsSync(a)) || null

// A desktop launcher puts the path in argv; Finder does not — macOS delivers it
// as an `open-file` event, which can arrive before the window exists.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!filePath.endsWith('.latte') || !fs.existsSync(filePath)) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-file', filePath)   // already running: just load it
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } else {
    initialFile = filePath                                // launched by the double-click
  }
})

let mainWindow = null
let saveBoundsOnClose = true

function createWindow() {
  const b = store.get('windowBounds') || {}
  mainWindow = new BrowserWindow({
    width: b.width || 1200,
    height: b.height || 820,
    x: b.x,
    y: b.y,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#17100a',
    // macOS draws its own traffic lights and a window without them reads as
    // broken, so there the frame is only hidden down to an inset title bar and
    // the toolbar's first row pads itself clear of them (see TopBar).
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 15, y: 16 } }
      : { frame: false }),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  if (b.maximized) mainWindow.maximize()

  mainWindow.on('close', () => {
    // Skip during restore so we don't overwrite the just-restored config.
    if (saveBoundsOnClose) store.set('windowBounds', { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() })
  })

  const ses = mainWindow.webContents.session
  ses.setSpellCheckerLanguages(['en-US'])
  ses.setSpellCheckerEnabled(store.get('spellcheck'))

  // Route right-clicks to the renderer so the context menu can be fully themed.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    mainWindow.webContents.send('context-menu', {
      x: params.x, y: params.y,
      misspelledWord: params.misspelledWord,
      suggestions: params.dictionarySuggestions || [],
      isEditable: params.isEditable,
      mediaType: params.mediaType,
      srcURL: params.srcURL,
      canCut: params.editFlags.canCut,
      canCopy: params.editFlags.canCopy,
      canPaste: params.editFlags.canPaste,
      canSelectAll: params.editFlags.canSelectAll
    })
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('window:fullscreen', true))
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('window:fullscreen', false))

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Where documents live and what the top-bar search looks through: beside the
// AppImage on Linux, under $HOME on macOS. See paths.js for why they differ.
function docsDir() {
  try { fs.mkdirSync(docsPath, { recursive: true }) } catch {}
  return docsPath
}

function sanitizeName(name) {
  return (name || '').replace(/[\/\\:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

function addRecent(filePath) {
  const recent = [filePath, ...store.get('recentFiles').filter(f => f !== filePath)].slice(0, 12)
  store.set('recentFiles', recent)
  store.set('currentFile', filePath)
}

// ── Settings ──────────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => store.store)
ipcMain.handle('settings:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch)) store.set(k, v)
  return store.store
})

// ── Auth ──────────────────────────────────────────────────────────────────────
ipcMain.handle('auth:status', () => isAuthenticated())
ipcMain.handle('auth:start', async () => {
  await startAuthFlow()
  await checkDrive(true)
  maybeStartupSync()   // the launch pull a dead sign-in skipped
  return true
})
ipcMain.handle('auth:signout', () => { signOut(); driveCheck = null; return true })

// Launch check: whether the stored Google Drive sign-in actually still works
// (see checkConnection). Run once per launch and shared, so the startup sync
// and the renderer's reconnect prompt act on the same answer. `force` re-runs
// it, for the prompt's RETRY.
let driveCheck = null
function checkDrive(force) {
  if (force || !driveCheck) {
    driveCheck = store.get('syncProvider') === 'gdrive' ? checkConnection() : Promise.resolve({ state: 'off' })
  }
  return driveCheck
}
ipcMain.handle('auth:check', async (_e, force) => {
  const result = await checkDrive(force)
  if (force) maybeStartupSync()
  return result
})

// ── Documents ─────────────────────────────────────────────────────────────────
ipcMain.handle('doc:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: FILTERS })
  if (res.canceled || !res.filePaths[0]) return null
  return openPath(res.filePaths[0])
})

ipcMain.handle('doc:openPath', (_e, filePath) => openPath(filePath))

function openPath(filePath) {
  if (!fs.existsSync(filePath)) return null
  // `legacy` means the bundle still keeps its pictures inline as base64. The
  // renderer answers by marking the history dirty, so the next save rewrites the
  // whole file in the current layout — a one-time migration, no separate pass.
  const { doc, meta, versions, legacy } = readBundle(filePath)
  addRecent(filePath)
  return { filePath, doc, meta, versions, legacy }
}

ipcMain.handle('doc:save', async (_e, { filePath, doc, meta, versions }) => {
  let target = filePath
  if (!target) {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: join(docsDir(), `${meta?.title || 'Untitled'}.latte`),
      filters: FILTERS
    })
    if (res.canceled || !res.filePath) return null
    target = res.filePath
  }
  saveDocument(target, { doc, meta, versions }, store.get('backupsToKeep'), store.get('backupIntervalMs'))
  addRecent(target)

  if (store.get('syncOnSave')) { try { await syncCurrent(target) } catch { /* surfaced via sync:now */ } }
  return { filePath: target }
})

ipcMain.handle('doc:saveAs', async (_e, { doc, meta, versions }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: join(docsDir(), `${meta?.title || 'Untitled'}.latte`),
    filters: FILTERS
  })
  if (res.canceled || !res.filePath) return null
  saveDocument(res.filePath, { doc, meta, versions }, store.get('backupsToKeep'), store.get('backupIntervalMs'))
  addRecent(res.filePath)
  return { filePath: res.filePath }
})

// Persist a document (e.g. a version snapshot) to a fresh, non-colliding file in
// the latte folder, then open it in a brand-new window (a second instance) — so
// an old version can be edited on its own without touching the current document.
// The .app bundle we are running from, or null anywhere else.
function appBundle() {
  if (!IS_MAC || !app.isPackaged) return null
  const bundle = resolve(process.execPath, '..', '..', '..')   // …/X.app/Contents/MacOS/X
  return bundle.endsWith('.app') ? bundle : null
}

// A second, fully independent instance. On macOS `open -n` is the only way to
// ask for another copy of a bundle — spawning the inner executable gets you a
// process the window server folds back into the first one.
function launchInstance(file) {
  const bundle = appBundle()
  const exe = process.env.APPIMAGE
  try {
    if (bundle) spawn('open', ['-n', '-a', bundle, ...(file ? [file] : [])], { detached: true, stdio: 'ignore' }).unref()
    else if (exe) spawn(exe, file ? [file] : [], { detached: true, stdio: 'ignore' }).unref()
    else spawn(process.execPath, [...process.argv.slice(1), ...(file ? [file] : [])], { detached: true, stdio: 'ignore' }).unref()
  } catch { /* nothing to do; the current window keeps working */ }
}

ipcMain.handle('doc:openInNewWindow', (_e, { doc, meta }) => {
  const base = sanitizeName(meta?.title) || 'Untitled'
  let target = join(docsDir(), `${base}.latte`)
  for (let i = 2; fs.existsSync(target); i++) target = join(docsDir(), `${base} (${i}).latte`)
  saveDocument(target, { doc, meta, versions: [] }, store.get('backupsToKeep'), store.get('backupIntervalMs'))
  addRecent(target)
  launchInstance(target)
  return { filePath: target }
})

ipcMain.handle('doc:recent', () => store.get('recentFiles').filter(f => fs.existsSync(f)))

// A .latte the app was launched with (double-click / "open with"); one-shot.
ipcMain.handle('doc:initialFile', () => {
  const f = initialFile
  initialFile = null
  return f && fs.existsSync(f) ? f : null
})

// Search the latte folder (and its subdirectories) by filename. Recursing lets
// Save As targets that land in a latte subfolder stay findable; .backups and
// other dot-folders are skipped.
ipcMain.handle('docs:search', (_e, query) => {
  const dir = docsDir()
  const q = (query || '').toLowerCase()
  try {
    return fs.readdirSync(dir, { recursive: true })
      .map(f => String(f).split('\\').join('/'))
      .filter(f => f.toLowerCase().endsWith('.latte'))
      .filter(f => !/(^|\/)\./.test(f))   // exclude hidden dirs like .backups
      .filter(f => !q || f.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 40)
      .map(f => ({ name: f.replace(/\.latte$/i, ''), path: join(dir, f) }))
  } catch { return [] }
})

ipcMain.handle('doc:rename', async (_e, { filePath, name, soft }) => {
  const clean = sanitizeName(name) || 'Untitled'
  let target = join(dirname(filePath), clean + '.latte')
  if (target === filePath) return { filePath }
  if (fs.existsSync(target)) {
    if (soft) return { filePath } // auto-naming: don't collide, keep the current name
    target = join(dirname(filePath), `${clean}_${Date.now()}.latte`)
  }
  fs.renameSync(filePath, target)
  // Carry the mirror twin and the snapshot history across, or the old ones would
  // look like a document that vanished and clutter the recovery list.
  try {
    const from = mirrorPathFor(filePath)
    if (fs.existsSync(from)) fs.renameSync(from, mirrorPathFor(target))
  } catch { /* the next save rewrites it anyway */ }
  try {
    const oldBase = basename(filePath, '.latte')
    const newBase = basename(target, '.latte')
    const bdir = join(dirname(filePath), '.backups')
    if (fs.existsSync(bdir)) {
      for (const f of fs.readdirSync(bdir)) {
        const m = f.match(/^(.*)_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.latte$/)
        if (m && m[1] === oldBase) fs.renameSync(join(bdir, f), join(bdir, `${newBase}_${m[2]}.latte`))
      }
    }
  } catch { /* history keeps the old name; harmless */ }
  store.set('recentFiles', store.get('recentFiles').map(f => f === filePath ? target : f))
  store.set('currentFile', target)
  // Rename the Drive copy in place so the cloud tracks the new name.
  const oldRel = relInDocs(filePath)
  if (liveSyncOn() && oldRel) { try { await gdriveRename(oldRel, basename(target)) } catch { /* next save reconciles */ } }
  return { filePath: target }
})

// Send the current file (and its rolling backups) to the OS trash. Trash rather
// than unlink so a mistaken delete is recoverable from the system trash. The
// .mirror twin is deliberately left behind — it is the copy that survives
// anything, including a delete that came from the other side of a sync.
ipcMain.handle('doc:delete', async (_e, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: true }
  try { await shell.trashItem(filePath) } catch { try { fs.unlinkSync(filePath) } catch {} }
  try {
    const base = basename(filePath, extname(filePath))
    const bdir = join(dirname(filePath), '.backups')
    if (fs.existsSync(bdir)) {
      for (const f of fs.readdirSync(bdir)) {
        if (f.startsWith(base + '_') && f.endsWith('.latte')) { try { fs.unlinkSync(join(bdir, f)) } catch {} }
      }
    }
  } catch {}
  store.set('recentFiles', store.get('recentFiles').filter(f => f !== filePath))
  if (store.get('currentFile') === filePath) store.set('currentFile', '')
  // Trash the Drive copy too so the cloud tracks the deletion.
  const rel = relInDocs(filePath)
  if (liveSyncOn() && rel) { try { await gdriveRemove(rel) } catch { /* next mirror reconciles */ } }
  return { ok: true }
})

// Reveal the default documents folder in the host file manager.
ipcMain.handle('doc:openFolder', () => { shell.openPath(docsDir()); return true })

// ── Recovery ─────────────────────────────────────────────────────────────────
// Documents that are gone from the latte folder but still exist as a mirror
// twin, in the OS trash, or as a .backups snapshot.
ipcMain.handle('recover:list', () => {
  try { return listRecoverable(docsDir()) } catch (e) { return { error: String(e.message || e) } }
})

ipcMain.handle('recover:restore', (_e, { file, origin }) => {
  try {
    const target = restoreFile(file, origin)
    addRecent(target)
    return { filePath: target }
  } catch (e) { return { error: String(e.message || e) } }
})

// Per-save snapshots of one document (plus its mirror), for rolling back an edit.
ipcMain.handle('recover:snapshots', (_e, filePath) => {
  try { return filePath ? listSnapshots(filePath) : [] } catch { return [] }
})

// Read any recovered copy so the renderer can load it into the open document.
ipcMain.handle('recover:read', (_e, file) => {
  try { return readBundle(file) } catch (e) { return { error: String(e.message || e) } }
})

// Drop a mirror twin the user doesn't want back (the only way one is removed).
ipcMain.handle('recover:discard', async (_e, file) => {
  try {
    fs.chmodSync(file, 0o644)
    await shell.trashItem(file)
    return { ok: true }
  } catch (e) { return { error: String(e.message || e) } }
})

// Create an autosaved draft in the latte folder immediately (unique name).
ipcMain.handle('doc:autoNew', (_e, { doc, meta }) => {
  const dir = docsDir()
  const base = sanitizeName(meta?.title) || 'Untitled'
  let name = base, i = 1
  while (fs.existsSync(join(dir, name + '.latte'))) { name = `${base}_${String(i).padStart(2, '0')}`; i++ }
  const target = join(dir, name + '.latte')
  saveDocument(target, { doc, meta }, store.get('backupsToKeep'), store.get('backupIntervalMs'))
  addRecent(target)
  return { filePath: target }
})

// ── Sync ──────────────────────────────────────────────────────────────────────
async function syncCurrent(filePath) {
  const provider = store.get('syncProvider')
  // Path relative to the latte folder, so the provider mirrors any subfolders.
  // A file saved outside the latte folder has no place in the tree, so it syncs
  // flat by basename.
  const rel = relInDocs(filePath) || basename(filePath)
  if (provider === 'gdrive') return gdriveSync(filePath, rel)
  if (provider === 'onedrive') return onedriveSync(filePath, rel)
  throw new Error('No sync provider selected')
}
ipcMain.handle('sync:now', async (_e, filePath) => syncCurrent(filePath))

// Baseline manifest for two-way sync: each path's Drive id + checksum as of the
// last successful reconcile. Kept in LW_DATA (not the latte folder, so it never
// syncs itself). Lets us tell a new file from a remotely-deleted one.
const SYNC_STATE = join(dataPath, 'drive-sync-state.json')
function readSyncState() { try { return JSON.parse(fs.readFileSync(SYNC_STATE, 'utf8')) } catch { return {} } }
function writeSyncState(obj) { try { fs.writeFileSync(SYNC_STATE, JSON.stringify(obj)) } catch { /* best effort */ } }

// Send a document Drive just pulled/changed to the OS trash locally (recoverable),
// falling back to a hard unlink if trashing isn't available.
async function trashLocal(abs) {
  try { await shell.trashItem(abs) } catch { try { fs.unlinkSync(abs) } catch { /* gone already */ } }
}

// Run the full two-way reconcile against Drive, persisting the new baseline.
// Returns the stats summary. onProgress, if given, is called repeatedly with
// { phase, index, total, file, action } as the reconcile walks the tree.
async function runTwoWaySync(onProgress) {
  const { stats, manifest } = await gdriveTwoWay(docsDir(), readSyncState(), { trashLocal, onProgress })
  writeSyncState(manifest)
  return stats
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

// The SYNC ALL button: a manual full two-way reconcile (Google Drive only).
// Streams progress back to the requesting window over 'sync:progress' so the
// Settings panel can show a bar + description instead of a single opaque wait.
ipcMain.handle('sync:all', async (event) => {
  const provider = store.get('syncProvider')
  if (provider === 'none') return { ok: false, error: 'No sync provider selected' }
  if (provider !== 'gdrive') return { ok: false, error: 'Two-way sync is only available for Google Drive' }
  const sender = event.sender
  const onProgress = (ev) => { if (!sender.isDestroyed()) sender.send('sync:progress', ev) }
  try {
    const stats = await runTwoWaySync(onProgress)
    broadcast('sync:updated')   // let open windows reload anything that changed on disk
    return { ok: true, ...stats }
  } catch (e) { return { ok: false, error: e.message } }
})

// Pull-on-open: reconcile once at launch so this device picks up whatever the
// other device (e.g. the phone) changed. Only when Drive sync is active; runs
// after the window has loaded so the renderer's listener is ready to refresh.
// Waits on the launch check: with a dead sign-in it would only fail silently,
// so it is left for after the user reconnects.
let startupSynced = false
async function maybeStartupSync() {
  if (startupSynced || !liveSyncOn()) return
  if ((await checkDrive()).state !== 'ok') return
  if (startupSynced) return   // a concurrent caller got here first
  startupSynced = true
  const go = async () => { try { await runTwoWaySync(); broadcast('sync:updated') } catch { /* offline etc. */ } }
  if (mainWindow && !mainWindow.webContents.isLoading()) go()
  else mainWindow?.webContents.once('did-finish-load', go)
}

// Path of a file relative to the latte folder, or null if it lives outside the
// tree (a custom Save As location) and so has no mirrored place on Drive.
function relInDocs(filePath) {
  const rel = relative(docsDir(), filePath)
  return (!rel || rel.startsWith('..') || isAbsolute(rel)) ? null : rel
}

// True when changes should sync to/from Drive (Google Drive connected + enabled).
function liveSyncOn() {
  return store.get('syncOnSave') && store.get('syncProvider') === 'gdrive'
}

// ── Export ────────────────────────────────────────────────────────────────────
async function pickExportPath(defaultName, ext) {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${defaultName}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  })
  return res.canceled ? null : res.filePath
}

ipcMain.handle('export:pdf', async (e, { title }) => {
  const out = await pickExportPath(title || 'Untitled', 'pdf')
  if (!out) return null
  const data = await e.sender.printToPDF({ printBackground: true, preferCSSPageSize: true })
  fs.writeFileSync(out, data)
  return out
})

ipcMain.handle('export:html', async (_e, payload) => {
  const out = await pickExportPath(payload.meta?.title || 'Untitled', 'html')
  return out ? await exportHTML(out, payload) : null
})
ipcMain.handle('export:markdown', async (_e, payload) => {
  const out = await pickExportPath(payload.meta?.title || 'Untitled', 'md')
  return out ? exportMarkdown(out, payload) : null
})
ipcMain.handle('export:docx', async (_e, payload) => {
  const out = await pickExportPath(payload.meta?.title || 'Untitled', 'docx')
  return out ? exportDocx(out, payload) : null
})

// ── Fonts ─────────────────────────────────────────────────────────────────────
ipcMain.handle('fonts:load', (_e, family) => loadFontCss(family))
ipcMain.handle('fonts:catalog', () => fontCatalog())

// ── Spellcheck / edit (for the themed context menu) ───────────────────────────
ipcMain.handle('spell:set', (_e, enabled) => {
  store.set('spellcheck', enabled)
  session.defaultSession.setSpellCheckerEnabled(enabled)
  return enabled
})
ipcMain.handle('spell:replace', (_e, word) => mainWindow.webContents.replaceMisspelling(word))
ipcMain.handle('spell:add', (_e, word) => session.defaultSession.addWordToSpellCheckerDictionary(word))
ipcMain.handle('edit:cut', () => mainWindow.webContents.cut())
ipcMain.handle('edit:copy', () => mainWindow.webContents.copy())
ipcMain.handle('edit:paste', () => mainWindow.webContents.paste())
ipcMain.handle('edit:selectAll', () => mainWindow.webContents.selectAll())
// Images live in the document as data URLs; decode one onto the clipboard as a
// real bitmap so it can be pasted into apps that don't understand HTML.
ipcMain.handle('edit:copyImage', (_e, { src, html }) => {
  const image = nativeImage.createFromDataURL(src)
  const markup = html || `<img src="${src}">`
  if (image.isEmpty()) clipboard.writeHTML(markup)
  else clipboard.write({ image, html: markup })
})

// ── Full backup / restore (settings, custom styles, cached fonts) ─────────────
ipcMain.handle('backup:create', async () => {
  const stamp = new Date().toISOString().slice(0, 10)
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: join(app.getPath('home'), `LatteWrite-backup-${stamp}.zip`),
    filters: [{ name: 'Zip', extensions: ['zip'] }]
  })
  if (res.canceled || !res.filePath) return null
  const zip = new AdmZip()
  zip.addLocalFolder(dataPath) // config.json (settings + custom styles) + fonts/
  zip.writeZip(res.filePath)
  return res.filePath
})

ipcMain.handle('backup:restore', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }]
  })
  if (res.canceled || !res.filePaths[0]) return false
  const zip = new AdmZip(res.filePaths[0])
  zip.extractAllTo(dataPath, true)
  saveBoundsOnClose = false
  app.relaunch()
  app.exit(0)
  return true
})

// Install a desktop-menu shortcut + icon and register the .latte file type, so
// the app shows up in the DE menu (KDE/GNOME/…) and .latte files open with it.
// AppImages don't self-integrate, so this is opt-in from Settings.
ipcMain.handle('desktop:install', () => {
  // macOS takes the same information from the bundle's Info.plist
  // (CFBundleDocumentTypes), so there is nothing to install — the association
  // exists as soon as Launch Services has seen the app. It usually has, but a
  // bundle that was moved or rebuilt in place can go stale, and re-registering
  // fixes the icon and the "open with" default.
  if (IS_MAC) {
    const bundle = appBundle()
    if (!bundle) return { error: 'Run the packaged LatteWrite.app to register the .latte file type.' }
    const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/' +
      'LaunchServices.framework/Support/lsregister'
    try {
      spawn(lsregister, ['-f', bundle], { stdio: 'ignore' }).unref()
    } catch {
      return { error: 'Could not reach Launch Services. Opening a .latte with "Open With" once has the same effect.' }
    }
    return { ok: true }
  }

  const appimage = process.env.APPIMAGE
  if (!appimage) return { error: 'Run the packaged .AppImage to install the menu shortcut.' }
  const home = app.getPath('home')
  const share = join(home, '.local', 'share')
  const iconDest = join(share, 'icons', 'lattewrite.png')
  const appsDir = join(share, 'applications')
  const mimeRoot = join(share, 'mime')
  const iconSrc = join(process.resourcesPath, 'icon.png')

  fs.mkdirSync(join(share, 'icons'), { recursive: true })
  fs.mkdirSync(appsDir, { recursive: true })
  fs.mkdirSync(join(mimeRoot, 'packages'), { recursive: true })
  if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, iconDest)

  fs.writeFileSync(join(mimeRoot, 'packages', 'lattewrite.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-latte">
    <comment>LatteWrite document</comment>
    <glob pattern="*.latte"/>
    <icon name="lattewrite"/>
  </mime-type>
</mime-info>
`, 'utf8')

  fs.writeFileSync(join(appsDir, 'lattewrite.desktop'), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=LatteWrite',
    'Comment=Presentation-first word processor',
    `Exec="${appimage}" %f`,
    `Icon=${iconDest}`,
    'Terminal=false',
    'Categories=Office;WordProcessor;',
    'MimeType=application/x-latte;',
    'StartupWMClass=LatteWrite',
  ].join('\n') + '\n', 'utf8')

  const run = (cmd, args) => { try { spawn(cmd, args, { stdio: 'ignore' }).unref() } catch {} }
  run('update-desktop-database', [appsDir])
  run('update-mime-database', [mimeRoot])
  run('xdg-mime', ['default', 'lattewrite.desktop', 'application/x-latte'])
  run('gtk-update-icon-cache', ['-f', '-t', join(share, 'icons')])
  run('kbuildsycoca6', [])
  return { ok: true }
})

// Launch a second, fully independent instance (its own editor/undo history) so a
// different file can be edited alongside this one.
ipcMain.handle('window:new', () => { launchInstance(null); return true })

// ── Window controls (frameless) ───────────────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow.minimize())
ipcMain.handle('window:maximize', () => { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize() })
ipcMain.handle('window:close', () => mainWindow.close())
ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized())

// The AppImage filename carries no version on purpose, so desktop entries and
// shortcuts survive rebuilds. This is how you tell which build you are running.
ipcMain.handle('app:version', () => app.getVersion())

// ── Dictation ─────────────────────────────────────────────────────────────────
// Latte Dictate runs as a child process; events are pushed straight to the
// renderer, which turns them into grey interim text and committed text.
// Latte Dictate is a Linux app — it drives real Chrome and types through
// ydotool, which has no macOS counterpart. It isn't needed there either: macOS
// dictation (Fn twice) types into the editor like any other text field. The
// handlers keep their shape so the renderer is identical on both.
ipcMain.handle('dictate:available', () => (IS_MAC ? false : dictateAvailable()))
ipcMain.handle('dictate:setListening', (_e, on) =>
  IS_MAC ? false : dictateSet(on, (ev) => mainWindow && !mainWindow.isDestroyed()
    && mainWindow.webContents.send('dictate:event', ev)))

app.on('before-quit', () => dictateShutdown())

// ── Window ────────────────────────────────────────────────────────────────────
ipcMain.handle('window:presentation', () => {
  const on = !mainWindow.isFullScreen()
  mainWindow.setFullScreen(on)
  return on
})

// macOS needs a real menu bar. Without one there is no Cmd+Q, no Cmd+C/V/X/A,
// no Cmd+Z — a BrowserWindow gets those from menu roles, not for free — and the
// system's own Dictation and Emoji items, which it injects into a standard Edit
// menu, never appear. Accelerators the app already binds for itself (Cmd+S/O/N/
// F/D and the zoom keys, all in App.svelte's onKey) are deliberately left out so
// nothing is claimed twice. Linux keeps its frameless window and no menu.
function buildMenu() {
  if (!IS_MAC) return
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }]
    }
  ]))
}

app.whenReady().then(() => {
  buildMenu()
  checkDrive()         // start proving the Drive sign-in while the window loads
  createWindow()
  maybeStartupSync()   // pull anything the other device changed, once per launch
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
