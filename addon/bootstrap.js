var PLUGIN_ID = 'ai-chat@hitesh.local';
var rootURI;

const PREF_PREFIX = 'extensions.aichat';
const PREF_PROVIDER = PREF_PREFIX + '.provider';

function log(msg) {
  try { Zotero.debug('[AIChat] ' + msg); } catch (e) { /* Zotero not ready yet */ }
}

function getMainDoc() {
  let win = Zotero.getMainWindow ? Zotero.getMainWindow() : Zotero.getMainWindows()[0];
  return win.document;
}

// ---------- Providers ----------
// Everything provider-specific lives in this registry: the wire format of a
// chat request, how a reply is unwrapped, and where the user gets a key.
// Adding OpenAI/Gemini/etc. later means adding an entry here — nothing
// outside this section knows which model is answering.

const PROVIDERS = {
  anthropic: {
    label: 'Claude',
    defaultModel: 'claude-sonnet-4-6',
    keyLabel: 'Anthropic API key (not your Claude.ai login)',
    keyHelp: 'Get one at console.anthropic.com → Settings → API Keys',
    request(apiKey, model, messages, system) {
      let body = { model, max_tokens: 1024, messages };
      if (system) body.system = system;
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body,
      };
    },
    parseReply(data) {
      if (!data || !data.content) return null;
      return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    },
  },
};

const DEFAULT_PROVIDER = 'anthropic';

function activeProviderId() {
  let id = Zotero.Prefs.get(PREF_PROVIDER, true);
  return (id && PROVIDERS[id]) ? id : DEFAULT_PROVIDER;
}

function activeProvider() {
  return PROVIDERS[activeProviderId()];
}

// Keys and models are stored per provider so switching back and forth
// doesn't lose either one.
function providerPref(id, name) {
  return PREF_PREFIX + '.' + id + '.' + name;
}

// ---------- Chat API ----------

async function callAI(messages, system) {
  let id = activeProviderId();
  let provider = PROVIDERS[id];
  let apiKey = Zotero.Prefs.get(providerPref(id, 'apiKey'), true);
  if (!apiKey) {
    throw new Error('No ' + provider.label + ' API key set. Use Tools → AI Chat: Set API Key…');
  }
  let model = Zotero.Prefs.get(providerPref(id, 'model'), true) || provider.defaultModel;
  let req = provider.request(apiKey, model, messages, system);

  let resp;
  try {
    resp = await Zotero.HTTP.request('POST', req.url, {
      headers: req.headers,
      body: JSON.stringify(req.body),
      responseType: 'json',
    });
  } catch (e) {
    // Zotero.HTTP.request throws a generic status-code error; the actual
    // reason from the provider's API is in the response body, so surface
    // that instead of just "failed with status code 400".
    let detail = '';
    try {
      // With responseType: 'json', xmlhttp.responseText throws
      // InvalidStateError; the parsed body is on .response instead.
      let parsed = e.xmlhttp && e.xmlhttp.response;
      detail = parsed && parsed.error && parsed.error.message;
    } catch (parseErr) { /* fall through to generic message */ }
    throw new Error(detail || e.message || String(e));
  }

  let reply = provider.parseReply(resp.response);
  if (reply === null || reply === undefined) {
    throw new Error('Unexpected response from ' + provider.label + ' API: ' + JSON.stringify(resp.response));
  }
  return reply;
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
    ? `You are discussing the paper "${title}" with a researcher. ` +
      `Abstract: ${abstract || '(none available)'}.\n\n` +
      `Full text of the paper (may be truncated):\n${fullText}\n\n` +
      `Answer using this text plus your general knowledge of the field. Be precise and concise. ` +
      `If asked about something not in the excerpt above, say so rather than guessing.`
    : `You are discussing the paper "${title}" with a researcher. ` +
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
  // libraryID is deliberately left unset: Zotero.Search scopes to one library
  // when it is set, which hides group libraries entirely -- and a group can
  // hold the whole collection.
  s.addCondition('quicksearch-titleCreatorYear', 'contains', query);
  let ids = await s.search();
  let items = await Zotero.Items.getAsync(ids.slice(0, limit));
  return items.map(it => {
    let title = it.getField('title') || '(untitled)';
    let abs = it.getField('abstractNote') || '';
    return `- ${title}${abs ? ': ' + abs.slice(0, 300) : ''}`;
  }).join('\n');
}

// ---------- "@" mention context ----------
// Items offered by the "@" suggestion popup and by the plus menu's
// "Add context". Titles are what a user actually recognises, so the typed
// query is matched with Zotero's own quick search over title/creator/year.

// The popup's own CSS caps the visible window to 5 rows and scrolls past
// that, so this only needs to bound how many rows exist to scroll through --
// matching the search's own internal 50-result cap below is enough.
const MENTION_LIMIT = 50;
const MAX_CONTEXT_ITEM_CHARS = 8000;
const MAX_CONTEXT_FILE_CHARS = 8000;

function mentionLabel(item) {
  let title = item.getField('title') || '(untitled)';
  let creator = item.getField('firstCreator') || '';
  let year = (item.getField('date') || '').match(/\d{4}/);
  let meta = [creator, year ? year[0] : ''].filter(Boolean).join(', ');
  return { title, meta };
}

async function searchMentionItems(query, limit = MENTION_LIMIT) {
  let s = new Zotero.Search();
  // Unscoped on purpose -- see searchLibrary(). Personal and group libraries
  // are both offered, which is why a mention has to record which one it came
  // from and not just the item key.
  if (query) {
    s.addCondition('quicksearch-titleCreatorYear', 'contains', query);
  } else {
    // Nothing typed after the "@" yet, so offer the newest items rather than
    // an empty list. A search needs at least one condition, and this one is
    // simply "everything that isn't a file attachment".
    s.addCondition('itemType', 'isNot', 'attachment');
  }
  let ids = await s.search();
  // Results come back unranked in item-id order, and ids climb with insertion,
  // so the tail of that is the most recently added.
  ids = query ? ids.slice(0, 50) : ids.slice(-50);
  let items = (await Zotero.Items.getAsync(ids)).filter(it => it.isRegularItem());
  if (!query) items.sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1));
  log('mention search "' + query + '": ' + ids.length + ' hits, ' + items.length + ' usable');
  return items.slice(0, limit);
}

// A chosen mention is written into the composer as
// "@[Title](library:2,key:ABCD2345)". The key is the item's own 8-character
// key, stable across syncs -- unlike itemID, a local rowid that differs
// between machines. Item keys are only unique within a library, so the
// library id rides along; without it a group item cannot be found again.
// The library part is optional when reading, for tokens written before it
// was recorded.
const MENTION_TOKEN = /@\[([^\]]*)\]\((?:library:(\d+),)?key:([A-Z0-9]+)\)/g;

// Titles are free text, so anything that would close the token early is
// dropped from the label. Only the library and key are load-bearing.
function mentionToken(item) {
  return '@[' + (item.getField('title') || '(untitled)').replace(/[[\]()]/g, '') +
    '](library:' + item.libraryID + ',key:' + item.key + ')';
}

function stripMentionKeys(text) {
  return text.replace(MENTION_TOKEN, '@$1');
}

function mentionedRefs(text) {
  return Array.from(text.matchAll(MENTION_TOKEN), m => ({
    libraryID: m[2] ? parseInt(m[2], 10) : Zotero.Libraries.userLibraryID,
    key: m[3],
  }));
}

// Flattens one library item into the text handed to the model: metadata plus
// the indexed full text of its best attachment, same as the reader prompt.
async function buildItemContext(item) {
  let { title } = mentionLabel(item);
  let parts = ['Title: ' + title];
  for (let [label, field] of [['Authors', 'firstCreator'], ['Date', 'date'], ['Abstract', 'abstractNote']]) {
    let val = item.getField(field);
    if (val) parts.push(label + ': ' + val);
  }
  let text = '';
  try {
    let att = await item.getBestAttachment();
    if (att) text = (await att.attachmentText) || '';
  } catch (e) {
    log('buildItemContext: attachment text failed for "' + title + '": ' + e.message);
  }
  if (text.length > MAX_CONTEXT_ITEM_CHARS) {
    text = text.slice(0, MAX_CONTEXT_ITEM_CHARS) + '\n[...truncated...]';
  }
  if (text) parts.push('Full text (may be truncated):\n' + text);
  return parts.join('\n');
}

// Only text can be attached: the chat API here takes plain-text messages, so
// a PDF or image is reported as unreadable rather than pasted in as mojibake.
async function buildFileContext(path, name) {
  let text;
  try {
    text = await Zotero.File.getContentsAsync(path);
  } catch (e) {
    return 'File "' + name + '" could not be read: ' + e.message;
  }
  // Binary files keep their NUL bytes through the UTF-8 decode, which no real
  // text file has.
  if (typeof text !== 'string' || text.slice(0, 4000).indexOf('\x00') !== -1) {
    return 'File "' + name + '" is not a text file, so its contents could not be included.';
  }
  if (text.length > MAX_CONTEXT_FILE_CHARS) {
    text = text.slice(0, MAX_CONTEXT_FILE_CHARS) + '\n[...truncated...]';
  }
  return 'File "' + name + '":\n' + text;
}

// ---------- Minimal markdown rendering ----------
// No bundled markdown library is available in a bootstrap plugin, so this
// handles just the subset models actually produce in chat replies: headers,
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

function isTableDelimiter(line) {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

// Splits one table row into cells, dropping the optional leading/trailing pipe.
function splitRow(line) {
  let s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split('|').map(c => c.trim());
}

// Zotero's window is an XHTML (XML) document, so `innerHTML` there runs the
// strict XML parser: one void tag such as <hr> makes the whole assignment
// throw and the message renders as nothing. Parsing the string as text/html
// and importing the nodes uses the real HTML parser instead.
function setRenderedHtml(el, html) {
  let doc = el.ownerDocument;
  el.textContent = '';
  let parsed = new (doc.defaultView.DOMParser)().parseFromString('<body>' + html + '</body>', 'text/html');
  for (let node of Array.from(parsed.body.childNodes)) {
    el.appendChild(doc.importNode(node, true));
  }
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
    let heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      let level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
      html.push('<hr>');
      i++;
      continue;
    }
    // GFM pipe table: a header row followed by a |---|:--:| delimiter row.
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && isTableDelimiter(lines[i + 1])) {
      flushList();
      let aligns = splitRow(lines[i + 1]).map(c => {
        let left = c.startsWith(':'), right = c.endsWith(':');
        return right ? (left ? 'center' : 'right') : (left ? 'left' : '');
      });
      let cells = (row, tag) => splitRow(row).map((c, n) => {
        let a = aligns[n] ? ` style="text-align:${aligns[n]}"` : '';
        return `<${tag}${a}>${renderInlineMarkdown(c)}</${tag}>`;
      }).join('');
      let body = [];
      let head = `<thead><tr>${cells(line, 'th')}</tr></thead>`;
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body.push(`<tr>${cells(lines[i], 'td')}</tr>`);
        i++;
      }
      html.push(`<table>${head}<tbody>${body.join('')}</tbody></table>`);
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

const PREF_CHATS = PREF_PREFIX + '.chats';
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

const PREF_SIDEBAR_WIDTH = PREF_PREFIX + '.sidebarWidth';
const DEFAULT_SIDEBAR_WIDTH = 340;
const sidebarApis = new WeakMap(); // main window -> sidebar API, one per window

function injectSidebarStyle(doc) {
  // Replace rather than skip: on a hot reload the previous build's <style> can
  // still be in the document, and keeping it would silently pin the sidebar to
  // the old stylesheet -- new rules would never apply.
  let stale = doc.getElementById('ai-chat-sidebar-style');
  if (stale) stale.remove();
  let style = doc.createElement('style');
  style.id = 'ai-chat-sidebar-style';
  style.textContent = `
    #ai-chat-sidebar, #aic-ctxmenu {
      --aic-bg: #fff; --aic-bg-alt: #f9f9f9; --aic-bg-hover: #e2e2e2; --aic-messages-bg: #fff;
      --aic-border: #cdcdcd; --aic-border-alt: #dadada; --aic-border-input: #d5d5d5;
      --aic-text: #222; --aic-text-alt: #333; --aic-text-muted: #444; --aic-text-faint: #888;
      --aic-resizer-hover: #bcd6f7;
      --aic-bubble-user: var(--aic-messages-bg); --aic-bubble-assistant: #d7eaff;
      --aic-code-bg: #eef1ee; --aic-link: #2563a8;
      --aic-input-bg: #fafafa; --aic-send-hover: #eee;
      --aic-history-odd: #f4f4f4; --aic-history-even: #e3e3e3; --aic-history-hover: #d3d3d3;
      --aic-menu-border: #ccc; --aic-menu-shadow: rgba(0,0,0,0.2); --aic-menu-disabled: #aaa;
    }
    @media (prefers-color-scheme: dark) {
      #ai-chat-sidebar, #aic-ctxmenu {
        --aic-bg: #2b2b2b; --aic-bg-alt: #272727; --aic-bg-hover: #3f3f3f; --aic-messages-bg: #323232;
        --aic-border: #4a4a4a; --aic-border-alt: #454545; --aic-border-input: #454545;
        --aic-text: #e8e8e8; --aic-text-alt: #dcdcdc; --aic-text-muted: #cfcfcf; --aic-text-faint: #9a9a9a;
        --aic-resizer-hover: #3a5a80;
        --aic-bubble-user: #262626; --aic-bubble-assistant: #1f3b57;
        --aic-code-bg: #383838; --aic-link: #6ba6e8;
        --aic-input-bg: #262626; --aic-send-hover: #3a3a3a;
        --aic-history-odd: #303030; --aic-history-even: #383838; --aic-history-hover: #444;
        --aic-menu-border: #4a4a4a; --aic-menu-shadow: rgba(0,0,0,0.5); --aic-menu-disabled: #777;
      }
    }
    #ai-chat-sidebar-resizer {
      position: fixed; top: 0; bottom: 0; width: 5px; cursor: col-resize;
      background: transparent; z-index: 1000000; -moz-window-dragging: no-drag;
    }
    #ai-chat-sidebar-resizer:hover { background: var(--aic-resizer-hover); }
    #ai-chat-sidebar {
      position: fixed; top: 0; right: 0; bottom: 0;
      display: flex; flex-direction: column;
      border-left: 1px solid var(--aic-border); background: var(--aic-bg); color: var(--aic-text);
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12.5px;
      min-width: 240px; max-width: 70vw; z-index: 999999;
      -moz-window-dragging: no-drag;
    }
    #ai-chat-sidebar.aic-hidden, #ai-chat-sidebar-resizer.aic-hidden { display: none; }
    #ai-chat-sidebar .aic-header {
      height: var(--aic-header-height, 32px); box-sizing: border-box; flex-shrink: 0;
      padding: 0 8px; background: var(--aic-bg-alt);
      border-top: 1px solid var(--aic-border-alt); border-bottom: 1px solid var(--aic-border-alt); color: var(--aic-text-alt);
      display: flex; justify-content: space-between; align-items: center; gap: 6px;
    }
    #ai-chat-sidebar .aic-title-wrap {
      display: flex; align-items: center; gap: 4px; flex: 0 1 auto; min-width: 0; overflow: hidden;
      padding: 3px 6px; border-radius: 5px; cursor: pointer;
    }
    #ai-chat-sidebar .aic-title-wrap.aic-editing { flex: 1; }
    #ai-chat-sidebar .aic-title-wrap:hover { background: var(--aic-bg-hover); }
    #ai-chat-sidebar .aic-title {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-weight: 600;
    }
    #ai-chat-sidebar .aic-title-edit-icon {
      display: none; font-size: 11px; color: var(--aic-text-muted); flex-shrink: 0;
    }
    #ai-chat-sidebar .aic-title-wrap:hover .aic-title-edit-icon { display: inline; }
    #ai-chat-sidebar .aic-title-wrap.aic-locked { cursor: default; }
    #ai-chat-sidebar .aic-title-wrap.aic-locked:hover { background: none; }
    #ai-chat-sidebar .aic-title-wrap.aic-locked:hover .aic-title-edit-icon { display: none; }
    #ai-chat-sidebar .aic-title-input {
      flex: 1; min-width: 0; font: inherit; font-weight: 600; color: var(--aic-text);
      background: var(--aic-bg); border: 1px solid #32728e; border-radius: 4px;
      padding: 1px 5px; outline: none;
      box-shadow: 0 0 0 2px rgba(50, 114, 142, 0.25);
    }
    #ai-chat-sidebar .aic-header-btns { display: flex; gap: 2px; flex-shrink: 0; }
    #ai-chat-sidebar .aic-header-btns [role="button"] {
      cursor: pointer; font-size: 18px; line-height: 1; padding: 3px 8px; border-radius: 5px; color: var(--aic-text-muted);
      display: flex; align-items: center; justify-content: center;
    }
    #ai-chat-sidebar .aic-header-btns .aic-close { font-size: 14px; }
    #ai-chat-sidebar .aic-header-btns .aic-new svg { width: 21px; height: 21px; display: block; }
    #ai-chat-sidebar .aic-header-btns .aic-history svg { width: 18px; height: 18px; display: block; }
    #ai-chat-sidebar .aic-header-btns [role="button"]:hover { background: var(--aic-bg-hover); }
    #ai-chat-sidebar .aic-messages {
      flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 13px;
      background: var(--aic-messages-bg);
    }
    #ai-chat-sidebar .aic-msg {
      padding: 6px 9px; border-radius: 8px; white-space: pre-wrap; line-height: 1.4;
      user-select: text !important; -moz-user-select: text !important; cursor: text;
      position: relative;
    }
    #ai-chat-sidebar .aic-msg.user { background: var(--aic-bubble-user); align-self: flex-end; max-width: 85%; border: 1px solid var(--aic-border); }
    #ai-chat-sidebar .aic-msg.aic-collapsible { padding-bottom: 24px; }
    #ai-chat-sidebar .aic-msg.aic-collapsed .aic-msg-body { max-height: var(--aic-collapse-max); overflow: hidden; }
    #ai-chat-sidebar .aic-msg.aic-collapsed::after {
      content: ''; position: absolute; left: 0; right: 0; top: 50%; bottom: 0;
      background: linear-gradient(to bottom, transparent, var(--aic-bubble-user));
      opacity: 0.8; pointer-events: none;
    }
    #ai-chat-sidebar .aic-msg-toggle {
      position: absolute; right: 9px; bottom: 5px; z-index: 1; font-size: 11px; font-weight: 600;
      color: var(--aic-text-muted); cursor: pointer; user-select: none; -moz-user-select: none;
      white-space: nowrap;
    }
    #ai-chat-sidebar .aic-msg-toggle:hover { text-decoration: underline; }
    #ai-chat-sidebar .aic-msg.assistant { background: var(--aic-bubble-assistant); align-self: flex-start; max-width: 95%; }
    #ai-chat-sidebar .aic-msg.assistant p { margin: 0 0 6px 0; }
    #ai-chat-sidebar .aic-msg.assistant p:last-child { margin-bottom: 0; }
    #ai-chat-sidebar .aic-msg.assistant ul, #ai-chat-sidebar .aic-msg.assistant ol { margin: 4px 0; padding-left: 20px; }
    #ai-chat-sidebar .aic-msg.assistant pre {
      background: var(--aic-code-bg); border-radius: 5px; padding: 6px 8px; overflow-x: auto;
      white-space: pre; margin: 4px 0;
    }
    #ai-chat-sidebar .aic-msg.assistant code {
      background: var(--aic-code-bg); border-radius: 3px; padding: 1px 4px; font-family: Menlo, Consolas, monospace; font-size: 11.5px;
    }
    #ai-chat-sidebar .aic-msg.assistant pre code { background: transparent; padding: 0; }
    #ai-chat-sidebar .aic-msg.assistant strong { font-weight: 700; }
    #ai-chat-sidebar .aic-msg.assistant h1, #ai-chat-sidebar .aic-msg.assistant h2,
    #ai-chat-sidebar .aic-msg.assistant h3, #ai-chat-sidebar .aic-msg.assistant h4,
    #ai-chat-sidebar .aic-msg.assistant h5, #ai-chat-sidebar .aic-msg.assistant h6 {
      margin: 10px 0 4px 0; font-weight: 700; line-height: 1.25;
    }
    #ai-chat-sidebar .aic-msg.assistant h1 { font-size: 1.45em; }
    #ai-chat-sidebar .aic-msg.assistant h2 { font-size: 1.25em; }
    #ai-chat-sidebar .aic-msg.assistant h3 { font-size: 1.1em; }
    #ai-chat-sidebar .aic-msg.assistant h4,
    #ai-chat-sidebar .aic-msg.assistant h5,
    #ai-chat-sidebar .aic-msg.assistant h6 { font-size: 1em; }
    #ai-chat-sidebar .aic-msg.assistant :first-child { margin-top: 0; }
    #ai-chat-sidebar .aic-msg.assistant hr {
      border: none; border-top: 1px solid var(--aic-border); margin: 10px 0;
    }
    #ai-chat-sidebar .aic-msg.assistant table {
      border-collapse: collapse; margin: 6px 0; font-size: 0.95em; display: block;
      overflow-x: auto; max-width: 100%;
    }
    #ai-chat-sidebar .aic-msg.assistant th, #ai-chat-sidebar .aic-msg.assistant td {
      border: 1px solid var(--aic-border); padding: 3px 7px; text-align: left;
      white-space: normal; vertical-align: top;
    }
    #ai-chat-sidebar .aic-msg.assistant th { background: var(--aic-code-bg); font-weight: 700; }
    #ai-chat-sidebar .aic-msg.assistant a { color: var(--aic-link); }
    #ai-chat-sidebar .aic-input-area {
      flex-shrink: 0; padding: 0 8px 8px 8px; background: var(--aic-messages-bg);
      position: relative;
    }
    #ai-chat-sidebar .aic-input-row {
      display: flex; flex-direction: column; flex-shrink: 0; background: var(--aic-input-bg);
      border: 1px solid var(--aic-border-input); border-radius: 10px;
      overflow: hidden; transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    #ai-chat-sidebar .aic-input-row:focus-within {
      border-color: #32728e;
      box-shadow: 0 0 0 3px rgba(50, 114, 142, 0.25), 0 0 12px rgba(50, 114, 142, 0.35);
    }
    #ai-chat-sidebar textarea {
      width: 100%; box-sizing: border-box; border: none; background: transparent;
      padding: 8px; resize: none; height: 44px; overflow-y: auto;
      font-family: inherit; font-size: 12.5px; color: var(--aic-text);
    }
    #ai-chat-sidebar textarea:focus { outline: none; }
    #ai-chat-sidebar .aic-input-actions {
      display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
      padding: 6px 8px; border-top: 1px solid var(--aic-border-input);
    }
    #ai-chat-sidebar .aic-send {
      border: 1px solid var(--aic-border-input); border-radius: 6px; background: transparent;
      color: var(--aic-text-muted); height: 26px; padding: 0 14px; box-sizing: border-box;
      cursor: pointer; font-weight: 600; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
    }
    #ai-chat-sidebar .aic-send:hover { background: var(--aic-send-hover); }
    #ai-chat-sidebar .aic-history-list { flex: 1; overflow-y: auto; padding: 6px; }
    #ai-chat-sidebar .aic-history-item {
      padding: 8px; border-radius: 6px; cursor: pointer; margin-bottom: 2px;
    }
    #ai-chat-sidebar .aic-history-item:nth-child(odd) { background: var(--aic-history-odd); }
    #ai-chat-sidebar .aic-history-item:nth-child(even) { background: var(--aic-history-even); }
    #ai-chat-sidebar .aic-history-item:hover { background: var(--aic-history-hover); }
    #ai-chat-sidebar .aic-history-item .aic-hi-title {
      font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--aic-text);
    }
    #ai-chat-sidebar .aic-history-item .aic-hi-meta { font-size: 11px; color: var(--aic-text-faint); }
    #ai-chat-sidebar .aic-history-empty { padding: 12px; color: var(--aic-text-faint); text-align: center; }
    #ai-chat-sidebar .aic-plus {
      border: none; border-radius: 6px; background: transparent; color: var(--aic-text-muted);
      width: 26px; height: 26px; box-sizing: border-box; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    #ai-chat-sidebar .aic-plus:hover { background: var(--aic-send-hover); color: var(--aic-text); }
    #ai-chat-sidebar .aic-plus svg { width: 20px; height: 20px; display: block; }
    /* Anchored to .aic-input-area, not to the button: .aic-input-row clips its
       own overflow to keep the composer's rounded corners, which would cut the
       menu off at the top edge. */
    #ai-chat-sidebar .aic-plus-menu {
      position: absolute; left: 8px; bottom: 100%; margin-bottom: 4px; display: none; z-index: 4;
      background: var(--aic-bg); border: 1px solid var(--aic-menu-border); border-radius: 10px;
      padding: 5px; min-width: 190px; box-shadow: 0 4px 14px var(--aic-menu-shadow);
      white-space: nowrap;
    }
    #ai-chat-sidebar .aic-plus-menu.aic-open { display: block; }
    #ai-chat-sidebar .aic-plus-item {
      display: flex; align-items: center; gap: 10px; padding: 7px 10px;
      border-radius: 6px; cursor: pointer; color: var(--aic-text);
    }
    #ai-chat-sidebar .aic-plus-item:hover { background: var(--aic-bg-hover); }
    #ai-chat-sidebar .aic-plus-item svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--aic-text-muted); }
    #ai-chat-sidebar .aic-suggest {
      position: absolute; left: 8px; right: 8px; bottom: 100%; margin-bottom: 4px;
      display: none; z-index: 3; background: var(--aic-bg);
      border: 1px solid var(--aic-menu-border); border-radius: 8px;
      box-shadow: 0 4px 14px var(--aic-menu-shadow); padding: 4px 0;
      /* five 28px rows plus the 4px padding -- anything beyond that scrolls */
      max-height: 148px; overflow-y: auto;
    }
    #ai-chat-sidebar .aic-suggest.aic-open { display: block; }
    #ai-chat-sidebar .aic-suggest-item {
      display: flex; align-items: center; gap: 8px; height: 28px; box-sizing: border-box;
      padding: 0 10px; cursor: pointer; color: var(--aic-text);
    }
    #ai-chat-sidebar .aic-suggest-item svg { width: 14px; height: 14px; flex-shrink: 0; color: var(--aic-text-faint); }
    #ai-chat-sidebar .aic-suggest-item.aic-active { background: var(--aic-bg-hover); font-weight: 600; }
    #ai-chat-sidebar .aic-suggest-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #ai-chat-sidebar .aic-suggest-empty {
      padding: 6px 10px; color: var(--aic-text-faint); font-size: 11.5px;
    }
    #ai-chat-sidebar .aic-suggest-meta {
      flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--aic-text-faint); font-weight: 400; font-size: 11.5px;
    }
    #ai-chat-sidebar .aic-chips {
      display: none; flex-wrap: wrap; gap: 4px; padding: 7px 8px;
      border-bottom: 1px solid var(--aic-border-input);
    }
    #ai-chat-sidebar .aic-chips.aic-open { display: flex; }
    #ai-chat-sidebar .aic-chip {
      display: flex; align-items: center; gap: 5px; max-width: 100%; box-sizing: border-box;
      background: var(--aic-bg-hover); border-radius: 5px; padding: 2px 5px 2px 7px;
      font-size: 11.5px; color: var(--aic-text);
    }
    #ai-chat-sidebar .aic-chip > svg { width: 12px; height: 12px; flex-shrink: 0; color: var(--aic-text-faint); }
    #ai-chat-sidebar .aic-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #ai-chat-sidebar .aic-chip-x { cursor: pointer; color: var(--aic-text-faint); display: flex; }
    #ai-chat-sidebar .aic-chip-x svg { width: 11px; height: 11px; }
    #ai-chat-sidebar .aic-chip-x:hover { color: var(--aic-text); }
    #aic-ctxmenu {
      position: fixed; display: none; z-index: 1000001; background: var(--aic-bg);
      border: 1px solid var(--aic-menu-border); border-radius: 6px; padding: 4px 0; min-width: 110px;
      box-shadow: 0 2px 8px var(--aic-menu-shadow);
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12.5px;
      -moz-window-dragging: no-drag;
    }
    #aic-ctxmenu .aic-ctx-item { padding: 6px 14px; cursor: pointer; color: var(--aic-text); }
    #aic-ctxmenu .aic-ctx-item:hover { background: var(--aic-bg-hover); }
    #aic-ctxmenu .aic-ctx-item.disabled { color: var(--aic-menu-disabled); cursor: default; }
    #aic-ctxmenu .aic-ctx-item.disabled:hover { background: transparent; }
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

// The reader toolbar and the sidebar header both start at the tab strip's
// bottom edge and sit side by side, so the header is sized to whatever the
// toolbar actually measures -- a hardcoded value drifts between Zotero
// versions and display scalings. Until a reader has been opened there is
// nothing to measure and the CSS fallback stands.
let readerToolbarHeight = null;

function applyHeaderHeight(doc) {
  if (!readerToolbarHeight) return;
  let sidebar = doc.getElementById('ai-chat-sidebar');
  if (sidebar) sidebar.style.setProperty('--aic-header-height', readerToolbarHeight + 'px');
}

// Plus button, its two menu entries, the chips and the suggestion rows, all
// stroked in currentColor so they follow the sidebar's light/dark palette.
// Sizing is left to CSS.
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_ATTRS = {
  viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
};

const ICON_PATHS = {
  plus: ['M8 3v10M3 8h10'],
  upload: ['M8 10.5V2.6M5 5.6 8 2.6l3 3', 'M2.5 10.8v1.7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.7'],
  doc: ['M9.3 2H4.6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V5.2z', 'M9.3 2v3.2h3.1'],
  close: ['M4.5 4.5l7 7M11.5 4.5l-7 7'],
};

// For the markup that goes in through innerHTML. The xmlns matters there: the
// sidebar lives in an XML document, where an undeclared <svg> would land in
// the wrong namespace and render nothing.
function iconMarkup(name) {
  let attrs = Object.entries(SVG_ATTRS).map(([k, v]) => k + '="' + v + '"').join(' ');
  return '<svg xmlns="' + SVG_NS + '" ' + attrs + '>' +
    ICON_PATHS[name].map(d => '<path d="' + d + '"/>').join('') + '</svg>';
}

// For icons built in script (chips, suggestion rows), where the same namespace
// rule means createElement('svg') would silently produce nothing visible.
function makeIcon(doc, name) {
  let svg = doc.createElementNS(SVG_NS, 'svg');
  for (let [k, v] of Object.entries(SVG_ATTRS)) svg.setAttribute(k, v);
  for (let d of ICON_PATHS[name]) {
    let path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
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
  let preexisting = doc.querySelectorAll('#ai-chat-sidebar').length;
  if (preexisting > 0) {
    log('mountSidebar: WARNING ' + preexisting + ' stale #ai-chat-sidebar node(s) already in DOM');
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
  resizer.id = 'ai-chat-sidebar-resizer';
  resizer.className = 'aic-hidden';

  let sidebar = doc.createElement('div');
  sidebar.id = 'ai-chat-sidebar';
  sidebar.className = 'aic-hidden';
  let savedWidth = parseInt(Zotero.Prefs.get(PREF_SIDEBAR_WIDTH, true), 10) || DEFAULT_SIDEBAR_WIDTH;
  sidebar.style.width = savedWidth + 'px';
  resizer.style.right = savedWidth + 'px';
  sidebar.innerHTML = `
    <div class="aic-header">
      <div class="aic-title-wrap" tabindex="0" role="button" title="Rename chat">
        <span class="aic-title">AI Chat</span>
        <span class="aic-title-edit-icon">✎</span>
      </div>
      <div class="aic-header-btns">
        <div class="aic-new" tabindex="0" role="button" title="New chat"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4.42h6.08v7.08h-2.41l-.05 2.03-1.45-2.03H4V8.5"/><path d="M2.4 4.5h3.2M4 2.9v3.2"/></svg></div>
        <div class="aic-history" tabindex="0" role="button" title="History"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.4V8l2.6 1.6"/></svg></div>
        <div class="aic-close" tabindex="0" role="button" title="Hide sidebar">\u2715</div>
      </div>
    </div>
    <div class="aic-messages"></div>
    <div class="aic-history-list" style="display:none"></div>
    <div class="aic-input-area">
      <div class="aic-suggest"></div>
      <div class="aic-plus-menu">
        <div class="aic-plus-item" data-action="attach">${iconMarkup('upload')}<span>Attach files</span></div>
        <div class="aic-plus-item" data-action="context">${iconMarkup('doc')}<span>Add context</span></div>
      </div>
      <div class="aic-input-row">
        <div class="aic-chips"></div>
        <textarea placeholder="Ask anything\u2026"></textarea>
        <div class="aic-input-actions">
          <div class="aic-plus" tabindex="0" role="button" title="Attach files or add context">${iconMarkup('plus')}</div>
          <div class="aic-send" tabindex="0" role="button">Send</div>
        </div>
      </div>
    </div>
  `;

  let ctxMenu = doc.createElement('div');
  ctxMenu.id = 'aic-ctxmenu';
  ctxMenu.innerHTML = `
    <div class="aic-ctx-item" data-action="cut">Cut</div>
    <div class="aic-ctx-item" data-action="copy">Copy</div>
    <div class="aic-ctx-item" data-action="paste">Paste</div>
  `;

  anchor.appendChild(resizer);
  anchor.appendChild(sidebar);
  anchor.appendChild(ctxMenu);

  let titleWrap = sidebar.querySelector('.aic-title-wrap');
  let titleEl = sidebar.querySelector('.aic-title');
  let titleInput = doc.createElement('input');
  titleInput.className = 'aic-title-input';
  titleInput.style.display = 'none';
  titleWrap.insertBefore(titleInput, sidebar.querySelector('.aic-title-edit-icon'));
  let messagesEl = sidebar.querySelector('.aic-messages');
  let historyListEl = sidebar.querySelector('.aic-history-list');
  let textarea = sidebar.querySelector('textarea');
  let sendBtn = sidebar.querySelector('.aic-send');
  let closeBtn = sidebar.querySelector('.aic-close');
  let newBtn = sidebar.querySelector('.aic-new');
  let historyBtn = sidebar.querySelector('.aic-history');
  let inputArea = sidebar.querySelector('.aic-input-area');
  let plusBtn = sidebar.querySelector('.aic-plus');
  let plusMenu = sidebar.querySelector('.aic-plus-menu');
  let suggestEl = sidebar.querySelector('.aic-suggest');
  let chipsEl = sidebar.querySelector('.aic-chips');

  // state.context is what the plus menu has attached to the current chat:
  // { path, label, textPromise } entries, resolved to prompt text on send.
  // Mentioned library items are NOT here -- those live in the message text.
  let state = { chat: null, system: '', getExtraContext: null, context: [] };

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
    applyHeaderHeight(doc);
    sidebar.classList.remove('aic-hidden');
    resizer.classList.remove('aic-hidden');
    applyContentPush();
  }
  function hide() {
    sidebar.classList.add('aic-hidden');
    resizer.classList.add('aic-hidden');
    clearContentPush();
  }
  function toggle() {
    if (sidebar.classList.contains('aic-hidden')) show(); else hide();
  }

  // Chat bubbles live in the chrome document (not a <browser> content area),
  // so Gecko has no cmd_copy controller wired up for their selection --
  // Ctrl+C is silently swallowed. Copy the selection to the clipboard
  // ourselves. Listen on the whole sidebar (capture phase) rather than just
  // .aic-messages, since a mouse-drag selection doesn't reliably move
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
    let item = e.target.closest('.aic-ctx-item');
    if (!item || item.classList.contains('disabled')) return;
    let isTextarea = ctxTarget === textarea || (ctxTarget && ctxTarget.closest && ctxTarget.closest('textarea') === textarea);
    let action = item.dataset.action;
    if (action === 'copy') {
      // For a message bubble, copy the raw text the model sent (with markdown
      // syntax intact) rather than the rendered HTML's plain text -- the
      // rendered text loses the "**"/"`"/etc that made the formatting.
      let msgEl = ctxTarget && ctxTarget.closest && ctxTarget.closest('.aic-msg');
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
      appendMsg(m.role, displayText(m));
    }
  }

  // Stored messages keep their "@[Title](key:...)" tokens so the conversation
  // stays the record of what it references, but the key is plumbing: neither
  // the reader nor the model ever sees it.
  function displayText(m) {
    return m.role === 'user' ? stripMentionKeys(m.content) : m.content;
  }

  function appendMsg(role, text) {
    let el = doc.createElement('div');
    el.className = 'aic-msg ' + role;
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
      setRenderedHtml(el, renderMarkdown(text));
    } else {
      el.textContent = '';
      let body = doc.createElement('div');
      body.className = 'aic-msg-body';
      body.textContent = text;
      el.appendChild(body);
    }
  }

  // User messages taller than this many lines start collapsed behind a
  // "See more" toggle.
  const MSG_COLLAPSE_LINES = 5;

  function lineHeightOf(el) {
    let cs = el.ownerDocument.defaultView.getComputedStyle(el);
    let lh = parseFloat(cs.lineHeight);
    if (!lh) lh = parseFloat(cs.fontSize) * 1.4;
    return lh;
  }

  function applyCollapse(el) {
    let body = el.querySelector('.aic-msg-body');
    if (!body) return;
    // Allow a sub-pixel slack so an exactly-5-line message isn't collapsed.
    let max = Math.round(lineHeightOf(body) * MSG_COLLAPSE_LINES);
    if (body.scrollHeight <= max + 1) return;
    el.style.setProperty('--aic-collapse-max', max + 'px');
    el.classList.add('aic-collapsible', 'aic-collapsed');
    let toggle = doc.createElement('div');
    toggle.className = 'aic-msg-toggle';
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('tabindex', '0');
    toggle.textContent = 'See more';
    toggle.addEventListener('click', () => {
      let collapsed = el.classList.toggle('aic-collapsed');
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
    if (titleWrap.classList.contains('aic-locked')) return;
    titleInput.value = state.chat.title || '';
    titleEl.style.display = 'none';
    titleInput.style.display = '';
    titleWrap.classList.add('aic-editing');
    titleInput.focus();
    titleInput.select();
  }

  function commitTitleEdit() {
    if (titleInput.style.display === 'none') return;
    titleInput.style.display = 'none';
    titleEl.style.display = '';
    titleWrap.classList.remove('aic-editing');
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
    titleWrap.classList.remove('aic-editing');
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
    clearContext();
    mentionCache.clear();
    hideSuggestions();
    titleEl.textContent = opts.title || 'AI Chat';
    titleWrap.classList.add('aic-locked');
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
    state.system = 'You are a research assistant, continuing a previous conversation' +
      (chat.contextLabel ? ' about: ' + chat.contextLabel : '') +
      '. Use the prior messages as context.';
    state.getExtraContext = null;
    clearContext();
    mentionCache.clear();
    hideSuggestions();
    titleEl.textContent = chat.title || 'AI Chat';
    titleWrap.classList.remove('aic-locked');
    showChatView();
    show();
    renderMessages();
  }

  function showHistory() {
    cancelTitleEdit();
    titleWrap.classList.add('aic-locked');
    let chats = ChatStore.list();
    historyListEl.innerHTML = '';
    if (!chats.length) {
      let empty = doc.createElement('div');
      empty.className = 'aic-history-empty';
      empty.textContent = 'No saved chats yet.';
      historyListEl.appendChild(empty);
    } else {
      for (let chat of chats) {
        let item = doc.createElement('div');
        item.className = 'aic-history-item';
        let titleDiv = doc.createElement('div');
        titleDiv.className = 'aic-hi-title';
        titleDiv.textContent = chat.title || '(untitled chat)';
        let metaDiv = doc.createElement('div');
        metaDiv.className = 'aic-hi-meta';
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
          title: 'AI Chat — ' + title,
          system: system + '\n\nThe user may also ask about other items in their Zotero library; ' +
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
      system: 'You are a research assistant helping search and discuss a Zotero library. ' +
        'Relevant items (title + abstract snippet) matching the user\'s question are provided as context when found. ' +
        'If nothing relevant was found, say so rather than inventing papers.',
      getExtraContext: async (query) => await searchLibrary(query),
    });
  }

  // Replaces the truncated placeholder title with a short model-generated
  // one once the first exchange is underway. Best-effort: falls back
  // silently to the placeholder set in send() if this fails.
  async function generateTitle(chat, firstMessage) {
    let title;
    try {
      title = await callAI(
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
      titleWrap.classList.remove('aic-locked');
    }
    chat.updatedAt = Date.now();
    ChatStore.upsert(chat);
  }

  // ---------- Attached context (plus menu) ----------

  function renderChips() {
    chipsEl.innerHTML = '';
    chipsEl.classList.toggle('aic-open', state.context.length > 0);
    for (let entry of state.context) {
      let chip = doc.createElement('div');
      chip.className = 'aic-chip';
      chip.title = entry.label;
      let icon = makeIcon(doc, 'upload');
      let label = doc.createElement('span');
      label.className = 'aic-chip-label';
      label.textContent = entry.label;
      let close = doc.createElement('span');
      close.className = 'aic-chip-x';
      close.setAttribute('role', 'button');
      close.setAttribute('tabindex', '0');
      close.appendChild(makeIcon(doc, 'close'));
      close.addEventListener('click', () => {
        state.context = state.context.filter(e => e !== entry);
        renderChips();
      });
      chip.appendChild(icon);
      chip.appendChild(label);
      chip.appendChild(close);
      chipsEl.appendChild(chip);
    }
    autosizeTextarea();
  }

  // Entries carry a promise rather than resolved text: reading a file takes a
  // moment and the chip should appear the instant it is picked. send() awaits
  // them, so there is no race.
  function addContext(entry) {
    state.context.push(entry);
    renderChips();
  }

  function clearContext() {
    state.context = [];
    renderChips();
  }

  async function resolveContext() {
    let blocks = [];
    for (let entry of state.context) {
      try {
        blocks.push(await entry.textPromise);
      } catch (e) {
        log('attached context "' + entry.label + '" failed: ' + e.message);
      }
    }
    return blocks.join('\n\n---\n\n');
  }

  // Every paper mentioned anywhere in the conversation, so a follow-up
  // question still has the text of a paper named several turns ago. Resolved
  // text is cached per key -- pulling a PDF's index is slow to repeat.
  const mentionCache = new Map();

  async function resolveMentions(pending) {
    let refs = [];
    for (let m of state.chat.messages) {
      if (m.role === 'user') refs.push(...mentionedRefs(m.content));
    }
    refs.push(...mentionedRefs(pending));
    let blocks = [];
    let seen = new Set();
    for (let ref of refs) {
      let id = ref.libraryID + '/' + ref.key;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!mentionCache.has(id)) {
        let item = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.key);
        if (!item) {
          log('mentioned item ' + id + ' is no longer in the library');
          continue;
        }
        mentionCache.set(id, buildItemContext(item));
      }
      try {
        blocks.push(await mentionCache.get(id));
      } catch (e) {
        log('mentioned item ' + id + ' failed to resolve: ' + e.message);
      }
    }
    return blocks.join('\n\n---\n\n');
  }

  function togglePlusMenu(open) {
    if (open === undefined) open = !plusMenu.classList.contains('aic-open');
    plusMenu.classList.toggle('aic-open', open);
  }

  plusBtn.addEventListener('click', () => togglePlusMenu());
  doc.addEventListener('mousedown', (e) => {
    if (!plusMenu.contains(e.target) && !plusBtn.contains(e.target)) togglePlusMenu(false);
  });
  plusMenu.addEventListener('click', (e) => {
    let item = e.target.closest('.aic-plus-item');
    if (!item) return;
    togglePlusMenu(false);
    if (item.dataset.action === 'attach') pickFiles();
    else insertMentionTrigger();
  });

  // nsIFilePicker.init() takes a BrowsingContext on the Gecko that Zotero 7
  // is built on, but a DOM window on older builds -- try the modern shape
  // first rather than pinning this to one Zotero version.
  function pickFiles() {
    let fp = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
    try {
      fp.init(win.browsingContext, 'Attach files', Ci.nsIFilePicker.modeOpenMultiple);
    } catch (e) {
      fp.init(win, 'Attach files', Ci.nsIFilePicker.modeOpenMultiple);
    }
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.open((rv) => {
      if (rv !== Ci.nsIFilePicker.returnOK) return;
      let files = fp.files;
      while (files.hasMoreElements()) {
        let file = files.getNext().QueryInterface(Ci.nsIFile);
        if (state.context.some(en => en.path === file.path)) continue;
        addContext({
          path: file.path,
          label: file.leafName,
          textPromise: buildFileContext(file.path, file.leafName),
        });
      }
    });
  }

  // ---------- "@" suggestions ----------

  // "Add context" is only a menu-driven entry point into the same "@" flow
  // that can be typed by hand.
  function insertMentionTrigger() {
    textarea.focus();
    let pos = textarea.selectionStart;
    let before = textarea.value.slice(0, pos);
    // Keep the "@ follows a space or the start of the input" rule the typed
    // shortcut relies on, so the popup opens either way.
    let insert = (before === '' || /\s$/.test(before)) ? '@' : ' @';
    textarea.value = before + insert + textarea.value.slice(pos);
    textarea.selectionStart = textarea.selectionEnd = pos + insert.length;
    autosizeTextarea();
    updateSuggestions();
  }

  // The mention being typed at the caret, or null if the caret isn't in one.
  // A mention starts at an "@" that itself follows the start of the input or
  // whitespace, and runs to the caret. Spaces are allowed inside it so a
  // multi-word title can be typed out; the length cap keeps an ordinary
  // sentence that happens to contain an "@" from searching forever.
  const MENTION_MAX_QUERY = 60;
  function mentionAtCaret() {
    let pos = textarea.selectionStart;
    if (pos !== textarea.selectionEnd) return null;
    let before = textarea.value.slice(0, pos);
    let at = before.lastIndexOf('@');
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(before[at - 1])) return null;
    let query = before.slice(at + 1);
    if (query.length > MENTION_MAX_QUERY || query.includes('\n')) return null;
    // A completed "@[Title](key:...)" token is a finished reference, not a query
    // still being typed, so writing on past it must not reopen the list.
    if (query.startsWith('[')) return null;
    return { start: at, query };
  }

  let suggest = { items: [], active: 0, mention: null, seq: 0 };

  function hideSuggestions() {
    suggest.items = [];
    suggest.mention = null;
    suggestEl.innerHTML = '';
    suggestEl.classList.remove('aic-open');
  }

  function renderSuggestions() {
    suggestEl.innerHTML = '';
    suggest.items.forEach((item, idx) => {
      let { title, meta } = mentionLabel(item);
      let row = doc.createElement('div');
      row.className = 'aic-suggest-item' + (idx === suggest.active ? ' aic-active' : '');
      let icon = makeIcon(doc, 'doc');
      let titleSpan = doc.createElement('span');
      titleSpan.className = 'aic-suggest-title';
      titleSpan.textContent = title;
      row.appendChild(icon);
      row.appendChild(titleSpan);
      if (meta) {
        let metaSpan = doc.createElement('span');
        metaSpan.className = 'aic-suggest-meta';
        metaSpan.textContent = meta;
        row.appendChild(metaSpan);
      }
      // mousedown, not click: the default would blur the textarea first and
      // the blur handler would close the list out from under the click.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        chooseSuggestion(idx);
      });
      suggestEl.appendChild(row);
    });
    suggestEl.classList.add('aic-open');
    // Now that the list can hold more rows than the popup's fixed-height
    // window shows, arrow-key navigation has to drag the active row back
    // into view itself -- CSS overflow alone won't follow the selection.
    let active = suggestEl.children[suggest.active];
    if (active) {
      if (active.offsetTop < suggestEl.scrollTop) {
        suggestEl.scrollTop = active.offsetTop;
      } else if (active.offsetTop + active.offsetHeight > suggestEl.scrollTop + suggestEl.clientHeight) {
        suggestEl.scrollTop = active.offsetTop + active.offsetHeight - suggestEl.clientHeight;
      }
    }
  }

  // A row shown in place of results. Without it, "no matches", "Zotero threw"
  // and "the popup cannot render at all" are indistinguishable from the
  // outside -- they all look like a list that never appears.
  function showSuggestMessage(text) {
    suggest.items = [];
    suggest.mention = null;
    suggestEl.innerHTML = '';
    let row = doc.createElement('div');
    row.className = 'aic-suggest-empty';
    row.textContent = text;
    suggestEl.appendChild(row);
    suggestEl.classList.add('aic-open');
  }

  async function updateSuggestions() {
    let mention = mentionAtCaret();
    if (!mention) {
      hideSuggestions();
      return;
    }
    let seq = ++suggest.seq;
    let query = mention.query.trim();
    log('mention lookup for "' + query + '"');
    // Everything from here on runs off an await, where a throw would otherwise
    // be an unhandled rejection and the list would just never appear.
    try {
      let items = await searchMentionItems(query);
      if (seq !== suggest.seq) return; // a later keystroke already took over
      if (!items.length) {
        showSuggestMessage(query ? 'No items match "' + query + '"' : 'No items found');
        return;
      }
      suggest.items = items;
      suggest.mention = mention;
      suggest.active = 0;
      renderSuggestions();
    } catch (e) {
      log('mention suggestions failed: ' + e + ' / ' + (e && e.stack));
      showSuggestMessage('Search failed: ' + (e && e.message ? e.message : e));
    }
  }

  function chooseSuggestion(idx) {
    let item = suggest.items[idx];
    let mention = suggest.mention;
    if (!item || !mention) return;
    // The token IS the attachment: nothing is recorded anywhere else, so
    // deleting it from the composer detaches the paper.
    let replacement = mentionToken(item) + ' ';
    let caret = textarea.selectionStart;
    textarea.value = textarea.value.slice(0, mention.start) + replacement + textarea.value.slice(caret);
    textarea.selectionStart = textarea.selectionEnd = mention.start + replacement.length;
    hideSuggestions();
    autosizeTextarea();
    textarea.focus();
  }

  async function send(prefilled) {
    if (!state.chat) return;
    let text = (prefilled !== undefined ? prefilled : textarea.value).trim();
    if (!text) return;
    hideSuggestions();
    togglePlusMenu(false);
    textarea.value = '';
    autosizeTextarea();
    let shown = stripMentionKeys(text);
    appendMsg('user', shown);
    state.chat.messages.push({ role: 'user', content: text });
    let needsTitle = !state.chat.title;
    if (needsTitle) {
      state.chat.title = shown.length > 40 ? shown.slice(0, 40) + '\u2026' : shown;
      titleEl.textContent = state.chat.title;
    }
    persist();
    if (needsTitle) generateTitle(state.chat, shown);
    let placeholder = appendMsg('assistant', '\u2026');
    try {
      let attached = await resolveContext();
      let mentioned = await resolveMentions(text);
      let extraContext = state.getExtraContext ? await state.getExtraContext(shown) : '';
      let system = state.system +
        (attached ? `\n\nThe user attached the following for reference:\n${attached}` : '') +
        (mentioned ? `\n\nThe user referenced these library items with "@":\n${mentioned}` : '') +
        (extraContext ? `\n\nRelevant context:\n${extraContext}` : '');
      let reply = await callAI(
        state.chat.messages.map(m => ({ role: m.role, content: displayText(m) })), system);
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
  textarea.addEventListener('input', () => {
    autosizeTextarea();
    updateSuggestions();
  });
  textarea.addEventListener('blur', () => hideSuggestions());
  textarea.addEventListener('keydown', (e) => {
    if (suggestEl.classList.contains('aic-open') && e.key === 'Escape') {
      e.preventDefault();
      hideSuggestions();
      return;
    }
    if (suggest.items.length) {
      let n = suggest.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        suggest.active = (suggest.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderSuggestions();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        chooseSuggestion(suggest.active);
        return;
      }
    }
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
    if (!sidebar.classList.contains('aic-hidden')) applyContentPush();
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

// A single speech bubble with one sparkle off its top-right corner, drawn in
// currentColor so it stays transparent and follows the toolbar's foreground
// colour in light and dark mode alike, the way Zotero's own toolbar icons do.
//
// Sized deliberately larger than the surrounding reader-toolbar icons: the
// glyph inks about 22px of the 24px box, leaving roughly a unit of margin all
// round. The bubble's corners are a 1.4 radius with mitred joins to keep the
// edges crisp, and the sparkle clears the bubble's inked right edge by 1.2
// units so the two never touch at render size.
const CHAT_BUBBLE_PATH =
  'M3.4 8.2H15.8A1.4 1.4 0 0 1 17.2 9.6V17.6A1.4 1.4 0 0 1 15.8 19H7.4L2 22V9.6A1.4 1.4 0 0 1 3.4 8.2Z';
const CHAT_SPARKLE_PATH =
  'M19.3 1C19.3 3.85 20.35 4.9 23.2 4.9C20.35 4.9 19.3 5.95 19.3 8.8C19.3 5.95 18.25 4.9 15.4 4.9C18.25 4.9 19.3 3.85 19.3 1Z';

const CHAT_ICON_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="miter" style="pointer-events:none;">' +
    '<path d="' + CHAT_BUBBLE_PATH + '"/>' +
    '<path d="' + CHAT_SPARKLE_PATH + '" fill="currentColor" stroke="none"/>' +
  '</svg>';

async function onReaderToolbar(event) {
  let { doc, append, reader } = event;
  let readerWin = doc.defaultView;
  // renderToolbar fires on every toolbar re-render (page changes, resizes,
  // etc.), so guard against stacking duplicate buttons on top of each other.
  if (doc.querySelector('.ai-chat-toolbar-btn')) return;

  let btn = doc.createElement('button');
  btn.className = 'ai-chat-toolbar-btn toolbar-button';
  btn.title = 'Chat with AI about this paper';
  btn.style.cssText = 'margin-left:6px;padding:2px;border-radius:4px;border:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;-moz-window-dragging:no-drag;';
  btn.innerHTML = CHAT_ICON_SVG;
  btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, currentColor 10%, transparent)'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    let originalIcon = btn.innerHTML;
    btn.textContent = '\u2026';
    try {
      let { title, system } = await buildReaderSystemPrompt(reader);

      let win = Zotero.getMainWindow ? Zotero.getMainWindow() : Zotero.getMainWindows()[0];
      mountSidebar(win).startChat({ title: 'AI Chat \u2014 ' + title, system });
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

  // Measured on the next frame: renderToolbar fires mid-render, so the
  // toolbar has no laid-out box yet at this point.
  readerWin.requestAnimationFrame(() => {
    let toolbar = btn.closest('.toolbar') || doc.querySelector('.toolbar');
    let h = toolbar && toolbar.getBoundingClientRect().height;
    if (!h) {
      log('reader toolbar height could not be measured, sidebar header keeps its default');
      return;
    }
    readerToolbarHeight = h;
    log('reader toolbar height measured: ' + h);
    let mainWin = Zotero.getMainWindow ? Zotero.getMainWindow() : Zotero.getMainWindows()[0];
    if (mainWin) applyHeaderHeight(mainWin.document);
  });
}

function onSelectionPopup(event) {
  let { doc, params, append } = event;
  let container = doc.createElement('div');
  let btn = doc.createElement('button');
  btn.textContent = 'Explain with AI';
  btn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid ButtonBorder;background:ButtonFace;color:ButtonText;cursor:pointer;-moz-window-dragging:no-drag;';
  container.appendChild(btn);
  append(container);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Asking\u2026';
    let selected = params.annotation.text || '';
    try {
      let reply = await callAI(
        [{ role: 'user', content: `Explain this passage from a paper, concisely:\n\n"${selected}"` }],
        'You are a research assistant. Be precise and concise. Use plain text, no LaTeX markup.'
      );
      container.innerHTML = '';
      let out = doc.createElement('div');
      out.style.cssText = 'max-width:320px;padding:6px;white-space:pre-wrap;font-size:12px;';
      out.textContent = reply;
      container.appendChild(out);
    } catch (e) {
      btn.textContent = 'Error \u2014 see console';
      Zotero.debug('[AIChat] ' + e.message);
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
    if (doc.getElementById('ai-chat-menu-key')) {
      return true; // already added
    }

    let mk = (tag) => (doc.createXULElement ? doc.createXULElement(tag) : doc.createElement(tag));

    let sep = mk('menuseparator');
    sep.id = 'ai-chat-sep';
    toolsMenu.appendChild(sep);

    let miKey = mk('menuitem');
    miKey.id = 'ai-chat-menu-key';
    miKey.setAttribute('label', 'AI Chat: Set API Key\u2026');
    miKey.addEventListener('command', () => {
      let id = activeProviderId();
      let provider = PROVIDERS[id];
      let keyPref = providerPref(id, 'apiKey');
      let result = { value: Zotero.Prefs.get(keyPref, true) || '' };
      let ok = Services.prompt.prompt(
        win, provider.label + ' API Key',
        'Paste your ' + provider.keyLabel + ':\n\n' + provider.keyHelp,
        result, null, {}
      );
      if (ok && result.value) {
        Zotero.Prefs.set(keyPref, result.value, true);
      }
    });
    toolsMenu.appendChild(miKey);

    let miLib = mk('menuitem');
    miLib.id = 'ai-chat-menu-lib';
    miLib.setAttribute('label', 'AI Chat: Ask About My Library\u2026');
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
  ['ai-chat-sep', 'ai-chat-menu-key', 'ai-chat-menu-lib'].forEach(id => {
    let el = doc.getElementById(id);
    if (el) el.remove();
  });
}

function removeSidebar(win) {
  let doc = win.document;
  ['ai-chat-sidebar', 'ai-chat-sidebar-resizer', 'ai-chat-sidebar-style'].forEach(id => {
    let el = doc.getElementById(id);
    if (el) el.remove();
  });
  let pushTarget = doc.getElementById('browser') || doc.body;
  if (pushTarget) pushTarget.style.marginRight = '';
  sidebarApis.delete(win);
}

// ---------- Lifecycle ----------

// One-time carry-over from the plugin's Claude-only days, when prefs lived
// under extensions.claudereader.*. Safe to delete once no install predates
// the rename.
function migrateLegacyPrefs() {
  let moves = [
    ['extensions.claudereader.apiKey', providerPref('anthropic', 'apiKey')],
    ['extensions.claudereader.model', providerPref('anthropic', 'model')],
    ['extensions.claudereader.chats', PREF_CHATS],
    ['extensions.claudereader.sidebarWidth', PREF_SIDEBAR_WIDTH],
  ];
  for (let [from, to] of moves) {
    try {
      let val = Zotero.Prefs.get(from, true);
      if (val === undefined || val === null || val === '') continue;
      if (Zotero.Prefs.get(to, true) !== undefined) continue;
      Zotero.Prefs.set(to, val, true);
      log('migrated pref ' + from + ' -> ' + to);
    } catch (e) {
      log('pref migration failed for ' + from + ': ' + e.message);
    }
  }
}

function startup({ id, version, rootURI: ru }, reason) {
  rootURI = ru;
  // Zotero, Services, Cc, and Ci are automatically injected into the
  // bootstrap scope in Zotero 7+ — no manual lookup needed or possible.

  migrateLegacyPrefs();

  Zotero.Reader.registerEventListener('renderToolbar', onReaderToolbar, PLUGIN_ID);
  Zotero.Reader.registerEventListener('renderTextSelectionPopup', onSelectionPopup, PLUGIN_ID);

  for (let win of Zotero.getMainWindows()) {
    addToolsMenuWithRetry(win);
  }

  Zotero.AIChat = { callAI, searchLibrary, mountSidebar, ChatStore, PROVIDERS, activeProviderId };
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
  delete Zotero.AIChat;
}

function install() {}
function uninstall() {}
