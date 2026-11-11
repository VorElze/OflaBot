import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TOOLS, runTool, isDangerous, extractImage } from './agent';
import { AGENTS, getAgent, toolNamesFor, type AgentDef } from './agents';
import { PROVIDERS, getProvider, isAnthropicLike } from './providers';

type Role = 'user' | 'assistant' | 'tool' | 'system' | 'notice';
type Msg = { role: Role; content: any; name?: string; tool_call_id?: string; tool_calls?: any[]; image?: string; ts?: number };
type Session = { id: string; title: string; agentId: string; messages: Msg[]; createdAt: number; updatedAt: number };
type Settings = { provider: string; baseUrl: string; apiKey: string; model: string; autoLearn: boolean };

const SESSIONS_KEY = 'oflabot.sessions.v1';
const ACTIVE_KEY = 'oflabot.active-session.v1';
const SETTINGS_KEY = 'oflabot.settings.v1';
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
  const fallback: Settings = { provider: 'openai', baseUrl: 'https://api.openai.com', apiKey: '', model: 'gpt-4o', autoLearn: true };
  try {
    const raw = readKey(SETTINGS_KEY, LEGACY.settings);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        // migrasi id provider lama
        const provider = String(p.provider || 'openai');
        const mapped = provider === 'syncera' ? 'syncera-anthropic' : provider;
        return {
          provider: mapped,
          baseUrl: p.baseUrl ?? fallback.baseUrl,
          apiKey: p.apiKey ?? '',
          model: p.model ?? '',
          autoLearn: p.autoLearn !== false,
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
  const cleaned = text.replace(/```json/gi, '```').split('```').map((s) => s.trim()).filter(Boolean);
  for (const chunk of [text, ...cleaned]) {
    const start = chunk.indexOf('{');
    const end = chunk.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(chunk.slice(start, end + 1)); } catch { /* lanjut */ }
    }
  }
  return null;
}

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
  const [tab, setTab] = useState<'chat' | 'browser'>('chat');
  const [panel, setPanel] = useState<null | 'settings' | 'memory' | 'skills' | 'donate'>(null);
  const [notice, setNotice] = useState('');

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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const browserSlotRef = useRef<HTMLDivElement | null>(null);
  const hostReady = typeof window !== 'undefined' && !!window.dsh;

  const active = useMemo(() => sessions.find((s) => s.id === activeId) || sessions[0], [sessions, activeId]);
  const agent = useMemo(() => getAgent(active?.agentId || 'oflabot'), [active?.agentId]);
  const prov = getProvider(settings.provider);
  const isAnthropic = isAnthropicLike(settings.provider);
  const browserToolOk = hostReady && !!window.dsh.browser;

  // ---------------- persistence ----------------
  useEffect(() => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } }, [settings]);
  useEffect(() => { try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(-80))); } catch { /* ignore */ } }, [sessions]);
  useEffect(() => { if (active?.id) { try { localStorage.setItem(ACTIVE_KEY, active.id); } catch { /* ignore */ } } }, [active?.id]);
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
      if (res.error) {
        setModelErr(typeof res.error === 'string' ? res.error : JSON.stringify(res.error).slice(0, 220));
      } else if (!list.length) {
        setModelErr('Provider tidak mengembalikan daftar model.');
      }
      if (list.length && !list.includes(settings.model) && !silent) {
        setSettings((s) => ({ ...s, model: list[0] }));
      }
    } catch (err: any) {
      setModelErr(err?.message || String(err));
    } finally {
      setLoadingModels(false);
    }
  }, [hostReady, settings.provider, settings.baseUrl, settings.apiKey, settings.model]);

  // muat otomatis saat provider/base/key berubah
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

  // ---------------- browser ----------------
  const syncBrowserBounds = useCallback(async () => {
    if (!browserToolOk) return;
    if (tab !== 'browser' || panel) { await window.dsh.browser.hide(); return; }
    const el = browserSlotRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    await window.dsh.browser.show({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
  }, [browserToolOk, tab, panel]);

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
    const offOpen = window.dsh.browser.onRequestOpen(({ url }) => { setTab('browser'); setUrlInput(url); });
    return () => { offState(); offOpen(); };
  }, [browserToolOk]);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [active?.messages.length, running]);

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
    setTab('chat');
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
    const st = await window.dsh.browser.navigate(url);
    setBrowserState(st);
    if (st.url) setUrlInput(st.url);
  }

  // ---------------- system prompt (agent + memory + skill) ----------------
  async function buildSystemPrompt(def: AgentDef): Promise<string> {
    let extra = '';
    try {
      const mem = await window.dsh.memory.context(40);
      if (mem.memories?.length) {
        extra += '\n\n=== MEMORY TERSIMPAN (ingat ini) ===\n' +
          mem.memories.map((m) => `- ${m.title}: ${m.body.slice(0, 400)}`).join('\n');
      }
      if (mem.skills?.length) {
        extra += '\n\n=== SKILL HASIL BELAJAR ===\n' +
          mem.skills.map((m) => `- ${m.title}: ${m.body.slice(0, 300)}`).join('\n');
      }
      const sk = await window.dsh.skills.context();
      if (sk.enabled?.length) {
        extra += '\n\n=== SKILL TERPASANG (panggil skill_read sebelum dipakai) ===\n' +
          sk.enabled.map((s: any) => `- ${s.slug} (${s.name}): ${s.description}`).join('\n');
      }
    } catch { /* abaikan */ }
    return def.system + extra;
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

  async function agentLoop(sessionId: string, userText: string, agentDef: AgentDef) {
    setRunning(true);
    abortRef.current = false;

    const allowed = toolNamesFor(agentDef.tools);
    const tools = TOOLS.filter((t: any) => allowed.includes(t.function.name));
    const allowedNames = tools.map((t: any) => t.function.name);
    const systemPrompt = await buildSystemPrompt(agentDef);

    let msgs: Msg[] = [...(sessions.find((s) => s.id === sessionId)?.messages ?? []), { role: 'user', content: userText }];
    appendMessage(sessionId, { role: 'user', content: userText, ts: Date.now() });

    let steps = 0;
    while (steps < 30 && !abortRef.current) {
      steps++;
      const payload = {
        provider: isAnthropic ? 'anthropic' : 'openai',
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        system: systemPrompt,
        messages: messagesForApi(msgs),
        tools: isAnthropic
          ? tools.map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }))
          : tools,
        tool_choice: isAnthropic ? undefined : 'auto',
      };

      const resp = await window.dsh.chat(payload);
      if (resp?.error) {
        appendMessage(sessionId, { role: 'notice', content: 'Error provider: ' + JSON.stringify(resp.error).slice(0, 600) });
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

          if (isDangerous(name, args)) {
            const ok = await window.dsh.confirm(`Izinkan aksi "${name}"?\n${JSON.stringify(args).slice(0, 300)}`);
            if (!ok) {
              const denied = { error: 'dibatalkan pengguna' };
              msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(denied), name });
              appendMessage(sessionId, { role: 'tool', name, tool_call_id: tc.id, content: JSON.stringify(denied) });
              continue;
            }
          }

          const result = await runTool(name, args);
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

          if (name === 'memory_save' || name === 'memory_delete' || name === 'skill_read') void refreshMemory();
        }
        continue;
      }

      msgs.push({ role: 'assistant', content: text });
      appendMessage(sessionId, { role: 'assistant', content: text || '(tanpa jawaban)' });
      break;
    }

    if (steps >= 30) appendMessage(sessionId, { role: 'notice', content: 'Batas 30 langkah agent tercapai. Kirim instruksi lanjutan.' });
    setRunning(false);
    void refreshMemory();
    return steps;
  }

  // ---------------- auto-learn (Hermes-style reflection) ----------------
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
        'Balas HANYA JSON valid dengan bentuk:\n' +
        '{"memories":[{"title":"...","body":"...","tags":["..."]}],"skills":[{"title":"...","body":"langkah 1...; langkah 2..."}]}\n' +
        'Jika tidak ada yang layak, balas {"memories":[],"skills":[]}. Jangan menyimpan rahasia (password/API key).\n\n' +
        'PERCAKAPAN:\n' + transcript;

      const resp = await window.dsh.chat({
        provider: isAnthropic ? 'anthropic' : 'openai',
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: [{ role: 'user', content: prompt }],
      });
      if (resp?.error || !resp?.text) return;
      const data = safeJson(resp.text);
      if (!data) return;
      let saved = 0;
      for (const m of data.memories || []) {
        if (m?.title && m?.body) { await window.dsh.memory.add({ kind: 'memory', title: m.title, body: m.body, tags: m.tags }); saved++; }
      }
      for (const s of data.skills || []) {
        if (s?.title && s?.body) { await window.dsh.memory.add({ kind: 'skill', title: s.title, body: s.body }); saved++; }
      }
      if (saved) {
        void refreshMemory();
        flash(`Belajar ${saved} hal baru dari sesi ini (memory/skill).`);
      }
    } catch { /* abaikan */ } finally {
      setLearning(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || running || !active) return;
    if (!hostReady) return;
    const p = getProvider(settings.provider);
    if (!settings.apiKey && !p.noKey) { setPanel('settings'); flash('Isi API Key dulu.'); return; }
    if (!settings.model) { setPanel('settings'); flash('Pilih model AI dulu.'); return; }

    setInput('');
    updateSession(active.id, (s) => ({ ...s, title: s.messages.length === 0 ? sessionTitle(text) : s.title }));
    const snapshot = active;
    await agentLoop(snapshot.id, text, getAgent(snapshot.agentId));
    const updated = { ...snapshot, messages: [...snapshot.messages] };
    try {
      const fresh = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]') as Session[];
      const s2 = fresh.find((x) => x.id === snapshot.id);
      if (s2) void learnFromSession(s2);
    } catch { void learnFromSession(updated); }
  }

  // ---------------- skills actions ----------------
  async function installSkills() {
    if (!repoInput.trim()) return;
    setSkillBusy(true); setSkillMsg('Mengambil skill dari GitHub…');
    try {
      const r = await window.dsh.skills.installRepo(repoInput.trim());
      if (r?.error) setSkillMsg('Gagal: ' + r.error);
      else {
        setSkillMsg(`Selesai: ${r.installed?.length || 0}/${r.found || 0} skill terpasang.`);
        setRepoInput('');
        void refreshSkills();
      }
    } catch (err: any) { setSkillMsg('Gagal: ' + (err?.message || String(err))); }
    finally { setSkillBusy(false); }
  }

  async function importLocalSkills() {
    setSkillBusy(true); setSkillMsg('Memindai folder skill Claude/Codex/OpenCode/Hermes/VS Code…');
    try {
      const r = await window.dsh.skills.importLocal();
      setSkillMsg(`Ditemukan ${r.found || 0}, ditambahkan ${r.added || 0}.`);
      void refreshSkills();
    } catch (err: any) { setSkillMsg('Gagal: ' + (err?.message || String(err))); }
    finally { setSkillBusy(false); }
  }

  // ---------------- render ----------------
  const messages = active?.messages ?? [];
  const memCount = memEntries.filter((m) => m.kind === 'memory').length;
  const skillMemCount = memEntries.filter((m) => m.kind === 'skill').length;

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
              <button
                key={a.id}
                className={`agent-item ${active?.agentId === a.id ? 'active' : ''}`}
                title={a.description}
                onClick={() => active && updateSession(active.id, (s) => ({ ...s, agentId: a.id }))}
              >
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
              <div key={s.id} className={`session-item ${s.id === active?.id ? 'active' : ''}`} onClick={() => { setActiveId(s.id); setTab('chat'); }}>
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
          <button className="side-btn" onClick={() => { setPanel('memory'); void refreshMemory(); }}>
            🧠 Memory <span className="badge">{memCount}/{skillMemCount}</span>
          </button>
          <button className="side-btn" onClick={() => { setPanel('skills'); void refreshSkills(); }}>
            🧩 Skills <span className="badge">{skillList.filter((s) => s.enabled).length}/{skillList.length}</span>
          </button>
          <button className="side-btn" onClick={() => setPanel('settings')}>⚙ Settings</button>
          <button className="side-btn donate" onClick={() => setPanel('donate')}>❤ Dukung OflaBot</button>
        </div>
      </aside>

      {/* ============ MAIN ============ */}
      <main className="main">
        <header className="topbar">
          <div className="tabs">
            <button className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>Chat</button>
            <button className={`tab ${tab === 'browser' ? 'active' : ''}`} onClick={() => setTab('browser')}>Browser</button>
          </div>
          <div className="topbar-info">
            <span className="pill">{agent.icon} {agent.name}</span>
            <span className="pill muted">{settings.model || 'pilih model'}</span>
            <span className="pill muted">{prov.name}</span>
            {learning && <span className="pill learn">belajar…</span>}
          </div>
        </header>

        {tab === 'chat' ? (
          <>
            <div className="chat" ref={scrollRef}>
              {messages.length === 0 && (
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
              {messages.map((m, i) => {
                if (m.role === 'notice') return <div key={i} className="msg notice">{String(m.content)}</div>;
                if (m.role === 'tool') {
                  return (
                    <div key={i} className="msg tool">
                      <div className="role">tool · {m.name}</div>
                      <div className="content mono">{typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}</div>
                      {m.image && <img className="tool-image" src={m.image} alt="snapshot" />}
                    </div>
                  );
                }
                return (
                  <div key={i} className={`msg ${m.role}`}>
                    <div className="role">{m.role}</div>
                    <div className="content">{typeof m.content === 'string' ? m.content : <pre className="mono">{JSON.stringify(m.content, null, 2)}</pre>}</div>
                    {m.tool_calls && (
                      <div className="tools">{m.tool_calls.map((t: any, k: number) => <span key={k} className="tool-chip">{t.function?.name}</span>)}</div>
                    )}
                  </div>
                );
              })}
              {running && <div className="msg assistant"><div className="content">Thinking…</div></div>}
            </div>

            <div className="composer">
              <textarea
                value={input}
                placeholder={`Perintah untuk ${agent.name}… (Enter kirim, Shift+Enter baris baru)`}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              />
              <div className="composer-actions">
                <button className="btn primary" onClick={() => void send()} disabled={running}>Send</button>
                <button className="btn" onClick={() => { abortRef.current = true; }} disabled={!running}>Stop</button>
                <button className="btn ghost" onClick={() => active && updateSession(active.id, (s) => ({ ...s, messages: [] }))}>Clear</button>
              </div>
            </div>
          </>
        ) : (
          <div className="browser-pane">
            <div className="browser-bar">
              <button className="btn icon" title="Kembali" onClick={() => void window.dsh.browser.action('back')} disabled={!browserState.canGoBack}>←</button>
              <button className="btn icon" title="Maju" onClick={() => void window.dsh.browser.action('forward')} disabled={!browserState.canGoForward}>→</button>
              <button className="btn icon" title="Muat ulang" onClick={() => void window.dsh.browser.action('reload')}>⟳</button>
              <input className="url-input" value={urlInput} placeholder="Ketik alamat atau kata pencarian, lalu Enter…"
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void navigateBrowser(urlInput); } }} />
              <button className="btn primary" onClick={() => void navigateBrowser(urlInput)}>Buka</button>
              <button className="btn icon" title="DevTools" onClick={() => void window.dsh.browser.devtools()}>🛠</button>
            </div>
            <div className="browser-slot" ref={browserSlotRef}>
              {!browserState.url && (
                <div className="browser-placeholder">
                  <div className="bp-icon">🌐</div>
                  <h3>Browser tertanam</h3>
                  <p>Halaman tampil di area ini. Ketik alamat di atas, atau minta agent "buka google.com".</p>
                  <div className="suggestions">
                    <button onClick={() => void navigateBrowser('google.com')}>google.com</button>
                  </div>
                </div>
              )}
            </div>
            {browserState.loading && <div className="browser-loading" />}
            <div className="browser-status">
              <span>{browserState.title || '(tanpa judul)'}</span>
              <span className="muted">{browserState.url}</span>
            </div>
          </div>
        )}
      </main>

      {notice && <div className="toast">{notice}</div>}

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
                  <div className="hint">Versi {appVersion || '0.2.0'} · OflaBot</div>
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
                  {memEntries.length === 0 && <div className="empty-small">Belum ada memory. Agent akan menyimpan otomatis setelah percakapan bermakna.</div>}
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
                    <div className="hint">Pasang skill dari GitHub — mendukung format SKILL.md (Claude Code/Desktop, Codex, OpenCode, Hermes, VS Code).</div>
                    <div className="model-row">
                      <input value={repoInput} placeholder="owner/repo atau https://github.com/owner/repo" onChange={(e) => setRepoInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void installSkills(); }} />
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
                  <p>
                    OflaBot gratis dan dikembangkan mandiri. Kalau aplikasi ini membantu pekerjaan Anda,
                    dukungan lewat Saweria sangat berarti untuk biaya server, API, dan waktu pengembangan.
                  </p>
                  <div className="donate-actions">
                    <button className="btn primary big" onClick={() => void window.dsh.openExternal(DONATE_URL)}>Buka Saweria</button>
                    <button className="btn" onClick={() => { setTab('browser'); setPanel(null); void navigateBrowser(DONATE_URL); }}>Lihat di browser aplikasi</button>
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
