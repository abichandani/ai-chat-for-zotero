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
    #claude-sidebar-resizer {
      position: fixed; top: 0; bottom: 0; width: 5px; cursor: col-resize;
      background: transparent; z-index: 1000000; -moz-window-dragging: no-drag;
    }
    #claude-sidebar-resizer:hover { background: #bcd6f7; }
    #claude-sidebar {
      position: fixed; top: 0; right: 0; bottom: 0;
      display: flex; flex-direction: column;
      border-left: 1px solid #cdcdcd; background: #fff; color: #222;
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12.5px;
      min-width: 240px; max-width: 70vw; z-index: 999999;
      -moz-window-dragging: no-drag;
    }
    #claude-sidebar.cr-hidden, #claude-sidebar-resizer.cr-hidden { display: none; }
    #claude-sidebar .cr-header {
      padding: 6px 8px; background: #f0f0f0; border-bottom: 1px solid #d5d5d5; color: #333;
      display: flex; justify-content: space-between; align-items: center; gap: 6px;
    }
    #claude-sidebar .cr-title {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-weight: 600;
    }
    #claude-sidebar .cr-header-btns { display: flex; gap: 2px; flex-shrink: 0; }
    #claude-sidebar .cr-header-btns [role="button"] {
      cursor: pointer; font-size: 13px; padding: 3px 7px; border-radius: 4px; color: #444;
      display: flex; align-items: center; justify-content: center;
    }
    #claude-sidebar .cr-header-btns [role="button"]:hover { background: #e2e2e2; }
    #claude-sidebar .cr-messages {
      flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px;
    }
    #claude-sidebar .cr-msg {
      padding: 6px 9px; border-radius: 8px; white-space: pre-wrap; line-height: 1.4;
      user-select: text !important; -moz-user-select: text !important; cursor: text;
    }
    #claude-sidebar .cr-msg.user { background: #eef2f8; align-self: flex-end; max-width: 85%; }
    #claude-sidebar .cr-msg.assistant { background: #f5f5f5; align-self: flex-start; max-width: 85%; }
    #claude-sidebar .cr-input-row {
      display: flex; border-top: 1px solid #d5d5d5; flex-shrink: 0; background: #fafafa;
    }
    #claude-sidebar textarea {
      flex: 1; border: none; background: transparent; padding: 8px; resize: none; height: 44px;
      font-family: inherit; font-size: 12.5px; color: #222;
    }
    #claude-sidebar textarea:focus { outline: none; }
    #claude-sidebar .cr-send {
      border: none; border-left: 1px solid #d5d5d5; background: transparent; color: #444;
      padding: 0 14px; cursor: pointer; font-weight: 600;
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    }
    #claude-sidebar .cr-send:hover { background: #eee; }
    #claude-sidebar .cr-history-list { flex: 1; overflow-y: auto; padding: 6px; }
    #claude-sidebar .cr-history-item {
      padding: 8px; border-radius: 6px; cursor: pointer; margin-bottom: 2px;
    }
    #claude-sidebar .cr-history-item:hover { background: #f0f0f0; }
    #claude-sidebar .cr-history-item .cr-hi-title {
      font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #222;
    }
    #claude-sidebar .cr-history-item .cr-hi-meta { font-size: 11px; color: #888; }
    #claude-sidebar .cr-history-empty { padding: 12px; color: #888; text-align: center; }
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
      <span class="cr-title">Claude</span>
      <div class="cr-header-btns">
        <div class="cr-new" tabindex="0" role="button" title="New chat">+</div>
        <div class="cr-history" tabindex="0" role="button" title="History">\u2630</div>
        <div class="cr-close" tabindex="0" role="button" title="Hide sidebar">\u2715</div>
      </div>
    </div>
    <div class="cr-messages"></div>
    <div class="cr-history-list" style="display:none"></div>
    <div class="cr-input-row">
      <textarea placeholder="Ask Claude\u2026"></textarea>
      <div class="cr-send" tabindex="0" role="button">Send</div>
    </div>
  `;

  anchor.appendChild(resizer);
  anchor.appendChild(sidebar);

  let titleEl = sidebar.querySelector('.cr-title');
  let messagesEl = sidebar.querySelector('.cr-messages');
  let historyListEl = sidebar.querySelector('.cr-history-list');
  let textarea = sidebar.querySelector('textarea');
  let sendBtn = sidebar.querySelector('.cr-send');
  let closeBtn = sidebar.querySelector('.cr-close');
  let newBtn = sidebar.querySelector('.cr-new');
  let historyBtn = sidebar.querySelector('.cr-history');
  let inputRow = sidebar.querySelector('.cr-input-row');

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
  }
  function clearContentPush() {
    let pushTarget = doc.getElementById('browser') || doc.body || doc.documentElement;
    pushTarget.style.marginRight = '';
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

  function renderMessages() {
    messagesEl.innerHTML = '';
    for (let m of state.chat.messages) {
      appendMsg(m.role, m.content);
    }
  }

  function appendMsg(role, text) {
    let el = doc.createElement('div');
    el.className = 'cr-msg ' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function persist() {
    state.chat.updatedAt = Date.now();
    ChatStore.upsert(state.chat);
  }

  function showChatView() {
    messagesEl.style.display = '';
    inputRow.style.display = '';
    historyListEl.style.display = 'none';
  }

  // opts: { title, system, getExtraContext(query), seedText }
  function startChat(opts) {
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
    showChatView();
    renderMessages();
    show();
    if (opts.seedText) {
      textarea.value = opts.seedText;
    }
    textarea.focus();
  }

  // Reopens a stored chat. Since the original system prompt/live context
  // (e.g. a paper's full text) isn't persisted, continuation uses a generic
  // system prompt grounded only in the saved contextLabel and prior messages.
  function openSavedChat(id) {
    let chat = ChatStore.get(id);
    if (!chat) return;
    state.chat = chat;
    state.system = 'You are Claude, continuing a previous conversation' +
      (chat.contextLabel ? ' about: ' + chat.contextLabel : '') +
      '. Use the prior messages as context.';
    state.getExtraContext = null;
    titleEl.textContent = chat.title || 'Claude';
    showChatView();
    renderMessages();
    show();
  }

  function showHistory() {
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
    inputRow.style.display = 'none';
    historyListEl.style.display = '';
    titleEl.textContent = 'History';
    show();
  }

  function startLibraryChat() {
    startChat({
      title: '',
      system: 'You are a research assistant helping search and discuss a physics Zotero library. ' +
        'Relevant items (title + abstract snippet) matching the user\'s question are provided as context when found. ' +
        'If nothing relevant was found, say so rather than inventing papers.',
      getExtraContext: async (query) => await searchLibrary(query),
    });
  }

  async function send(prefilled) {
    if (!state.chat) return;
    let text = (prefilled !== undefined ? prefilled : textarea.value).trim();
    if (!text) return;
    textarea.value = '';
    appendMsg('user', text);
    state.chat.messages.push({ role: 'user', content: text });
    if (!state.chat.title) {
      state.chat.title = text.length > 40 ? text.slice(0, 40) + '\u2026' : text;
      titleEl.textContent = state.chat.title;
    }
    persist();
    let placeholder = appendMsg('assistant', '\u2026');
    try {
      let extraContext = state.getExtraContext ? await state.getExtraContext(text) : '';
      let system = state.system + (extraContext ? `\n\nRelevant context:\n${extraContext}` : '');
      let reply = await callClaude(state.chat.messages, system);
      placeholder.textContent = reply;
      state.chat.messages.push({ role: 'assistant', content: reply });
      persist();
    } catch (e) {
      placeholder.textContent = 'Error: ' + e.message;
    }
  }

  sendBtn.addEventListener('click', () => send());
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
  btn.className = 'claude-reader-toolbar-btn';
  btn.textContent = 'Claude';
  btn.title = 'Chat with Claude about this paper';
  btn.style.cssText = 'margin-left:6px;padding:2px 10px;border-radius:4px;border:1px solid #999;background:#fff;cursor:pointer;-moz-window-dragging:no-drag;';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    let originalLabel = btn.textContent;
    btn.textContent = 'Loading\u2026';
    try {
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
          `Full text could not be extracted (the PDF may not be indexed yet \u2014 try again in a moment, ` +
          `or Zotero > right-click item > "Reindex Item"). They may paste excerpts manually in the meantime.`;

      let win = Zotero.getMainWindow ? Zotero.getMainWindow() : Zotero.getMainWindows()[0];
      mountSidebar(win).startChat({ title: 'Claude \u2014 ' + title, system });
      log('sidebar opened for: ' + title);
      btn.textContent = originalLabel;
    } catch (e) {
      log('Toolbar button click failed: ' + e + ' / ' + (e && e.stack));
      btn.textContent = 'Error \u2014 see console';
      setTimeout(() => { btn.textContent = originalLabel; }, 3000);
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
  btn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid #999;background:#fff;cursor:pointer;-moz-window-dragging:no-drag;';
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
