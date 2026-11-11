import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TOOLS, runTool, isDangerous, extractImage, setAgentRuntime } from './agent';
import { AGENTS, getAgent, toolNamesFor, type AgentDef } from './agents';
import { PROVIDERS, getProvider, isAnthropicLike } from './providers';

type Role = 'user' | 'assistant' | 'tool' | 'system' | 'notice';
type Msg = { role: Role; content: any; name?: string; tool_call_id?: string; tool_calls?: any[]; image?: string; ts?: number };
type Session = { id: string; title: string; agentId: string; messages: Msg[]; createdAt: number; updatedAt: number; goal?: string; planMode?: boolean };
type Permission = 'read-only' | 'workspace' | 'full';
type RuleAction = 'allow' | 'ask' | 'deny';
type PermissionRule = { id: string; tool: string; pattern: string; action: RuleAction };
type Settings = {
  provider: string; baseUrl: string; apiKey: string; model: string;
  autoLearn: boolean; accessMode: 'normal' | 'full'; permission: Permission;
  tokenSaver: { rtk: boolean; caveman: boolean; ponytail: boolean };
  rules: PermissionRule[];
  webSearch: { provider: string; apiKey: string; baseUrl: string };
};

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
  const fallback: Settings = {
  provider: 'openai', baseUrl: 'https://api.openai.com', apiKey: '', model: 'gpt-4o',
  autoLearn: true, accessMode: 'normal', permission: 'workspace',
  tokenSaver: { rtk: true, caveman: false, ponytail: false },
  rules: [],
  webSearch: { provider: 'duckduckgo', apiKey: '', baseUrl: '' },
};
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
          tokenSaver: {
            rtk: p.tokenSaver?.rtk !== false,
            caveman: p.tokenSaver?.caveman === true,
            ponytail: p.tokenSaver?.ponytail === true,
          },
          rules: Array.isArray(p.rules)
            ? p.rules.filter((r: any) => r && typeof r === 'object')
              .map((r: any) => ({
                id: String(r.id || uid()),
                tool: String(r.tool || '*'),
                pattern: String(r.pattern || '*'),
                action: (r.action === 'allow' || r.action === 'deny' ? r.action : 'ask') as RuleAction,
              }))
            : [],
          webSearch: {
            provider: String(p.webSearch?.provider || 'duckduckgo'),
            apiKey: String(p.webSearch?.apiKey || ''),
            baseUrl: String(p.webSearch?.baseUrl || ''),
          },
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

/**
 * Token Saver — RTK (Compress tool output).
 * Ringkas hasil tool untuk dikirim ke model: buang key besar, batasi list & panjang.
 * UI tetap menampilkan versi penuh.
 */
function compressToolResult(name: string, result: any, full: string, aggressive = true): string {
  const MAX = aggressive ? 1200 : 4000;
  try {
    if (!result || typeof result !== 'object') return String(full).slice(0, MAX);

    // Daftar file/folder: SELALU diringkas (nama saja + hitungan). Path lengkap
    // diulang-ulang bikin konteks model cepat penuh.
    if (Array.isArray(result.entries)) {
      const entries = result.entries as any[];
      const take = aggressive ? 8 : 30;
      const sample = entries.slice(0, take).map((e) => (e.dir ? '[dir] ' : '') + (e.name || e.path));
      return JSON.stringify({
        ok: result.ok, base: result.base, count: result.count, truncated: result.truncated,
        sample, note: entries.length > sample.length ? `${entries.length - sample.length} entri lain disembunyikan (pakai pola/pattern untuk mempersempit)` : undefined,
      }).slice(0, MAX);
    }

    // exec: kode + potongan output
    if ('stdout' in result || 'stderr' in result) {
      const lim = aggressive ? 600 : 1500;
      return JSON.stringify({
        code: result.code, timedOut: result.timedOut, truncated: result.truncated,
        stdout: String(result.stdout || '').slice(0, lim),
        stderr: String(result.stderr || '').slice(0, aggressive ? 400 : 800),
      }).slice(0, MAX);
    }

    // browser_text / teks panjang
    if (typeof result.text === 'string' && result.text.length > 500) {
      return JSON.stringify({ ...result, text: result.text.slice(0, aggressive ? 700 : 1800) + '…(dipotong; pakai bagian penting saja)' }).slice(0, MAX);
    }

    // gambar tidak perlu base64 di teks
    if (result.dataUrl) return JSON.stringify({ ...result, dataUrl: '(gambar terkirim terpisah)' }).slice(0, MAX);

    // generik: minify + batasi. Potong TENGAH (head+tail) seperti pruner DSH,
    // supaya awal & akhir output tetap terlihat model.
    const minified = JSON.stringify(result).replace(/\s{2,}/g, ' ');
    if (minified.length <= MAX) return minified;
    const head = Math.max(200, MAX - 500);
    const tail = 400;
    const omitted = minified.length - head - tail;
    return minified.slice(0, head) + `\n\n[... ${omitted} karakter tengah dipotong ...]\n\n` + minified.slice(-tail);
  } catch {
    return String(full).slice(0, MAX);
  }
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
      const note = typeof m.content === 'string' && m.content.trim() && m.content !== '(memanggil tool)' ? m.content : undefined;
      const prev = blocks[blocks.length - 1];
      // Gabungkan pemanggilan tool berurutan jadi SATU kartu supaya kolom chat
      // tidak penuh baris "Used file_list" (gaya DSH/OpenCode).
      if (prev && prev.kind === 'activity' && !prev.text && !note) {
        prev.items.push(...items);
      } else {
        blocks.push({ kind: 'activity', items, text: note });
      }
      i++;
      continue;
    }

    if (m.role === 'user') { blocks.push({ kind: 'user', msg: m }); i++; continue; }
    if (m.role === 'assistant') { blocks.push({ kind: 'assistant', msg: m }); i++; continue; }
    i++;
  }
  return blocks;
}

/** Peta tool -> kategori (mengikuti pola DSH: judul grup memakai kategori, bukan nama tool). */
function toolCategory(name: string): { key: string; label: string } {
  const n = name || '';
  if (n === 'file_list' || n === 'file_stat' || n === 'file_read') return { key: 'read', label: 'Membaca file' };
  if (n === 'file_glob' || n === 'file_search') return { key: 'search', label: 'Mencari file' };
  if (n === 'exec' || n === 'launch') return { key: 'commands', label: 'Menjalankan perintah' };
  if (n === 'file_move' || n === 'file_copy' || n === 'file_write' || n === 'file_mkdir' || n === 'file_edit' || n === 'file_delete') return { key: 'write', label: 'Mengubah file' };
  if (n.startsWith('browser_') || n === 'web_search') return { key: 'web', label: 'Menjelajah web' };
  if (n.startsWith('memory_') || n.startsWith('skill_')) return { key: 'memory', label: 'Mengingat hal penting' };
  if (n === 'spawn_subagents') return { key: 'subagents', label: 'Menjalankan sub-agent' };
  if (n === 'todo_write' || n === 'session_log') return { key: 'plan', label: 'Menyusun rencana' };
  if (n === 'ask_user') return { key: 'ask', label: 'Menanyakan ke pengguna' };
  if (n === 'screenshot' || n === 'mouse' || n === 'type' || n === 'keys') return { key: 'desktop', label: 'Mengoperasikan layar' };
  return { key: 'tools', label: 'Memakai tool' };
}

function activitySummary(items: ActivityItem[]): string {
  const counts = new Map<string, number>();
  const labelOf = new Map<string, string>();
  for (const it of items) {
    const cat = toolCategory(it.name || 'tool');
    counts.set(cat.key, (counts.get(cat.key) || 0) + 1);
    labelOf.set(cat.key, cat.label);
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const labels = ranked.map(([k]) => labelOf.get(k) || 'Memakai tool');
  let title: string;
  if (labels.length === 0) title = 'Bekerja';
  else if (labels.length === 1) title = labels[0];
  else if (labels.length === 2) title = `${labels[0]} dan ${labels[1].toLowerCase()}`;
  else title = `${labels[0]}, ${labels[1].toLowerCase()}, dan ${labels[2].toLowerCase()}`;
  title += counts.size > 3 ? ', dll.' : '';
  return title;
}

/** Tool yang hanya membaca: aman di-cache & tidak mengubah apa pun di komputer. */
const READ_ONLY_TOOLS = new Set([
  'file_list', 'file_glob', 'file_search', 'file_stat', 'file_read', 'browser_text', 'browser_snapshot',
  'browser_open', 'memory_search', 'skill_list', 'skill_read', 'session_log', 'screenshot', 'ask_user',
  'web_search', 'spawn_subagents',
]);

/** Aksi di browser yang MENGUBAH state halaman — dihitung sebagai kemajuan. */
const BROWSER_ACTION_TOOLS = new Set([
  'browser_open', 'browser_action', 'browser_click', 'browser_fill', 'browser_pdf', 'browser_wait',
]);
/**
 * Normalisasi perintah shell untuk deteksi duplikat. `dir /b C:\\`,
 * `dir C:\\ /b`, `cmd /c "dir C:\\ /b"`, dan `powershell -Command Get-ChildItem C:\\`
 * dianggap panggilan yang sama (model sering "berpindah dialek" untuk hal sama).
 */
function canonExecCommand(cmd: string): string {
  let c = String(cmd || '').toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();
  c = c.replace(/^cmd(\.exe)?\s+(\/c|\/k)\s+/, '');
  c = c.replace(/^powershell(\.exe)?\s+(-command|-c)\s+/, '');
  c = c.replace(/\s*2>&1\s*/g, ' ');
  c = c.replace(/\s*\|\s*(more|findstr[^|]*|select-object[^|]*|sort-object[^|]*|measure-object[^|]*|group-object[^|]*)$/, '');
  c = c.replace(/[\\]+$/, '').replace(/\s+/g, ' ').trim();
  const tokens = c.split(' ').filter(Boolean);
  const verb = tokens[0] || '';
  // Perintah daftar: urutan opsi tidak penting, jadi samakan dengan sorting token.
  if (['dir', 'ls', 'get-childitem', 'gci', 'tree'].includes(verb)) tokens.sort();
  return tokens.join(' ');
}

/** Perintah shell yang benar-benar mengubah sistem/berkas (bukan sekadar membaca). */
const MUTATING_VERBS = new Set([
  'move', 'move-item', 'copy', 'copy-item', 'mkdir', 'md', 'ren', 'rename', 'rename-item',
  'del', 'erase', 'rmdir', 'rd', 'remove-item', 'xcopy', 'robocopy', 'set-content', 'out-file',
  'add-content', 'new-item', 'git', 'npm', 'pnpm', 'yarn', 'node', 'python', 'py', 'pip',
  'dotnet', 'msbuild', 'cargo', 'go', 'curl', 'wget', 'invoke-webrequest', 'invoke-restmethod',
  'start-process', 'schtasks', 'reg', 'sc', 'net', 'taskkill', 'diskpart', 'format', 'attrib',
  'icacls', 'takeown', 'mklink', 'tar', '7z', 'expand', 'compact', 'shutdown', 'restart',
]);

function execVerb(cmd: string): string {
  const c = canonExecCommand(cmd);
  return (c.split(' ')[0] || '').replace(/\.exe$/, '');
}

/** Apakah panggilan ini mengubah sesuatu? Kalau tidak, tidak dihitung sebagai kemajuan. */
function isMutatingCall(name: string, args: any): boolean {
  if (['file_move', 'file_copy', 'file_write', 'file_edit', 'file_delete', 'file_mkdir', 'apply_patch', 'launch', 'mouse', 'type', 'keys'].includes(name)) return true;
  if (name === 'exec') return MUTATING_VERBS.has(execVerb(args?.cmd || ''));
  return false;
}

/** Path sistem yang TIDAK boleh dipindah/dihapus otomatis, walau Full Access. */
const PROTECTED_ROOTS = [
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\\$recycle\.bin/i,
  /^[a-z]:\\system volume information/i,
  /^[a-z]:\\recovery(\\|$)/i,
  /\\appdata(\\|$)/i,
];

function protectionViolation(name: string, args: any): string {
  const paths: string[] = [];
  if (name === 'file_move' || name === 'file_copy') paths.push(String(args?.src || ''), String(args?.dest || ''));
  if (name === 'file_delete') paths.push(String(args?.path || ''));
  if (name === 'file_write' || name === 'file_edit') paths.push(String(args?.path || ''));
  if (name === 'apply_patch') paths.push(...(Array.isArray(args?.changes) ? args.changes : []).map((c: any) => String(c?.path || '')));
  if (name === 'exec') {
    const cmd = String(args?.cmd || '');
    if (/\b(move|del|erase|rmdir|rd|xcopy|robocopy|copy|move-item|remove-item|rename-item|new-item|set-content|out-file|remove-item)\b/i.test(cmd)) {
      paths.push(...(cmd.match(/[a-z]:\\[^\s"']*/gi) || []));
    }
  }
  for (const raw of paths) {
    const p = String(raw || '').replace(/["']/g, '').trim();
    if (!p) continue;
    if (PROTECTED_ROOTS.some((r) => r.test(p))) return p;
  }
  return '';
}

/** Target (path/perintah) yang dipakai aturan izin untuk mencocokkan pola. */
function ruleTargetOf(name: string, args: any): string {
  if (name === 'exec') return String(args?.cmd || '');
  if (name === 'file_move' || name === 'file_copy') return `${args?.src || ''} -> ${args?.dest || ''}`;
  if (name === 'apply_patch') return (Array.isArray(args?.changes) ? args.changes : []).map((c: any) => String(c?.path || '')).join(' | ');
  if (['file_delete', 'file_write', 'file_edit', 'file_read', 'file_stat', 'file_mkdir'].includes(name)) return String(args?.path || args?.dir || '');
  if (['file_list', 'file_glob', 'file_search'].includes(name)) return String(args?.dir || '');
  return '';
}

function ruleMatches(rule: PermissionRule, name: string, target: string): boolean {
  if (rule.tool !== '*' && rule.tool !== name) return false;
  const pat = String(rule.pattern || '*').trim();
  if (!pat || pat === '*') return true;
  if (!target) return false;
  const rx = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return rx.test(target) || rx.test(target.toLowerCase()) || target.toLowerCase().includes(pat.toLowerCase().replace(/\*/g, ''));
}

/** Urutan prioritas: deny > ask > allow. null = tidak ada aturan yang cocok. */
function decideRule(rules: PermissionRule[], name: string, args: any): { action: RuleAction; rule: PermissionRule } | null {
  const target = ruleTargetOf(name, args);
  const matched = (rules || []).filter((r) => ruleMatches(r, name, target));
  if (!matched.length) return null;
  for (const action of ['deny', 'ask', 'allow'] as RuleAction[]) {
    const r = matched.find((m) => m.action === action);
    if (r) return { action, rule: r };
  }
  return null;
}

function toolSignature(name: string, args: any): string {
  if (name === 'exec') return 'exec|' + canonExecCommand(args?.cmd || '');  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: any = {};
      for (const k of Object.keys(v).sort()) {
        if (k === 'max' || k === 'timeoutMs' || k === 'cwd' || k === 'limit') continue;
        out[k] = norm(v[k]);
      }
      return out;
    }
    if (typeof v === 'string') return v.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
    return v;
  };
  try { return name + '|' + JSON.stringify(norm(args)); } catch { return name + '|' + String(args); }
}

function estimateMsgsChars(list: Msg[]): number {
  let n = 0;
  for (const m of list) {
    if (typeof m.content === 'string') n += m.content.length;
    else if (m.content) { try { n += JSON.stringify(m.content).length; } catch { /* ignore */ } }
    if (m.tool_calls) { try { n += JSON.stringify(m.tool_calls).length; } catch { /* ignore */ } }
  }
  return n;
}

/**
 * Auto-compaction (mirip DSH/OpenCode): kalau konteks membengkak, riwayat lama
 * diringkas jadi satu catatan. Hanya memotong pada batas pesan user supaya
 * pasangan tool_call <-> hasil tool tidak pernah terputus.
 */
function compactContext(list: Msg[], limitChars = 110000): { msgs: Msg[]; dropped: number } {
  if (list.length < 30 || estimateMsgsChars(list) <= limitChars) return { msgs: list, dropped: 0 };
  let cut = list.length - 24;
  while (cut > 0 && list[cut]?.role !== 'user') cut--;
  while (cut < list.length && (list[cut]?.role === 'tool' || (list[cut] as any)?.role === 'notice')) cut++;
  if (cut <= 1) return { msgs: list, dropped: 0 };

  const dropped = list.slice(0, cut);
  const counts = new Map<string, number>();
  const notes: string[] = [];
  for (const m of dropped) {
    if (m.role === 'tool' && m.name) counts.set(m.name, (counts.get(m.name) || 0) + 1);
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim() && m.content !== '(memanggil tool)') {
      const t = m.content.trim();
      if (t.length > 40) notes.push(t.slice(0, 240));
    }
  }
  const users = dropped
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => String(m.content).slice(0, 220));
  const parts = ['[RINGKASAN RIWAYAT LAMA — dibuat otomatis karena konteks sudah panjang]'];
  if (users.length) parts.push('Permintaan pengguna sebelumnya: ' + users.slice(-4).join(' | '));
  if (counts.size) parts.push('Tool yang sudah dipanggil: ' + Array.from(counts.entries()).map(([n, c]) => `${n}×${c}`).join(', '));
  if (notes.length) parts.push('Catatan dari langkah sebelumnya: ' + notes.slice(-4).join(' | '));
  parts.push('Lanjutkan dari keadaan terakhir. JANGAN mengulang langkah yang sudah tercatat di ringkasan ini.');
  return { msgs: [{ role: 'user', content: parts.join('\n') } as Msg, ...list.slice(cut)], dropped: cut };
}

/** Log pekerjaan sesi ini (dipakai tool session_log untuk laporan progres/error). */
function buildSessionLog(list: Msg[]): any {
  const counts = new Map<string, number>();
  const errors: string[] = [];
  const lines: string[] = [];
  for (const m of list) {
    if (m.role === 'notice') { lines.push(`! ${String(m.content).slice(0, 200)}`); continue; }
    if (m.role === 'user') {
      const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      lines.push('USER: ' + t.replace(/\s+/g, ' ').slice(0, 240));
      continue;
    }
    if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const n = tc.function?.name || '?';
          counts.set(n, (counts.get(n) || 0) + 1);
          lines.push(`  → ${n}(${String(tc.function?.arguments || '').replace(/\s+/g, ' ').slice(0, 120)})`);
        }
      } else if (typeof m.content === 'string' && m.content.trim()) {
        lines.push('AI: ' + m.content.replace(/\s+/g, ' ').slice(0, 260));
      }
      continue;
    }
    if (m.role === 'tool') {
      let r: any = m.content;
      if (typeof r === 'string') { try { r = JSON.parse(r); } catch { /* biarkan */ } }
      const err = r && typeof r === 'object' ? r.error : '';
      if (err) errors.push(`${m.name}: ${String(err).slice(0, 160)}`);
      const extra = r && typeof r === 'object'
        ? (r.count !== undefined ? `count=${r.count}` : r.code !== undefined ? `code=${r.code}` : err ? `error=${String(err).slice(0, 80)}` : 'ok')
        : 'ok';
      lines.push(`  ← ${m.name} ${extra}`);
    }
  }
  return {
    ok: true,
    total_events: lines.length,
    tool_totals: Object.fromEntries(counts),
    errors: errors.slice(-12),
    log: lines.slice(-90),
    note: 'Ini log internal sesi. Untuk laporan, ringkas dari log ini; jangan mengarang dan jangan membaca folder lain.',
  };
}

/**
 * Ringkasan pekerjaan deterministik (tanpa model) dipakai saat model berhenti
 * tanpa jawaban setelah pengaman kemajuan. Dibuat dari log + todo yang nyata.
 */
function buildWorkReport(list: Msg[], todos: { content: string; status: string }[]): string {
  const counts = new Map<string, number>();
  const errors: string[] = [];
  const moved: string[] = [];
  for (const m of list) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        const n = tc.function?.name || '';
        counts.set(n, (counts.get(n) || 0) + 1);
        if (n === 'file_move' || n === 'file_copy') {
          try {
            const a = JSON.parse(tc.function?.arguments || '{}');
            if (a?.src) moved.push(`${a.src} → ${a.dest || '?'}${a.copy ? ' (copy)' : ''}`);
          } catch { /* ignore */ }
        }
      }
    }
    if (m.role === 'tool') {
      const c = String(m.content || '');
      if (c.includes('"error"')) {
        try {
          const j = JSON.parse(c);
          if (j?.error) errors.push(`${m.name}: ${String(j.error).slice(0, 120)}`);
        } catch { /* ignore */ }
      }
    }
  }
  const lines: string[] = ['Ringkasan pekerjaan (dibuat otomatis oleh OflaBot):'];
  if (todos.length) lines.push(`- Rencana: ${todos.filter((t) => t.status === 'completed').length}/${todos.length} langkah selesai.`);
  const acts = ['file_move', 'file_copy', 'file_delete', 'file_edit', 'file_write', 'file_mkdir']
    .map((n) => [n, counts.get(n) || 0] as [string, number]).filter(([, c]) => c > 0);
  if (acts.length) lines.push('- Aksi nyata: ' + acts.map(([n, c]) => `${n} ×${c}`).join(', ') + '.');
  if (moved.length) lines.push('- Contoh file diproses: ' + moved.slice(-8).join(' | '));
  const reads = ['file_list', 'file_glob', 'file_search', 'file_read', 'file_stat', 'exec']
    .map((n) => [n, counts.get(n) || 0] as [string, number]).filter(([, c]) => c > 0);
  if (reads.length) lines.push('- Pemeriksaan: ' + reads.map(([n, c]) => `${n} ×${c}`).join(', ') + '.');
  if (errors.length) lines.push('- Kendala: ' + Array.from(new Set(errors)).slice(0, 5).join('; '));
  const pending = todos.filter((t) => t.status !== 'completed').map((t) => t.content);
  if (pending.length) lines.push('- Belum selesai: ' + pending.slice(0, 4).join('; ') + '.');
  lines.push('- Langkah berikutnya: jalankan ulang perintah dengan cakupan lebih sempit (mis. satu folder), atau ganti model di Settings.');
  return lines.join('\n');
}

/**
 * Perkecil/normalisasi gambar tempelan (pola DSH: cap dimensi & ukuran file)
 * supaya tidak ditolak provider vision dan tidak membengkakkan konteks.
 */
async function normalizeImageDataUrl(dataUrl: string, maxDim = 1600, maxBytes = 3_000_000): Promise<string> {
  try {
    if (!dataUrl.startsWith('data:image/')) return dataUrl;
    const bytesOf = (u: string) => Math.floor((u.length - u.indexOf(',') - 1) * 0.75);
    if (bytesOf(dataUrl) <= maxBytes) return dataUrl;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = dataUrl;
    });
    let width = img.naturalWidth || 1280;
    let height = img.naturalHeight || 720;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    for (let attempt = 0; attempt < 3; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const c2d = canvas.getContext('2d');
      if (!c2d) return dataUrl;
      c2d.drawImage(img, 0, 0, width, height);
      const out = canvas.toDataURL('image/png');
      if (bytesOf(out) <= maxBytes) return out;
      width = Math.max(320, Math.round(width * 0.7));
      height = Math.max(240, Math.round(height * 0.7));
    }
    return dataUrl;
  } catch {
    return dataUrl;
  }
}

const ICON: Record<string, string> = {
  browser_open: '🌐', browser_text: '📄', browser_snapshot: '🖼', browser_click: '👆', browser_fill: '⌨',
  browser_action: '🧭', screenshot: '📸', exec: '⚡', launch: '🚀', mouse: '🖱', type: '⌨', keys: '⌨',
  memory_save: '🧠', memory_search: '🔎', memory_delete: '🗑',
  skill_list: '🧩', skill_read: '📘', confirm: '✅', confirm_dangerous: '✅',
  file_read: '📖', file_write: '💾', file_list: '📂', file_glob: '🔎', file_search: '🔍',
  file_move: '📦', file_copy: '🧾', file_delete: '🗑', file_edit: '✏', file_mkdir: '📁', file_stat: '📄',
  todo_write: '📋', session_log: '🧾', ask_user: '❓',
  web_search: '🔎', apply_patch: '🩹', spawn_subagents: '👥',
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
  const [queue, setQueue] = useState<{ id: string; text: string }[]>([]);
  const [browserOpen, setBrowserOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(BROWSER_OPEN_KEY) !== '0'; } catch { return true; }
  });
  const [panel, setPanel] = useState<null | 'settings' | 'memory' | 'skills' | 'donate' | 'tokensaver' | 'permissions'>(null);
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [autoApprove, setAutoApprove] = useState(false);
  const [todos, setTodos] = useState<{ content: string; status: string }[]>([]);
  const [showPlan, setShowPlan] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<'root' | 'permission' | 'shell'>('root');
  const [modal, setModal] = useState<null | 'goal' | 'feedback'>(null);
  const [ruleTool, setRuleTool] = useState('*');
  const [rulePattern, setRulePattern] = useState('*');
  const [ruleAction, setRuleAction] = useState<RuleAction>('deny');
  const [askState, setAskState] = useState<null | { question: string; options: string[] }>(null);
  const [askAnswer, setAskAnswer] = useState('');
  const askResolverRef = useRef<((v: string) => void) | null>(null);
  const [goalDraft, setGoalDraft] = useState('');
  const [shellDraft, setShellDraft] = useState('');
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackRating, setFeedbackRating] = useState(0);
  const [compacting, setCompacting] = useState(false);
  const [stepLimitHit, setStepLimitHit] = useState(false);
  const [liveStep, setLiveStep] = useState(0);

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
  const pasteGuardRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const queueRef = useRef<{ id: string; text: string }[]>([]);
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

  // Unduhan dari browser tertanam: tampilkan path-nya supaya pengguna bisa mengambil file.
  useEffect(() => {
    if (!hostReady || !window.dsh?.browser?.onDownload) return;
    const off = window.dsh.browser.onDownload((d: any) => {
      if (!d) return;
      if (d.state === 'done') {
        flash(`📥 File terunduh: ${d.filename} (${Math.max(1, Math.round((d.bytes || 0) / 1024))} KB) — ${d.path}`);
      } else if (d.state === 'error') {
        flash(`Gagal mengunduh: ${d.filename}`);
      }
    });
    return off;
  }, [flash, hostReady]);

  // Tanya pengguna dari dalam agent loop (gaya ask_user_question DSH).
  const askUserInline = useCallback((question: string, options?: string[]) => {
    return new Promise<string>((resolve) => {
      askResolverRef.current = resolve;
      setAskAnswer('');
      setAskState({ question: String(question || 'OflaBot butuh konfirmasi'), options: Array.isArray(options) ? options.filter(Boolean).map(String) : [] });
    });
  }, []);

  const answerAsk = useCallback((value: string) => {
    const r = askResolverRef.current;
    askResolverRef.current = null;
    setAskState(null);
    setAskAnswer('');
    if (r) r(String(value || '').trim() || '(tidak dijawab)');
  }, []);

  // ---- Aturan izin granular ----
  const addRule = useCallback((tool: string, pattern: string, action: RuleAction) => {
    const rule: PermissionRule = { id: uid(), tool: tool || '*', pattern: pattern || '*', action };
    setSettings((s) => ({ ...s, rules: [...s.rules, rule].slice(0, 60) }));
    flash(`Aturan izin ditambah: ${rule.tool} ${rule.pattern} → ${rule.action}`);
  }, [flash]);

  const removeRule = useCallback((id: string) => {
    setSettings((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== id) }));
  }, []);

  const presetRules = useCallback(() => {
    const presets: PermissionRule[] = [
      { id: uid(), tool: '*', pattern: 'C:\\Windows*', action: 'deny' },
      { id: uid(), tool: '*', pattern: '*Program Files*', action: 'deny' },
      { id: uid(), tool: '*', pattern: '*AppData*', action: 'deny' },
      { id: uid(), tool: 'exec', pattern: '*format*', action: 'ask' },
      { id: uid(), tool: 'file_move', pattern: 'D:\\*', action: 'allow' },
      { id: uid(), tool: 'file_delete', pattern: '*', action: 'ask' },
    ];
    setSettings((s) => ({ ...s, rules: [...presets, ...s.rules].slice(0, 60) }));
    flash('Preset aturan izin ditambahkan (sistem dilindungi, move ke D: diizinkan, delete bertanya).');
  }, [flash]);

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
    if (settings.tokenSaver?.caveman) {
      extra += '\n\n=== TOKEN SAVER: CAVEMAN (output ringkas) ===\n' +
        'Jawab sesingkat mungkin. Gaya telegrafis: tanpa salam, tanpa basa-basi, tanpa pengulangan. ' +
        'Pakai poin-poin bila membantu. Frasa seperti "berikut adalah", "tentu", "semoga membantu" DILARANG. ' +
        'Tetap akurat dan lengkap secara informasi.';
    }
    if (settings.tokenSaver?.ponytail) {
      extra += '\n\n=== TOKEN SAVER: LAZY SENIOR DEV ===\n' +
        'Bias ke solusi paling kecil yang bekerja: YAGNI, pakai standar/library yang sudah ada, ' +
        'lebih baik menghapus daripada menambah. Jangan menulis kode yang tidak diminta. ' +
        'Sebelum menulis kode baru, cek apakah fungsi serupa sudah ada (file_list/file_stat).';
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

  const addImageAttachment = useCallback(async (rawDataUrl: string, size?: number) => {
    const dataUrl = await normalizeImageDataUrl(rawDataUrl);
    const att: Attachment = {
      kind: 'image',
      name: `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.png`,
      path: '(clipboard)',
      dataUrl,
      size: size || Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75),
    };
    setAttachments((prev) => [...prev, att].slice(-10));
    flash('Screenshot ditempel 🖼 — tekan Enter untuk mengirim.');
  }, [flash]);

  // Ambil gambar langsung dari clipboard sistem (dipakai Ctrl+V, menu +, dan
  // listener global saat fokus tidak berada di kotak ketik).
  const pasteSystemImage = useCallback(async (): Promise<boolean> => {
    if (Date.now() - pasteGuardRef.current < 1200) return true; // sudah ditangani
    if (!hostReady) return false;
    try {
      const res = await window.dsh.clipboard.image();
      if (res?.ok && res.dataUrl) {
        pasteGuardRef.current = Date.now();
        await addImageAttachment(res.dataUrl);
        return true;
      }
      if (res?.note) flash('Clipboard: ' + res.note);
    } catch (err: any) {
      flash('Gagal membaca clipboard: ' + (err?.message || String(err)));
    }
    return false;
  }, [addImageAttachment, flash, hostReady]);

  async function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) { void pasteSystemImage(); return; }
      const reader = new FileReader();
      reader.onload = () => {
        pasteGuardRef.current = Date.now();
        void addImageAttachment(String(reader.result || ''), file.size);
      };
      reader.readAsDataURL(file);
      return;
    }
    // Windows sering menaruh screenshot tanpa item file: baca lewat clipboard sistem.
    const text = e.clipboardData?.getData('text') || '';
    if (!text) {
      const ok = await pasteSystemImage();
      if (ok) e.preventDefault();
    }
  }

  // Ctrl+V saat fokus tidak di textarea (mis. baru klik panel aktivitas).
  useEffect(() => {
    function onDocPaste(ev: ClipboardEvent) {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return; // ditangani komponen
      const items = Array.from(ev.clipboardData?.items || []);
      if (items.some((it) => it.kind === 'file' && it.type.startsWith('image/'))) return;
      if ((ev.clipboardData?.getData('text') || '').length > 0) return;
      void pasteSystemImage();
    }
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  }, [pasteSystemImage]);
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

  // ---------------- sub-agent paralel ----------------
  const SUBAGENT_TOOLS = new Set([
    'file_list', 'file_glob', 'file_search', 'file_read', 'file_stat',
    'browser_open', 'browser_action', 'browser_text', 'browser_snapshot',
    'memory_search', 'skill_list', 'skill_read', 'web_search', 'session_log',
  ]);

  async function runSubagentsParallel(tasks: any[]): Promise<any> {
    const list = (Array.isArray(tasks) ? tasks : []).slice(0, 4);
    if (!list.length) return { error: 'tasks kosong' };
    const tools = TOOLS.filter((t: any) => SUBAGENT_TOOLS.has(t.function.name));
    const runOne = async (task: any, idx: number) => {
      const prompt = String(task?.prompt || task?.title || '');
      const title = String(task?.title || `Sub-agent ${idx + 1}`);
      const sys =
        `${agent.system}\n\n[SUB-AGENT] Kamu bekerja mandiri untuk satu tugas kecil. ` +
        'Hanya MEMBACA (file_list/file_glob/file_search/file_read, browser, web_search). JANGAN mengubah file apa pun. ' +
        'Selesaikan maksimal 10 langkah, lalu beri jawaban ringkas berisi temuan penting.';
      const msgs: Msg[] = [{ role: 'user', content: prompt }];
      const used: Record<string, number> = {};
      let finalText = '';
      let err = '';
      for (let step = 0; step < 10; step++) {
        if (abortRef.current) { err = 'dibatalkan pengguna'; break; }
        const r = await window.dsh.chat({
          provider: isAnthropic ? 'anthropic' : 'openai',
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          system: sys,
          messages: messagesForApi(msgs),
          tools: isAnthropic ? tools.map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) : tools,
          tool_choice: isAnthropic ? undefined : 'auto',
        });
        if (r?.error) { err = JSON.stringify(r.error).slice(0, 300); break; }
        const text = r.text || '';
        const calls = (r.tool_calls || []).filter((tc: any) => SUBAGENT_TOOLS.has(tc.function?.name));
        if (!calls.length) { finalText = text || '(tanpa jawaban)'; break; }
        msgs.push({ role: 'assistant', content: text, tool_calls: calls });
        for (const tc of calls) {
          if (abortRef.current) break;
          let a: any = {};
          try { a = JSON.parse(tc.function.arguments || '{}'); } catch { a = {}; }
          used[tc.function.name] = (used[tc.function.name] || 0) + 1;
          let res: any;
          if (tc.function.name === 'session_log') res = buildSessionLog(msgs);
          else {
            try { res = await runTool(tc.function.name, a); } catch (e: any) { res = { error: String(e?.message || e) }; }
          }
          msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(res).slice(0, 3000) });
        }
      }
      return { title, ok: !err, answer: finalText.slice(0, 1200), tools: used, steps: msgs.length, error: err || undefined };
    };
    const started = Date.now();
    const results = await Promise.all(list.map((t, i) => runOne(t, i)));
    return { ok: true, parallel: list.length, ms: Date.now() - started, subagents: results };
  }

  async function agentLoop(sessionId: string, userText: string, agentDef: AgentDef, userContent?: any) {
    setRunning(true);
    setLiveStep(0);
    abortRef.current = false;

    let allowed = toolNamesFor(agentDef.tools);
    setAgentRuntime({ webSearch: settings.webSearch });
    if (sessions.find((s) => s.id === sessionId)?.planMode) {
      const SAFE = ['file_list', 'file_glob', 'file_search', 'file_read', 'file_stat', 'browser_open', 'browser_action', 'browser_text', 'browser_snapshot', 'browser_click', 'browser_fill', 'todo_write', 'memory_save', 'memory_search', 'skill_list', 'skill_read', 'session_log', 'ask_user'];
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

    let blockedRepeats = 0;
    // ---- state engine ----
    const toolCache = new Map<string, string>();   // hasil tool baca yang sudah pernah dijalankan
    let exploreStreak = 0;      // panggilan baca berturut-turut tanpa aksi nyata
    let wastedTotal = 0;        // panggilan sia-sia (duplikat/cache/error) — indikator stuck
    let timeoutStreak = 0;      // perintah yang timeout berturut-turut
    let forceFinal = false;     // paksa model menjawab dari data yang ada
    let finalAttempts = 0;      // percobaan minta jawaban teks sebelum ringkasan otomatis
    let todoList: { content: string; status: string }[] = [];  // todo terbaru (untuk ringkasan)
    let taskDone = false;       // model sudah memberi jawaban akhir
    let compactNoticeShown = false;
    let ctx: Msg[] = msgs;      // konteks yang dikirim ke model (bisa diringkas)
    const addMsg = (m: Msg) => { msgs.push(m); if (ctx !== msgs) ctx.push(m); };

    const markProgress = (name: string, args: any) => {
      // Aksi yang mengubah state (tulis file, klik/isi browser, navigasi) = kemajuan.
      if (isMutatingCall(name, args) || BROWSER_ACTION_TOOLS.has(name)) { exploreStreak = 0; return; }
      exploreStreak++;
    };

    while (!abortRef.current) {
      steps++;
      setLiveStep(steps);

      // Antrian pesan pengguna (steer): suntikkan sebelum memanggil model lagi.
      if (queueRef.current.length) {
        const inbox = queueRef.current.splice(0, queueRef.current.length);
        for (const q of inbox) {
          addMsg({ role: 'user', content: q.text });
          appendMessage(sessionId, { role: 'user', content: q.text });
        }
        setQueue([]);
        systemPrompt +=
          '\n\n[PESAN BARU DARI PENGGUNA SELAMA KAMU BEKERJA]\n' +
          inbox.map((q) => '- ' + q.text).join('\n') +
          '\nPerhatikan pesan ini dan sesuaikan arah pekerjaan. Jangan mengulang pekerjaan yang sudah selesai.';
        exploreStreak = 0;
        wastedTotal = 0;
      }

      // Auto-compaction: konteks terlalu panjang -> ringkas riwayat lama.
      const comp = compactContext(ctx);
      if (comp.dropped) {
        ctx = comp.msgs;
        if (!compactNoticeShown) {
          compactNoticeShown = true;
          appendMessage(sessionId, { role: 'notice', content: 'Riwayat lama diringkas otomatis agar percakapan tetap ringkas dan hemat konteks.' });
        }
      }

      // Pengingat otomatis (tanpa terlihat pengguna): kalau rencana belum dibuat.
      if (isMultiStep && !todoSeen && planNudges < 3 && steps >= 2) {
        planNudges++;
        systemPrompt +=
          '\n\n[PENGINGAT SISTEM] Kamu belum membuat daftar langkah untuk tugas ini. ' +
          'Panggil todo_write SEKARANG (3-6 langkah sederhana) sebelum memanggil tool lain.';
      }
      const activeTools = forceFinal ? [] : tools;
      const payload = {
        provider: isAnthropic ? 'anthropic' : 'openai',
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        system: systemPrompt,
        messages: messagesForApi(ctx),
        tools: isAnthropic ? activeTools.map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) : activeTools,
        tool_choice: isAnthropic ? undefined : forceFinal ? 'none' : 'auto',
      };

      const resp = await callModel(payload);
      if (resp?.error) {
        lastError = JSON.stringify(resp.error).slice(0, 600);
        appendMessage(sessionId, { role: 'notice', content: 'Error provider: ' + lastError });
        break;
      }

      const text: string = resp.text || '';
      const toolCalls = (resp.tool_calls || []).filter((tc: any) => allowedNames.includes(tc.function?.name));

      // Sebagian provider mengabaikan tool_choice="none": minta jawaban teks satu
      // kali lagi, baru kalau tetap memaksa tool -> simpulkan otomatis dari log.
      if (forceFinal && toolCalls.length) {
        if (finalAttempts < 1) {
          finalAttempts++;
          ctx.push({
            role: 'user',
            content:
              '[SISTEM] JANGAN memanggil tool lagi. Tulis JAWABAN AKHIR untuk pengguna sekarang, tanpa tool: ' +
              'apa yang sudah dikerjakan, apa hasilnya, kendala yang muncul, dan langkah berikutnya. Bahasa Indonesia, ringkas.',
          } as Msg);
          continue;
        }
        const report = buildWorkReport(msgs, todos);
        addMsg({ role: 'assistant', content: report });
        appendMessage(sessionId, { role: 'assistant', content: report });
        taskDone = true;
        break;
      }

      if (toolCalls.length) {
        addMsg({ role: 'assistant', content: text, tool_calls: toolCalls });
        appendMessage(sessionId, { role: 'assistant', content: text || '(memanggil tool)', tool_calls: toolCalls });

        for (const tc of toolCalls) {
          if (abortRef.current) break;
          const name = tc.function.name;
          let args: any = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }

          // --- Pengaman loop: panggilan dengan argumen mirip dianggap duplikat ---
          const sig = toolSignature(name, args);
          const seen = (sigCounts.get(sig) || 0) + 1;
          sigCounts.set(sig, seen);

          const pushToolResult = (payload: any) => {
            const s = JSON.stringify(payload).slice(0, 6000);
            addMsg({ role: 'tool', tool_call_id: tc.id, content: s, name });
            appendMessage(sessionId, { role: 'tool', name, tool_call_id: tc.id, content: s });
          };

          if (seen >= 2) {
            blockedRepeats++;
            wastedTotal++;
            if (toolCache.has(sig)) {
              pushToolResult({
                cached: true,
                note: `Perintah/panggilan ${name} ini SUDAH dijalankan sebelumnya (variasi penulisan dianggap sama). Tidak dijalankan ulang — pakai hasil di bawah.`,
                result: (toolCache.get(sig) || '').slice(0, 1500),
              });
            } else {
              pushToolResult({
                error: 'panggilan berulang',
                hint:
                  `Panggilan ${name} dengan argumen yang sama sudah dilakukan ${seen}×. JANGAN ulangi. ` +
                  'Ambil aksi berikutnya (file_move/file_write) atau jawab pengguna dengan hasil yang sudah ada.',
              });
            }
            continue;
          }

          // Pengaman path sistem: jangan pernah pindahkan/hapus file Windows.
          const blockedPath = protectionViolation(name, args);
          if (blockedPath) {
            pushToolResult({
              error: 'path sistem dilindungi',
              path: blockedPath,
              hint:
                'File/folder sistem Windows (Windows, Program Files, ProgramData, AppData, Recovery) TIDAK boleh dipindahkan atau dihapus otomatis — bisa merusak Windows. ' +
                'Lewati path ini. Jika pengguna memang meminta, jelaskan risikonya dan minta konfirmasi manual di luar OflaBot.',
            });
            continue;
          }

          // Aturan izin granular (deny > ask > allow), dicek sebelum aksi apa pun.
          const decided = decideRule(settings.rules || [], name, args);
          if (decided?.action === 'deny') {
            pushToolResult({
              error: 'diblokir aturan izin',
              rule: { tool: decided.rule.tool, pattern: decided.rule.pattern, action: decided.rule.action },
              hint: 'Aksi ini dilarang oleh aturan izin pengguna. Jangan mengulang. Pilih pendekatan lain atau jelaskan ke pengguna.',
            });
            continue;
          }

          if (permission === 'read-only' && isDangerous(name, args)) {
            pushToolResult({ error: 'Mode Read Only aktif', hint: 'Aksi mengubah/menjalankan diblokir. Minta pengguna mengganti Permission ke Workspace Write atau Full access.' });
            continue;
          }
          const fullAccess = permission === 'full' || autoApprove;
          const ruleAllows = decided?.action === 'allow';
          const needAsk = !ruleAllows && (decided?.action === 'ask' || (isDangerous(name, args) && !fullAccess));
          if (needAsk) {
            const why = decided?.action === 'ask' ? `Aturan izin: ${decided.rule.tool} ${decided.rule.pattern} = tanya.` : '';
            const ok = await window.dsh.confirm(
              `${why}\nIzinkan aksi "${name}"?\n${JSON.stringify(args).slice(0, 300)}\n\n` +
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
            if (name === 'session_log') result = buildSessionLog(msgs);
            else if (name === 'spawn_subagents') result = await runSubagentsParallel(args?.tasks);
            else if (name === 'ask_user') {
              const answer = await askUserInline(String(args?.question || 'OflaBot butuh konfirmasi'), args?.options);
              result = { ok: true, question: args?.question, answer };
            } else result = await runTool(name, args);
          } catch (err: any) {
            result = { error: 'tool gagal: ' + (err?.message || String(err)) };
          }

          // Pantau kemajuan: baca saja tidak dihitung sebagai aksi, tapi bukan "gagal".
          markProgress(name, args);
          if (name === 'ask_user') { exploreStreak = 0; wastedTotal = 0; }
          if (result?.error && !result?.cached) wastedTotal++;
          if (result?.timedOut) { timeoutStreak++; wastedTotal += 2; }
          else timeoutStreak = 0;
          // Unduhan browser yang berhasil = kemajuan nyata.
          if (name === 'browser_downloads' || name === 'browser_click') {
            const items = Array.isArray(result?.items) ? result.items : result?.downloaded ? [result.downloaded] : [];
            if (items.some((d: any) => d && d.state === 'done')) { exploreStreak = 0; wastedTotal = 0; }
          }

          if (name === 'todo_write') {
            todoSeen = true;
            const list = Array.isArray(result?.todos) ? result.todos : Array.isArray(args.todos) ? args.todos : [];
            todoList = list;
            setTodos(list);
          }

          const image = extractImage(result);
          const clean = { ...result };
          if (clean.dataUrl) clean.dataUrl = '(gambar terkirim terpisah)';
          const fullStr = JSON.stringify(clean);
          // Yang dikirim ke MODEL selalu diringkas terstruktur; UI menyimpan versi penuh.
          const modelStr = compressToolResult(name, clean, fullStr, settings.tokenSaver?.rtk !== false);
          const contentStr = fullStr.slice(0, 6000);
          if (!clean.error || clean.cached) toolCache.set(sig, modelStr);

          addMsg({ role: 'tool', tool_call_id: tc.id, content: modelStr, name });
          appendMessage(sessionId, { role: 'tool', name, tool_call_id: tc.id, content: contentStr, image: image || undefined });

          if (image) {
            addMsg({ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] } as any);
            appendMessage(sessionId, { role: 'user', content: '[gambar halaman]' });
          }
          if (name.startsWith('memory_') || name.startsWith('skill_')) void refreshMemory();
        }

        // --- Pengaman kemajuan (bukan batas langkah): hanya aktif kalau stuck ---
        if (!forceFinal && timeoutStreak >= 2) {
          systemPrompt +=
            '\n\n[PENGINGAT SISTEM] Dua perintahmu timeout. JANGAN menjalankan pemindaian rekursif ' +
            '(Get-ChildItem -Recurse, dir /s). Periksa folder satu per satu dengan file_list, lalu ambil aksi.';
        }
        if (!forceFinal && (wastedTotal >= 12 || exploreStreak >= 30 || timeoutStreak >= 3)) {
          forceFinal = true;
          hitLimit = true;
          appendMessage(sessionId, {
            role: 'notice',
            content:
              'OflaBot berhenti karena beberapa langkah terakhir tidak membuahkan hasil baru ' +
              `(${wastedTotal} langkah sia-sia). Saya minta ia merangkum apa yang sudah didapat.`,
          });
          ctx.push({
            role: 'user',
            content:
              '[SISTEM] Beberapa langkah terakhir tidak menghasilkan kemajuan. JANGAN memanggil tool lagi. ' +
              'Tulis JAWABAN AKHIR sekarang: apa yang sudah dikerjakan, apa hasilnya, kendala/error yang muncul, dan langkah berikutnya. ' +
              'Bahasa Indonesia, ringkas, tanpa menyebut nama tool.',
          } as Msg);
        } else if (!forceFinal && exploreStreak === 16) {
          systemPrompt +=
            '\n\n[PENGINGAT SISTEM] Kamu sudah cukup banyak membaca. Ambil aksi nyata berikutnya, ' +
            'atau kalau sudah cukup data, langsung susun jawaban.';
        } else if (!forceFinal && exploreStreak === 24) {
          systemPrompt +=
            '\n\n[PENGINGAT SISTEM] Eksplorasi sudah sangat panjang. Prioritaskan menyelesaikan tugas ' +
            '(aksi/kirim jawaban) daripada terus memeriksa.';
        }
        continue;
      }

      // --- Tidak ada tool call: ini jawaban akhir ---
      if (!text.trim()) {
        if (forceFinal && finalAttempts < 1) {
          finalAttempts++;
          ctx.push({
            role: 'user',
            content:
              '[SISTEM] Jawabanmu kosong. Tulis jawaban akhir dalam teks biasa sekarang: hasil pekerjaan, kendala, langkah berikutnya. ' +
              'Jangan memanggil tool.',
          } as Msg);
          continue;
        }
        if (forceFinal) {
          const report = buildWorkReport(msgs, todoList);
          addMsg({ role: 'assistant', content: report });
          appendMessage(sessionId, { role: 'assistant', content: report });
        } else {
          appendMessage(sessionId, {
            role: 'notice',
            content: 'Model tidak mengembalikan jawaban (respons kosong). Coba kirim ulang, atau ganti model/provider di Settings.',
          });
        }
        break;
      }

      addMsg({ role: 'assistant', content: text });
      appendMessage(sessionId, { role: 'assistant', content: text });
      taskDone = true;
      break;
    }

    if (hitLimit) setStepLimitHit(true);
    void taskDone;

    setRunning(false);
    setLiveStep(0);
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

  // ---------------- antrian chat (steer saat agent bekerja) ----------------
  const enqueueMessage = useCallback((text: string) => {
    const item = { id: uid(), text };
    queueRef.current = [...queueRef.current, item];
    setQueue(queueRef.current.map((x) => ({ ...x })));
  }, []);

  const removeQueued = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((x) => x.id !== id);
    setQueue(queueRef.current.map((x) => ({ ...x })));
  }, []);

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueue([]);
  }, []);

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || !active) return;
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

    // Sedang bekerja? Pesan masuk antrian dan disuntikkan di langkah berikutnya (steer).
    if (running) {
      enqueueMessage(promptText || '(pesan antrian)');
      setInput('');
      setAttachments([]);
      flash('Pesan masuk antrian — akan dibaca OflaBot setelah langkah ini selesai.');
      return;
    }

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
          <span className="activity-hint">{open ? 'sembunyikan' : `${b.items.length} langkah · detail`}</span>
        </button>
        {open && (
          <div className="activity-body">
            {b.text && <div className="activity-note">{b.text}</div>}
            {b.items.slice(0, 40).map((it, idx) => (
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
            {b.items.length > 40 && (
              <div className="activity-more">…dan {b.items.length - 40} pemanggilan lain (disembunyikan agar ringkas)</div>
            )}
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
          <button className="side-btn" onClick={() => setPanel('permissions')}>🛡 Izin <span className="badge">{settings.rules.length} aturan</span></button>
          <button className="side-btn" onClick={() => setPanel('tokensaver')}>⚡ Token Saver <span className="badge">{[settings.tokenSaver.rtk ? 'RTK' : '', settings.tokenSaver.caveman ? 'Caveman' : '', settings.tokenSaver.ponytail ? 'Ponytail' : ''].filter(Boolean).join('·') || 'off'}</span></button>
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
                  <span className="spinner" /> Thinking…{liveStep > 1 ? ` (langkah ${liveStep})` : ''}
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

              {queue.length > 0 && (
                <div className="queue-row">
                  <span className="queue-label">⏳ Antrian</span>
                  {queue.map((q) => (
                    <span key={q.id} className="queue-chip" title={q.text}>
                      {q.text.length > 60 ? q.text.slice(0, 60) + '…' : q.text}
                      <button className="attach-x" title="Batalkan antrian" onClick={() => removeQueued(q.id)}>×</button>
                    </span>
                  ))}
                  <button className="queue-clear" onClick={clearQueue}>hapus semua</button>
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
                          <button className="popmenu-item" onClick={() => { setMenuOpen(false); void pasteSystemImage(); }}>
                            <span className="pi-icon">🖼</span><span className="pi-text">Tempel gambar</span>
                            <span className="pi-hint">screenshot dari clipboard (Ctrl+V)</span>
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
                  ref={composerRef}
                  value={input}
                  placeholder={`Perintah untuk ${agent.name}… (Ctrl+V tempel screenshot, Enter kirim, Shift+Enter baris baru, ! perintah shell)`}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(e) => void handlePaste(e)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                />
              </div>

              <div className="composer-actions">
                <button
                  className="btn primary"
                  onClick={() => void send()}
                  disabled={!input.trim() && attachments.length === 0}
                  title={running ? 'Kirim ke antrian (dibaca setelah langkah ini)' : 'Kirim perintah'}
                >
                  {running ? 'Antrikan' : 'Send'}
                </button>
                <button className="btn" onClick={() => { abortRef.current = true; void window.dsh.execKill?.(); clearQueue(); }} disabled={!running}>Stop</button>

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

      {/* ============ MODAL: tanya pengguna dari agent (ask_user) ============ */}
      {askState && (
        <div className="modal-backdrop">
          <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>❓ OflaBot bertanya</h3>
            </div>
            <div className="modal-body">
              <div className="hint ask-question">{askState.question}</div>
              {askState.options.length > 0 && (
                <div className="ask-options">
                  {askState.options.map((o) => (
                    <button key={o} className="btn" onClick={() => answerAsk(o)}>{o}</button>
                  ))}
                </div>
              )}
              <input
                className="ask-input"
                autoFocus
                value={askAnswer}
                onChange={(e) => setAskAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); answerAsk(askAnswer); } }}
                placeholder="Ketik jawaban… (Enter kirim)"
              />
              <div className="row-gap end">
                <button className="btn ghost" onClick={() => answerAsk('dibatalkan pengguna')}>Batal</button>
                <button className="btn primary" onClick={() => answerAsk(askAnswer)}>Kirim jawaban</button>
              </div>
            </div>
          </div>
        </div>
      )}

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
                {panel === 'tokensaver' && '⚡ Token Saver'}
                {panel === 'permissions' && '🛡 Aturan Izin'}
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

                  <div className="settings-sep">Web Search (untuk tool web_search)</div>
                  <label>Penyedia
                    <select value={settings.webSearch.provider}
                      onChange={(e) => setSettings((s) => ({ ...s, webSearch: { ...s.webSearch, provider: e.target.value } }))}>
                      <option value="duckduckgo">DuckDuckGo (gratis, tanpa key)</option>
                      <option value="bing">Bing (gratis, tanpa key)</option>
                      <option value="tavily">Tavily (API key)</option>
                      <option value="brave">Brave Search (API key)</option>
                      <option value="searxng">SearXNG (baseUrl sendiri)</option>
                    </select>
                  </label>
                  {(settings.webSearch.provider === 'tavily' || settings.webSearch.provider === 'brave') && (
                    <label>API Key Web Search
                      <input type="password" value={settings.webSearch.apiKey}
                        onChange={(e) => setSettings((s) => ({ ...s, webSearch: { ...s.webSearch, apiKey: e.target.value } }))}
                        placeholder="kunci API pencarian" />
                    </label>
                  )}
                  {settings.webSearch.provider === 'searxng' && (
                    <label>Base URL SearXNG
                      <input value={settings.webSearch.baseUrl}
                        onChange={(e) => setSettings((s) => ({ ...s, webSearch: { ...s.webSearch, baseUrl: e.target.value } }))}
                        placeholder="https://searx.example.com" />
                    </label>
                  )}

                  <div className="hint">Versi {appVersion || '0.2.1'} · OflaBot</div>
                </div>
              )}

              {panel === 'tokensaver' && (
                <div className="ts-panel">
                  <div className="hint">Hemat token & biaya. Semua fitur bisa dinyalakan/dimatikan kapan saja dan berlaku untuk semua sesi.</div>

                  <div className="ts-item">
                    <div className="ts-text">
                      <div className="ts-title">Compress tool output <span className="ts-badge">RTK</span></div>
                      <div className="ts-desc">Hasil tool (file_list, exec, browser_text) diringkas sebelum dikirim ke model — jauh lebih sedikit token. Tampilan di layar tetap lengkap.</div>
                    </div>
                    <label className="switch">
                      <input type="checkbox" checked={settings.tokenSaver.rtk}
                        onChange={(e) => setSettings((s) => ({ ...s, tokenSaver: { ...s.tokenSaver, rtk: e.target.checked } }))} />
                      <span className="slider" />
                    </label>
                  </div>

                  <div className="ts-item">
                    <div className="ts-text">
                      <div className="ts-title">Compress LLM output <span className="ts-badge">Caveman</span></div>
                      <div className="ts-desc">Model diminta menjawab gaya telegrafis: tanpa salam & basa-basi, poin singkat. Menghemat token output.</div>
                    </div>
                    <label className="switch">
                      <input type="checkbox" checked={settings.tokenSaver.caveman}
                        onChange={(e) => setSettings((s) => ({ ...s, tokenSaver: { ...s.tokenSaver, caveman: e.target.checked } }))} />
                      <span className="slider" />
                    </label>
                  </div>

                  <div className="ts-item">
                    <div className="ts-text">
                      <div className="ts-title">Lazy senior dev <span className="ts-badge">Ponytail</span></div>
                      <div className="ts-desc">Bias ke solusi paling kecil: YAGNI, pakai library yang sudah ada, hapus daripada menambah. Cocok untuk tugas coding.</div>
                    </div>
                    <label className="switch">
                      <input type="checkbox" checked={settings.tokenSaver.ponytail}
                        onChange={(e) => setSettings((s) => ({ ...s, tokenSaver: { ...s.tokenSaver, ponytail: e.target.checked } }))} />
                      <span className="slider" />
                    </label>
                  </div>

                  <div className="ts-note">
                    Status: {[settings.tokenSaver.rtk ? 'RTK' : null, settings.tokenSaver.caveman ? 'Caveman' : null, settings.tokenSaver.ponytail ? 'Ponytail' : null].filter(Boolean).join(' · ') || 'tidak ada (token penuh)'}
                  </div>
                  <div className="row-gap end">
                    <button className="btn ghost" onClick={() => setSettings((s) => ({ ...s, tokenSaver: { rtk: true, caveman: true, ponytail: true } }))}>Aktifkan semua</button>
                    <button className="btn ghost" onClick={() => setSettings((s) => ({ ...s, tokenSaver: { rtk: false, caveman: false, ponytail: false } }))}>Matikan semua</button>
                  </div>
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

              {panel === 'permissions' && (
                <div className="form">
                  <div className="hint">
                    Aturan dicek sebelum tool dijalankan: <b>deny</b> memblokir, <b>ask</b> selalu bertanya,
                    <b> allow</b> mengizinkan tanpa bertanya walau Full Access. Prioritas: deny &gt; ask &gt; allow.
                    Pola mendukung <code>*</code>, mis. <code>C:\Windows*</code> atau <code>D:\*</code>.
                    Tool <code>*</code> berarti semua tool. Untuk exec, pola dicocokkan ke perintahnya.
                  </div>
                  <div className="row-gap">
                    <button className="btn" onClick={presetRules}>Tambahkan preset aman</button>
                  </div>
                  <div className="rule-add">
                    <select value={ruleTool} onChange={(e) => setRuleTool(e.target.value)}>
                      <option value="*">Semua tool (*)</option>
                      <option value="file_delete">file_delete</option>
                      <option value="file_move">file_move</option>
                      <option value="file_copy">file_copy</option>
                      <option value="file_write">file_write</option>
                      <option value="file_edit">file_edit</option>
                      <option value="apply_patch">apply_patch</option>
                      <option value="exec">exec</option>
                      <option value="launch">launch</option>
                    </select>
                    <input value={rulePattern} onChange={(e) => setRulePattern(e.target.value)} placeholder="pola: C:\Windows*  /  D:\*  /  *format*" />
                    <select value={ruleAction} onChange={(e) => setRuleAction(e.target.value as RuleAction)}>
                      <option value="deny">deny (blokir)</option>
                      <option value="ask">ask (tanya)</option>
                      <option value="allow">allow (izinkan)</option>
                    </select>
                    <button className="btn primary" onClick={() => addRule(ruleTool, rulePattern, ruleAction)}>Tambah</button>
                  </div>
                  <div className="rule-list">
                    {settings.rules.length === 0 && <div className="hint">Belum ada aturan. Tool mengikuti Permission di toolbar (Read Only / Workspace / Full).</div>}
                    {settings.rules.map((r) => (
                      <div key={r.id} className={`rule-item ${r.action}`}>
                        <span className="rule-tool mono">{r.tool}</span>
                        <span className="rule-pattern mono" title={r.pattern}>{r.pattern}</span>
                        <span className={`rule-action ${r.action}`}>{r.action}</span>
                        <button className="btn icon" title="Hapus aturan" onClick={() => removeRule(r.id)}>✕</button>
                      </div>
                    ))}
                  </div>
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
