// ── State ─────────────────────────────────────────────────
let currentConvId  = null;
let isLoading      = false;
let selectedSkill  = null;   // { name, description }
let allSkills      = [];     // cached skill list
const clientProcs  = new Map(); // procId -> { id, prompt, startMs }

// ── DOM refs ──────────────────────────────────────────────
const procListEl    = document.getElementById('procList');
const convListEl    = document.getElementById('conversationList');
const messagesEl    = document.getElementById('messages');
const welcomeEl     = document.getElementById('welcome');
const inputEl       = document.getElementById('messageInput');
const sendBtn       = document.getElementById('sendBtn');
const newChatBtn    = document.getElementById('newChatBtn');
const termBody      = document.getElementById('termBody');
const termClearBtn  = document.getElementById('termClearBtn');
const resizerEl     = document.getElementById('resizer');
const termPanel     = document.getElementById('terminalPanel');

// Skill picker — created dynamically
let skillPickerEl = null;

// ── Boot ──────────────────────────────────────────────────
async function init() {
  await loadConversations();
  connectMonitor();
  initResizer();
  initSkillPicker();
  setInterval(() => { if (clientProcs.size > 0) renderProcList(); }, 1000);

  newChatBtn.addEventListener('click', startNewChat);
  sendBtn.addEventListener('click', sendMessage);
  termClearBtn.addEventListener('click', () => { termBody.innerHTML = ''; });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideSkillPicker(); return; }
    if (skillPickerEl && !skillPickerEl.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); movePicker(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); movePicker(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const active = skillPickerEl.querySelector('.skill-item.active');
        if (active) { e.preventDefault(); selectSkill(active.dataset.name, active.dataset.desc); return; }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
    handleSkillTrigger();
  });

  inputEl.focus();
}

// ── Skill picker ──────────────────────────────────────────
async function initSkillPicker() {
  try { allSkills = await api('/api/skills'); } catch { allSkills = []; }

  skillPickerEl = document.createElement('div');
  skillPickerEl.className = 'skill-picker hidden';
  // Insert inside .input-inner so absolute position is relative to it
  inputEl.closest('.input-inner').appendChild(skillPickerEl);

  document.addEventListener('click', (e) => {
    if (!skillPickerEl.contains(e.target) && e.target !== inputEl) hideSkillPicker();
  });
}

function handleSkillTrigger() {
  const val = inputEl.value;
  const slashIdx = val.lastIndexOf('/');
  if (slashIdx === -1) { hideSkillPicker(); return; }

  // Only trigger if '/' is at start or after whitespace
  const before = val.slice(0, slashIdx);
  if (before.length > 0 && !/\s$/.test(before)) { hideSkillPicker(); return; }

  const query = val.slice(slashIdx + 1).toLowerCase();
  const filtered = allSkills.filter(s =>
    s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)
  );

  if (!filtered.length) { hideSkillPicker(); return; }
  showSkillPicker(filtered, slashIdx);
}

function showSkillPicker(skills, slashIdx) {
  skillPickerEl.innerHTML = skills.map((s, i) => `
    <div class="skill-item ${i === 0 ? 'active' : ''}"
         data-name="${esc(s.name)}" data-desc="${esc(s.description)}"
         onclick="selectSkill('${esc(s.name)}','${esc(s.description)}')">
      <span class="skill-name">/${esc(s.name)}</span>
      <span class="skill-desc">${esc(s.description.slice(0, 60))}</span>
    </div>
  `).join('');
  skillPickerEl.dataset.slashIdx = slashIdx;
  skillPickerEl.classList.remove('hidden');
}

function hideSkillPicker() {
  if (skillPickerEl) skillPickerEl.classList.add('hidden');
}

function movePicker(dir) {
  const items = [...skillPickerEl.querySelectorAll('.skill-item')];
  const cur = items.findIndex(i => i.classList.contains('active'));
  items[cur]?.classList.remove('active');
  items[(cur + dir + items.length) % items.length]?.classList.add('active');
}

function selectSkill(name, desc) {
  const slashIdx = Number(skillPickerEl.dataset.slashIdx ?? 0);
  const before = inputEl.value.slice(0, slashIdx);
  inputEl.value = before + '/' + name + ' ';
  selectedSkill = { name, desc };
  hideSkillPicker();
  inputEl.focus();
  // Show pill
  renderSkillPill();
}

function renderSkillPill() {
  document.querySelector('.skill-pill')?.remove();
  if (!selectedSkill) return;
  const pill = document.createElement('div');
  pill.className = 'skill-pill';
  pill.innerHTML = `<span>🔧 ${esc(selectedSkill.name)}</span><button onclick="clearSkill()">✕</button>`;
  const inner = inputEl.closest('.input-inner');
  inner.insertBefore(pill, inner.querySelector('.input-wrapper'));
}

function clearSkill() {
  selectedSkill = null;
  document.querySelector('.skill-pill')?.remove();
  // Remove /skillname from input
  inputEl.value = inputEl.value.replace(/^\/[\w-]+\s*/, '');
  inputEl.focus();
}

// ── PTY Monitor (SSE) ─────────────────────────────────────
function connectMonitor() {
  const es = new EventSource('/api/monitor');

  es.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data.tag === 'PROC') {
      if (data.action === 'start') {
        clientProcs.set(data.id, { id: data.id, prompt: data.prompt, startMs: Date.now() });
      } else if (data.action === 'end') {
        clientProcs.delete(data.id);
      }
      renderProcList();
      return; // don't show PROC events in the terminal log
    }
    appendTermLine(data);
  };

  es.onerror = () => {
    appendTermLine({ ts: now(), tag: 'ERR', msg: 'monitor stream disconnected — retrying…' });
  };
}

function renderProcList() {
  if (!clientProcs.size) {
    procListEl.innerHTML = '<div class="proc-empty">No active processes</div>';
    return;
  }
  const now = Date.now();
  procListEl.innerHTML = [...clientProcs.values()].map(p => {
    const elapsed = ((now - p.startMs) / 1000).toFixed(0);
    return `<div class="proc-item">
      <div class="proc-dot"></div>
      <span class="proc-prompt">${esc(p.prompt)}</span>
      <span class="proc-elapsed">${elapsed}s</span>
    </div>`;
  }).join('');
}

function appendTermLine(data) {
  const { ts = '--:--:--', tag = 'INFO', ...rest } = data;
  delete rest.tag; delete rest.ts;

  const tagClass = tag.toLowerCase();
  const div = document.createElement('div');
  div.className = `term-line ${tagClass}`;

  // Build key=value text with syntax highlighting
  const pairs = Object.entries(rest).map(([k, v]) => {
    const vStr = typeof v === 'string'
      ? `<span class="term-kv-str">${esc(JSON.stringify(v))}</span>`
      : typeof v === 'number'
        ? `<span class="term-kv-num">${v}</span>`
        : typeof v === 'boolean'
          ? `<span class="term-kv-bool">${v}</span>`
          : `<span class="term-kv-val">${esc(String(v))}</span>`;
    return `<span class="term-kv-key">${esc(k)}</span>=<span>${vStr}</span>`;
  }).join('  ');

  div.innerHTML = `
    <span class="term-ts">${esc(ts)}</span>
    <span class="term-tag tag-${tagClass}">${esc(tag)}</span>
    <span class="term-text">${pairs}</span>
  `;

  termBody.appendChild(div);
  termBody.scrollTop = termBody.scrollHeight;
}

function now() { return new Date().toISOString().slice(11, 23); }

// ── Drag resizer ──────────────────────────────────────────
function initResizer() {
  let startX, startW;

  resizerEl.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = termPanel.offsetWidth;
    resizerEl.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizerEl.classList.contains('dragging')) return;
    const delta = startX - e.clientX;
    const newW  = Math.min(700, Math.max(240, startW + delta));
    termPanel.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    resizerEl.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── Conversation list ─────────────────────────────────────
async function loadConversations() {
  const list = await api('/api/conversations');
  renderConvList(list);
}

function renderConvList(list) {
  if (!list.length) {
    convListEl.innerHTML = '<div class="empty-state">No conversations yet<br>Start a new chat</div>';
    return;
  }
  convListEl.innerHTML = list.map(c => /* html */`
    <div class="conv-item ${c.id === currentConvId ? 'active' : ''}"
         data-id="${c.id}" onclick="openConversation('${c.id}')">
      <div class="conv-item-title">${esc(c.title)}</div>
      <div class="conv-item-meta">${relativeTime(c.updatedAt)} &middot; ${c.messageCount} msg</div>
      <button class="conv-delete-btn" onclick="deleteConversation(event,'${c.id}')" title="Delete">✕</button>
    </div>
  `).join('');
}

async function openConversation(id) {
  if (isLoading) return;
  currentConvId = id;
  const conv = await api(`/api/conversations/${id}`);
  showMessages();
  messagesEl.innerHTML = '';
  for (const msg of conv.messages) renderMessage(msg.role, msg.content);
  scrollBottom();
  await loadConversations();
}

async function deleteConversation(e, id) {
  e.stopPropagation();
  if (!confirm('Delete this conversation?')) return;
  await api(`/api/conversations/${id}`, { method: 'DELETE' });
  if (currentConvId === id) startNewChat();
  else await loadConversations();
}

function startNewChat() {
  currentConvId = null;
  messagesEl.innerHTML = '';
  showWelcome();
  inputEl.focus();
  loadConversations();
}

// ── Panel visibility ──────────────────────────────────────
function showWelcome()  { welcomeEl.style.display = 'flex'; messagesEl.style.display = 'none'; }
function showMessages() { welcomeEl.style.display = 'none'; messagesEl.style.display = 'block'; }

// ── Message rendering ─────────────────────────────────────
function renderMessage(role, content) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerHTML = /* html */`
    <div class="message-avatar">${role === 'user' ? 'U' : '◆'}</div>
    <div class="message-content">
      <div class="message-role">${role === 'user' ? 'You' : 'Claude'}</div>
      <div class="message-body">${renderMarkdown(content)}</div>
    </div>
  `;
  messagesEl.appendChild(div);
  return div;
}

function appendTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = 'typing-msg';
  div.innerHTML = /* html */`
    <div class="message-avatar">◆</div>
    <div class="message-content">
      <div class="message-role">Claude</div>
      <div class="message-body">
        <div class="typing-indicator">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-status"></span>
        </div>
      </div>
    </div>
  `;
  messagesEl.appendChild(div);
  scrollBottom();
  return div;
}

// ── Send message ──────────────────────────────────────────
async function sendMessage() {
  let text = inputEl.value.trim();
  if (!text || isLoading) return;

  // Detect /skillname prefix even if no pill was set
  const slashMatch = text.match(/^\/([a-zA-Z0-9_-]+)\s*/);
  if (slashMatch && !selectedSkill) {
    const found = allSkills.find(s => s.name === slashMatch[1]);
    if (found) selectedSkill = { name: found.name, desc: found.description };
  }
  // Strip /skillname prefix from visible message
  if (selectedSkill) text = text.replace(/^\/[a-zA-Z0-9_-]+\s*/, '').trim();
  if (!text && !selectedSkill) return;

  const skillForRequest = selectedSkill?.name ?? null;
  selectedSkill = null;
  document.querySelector('.skill-pill')?.remove();

  setLoading(true);
  inputEl.value = '';
  inputEl.style.height = 'auto';

  showMessages();
  renderMessage('user', text);
  scrollBottom();

  const indicator = appendTypingIndicator();
  // statusEl always points to the visible status element; reassigned when
  // the typing indicator transitions into the actual assistant message.
  let statusEl = indicator.querySelector('.typing-status');

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConvId, message: text, skillName: skillForRequest }),
    });

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let streamed = '';
    let assistantDiv = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }

        if (data.type === 'spinner') {
          // Server already filters partial frames; client just dedupes.
          if (statusEl && data.label !== statusEl.textContent) {
            statusEl.classList.add('refresh');
            void statusEl.offsetWidth;
            statusEl.classList.remove('refresh');
            statusEl.textContent = data.label;
          }

        } else if (data.type === 'text') {
          // Filter TUI noise — structural checks only, no language-specific words
          if (data.text.replace(/\s/g, '').length < 3) continue;
          // Heavy padding + ≤2 words → TUI status line (e.g., "          still thinking")
          { const tr = data.text.trim();
            if ((data.text.length - tr.length) > 8 && tr.split(/\s+/).length <= 2) continue; }
          // Spaced-out chars pattern (e.g., "s  t  i  l  l") → partial TUI animation frame
          if (/(\S\s{2,}){3,}\S/.test(data.text)) continue;
          if (!assistantDiv) {
            indicator.remove();
            assistantDiv = renderMessage('assistant', '');
            assistantDiv.querySelector('.message-body').classList.add('streaming');
            const statusBar = document.createElement('div');
            statusBar.className = 'msg-status';
            assistantDiv.querySelector('.message-content').appendChild(statusBar);
            statusEl = statusBar;
          }
          streamed += data.text;
          assistantDiv.querySelector('.message-body').innerHTML = renderStreamingMarkdown(streamed);
          scrollBottom();

        } else if (data.type === 'done') {
          const final = data.text || streamed;
          if (!assistantDiv) {
            indicator.remove();
            const newDiv = renderMessage('assistant', final || '(no response)');
            if (data.meta) renderMeta(newDiv, data.meta);
          } else {
            assistantDiv.querySelector('.msg-status')?.remove();
            assistantDiv.querySelector('.msg-meta')?.remove();
            const body = assistantDiv.querySelector('.message-body');
            body.classList.remove('streaming');
            body.innerHTML = renderMarkdown(final);
            if (data.meta) renderMeta(assistantDiv, data.meta);
          }
          statusEl = null;
          currentConvId = data.conversationId;
          await loadConversations();
          scrollBottom();

        } else if (data.type === 'error') {
          indicator.remove();
          statusEl = null;
          if (assistantDiv) {
            assistantDiv.querySelector('.msg-status')?.remove();
            assistantDiv.querySelector('.message-body').classList.remove('streaming');
            assistantDiv.querySelector('.message-body').innerHTML = `<p>⚠️ ${esc(data.error)}</p>`;
          } else {
            renderMessage('assistant', `⚠️ ${esc(data.error)}`);
          }
        }
      }
    }
  } catch (err) {
    indicator.remove();
    renderMessage('assistant', `⚠️ Connection error: ${esc(err.message)}`);
  }

  setLoading(false);
  inputEl.focus();
}

// ── Helpers ───────────────────────────────────────────────
function setLoading(v) {
  isLoading = v;
  sendBtn.disabled = v;
  sendBtn.classList.toggle('loading', v);
}

function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (r.status === 204) return null;
  return r.json();
}

function esc(s = '') {
  // Escape all five HTML special chars including the single quote so that
  // values interpolated into single-quoted attributes (e.g. inline
  // onclick='selectSkill(\'${esc(x)}\')') cannot break out of the JS
  // string context.
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStreamingMarkdown(text) {
  const VISIBLE = 3;
  const CHARS_PER_LINE = 65;

  const nonEmpty  = text.split('\n').filter(l => l.trim()).length;
  const charLines = Math.ceil(text.replace(/\n/g, '').length / CHARS_PER_LINE);
  const totalEst  = Math.max(nonEmpty, charLines);

  if (totalEst <= VISIBLE) return renderMarkdown(text);

  const hidden = totalEst - VISIBLE;

  // Always show the latest (tail) — earlier content appears as hidden lines above
  const tail = text.slice(-(VISIBLE * CHARS_PER_LINE));
  return `<div class="stream-trunc">...+${hidden} lines</div>`
       + renderMarkdown(tail);
}

function renderInline(text) {
  // Extract URLs from RAW (pre-escape) text first, replace each with a
  // placeholder, then escape the surrounding text. Splicing URLs back in
  // afterwards with esc()'d href values prevents the attribute-injection
  // bug where esc() converts " into &quot; — a 6-char sequence that the
  // URL char-class would have happily captured, only for the browser to
  // decode it back into a literal " inside href="..." and break out.
  const tokens = [];
  const PH = (i) => `\x02OCP_URL_${i}\x02`;

  text = String(text).replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, t, u) => { tokens.push({ t, u }); return PH(tokens.length - 1); },
  );
  text = text.replace(
    /(?<![\[("'=])(https?:\/\/[^\s<>"')\]]+)/g,
    (u) => { tokens.push({ t: null, u }); return PH(tokens.length - 1); },
  );

  let s = esc(text);
  s = s.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/gs,     '<em>$1</em>');
  s = s.replace(/`([^`\n]+)`/g,    '<code>$1</code>');

  // Substitute placeholders back in. The href value is esc()'d so any &, "
  // inside it cannot break out of the double-quoted attribute. The link
  // text is also esc()'d (markdown text portion came from raw input).
  s = s.replace(/\x02OCP_URL_(\d+)\x02/g, (_, i) => {
    const { t, u } = tokens[+i];
    const href = esc(u);
    const body = t !== null ? esc(t) : href;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${body}</a>`;
  });
  return s;
}

function renderMarkdown(text) {
  // 1. Extract fenced code blocks
  const codeBlocks = [];
  text = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${esc(code.trimEnd())}</code></pre>`);
    return `\x00CODE${idx}\x00`;
  });

  const lines = text.split('\n');
  let html = '';
  let paraLines = [];
  let listItems = [];

  function flushPara() {
    if (!paraLines.length) return;
    html += `<p>${paraLines.join('<br>')}</p>`;
    paraLines = [];
  }
  function flushList() {
    if (!listItems.length) return;
    html += `<ul>${listItems.join('')}</ul>`;
    listItems = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Code block placeholder
    if (/^\x00CODE\d+\x00$/.test(trimmed)) {
      flushPara(); flushList();
      html += trimmed;
      continue;
    }

    // Heading
    const hm = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      flushPara(); flushList();
      html += `<h${hm[1].length}>${renderInline(hm[2])}</h${hm[1].length}>`;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushPara(); flushList();
      html += '<hr>';
      continue;
    }

    // List item (- / • / 1.)
    const lm = line.match(/^(\s*)(?:[-•*]|\d+\.)\s+(.+)/);
    if (lm) {
      flushPara();
      listItems.push(`<li>${renderInline(lm[2])}</li>`);
      continue;
    }

    // Empty line — flush buffers
    if (trimmed === '') {
      flushPara(); flushList();
      continue;
    }

    // Regular text line
    if (listItems.length) flushList();
    paraLines.push(renderInline(line));
  }

  flushPara();
  flushList();

  // Restore code blocks
  return html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[+i]);
}

function renderMeta(msgDiv, meta) {
  const el = document.createElement('div');
  el.className = 'msg-meta';
  const parts = [];

  const secs = (meta.elapsedMs / 1000).toFixed(1);
  parts.push(`<span class="meta-item">⏱ ${secs}s</span>`);

  if (meta.outputTokens != null) {
    const fmt = n => n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n);
    parts.push(`<span class="meta-item">↑${fmt(meta.inputTokens)} ↓${fmt(meta.outputTokens)} tok</span>`);
  }

  if (meta.costUsd != null && meta.costUsd > 0) {
    const c = meta.costUsd < 0.001
      ? `$${(meta.costUsd * 1000).toFixed(3)}m`
      : `$${meta.costUsd.toFixed(4)}`;
    parts.push(`<span class="meta-item">${c}</span>`);
  }

  if (meta.tools && meta.tools.length > 0) {
    const unique = [...new Set(meta.tools)];
    parts.push(`<span class="meta-item">🔧 ${unique.map(t => esc(t)).join(', ')}</span>`);
  }

  el.innerHTML = parts.join('<span class="meta-sep"> · </span>');
  msgDiv.querySelector('.message-content').appendChild(el);
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)      return 'just now';
  if (diff < 3_600_000)   return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)  return `${Math.floor(diff / 3_600_000)}h ago`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Start ─────────────────────────────────────────────────
init();
