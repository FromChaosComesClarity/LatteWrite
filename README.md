# LatteWrite

A beautiful, themeable, **presentation-first** word processor. Built to be gorgeous
enough to write in live during online classes and meetings — edit view and audience
view are the same view.

Electron + `electron-vite` + Svelte, with a Tiptap editing core.

## Features (v1 scaffold)

- **Tiptap editor** — headings, bold/italic/underline, quotes, lists, alignment.
- **Styles** — pick a whole look (colors + font pairing + reading measure) from the
  menu: Espresso, Ink, Manuscript, Lecture, Paper. Applied as CSS variables, so any
  Style can be forked later.
- **Presentation mode** (`Ctrl+Shift+P`) — full screen, chrome hidden, only a discreet
  floating control pill remains.
- **Dictation** (`Ctrl+D`, Linux) — speech-to-text via **Latte Dictate**, a sibling
  app that drives real Chrome; put its AppImage beside LatteWrite's. On macOS the
  button is hidden and the system's own dictation (press **Fn** twice) is used
  instead — it works in the editor like any other text field.
- **Autosave + backups** — atomic writes to the live `.latte` file plus a rolling ring
  of timestamped backups in a sibling `.backups/` folder.
- **`.latte` bundle format** — a zip holding the document JSON and its metadata, so a
  file reopens identically anywhere (fonts/images embedding is phase 2).
- **Export** — PDF (white "Paper" theme, via Chromium print-to-PDF), HTML, Markdown,
  and best-effort DOCX.
- **Google Drive sync** — reused OAuth loopback flow (scope `drive.file`); enable in
  Settings. OneDrive is stubbed for phase 2.

## Develop

```bash
npm install
npm run dev
```

## Build

One codebase, both platforms. `npm run dist` builds for whichever OS you are on.

```bash
npm run dist          # host platform
npm run dist:linux    # → dist/LatteWrite.AppImage, copied to ~/Apps/
npm run dist:mac      # → dist/LatteWrite-arm64.dmg  (Apple Silicon)
```

## macOS

The app is the same; three things differ, all behind `process.platform` guards.

**Where your files live.** On Linux everything sits beside the AppImage, which is
what makes it portable. A `.app` bundle cannot do that — it is signed and treated
as read-only — so on macOS the same layout sits in `~/LatteWrite/` instead
(`latte/` for documents, `LW_DATA/` for settings). The shape is identical either
way, so Drive sync mirrors one tree across both machines. See `src/main/paths.js`.

**Window chrome and menus.** macOS keeps its own traffic lights
(`titleBarStyle: 'hiddenInset'`) rather than the frameless window and custom
buttons Linux uses, and gets a real application menu — without one a
`BrowserWindow` has no ⌘Q, ⌘C, ⌘V, ⌘X, ⌘A or ⌘Z, and the system never shows its
own Dictation and Emoji items.

**Signing is not optional.** Apple Silicon refuses to launch an unsigned bundle,
killing it with no message that resembles anything but a crash in the app's own
code — and electron-builder has no ad-hoc signing of its own whichever host built
it. `scripts/afterPack.cjs` signs the bundle before it is packaged, so a build
made on a Mac is ready to run. A bundle cross-built on Linux cannot be signed
there (`codesign` is macOS-only) and needs one manual step on the Mac:

```bash
xattr -cr LatteWrite.app                        # clear the download quarantine
codesign --force --deep --sign - LatteWrite.app # ad-hoc signature
```

No Apple Developer account, certificate or notarization is involved.

## Google Drive setup

In Settings, paste a Google OAuth **Client ID** and **Client Secret** (Desktop app
credentials from Google Cloud Console), choose Google Drive as the provider, then
CONNECT. The redirect URI is `http://localhost:42814/callback`.

## Roadmap (phase 2)

- Local Whisper dictation (bundled `whisper.cpp` + model)
- OneDrive sync (Microsoft Graph)
- Any-Google-Font loading at runtime + font embedding in exports
- Custom Style editor
- Per-paragraph reveal (teleprompter mode)

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE).
