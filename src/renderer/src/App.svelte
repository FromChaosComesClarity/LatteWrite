<script>
  import { onMount, onDestroy, tick } from 'svelte'
  import { EditorState } from '@tiptap/pm/state'
  import Editor from './components/Editor.svelte'
  import TopBar from './components/TopBar.svelte'
  import PresentationBar from './components/PresentationBar.svelte'
  import ThemeChooser from './components/ThemeChooser.svelte'
  import Settings from './components/Settings.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import ConfirmDialog from './components/ConfirmDialog.svelte'
  import Drawing from './components/Drawing.svelte'
  import VersionHistory from './components/VersionHistory.svelte'
  import VersionViewer from './components/VersionViewer.svelte'
  import Recovery from './components/Recovery.svelte'
  import FindBar from './components/FindBar.svelte'
  import Outline from './components/Outline.svelte'
  import { applyStyle } from './theme.js'
  import { STYLES, DEFAULT_STYLE, isBuiltin, cloneStyle } from './styles.js'
  import { fontStack, ensureFontLoaded } from './fonts.js'
  import { DEFAULT_TEXT_COLORS, DEFAULT_HL_COLORS } from './colors.js'

  let settings = {}
  let editor = null
  // `bump` ticks on every change, for cheap things that must feel instant (the
  // toolbar's active states). `docBump` is its coalesced twin, for anything that
  // has to walk the document — dictation produces several changes a second and
  // nothing that expensive should run at that rate.
  let bump = 0
  let docBump = 0
  let docBumpTimer = null
  function markDocChanged() {
    clearTimeout(docBumpTimer)
    docBumpTimer = setTimeout(() => docBump++, 250)
  }

  // Saved favourite colours for the text/highlight pickers (most-recent first).
  let favText = DEFAULT_TEXT_COLORS
  let favHl = DEFAULT_HL_COLORS
  function addFav(list, hex, key) {
    const next = [hex, ...list.filter(c => c.toLowerCase() !== hex.toLowerCase())].slice(0, 15)
    window.api.settings.set({ [key]: next })
    return next
  }
  const addFavText = (hex) => { favText = addFav(favText, hex, 'favTextColors') }
  const addFavHl = (hex) => { favHl = addFav(favHl, hex, 'favHighlightColors') }

  let filePath = ''
  let title = 'Untitled'
  let titleManual = false  // true once the user renames the doc explicitly
  let fontScale = 1

  // Style state: `style` is the selected name (built-in or custom). `draft` is an
  // unsaved fork of a built-in being edited (built-ins are immutable).
  let customStyles = {}
  let style = DEFAULT_STYLE
  let draft = null
  let draftBase = ''

  let saving = false
  let dirty = false
  let fullscreen = false
  let chromeHidden = false
  let dictating = false
  let dictLabel = ''
  let dictAnchor = null
  let dictLen = 0

  let showStyles = false
  let showSettings = false
  let connected = false
  let driveStatus = null   // the launch check's { state, error }
  let maximized = false
  let drawMode = false
  let drawings = []
  let dialog = null  // themed alert/confirm

  // Version history — one snapshot per day (the day's final content), newest 20.
  // Each snapshot embeds the images the document had that day, so this is very
  // often far larger than the document itself. It changes at most once a day, so
  // it is sent to the main process only when it really did change; otherwise the
  // save keeps whatever is already in the file. See buildBundle in main/bundle.js.
  let versions = []
  let versionsDirty = false
  let lastSaveDate = null
  let lastSaveDoc = null
  let showVersions = false
  let showRecovery = false
  let viewingVersion = null   // a snapshot opened in the read-only viewer window
  let showFind = false
  let findBar
  let showNav = false

  // Document outline (H1/H2). Only built while the navigator is open, and then
  // off `docBump` rather than `bump`: it walks the entire document, which is far
  // too much to redo for every interim dictation result. The "you are here"
  // marker still tracks the caret live — it only scans the headings list.
  $: outline = showNav ? buildOutline(editor, docBump) : []
  $: activeHeadingPos = showNav ? activeHeading(outline, editor, bump) : -1

  function buildOutline(ed, _bump) {
    if (!ed) return []
    const items = []
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading' && (node.attrs.level === 1 || node.attrs.level === 2)) {
        items.push({ pos, level: node.attrs.level, text: node.textContent.trim() })
      }
    })
    return items
  }

  // The heading the caret currently sits in — the last one at or before the head.
  function activeHeading(list, ed, _bump) {
    if (!ed || !list.length) return -1
    const head = ed.state.selection.head
    let best = -1
    for (const it of list) { if (it.pos <= head) best = it.pos; else break }
    return best
  }

  // Jump the scroller to a heading, parking it a little below the top edge.
  function goToHeading(pos) {
    if (!editor || !scroller) return
    let dom = null
    try { dom = editor.view.nodeDOM(pos) } catch {}
    if (!dom || dom.nodeType !== 1) {
      try { dom = editor.view.domAtPos(pos + 1).node; if (dom && dom.nodeType === 3) dom = dom.parentElement } catch {}
    }
    if (!dom) return
    const rect = scroller.getBoundingClientRect()
    const y = dom.getBoundingClientRect().top - rect.top + scroller.scrollTop
    scroller.scrollTo({ top: Math.max(0, y - 90), behavior: 'smooth' })
    editor.commands.setTextSelection(pos + 1)   // moves the "you are here" marker
  }

  async function openFind() {
    // Seed from the selection, the way every other editor does.
    const sel = editor?.state.selection
    const seed = sel && !sel.empty ? editor.state.doc.textBetween(sel.from, sel.to, ' ').trim() : ''
    showFind = true
    await tick()
    findBar && findBar.open(seed.includes('\n') ? '' : seed)
  }

  const ymd = (t = Date.now()) => {
    const d = new Date(t), p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  function upsertVersion(date, doc) {
    versions = [{ date, savedAt: Date.now(), doc }, ...versions.filter(v => v.date !== date)]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 20)
    versionsDirty = true
  }

  function onDrawChange() { dirty = true; scheduleAutosave() }

  // Open a snapshot in the read-only viewer window (leaving the current document
  // untouched). The small history list steps aside for the fullscreen viewer.
  function viewVersion(v) { viewingVersion = v; showVersions = false }
  function closeViewer() { viewingVersion = null; showVersions = true }

  function restoreVersion(v) {
    showConfirm({
      title: 'Restore version', danger: true, confirmLabel: 'RESTORE',
      message: `Replace the current document with the version from ${v.date}? The current content will be replaced.`,
      onConfirm: () => { editor.commands.setContent(v.doc || ''); dirty = true; showVersions = false; viewingVersion = null; saveNow(false) }
    })
  }

  // An earlier save of the open document, loaded from .backups/.mirror. Saving it
  // rotates the current state into .backups first, so nothing is lost either way.
  function rollbackTo(res, snap) {
    showConfirm({
      title: 'Restore earlier save', danger: true, confirmLabel: 'RESTORE',
      message: `Replace the current document with the save from ${new Date(snap.at).toLocaleString()}? The state you have now is kept as a snapshot.`,
      onConfirm: () => {
        setDocument(res.doc)
        const m = res.meta || {}
        if (m.style && (STYLES[m.style] || customStyles[m.style])) style = m.style
        if (m.titleManual && m.title) { title = m.title; titleManual = true }
        applyCurrent()
        dirty = true
        showRecovery = false
        saveNow(false)
      }
    })
  }

  // Save a snapshot as a brand-new .latte the user names and places — the current
  // open document (its path, title and history) is left exactly as it is.
  async function saveVersionAs(v) {
    saving = true
    // A snapshot stores only the text document, so the copy carries the current
    // Style/fonts but not the live drawing overlay (which was never versioned).
    const meta = { ...buildMeta(), title: `${(title || 'Untitled').trim()} (${v.date})`, titleManual: true, drawings: [], savedDate: ymd() }
    await window.api.doc.saveAs({ doc: v.doc || '', meta, versions: [] })
    saving = false
  }

  // Open a snapshot as its own editable document in a new window — a fresh copy
  // is saved into the latte folder, then launched in a second window.
  async function openVersionInNewWindow(v) {
    const meta = { ...buildMeta(), title: `${(title || 'Untitled').trim()} (${v.date})`, titleManual: true, drawings: [], savedDate: ymd() }
    await window.api.doc.openInNewWindow({ doc: v.doc || '', meta })
  }
  function deleteVersion(v) {
    showConfirm({
      title: 'Delete version', danger: true, confirmLabel: 'DELETE',
      message: `Delete the saved version from ${v.date}?`,
      onConfirm: () => { versions = versions.filter(x => x.date !== v.date); versionsDirty = true; saveNow(false) }
    })
  }

  function showAlert(title, message) {
    dialog = { title, message, confirmLabel: 'OK', cancelLabel: '', danger: false, onConfirm: () => dialog = null }
  }
  function showConfirm({ title, message, confirmLabel, danger, onConfirm }) {
    dialog = { title, message, confirmLabel, cancelLabel: 'CANCEL', danger, onConfirm: () => { dialog = null; onConfirm() } }
  }

  // Presentation modes
  let typewriter = false
  let focusMode = false
  let revealMode = false
  let revealCount = 1
  let scroller = null

  let autosaveTimer = null

  $: revealTotal = (bump, editor) ? (editor?.view?.dom?.children?.length || 0) : 0

  $: curObj = draft || customStyles[style] || STYLES[style] || STYLES[DEFAULT_STYLE]
  $: bgEffect = settings?.bgEffect || 'none'
  $: stylesMap = { ...STYLES, ...customStyles }
  $: customSet = new Set(Object.keys(customStyles))
  $: editingLabel = draft ? draftBase + ' (unsaved copy)' : style

  // Set once at startup: whether the Latte Dictate app was found on disk.
  // Always false on macOS, where dictation is the system's job (press Fn twice).
  let micAvailable = false
  onDestroy(wireDictation())

  // A .latte double-clicked in Finder while the app is already running.
  onDestroy(window.api.onOpenFile((filePath) => openByPath(filePath)))

  // Window title (what KDE shows in the taskbar) reflects the current document.
  // Electron mirrors the page title to the native window title automatically.
  $: document.title = (title && title.trim()) ? `${title.trim()} — LatteWrite` : 'LatteWrite'
    ? true
    : !!(window.SpeechRecognition || window.webkitSpeechRecognition)

  function resolveCurrent() { return draft || customStyles[style] || STYLES[style] || STYLES[DEFAULT_STYLE] }

  function buildMeta() {
    const obj = resolveCurrent()
    return { title, titleManual, style, fontScale, drawings, bodyFont: fontStack(obj.fonts.body), headingFont: fontStack(obj.fonts.heading), bodyFamily: obj.fonts.body, headingFamily: obj.fonts.heading, codeFamily: obj.fonts.code, updatedAt: Date.now() }
  }

  // The document's first non-empty line. Stops at the block that has one rather
  // than flattening the whole document to text: this runs on every keystroke —
  // and on every interim dictation result, several times a second.
  function firstLine(ed) {
    const doc = ed.state.doc
    for (let i = 0; i < doc.childCount; i++) {
      const t = doc.child(i).textContent.trim()
      if (t) return t
    }
    return ''
  }

  // Auto-derive the name from the first line — unless the user has set it explicitly.
  function computeTitle() {
    if (!editor || titleManual) return
    const line = firstLine(editor)
    const fromFile = filePath ? filePath.split('/').pop().replace(/\.latte$/, '') : ''
    title = (line || fromFile || 'Untitled').trim().slice(0, 80)
  }

  // User renamed the document in the top bar → fix the title and rename the file.
  async function commitTitle(name) {
    name = (name || '').trim()
    if (!name || name === title) return
    title = name
    titleManual = true
    if (filePath) {
      const res = await window.api.doc.rename({ filePath, name })
      if (res) filePath = res.filePath
      saveNow(false)
    }
  }

  function onReady(ed) { editor = ed; computeTitle(); updatePresentation() }
  function onChange() {
    bump++; markDocChanged(); dirty = true; computeTitle(); updatePresentation()
    if (!filePath) createDraft()
    else scheduleAutosave()
  }

  // First edit of an unsaved document → create an autosaved draft in /latte
  // straight away (named from the auto-title), so no work is ever lost.
  let creatingDraft = false
  async function createDraft() {
    if (filePath || creatingDraft || !editor) return
    creatingDraft = true
    const doc = editor.getJSON()
    const res = await window.api.doc.autoNew({ doc, meta: { ...buildMeta(), savedDate: ymd() } })
    if (res) { filePath = res.filePath; dirty = false; versions = []; versionsDirty = false; lastSaveDate = ymd(); lastSaveDoc = doc }
    creatingDraft = false
    scheduleAutosave()
  }
  function onSelect() { bump++; updatePresentation() }

  // ── Presentation modes ──────────────────────────────────────────────────────
  // Focus/reveal styling is done by the Presentation ProseMirror extension (via
  // the focus/reveal/revealCount props on <Editor>) — external DOM edits get
  // reverted by ProseMirror. Here we only handle typewriter scroll + reveal nav.
  function currentBlockIndex() {
    return editor ? editor.state.selection.$head.index(0) : 0
  }

  function scrollCaretToCenter() {
    if (!editor || !scroller) return
    let coords
    try { coords = editor.view.coordsAtPos(editor.state.selection.head) } catch { return }
    const rect = scroller.getBoundingClientRect()
    const caretY = coords.top - rect.top + scroller.scrollTop
    scroller.scrollTo({ top: Math.max(0, caretY - scroller.clientHeight / 2), behavior: 'smooth' })
  }

  function scrollToBlock(i) {
    if (!editor || !scroller) return
    const el = editor.view.dom.children[i]
    if (!el) return
    const rect = scroller.getBoundingClientRect()
    const y = el.getBoundingClientRect().top - rect.top + scroller.scrollTop
    scroller.scrollTo({ top: Math.max(0, y - scroller.clientHeight / 2 + el.offsetHeight / 2), behavior: 'smooth' })
  }

  function updatePresentation() {
    if (typewriter) requestAnimationFrame(scrollCaretToCenter)
  }

  function toggleTypewriter() { typewriter = !typewriter; window.api.settings.set({ typewriter }); updatePresentation() }
  function toggleFocus() { focusMode = !focusMode; window.api.settings.set({ focusMode }) }
  function toggleReveal() {
    revealMode = !revealMode
    if (revealMode) revealCount = Math.max(1, currentBlockIndex() + 1)
    window.api.settings.set({ revealMode })
  }
  function revealNext() {
    revealCount = Math.min(editor?.view.dom.children.length || 1, revealCount + 1)
    scrollToBlock(revealCount - 1)
  }
  function revealPrev() { revealCount = Math.max(1, revealCount - 1) }

  function scheduleAutosave() {
    if (!filePath) return
    clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(() => saveNow(false), settings.autosaveMs || 1200)
  }

  async function saveNow(explicit) {
    if (!editor) return
    if (!filePath && !explicit) return
    saving = true
    // Until the user names it, keep the draft's filename following the auto-title.
    if (filePath && !titleManual) {
      const base = filePath.split('/').pop().replace(/\.latte$/i, '')
      const want = title.trim()
      if (want && want !== base) {
        const r = await window.api.doc.rename({ filePath, name: want, soft: true })
        if (r) filePath = r.filePath
      }
    }
    const today = ymd()
    const curDoc = editor.getJSON()
    // First save of a new day → freeze the previous day's final content.
    if (lastSaveDate && lastSaveDate !== today && lastSaveDoc) upsertVersion(lastSaveDate, lastSaveDoc)
    // Omitting `versions` means "keep the history already on disk". A file that
    // doesn't exist yet has none to keep, so send it there whatever the flag says.
    const req = { filePath, doc: curDoc, meta: { ...buildMeta(), savedDate: today } }
    if (versionsDirty || !filePath) req.versions = versions
    const res = await window.api.doc.save(req)
    if (res) { filePath = res.filePath; dirty = false; versionsDirty = false; computeTitle() }
    lastSaveDate = today
    lastSaveDoc = curDoc
    saving = false
  }

  // Write the current document to a directory/name of the user's choosing.
  // Returns the new path, or null if cancelled. Shared by Save As / Save a copy.
  async function writeToNewLocation() {
    const curDoc = editor.getJSON()
    const today = ymd()
    const res = await window.api.doc.saveAs({ doc: curDoc, meta: { ...buildMeta(), savedDate: today }, versions })
    return res ? { path: res.filePath, curDoc, today } : null
  }

  // Save As… — MOVE the document to the chosen location and edit it there. The
  // original in /latte is removed (it stays findable in search if the new home is
  // a /latte subfolder, since search now recurses).
  async function saveAsDoc() {
    if (!editor) return
    saving = true
    const prev = filePath
    const res = await writeToNewLocation()
    if (res) {
      filePath = res.path
      // Adopt the chosen filename as the title, treated as user-set so autosave
      // keeps the file where the user put it instead of renaming from line 1.
      title = filePath.split('/').pop().replace(/\.latte$/i, '')
      titleManual = true
      lastSaveDate = res.today
      lastSaveDoc = res.curDoc
      dirty = false
      await saveNow(false)   // persist the adopted title/manual flag into the new file
      if (prev && prev !== filePath) await window.api.doc.delete(prev)
    }
    saving = false
  }

  // Save a copy… — write a copy to the chosen location but keep editing the
  // ORIGINAL file; nothing is removed from /latte.
  async function saveCopyDoc() {
    if (!editor) return
    saving = true
    await writeToNewLocation()
    saving = false
  }

  async function openDoc() {
    const res = await window.api.doc.open()
    if (res) loadDoc(res)
  }

  async function openByPath(path) {
    const res = await window.api.doc.openPath(path)
    if (res) loadDoc(res)
  }

  // Replace the document AND wipe undo/redo history. Without the wipe, Ctrl+Z
  // can walk back past the load point into the previously-open file's content,
  // which autosave would then persist over the current file — destroying it.
  // Recreating the EditorState resets every plugin's state, including history.
  function setDocument(content) {
    editor.commands.setContent(content || '', false)
    const view = editor.view
    view.updateState(EditorState.create({ doc: view.state.doc, plugins: view.state.plugins }))
    bump++; markDocChanged(); updatePresentation()
  }

  function loadDoc(res) {
    filePath = res.filePath
    showFind = false          // a fresh EditorState drops the find highlights
    setDocument(res.doc)
    const meta = res.meta || {}
    draft = null; draftBase = ''
    if (meta.style && (STYLES[meta.style] || customStyles[meta.style])) style = meta.style
    fontScale = meta.fontScale || 1
    drawings = meta.drawings || []
    versions = res.versions || []
    // A bundle that still stores its pictures inline gets rewritten on the next
    // save; sending the history along is what lets the snapshots share them.
    versionsDirty = !!res.legacy
    lastSaveDate = meta.savedDate || null
    lastSaveDoc = res.doc
    applyCurrent()
    dirty = false
    titleManual = !!meta.titleManual
    if (titleManual && meta.title) title = meta.title
    else computeTitle()
  }

  function newWindow() { window.api.window.newWindow() }

  function newDoc() {
    if (!editor) return
    setDocument('')
    editor.commands.focus()
    filePath = ''
    dirty = false
    titleManual = false
    drawings = []
    versions = []
    versionsDirty = false
    lastSaveDate = null
    lastSaveDoc = null
    computeTitle()
  }

  function openDocsFolder() { window.api.doc.openFolder() }

  // Delete the current .latte (with a themed confirm). Unsaved buffers just clear.
  function requestDeleteDoc() {
    if (!filePath) { newDoc(); return }
    const name = filePath.split('/').pop().replace(/\.latte$/i, '')
    showConfirm({
      title: 'Delete document',
      message: `Delete “${name}”? The file and its backups are moved to your system trash, and the editor resets to a new document.`,
      confirmLabel: 'DELETE',
      danger: true,
      onConfirm: deleteCurrentDoc
    })
  }
  async function deleteCurrentDoc() {
    const target = filePath
    clearTimeout(autosaveTimer)   // don't let a pending autosave re-create the file
    filePath = ''                 // stop scheduleAutosave from touching it mid-delete
    await window.api.doc.delete(target)
    newDoc()
  }

  // ── Styles & fonts ────────────────────────────────────────────────────────
  function applyCurrent() {
    const obj = resolveCurrent()
    applyStyle(obj, fontScale)
    ensureFontLoaded(obj.fonts.heading)
    ensureFontLoaded(obj.fonts.body)
    ensureFontLoaded(obj.fonts.ui)
    ensureFontLoaded(obj.fonts.code)
  }

  function pickStyle(name) {
    draft = null
    draftBase = ''
    style = name
    applyCurrent()
    window.api.settings.set({ style })
  }

  // Change a font. Built-ins are immutable → fork an unsaved draft. Custom styles
  // are edited in place. Blank family reverts that slot to the base built-in's font.
  function hexToRgba(hex, a) {
    const h = hex.replace('#', '')
    const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h
    const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${a})`
  }

  // Apply a mutation to the current editable style: edit a custom style in place,
  // or fork an immutable built-in into an unsaved draft first.
  function editStyle(mutate) {
    if (draft) {
      mutate(draft)
      draft = draft
    } else if (customStyles[style]) {
      const cs = { ...customStyles[style], fonts: { ...customStyles[style].fonts }, tokens: { ...customStyles[style].tokens } }
      mutate(cs)
      customStyles = { ...customStyles, [style]: cs }
      window.api.settings.set({ customStyles })
    } else {
      draftBase = style
      draft = cloneStyle(STYLES[style])
      draft.base = style
      mutate(draft)
    }
    applyCurrent()
  }

  function setFont(kind, family) {
    const fam = (family || '').trim()
    if (!fam && !draft && !customStyles[style]) return // clearing an unedited built-in
    editStyle(s => { s.fonts[kind] = fam || (STYLES[s.base]?.fonts[kind] ?? STYLES[style].fonts[kind]) })
  }

  function setToken(key, value) {
    editStyle(s => {
      s.tokens[key] = value
      if (key === 'accent') s.tokens.selection = hexToRgba(value, 0.28) // keep selection tied to accent
    })
  }
  function setMeasure(value) { editStyle(s => { s.measure = value }) }
  function setDark(v) { editStyle(s => { s.dark = v }) }

  function saveStyle(name) {
    name = (name || '').trim()
    if (!name || !draft) return
    if (isBuiltin(name)) { showAlert('Style', 'That name belongs to a built-in style. Pick another.'); return }
    const obj = cloneStyle(draft)
    obj.base = draft.base
    customStyles = { ...customStyles, [name]: obj }
    style = name
    draft = null
    draftBase = ''
    window.api.settings.set({ customStyles, style })
    applyCurrent()
  }

  function requestDeleteCustom(name) {
    showConfirm({
      title: 'Delete style',
      message: `Delete the custom style "${name}"? This can't be undone.`,
      confirmLabel: 'DELETE', danger: true,
      onConfirm: () => deleteCustom(name)
    })
  }

  function deleteCustom(name) {
    if (!customStyles[name]) return
    const next = { ...customStyles }
    delete next[name]
    customStyles = next
    window.api.settings.set({ customStyles })
    if (style === name) pickStyle(DEFAULT_STYLE)
  }

  function uniqueStyleName(base) {
    let n = base, i = 2
    while (STYLES[n] || customStyles[n]) n = `${base} ${i++}`
    return n
  }

  // Duplicate any style (built-in or custom) into a new editable custom style.
  function duplicateStyle(name) {
    const src = customStyles[name] || STYLES[name]
    if (!src) return
    const obj = cloneStyle(src)
    obj.base = src.base || (isBuiltin(name) ? name : DEFAULT_STYLE)
    const newName = uniqueStyleName(`${name} copy`)
    customStyles = { ...customStyles, [newName]: obj }
    style = newName
    draft = null; draftBase = ''
    window.api.settings.set({ customStyles, style })
    applyCurrent()
  }

  function renameStyle(oldName, newName) {
    newName = (newName || '').trim()
    if (!newName || !customStyles[oldName] || newName === oldName) return
    if (STYLES[newName] || customStyles[newName]) { showAlert('Style', 'A style with that name already exists.'); return }
    const next = { ...customStyles }
    next[newName] = next[oldName]
    delete next[oldName]
    customStyles = next
    if (style === oldName) style = newName
    window.api.settings.set({ customStyles, style })
  }

  // ── Zoom (editor text only) ─────────────────────────────────────────────────
  function zoomBy(d) {
    fontScale = Math.min(2.5, Math.max(0.6, Math.round((fontScale + d) * 10) / 10))
    applyCurrent()
    window.api.settings.set({ fontScale })
  }
  function zoomReset() { fontScale = 1; applyCurrent(); window.api.settings.set({ fontScale }) }

  async function setSpellcheck(v) {
    await window.api.spell.set(v)
    settings = { ...settings, spellcheck: v }
  }

  // ── Export ────────────────────────────────────────────────────────────────
  async function exportAs(kind) {
    if (!editor) return
    if (kind === 'pdf' || kind === 'pdfPlain') {
      // The document-only PDF comes from the print stylesheet; 'plain' swaps to
      // white paper (fonts kept). No interface, no style-switching flash.
      document.documentElement.setAttribute('data-print', kind === 'pdfPlain' ? 'plain' : 'styled')
      await new Promise(r => setTimeout(r, 50))
      await window.api.exports.pdf({ title })
      document.documentElement.removeAttribute('data-print')
      return
    }
    const payload = { doc: editor.getJSON(), html: editor.getHTML(), text: editor.getText(), meta: buildMeta() }
    await window.api.exports[kind](payload)
  }

  // ── Presentation ────────────────────────────────────────────────────────────
  async function toggleFullscreen() { fullscreen = await window.api.window.togglePresentation() }
  function toggleChrome() { chromeHidden = !chromeHidden }
  const winMin = () => window.api.window.minimize()
  const winMax = () => window.api.window.maximize()
  const winClose = () => window.api.window.close()

  // ── Dictation ────────────────────────────────────────────────────────────────
  function clampPos(p) { return Math.max(0, Math.min(p, editor.state.doc.content.size)) }
  function greyColor() { return getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888888' }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

  // Latte Dictate emits \n for "new line" and \n\n for "new paragraph". A bare
  // newline inside an HTML string collapses to a space, so build real markup.
  function dictHtml(text) {
    const paras = esc(text).split(/\n{2,}/)
    if (paras.length === 1) return paras[0].replace(/\n/g, '<br>')
    return paras.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
  }

  function dictInterim(text) {
    if (!editor || !text) return
    if (dictAnchor == null) dictAnchor = editor.state.selection.to
    const from = clampPos(dictAnchor)
    const to = clampPos(dictAnchor + dictLen)
    const t = text.replace(/^\s+/, '')
    editor.chain().insertContentAt({ from, to }, esc(t)).setTextSelection({ from, to: from + t.length })
      .setColor(greyColor()).setTextSelection(from + t.length).run()
    dictLen = t.length
  }

  function dictCommit(text) {
    if (!editor || !text) return
    if (dictAnchor == null) dictAnchor = editor.state.selection.to
    const from = clampPos(dictAnchor)
    const to = clampPos(dictAnchor + dictLen)
    // Inserted verbatim. Latte Dictate's punctuator emits a LEADING space and
    // never a trailing one — that is how a phrase starting with "comma"
    // attaches to the previous word. Trimming it, or adding a space of our
    // own, breaks spacing for every phrase after the first.
    editor.chain().insertContentAt({ from, to }, dictHtml(text)).run()

    // Committed text must lose the grey the interim preview left at this
    // position, which the insertion inherits. This has to be a second chain
    // over an explicit range: insertContentAt leaves the selection collapsed at
    // the end, and unsetColor() on a collapsed selection only sets stored marks
    // for whatever is typed NEXT — it does not touch the text just inserted.
    // The end is read from state rather than computed from string length,
    // because "new paragraph" becomes a block node and the two disagree.
    const end = editor.state.selection.to
    editor.chain().setTextSelection({ from, to: end }).unsetColor()
      .setTextSelection(end).run()
    dictAnchor = end
    dictLen = 0
  }

  // Turn whatever grey interim text is on screen into normal committed text.
  function settleInterim() {
    if (editor && dictLen > 0 && dictAnchor != null) {
      const from = clampPos(dictAnchor), to = clampPos(dictAnchor + dictLen)
      editor.chain().setTextSelection({ from, to }).unsetColor().setTextSelection(to).run()
      dictAnchor = to
    }
    dictLen = 0
  }

  // Events from the Latte Dictate child process. Registered once; the returned
  // function unsubscribes on destroy.
  function wireDictation() {
    return window.api.dictate.onEvent((ev) => {
      switch (ev.event) {
        case 'interim':
          if (dictating) dictInterim(ev.text)
          break
        case 'final':
          if (dictating) dictCommit(ev.text)
          break
        case 'ready':
        case 'state':
          if (dictating) dictLabel = ev.listening ? 'LISTENING' : 'STARTING…'
          break
        case 'error':
          showAlert('Dictation', ev.text || 'Latte Dictate reported an error.')
          break
        case 'bye':
        case 'exit':
          // The child died or was shut down; do not leave the button lit.
          if (dictating) {
            settleInterim()
            dictating = false; dictAnchor = null; dictLen = 0
          }
          dictLabel = ''
          break
      }
    })
  }

  async function toggleDictate() {
    if (dictating) {
      await window.api.dictate.setListening(false)
      settleInterim()
      dictating = false; dictLabel = ''; dictAnchor = null; dictLen = 0
      return
    }
    // Anchor at the caret so text lands where the cursor is, not where it was.
    dictAnchor = null; dictLen = 0
    dictLabel = 'STARTING…'
    const ok = await window.api.dictate.setListening(true)
    if (!ok) {
      dictLabel = ''
      showAlert('Dictation', 'Latte Dictate was not found. Install its AppImage next to LatteWrite (in ~/LatteWrite) and try again.')
      return
    }
    dictating = true
  }

  // ── Settings & auth ──────────────────────────────────────────────────────────
  async function patchSettings(patch) { settings = await window.api.settings.set(patch) }
  async function connectDrive() {
    try {
      await window.api.auth.start()
      connected = await window.api.auth.status()
      reportDrive(await window.api.auth.check())
    }
    catch (e) { showAlert('Cloud sync', 'Could not connect: ' + e.message) }
  }
  async function disconnectDrive() { await window.api.auth.signOut(); connected = false; driveStatus = null }

  // The launch check's answer (see checkConnection in main/auth.js). A sign-in
  // Google refused, or a Drive it could not reach, is put in front of the user
  // instead of left for them to find in Settings.
  function reportDrive(r) {
    driveStatus = r
    if (r.state !== 'reauth' && r.state !== 'unreachable') return
    const stakes = 'nothing syncs: your saves stay on this computer and changes from your other devices will not come down.'
    dialog = r.state === 'reauth'
      ? { title: 'Google Drive', danger: false,
          message: `LatteWrite is no longer signed in to Google Drive (${r.error}). Until you reconnect, ${stakes}`,
          confirmLabel: 'RECONNECT', cancelLabel: 'CONTINUE ANYWAY',
          onConfirm: () => { dialog = null; connectDrive() } }
      : { title: 'Google Drive', danger: false,
          message: `LatteWrite could not reach Google Drive (${r.error}). Until it can, ${stakes}`,
          confirmLabel: 'RETRY', cancelLabel: 'CONTINUE ANYWAY',
          onConfirm: async () => { dialog = null; reportDrive(await window.api.auth.check(true)) } }
  }
  function openSettings() { showSettings = true }

  function onKey(e) {
    const ctrl = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (ctrl && e.shiftKey && k === 's') { e.preventDefault(); saveAsDoc() }
    else if (ctrl && k === 's') { e.preventDefault(); saveNow(true) }
    else if (ctrl && e.shiftKey && k === 'p') { e.preventDefault(); toggleFullscreen() }
    else if (ctrl && e.shiftKey && k === 'h') { e.preventDefault(); toggleChrome() }
    else if (ctrl && e.shiftKey && k === 'x') { e.preventDefault(); editor?.chain().focus().toggleStrike().run() }
    else if (ctrl && k === 'd') { e.preventDefault(); if (micAvailable) toggleDictate() }
    else if (ctrl && k === 'o') { e.preventDefault(); openDoc() }
    else if (ctrl && k === 'f') { e.preventDefault(); openFind() }
    else if (ctrl && e.shiftKey && k === 'n') { e.preventDefault(); newWindow() }
    else if (ctrl && k === 'n') { e.preventDefault(); newDoc() }
    else if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); zoomBy(0.1) }
    else if (ctrl && k === '-') { e.preventDefault(); zoomBy(-0.1) }
    else if (ctrl && k === '0') { e.preventDefault(); zoomReset() }
    else if (revealMode && e.key === 'PageDown') { e.preventDefault(); revealNext() }
    else if (revealMode && e.key === 'PageUp') { e.preventDefault(); revealPrev() }
    else if (e.key === 'Escape') {
      if (dialog) return                       // a confirm is open — let it handle Esc
      else if (showNav) showNav = false
      else if (showFind) showFind = false
      else if (showRecovery) showRecovery = false
      else if (viewingVersion) closeViewer()
      else if (showVersions) showVersions = false
      else { showStyles = false; showSettings = false }
    }
  }

  onMount(async () => {
    micAvailable = await window.api.dictate.available()
    settings = await window.api.settings.get()
    customStyles = settings.customStyles || {}
    // Styles promoted to built-ins shed their stale per-install custom copies.
    const promoted = Object.keys(customStyles).filter((n) => STYLES[n])
    if (promoted.length) {
      const kept = { ...customStyles }
      for (const n of promoted) delete kept[n]
      customStyles = kept
      window.api.settings.set({ customStyles })
    }
    style = settings.style || DEFAULT_STYLE
    if (!STYLES[style] && !customStyles[style]) style = DEFAULT_STYLE
    fontScale = settings.fontScale || 1
    typewriter = !!settings.typewriter
    focusMode = !!settings.focusMode
    revealMode = !!settings.revealMode
    if (settings.favTextColors?.length) favText = settings.favTextColors
    if (settings.favHighlightColors?.length) favHl = settings.favHighlightColors
    applyCurrent()
    connected = await window.api.auth.status()
    window.api.auth.check().then(reportDrive)   // resolves after launch; the editor stays usable meanwhile
    maximized = await window.api.window.isMaximized()
    window.api.window.onFullscreen(v => { fullscreen = v; chromeHidden = v })
    window.api.window.onMaximized(v => { maximized = v })
    // A two-way sync just landed changes on disk. Reload the open document so it
    // reflects what came down from Drive — but never over unsaved edits (those
    // win and push on the next save), and reset to a blank doc if it was deleted
    // remotely.
    window.api.sync.onUpdated(async () => {
      if (dirty || !filePath) return
      const res = await window.api.doc.openPath(filePath)
      if (res) loadDoc(res)
      else newDoc()
    })
    window.addEventListener('keydown', onKey)
    const initial = await window.api.doc.initialFile()
    if (initial) openByPath(initial)
  })
</script>

<div class="bg-fx" data-bg={bgEffect}></div>

<div class="app-shell">
  {#if !chromeHidden}
    <TopBar
      {editor} {bump} {title} {saving} {dirty} {maximized} zoom={fontScale}
      onNew={newDoc} onNewWindow={newWindow} onOpen={openDoc} onSave={() => saveNow(true)} onSaveAs={saveAsDoc}
      onSaveCopy={saveCopyDoc} onOpenFolder={openDocsFolder} onDeleteDoc={requestDeleteDoc}
      onExport={exportAs} onStyles={() => showStyles = true}
      onSettings={openSettings} onPresent={toggleFullscreen}
      onZoomIn={() => zoomBy(0.1)} onZoomOut={() => zoomBy(-0.1)} onZoomReset={zoomReset}
      onMinimize={winMin} onMaximize={winMax} onClose={winClose} onRename={commitTitle}
      onOpenDoc={openByPath} drawing={drawMode} onDraw={() => drawMode = !drawMode}
      favText={favText} favHl={favHl} onAddFavText={addFavText} onAddFavHl={addFavHl}
      onVersions={() => showVersions = true} onRecover={() => showRecovery = true} />
  {/if}

  <div class="editor-area">
    {#if showFind}
      <FindBar bind:this={findBar} {editor} onClose={() => showFind = false} />
    {/if}

    <div class="editor-scroll" class:typewriter bind:this={scroller}>
      <div class="draw-host">
        <Editor {onReady} {onChange} {onSelect} focus={focusMode} reveal={revealMode} {revealCount} />
        <Drawing active={drawMode} bind:shapes={drawings} on:change={onDrawChange} onExit={() => drawMode = false} />
      </div>
    </div>

    <Outline
      {outline} activePos={activeHeadingPos} {fullscreen} {chromeHidden}
      bind:open={showNav}
      onToggle={() => showNav = !showNav} onClose={() => showNav = false}
      onGo={goToHeading} />
  </div>

  <PresentationBar
    {dictating} {dictLabel} {fullscreen} {chromeHidden} {saving} {micAvailable}
    {typewriter} {focusMode} {revealMode} {revealCount} {revealTotal}
    onDictate={toggleDictate} onPresent={toggleFullscreen} onToggleChrome={toggleChrome}
    onToggleTypewriter={toggleTypewriter} onToggleFocus={toggleFocus} onToggleReveal={toggleReveal}
    onRevealNext={revealNext} onRevealPrev={revealPrev} />

  {#if showStyles}
    <ThemeChooser current={style} {stylesMap} {customSet}
      onPick={pickStyle} onDelete={requestDeleteCustom} onDuplicate={duplicateStyle}
      onRename={renameStyle} onClose={() => showStyles = false} />
  {/if}
  {#if showSettings}
    <Settings {settings} {connected} {driveStatus}
      headingFamily={curObj.fonts.heading} bodyFamily={curObj.fonts.body} codeFamily={curObj.fonts.code}
      tokens={curObj.tokens} measure={curObj.measure} dark={curObj.dark}
      isDraft={!!draft} {editingLabel}
      onPatch={patchSettings} onSetFont={setFont} onSaveStyle={saveStyle} onSpellcheck={setSpellcheck}
      onSetToken={setToken} onSetMeasure={setMeasure} onSetDark={setDark}
      onConnect={connectDrive} onDisconnect={disconnectDrive} onClose={() => showSettings = false} />
  {/if}

  <ContextMenu />

  {#if showVersions}
    <VersionHistory {versions} onView={viewVersion} onDelete={deleteVersion} onClose={() => showVersions = false} />
  {/if}

  {#if showRecovery}
    <Recovery {filePath} onOpen={openByPath} onRollback={rollbackTo} onClose={() => showRecovery = false} />
  {/if}

  {#if viewingVersion}
    <VersionViewer version={viewingVersion} {title}
      onRestore={restoreVersion} onSaveAs={saveVersionAs}
      onOpenNewWindow={openVersionInNewWindow} onClose={closeViewer} />
  {/if}

  {#if dialog}
    <ConfirmDialog title={dialog.title} message={dialog.message}
      confirmLabel={dialog.confirmLabel} cancelLabel={dialog.cancelLabel} danger={dialog.danger}
      onConfirm={dialog.onConfirm} onCancel={() => dialog = null} />
  {/if}
</div>
