import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TOOLS, runTool, isDangerous, extractImage } from './agent';
import { AGENTS, getAgent, toolNamesFor, type AgentDef } from './agents';
import { PROVIDERS, getProvider, isAnthropicLike } from './providers';

type Role = 'user' | 'assistant' | 'tool' | 'system' | 'notice';
type Msg = { role: Role; content: any; name?: string; tool_call_id?: string; tool_calls?: any[]; image?: string; ts?: number };
type Session = { id: string; title: string; agentId: string; messages: Msg[]; createdAt: number; updatedAt: number; goal?: string; planMode?: boolean };
type Permission = 'read-only' | 'workspace' | 'full';
type Settings = { provider: string; baseUrl: string; apiKey: string; model: string; autoLearn: boolean; accessMode: 'normal' | 'full'; permission: Permission };

type ActivityItem = { name: string; args?: any; result?: any; image?: string; denied?: boolean };
type Attachment = { kind: 'image' | 'text' | 'meta'; name: string; path: string; dataUrl?: string; content?: string; size?: number };
type Block =
  | { kind: 'user'; msg: Msg }
  | { kind: 'assistant'; msg: Msg }
  | { kind: 'notice'; msg: Msg }
  | { kind: 'activity'; items: ActivityItem[]; text?: string };

const SESSIONS_KEY = 'oflabot.sessions.v1';
const ACTIVE_KEY = 'oflabot.active-session.v1';
const SETTINGS_KEY = 'oflabot.settings.v1';
const BROWSER_OPEN_KEY = 'oflabot.browser.open';
const LEGACY = { settings: 'grokbot.settings.v1', sessions: 'grokbot.sessions.v3', active: 'grokbot.active-session.v3' };
const DONATE_URL = 'https://saweria.co/OflaCo';

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function readKey(key: string, legacy?: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v != null) return v;
    if (legacy) {
      const old = localStorage.getItem(legacy);
      if (old != null) { localStorage.setItem(key, old); return old; }
    }
  } catch { /* ignore */ }
  return null;
}

function loadSettings(): Settings {
  const fallback: Settings = { provider: 'openai', baseUrl: 'https://api.openai.com', apiKey: '', model: 'gpt-4o', autoLearn: true, accessMode: 'normal', permission: 'workspace' };
  try {
    const raw = readKey(SETTINGS_KEY, LEGACY.settings);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        const provider = String(p.provider || 'openai');
        return {
          provider: provider === 'syncera' ? 'syncera-anthropic' : provider,
          baseUrl: p.baseUrl ?? fallback.baseUrl,
          apiKey: p.apiKey ?? '',
          model: p.model ?? '',
          autoLearn: p.autoLearn !== false,
          accessMode: p.accessMode === 'full' ? 'full' : 'normal',
          permission: (p.permission as Permission) || (p.accessMode === 'full' ? 'full' : 'workspace'),
        };
      }
    }
  } catch { /* ignore */ }
  return fallback;
}

function loadSessions(): Session[] {
  try {
    const raw = readKey(SESSIONS_KEY, LEGACY.sessions);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s: any) => s && typeof s.id === 'string' && Array.isArray(s.messages));
  } catch { return []; }
}

function newSession(agentId = 'oflabot'): Session {
  return { id: uid(), title: 'Sesi baru', agentId, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
}

function sessionTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 42 ? t.slice(0, 42) + '…' : t || 'Sesi baru';
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'baru saja';
  if (d < 3_600_000) return Math.floor(d / 60_000) + 'm';
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + 'j';
  return Math.floor(d / 86_400_000) + 'h';
}

function safeJson(text: string): any {
  if (!text) return null;
  for (const chunk of [text]) {
    const start = chunk.indexOf('{');
    const end = chunk.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(chunk.slice(start, end + 1)); } catch { /* lanjut */ }
    }
  }
  return null;
}

/**
 * Deteksi otomatis apakah permintaan pengguna butuh rencana bertahap.
 * Dipakai agar pengguna awam tidak perlu menyebut "todo_write" sama sekali.
 */
function needsPlan(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 160) return true;
  const verbs = [
    'rapikan', 'pindahkan', 'pindahin', 'migrasi', 'backup', 'cadangkan', 'kelompokkan', 'sortir',
    'bersihkan', 'hapus semua', 'gabung', 'pecah', 'pisahkan', 'rename', 'ubah nama', 'susun ulang',
    'install', 'pasang', 'setup', 'konfigurasi', 'buatkan', 'buat aplikasi', 'buat website',
    'cari semua', 'telusuri', 'bandingkan', 'ringkas semua', 'rangkum semua', 'analisa', 'analisis',
    'otomatis', 'setiap', 'semua file', 'seluruh', 'beberapa langkah', 'langkah demi langkah',
  ];
  if (verbs.some((v) => t.includes(v))) return true;
  // banyak klausa = kemungkinan multi-langkah
  const clauses = (text.match(/\b(lalu|kemudian|setelah itu|selanjutnya|dan juga|terus)\b/gi) || []).length;
  return clauses >= 2;
}

function pretty(v: any, max = 900): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    return s.length > max ? s.slice(0, max) + '\n…' : s;
  } catch { return String(v); }
}

/** Kelompokkan pesan menjadi blok: bubble user/assistant dan aktivitas tool (collapsible). */
function buildBlocks(messages: Msg[]): Block[] {
  const blocks: Block[] = [];
  const byCallId = new Map<string, Msg>();
  for (const m of messages) if (m.role === 'tool' && m.tool_call_id) byCallId.set(m.tool_call_id, m);

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'notice') { blocks.push({ kind: 'notice', msg: m }); i++; continue; }
    if (m.role === 'tool') { i++; continue; } // hasil tool selalu dilipat ke activity

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const items: ActivityItem[] = [];
      for (const tc of m.tool_calls) {
        const resMsg = byCallId.get(tc.id);
        let res: any = resMsg?.content;
        if (typeof res === 'string') { try { res = JSON.parse(res); } catch { /* biarkan string */ } }
        const denied = !!(res && typeof res === 'object' && String(res.error || '').includes('dibatalkan'));
        items.push({ name: tc.function?.name, args: safeJson(tc.function?.arguments) ?? tc.function?.arguments, result: res, image: resMsg?.image, denied });
      }
      blocks.push({ kind: 'activity', items, text: typeof m.content === 'string' && m.content.trim() && m.content !== '(memanggil tool)' ? m.content : undefined });
      i++;
      continue;
    }

    if (m.role === 'user') { blocks.push({ kind: 'user', msg: m }); i++; continue; }
    if (m.role === 'assistant') { blocks.push({ kind: 'assistant', msg: m }); i++; continue; }
    i++;
  }
  return blocks;
}

function activitySummary(items: ActivityItem[]): string {
  const names = Array.from(new Set(items.map((it) => it.name || 'tool')));
  const denied = items.filter((it) => it.denied).length;
  const label = names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '');
  const base = items.length === 1 ? `Used ${label}` : `Used ${items.length} tools · ${label}`;
  return denied ? `${base} · ${denied} dibatalkan` : base;
}

const ICON: Record<string, string> = {
  browser_open: '🌐', browser_text: '📄', browser_snapshot: '🖼', browser_click: '👆', browser_fill: '⌨',
  browser_action: '🧭', screenshot: '📸', exec: '⚡', launch: '🚀', mouse: '🖱', type: '⌨', keys: '⌨',
  file_read: '📖', file_write: '💾', memory_save: '🧠', memory_search: '🔎', memory_delete: '🗑',
  skill_list: '🧩', skill_read: '📘', confirm: '✅', confirm_dangerous: '✅',
};

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [sessions, setSessions] = useState<Session[]>(() => {
    const s = loadSessions();
    return s.length ? s : [newSession()];
  });
  const [activeId, setActiveId] = useState<string>(() => {
    try { return readKey(ACTIVE_KEY, LEGACY.active) || ''; } catch { return ''; }
  });
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [browserOpen, setBrowserOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(BROWSER_OPEN_KEY) !== '0'; } catch { return true; }
  });
  const [panel, setPanel] = useState<null | 'settings' | 'memory' | 'skills' | 'donate'>(null);
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [autoApprove, setAutoApprove] = useState(false);
  const [todos, setTodos] = useState<{ content: string; status: string }[]>([]);
  const [showPlan, setShowPlan] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<'root' | 'permission' | 'shell'>('root');
  const [modal, setModal] = useState<null | 'goal' | 'feedback'>(null);
  const [goalDraft, setGoalDraft] = useState('');
  const [shellDraft, setShellDraft] = useState('');
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackRating, setFeedbackRating] = useState(0);
  const [compacting, setCompacting] = useState(false);
  const [stepLimitHit, setStepLimitHit] = useState(false);

  // model dropdown
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelErr, setModelErr] = useState('');
  const [manualModel, setManualModel] = useState(false);

  // memory & skills
  const [memEntries, setMemEntries] = useState<MemEntry[]>([]);
  const [skillList, setSkillList] = useState<SkillMeta[]>([]);
  const [skillsDir, setSkillsDir] = useState('');
  const [repoInput, setRepoInput] = useState('');
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillMsg, setSkillMsg] = useState('');
  const [learning, setLearning] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  // browser
  const [browserState, setBrowserState] = useState<BrowserState>({ url: '', title: '', canGoBack: false, canGoForward: false, loading: false, visible: false });
  const [urlInput, setUrlInput] = useState('');

  const abortRef = useRef(false);
  const pickFilesRef = useRef<() => Promise<void>>(async () => { /* diisi di bawah */ });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const browserSlotRef = useRef<HTMLDivElement | null>(null);
  const hostReady = typeof window !== 'undefined' && !!window.dsh;

  const active = useMemo(() => sessions.find((s) => s.id === activeId) || sessions[0], [sessions, activeId]);
  const agent = useMemo(() => getAgent(active?.agentId || 'oflabot'), [active?.agentId]);
  const prov = getProvider(settings.provider);
  const isAnthropic = isAnthropicLike(settings.provider);
  const browserToolOk = hostReady && !!window.dsh?.browser;

  // ---------------- persistence ----------------
  useEffect(() => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } }, [settings]);
  useEffect(() => { try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(-80))); } catch { /* ignore */ } }, [sessions]);
  useEffect(() => { if (active?.id) { try { localStorage.setItem(ACTIVE_KEY, active.id); } catch { /* ignore */ } } }, [active?.id]);
  useEffect(() => { try { localStorage.setItem(BROWSER_OPEN_KEY, browserOpen ? '1' : '0'); } catch { /* ignore */ } }, [browserOpen]);
  useEffect(() => { if (!activeId && sessions[0]) setActiveId(sessions[0].id); }, [activeId, sessions]);

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? '' : n)), 5000);
  }, []);

  // ---------------- model dropdown ----------------
  const loadModels = useCallback(async (silent = false) => {
    if (!hostReady) return;
    const p = getProvider(settings.provider);
    setLoadingModels(true);
    setModelErr('');
    try {
      const res = await window.dsh.models({ provider: p.id, protocol: p.protocol, baseUrl: settings.baseUrl, apiKey: settings.apiKey });
      let list: string[] = Array.isArray(res.models) ? res.models : [];
      if (!list.length && p.fallbackModels?.length) list = p.fallbackModels;
      setModels(list);
      if (res.error) setModelErr(typeof res.error === 'string' ? res.error : JSON.stringify(res.error).slice(0, 220));
      else if (!list.length) setModelErr('Provider tidak mengembalikan daftar model.');
      if (list.length && !list.includes(settings.model) && !silent) setSettings((s) => ({ ...s, model: list[0] }));
    } catch (err: any) {
      setModelErr(err?.message || String(err));
    } finally {
      setLoadingModels(false);
    }
  }, [hostReady, settings.provider, settings.baseUrl, settings.apiKey, settings.model]);

  useEffect(() => {
    if (!hostReady) return;
    const p = getProvider(settings.provider);
    if (!settings.baseUrl) return;
    if (!p.noKey && !settings.apiKey) { setModels(p.fallbackModels || []); return; }
    const t = window.setTimeout(() => { void loadModels(true); }, 700);
    return () => window.clearTimeout(t);
  }, [hostReady, settings.provider, settings.baseUrl, settings.apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- memory & skills ----------------
  const refreshMemory = useCallback(async () => {
    if (!hostReady) return;
    const r = await window.dsh.memory.list();
    setMemEntries(r.entries || []);
  }, [hostReady]);

  const refreshSkills = useCallback(async () => {
    if (!hostReady) return;
    const r = await window.dsh.skills.list();
    setSkillList(r.skills || []);
    setSkillsDir(r.dir || '');
  }, [hostReady]);

  useEffect(() => {
    if (!hostReady) return;
    void refreshMemory();
    void refreshSkills();
    window.dsh.appInfo().then((i) => setAppVersion(i?.version || '')).catch(() => { /* ignore */ });
  }, [hostReady, refreshMemory, refreshSkills]);

  // ---------------- browser panel bounds ----------------
  const syncBrowserBounds = useCallback(async () => {
    if (!browserToolOk) return;
    const el = browserSlotRef.current;
    if (!browserOpen || panel || !el) { await window.dsh.browser.hide(); return; }
    const r = el.getBoundingClientRect();
    await window.dsh.browser.show({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
  }, [browserToolOk, browserOpen, panel]);

  useEffect(() => { void syncBrowserBounds(); }, [syncBrowserBounds]);
  useEffect(() => {
    if (!browserToolOk) return;
    const ro = new ResizeObserver(() => { void syncBrowserBounds(); });
    if (browserSlotRef.current) ro.observe(browserSlotRef.current);
    const onResize = () => { void syncBrowserBounds(); };
    window.addEventListener('resize', onResize);
    return () => { ro.disconnect(); window.removeEventListener('resize', onResize); };
  }, [browserToolOk, syncBrowserBounds]);

  useEffect(() => {
    if (!browserToolOk) return;
    const offState = window.dsh.browser.onState((s) => { setBrowserState(s); if (s.url) setUrlInput(s.url); });
    const offOpen = window.dsh.browser.onRequestOpen(({ url }) => { setBrowserOpen(true); setUrlInput(url); });
    return () => { offState(); offOpen(); };
  }, [browserToolOk]);

  // Ctrl+Alt+B: buka/tutup panel browser (seperti DSH).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setBrowserOpen((v) => !v);
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        void pickFilesRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [active?.messages.length, running]);
  useEffect(() => { setStepLimitHit(false); }, [activeId]);

  // ---------------- helpers ----------------
  const updateSession = useCallback((id: string, fn: (s: Session) => Session) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));
  }, []);

  const appendMessage = useCallback((id: string, msg: Msg) => {
    updateSession(id, (s) => ({ ...s, messages: [...s.messages, msg], updatedAt: Date.now() }));
  }, [updateSession]);

  function pickProvider(id: string) {
    const p = getProvider(id);
    setSettings((s) => ({ ...s, provider: id, baseUrl: p.baseUrl, model: p.defaultModel }));
    setModels(p.fallbackModels || []);
    setModelErr('');
    setManualModel(false);
  }

  function createSession(agentId = 'oflabot') {
    const s = newSession(agentId);
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setInput('');
  }

  function deleteSession(id: string) {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      const list = next.length ? next : [newSession()];
      if (id === activeId) setActiveId(list[0].id);
      return list;
    });
  }

  async function navigateBrowser(url: string) {
    if (!url) return;
    if (!browserOpen) setBrowserOpen(true);
    const st = await window.dsh.browser.navigate(url);
    setBrowserState(st);
    if (st.url) setUrlInput(st.url);
  }

  async function openDonate() {
    const r = await window.dsh.openExternal(DONATE_URL);
    if (!r?.ok) {
      setPanel(null);
      setBrowserOpen(true);
      void navigateBrowser(DONATE_URL);
      flash(r?.error || 'Browser default tidak bisa dibuka — dibuka di panel browser aplikasi.');
    }
  }

  // ---------------- system prompt (agent + memory + skill + goal/plan) ----------------
  async function buildSystemPrompt(def: AgentDef): Promise<string> {
    let extra = '';
    try {
      const mem = await window.dsh.memory.context(40);
      if (mem.memories?.length) extra += '\n\n=== MEMORY TERSIMPAN ===\n' + mem.memories.map((m) => `- ${m.title}: ${m.body.slice(0, 400)}`).join('\n');
      if (mem.skills?.length) extra += '\n\n=== SKILL HASIL BELAJAR ===\n' + mem.skills.map((m) => `- ${m.title}: ${m.body.slice(0, 300)}`).join('\n');
      const sk = await window.dsh.skills.context();
      if (sk.enabled?.length) extra += '\n\n=== SKILL TERPASANG (panggil skill_read sebelum dipakai) ===\n' + sk.enabled.map((s: any) => `- ${s.slug} (${s.name}): ${s.description}`).join('\n');
    } catch { /* abaikan */ }

    const cur = sessions.find((s) => s.id === (active?.id || ''));
    if (cur?.goal) {
      extra += '\n\n=== GOAL SESI (tujuan jangka panjang) ===\n' + cur.goal +
        '\nSelalu arahkan pekerjaan menuju goal ini. Jika goal sudah tercapai, nyatakan dengan jelas.';
    }
    if (cur?.planMode) {
      extra += '\n\n=== MODE RENCANA (PLAN) ===\n' +
        'Kamu HANYA menyusun rencana. JANGAN mengubah apa pun di komputer: jangan panggil exec, file_move, file_write, launch, mouse, type, keys. ' +
        'Boleh membaca (file_list, file_stat, browser_*, memory_*) dan menulis todo. Akhiri dengan rencana langkah yang bisa disetujui pengguna.';
    }
    return def.system + extra;
  }

  // ---------------- menu "+" actions ----------------
  pickFilesRef.current = () => pickFiles();
  const permission: Permission = settings.permission || (settings.accessMode === 'full' ? 'full' : 'workspace');

  async function pickFiles(mode?: 'image') {
    setMenuOpen(false);
    const res = await window.dsh.files.pick(mode);
    if (res?.error) { flash('Gagal memilih file: ' + res.error); return; }
    const files = (res?.files || []).filter((f: any) => f.kind !== 'error');
    if (!files.length) return;
    setAttachments((prev) => [...prev, ...files.map((f: any) => ({ kind: f.kind, name: f.name, path: f.path, dataUrl: f.dataUrl, content: f.content, size: f.size }))].slice(0, 10));
    flash(`${files.length} file dilampirkan.`);
  }

  async function togglePlanMode() {
    setMenuOpen(false);
    if (!active) return;
    updateSession(active.id, (s) => ({ ...s, planMode: !s.planMode }));
    flash(active.planMode ? 'Keluar dari mode rencana.' : 'Mode rencana aktif — OflaBot hanya menyusun rencana, tidak mengubah apa pun.');
  }

  function saveGoal() {
    if (!active) return;
    updateSession(active.id, (s) => ({ ...s, goal: goalDraft.trim() || undefined }));
    setModal(null);
    flash(goalDraft.trim() ? 'Goal sesi disimpan.' : 'Goal dihapus.');
  }

  async function setPermission(p: Permission) {
    setMenuOpen(false);
    setSettings((s) => ({ ...s, permission: p, accessMode: p === 'full' ? 'full' : 'normal' }));
    setAutoApprove(p === 'full');
    flash(
      p === 'read-only' ? 'Permission: Read Only — OflaBot tidak boleh mengubah apa pun.'
        : p === 'workspace' ? 'Permission: Workspace Write — boleh mengubah file, tetap minta konfirmasi.'
          : 'Permission: Full access — tanpa konfirmasi.',
    );
  }

  async function saveFeedback() {
    await window.dsh.feedback({ rating: feedbackRating, text: feedbackText.trim(), session: active?.title || '' });
    setModal(null);
    setFeedbackText('');
    setFeedbackRating(0);
    flash('Terima kasih! Feedback tersimpan.');
  }

  function sessionTranscript(): string {
    const s = active;
    if (!s) return '';
    const lines: string[] = [`# ${s.title}`, '', `- Agent: ${getAgent(s.agentId).name}`, `- Model: ${settings.model}`, `- Provider: ${prov.name}`, `- Waktu: ${new Date().toISOString()}`, ''];
    if (s.goal) lines.push(`**Goal:** ${s.goal}`, '');
    for (const m of s.messages) {
      if (m.role === 'notice') { lines.push(`> ${String(m.content)}`, ''); continue; }
      if (m.role === 'tool') { lines.push('<details><summary>tool · ' + (m.name || '') + '</summary>', '', '```', typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2), '```', '', '</details>', ''); continue; }
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
      if (m.role === 'assistant' && m.tool_calls?.length) {
        lines.push(`**${m.role.toUpperCase()}**`, '', body, '', 'Tool: ' + m.tool_calls.map((t: any) => t.function?.name).join(', '), '');
      } else {
        lines.push(`**${m.role.toUpperCase()}**`, '', body, '');
      }
    }
    return lines.join('\n');
  }

  async function exportSession() {
    if (!active) return;
    const res = await window.dsh.sessionExport({ name: active.title, content: sessionTranscript(), format: 'md' });
    if (res?.ok && !res.canceled) flash('Sesi disimpan: ' + res.path);
    else if (res?.error) flash('Gagal menyimpan: ' + res.error);
  }

  async function runShellCommand() {
    const cmd = shellDraft.trim();
    if (!cmd) return;
    setMenuOpen(false);
    setShellDraft('');
    if (!active) return;
    const id = active.id;
    appendMessage(id, { role: 'notice', content: `Shell: ${cmd}` });
    const r = await window.dsh.exec(cmd, { timeoutMs: 120000 });
    const out = [r?.stdout, r?.stderr].filter(Boolean).join('\n').trim() || '(tanpa output)';
    appendMessage(id, { role: 'tool', name: 'exec', tool_call_id: 'shell-' + Date.now(), content: `kode: ${r?.code}\n${out.slice(0, 4000)}` });
  }

  async function compactHistory() {
    if (!active || compacting) return;
    setMenuOpen(false);
    const msgs = active.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    if (msgs.length < 6) { flash('Riwayat masih pendek, belum perlu diringkas.'); return; }
    setCompacting(true);
    try {
      const old = msgs.slice(0, -4);
      const keep = msgs.slice(-4);
      const transcript = old.map((m) => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n').slice(0, 24000);
      const resp = await window.dsh.chat({
        provider: isAnthropic ? 'anthropic' : 'openai',
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: [{ role: 'user', content: 'Ringkas percakapan berikut menjadi catatan padat (poin keputusan, hasil, dan konteks penting). Balas ringkasan saja:\n\n' + transcript }],
      });
      if (resp?.error || !resp?.text) { flash('Gagal meringkas: ' + JSON.stringify(resp?.error || 'kosong').slice(0, 160)); return; }
      const summary: Msg = { role: 'assistant', content: '📦 Ringkasan percakapan sebelumnya:\n' + resp.text.trim() };
      updateSession(active.id, (s) => ({ ...s, messages: [summary, ...keep] }));
      flash('Riwayat lama diringkas.');
    } finally { setCompacting(false); }
  }

  // ---------------- chat loop ----------------
  const messagesForApi = useCallback((msgs: Msg[]) => {
    return msgs
      .filter((m) => m.role !== 'notice' && m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
        if (m.role === 'assistant' && m.tool_calls) return { role: 'assistant', content: typeof m.content === 'string' ? m.content : '', tool_calls: m.tool_calls };
        return { role: m.role, content: m.content };
      });
  }, []);

  async function agentLoop(sessionId: string, userText: string, agentDef: AgentDef, userContent?: any) {
    setRunning(true);
    abortRef.current = false;

    let allowed = toolNamesFor(agentDef.tools);
    if (sessions.find((s) => s.id === sessionId)?.planMode) {
      const SAFE = ['file_list', 'file_stat', 'browser_open', 'browser_action', 'browser_text', 'browser_snapshot', 'browser_click', 'browser_fill', 'todo_write', 'memory_save', 'memory_search', 'skill_list', 'skill_read'];
      allowed = allowed.filter((n) => SAFE.includes(n));
    }
    const tools = TOOLS.filter((t: any) => allowed.includes(t.function.name));
    const allowedNames = tools.map((t: any) => t.function.name);
    let systemPrompt = await buildSystemPrompt(agentDef);

    // Deteksi otomatis tugas multi-langkah (tanpa perlu pengguna menyebut nama tool).
    const isMultiStep = needsPlan(userText);
    if (isMultiStep && allowedNames.includes('todo_write')) {
      systemPrompt +=
        '\n\n[INSTRUKSI INTERNAL — jangan tampilkan ke pengguna] ' +
        'Permintaan ini multi-langkah. Sebelum tool lain, panggil todo_write dengan rencana 3-6 langkah ' +
        'berbahasa awam, lalu jalankan dan perbarui statusnya. Pengguna tidak menyuruh ini; lakukan otomatis.';
    }
    setShowPlan(isMultiStep);

    const msgs: Msg[] = [...(sessions.find((s) => s.id === sessionId)?.messages ?? []), { role: 'user', content: userContent ?? userText }];
    appendMessage(sessionId, { role: 'user', content: userContent ? (userText || '[lampiran]') : userText, ts: Date.now() });
    if (isMultiStep) setTodos([]);

    let steps = 0;
    const sigCounts = new Map<string, number>();
    let hitLimit = false;
    let lastError = '';
    let planNudges = 0;
    let todoSeen = false;

    const callModel = async (payload: any) => {
      // Retry untuk error transien (rate limit / 5xx / jaringan).
      let last: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await window.dsh.chat(payload);
        if (!r?.error) return r;
        last = r;
        const raw = JSON.stringify(r.error || '');
        const transient = /\b(429|500|502|503|504|ECONN|ETIMEDOUT|timeout|overloaded|rate.?limit)\b/i.test(raw);
        if (!transient || abortRef.current || attempt === 2) break;
        appendMessage(sessionId, { role: 'notice', content: `Provider sibuk (${attempt + 1}/3), mencoba lagi…` });
        await new Promise((res) => setTimeout(res, 1200 * (attempt + 1)));
      }
      return last;
    };

    while (steps < 26 && !abortRef.current) {
      steps++;

      // Pengingat otomatis (tanpa terlihat pengguna): kalau rencana belum dibuat.
      if (isMultiStep && !todoSeen && planNudges < 3 && steps >= 2) {
        planNudges++;
        systemPrompt +=
          '\n\n[PENGINGAT SISTEM] Kamu belum membuat daftar langkah untuk tugas ini. ' +
          'Panggil todo_write SEKARANG (3-6 langkah sederhana) sebelum memanggil tool lain.';
      }
      const payload = {
        provider: isAnthropic ? 'anthropic' : 'openai',
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        system: systemPrompt,
        messages: messagesForApi(msgs),
        tools: isAnthropic ? tools.map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) : tools,
        tool_choice: isAnthropic ? undefined : 'auto',
      };

      const resp = await callModel(payload);
      if (resp?.error) {
        lastError = JSON.stringify(resp.error).slice(0, 600);
        appendMessage(sessionId, { role: 'notice', content: 'Error provider: ' + lastError });
        break;
      }

      const text: string = resp.text || '';
      const toolCalls = (resp.tool_calls || []).filter((tc: any) => allowedNames.includes(tc.function?.name));

      if (toolCalls.length) {
        msgs.push({ role: 'assistant', content: text, tool_calls: toolCalls });
        appendMessage(sessionId, { role: 'assistant', content: text || '(memanggil tool)', tool_calls: toolCalls });

        for (const tc of toolCalls) {
          if (abortRef.current) break;
          const name = tc.function.name;
          let args: any = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }

          // --- Pengaman loop: panggilan identik berulang ---
          const sig = name + '|' + JSON.stringify(args);
          const seen = (sigCounts.get(sig) || 0) + 1;
          sigCounts.set(sig, seen);

          const pushToolResult = (payload: any) => {
            const s = JSON.stringify(payload).slice(0, 6000);
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: s, name });
            appendMessage(sessionId, { role: 'tool', name, tool_call_id: tc.id, content: s });
          };

          if (seen >= 3) {
            pushToolResult({
              error: 'loop terdeteksi',
              hint:
                `Panggilan ${name} dengan argumen yang sama sudah ${seen}× tanpa hasil baru. ` +
                'JANGAN ulangi. Ubah pendekatan (mis. pakai file_list/file_move atau exec dengan perintah berbeda), ' +
                'atau jelaskan ke pengguna kendala yang dihadapi dan minta klarifikasi.',
            });
            continue;
          }

          if (permission === 'read-only' && isDangerous(name, args)) {
            pushToolResult({ error: 'Mode Read Only aktif', hint: 'Aksi mengubah/menjalankan diblokir. Minta pengguna mengganti Permission ke Workspace Write atau Full access.' });
            continue;
          }
          const fullAccess = permission === 'full' || autoApprove;
          if (isDangerous(name, args) && !fullAccess) {
            const ok = await window.dsh.confirm(
              `Izinkan aksi "${name}"?\n${JSON.stringify(args).slice(0, 300)}\n\n` +
              `Klik Allow = izinkan semua aksi berikutnya di sesi ini (Full Access).`,
            );
            if (ok) {
              setAutoApprove(true);
              flash('Full Access aktif untuk sesi ini — tidak akan bertanya lagi.');
            }
            if (!ok) {
              pushToolResult({ error: 'dibatalkan pengguna' });
              continue;
            }
          }

          let result: any;
          try {
            result = await runTool(name, args);
          } catch (err: any) {
            result = { error: 'tool gagal: ' + (err?.message || String(err)) };
          }

          if (name === 'todo_write') {
            todoSeen = true;
            const list = Array.isArray(result?.todos) ? result.todos : Array.isArray(args.todos) ? args.todos : [];
            setTodos(list);
          }

          const image = extractImage(result);
          const clean = { ...result };
          if (clean.dataUrl) clean.dataUrl = '(gambar terkirim terpisah)';
          const contentStr = JSON.stringify(clean).slice(0, 6000);

          msgs.push({ role: 'tool', tool_call_id: tc.id, content: contentStr, name });
          appendMessage(sessionId, { role: 'tool', name, tool_call_id: tc.id, content: contentStr, image: image || undefined });

          if (image) {
            msgs.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] } as any);
            appendMessage(sessionId, { role: 'user', content: '[gambar halaman]' });
          }
          if (name.startsWith('memory_') || name.startsWith('skill_')) void refreshMemory();
        }
        continue;
      }

      // --- Tidak ada tool call: ini jawaban akhir ---
      if (!text.trim()) {
        appendMessage(sessionId, {
          role: 'notice',
          content: 'Model tidak mengembalikan jawaban (respons kosong). Coba kirim ulang, atau ganti model/provider di Settings.',
        });
        break;
      }

      msgs.push({ role: 'assistant', content: text });
      appendMessage(sessionId, { role: 'assistant', content: text });
      break;
    }

    if (steps >= 26) {
      hitLimit = true;
      appendMessage(sessionId, {
        role: 'notice',
        content: 'Batas 26 langkah tercapai. Klik tombol "Lanjutkan" atau kirim "lanjutkan" untuk melanjutkan, atau uraikan tugas menjadi bagian lebih kecil.',
      });
    }
    setStepLimitHit(hitLimit);
    setRunning(false);
    void refreshMemory();
  }

  // ---------------- auto-learn ----------------
  async function learnFromSession(session: Session) {
    if (!settings.autoLearn || learning) return;
    const transcript = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-14)
      .map((m) => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n');
    if (transcript.length < 120) return;

    setLearning(true);
    try {
      const prompt =
        'Analisa percakapan berikut. Ekstrak HANYA informasi yang layak diingat jangka panjang dan skill/prosedur yang bisa dipakai ulang.\n' +
        'Balas HANYA JSON valid: {"memories":[{"title":"...","body":"...","tags":["..."]}],"skills":[{"title":"...","body":"langkah 1...; langkah 2..."}]}\n' +
        'Jika tidak ada yang layak, balas {"memories":[],"skills":[]}. Jangan menyimpan rahasia (password/API key).\n\n' +
        'PERCAKAPAN:\n' + transcript;

      const resp = await window.dsh.chat({ provider: isAnthropic ? 'anthropic' : 'openai', baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, messages: [{ role: 'user', content: prompt }] });
      if (resp?.error || !resp?.text) return;
      const data = safeJson(resp.text);
      if (!data) return;
      let saved = 0;
      for (const m of data.memories || []) if (m?.title && m?.body) { await window.dsh.memory.add({ kind: 'memory', title: m.title, body: m.body, tags: m.tags }); saved++; }
      for (const s of data.skills || []) if (s?.title && s?.body) { await window.dsh.memory.add({ kind: 'skill', title: s.title, body: s.body }); saved++; }
      if (saved) { void refreshMemory(); flash(`Belajar ${saved} hal baru dari sesi ini.`); }
    } catch { /* abaikan */ } finally { setLearning(false); }
  }

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || running || !active) return;
    if (!hostReady) return;
    const p = getProvider(settings.provider);
    if (!settings.apiKey && !p.noKey) { setPanel('settings'); flash('Isi API Key dulu.'); return; }
    if (!settings.model) { setPanel('settings'); flash('Pilih model AI dulu.'); return; }

    // Lampiran: gambar -> vision, file teks -> konteks tambahan.
    const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl);
    const textFiles = attachments.filter((a) => a.kind === 'text' && a.content);
    let userContent: any = text;
    if (images.length) {
      const parts: any[] = [];
      if (text) parts.push({ type: 'text', text });
      for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      userContent = parts;
    }
    let promptText = text;
    if (textFiles.length) {
      promptText += '\n\n' + textFiles
        .map((f) => `--- LAMPIRAN: ${f.name} (${f.path}) ---\n${(f.content || '').slice(0, 60000)}`)
        .join('\n\n');
    }
    if (!text && images.length) promptText = promptText || '(lihat gambar yang dilampirkan)';

    setInput('');
    setAttachments([]);
    setStepLimitHit(false);
    updateSession(active.id, (s) => ({ ...s, title: s.messages.length === 0 ? sessionTitle(promptText || 'Lampiran') : s.title }));
    const snapshot = active;
    await agentLoop(snapshot.id, promptText, getAgent(snapshot.agentId), userContent);
    try {
      const fresh = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]') as Session[];
      const s2 = fresh.find((x) => x.id === snapshot.id);
      if (s2) void learnFromSession(s2);
    } catch { /* ignore */ }
  }

  // ---------------- skills actions ----------------
  async function installSkills() {
    if (!repoInput.trim()) return;
    setSkillBusy(true); setSkillMsg('Mengambil skill dari GitHub…');
    try {
      const r = await window.dsh.skills.installRepo(repoInput.trim());
      if (r?.error) setSkillMsg('Gagal: ' + r.error);
      else { setSkillMsg(`Selesai: ${r.installed?.length || 0}/${r.found || 0} skill terpasang.`); setRepoInput(''); void refreshSkills(); }
    } catch (err: any) { setSkillMsg('Gagal: ' + (err?.message || String(err))); } finally { setSkillBusy(false); }
  }

  async function importLocalSkills() {
    setSkillBusy(true); setSkillMsg('Memindai folder skill Claude/Codex/OpenCode/Hermes/VS Code…');
    try {
      const r = await window.dsh.skills.importLocal();
      setSkillMsg(`Ditemukan ${r.found || 0}, ditambahkan ${r.added || 0}.`);
      void refreshSkills();
    } catch (err: any) { setSkillMsg('Gagal: ' + (err?.message || String(err))); } finally { setSkillBusy(false); }
  }

  // ---------------- render ----------------
  const messages = active?.messages ?? [];
  const blocks = useMemo(() => buildBlocks(messages), [messages]);
  const memCount = memEntries.filter((m) => m.kind === 'memory').length;
  const skillMemCount = memEntries.filter((m) => m.kind === 'skill').length;

  const toggle = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  function renderActivity(b: Extract<Block, { kind: 'activity' }>, key: string) {
    const open = !!expanded[key];
    return (
      <div className={`activity ${open ? 'open' : ''}`}>
        <button className="activity-head" onClick={() => toggle(key)}>
          <span className="activity-chevron">{open ? '▾' : '▸'}</span>
          <span className="activity-icon">⚙</span>
          <span className="activity-title">{activitySummary(b.items)}</span>
          <span className="activity-hint">{open ? 'sembunyikan' : 'detail'}</span>
        </button>
        {open && (
          <div className="activity-body">
            {b.text && <div className="activity-note">{b.text}</div>}
            {b.items.map((it, idx) => (
              <div key={idx} className="activity-item">
                <div className="activity-item-head">
                  <span>{ICON[it.name || ''] || '•'}</span>
                  <b>{it.name}</b>
                  {it.denied && <span className="tag warn">dibatalkan</span>}
                  {it.args && Object.keys(it.args).length > 0 && (
                    <span className="activity-args">{pretty(it.args, 120).replace(/\s+/g, ' ')}</span>
                  )}
                </div>
                {it.image && <img className="tool-image" src={it.image} alt="snapshot" />}
                <pre className="activity-result mono">{pretty(it.result, 700)}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="shell">
      {/* ============ SIDEBAR ============ */}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <span>OflaBot</span>
        </div>
        <button className="new-session" onClick={() => createSession(active?.agentId || 'oflabot')}>
          <span>＋</span> Sesi Baru
        </button>

        <div className="side-section">
          <div className="side-title">Agents</div>
          <div className="agent-list">
            {AGENTS.map((a) => (
              <button key={a.id} className={`agent-item ${active?.agentId === a.id ? 'active' : ''}`} title={a.description}
                onClick={() => active && updateSession(active.id, (s) => ({ ...s, agentId: a.id }))}>
                <span className="agent-icon">{a.icon}</span>
                <span className="agent-name">{a.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="side-section grow">
          <div className="side-title">Sessions</div>
          <div className="session-list">
            {sessions.map((s) => (
              <div key={s.id} className={`session-item ${s.id === active?.id ? 'active' : ''}`} onClick={() => setActiveId(s.id)}>
                <div className="session-main">
                  <div className="session-title">{s.title}</div>
                  <div className="session-meta">{getAgent(s.agentId).name} · {timeAgo(s.updatedAt)}</div>
                </div>
                <button className="session-del" title="Hapus sesi" onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}>×</button>
              </div>
            ))}
          </div>
        </div>

        <div className="side-actions">
          <button className="side-btn" onClick={() => { setPanel('memory'); void refreshMemory(); }}>🧠 Memory <span className="badge">{memCount}/{skillMemCount}</span></button>
          <button className="side-btn" onClick={() => { setPanel('skills'); void refreshSkills(); }}>🧩 Skills <span className="badge">{skillList.filter((s) => s.enabled).length}/{skillList.length}</span></button>
          <button className="side-btn" onClick={() => setPanel('settings')}>⚙ Settings</button>
          <button className="side-btn donate" onClick={() => setPanel('donate')}>❤ Dukung OflaBot</button>
        </div>
      </aside>

      {/* ============ MAIN ============ */}
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <span className="mode-pill">Chat</span>
            <button className={`btn icon ghost ${browserOpen ? 'on' : ''}`} title="Browser (Ctrl+Alt+B)"
              onClick={() => setBrowserOpen((v) => !v)}>🌐</button>
          </div>
          <div className="topbar-info">

            <button
              className="pill perm"
              title="Permission (klik untuk ganti)"
              onClick={() => void setPermission(permission === 'read-only' ? 'workspace' : permission === 'workspace' ? 'full' : 'read-only')}
            >
              🛡 {permission === 'read-only' ? 'Read Only' : permission === 'workspace' ? 'Workspace' : 'Full'}
            </button>
            {active?.planMode && <span className="pill plan">🗒 Plan</span>}
            <span className="pill">{agent.icon} {agent.name}</span>
            <span className="pill muted">{settings.model || 'pilih model'}</span>
            <span className="pill muted">{prov.name}</span>
            {learning && <span className="pill learn">belajar…</span>}
          </div>
        </header>

        <div className="body">
          <section className="chat-col">
            <div className="chat" ref={scrollRef}>
              {active?.goal && (
                <div className="goal-banner">
                  <span className="goal-icon">🎯</span>
                  <span className="goal-text"><b>Goal:</b> {active.goal}</span>
                  <button className="link" onClick={() => { setGoalDraft(active.goal || ''); setModal('goal'); }}>ubah</button>
                </div>
              )}
              {active?.planMode && (
                <div className="plan-banner">🗒 Mode rencana: OflaBot hanya menyusun rencana, tidak mengubah apa pun. <button className="link" onClick={() => void togglePlanMode()}>keluar</button></div>
              )}
              {(todos.length > 0 || (showPlan && running)) && (
                <div className="todo-card">
                  <div className="todo-head">
                    <span>📋 Langkah kerja</span>
                    <span className="muted">
                      {todos.length ? `${todos.filter((t) => t.status === 'completed').length}/${todos.length}` : 'menyusun…'}
                    </span>
                  </div>
                  {todos.length === 0 && <div className="todo-item"><span className="todo-mark">◐</span><span>Menyusun rencana langkah…</span></div>}
                  {todos.map((t, i) => (
                    <div key={i} className={`todo-item ${t.status}`}>
                      <span className="todo-mark">
                        {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
                      </span>
                      <span>{t.content}</span>
                    </div>
                  ))}
                </div>
              )}
              {blocks.length === 0 && (
                <div className="empty">
                  <h2>{agent.icon} {agent.name}</h2>
                  <p>{agent.description}</p>
                  <div className="suggestions">
                    <button onClick={() => setInput('Buka google.com lalu cari berita hari ini')}>Buka google.com dan cari berita</button>
                    <button onClick={() => setInput('Buka portal sekolah lalu ringkas isinya')}>Ringkas sebuah website</button>
                    <button onClick={() => setInput('Ingat: saya suka jawaban singkat dalam bahasa Indonesia')}>Ajari memory saya</button>
                  </div>
                </div>
              )}

              {blocks.map((b, i) => {
                const key = `${active?.id}-${i}`;
                if (b.kind === 'notice') return <div key={key} className="msg notice">{String(b.msg.content)}</div>;
                if (b.kind === 'activity') return <div key={key}>{renderActivity(b, key)}</div>;
                if (b.kind === 'user') {
                  return (
                    <div key={key} className="msg user">
                      <div className="content">{typeof b.msg.content === 'string' ? b.msg.content : pretty(b.msg.content, 4000)}</div>
                    </div>
                  );
                }
                return (
                  <div key={key} className="msg assistant">
                    <div className="role">{agent.name}</div>
                    <div className="content markdown">
                      {typeof b.msg.content === 'string' ? <RichText text={b.msg.content} /> : pretty(b.msg.content, 6000)}
                    </div>
                  </div>
                );
              })}

              {running && (
                <div className="thinking">
                  <span className="spinner" /> Thinking…
                </div>
              )}
            </div>

            <div className="composer">
              {attachments.length > 0 && (
                <div className="attach-row">
                  {attachments.map((a, i) => (
                    <span key={i} className={`attach-chip ${a.kind}`} title={a.path}>
                      {a.kind === 'image' ? '🖼' : a.kind === 'text' ? '📄' : '📎'} {a.name}
                      <button className="attach-x" onClick={() => setAttachments((prev) => prev.filter((_, k) => k !== i))}>×</button>
                    </span>
                  ))}
                </div>
              )}

              <div className="composer-main">
                <div className="attach-wrap">
                  <button
                    className={`btn icon add-btn ${menuOpen ? 'on' : ''}`}
                    title="Tambah (File, Goal, Plan, Permission, Model, Export)"
                    onClick={() => { setMenuOpen((v) => !v); setMenuView('root'); }}
                  >
                    ＋
                  </button>

                  {menuOpen && (
                    <div className="popmenu" onMouseLeave={() => setMenuView('root')}>
                      {menuView === 'root' ? (
                        <>
                          <div className="popmenu-label">Add</div>
                          <button className="popmenu-item" onClick={() => void pickFiles()}>
                            <span className="pi-icon">📎</span><span className="pi-text">File</span>
                            <span className="pi-hint">lampirkan gambar / file</span>
                          </button>
                          <button className="popmenu-item" onClick={() => { setMenuOpen(false); setGoalDraft(active?.goal || ''); setModal('goal'); }}>
                            <span className="pi-icon">🎯</span><span className="pi-text">Goal</span>
                            <span className="pi-hint">tujuan tugas panjang</span>
                          </button>
                          <button className="popmenu-item" onClick={() => void togglePlanMode()}>
                            <span className="pi-icon">🗒</span><span className="pi-text">Plan</span>
                            <span className="pi-hint">{active?.planMode ? 'keluar dari mode rencana' : 'mode rencana saja'}</span>
                          </button>
                          <button className="popmenu-item" onClick={() => { setMenuOpen(false); setModal('feedback'); }}>
                            <span className="pi-icon">💬</span><span className="pi-text">Feedback</span>
                            <span className="pi-hint">catat masukan sesi ini</span>
                          </button>

                          <div className="popmenu-label">Commands</div>
                          <button className="popmenu-item" onClick={() => { setMenuOpen(false); void compactHistory(); }} disabled={running}>
                            <span className="pi-icon">◐</span><span className="pi-text">Compact</span>
                            <span className="pi-hint">ringkas riwayat lama</span>
                          </button>
                          <button className="popmenu-item" onClick={() => setMenuView('permission')}>
                            <span className="pi-icon">🛡</span><span className="pi-text">Permission</span>
                            <span className="pi-hint">{permission === 'read-only' ? 'Read Only' : permission === 'workspace' ? 'Workspace Write' : 'Full access'}</span>
                            <span className="pi-chev">›</span>
                          </button>
                          <button className="popmenu-item" onClick={() => { setMenuOpen(false); setPanel('settings'); }}>
                            <span className="pi-icon">🧠</span><span className="pi-text">Model</span>
                            <span className="pi-hint">{settings.model || 'pilih model'}</span>
                          </button>
                          <button className="popmenu-item" onClick={() => { setMenuOpen(false); void exportSession(); }}>
                            <span className="pi-icon">⬇</span><span className="pi-text">Export</span>
                            <span className="pi-hint">simpan log sesi</span>
                          </button>
                          <button className="popmenu-item" onClick={() => { setMenuOpen(false); setMenuView('shell'); }}>
                            <span className="pi-icon">▸</span><span className="pi-text">Shell command</span>
                            <span className="pi-hint">jalankan perintah ( ! )</span>
                          </button>
                        </>
                      ) : menuView === 'permission' ? (
                        <>
                          <button className="popmenu-item" onClick={() => setMenuView('root')}>
                            <span className="pi-icon">‹</span><span className="pi-text">Permission</span>
                          </button>
                          {([
                            ['read-only', 'Read Only', 'hanya membaca, tanpa ubah apa pun'],
                            ['workspace', 'Workspace Write', 'boleh ubah file, tetap konfirmasi'],
                            ['full', 'Full access', 'tanpa konfirmasi'],
                          ] as const).map(([val, label, hint]) => (
                            <button key={val} className={`popmenu-item ${permission === val ? 'selected' : ''}`} onClick={() => void setPermission(val)}>
                              <span className="pi-icon">🛡</span><span className="pi-text">{label}</span>
                              <span className="pi-hint">{hint}</span>
                              {permission === val && <span className="pi-check">✓</span>}
                            </button>
                          ))}
                        </>
                      ) : (
                        <>
                          <button className="popmenu-item" onClick={() => setMenuView('root')}>
                            <span className="pi-icon">‹</span><span className="pi-text">Shell command</span>
                          </button>
                          <div className="popmenu-label">Jalankan perintah tanpa AI</div>
                          <div className="popmenu-input">
                            <input
                              autoFocus
                              value={shellDraft}
                              placeholder="mis. dir C:\\Users"
                              onChange={(e) => setShellDraft(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') void runShellCommand(); }}
                            />
                            <button className="btn primary" onClick={() => void runShellCommand()}>Jalankan</button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <textarea
                  value={input}
                  placeholder={`Perintah untuk ${agent.name}… (Enter kirim, Shift+Enter baris baru, ! perintah shell)`}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                />
              </div>

              <div className="composer-actions">
                <button className="btn primary" onClick={() => void send()} disabled={running}>Send</button>
                <button className="btn" onClick={() => { abortRef.current = true; }} disabled={!running}>Stop</button>
                {stepLimitHit && !running && (
                  <button className="btn continue" onClick={() => { setInput('lanjutkan'); setTimeout(() => void send(), 60); }}>
                    ▶ Lanjutkan
                  </button>
                )}
                <button className="btn ghost" onClick={() => active && updateSession(active.id, (s) => ({ ...s, messages: [] }))}>Clear</button>
              </div>
            </div>
          </section>

          {/* ============ BROWSER PANEL (collapsible) ============ */}
          <section className={`browser-col ${browserOpen ? 'open' : 'closed'}`}>
            {browserOpen ? (
              <div className="browser-panel">
                <div className="browser-bar">
                  <button className="btn icon" title="Kembali" onClick={() => void window.dsh.browser.action('back')} disabled={!browserState.canGoBack}>←</button>
                  <button className="btn icon" title="Maju" onClick={() => void window.dsh.browser.action('forward')} disabled={!browserState.canGoForward}>→</button>
                  <button className="btn icon" title="Muat ulang" onClick={() => void window.dsh.browser.action('reload')}>⟳</button>
                  <input className="url-input" value={urlInput} placeholder="Alamat atau kata pencarian…"
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void navigateBrowser(urlInput); } }} />
                  <button className="btn primary" onClick={() => void navigateBrowser(urlInput)}>Buka</button>
                  <button className="btn icon" title="Tutup browser (Ctrl+Alt+B)" onClick={() => setBrowserOpen(false)}>✕</button>
                </div>
                <div className="browser-slot" ref={browserSlotRef}>
                  {!browserState.url && (
                    <div className="browser-placeholder">
                      <div className="bp-icon">🌐</div>
                      <h3>Browser tertanam</h3>
                      <p>Halaman tampil di panel ini. Bisa ditutup dengan tombol ✕ atau Ctrl+Alt+B.</p>
                      <div className="suggestions"><button onClick={() => void navigateBrowser('google.com')}>google.com</button></div>
                    </div>
                  )}
                </div>
                <div className="browser-status">
                  <span>{browserState.title || '(tanpa judul)'}</span>
                  <span className="muted">{browserState.url}</span>
                </div>
              </div>
            ) : (
              <button className="browser-rail" title="Buka browser (Ctrl+Alt+B)" onClick={() => setBrowserOpen(true)}>
                <span>🌐</span>
              </button>
            )}
          </section>
        </div>
      </main>

      {notice && <div className="toast">{notice}</div>}

      {/* ============ MODAL: Goal / Feedback ============ */}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{modal === 'goal' ? '🎯 Goal sesi' : '💬 Feedback'}</h3>
              <button className="btn icon" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {modal === 'goal' ? (
                <div className="form">
                  <div className="hint">
                    Goal adalah tujuan jangka panjang untuk sesi ini. OflaBot akan terus mengingatnya dan mengarahkan
                    setiap langkah ke sana. Kosongkan untuk menghapus.
                  </div>
                  <label>Tujuan
                    <textarea
                      className="goal-input"
                      value={goalDraft}
                      onChange={(e) => setGoalDraft(e.target.value)}
                      placeholder="mis. Merapikan seluruh file kerja ke D:\Rapi dan memastikan tidak ada duplikat"
                      rows={4}
                    />
                  </label>
                  <div className="row-gap end">
                    <button className="btn ghost" onClick={() => setModal(null)}>Batal</button>
                    <button className="btn primary" onClick={saveGoal}>Simpan</button>
                  </div>
                </div>
              ) : (
                <div className="form">
                  <div className="hint">Masukan Anda membantu perbaikan OflaBot. Tersimpan lokal di profil aplikasi.</div>
                  <div className="rating-row">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        className={`rating ${feedbackRating >= n ? 'on' : ''}`}
                        onClick={() => setFeedbackRating(n)}
                        title={`${n} bintang`}
                      >★</button>
                    ))}
                  </div>
                  <label>Catatan
                    <textarea
                      className="goal-input"
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      placeholder="Apa yang kurang / apa yang bagus?"
                      rows={4}
                    />
                  </label>
                  <div className="row-gap end">
                    <button className="btn ghost" onClick={() => setModal(null)}>Batal</button>
                    <button className="btn primary" onClick={() => void saveFeedback()} disabled={!feedbackRating && !feedbackText.trim()}>Kirim</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============ PANELS ============ */}
      {panel && (
        <div className="modal-backdrop" onClick={() => setPanel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                {panel === 'settings' && '⚙ Settings'}
                {panel === 'memory' && '🧠 Memory & Skill Belajar'}
                {panel === 'skills' && '🧩 Skills'}
                {panel === 'donate' && '❤ Dukung OflaBot'}
              </h3>
              <button className="btn icon" onClick={() => setPanel(null)}>✕</button>
            </div>
            <div className="modal-body">
              {panel === 'settings' && (
                <div className="form">
                  <label>Provider
                    <select value={settings.provider} onChange={(e) => pickProvider(e.target.value)}>
                      {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  {prov.hint && <div className="hint">{prov.hint}</div>}
                  <label>Base URL
                    <input value={settings.baseUrl} onChange={(e) => setSettings((s) => ({ ...s, baseUrl: e.target.value }))} placeholder="https://api.provider.com" />
                  </label>
                  <label>API Key
                    <input type="password" value={settings.apiKey} onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))} placeholder={prov.noKey ? '(tidak perlu)' : 'sk-...'} />
                  </label>
                  <label>Model AI
                    <div className="model-row">
                      {manualModel ? (
                        <input value={settings.model} onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))} placeholder="nama model" />
                      ) : (
                        <select value={settings.model} onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}>
                          <option value="">{loadingModels ? 'memuat model…' : models.length ? '— pilih model —' : '— belum ada model —'}</option>
                          {models.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      )}
                      <button className="btn" onClick={() => void loadModels()} disabled={loadingModels}>⟳ Muat</button>
                    </div>
                  </label>
                  <div className="model-meta">
                    <span>{models.length ? `${models.length} model tersedia` : 'daftar model belum dimuat'}</span>
                    <button className="link" onClick={() => setManualModel((v) => !v)}>{manualModel ? 'pakai dropdown' : 'ketik manual'}</button>
                  </div>
                  {modelErr && <div className="err">Tidak bisa memuat daftar model: {modelErr}</div>}
                  <label className="check">
                    <input type="checkbox" checked={settings.autoLearn} onChange={(e) => setSettings((s) => ({ ...s, autoLearn: e.target.checked }))} />
                    Belajar otomatis (simpan memory & skill dari tiap sesi)
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings.accessMode === 'full'}
                      onChange={(e) => {
                        setSettings((s) => ({ ...s, accessMode: e.target.checked ? 'full' : 'normal' }));
                        setAutoApprove(false);
                      }}
                    />
                    Full Access — jalankan aksi berbahaya tanpa konfirmasi
                  </label>
                  <div className="hint">Tanpa Full Access: dialog konfirmasi muncul sekali, lalu semua aksi berikutnya di sesi itu otomatis diizinkan (klik Allow).</div>
                  <div className="hint">Versi {appVersion || '0.2.1'} · OflaBot</div>
                </div>
              )}

              {panel === 'memory' && (
                <div className="list-panel">
                  <div className="list-head">
                    <span>{memCount} memory · {skillMemCount} skill hasil belajar</span>
                    <div className="row-gap">
                      <button className="btn ghost" onClick={() => void refreshMemory()}>⟳</button>
                      <button className="btn ghost" onClick={async () => { await window.dsh.memory.clear(); void refreshMemory(); }}>Hapus semua</button>
                    </div>
                  </div>
                  {memEntries.length === 0 && <div className="empty-small">Belum ada memory. Agent menyimpannya otomatis setelah percakapan bermakna.</div>}
                  {memEntries.map((m) => (
                    <div key={m.id} className="card">
                      <div className="card-head">
                        <span className={`tag ${m.kind}`}>{m.kind}</span>
                        <b>{m.title}</b>
                        <button className="link danger" onClick={async () => { await window.dsh.memory.remove(m.id); void refreshMemory(); }}>hapus</button>
                      </div>
                      <div className="card-body">{m.body}</div>
                    </div>
                  ))}
                </div>
              )}

              {panel === 'skills' && (
                <div className="list-panel">
                  <div className="install-box">
                    <div className="hint">Pasang skill dari GitHub — format SKILL.md (Claude Code/Desktop, Codex, OpenCode, Hermes, VS Code).</div>
                    <div className="model-row">
                      <input value={repoInput} placeholder="owner/repo atau https://github.com/owner/repo"
                        onChange={(e) => setRepoInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void installSkills(); }} />
                      <button className="btn primary" onClick={() => void installSkills()} disabled={skillBusy}>Install</button>
                    </div>
                    <div className="row-gap">
                      <button className="btn ghost" onClick={() => void importLocalSkills()} disabled={skillBusy}>Import dari folder lokal</button>
                      <button className="btn ghost" onClick={() => void refreshSkills()}>⟳</button>
                    </div>
                    {skillMsg && <div className="hint">{skillMsg}</div>}
                    {skillsDir && <div className="hint mono">Folder skill: {skillsDir}</div>}
                  </div>
                  <div className="list-head"><span>{skillList.length} skill terpasang</span></div>
                  {skillList.length === 0 && <div className="empty-small">Belum ada skill. Tempel URL repo GitHub lalu klik Install.</div>}
                  {skillList.map((s) => (
                    <div key={s.slug} className="card">
                      <div className="card-head">
                        <input type="checkbox" checked={s.enabled} onChange={async (e) => { await window.dsh.skills.toggle(s.slug, e.target.checked); void refreshSkills(); }} />
                        <b>{s.name}</b>
                        <span className="tag">{s.source}</span>
                        <button className="link danger" onClick={async () => { await window.dsh.skills.remove(s.slug); void refreshSkills(); }}>hapus</button>
                      </div>
                      <div className="card-body">{s.description || '(tanpa deskripsi)'}</div>
                    </div>
                  ))}
                </div>
              )}

              {panel === 'donate' && (
                <div className="donate-panel">
                  <div className="donate-heart">❤</div>
                  <h4>Dukung pengembangan OflaBot</h4>
                  <p>OflaBot gratis dan dikembangkan mandiri. Kalau aplikasi ini membantu pekerjaan Anda, dukungan lewat Saweria sangat berarti untuk biaya server, API, dan waktu pengembangan.</p>
                  <div className="donate-actions">
                    <button className="btn primary big" onClick={() => void openDonate()}>Buka Saweria</button>
                    <button className="btn" onClick={() => { setPanel(null); setBrowserOpen(true); void navigateBrowser(DONATE_URL); }}>Buka di panel browser</button>
                  </div>
                  <div className="hint mono">{DONATE_URL}</div>
                  <div className="hint">Terima kasih atas dukungannya 🙏</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Render teks assistant sederhana: **bold**, `kode`, dan baris baru. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="inline-code">{p.slice(1, -1)}</code>;
        return <React.Fragment key={i}>{p}</React.Fragment>;
      })}
    </>
  );
}
