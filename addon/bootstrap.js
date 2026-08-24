var PLUGIN_ID = 'claude-reader@hitesh.local';
var rootURI;

const PREF_KEY = 'extensions.claudereader.apiKey';
const PREF_MODEL = 'extensions.claudereader.model';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function log(msg) {
  try { Zotero.debug('[ClaudeReader] ' + msg); } catch (e) { /* Zotero not ready yet */ }
}

function getMainDoc() {
  let win = Zotero.getMainWindow ? Zotero.getMainWindow() : Zotero.getMainWindows()[0];
  return win.document;
}

// ---------- Claude API ----------

async function callClaude(messages, system) {
  let apiKey = Zotero.Prefs.get(PREF_KEY, true);
  if (!apiKey) {
    throw new Error('No Claude API key set. Use Tools \u2192 Set Claude API Key\u2026');
  }
  let model = Zotero.Prefs.get(PREF_MODEL, true) || DEFAULT_MODEL;
  let body = {
    model,
    max_tokens: 1024,
    messages,
  };
  if (system) body.system = system;

  let resp;
  try {
    resp = await Zotero.HTTP.request('POST', 'https://api.anthropic.com/v1/messages', {
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      responseType: 'json',
    });
  } catch (e) {
    // Zotero.HTTP.request throws a generic status-code error; the actual
    // reason from Anthropic's API is in the response body, so surface that
    // instead of just "failed with status code 400".
    let detail = '';
    try {
      // With responseType: 'json', xmlhttp.responseText throws
      // InvalidStateError; the parsed body is on .response instead.
      let parsed = e.xmlhttp && e.xmlhttp.response;
      detail = parsed && parsed.error && parsed.error.message;
    } catch (parseErr) { /* fall through to generic message */ }
    throw new Error(detail || e.message || String(e));
  }

  let data = resp.response;
  if (data && data.content) {
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  throw new Error('Unexpected response from Claude API: ' + JSON.stringify(data));
}

// Full text of the PDF/HTML currently open in the reader.
// attachmentText is Zotero's own documented async getter — it returns
// the indexed text layer for the attachment (building the index on
// first access if needed). Truncated to keep token usage sane.
const MAX_FULLTEXT_CHARS = 18000;

async function getReaderFullText(itemID) {
  let item = await Zotero.Items.getAsync(itemID);
  if (!item || !item.isAttachment()) return '';
  let text = '';
  try {
    text = (await item.attachmentText) || '';
  } catch (e) {
    log('attachmentText failed: ' + e.message);
  }
  if (text.length > MAX_FULLTEXT_CHARS) {
    text = text.slice(0, MAX_FULLTEXT_CHARS) + '\n\n[...truncated...]';
  }
  return text;
}

// Reader instance for the tab currently showing in the window, or null if
// the active tab isn't a reader (e.g. My Library view).
function getActiveReader(win) {
  let tabID = win.Zotero_Tabs && win.Zotero_Tabs.selectedID;
  return tabID ? Zotero.Reader.getByTabID(tabID) : null;
}

// Builds the title + system prompt used to seed a chat about a paper
// currently open in a reader. Shared by the reader-toolbar button and any
// sidebar entry point that wants to default to the open PDF's context.
async function buildReaderSystemPrompt(reader) {
  let item = await Zotero.Items.getAsync(reader.itemID);
  let parent = item.parentID ? await Zotero.Items.getAsync(item.parentID) : item;
  let title = parent.getField('title') || 'this paper';
  let abstract = parent.getField('abstractNote') || '';
  let fullText = await getReaderFullText(reader.itemID);

  let system = fullText
    ? `You are discussing the paper "${title}" with a physics researcher. ` +
      `Abstract: ${abstract || '(none available)'}.\n\n` +
      `Full text of the paper (may be truncated):\n${fullText}\n\n` +
      `Answer using this text plus your general knowledge of the field. Be precise and concise. ` +
      `If asked about something not in the excerpt above, say so rather than guessing.`
    : `You are discussing the paper "${title}" with a physics researcher. ` +
      `Abstract: ${abstract || '(none available)'}. ` +
      `Full text could not be extracted (the PDF may not be indexed yet — try again in a moment, ` +
      `or Zotero > right-click item > "Reindex Item"). They may paste excerpts manually in the meantime.`;

  return { title, system };
}

// A very simple keyword search over the library, used to give the
// "ask about my library" chat some grounding. Not semantic search —
// just Zotero's own quick-search fields.
async function searchLibrary(query, limit = 6) {
  let s = new Zotero.Search();
  s.libraryID = Zotero.Libraries.userLibraryID;
  s.addCondition('quicksearch-titleCreatorYear', 'contains', query);
  let ids = await s.search();
  let items = await Zotero.Items.getAsync(ids.slice(0, limit));
  return items.map(it => {
    let title = it.getField('title') || '(untitled)';
    let abs = it.getField('abstractNote') || '';
    return `- ${title}${abs ? ': ' + abs.slice(0, 300) : ''}`;
  }).join('\n');
}

// ---------- Minimal markdown rendering ----------
// No bundled markdown library is available in a bootstrap plugin, so this
// handles just the subset Claude actually produces in chat replies: headers,
// bold/italic, inline code, fenced code blocks, links, and (un)ordered lists.
// Everything is HTML-escaped first so raw model output can never inject markup.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInlineMarkdown(s) {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return s;
}

function renderMarkdown(text) {
  let escaped = escapeHtml(text);
  let lines = escaped.split('\n');
  let html = [];
  let i = 0;
  let listBuf = null; // { tag, items: [] }
  function flushList() {
    if (listBuf) {
      html.push(`<${listBuf.tag}>` + listBuf.items.map(li => `<li>${renderInlineMarkdown(li)}</li>`).join('') + `</${listBuf.tag}>`);
      listBuf = null;
    }
  }
  while (i < lines.length) {
    let line = lines[i];
    let fence = line.match(/^```/);
    if (fence) {
      flushList();
      let code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      html.push('<pre><code>' + code.join('\n') + '</code></pre>');
      i++;
      continue;
    }
    let heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushList();
      let level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    let ol = line.match(/^\s*\d+\.\s+(.*)$/);
    let ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ol || ul) {
      let tag = ol ? 'ol' : 'ul';
      let content = (ol || ul)[1];
      if (!listBuf || listBuf.tag !== tag) {
        flushList();
        listBuf = { tag, items: [] };
      }
      listBuf.items.push(content);
      i++;
      continue;
    }
    flushList();
    if (line.trim() === '') {
      i++;
      continue;
    }
    html.push(`<p>${renderInlineMarkdown(line)}</p>`);
    i++;
  }
  flushList();
  return html.join('');
}

// ---------- Chat history storage ----------
// Persisted as a single JSON blob in prefs (bootstrap plugins have no
// bundled DB access). Capped so the pref blob can't grow unbounded.

const PREF_CHATS = 'extensions.claudereader.chats';
const MAX_STORED_CHATS = 50;

const ChatStore = {
  _load() {
    try {
      let raw = Zotero.Prefs.get(PREF_CHATS, true);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      log('ChatStore load failed: ' + e.message);
      return [];
    }
  },
  _save(chats) {
    chats.sort((a, b) => b.updatedAt - a.updatedAt);
    if (chats.length > MAX_STORED_CHATS) chats.length = MAX_STORED_CHATS;
    Zotero.Prefs.set(PREF_CHATS, JSON.stringify(chats), true);
  },
  list() {
    return this._load().sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get(id) {
    return this._load().find(c => c.id === id) || null;
  },
  upsert(chat) {
    let chats = this._load();
    let idx = chats.findIndex(c => c.id === chat.id);
    if (idx >= 0) chats[idx] = chat;
    else chats.push(chat);
    this._save(chats);
  },
};

function makeChatId() {
  return 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

// ---------- Docked sidebar UI (reused for both PDF-context and library chat) ----------

const PREF_SIDEBAR_WIDTH = 'extensions.claudereader.sidebarWidth';
const DEFAULT_SIDEBAR_WIDTH = 340;
const sidebarApis = new WeakMap(); // main window -> sidebar API, one per window

function injectSidebarStyle(doc) {
  if (doc.getElementById('claude-sidebar-style')) return;
  let style = doc.createElement('style');
  style.id = 'claude-sidebar-style';
  style.textContent = `
    #claude-sidebar, #cr-ctxmenu {
      --cr-bg: #fff; --cr-bg-alt: #f9f9f9; --cr-bg-hover: #e2e2e2; --cr-messages-bg: #fff;
      --cr-border: #cdcdcd; --cr-border-alt: #dadada; --cr-border-input: #d5d5d5;
      --cr-text: #222; --cr-text-alt: #333; --cr-text-muted: #444; --cr-text-faint: #888;
      --cr-resizer-hover: #bcd6f7;
      --cr-bubble-user: #d7eaff; --cr-bubble-assistant: #e7f7e9;
      --cr-code-bg: #eef1ee; --cr-link: #2563a8;
      --cr-input-bg: #fafafa; --cr-send-hover: #eee;
      --cr-history-odd: #f4f4f4; --cr-history-even: #e3e3e3; --cr-history-hover: #d3d3d3;
      --cr-menu-border: #ccc; --cr-menu-shadow: rgba(0,0,0,0.2); --cr-menu-disabled: #aaa;
    }
    @media (prefers-color-scheme: dark) {
      #claude-sidebar, #cr-ctxmenu {
        --cr-bg: #2b2b2b; --cr-bg-alt: #272727; --cr-bg-hover: #3f3f3f; --cr-messages-bg: #323232;
        --cr-border: #4a4a4a; --cr-border-alt: #454545; --cr-border-input: #454545;
        --cr-text: #e8e8e8; --cr-text-alt: #dcdcdc; --cr-text-muted: #cfcfcf; --cr-text-faint: #9a9a9a;
        --cr-resizer-hover: #3a5a80;
        --cr-bubble-user: #1f3b57; --cr-bubble-assistant: #1f3f2a;
        --cr-code-bg: #383838; --cr-link: #6ba6e8;
        --cr-input-bg: #262626; --cr-send-hover: #3a3a3a;
        --cr-history-odd: #303030; --cr-history-even: #383838; --cr-history-hover: #444;
        --cr-menu-border: #4a4a4a; --cr-menu-shadow: rgba(0,0,0,0.5); --cr-menu-disabled: #777;
      }
    }
    #claude-sidebar-resizer {
      position: fixed; top: 0; bottom: 0; width: 5px; cursor: col-resize;
      background: transparent; z-index: 1000000; -moz-window-dragging: no-drag;
    }
    #claude-sidebar-resizer:hover { background: var(--cr-resizer-hover); }
    #claude-sidebar {
      position: fixed; top: 0; right: 0; bottom: 0;
      display: flex; flex-direction: column;
      border-left: 1px solid var(--cr-border); background: var(--cr-bg); color: var(--cr-text);
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12.5px;
      min-width: 240px; max-width: 70vw; z-index: 999999;
      -moz-window-dragging: no-drag;
    }
    #claude-sidebar.cr-hidden, #claude-sidebar-resizer.cr-hidden { display: none; }
    #claude-sidebar .cr-header {
      padding: 6px 8px; background: var(--cr-bg-alt);
      border-top: 1px solid var(--cr-border-alt); border-bottom: 1px solid var(--cr-border-alt); color: var(--cr-text-alt);
      display: flex; justify-content: space-between; align-items: center; gap: 6px;
    }
    #claude-sidebar .cr-title-wrap {
      display: flex; align-items: center; gap: 4px; flex: 0 1 auto; min-width: 0; overflow: hidden;
      padding: 3px 6px; border-radius: 5px; cursor: pointer;
    }
    #claude-sidebar .cr-title-wrap.cr-editing { flex: 1; }
    #claude-sidebar .cr-title-wrap:hover { background: var(--cr-bg-hover); }
    #claude-sidebar .cr-title {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-weight: 600;
    }
    #claude-sidebar .cr-title-edit-icon {
      display: none; font-size: 11px; color: var(--cr-text-muted); flex-shrink: 0;
    }
    #claude-sidebar .cr-title-wrap:hover .cr-title-edit-icon { display: inline; }
    #claude-sidebar .cr-title-wrap.cr-locked { cursor: default; }
    #claude-sidebar .cr-title-wrap.cr-locked:hover { background: none; }
    #claude-sidebar .cr-title-wrap.cr-locked:hover .cr-title-edit-icon { display: none; }
    #claude-sidebar .cr-title-input {
      flex: 1; min-width: 0; font: inherit; font-weight: 600; color: var(--cr-text);
      background: var(--cr-bg); border: 1px solid #32728e; border-radius: 4px;
      padding: 1px 5px; outline: none;
      box-shadow: 0 0 0 2px rgba(50, 114, 142, 0.25);
    }
    #claude-sidebar .cr-header-btns { display: flex; gap: 2px; flex-shrink: 0; }
    #claude-sidebar .cr-header-btns [role="button"] {
      cursor: pointer; font-size: 18px; line-height: 1; padding: 5px 10px; border-radius: 5px; color: var(--cr-text-muted);
      display: flex; align-items: center; justify-content: center;
    }
    #claude-sidebar .cr-header-btns .cr-close { font-size: 14px; }
    #claude-sidebar .cr-header-btns [role="button"]:hover { background: var(--cr-bg-hover); }
    #claude-sidebar .cr-messages {
      flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 13px;
      background: var(--cr-messages-bg);
    }
    #claude-sidebar .cr-msg {
      padding: 6px 9px; border-radius: 8px; white-space: pre-wrap; line-height: 1.4;
      user-select: text !important; -moz-user-select: text !important; cursor: text;
      position: relative;
    }
    #claude-sidebar .cr-msg.user { background: var(--cr-bubble-user); align-self: flex-end; max-width: 85%; }
    #claude-sidebar .cr-msg.cr-collapsible { padding-bottom: 24px; }
    #claude-sidebar .cr-msg.cr-collapsed .cr-msg-body { max-height: 160px; overflow: hidden; }
    #claude-sidebar .cr-msg-toggle {
      position: absolute; right: 9px; bottom: 5px; font-size: 11px; font-weight: 600;
      color: var(--cr-text-muted); cursor: pointer; user-select: none; -moz-user-select: none;
      white-space: nowrap;
    }
    #claude-sidebar .cr-msg-toggle:hover { text-decoration: underline; }
    #claude-sidebar .cr-msg.assistant { background: var(--cr-bubble-assistant); align-self: flex-start; max-width: 85%; }
    #claude-sidebar .cr-msg.assistant p { margin: 0 0 6px 0; }
    #claude-sidebar .cr-msg.assistant p:last-child { margin-bottom: 0; }
    #claude-sidebar .cr-msg.assistant ul, #claude-sidebar .cr-msg.assistant ol { margin: 4px 0; padding-left: 20px; }
    #claude-sidebar .cr-msg.assistant pre {
      background: var(--cr-code-bg); border-radius: 5px; padding: 6px 8px; overflow-x: auto;
      white-space: pre; margin: 4px 0;
    }
    #claude-sidebar .cr-msg.assistant code {
      background: var(--cr-code-bg); border-radius: 3px; padding: 1px 4px; font-family: Menlo, Consolas, monospace; font-size: 11.5px;
    }
    #claude-sidebar .cr-msg.assistant pre code { background: transparent; padding: 0; }
    #claude-sidebar .cr-msg.assistant strong { font-weight: 700; }
    #claude-sidebar .cr-msg.assistant h1, #claude-sidebar .cr-msg.assistant h2, #claude-sidebar .cr-msg.assistant h3 {
      margin: 6px 0 4px 0; font-size: 1.05em;
    }
    #claude-sidebar .cr-msg.assistant a { color: var(--cr-link); }
    #claude-sidebar .cr-input-area {
      flex-shrink: 0; padding: 0 8px 8px 8px; background: var(--cr-messages-bg);
    }
    #claude-sidebar .cr-input-row {
      display: flex; flex-direction: column; flex-shrink: 0; background: var(--cr-input-bg);
      border: 1px solid var(--cr-border-input); border-radius: 10px;
      overflow: hidden; transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    #claude-sidebar .cr-input-row:focus-within {
      border-color: #32728e;
      box-shadow: 0 0 0 3px rgba(50, 114, 142, 0.25), 0 0 12px rgba(50, 114, 142, 0.35);
    }
    #claude-sidebar textarea {
      width: 100%; box-sizing: border-box; border: none; background: transparent;
      padding: 8px; resize: none; height: 44px; overflow-y: auto;
      font-family: inherit; font-size: 12.5px; color: var(--cr-text);
    }
    #claude-sidebar textarea:focus { outline: none; }
    #claude-sidebar .cr-input-actions {
      display: flex; justify-content: flex-end; align-items: center; flex-shrink: 0;
      padding: 6px 8px; border-top: 1px solid var(--cr-border-input);
    }
    #claude-sidebar .cr-send {
      border: 1px solid var(--cr-border-input); border-radius: 6px; background: transparent;
      color: var(--cr-text-muted); height: 26px; padding: 0 14px; box-sizing: border-box;
      cursor: pointer; font-weight: 600; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
    }
    #claude-sidebar .cr-send:hover { background: var(--cr-send-hover); }
    #claude-sidebar .cr-history-list { flex: 1; overflow-y: auto; padding: 6px; }
    #claude-sidebar .cr-history-item {
      padding: 8px; border-radius: 6px; cursor: pointer; margin-bottom: 2px;
    }
    #claude-sidebar .cr-history-item:nth-child(odd) { background: var(--cr-history-odd); }
    #claude-sidebar .cr-history-item:nth-child(even) { background: var(--cr-history-even); }
    #claude-sidebar .cr-history-item:hover { background: var(--cr-history-hover); }
    #claude-sidebar .cr-history-item .cr-hi-title {
      font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--cr-text);
    }
    #claude-sidebar .cr-history-item .cr-hi-meta { font-size: 11px; color: var(--cr-text-faint); }
    #claude-sidebar .cr-history-empty { padding: 12px; color: var(--cr-text-faint); text-align: center; }
    #cr-ctxmenu {
      position: fixed; display: none; z-index: 1000001; background: var(--cr-bg);
      border: 1px solid var(--cr-menu-border); border-radius: 6px; padding: 4px 0; min-width: 110px;
      box-shadow: 0 2px 8px var(--cr-menu-shadow);
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12.5px;
      -moz-window-dragging: no-drag;
    }
    #cr-ctxmenu .cr-ctx-item { padding: 6px 14px; cursor: pointer; color: var(--cr-text); }
    #cr-ctxmenu .cr-ctx-item:hover { background: var(--cr-bg-hover); }
    #cr-ctxmenu .cr-ctx-item.disabled { color: var(--cr-menu-disabled); cursor: default; }
    #cr-ctxmenu .cr-ctx-item.disabled:hover { background: transparent; }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

// Zotero's tab strip / custom titlebar sits above the actual content area,
// so the sidebar (and the margin pushing content over) needs to start below
// it rather than at the very top of the window. The exact chrome structure
// isn't verified against a running Zotero instance, so this tries several
// plausible candidates and logs which one (if any) matched, rather than
// hardcoding a guessed pixel value.
function getContentTopOffset(doc) {
  const candidates = [
    '#tabs-toolbar', '.tabs-toolbar', '#zotero-tabs-toolbar',
    '[role="tablist"]', '.tab-bar-container', '#titlebar',
  ];
  for (let sel of candidates) {
    let el = doc.querySelector(sel);
    if (el) {
      let rect = el.getBoundingClientRect();
      if (rect.height > 0) {
        log('getContentTopOffset: matched "' + sel + '", bottom=' + rect.bottom);
        return rect.bottom;
      }
    }
  }
  log('getContentTopOffset: no candidate selector matched, defaulting to 0 ' +
    '(sidebar will overlap the tab strip -- report this so the selector list can be fixed)');
  return 0;
}

// Mounts (once per main window) a persistent docked sidebar and returns an
// API for driving it. Idempotent -- safe to call from every entry point.
function mountSidebar(win) {
  if (sidebarApis.has(win)) {
    log('mountSidebar: reusing existing sidebar for ' + win.location.href);
    return sidebarApis.get(win);
  }
  log('mountSidebar: creating new sidebar for ' + win.location.href);

  let doc = win.document;
  let preexisting = doc.querySelectorAll('#claude-sidebar').length;
  if (preexisting > 0) {
    log('mountSidebar: WARNING ' + preexisting + ' stale #claude-sidebar node(s) already in DOM');
  }
  injectSidebarStyle(doc);
  // Appended directly to the document root -- NOT spliced into Zotero's own
  // pane/tab DOM. An earlier version anchored inside #zotero-pane's parent,
  // which broke Zotero's internal tab-switching bookkeeping (it throws from
  // its own browser-custom-element code when extra sibling nodes show up
  // there). A fixed-position panel over the document root avoids touching
  // any container Zotero itself manages.
  let anchor = doc.body || doc.documentElement;

  let resizer = doc.createElement('div');
  resizer.id = 'claude-sidebar-resizer';
  resizer.className = 'cr-hidden';

  let sidebar = doc.createElement('div');
  sidebar.id = 'claude-sidebar';
  sidebar.className = 'cr-hidden';
  let savedWidth = parseInt(Zotero.Prefs.get(PREF_SIDEBAR_WIDTH, true), 10) || DEFAULT_SIDEBAR_WIDTH;
  sidebar.style.width = savedWidth + 'px';
  resizer.style.right = savedWidth + 'px';
  sidebar.innerHTML = `
    <div class="cr-header">
      <div class="cr-title-wrap" tabindex="0" role="button" title="Rename chat">
        <span class="cr-title">Claude</span>
        <span class="cr-title-edit-icon">✎</span>
      </div>
      <div class="cr-header-btns">
        <div class="cr-new" tabindex="0" role="button" title="New chat">+</div>
        <div class="cr-history" tabindex="0" role="button" title="History">\u2630</div>
        <div class="cr-close" tabindex="0" role="button" title="Hide sidebar">\u2715</div>
      </div>
    </div>
    <div class="cr-messages"></div>
    <div class="cr-history-list" style="display:none"></div>
    <div class="cr-input-area">
      <div class="cr-input-row">
        <textarea placeholder="Ask Claude\u2026"></textarea>
        <div class="cr-input-actions">
          <div class="cr-send" tabindex="0" role="button">Send</div>
        </div>
      </div>
    </div>
  `;

  let ctxMenu = doc.createElement('div');
  ctxMenu.id = 'cr-ctxmenu';
  ctxMenu.innerHTML = `
    <div class="cr-ctx-item" data-action="cut">Cut</div>
    <div class="cr-ctx-item" data-action="copy">Copy</div>
    <div class="cr-ctx-item" data-action="paste">Paste</div>
  `;

  anchor.appendChild(resizer);
  anchor.appendChild(sidebar);
  anchor.appendChild(ctxMenu);

  let titleWrap = sidebar.querySelector('.cr-title-wrap');
  let titleEl = sidebar.querySelector('.cr-title');
  let titleInput = doc.createElement('input');
  titleInput.className = 'cr-title-input';
  titleInput.style.display = 'none';
  titleWrap.insertBefore(titleInput, sidebar.querySelector('.cr-title-edit-icon'));
  let messagesEl = sidebar.querySelector('.cr-messages');
  let historyListEl = sidebar.querySelector('.cr-history-list');
  let textarea = sidebar.querySelector('textarea');
  let sendBtn = sidebar.querySelector('.cr-send');
  let closeBtn = sidebar.querySelector('.cr-close');
  let newBtn = sidebar.querySelector('.cr-new');
  let historyBtn = sidebar.querySelector('.cr-history');
  let inputArea = sidebar.querySelector('.cr-input-area');

  let state = { chat: null, system: '', getExtraContext: null };

  // Pushes the rest of Zotero's UI over by setting a margin on #browser
  // (the hbox that actually lays out the reader/tab content -- the same box
  // Zotero's own context pane lives in as a flex sibling), rather than
  // reparenting/resizing Zotero's own elements directly (that's what broke
  // tab-switching before -- see the anchor comment above). This document has
  // no <body> (it's a XUL chrome doc), and margining the doc root wouldn't
  // resize the reader anyway since #browser is what's actually flexed.
  function applyContentPush() {
    let width = parseInt(sidebar.style.width, 10) || DEFAULT_SIDEBAR_WIDTH;
    let pushTarget = doc.getElementById('browser') || doc.body || doc.documentElement;
    pushTarget.style.marginRight = width + 'px';
    notifyReaderResize(pushTarget);
  }
  // The reader (PDF.js etc.) runs as its own web app inside a nested
  // <browser>, with its own internal split between the page view and the
  // annotations/context pane. That inner layout only re-measures on a
  // resize event dispatched on the reader browser's OWN contentWindow --
  // shrinking the outer XUL box (or dispatching resize on the top chrome
  // window) doesn't reach it, so the inner pane keeps its stale width and
  // visually spills out past the shrunk box.
  function notifyReaderResize(container) {
    for (let browserEl of container.querySelectorAll('browser')) {
      try {
        if (browserEl.contentWindow) {
          browserEl.contentWindow.dispatchEvent(new browserEl.contentWindow.Event('resize'));
        }
      } catch (e) { /* cross-process browser, can't reach contentWindow */ }
    }
  }
  function clearContentPush() {
    let pushTarget = doc.getElementById('browser') || doc.body || doc.documentElement;
    pushTarget.style.marginRight = '';
    notifyReaderResize(pushTarget);
  }

  function show() {
    let top = getContentTopOffset(doc);
    sidebar.style.top = top + 'px';
    resizer.style.top = top + 'px';
    sidebar.classList.remove('cr-hidden');
    resizer.classList.remove('cr-hidden');
    applyContentPush();
  }
  function hide() {
    sidebar.classList.add('cr-hidden');
    resizer.classList.add('cr-hidden');
    clearContentPush();
  }
  function toggle() {
    if (sidebar.classList.contains('cr-hidden')) show(); else hide();
  }

  // Chat bubbles live in the chrome document (not a <browser> content area),
  // so Gecko has no cmd_copy controller wired up for their selection --
  // Ctrl+C is silently swallowed. Copy the selection to the clipboard
  // ourselves. Listen on the whole sidebar (capture phase) rather than just
  // .cr-messages, since a mouse-drag selection doesn't reliably move
  // keyboard focus there.
  messagesEl.setAttribute('tabindex', '0');
  sidebar.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      let sel = doc.getSelection().toString();
      if (sel) {
        e.preventDefault();
        Cc['@mozilla.org/widget/clipboardhelper;1']
          .getService(Ci.nsIClipboardHelper)
          .copyString(sel);
      }
    }
  }, true);

  function copyToClipboard(text) {
    Cc['@mozilla.org/widget/clipboardhelper;1']
      .getService(Ci.nsIClipboardHelper)
      .copyString(text);
  }

  function readFromClipboard() {
    try {
      let trans = Cc['@mozilla.org/widget/transferable;1'].createInstance(Ci.nsITransferable);
      trans.init(win.docShell);
      trans.addDataFlavor('text/plain');
      Services.clipboard.getData(trans, Services.clipboard.kGlobalClipboard);
      let str = {};
      trans.getTransferData('text/plain', str);
      if (str.value) {
        return str.value.QueryInterface(Ci.nsISupportsString).data;
      }
    } catch (e) {
      log('readFromClipboard failed: ' + e.message);
    }
    return '';
  }

  // nsITransferable is finicky about the exact flavor string and load
  // context across Gecko versions, so paste is done the simple way instead:
  // move focus/caret into the textarea and let the platform's own paste
  // command run, falling back to the manual transferable read above only
  // if that's unavailable.
  function pasteIntoTextarea() {
    let start = textarea.selectionStart, end = textarea.selectionEnd;
    textarea.focus();
    textarea.selectionStart = start;
    textarea.selectionEnd = end;
    let ok = false;
    try {
      ok = doc.execCommand('paste');
    } catch (e) {
      log('execCommand paste failed: ' + e.message);
    }
    if (!ok) {
      let text = readFromClipboard();
      if (text) {
        textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + text.length;
      }
    }
    autosizeTextarea();
  }

  // Right-click context menu for the sidebar (Cut/Copy/Paste). Chat bubbles
  // are chrome-doc divs with no native context menu wired up (same reason
  // Ctrl+C needed the manual handler above), and even the textarea doesn't
  // reliably get Zotero/Firefox's own edit menu in this embedded chrome
  // context, so this provides one uniformly for both.
  let ctxTarget = null;
  function hideCtxMenu() {
    ctxMenu.style.display = 'none';
    ctxTarget = null;
  }
  function setCtxItemEnabled(action, enabled) {
    let item = ctxMenu.querySelector(`[data-action="${action}"]`);
    item.classList.toggle('disabled', !enabled);
  }
  // Selection state is captured up front, at the moment the menu opens --
  // querying it again later (e.g. from the click handler) can come back
  // empty, since focus/selection in this embedded chrome context doesn't
  // reliably survive past the initial contextmenu event.
  let ctxSelectedText = '';
  sidebar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ctxTarget = e.target;
    let isTextarea = ctxTarget === textarea || ctxTarget.closest('textarea') === textarea;
    ctxSelectedText = isTextarea
      ? textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
      : doc.getSelection().toString();
    setCtxItemEnabled('cut', isTextarea);
    setCtxItemEnabled('copy', true);
    setCtxItemEnabled('paste', isTextarea);
    // Measure before clamping -- the menu needs a size to know whether it
    // overflows the window (e.g. opened near the taskbar/bottom edge).
    ctxMenu.style.left = '0px';
    ctxMenu.style.top = '0px';
    ctxMenu.style.display = 'block';
    let menuW = ctxMenu.offsetWidth, menuH = ctxMenu.offsetHeight;
    let left = Math.min(e.clientX, win.innerWidth - menuW - 4);
    let top = Math.min(e.clientY, win.innerHeight - menuH - 4);
    ctxMenu.style.left = Math.max(0, left) + 'px';
    ctxMenu.style.top = Math.max(0, top) + 'px';
  });
  doc.addEventListener('mousedown', (e) => {
    if (ctxMenu.style.display === 'block' && !ctxMenu.contains(e.target)) hideCtxMenu();
  });
  ctxMenu.addEventListener('click', (e) => {
    let item = e.target.closest('.cr-ctx-item');
    if (!item || item.classList.contains('disabled')) return;
    let isTextarea = ctxTarget === textarea || (ctxTarget && ctxTarget.closest && ctxTarget.closest('textarea') === textarea);
    let action = item.dataset.action;
    if (action === 'copy') {
      // For a message bubble, copy the raw text Claude sent (with markdown
      // syntax intact) rather than the rendered HTML's plain text -- the
      // rendered text loses the "**"/"`"/etc that made the formatting.
      let msgEl = ctxTarget && ctxTarget.closest && ctxTarget.closest('.cr-msg');
      let text = msgEl ? msgEl.dataset.raw : (ctxSelectedText || (isTextarea ? textarea.value : '')) || '';
      if (text) copyToClipboard(text);
    } else if (action === 'cut' && isTextarea) {
      let start = textarea.selectionStart, end = textarea.selectionEnd;
      if (start !== end) {
        copyToClipboard(ctxSelectedText);
        textarea.value = textarea.value.slice(0, start) + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start;
        autosizeTextarea();
      }
      textarea.focus();
    } else if (action === 'paste' && isTextarea) {
      pasteIntoTextarea();
    }
    hideCtxMenu();
  });

  function renderMessages() {
    messagesEl.innerHTML = '';
    for (let m of state.chat.messages) {
      appendMsg(m.role, m.content);
    }
  }

  function appendMsg(role, text) {
    let el = doc.createElement('div');
    el.className = 'cr-msg ' + role;
    setMsgContent(el, role, text);
    messagesEl.appendChild(el);
    // Overflow can only be measured once the bubble is laid out, so the
    // See more / See less affordance is attached after insertion.
    if (role === 'user') applyCollapse(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function setMsgContent(el, role, text) {
    el.dataset.raw = text;
    if (role === 'assistant') {
      el.innerHTML = renderMarkdown(text);
    } else {
      el.textContent = '';
      let body = doc.createElement('div');
      body.className = 'cr-msg-body';
      body.textContent = text;
      el.appendChild(body);
    }
  }

  // Long user messages start collapsed behind a "See more" toggle. Must match
  // the max-height of .cr-msg.cr-collapsed .cr-msg-body in the stylesheet.
  const MSG_COLLAPSE_MAX = 160;

  function applyCollapse(el) {
    let body = el.querySelector('.cr-msg-body');
    if (!body || body.scrollHeight <= MSG_COLLAPSE_MAX) return;
    el.classList.add('cr-collapsible', 'cr-collapsed');
    let toggle = doc.createElement('div');
    toggle.className = 'cr-msg-toggle';
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('tabindex', '0');
    toggle.textContent = 'See more';
    toggle.addEventListener('click', () => {
      let collapsed = el.classList.toggle('cr-collapsed');
      toggle.textContent = collapsed ? 'See more' : 'See less';
    });
    el.appendChild(toggle);
  }

  function persist() {
    state.chat.updatedAt = Date.now();
    ChatStore.upsert(state.chat);
  }

  function beginTitleEdit() {
    if (!state.chat || historyListEl.style.display !== 'none') return;
    if (titleWrap.classList.contains('cr-locked')) return;
    titleInput.value = state.chat.title || '';
    titleEl.style.display = 'none';
    titleInput.style.display = '';
    titleWrap.classList.add('cr-editing');
    titleInput.focus();
    titleInput.select();
  }

  function commitTitleEdit() {
    if (titleInput.style.display === 'none') return;
    titleInput.style.display = 'none';
    titleEl.style.display = '';
    titleWrap.classList.remove('cr-editing');
    if (!state.chat) return;
    let val = titleInput.value.trim();
    if (val && val !== state.chat.title) {
      state.chat.title = val;
      titleEl.textContent = val;
      persist();
    }
  }

  function cancelTitleEdit() {
    titleInput.style.display = 'none';
    titleEl.style.display = '';
    titleWrap.classList.remove('cr-editing');
  }

  titleWrap.addEventListener('click', beginTitleEdit);
  titleInput.addEventListener('click', (e) => e.stopPropagation());
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitTitleEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelTitleEdit(); }
  });
  titleInput.addEventListener('blur', commitTitleEdit);

  function showChatView() {
    messagesEl.style.display = '';
    inputArea.style.display = '';
    historyListEl.style.display = 'none';
  }

  // opts: { title, system, getExtraContext(query), seedText }
  function startChat(opts) {
    cancelTitleEdit();
    state.chat = {
      id: makeChatId(),
      title: opts.title || '',
      contextLabel: opts.title || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.system = opts.system || '';
    state.getExtraContext = opts.getExtraContext || null;
    titleEl.textContent = opts.title || 'Claude';
    titleWrap.classList.add('cr-locked');
    showChatView();
    show();
    renderMessages();
    if (opts.seedText) {
      textarea.value = opts.seedText;
    }
    autosizeTextarea();
    textarea.focus();
  }

  // Reopens a stored chat. Since the original system prompt/live context
  // (e.g. a paper's full text) isn't persisted, continuation uses a generic
  // system prompt grounded only in the saved contextLabel and prior messages.
  function openSavedChat(id) {
    let chat = ChatStore.get(id);
    if (!chat) return;
    cancelTitleEdit();
    state.chat = chat;
    state.system = 'You are Claude, continuing a previous conversation' +
      (chat.contextLabel ? ' about: ' + chat.contextLabel : '') +
      '. Use the prior messages as context.';
    state.getExtraContext = null;
    titleEl.textContent = chat.title || 'Claude';
    titleWrap.classList.remove('cr-locked');
    showChatView();
    show();
    renderMessages();
  }

  function showHistory() {
    cancelTitleEdit();
    titleWrap.classList.add('cr-locked');
    let chats = ChatStore.list();
    historyListEl.innerHTML = '';
    if (!chats.length) {
      let empty = doc.createElement('div');
      empty.className = 'cr-history-empty';
      empty.textContent = 'No saved chats yet.';
      historyListEl.appendChild(empty);
    } else {
      for (let chat of chats) {
        let item = doc.createElement('div');
        item.className = 'cr-history-item';
        let titleDiv = doc.createElement('div');
        titleDiv.className = 'cr-hi-title';
        titleDiv.textContent = chat.title || '(untitled chat)';
        let metaDiv = doc.createElement('div');
        metaDiv.className = 'cr-hi-meta';
        metaDiv.textContent = (chat.contextLabel ? chat.contextLabel + ' \u00b7 ' : '') +
          new Date(chat.updatedAt).toLocaleString();
        item.appendChild(titleDiv);
        item.appendChild(metaDiv);
        item.addEventListener('click', () => openSavedChat(chat.id));
        historyListEl.appendChild(item);
      }
    }
    messagesEl.style.display = 'none';
    inputArea.style.display = 'none';
    historyListEl.style.display = '';
    titleEl.textContent = 'History';
    show();
  }

  async function startLibraryChat() {
    let reader = getActiveReader(win);
    if (reader) {
      try {
        let { title, system } = await buildReaderSystemPrompt(reader);
        startChat({
          title: 'Claude — ' + title,
          system: system + '\n\nThe user may also ask about other items in their physics Zotero library; ' +
            'relevant items (title + abstract snippet) matching the question are provided as extra context when found.',
          getExtraContext: async (query) => await searchLibrary(query),
        });
        return;
      } catch (e) {
        log('startLibraryChat: reader context failed, falling back to library chat: ' + e.message);
      }
    }
    startChat({
      title: '',
      system: 'You are a research assistant helping search and discuss a physics Zotero library. ' +
        'Relevant items (title + abstract snippet) matching the user\'s question are provided as context when found. ' +
        'If nothing relevant was found, say so rather than inventing papers.',
      getExtraContext: async (query) => await searchLibrary(query),
    });
  }

  // Replaces the truncated placeholder title with a short Claude-generated
  // one once the first exchange is underway. Best-effort: falls back
  // silently to the placeholder set in send() if this fails.
  async function generateTitle(chat, firstMessage) {
    let title;
    try {
      title = await callClaude(
        [{ role: 'user', content: firstMessage }],
        'Summarize the subject of this message in 4-5 words for use as a chat title. ' +
          'Reply with only the title, no punctuation at the end, no quotes.'
      );
    } catch (e) {
      return;
    }
    title = title.trim();
    if (!title) return;
    // The chat may have been renamed by hand, switched away from, or
    // deleted while the request was in flight — don't clobber any of that.
    if (chat.title !== firstMessage && !chat.title.startsWith(firstMessage.slice(0, 40))) return;
    chat.title = title;
    if (state.chat === chat) {
      titleEl.textContent = title;
      titleWrap.classList.remove('cr-locked');
    }
    chat.updatedAt = Date.now();
    ChatStore.upsert(chat);
  }

  async function send(prefilled) {
    if (!state.chat) return;
    let text = (prefilled !== undefined ? prefilled : textarea.value).trim();
    if (!text) return;
    textarea.value = '';
    autosizeTextarea();
    appendMsg('user', text);
    state.chat.messages.push({ role: 'user', content: text });
    let needsTitle = !state.chat.title;
    if (needsTitle) {
      state.chat.title = text.length > 40 ? text.slice(0, 40) + '\u2026' : text;
      titleEl.textContent = state.chat.title;
    }
    persist();
    if (needsTitle) generateTitle(state.chat, text);
    let placeholder = appendMsg('assistant', '\u2026');
    try {
      let extraContext = state.getExtraContext ? await state.getExtraContext(text) : '';
      let system = state.system + (extraContext ? `\n\nRelevant context:\n${extraContext}` : '');
      let reply = await callClaude(state.chat.messages, system);
      setMsgContent(placeholder, 'assistant', reply);
      state.chat.messages.push({ role: 'assistant', content: reply });
      persist();
    } catch (e) {
      placeholder.textContent = 'Error: ' + e.message;
    }
  }

  // Grows the input with its content, up to 35% of the sidebar height; past
  // that the textarea scrolls internally.
  const TEXTAREA_MIN_HEIGHT = 44;
  function autosizeTextarea() {
    textarea.style.height = 'auto';
    let max = Math.max(TEXTAREA_MIN_HEIGHT, Math.round(sidebar.clientHeight * 0.35));
    let next = Math.min(Math.max(textarea.scrollHeight, TEXTAREA_MIN_HEIGHT), max);
    textarea.style.height = next + 'px';
  }

  sendBtn.addEventListener('click', () => send());
  textarea.addEventListener('input', autosizeTextarea);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  closeBtn.addEventListener('click', () => hide());
  newBtn.addEventListener('click', () => startLibraryChat());
  historyBtn.addEventListener('click', () => showHistory());

  // Drag-resize (both elements are position:fixed against the viewport, not
  // laid out via flex, so width and the resizer's offset are both set directly).
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
  });
  doc.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    let newWidth = Math.max(240, Math.min(win.innerWidth * 0.7, win.innerWidth - e.clientX));
    sidebar.style.width = newWidth + 'px';
    resizer.style.right = newWidth + 'px';
    if (!sidebar.classList.contains('cr-hidden')) applyContentPush();
  });
  doc.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    Zotero.Prefs.set(PREF_SIDEBAR_WIDTH, parseInt(sidebar.style.width, 10), true);
  });

  let api = { show, hide, toggle, startChat, startLibraryChat, openSavedChat, showHistory };
  sidebarApis.set(win, api);
  return api;
}

// ---------- Reader hooks ----------

async function onReaderToolbar(event) {
  let { doc, append, reader } = event;
  // renderToolbar fires on every toolbar re-render (page changes, resizes,
  // etc.), so guard against stacking duplicate buttons on top of each other.
  if (doc.querySelector('.claude-reader-toolbar-btn')) return;

  let btn = doc.createElement('button');
  btn.className = 'claude-reader-toolbar-btn toolbar-button';
  btn.title = 'Chat with Claude about this paper';
  btn.style.cssText = 'margin-left:6px;padding:4px;border-radius:4px;border:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;-moz-window-dragging:no-drag;';
  let icon = doc.createElement('img');
  icon.src = 'data:image/png;base64,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';
  icon.style.cssText = 'width:24px;height:24px;';
  btn.appendChild(icon);
  btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, currentColor 10%, transparent)'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    let originalIcon = btn.innerHTML;
    btn.textContent = '\u2026';
    try {
      let { title, system } = await buildReaderSystemPrompt(reader);

      let win = Zotero.getMainWindow ? Zotero.getMainWindow() : Zotero.getMainWindows()[0];
      mountSidebar(win).startChat({ title: 'Claude \u2014 ' + title, system });
      log('sidebar opened for: ' + title);
      btn.innerHTML = originalIcon;
    } catch (e) {
      log('Toolbar button click failed: ' + e + ' / ' + (e && e.stack));
      btn.title = 'Error \u2014 see console';
      btn.innerHTML = originalIcon;
    } finally {
      btn.disabled = false;
    }
  });
  append(btn);
}

function onSelectionPopup(event) {
  let { doc, params, append } = event;
  let container = doc.createElement('div');
  let btn = doc.createElement('button');
  btn.textContent = 'Explain with Claude';
  btn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid ButtonBorder;background:ButtonFace;color:ButtonText;cursor:pointer;-moz-window-dragging:no-drag;';
  container.appendChild(btn);
  append(container);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Asking Claude\u2026';
    let selected = params.annotation.text || '';
    try {
      let reply = await callClaude(
        [{ role: 'user', content: `Explain this passage from a physics paper, concisely:\n\n"${selected}"` }],
        'You are a physics research assistant. Be precise and concise. Use plain text, no LaTeX markup.'
      );
      container.innerHTML = '';
      let out = doc.createElement('div');
      out.style.cssText = 'max-width:320px;padding:6px;white-space:pre-wrap;font-size:12px;';
      out.textContent = reply;
      container.appendChild(out);
    } catch (e) {
      btn.textContent = 'Error \u2014 see console';
      Zotero.debug('[ClaudeReader] ' + e.message);
    }
  });
}

// ---------- Tools menu (API key + library chat) ----------

function addToolsMenu(win) {
  try {
    let doc = win.document;
    let toolsMenu = doc.getElementById('menu_ToolsPopup');
    if (!toolsMenu) {
      log('menu_ToolsPopup not found yet on this window, will retry');
      return false;
    }
    if (doc.getElementById('claude-reader-menu-key')) {
      return true; // already added
    }

    let mk = (tag) => (doc.createXULElement ? doc.createXULElement(tag) : doc.createElement(tag));

    let sep = mk('menuseparator');
    sep.id = 'claude-reader-sep';
    toolsMenu.appendChild(sep);

    let miKey = mk('menuitem');
    miKey.id = 'claude-reader-menu-key';
    miKey.setAttribute('label', 'Set Claude API Key\u2026');
    miKey.addEventListener('command', () => {
      let result = { value: Zotero.Prefs.get(PREF_KEY, true) || '' };
      let ok = Services.prompt.prompt(
        win, 'Claude API Key',
        'Paste your Anthropic API key (not your Claude.ai login):\n\nGet one at console.anthropic.com \u2192 Settings \u2192 API Keys',
        result, null, {}
      );
      if (ok && result.value) {
        Zotero.Prefs.set(PREF_KEY, result.value, true);
      }
    });
    toolsMenu.appendChild(miKey);

    let miLib = mk('menuitem');
    miLib.id = 'claude-reader-menu-lib';
    miLib.setAttribute('label', 'Ask Claude about My Library\u2026');
    miLib.addEventListener('command', () => {
      mountSidebar(win).startLibraryChat();
    });
    toolsMenu.appendChild(miLib);

    log('Tools menu items added successfully');
    return true;
  } catch (e) {
    log('addToolsMenu failed: ' + e + ' / ' + e.stack);
    return false;
  }
}

// The Tools menu may not exist yet at the moment startup() runs (main
// window still loading), and new main windows can open later too, so
// we retry on a short interval and also watch for new windows.
function addToolsMenuWithRetry(win, attemptsLeft = 10) {
  if (addToolsMenu(win)) return;
  if (attemptsLeft <= 0) {
    log('Gave up adding Tools menu after repeated retries');
    return;
  }
  win.setTimeout(() => addToolsMenuWithRetry(win, attemptsLeft - 1), 500);
}

function removeToolsMenu(win) {
  let doc = win.document;
  ['claude-reader-sep', 'claude-reader-menu-key', 'claude-reader-menu-lib'].forEach(id => {
    let el = doc.getElementById(id);
    if (el) el.remove();
  });
}

function removeSidebar(win) {
  let doc = win.document;
  ['claude-sidebar', 'claude-sidebar-resizer', 'claude-sidebar-style'].forEach(id => {
    let el = doc.getElementById(id);
    if (el) el.remove();
  });
  let pushTarget = doc.getElementById('browser') || doc.body;
  if (pushTarget) pushTarget.style.marginRight = '';
  sidebarApis.delete(win);
}

// ---------- Lifecycle ----------

function startup({ id, version, rootURI: ru }, reason) {
  rootURI = ru;
  // Zotero, Services, Cc, and Ci are automatically injected into the
  // bootstrap scope in Zotero 7+ — no manual lookup needed or possible.

  Zotero.Reader.registerEventListener('renderToolbar', onReaderToolbar, PLUGIN_ID);
  Zotero.Reader.registerEventListener('renderTextSelectionPopup', onSelectionPopup, PLUGIN_ID);

  for (let win of Zotero.getMainWindows()) {
    addToolsMenuWithRetry(win);
  }

  Zotero.ClaudeReader = { callClaude, searchLibrary, mountSidebar, ChatStore };
  log('startup complete');
}

function onMainWindowLoad({ window: win }) {
  addToolsMenuWithRetry(win);
}

function onMainWindowUnload({ window: win }) {
  removeToolsMenu(win);
  removeSidebar(win);
}

function shutdown(data, reason) {
  try {
    Zotero.Reader.unregisterEventListener('renderToolbar', onReaderToolbar);
    Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', onSelectionPopup);
    for (let win of Zotero.getMainWindows()) {
      removeToolsMenu(win);
      removeSidebar(win);
    }
  } catch (e) {}
  delete Zotero.ClaudeReader;
}

function install() {}
function uninstall() {}
