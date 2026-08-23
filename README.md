# Claude for Zotero (v0.1.0 — DIY scaffold)

A minimal Zotero plugin (tested on Zotero 9.0.6, 64-bit) that adds three things:

1. **"Claude" button in the PDF reader toolbar** — opens a chat drawer
   seeded with the paper's title/abstract. Paste in excerpts you're
   reading and ask questions.
2. **"Explain with Claude" on text selection** — select text in a PDF,
   a popup offers an inline explanation.
3. **Tools → Ask Claude about My Library** — a chat drawer that does a
   quick keyword search over your library and feeds matching
   titles/abstracts to Claude as context.

## Install

1. Get an API key at https://console.anthropic.com/settings/keys
   (this is separate from your claude.ai login — it's billed per use,
   typically a few dollars/month for reading-assistant-level usage).
2. Build the plugin: `npm install` then `npm run build`. This produces
   `.scaffold/build/claude-reader.xpi`.
3. In Zotero: **Tools → Plugins** (or **Add-ons**) → gear icon →
   **Install Plugin From File** → select that `claude-reader.xpi`.
4. Restart Zotero if prompted.
5. **Tools → Set Claude API Key…** and paste your key.
6. Open any PDF — you should see a "Claude" button in the toolbar.

## Known limitations (this is a v1 scaffold, not a polished plugin)

- **Full-text extraction now works**, using Zotero's own documented
  `attachment.attachmentText` getter — the "Claude" toolbar button
  pulls the open PDF's indexed text (up to ~18k characters, truncated
  beyond that to keep API costs sane) and feeds it to Claude as
  context. If a PDF hasn't been indexed yet, Zotero indexes it on
  first access, which may take a moment on a long PDF — the button
  shows "Loading…" while that happens. If extraction comes back
  empty, the drawer falls back to title/abstract-only and tells you
  so (try Zotero's right-click → "Reindex Item" if that happens on a
  PDF that should have a text layer).
- **Library search is keyword-only**, not semantic — it uses Zotero's
  quick-search, so phrasing needs to roughly match your library's
  titles/abstracts.
- The Tools-menu injection uses `menu_ToolsPopup`, which is standard
  across recent Zotero versions but hasn't been tested against every
  release — if the menu items don't appear, that ID is the first
  thing to check via **Help → Debug Output Logging** or the error
  console (Tools → Developer → Error Console).
- No streaming — replies appear once complete.
- Model defaults to `claude-sonnet-5`; change via the hidden pref
  `extensions.claudereader.model` in `about:config`-style prefs if
  you want a different one.

## Next steps worth adding

- Real full-text extraction (once you confirm the right internal API
  or route through Zotero's local HTTP API the way `zotero-mcp` does).
- Streaming responses.
- A real preferences pane instead of a prompt dialog for the API key.
- Persisting chat history per-item instead of resetting each time you
  reopen the drawer.
