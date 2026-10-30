import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    check: (force) => ipcRenderer.invoke('auth:check', !!force),
    start: () => ipcRenderer.invoke('auth:start'),
    signOut: () => ipcRenderer.invoke('auth:signout')
  },
  doc: {
    open: () => ipcRenderer.invoke('doc:open'),
    openPath: (p) => ipcRenderer.invoke('doc:openPath', p),
    save: (payload) => ipcRenderer.invoke('doc:save', payload),
    saveAs: (payload) => ipcRenderer.invoke('doc:saveAs', payload),
    openInNewWindow: (payload) => ipcRenderer.invoke('doc:openInNewWindow', payload),
    recent: () => ipcRenderer.invoke('doc:recent'),
    rename: (payload) => ipcRenderer.invoke('doc:rename', payload),
    autoNew: (payload) => ipcRenderer.invoke('doc:autoNew', payload),
    delete: (filePath) => ipcRenderer.invoke('doc:delete', filePath),
    openFolder: () => ipcRenderer.invoke('doc:openFolder'),
    search: (query) => ipcRenderer.invoke('docs:search', query),
    initialFile: () => ipcRenderer.invoke('doc:initialFile')
  },
  recover: {
    list: () => ipcRenderer.invoke('recover:list'),
    restore: (payload) => ipcRenderer.invoke('recover:restore', payload),
    snapshots: (filePath) => ipcRenderer.invoke('recover:snapshots', filePath),
    read: (file) => ipcRenderer.invoke('recover:read', file),
    discard: (file) => ipcRenderer.invoke('recover:discard', file)
  },
  desktop: {
    install: () => ipcRenderer.invoke('desktop:install')
  },
  sync: {
    now: (filePath) => ipcRenderer.invoke('sync:now', filePath),
    all: () => ipcRenderer.invoke('sync:all'),
    onProgress: (cb) => {
      const listener = (_e, ev) => cb(ev)
      ipcRenderer.on('sync:progress', listener)
      return () => ipcRenderer.off('sync:progress', listener)
    },
    onUpdated: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('sync:updated', listener)
      return () => ipcRenderer.off('sync:updated', listener)
    }
  },
  exports: {
    pdf: (payload) => ipcRenderer.invoke('export:pdf', payload),
    html: (payload) => ipcRenderer.invoke('export:html', payload),
    markdown: (payload) => ipcRenderer.invoke('export:markdown', payload),
    docx: (payload) => ipcRenderer.invoke('export:docx', payload)
  },
  fonts: {
    load: (family) => ipcRenderer.invoke('fonts:load', family),
    catalog: () => ipcRenderer.invoke('fonts:catalog')
  },
  backup: {
    create: () => ipcRenderer.invoke('backup:create'),
    restore: () => ipcRenderer.invoke('backup:restore')
  },
  spell: {
    set: (enabled) => ipcRenderer.invoke('spell:set', enabled),
    replace: (word) => ipcRenderer.invoke('spell:replace', word),
    add: (word) => ipcRenderer.invoke('spell:add', word)
  },
  edit: {
    cut: () => ipcRenderer.invoke('edit:cut'),
    copy: () => ipcRenderer.invoke('edit:copy'),
    paste: () => ipcRenderer.invoke('edit:paste'),
    selectAll: () => ipcRenderer.invoke('edit:selectAll'),
    copyImage: (payload) => ipcRenderer.invoke('edit:copyImage', payload)
  },
  contextMenu: {
    onShow: (cb) => {
      const listener = (_e, data) => cb(data)
      ipcRenderer.on('context-menu', listener)
      return () => ipcRenderer.off('context-menu', listener)
    }
  },
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },
  dictate: {
    available: () => ipcRenderer.invoke('dictate:available'),
    setListening: (on) => ipcRenderer.invoke('dictate:setListening', on),
    onEvent: (cb) => {
      const listener = (_e, ev) => cb(ev)
      ipcRenderer.on('dictate:event', listener)
      return () => ipcRenderer.off('dictate:event', listener)
    }
  },
  platform: process.platform,
  // macOS hands a double-clicked .latte to an already-running app this way.
  onOpenFile: (cb) => {
    const listener = (_e, filePath) => cb(filePath)
    ipcRenderer.on('open-file', listener)
    return () => ipcRenderer.off('open-file', listener)
  },
  window: {
    togglePresentation: () => ipcRenderer.invoke('window:presentation'),
    newWindow: () => ipcRenderer.invoke('window:new'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onFullscreen: (cb) => {
      const listener = (_e, v) => cb(v)
      ipcRenderer.on('window:fullscreen', listener)
      return () => ipcRenderer.off('window:fullscreen', listener)
    },
    onMaximized: (cb) => {
      const listener = (_e, v) => cb(v)
      ipcRenderer.on('window:maximized', listener)
      return () => ipcRenderer.off('window:maximized', listener)
    }
  }
})
