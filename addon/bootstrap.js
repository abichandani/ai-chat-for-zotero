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

// ---------- Chat drawer UI (reused for both PDF-context and library chat) ----------

function buildDrawer(doc, opts) {
  let existing = doc.getElementById('claude-reader-drawer');
  if (existing) {
    existing.remove();
  }

  let style = doc.getElementById('claude-reader-style');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'claude-reader-style';
    style.textContent = `
      #claude-reader-drawer {
        position: fixed; right: 12px; bottom: 12px; width: 340px; height: 460px;
        max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
        background: #fff; border: 1px solid #ccc; border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.25); z-index: 999999;
        display: flex; flex-direction: column; font-family: sans-serif; font-size: 13px;
      }
      #claude-reader-drawer .cr-header {
        padding: 8px 10px; background: #2d2d2d; color: #fff; border-radius: 8px 8px 0 0;
        display: flex; justify-content: space-between; align-items: center;
      }
      #claude-reader-drawer .cr-messages {
        flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px;
      }
      #claude-reader-drawer .cr-msg {
        padding: 6px 8px; border-radius: 6px; white-space: pre-wrap;
        user-select: text !important; -moz-user-select: text !important; cursor: text;
      }
      #claude-reader-drawer .cr-msg.user { background: #e8f0fe; align-self: flex-end; max-width: 85%; }
      #claude-reader-drawer .cr-msg.assistant { background: #f1f1f1; align-self: flex-start; max-width: 85%; }
      #claude-reader-drawer .cr-input-row { display: flex; border-top: 1px solid #ddd; }
      #claude-reader-drawer textarea {
        flex: 1; border: none; padding: 8px; resize: none; height: 44px; font-family: inherit; font-size: 13px;
      }
      #claude-reader-drawer .cr-send {
        border: none; background: #2d2d2d; color: #fff; padding: 0 14px; cursor: pointer;
        flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      }
      #claude-reader-drawer .cr-close {
        background: none; border: none; color: #fff; cursor: pointer; font-size: 14px;
        display: flex; align-items: center; justify-content: center; padding: 2px 4px;
      }
    `;
    (doc.head || doc.documentElement).appendChild(style);
  }

  let drawer = doc.createElement('div');
  drawer.id = 'claude-reader-drawer';
  drawer.innerHTML = `
    <div class="cr-header">
      <span>${opts.title}</span>
      <div class="cr-close" tabindex="0" role="button">\u2715</div>
    </div>
    <div class="cr-messages"></div>
    <div class="cr-input-row">
      <textarea placeholder="Ask Claude\u2026"></textarea>
      <div class="cr-send" tabindex="0" role="button">Send</div>
    </div>
  `;
  (doc.body || doc.documentElement).appendChild(drawer);

  let history = [];
  let messagesEl = drawer.querySelector('.cr-messages');
  let textarea = drawer.querySelector('textarea');
  let sendBtn = drawer.querySelector('.cr-send');
  let closeBtn = drawer.querySelector('.cr-close');

  closeBtn.addEventListener('click', () => drawer.remove());

  // Chat bubbles live in the chrome document (not a <browser> content area),
  // so Gecko has no cmd_copy controller wired up for their selection --
  // Ctrl+C is silently swallowed. Copy the selection to the clipboard ourselves.
  messagesEl.setAttribute('tabindex', '0');
  messagesEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      let sel = doc.getSelection().toString();
      if (sel) {
        e.preventDefault();
        Cc['@mozilla.org/widget/clipboardhelper;1']
          .getService(Ci.nsIClipboardHelper)
          .copyString(sel);
      }
    }
  });

  function appendMsg(role, text) {
    let el = doc.createElement('div');
    el.className = 'cr-msg ' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  async function send(prefilled) {
    let text = (prefilled !== undefined ? prefilled : textarea.value).trim();
    if (!text) return;
    textarea.value = '';
    appendMsg('user', text);
    history.push({ role: 'user', content: text });
    let placeholder = appendMsg('assistant', '\u2026');
    try {
      let extraContext = opts.getExtraContext ? await opts.getExtraContext(text) : '';
      let system = opts.system + (extraContext ? `\n\nRelevant context:\n${extraContext}` : '');
      let reply = await callClaude(history, system);
      placeholder.textContent = reply;
      history.push({ role: 'assistant', content: reply });
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

  if (opts.seedText) {
    textarea.value = opts.seedText;
    textarea.focus();
  }

  return drawer;
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
  btn.style.cssText = 'margin-left:6px;padding:2px 10px;border-radius:4px;border:1px solid #999;background:#fff;cursor:pointer;';
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

      buildDrawer(getMainDoc(), { title: 'Claude \u2014 ' + title, system });
      log('drawer opened for: ' + title);
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
  btn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid #999;background:#fff;cursor:pointer;';
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
      buildDrawer(doc, {
        title: 'Claude \u2014 My Library',
        system: 'You are a research assistant helping search and discuss a physics Zotero library. ' +
          'Relevant items (title + abstract snippet) matching the user\'s question are provided as context when found. ' +
          'If nothing relevant was found, say so rather than inventing papers.',
        getExtraContext: async (query) => await searchLibrary(query),
      });
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

  Zotero.ClaudeReader = { callClaude, searchLibrary, buildDrawer };
  log('startup complete');
}

function onMainWindowLoad({ window: win }) {
  addToolsMenuWithRetry(win);
}

function onMainWindowUnload({ window: win }) {
  removeToolsMenu(win);
}

function shutdown(data, reason) {
  try {
    Zotero.Reader.unregisterEventListener('renderToolbar', onReaderToolbar);
    Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', onSelectionPopup);
    for (let win of Zotero.getMainWindows()) {
      removeToolsMenu(win);
    }
  } catch (e) {}
  delete Zotero.ClaudeReader;
}

function install() {}
function uninstall() {}
