# Development History — Claude for Zotero

This documents how the plugin got built, in order, including every bug hit
and how it was diagnosed and fixed. Written so the project can be picked up
cleanly in VS Code without re-deriving any of this.

## Background / goal

Started from a broader question: how to connect Claude to a Zotero library
for reading papers. Explored several existing options first:

- **MCP servers** (`zotero-mcp`, `Zoteus`, others) for use with Claude Code —
  these remain a good complementary tool for deep multi-paper research
  sessions with real full-text search across a whole library. Zoteus in
  particular (`npx -y @oscardvs/zoteus`) is recommended for that use case:
  `claude mcp add --transport stdio zoteus -- npx -y @oscardvs/zoteus`.
- **Existing Zotero AI plugins** (Beaver, PapersGPT) as inline-in-Zotero
  alternatives — viable, but the goal here was a small, custom, Claude-only
  plugin rather than a general multi-provider tool.

Decided to build a small custom Zotero plugin instead, so Claude lives
directly inside Zotero (no app-switching), reads full paper text, and stays
minimal/inspectable rather than adopting a large third-party plugin.

## v0.1.0 — initial build

Built as a plain-JS bootstrapped Zotero 7+ plugin (no build tooling, so it's
easy to read/edit directly):

- `manifest.json` — WebExtension-style manifest required by Zotero 7+.
- `bootstrap.js` — all plugin logic.
- Three features:
  1. **Reader toolbar "Claude" button** — opens a chat drawer scoped to the
     currently-open paper.
  2. **"Explain with Claude" on text selection** — via
     `Zotero.Reader.registerEventListener('renderTextSelectionPopup', ...)`.
  3. **Tools → Ask Claude about My Library** — chat drawer grounded by a
     keyword search (`Zotero.Search`) across the library.
- API calls go straight to `https://api.anthropic.com/v1/messages` using
  `Zotero.HTTP.request` (privileged XPCOM networking — avoids browser CORS
  entirely, unlike a `fetch()` from an unprivileged context).
- API key entry via a Tools-menu item, stored in `Zotero.Prefs`
  (`extensions.claudereader.apiKey`).

Initially shipped **without** real PDF full-text extraction (used
title/abstract only), because the correct internal Zotero API for it wasn't
confirmed. Added properly in the next round once confirmed.

## Bug 1 — install fails: "incompatible with this version of Zotero"

Cause: `manifest.json`'s `strict_max_version` was capped at `9.0.*`, and
Zotero had just shipped version **10.0** (Aug 17, 2026). User was on 9.0.6,
so a max-version guess of `12.0.*` was tried next, then simplified to
`strict_max_version: "*"` (no upper bound) to remove version-guessing
entirely as a failure mode.

## Bug 2 — install still fails, real cause found via debug log

The Zotero debug log (Help → Debug Output Logging → View Output) showed the
actual error:

```
Reading manifest: applications.zotero.update_url not provided
```

Zotero 9's manifest parser requires `update_url` to be present (even for a
personal/unpublished plugin — it's just never queried). Added a placeholder
`update_url`. **This is the point where pulling the debug log became the
standard diagnostic step** for the rest of the project — guessing blind
repeatedly wasted time; the log consistently gave the exact answer.

## Feature: real PDF full-text extraction

Looked up Zotero's documented JS API and found `attachment.attachmentText`
— an async getter that returns the attachment's indexed text layer
(building the index on first access if needed). Wired into the toolbar
button: pulls the open PDF's full text (capped at ~18,000 characters to
control API cost/token usage), falls back to title/abstract-only with a
user-visible note if extraction fails or the PDF isn't indexed yet.

## Bug 3 — Tools menu item never appears

First hypothesis (wrong-ish): timing — `menu_ToolsPopup` not in the DOM yet
when `startup()` ran. Added retry logic (`addToolsMenuWithRetry`, 10
attempts on a 500ms interval) and a proper `log()` helper (which, it turned
out, **hadn't actually been defined anywhere** — calls to `log()` were
throwing `ReferenceError`s silently). Fixed both defensively, but the menu
still didn't appear.

## Bug 4 — real root cause: `startup()` was crashing on line 1

Debug log showed:

```
can't access property "getService", Components.classes['@zotero.org/Zotero;1'] is undefined
```

This was legacy Zotero-6-era code (`Components.classes['@zotero.org/Zotero;1'].getService(...)`)
copied from an older doc example. Zotero's own **current** developer docs
state plainly: *"the `Zotero` object is automatically made available in the
bootstrap scope, along with `Services`, `Cc`, and `Ci`"* — no manual lookup
needed or possible anymore. Because this line threw immediately,
**`startup()` never completed**, meaning nothing in the plugin worked yet —
not just the Tools menu, but the toolbar button and selection popup were
silently non-functional too.

Fix:
- Removed the `Components.classes` lookup entirely; use the injected
  `Zotero` global directly.
- Switched window-specific setup from a hand-rolled `Services.wm` window
  listener to Zotero's official `onMainWindowLoad` / `onMainWindowUnload`
  bootstrap hooks (the documented, supported mechanism for this).

## UX pass — API key dialog readability

User wanted the "Set Claude API Key" prompt reformatted: bold main
instruction, grey subtext below with where to get a key. Native
`Services.prompt.prompt` dialogs don't support styled text (only plain
strings, though multi-line via `\n` works), so first pass used two lines
via `\n\n`. A follow-up attempt to build a **fully custom styled XHTML
dialog window** (`content/apikey-dialog.xhtml`, opened via `win.openDialog`)
hit three rendering bugs in a row while debugging blind (no way to see the
live render):

1. Dialog opened at near-zero size — `width="440"` as a XUL element
   attribute is no longer honored by modern Gecko (per Zotero's own
   migration notes: *"width and height attributes are no longer recognized
   on XUL elements... replace with CSS rules"*). Tried CSS `min-width` on
   the `<window>` element instead.
2. Still wrong size — the actual fix needed was in the `openDialog()`
   **features string** (`chrome,dialog,modal,centerscreen,width=460,height=260`),
   which controls real OS-level window dimensions; the CSS fix from step 1
   was styling content that never had room to show.
3. Dialog then opened at the right size but rendered **completely blank**.
   Root cause not identified (see "Known unfinished item" below) — after
   three failed blind iterations without the ability to see the actual
   render, **reverted to the native `Services.prompt.prompt` dialog**
   (functional, just not styled) to stop burning the user's time on
   further guesses. The custom dialog file is still in the repo
   (`content/apikey-dialog.xhtml`) but is currently unused/disconnected
   from `bootstrap.js`.

## Bug 5 — toolbar button "does nothing" on click

Turned out to be two compounding issues:

1. **User was single-clicking; a double-click was required.** Root cause
   found later (see Bug 6) — stray duplicate buttons were absorbing the
   first click.
2. Once double-clicking to get past that, the button flipped to
   "Error — see console" with **no error actually appearing in the debug
   log** at first (a stale/cached log was being viewed). Once a genuinely
   fresh log was captured after a clean reinstall, it showed:

   ```
   TypeError: can't access property "appendChild", doc.body is null
   ```

   Cause: the drawer was being built in the **main Zotero window's
   document**, which is a XUL document — XUL documents have no `.body`
   property (only HTML documents do; XUL's root content container is
   `.documentElement`). Fixed by appending to `doc.body || doc.documentElement`
   (the style-injection code already used this fallback pattern; the
   drawer-append call didn't).

   Note: this document-scope bug was introduced while fixing a *different*
   suspected issue — originally the drawer was built inside the reader
   toolbar's own scoped `doc` (per `Zotero.Reader`'s `renderToolbar` event),
   which is a small iframe, not the full window; `position: fixed` there
   would clip the drawer to that tiny iframe's bounds. Moving the drawer to
   the main window fixed the clipping problem but introduced the `.body`
   problem above. Both fixes were needed together.

## Bug 6 — duplicate buttons stacking (the actual double-click cause)

`Zotero.Reader`'s `renderToolbar` event fires **every time the reader
toolbar re-renders** (page changes, resizes, etc.) — and the original code
appended a brand-new "Claude" button on every firing with no de-duplication
check, silently stacking multiple overlapping buttons in the DOM. The first
click was landing on a stale, inert button underneath the visible one.
Fixed with a guard: `if (doc.querySelector('.claude-reader-toolbar-btn')) return;`
at the top of the handler.

## Bug 7 — Send/Close buttons invisible in the chat drawer

Drawer appeared and was positioned correctly, but the `<button>` elements
for "Send" and the header's "✕" close control were completely invisible
(zero visual trace) while the `<textarea>` in the same drawer rendered and
worked fine. Zotero's main chrome window applies platform-level styling to
native `<button>` elements that appears to hide/collapse them unless
marked up in a way the chrome stylesheet expects (a documented pattern
elsewhere in Zotero's Firefox-platform migration notes mentions needing
`native="true"` for native form elements in XUL contexts) — rather than
chase that specific attribute blindly, the fix taken was to **stop using
`<button>` for these two controls** and use styled, `role="button"`,
`tabindex="0"` `<div>`s with `click` listeners instead, which render
identically in both plain-HTML and Zotero-chrome contexts and sidestep the
issue entirely.

## Bug 8 — Claude API calls failing with HTTP 400

Cause: `DEFAULT_MODEL` was set to `'claude-sonnet-5'`, which is a
display/marketing name, not a valid literal API model identifier for a
direct `/v1/messages` POST. Changed to `'claude-sonnet-4-6'`. Also improved
`callClaude()`'s error handling to parse and surface Anthropic's actual
`error.message` from the failed response body (previously only a bare
"failed with status code 400" was shown), so future API errors are
self-diagnosing without another debug-log round-trip.

## Current state (end of this session)

Working:
- Reader toolbar "Claude" button → chat drawer with real full-text context
  (via `attachment.attachmentText`, capped ~18k chars).
- "Explain with Claude" on text selection in the PDF reader.
- Tools → Ask Claude about My Library (keyword-search-grounded chat).
- Tools → Set Claude API Key (native prompt dialog, functional).
- Chat drawer: send/close controls visible and working.
- API calls use the correct model string and surface real error messages.

Known unfinished / good next targets in VS Code:

1. **Custom styled API-key dialog** (`content/apikey-dialog.xhtml`) is
   currently dead code — written but disconnected after rendering blank
   for an unknown reason on the third debugging attempt. Worth revisiting
   with actual local testing (VS Code + a real Zotero dev profile) rather
   than blind iteration over screenshots.
2. **No persistent chat history** — each time the drawer is reopened for a
   paper, conversation history resets.
3. **No streaming** — replies appear all at once after a pause.
4. **API key stored via a Tools-menu prompt, not a real preferences pane**
   — `Zotero.PreferencePanes.register()` is the documented, more standard
   approach and would also naturally solve the styled-subtext ask from
   item 1.
5. **Library search is keyword-only** (`Zotero.Search` quicksearch), not
   semantic.
6. Consider moving to a proper build setup (e.g. the
   `windingwind/zotero-plugin-template` TypeScript scaffold) once the
   plugin outgrows a single hand-edited `bootstrap.js` — trades away
   easy hand-editing for hot-reload, type safety, and `zotero-plugin-toolkit`
   convenience APIs (which also may sidestep some of the raw-DOM-injection
   bugs hit above, e.g. Bug 7's button issue).

## Debugging workflow that worked, for future reference

Whenever behavior didn't match expectations, the fastest path to a real
fix was always the same, and blind guessing without it repeatedly wasted
time:

1. Zotero → **Help → Debug Output Logging → Enable** (or "Restart Zotero to
   Debug").
2. Reproduce the exact broken action.
3. Zotero → **Help → Debug Output Logging → View Output**, search for
   `ClaudeReader`.
4. Paste the relevant lines back for diagnosis — they include our own
   `log()` calls (tagged `[ClaudeReader]`) plus any raw JS errors/stack
   traces from the plugin's own code.

Every non-cosmetic bug in this history (Bugs 2, 4, 5, 8) was solved
directly from a debug-log paste, not from guessing.
