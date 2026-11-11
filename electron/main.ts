import { app, BrowserWindow, WebContentsView, ipcMain, desktopCapturer, dialog, protocol, net, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';

const APP_NAME = 'OflaBot';

app.setName(APP_NAME);

// ---------------------------------------------------------------------------
// Kompatibilitas profil: kalau folder profil versi lama (GrokBot) ada dan
// masih bisa ditulis, pakai folder itu supaya setting/riwayat user tidak hilang.
// Kalau tidak ada (instalasi baru), Electron memakai %APPDATA%\OflaBot.
// ---------------------------------------------------------------------------
try {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const legacyProfile = path.join(appData, 'grokbot-desktop');
  // Pakai folder lama bila ada: menjamin profil yang sudah terbukti bisa ditulis
  // Chromium (menghindari crash startup di lingkungan yang membatasi %APPDATA%).
  if (fs.existsSync(legacyProfile)) {
    app.setPath('userData', legacyProfile);
  }
} catch { /* pakai path default */ }

// ---------------------------------------------------------------------------
// Di build Windows mesin ini Chromium gagal start (crash 0x80000003) kecuali
// proses dijalankan dengan --no-sandbox. Shortcut & launcher yang dibuat
// installer selalu menyertakan flag itu; di sini switch ditambahkan sebagai
// lapisan kedua untuk mesin yang masih mau start tanpa flag.
// ---------------------------------------------------------------------------
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// ---------------------------------------------------------------------------
// Folder profil (userData) harus selalu bisa ditulis. Kalau %APPDATA% diblokir
// (mis. aplikasi dijalankan dari lingkungan terbatas), Chromium crash tanpa
// jendela. Jadi cari lokasi yang bisa ditulis lalu arahkan userData ke sana.
// Sekaligus migrasi data lama dari GrokBot Desktop Agent.
// ---------------------------------------------------------------------------
function migrateOldProfile(target: string) {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const legacyDirs = [path.join(appData, 'grokbot-desktop'), path.join(appData, 'GrokBot Desktop Agent')];
  for (const old of legacyDirs) {
    try {
      if (old === target || !fs.existsSync(old)) continue;
      if (fs.existsSync(target) && fs.readdirSync(target).length > 0) continue;
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(old, target, { recursive: true, force: true });
      return true;
    } catch { /* abaikan */ }
  }
  return false;
}

function ensureWritableUserData() {
  const exeDir = (() => { try { return path.dirname(app.getPath('exe')); } catch { return process.cwd(); } })();
  const candidates = [
    (() => { try { return app.getPath('userData'); } catch { return null; } })(),
    path.join(exeDir, 'userdata'),
    path.join(os.tmpdir(), 'OflaBot'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      app.setPath('userData', dir);
      migrateOldProfile(dir);
      return dir;
    } catch { /* coba kandidat berikutnya */ }
  }
  return null;
}

const userDataDir = ensureWritableUserData();

// Jangan pernah crash tanpa pesan: catat error ke file log di folder aplikasi.
function logFatal(kind: string, err: unknown) {
  try {
    const line = `[${new Date().toISOString()}] ${kind}: ${(err as any)?.stack || err}\n`;
    fs.appendFileSync(path.join(userDataDir || os.tmpdir(), 'oflabot-crash.log'), line);
  } catch { /* abaikan */ }
  try {
    dialog.showErrorBox('OflaBot - Error', String((err as any)?.message || err));
  } catch { /* abaikan */ }
}
process.on('uncaughtException', (e) => logFatal('uncaughtException', e));
process.on('unhandledRejection', (e) => logFatal('unhandledRejection', e));

let win: BrowserWindow | null = null;

// Serve the built renderer over a privileged custom scheme.
// file:// blocks <script type="module"> (CORS), which caused a blank white window.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const DIST = path.join(__dirname, '..', 'dist');

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const target = path.normalize(path.join(DIST, rel));
    if (!target.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'OflaBot',
  });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadURL('app://bundle/index.html');
}

app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();

  // Smoke test hook: GROKBOT_SMOKE=<png path> renders once, writes a screenshot, then exits.
  if ((process.env.OFLABOT_SMOKE || process.env.GROKBOT_SMOKE)) {
    const out = (process.env.OFLABOT_SMOKE || process.env.GROKBOT_SMOKE);
    win!.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        // GROKBOT_SMOKE_BROWSER=<url>: buka tab Browser + navigasi untuk uji tampilan.
        const smokeUrl = (process.env.OFLABOT_SMOKE_BROWSER || process.env.GROKBOT_SMOKE_BROWSER);
        if (smokeUrl) {
          win!.webContents.send('browser:request-open', { url: normalizeUrl(smokeUrl) });
          openInEmbeddedBrowser(smokeUrl);
          await new Promise((r) => setTimeout(r, 4500));
        }
        const info = await win!.webContents.executeJavaScript(`(async () => {
          const out = {
            root: document.getElementById('root')?.innerHTML.length ?? -1,
            brand: document.querySelector('.brand')?.textContent ?? null,
            agents: document.querySelectorAll('.agent-item').length,
            sessions: document.querySelectorAll('.session-item').length,
            activeTab: document.querySelector('.tab.active')?.textContent ?? null,
            hasApi: typeof window.dsh === 'object',
            hasBrowserApi: typeof window.dsh?.browser === 'object',
          };
          if (process_env_tool_test) {
            out.toolOpen = await window.dsh.browser.tool('open', { url: 'example.org' });
            out.toolText = await window.dsh.browser.tool('text');
            const snap = await window.dsh.browser.tool('snapshot');
            out.snapshotPrefix = (snap && snap.dataUrl || '').slice(0, 30);
          }
          return out;
        })()`.replace('process_env_tool_test', (process.env.OFLABOT_SMOKE_TOOL || process.env.GROKBOT_SMOKE_TOOL) ? 'true' : 'false'));
        // Uji fitur memory & skills (OFLABOT_SMOKE_FEATURES=1).
        if (process.env.OFLABOT_SMOKE_FEATURES) {
          const feats = await win!.webContents.executeJavaScript(`(async () => {
            const out = {};
            try {
              out.memAdd = !!(await window.dsh.memory.add({ kind: 'memory', title: 'Smoke test', body: 'contoh memory' })).ok;
              out.memCount = (await window.dsh.memory.list()).entries.length;
              out.memCtx = (await window.dsh.memory.context()).memories.length;
            } catch (e) { out.memErr = String(e); }
            try {
              const imp = await window.dsh.skills.importLocal();
              out.skillFound = imp.found; out.skillAdded = imp.added;
              const s = await window.dsh.skills.list();
              out.skillCount = s.skills.length;
              out.skillDir = s.dir;
              out.skillCtx = (await window.dsh.skills.context()).enabled.length;
              out.skillSample = (s.skills[0] || {}).name;
            } catch (e) { out.skillErr = String(e); }
            try {
              const mo = await window.dsh.models({ provider: 'openai', protocol: 'openai', baseUrl: 'https://api.openai.com', apiKey: '' });
              out.modelsErr = String(mo.error || '').slice(0, 120);
              out.modelsCount = (mo.models || []).length;
            } catch (e) { out.modelsErr = String(e); }
            try { out.appInfo = await window.dsh.appInfo(); } catch (e) { out.appInfoErr = String(e); }
            try {
              const lst = await window.dsh.fs.list('D:/DeepSeek/aplikasi/src', { max: 50 });
              out.fsList = { count: lst.count, sample: (lst.entries || []).slice(0, 3).map((x) => x.name) };
              const tmp = 'D:/DeepSeek/aplikasi/.fstest';
              out.fsMkdir = await window.dsh.fs.mkdir(tmp);
              out.fsMove = await window.dsh.fs.move('D:/DeepSeek/aplikasi/package.json', tmp + '/pkg.json', { copy: true, overwrite: true });
              const rd = await window.dsh.fs.read(tmp + '/pkg.json', 80);
              out.fsRead = (rd.content || '').slice(0, 40);
            } catch (e) { out.fsErr = String(e); }
            try {
              const ex = await window.dsh.exec('echo halo-dari-exec', { timeoutMs: 10000 });
              out.exec = { code: ex.code, stdout: String(ex.stdout || '').trim() };
            } catch (e) { out.execErr = String(e); }
            return out;
          })()`);
          console.log('FEATURES ' + JSON.stringify(feats));
        }

        // Demo menu "+": buka popover untuk verifikasi tampilan.
        if (process.env.OFLABOT_SMOKE_MENU) {
          try {
            const r = await win!.webContents.executeJavaScript(`(async () => {
              const out = {};
              out.addBtn = !!document.querySelector('.add-btn');
              out.buttons = document.querySelectorAll('.composer button').length;
              const btn = document.querySelector('.add-btn');
              if (btn) btn.click();
              await new Promise((res) => setTimeout(res, 500));
              out.menu = !!document.querySelector('.popmenu');
              out.items = Array.from(document.querySelectorAll('.popmenu-item')).map((n) => n.innerText.replace(/\\n/g, ' | '));
              return out;
            })()`);
            console.log('MENU_TEST ' + JSON.stringify(r));
          } catch (e) { console.log('MENU_TEST_ERR ' + e); }
          await new Promise((r) => setTimeout(r, 800));
        }
        // Demo: isi sesi contoh (tool calls) untuk memeriksa render gaya DSH.
        if (process.env.OFLABOT_SMOKE_DEMO) {
          await win!.webContents.executeJavaScript(`(() => {
            const now = Date.now();
            const sid = 'demo-session';
            const session = {
              id: sid, title: 'Buka google.com dan cari berita', agentId: 'oflabot', createdAt: now, updatedAt: now,
              messages: [
                { role: 'user', content: 'Buka google.com lalu cari berita P3K hari ini', ts: now },
                { role: 'assistant', content: '(memanggil tool)', tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'browser_open', arguments: '{"url":"https://google.com"}' } },
                  { id: 'c2', type: 'function', function: { name: 'browser_text', arguments: '{}' } },
                ]},
                { role: 'tool', name: 'browser_open', tool_call_id: 'c1', content: '{"ok":true,"url":"https://www.google.com/","title":"Google"}' },
                { role: 'tool', name: 'browser_text', tool_call_id: 'c2', content: '{"ok":true,"title":"Google","url":"https://www.google.com/","text":"halaman pencarian google"}' },
                { role: 'assistant', content: '**Hasil** — Google berhasil dibuka dan isi halaman terbaca. Mau cari kata kunci tertentu?' },
              ],
            };
            localStorage.setItem('oflabot.sessions.v1', JSON.stringify([session]));
            localStorage.setItem('oflabot.active-session.v1', sid);
            localStorage.setItem('oflabot.browser.open', '0');
            return true;
          })()`);
          await win!.webContents.reload();
          await new Promise((r) => setTimeout(r, 2500));
        }

        // Uji buka tautan eksternal (OFLABOT_SMOKE_OPEN=1).
        if (process.env.OFLABOT_SMOKE_OPEN) {
          const res = await win!.webContents.executeJavaScript(`window.dsh.openExternal('https://saweria.co/OflaCo')`);
          console.log('OPEN_EXTERNAL ' + JSON.stringify(res));
        }

        // Uji pengaman loop: pakai provider mock yang selalu memanggil tool yang sama.
        if (process.env.OFLABOT_SMOKE_LOOP) {
          await win!.webContents.executeJavaScript(`(() => {
            const settings = { provider: 'custom', baseUrl: 'http://127.0.0.1:18999', apiKey: 'mock', model: 'mock-loop', autoLearn: false, accessMode: 'full' };
            localStorage.setItem('oflabot.settings.v1', JSON.stringify(settings));
            localStorage.setItem('oflabot.sessions.v1', JSON.stringify([{ id: 'loop-test', title: 'loop test', agentId: 'oflabot', messages: [], createdAt: Date.now(), updatedAt: Date.now() }]));
            localStorage.setItem('oflabot.active-session.v1', 'loop-test');
            return true;
          })()`);
          await win!.webContents.reload();
          await new Promise((r) => setTimeout(r, 2500));
          await win!.webContents.executeJavaScript(`(() => {
            const ta = document.querySelector('.composer textarea');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, 'tolong rapikan semua file di folder Download lalu pindahkan ke folder D sesuai jenisnya');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('.composer-actions .btn.primary').click();
            return true;
          })()`);
          await new Promise((r) => setTimeout(r, 12000));
          const loopInfo = await win!.webContents.executeJavaScript(`(() => {
            const raw = JSON.parse(localStorage.getItem('oflabot.sessions.v1') || '[]');
            const msgs = (raw[0] || {}).messages || [];
            const toolMsgs = msgs.filter((m) => m.role === 'tool');
            const notices = msgs.filter((m) => m.role === 'notice').map((m) => String(m.content));
            const assistant = msgs.filter((m) => m.role === 'assistant');
            return {
              total: msgs.length,
              tools: toolMsgs.length,
              loopHints: toolMsgs.filter((m) => String(m.content || '').includes('loop terdeteksi')).length,
              notices,
              lastAssistant: String((assistant[assistant.length - 1] || {}).content || '').slice(0, 160),
              todoResults: toolMsgs.filter((m) => String(m.content || '').indexOf('todos') >= 0).length,
              planPanelVisible: !!document.querySelector('.todo-card'),
            };
          })()`);
          console.log('LOOP_TEST ' + JSON.stringify(loopInfo));
        }

        const img = await win!.webContents.capturePage();
        require('fs').writeFileSync(out, img.toPNG());
        // Gagal tangkap child view? kirim juga info state browser.
        console.log('SMOKE ' + JSON.stringify(info));
        console.log('BROWSER_STATE ' + JSON.stringify(browserState()));

        // Uji: pindah ke tab Chat harus menyembunyikan view browser.
        if ((process.env.OFLABOT_SMOKE_CHAT || process.env.GROKBOT_SMOKE_CHAT)) {
          await win!.webContents.executeJavaScript(`document.querySelectorAll('.tab')[0].click()`);
          await new Promise((r) => setTimeout(r, 900));
          console.log('AFTER_CHAT_TAB ' + JSON.stringify({ visible: browserState().visible, tab: await win!.webContents.executeJavaScript(`document.querySelector('.tab.active')?.textContent`) }));
        }

        // Uji: buat sesi baru + pilih agent lain (interaksi sidebar).
        if ((process.env.OFLABOT_SMOKE_UI || process.env.GROKBOT_SMOKE_UI)) {
          const ui = await win!.webContents.executeJavaScript(`(async () => {
            const before = document.querySelectorAll('.session-item').length;
            document.querySelector('.new-session').click();
            await new Promise((r) => setTimeout(r, 400));
            const after = document.querySelectorAll('.session-item').length;
            const agents = Array.from(document.querySelectorAll('.agent-item'));
            agents[1].click();
            await new Promise((r) => setTimeout(r, 400));
            const activeAgent = document.querySelector('.agent-item.active')?.textContent || '';
            const sessions = Array.from(document.querySelectorAll('.session-title')).map((n) => n.textContent);
            return { before, after, activeAgent, sessions, tab: document.querySelector('.tab.active')?.textContent };
          })()`);
          console.log('UI_TEST ' + JSON.stringify(ui));
        }
      } catch (e: any) {
        console.log('SMOKE_FAIL ' + (e?.message || String(e)));
      }
      if (!(process.env.OFLABOT_SMOKE_STAY || process.env.GROKBOT_SMOKE_STAY)) app.exit(0);
    });
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ===========================================================================
// Browser tertanam (WebContentsView) — semua navigasi terjadi DI DALAM aplikasi
// ===========================================================================
let browserView: WebContentsView | null = null;
let browserVisible = false;

const BROWSER_PARTITION = 'persist:oflabot-browser';

function browserState() {
  const wc = browserView?.webContents;
  if (!wc) return { url: '', title: '', canGoBack: false, canGoForward: false, loading: false, visible: false };
  let url = wc.getURL();
  let title = wc.getTitle();
  try {
    return {
      url,
      title,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      visible: browserVisible,
    };
  } catch {
    return { url, title, canGoBack: false, canGoForward: false, loading: false, visible: browserVisible };
  }
}

function emitBrowserState() {
  try { win?.webContents.send('browser:state', browserState()); } catch { /* window might be gone */ }
}

function ensureBrowserView(): WebContentsView {
  if (browserView) return browserView;
  if (!win) throw new Error('Main window belum siap');

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Chromium di build Windows ini butuh sandbox mati
      partition: BROWSER_PARTITION,
    },
  });
  browserView = view;
  view.setBackgroundColor('#ffffff');
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  win.contentView.addChildView(view);

  const wc = view.webContents;
  // Popup/new tab: buka di view yang sama, jangan keluar aplikasi.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('did-navigate', emitBrowserState);
  wc.on('did-navigate-in-page', emitBrowserState);
  wc.on('page-title-updated', emitBrowserState);
  wc.on('did-start-loading', emitBrowserState);
  wc.on('did-stop-loading', emitBrowserState);
  wc.on('did-fail-load', (_e, code, desc, url) => {
    emitBrowserState();
    if (code !== -3 && url) {
      try { win?.webContents.send('browser:error', { code, desc, url }); } catch { /* ignore */ }
    }
  });
  wc.on('render-process-gone', () => emitBrowserState());
  return view;
}

function normalizeUrl(input: string): string {
  const raw = (input || '').trim();
  if (!raw) return '';
  if (/^[a-z]+:\/\//i.test(raw)) return raw;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw)) return 'http://' + raw;
  if (/^[^\s]+\.[a-z]{2,}(\/|$|\?)/i.test(raw)) return 'https://' + raw;
  return 'https://www.google.com/search?q=' + encodeURIComponent(raw);
}

function showBrowser(rect: { x: number; y: number; width: number; height: number } | null) {
  const view = ensureBrowserView();
  if ((process.env.OFLABOT_DEBUG_BOUNDS || process.env.GROKBOT_DEBUG_BOUNDS)) console.log('SHOW_BROWSER ' + JSON.stringify(rect));
  if (!rect || rect.width < 10 || rect.height < 10) {
    browserVisible = false;
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  } else {
    browserVisible = true;
    view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  emitBrowserState();
}

ipcMain.handle('browser:show', (_e, rect) => { showBrowser(rect); return browserState(); });
ipcMain.handle('browser:hide', () => { showBrowser(null); return browserState(); });
ipcMain.handle('browser:state', () => browserState());

ipcMain.handle('browser:navigate', async (_e, url: string) => {
  const target = normalizeUrl(url);
  if (!target) return browserState();
  const view = ensureBrowserView();
  try { await view.webContents.loadURL(target); } catch (err: any) {
    return { ...browserState(), error: err?.message || String(err) };
  }
  emitBrowserState();
  return browserState();
});

ipcMain.handle('browser:action', async (_e, action: string) => {
  const view = ensureBrowserView();
  const wc = view.webContents;
  try {
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
    else if (action === 'home') await wc.loadURL('https://www.google.com');
  } catch { /* ignore */ }
  return browserState();
});

ipcMain.handle('browser:snapshot', async () => {
  const view = ensureBrowserView();
  const img = await view.webContents.capturePage();
  return { dataUrl: 'data:image/png;base64,' + img.toPNG().toString('base64'), state: browserState() };
});

ipcMain.handle('browser:execute', async (_e, code: string) => {
  const view = ensureBrowserView();
  try {
    const result = await view.webContents.executeJavaScript(code, true);
    return { result };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
});

ipcMain.handle('browser:devtools', () => {
  const view = ensureBrowserView();
  view.webContents.openDevTools({ mode: 'detach' });
  return { ok: true };
});

// Helper: buka URL / jalankan aplikasi tanpa error ENOENT
function looksLikeUrl(s: string) {
  return /^(https?:\/\/|www\.|localhost|127\.0\.0\.1)/i.test((s || '').trim());
}

function launchDesktopApp(exe: string, args: string[] = []) {
  return new Promise((resolve) => {
    // "start" menyelesaikan App Paths (msedge, chrome, notepad, dll) lewat shell.
    const child = spawn('cmd.exe', ['/c', 'start', '', exe, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err: any) => resolve({ error: err?.message || String(err) }));
    child.on('spawn', () => resolve({ ok: true, launched: exe }));
    setTimeout(() => resolve({ ok: true, launched: exe }), 1500);
  });
}


// ---- Provider chat (OpenAI-compatible + Anthropic) with tool calling ----
ipcMain.handle('chat:send', async (_e, payload: any) => {
  const { provider, baseUrl, apiKey, model, messages, system, tools, tool_choice } = payload;
  try {
    if (provider === 'anthropic') {
      // Convert OpenAI-style messages to Anthropic format
      const anthMsgs: any[] = [];
      for (const m of messages) {
        if (m.role === 'assistant') {
          const blocks: any[] = [];
          if (m.content && typeof m.content === 'string' && m.content.trim()) blocks.push({ type: 'text', text: m.content });
          if (Array.isArray(m.content)) for (const c of m.content) if (c.type === 'text') blocks.push(c);
          if (m.tool_calls) for (const tc of m.tool_calls) {
            let input = {};
            try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          }
          anthMsgs.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
        } else if (m.role === 'tool') {
          const last = anthMsgs[anthMsgs.length - 1];
          const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
          if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
            last.content.push(block);
          } else {
            anthMsgs.push({ role: 'user', content: [block] });
          }
        } else if (m.role === 'user') {
          let content: any = m.content;
          if (Array.isArray(content)) {
            content = content.map((c: any) => {
              if (c.type === 'image_url') {
                const url = c.image_url.url;
                const b64 = url.split(',')[1];
                return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } };
              }
              return c;
            });
          }
          anthMsgs.push({ role: 'user', content });
        }
      }
      const body: any = { model, max_tokens: 4096, messages: anthMsgs };
      if (system) body.system = system;
      if (tools) body.tools = tools;
      const r = await fetch(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) return { error: j };
      // extract text + tool_use
      let text = '';
      const toolCalls: any[] = [];
      for (const b of j.content || []) {
        if (b.type === 'text') text += b.text;
        if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      }
      return { text, tool_calls: toolCalls.length ? toolCalls : undefined, raw: j, stop_reason: j.stop_reason };
    }
    // OpenAI-compatible
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const body: any = { model, messages: msgs, stream: false };
    if (tools) { body.tools = tools; body.tool_choice = tool_choice || 'auto'; }
    const r = await fetch(`${baseUrl || 'https://api.openai.com'}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) return { error: j };
    const m = j.choices?.[0]?.message || {};
    return { text: m.content ?? '', tool_calls: m.tool_calls, raw: j };
  } catch (e: any) { return { error: e?.message || String(e) }; }
});

// ---- Screenshot via desktopCapturer ----
ipcMain.handle('tool:screenshot', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
  if (!sources.length) return { error: 'no screen' };
  return { dataUrl: sources[0].thumbnail.toDataURL() };
});

// ---- Run shell command ----
ipcMain.handle('tool:exec', async (_e, cmd: string, opts?: { timeoutMs?: number; cwd?: string }) => {
  const timeoutMs = Math.min(Math.max(opts?.timeoutMs ?? 120000, 1000), 600000);
  const MAX_OUT = 200_000;
  return new Promise((resolve) => {
    let finished = false;
    const done = (payload: any) => { if (!finished) { finished = true; resolve(payload); } };
    try {
      const p = spawn('cmd.exe', ['/c', cmd], {
        shell: false,
        cwd: opts?.cwd || undefined,
        windowsHide: true,
      });
      let out = '', err = '';
      let truncated = false;
      p.stdout.on('data', (d) => { out += d; if (out.length > MAX_OUT) { out = out.slice(0, MAX_OUT); truncated = true; } });
      p.stderr.on('data', (d) => { err += d; if (err.length > MAX_OUT) { err = err.slice(0, MAX_OUT); truncated = true; } });
      p.on('error', (e: any) => done({ code: -1, stdout: out, stderr: (err + '\n' + (e?.message || String(e))).trim(), error: e?.message || String(e) }));
      p.on('close', (code) => done({ code, stdout: out, stderr: err, truncated }));
      setTimeout(() => {
        try { p.kill(); } catch { /* ignore */ }
        done({ code: -1, stdout: out, stderr: err, timedOut: true, note: `Perintah dihentikan setelah ${Math.round(timeoutMs / 1000)}s. Pecah jadi langkah kecil atau pakai tool file_* / file_list.` });
      }, timeoutMs);
    } catch (e: any) {
      done({ code: -1, stdout: '', stderr: e?.message || String(e), error: e?.message || String(e) });
    }
  });
});

// ===========================================================================
// Tool file-system native (menggantikan pola shell loop; seperti read/glob/move
// di OpenCode) — lebih aman dan hemat langkah.
// ===========================================================================
ipcMain.handle('fs:list', async (_e, dir: string, opts?: { pattern?: string; max?: number }) => {
  const fsP = await import('fs/promises');
  try {
    const target = dir || process.cwd();
    const max = Math.min(opts?.max ?? 500, 5000);
    const out: any[] = [];
    async function walk(cur: string, depth: number) {
      if (out.length >= max || depth > 3) return;
      let entries: any[] = [];
      try { entries = await fsP.readdir(cur, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (out.length >= max) return;
        const full = path.join(cur, ent.name);
        let size = 0;
        try { if (ent.isFile()) size = (await fsP.stat(full)).size; } catch { /* ignore */ }
        out.push({ path: full, name: ent.name, dir: ent.isDirectory(), size });
        if (ent.isDirectory()) await walk(full, depth + 1);
      }
    }
    await walk(target, 0);
    const pattern = (opts?.pattern || '').trim();
    const filtered = pattern
      ? out.filter((f) => {
          const rx = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
          return rx.test(f.name);
        })
      : out;
    return { ok: true, base: target, count: filtered.length, truncated: filtered.length >= max, entries: filtered.slice(0, max) };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
});

ipcMain.handle('fs:mkdir', async (_e, dir: string) => {
  const fsP = await import('fs/promises');
  try {
    await fsP.mkdir(dir, { recursive: true });
    return { ok: true, dir };
  } catch (e: any) { return { error: e?.message || String(e) }; }
});

ipcMain.handle('fs:move', async (_e, src: string, dest: string, opts?: { overwrite?: boolean; copy?: boolean }) => {
  const fsP = await import('fs/promises');
  try {
    const s = path.resolve(src);
    const d = path.resolve(dest);
    if (s === d) return { ok: true, note: 'sumber = tujuan' };
    await fsP.mkdir(path.dirname(d), { recursive: true });
    const exists = await fsP.stat(d).then(() => true).catch(() => false);
    if (exists && !opts?.overwrite) return { error: 'tujuan sudah ada: ' + d, hint: 'set overwrite=true atau ganti nama tujuan' };
    if (opts?.copy) await fsP.cp(s, d, { recursive: true, force: !!opts?.overwrite });
    else await fsP.rename(s, d);
    return { ok: true, from: s, to: d, copy: !!opts?.copy };
  } catch (e: any) { return { error: e?.message || String(e) }; }
});

ipcMain.handle('fs:read', async (_e, file: string, maxBytes?: number) => {
  const fsP = await import('fs/promises');
  try {
    const st = await fsP.stat(file);
    if (st.isDirectory()) return { error: 'ini folder, gunakan file_list' };
    const limit = Math.min(maxBytes ?? 200_000, 2_000_000);
    const fh = await fsP.open(file, 'r');
    const buf = Buffer.alloc(Math.min(limit, st.size));
    await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    return { ok: true, path: file, size: st.size, truncated: st.size > limit, content: buf.toString('utf8') };
  } catch (e: any) { return { error: e?.message || String(e) }; }
});

// ---- Launch app / URL ----
ipcMain.handle('tool:launch', async (_e, exe: string, args: string[] = []) => {
  const target = (exe || '').trim();
  if (!target) return { error: 'nama aplikasi/URL kosong' };

  // URL / nama situs -> buka di browser TERTANAM (bukan Edge/Chrome eksternal)
  const urlArg = (args || []).find((a) => looksLikeUrl(a));
  const browserNames = /^(msedge|edge|chrome|firefox|brave|browser|google-chrome)$/i;
  const isBrowser = browserNames.test(target.replace(/\.exe$/i, ''));

  if (looksLikeUrl(target)) return openInEmbeddedBrowser(target);
  if (urlArg && isBrowser) return openInEmbeddedBrowser(urlArg);
  // Permintaan "buka browser" tanpa URL -> browser tertanam aplikasi.
  if (isBrowser) return openInEmbeddedBrowser('https://www.google.com');

  return launchDesktopApp(target, args);
});

function openInEmbeddedBrowser(url: string) {
  try {
    const view = ensureBrowserView();
    const target = normalizeUrl(url);
    view.webContents.loadURL(target).catch(() => { /* error ditangani via did-fail-load */ });
    // beri tahu renderer supaya panel browser ditampilkan
    win?.webContents.send('browser:request-open', { url: target });
    return { ok: true, embedded: true, url: target, note: 'Tab Browser di aplikasi sudah dibuka. Gunakan browser_snapshot untuk melihat isinya.' };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}

// ---- Tool khusus browser tertanam (dipakai agent) ----
ipcMain.handle('tool:browser', async (_e, action: string, payload: any = {}) => {
  const view = ensureBrowserView();
  const wc = view.webContents;
  try {
    switch (action) {
      case 'open':
      case 'navigate': {
        const target = normalizeUrl(payload.url || '');
        if (!target) return { error: 'url kosong' };
        await wc.loadURL(target);
        win?.webContents.send('browser:request-open', { url: target });
        return { ok: true, ...browserState() };
      }
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'stop': wc.stop(); break;
      case 'snapshot': {
        const img = await wc.capturePage();
        return { dataUrl: 'data:image/png;base64,' + img.toPNG().toString('base64'), ...browserState() };
      }
      case 'text': {
        const result = await wc.executeJavaScript(
          `(() => { const t = document.body ? document.body.innerText : ''; return { title: document.title, url: location.href, text: t.slice(0, 12000) }; })()`,
          true,
        );
        return { ok: true, ...result };
      }
      case 'click': {
        const result = await wc.executeJavaScript(
          `(() => {
             const sel = ${JSON.stringify(payload.selector || '')};
             let el = null;
             if (sel) { try { el = document.querySelector(sel); } catch (e) { return { error: 'selector invalid' }; } }
             else if (${JSON.stringify(payload.text || '')}) {
               const t = ${JSON.stringify(payload.text || '')}.toLowerCase();
               const all = Array.from(document.querySelectorAll('a,button,input,[role=button]'));
               el = all.find((n) => (n.innerText || n.value || '').toLowerCase().includes(t)) || null;
             }
             if (!el) return { error: 'elemen tidak ditemukan' };
             el.scrollIntoView({ block: 'center' });
             el.click();
             return { clicked: true, tag: el.tagName };
           })()`,
          true,
        );
        return { ok: true, ...result };
      }
      case 'fill': {
        const result = await wc.executeJavaScript(
          `(() => {
             const sel = ${JSON.stringify(payload.selector || '')};
             const val = ${JSON.stringify(payload.value || '')};
             const el = sel ? document.querySelector(sel) : null;
             if (!el) return { error: 'elemen tidak ditemukan' };
             el.focus();
             el.value = val;
             el.dispatchEvent(new Event('input', { bubbles: true }));
             el.dispatchEvent(new Event('change', { bubbles: true }));
             return { filled: true };
           })()`,
          true,
        );
        return { ok: true, ...result };
      }
      case 'state': return browserState();
      default: return { error: 'action tidak dikenal: ' + action };
    }
    emitBrowserState();
    return { ok: true, ...browserState() };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
});


// ---- Mouse/keyboard via PowerShell ----
ipcMain.handle('tool:keys', async (_e, keys: string) => {
  return new Promise((resolve) => {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g,"''")}');`;
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps]);
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, stderr: err }));
  });
});

ipcMain.handle('tool:mouse', async (_e, action: string, x?: number, y?: number, button?: string) => {
  const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,int dx,int dy,uint data,UIntPtr extra);
}
"@
if ('${action}' -eq 'move') { [M]::SetCursorPos(${x},${y}) | Out-Null }
if ('${action}' -eq 'click') {
  [M]::SetCursorPos(${x},${y}) | Out-Null
  $down = 0x0002; $up = 0x0004;
  if ('${button}' -eq 'right') { $down = 0x0008; $up = 0x0010; }
  [M]::mouse_event($down,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [M]::mouse_event($up,0,0,0,[UIntPtr]::Zero);
}
if ('${action}' -eq 'double') {
  [M]::SetCursorPos(${x},${y}) | Out-Null
  1..2 | ForEach-Object { [M]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 20; [M]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 50; }
}
Write-Output ok
`;
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, stdout: out.trim(), stderr: err }));
  });
});

ipcMain.handle('tool:type', async (_e, text: string) => {
  // type text char by char via SendKeys with escaping
  const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}').replace(/'/g, "''");
  const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}');`;
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps]);
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, stderr: err }));
  });
});

// ---- File read/write (sandboxed to user dirs) ----
ipcMain.handle('file:read', async (_e, pth: string) => {
  const fs = await import('fs/promises');
  try { return { content: await fs.readFile(pth, 'utf8') }; }
  catch (e: any) { return { error: e?.message }; }
});
ipcMain.handle('file:write', async (_e, pth: string, content: string) => {
  const fs = await import('fs/promises');
  try { await fs.writeFile(pth, content, 'utf8'); return { ok: true }; }
  catch (e: any) { return { error: e?.message }; }
});

// ---- Dialog confirm (for dangerous actions) ----
ipcMain.handle('ui:confirm', async (_e, msg: string) => {
  const r = await dialog.showMessageBox(win!, { type: 'warning', buttons: ['Cancel', 'Allow'], defaultId: 0, message: msg });
  return r.response === 1;
});

// ===========================================================================
// Dialog pilih file/gambar untuk lampiran chat (menu "+").
// ===========================================================================
ipcMain.handle('dialog:pickFiles', async (_e, mode?: string) => {
  try {
    const isImageMode = mode === 'image';
    const filters = isImageMode
      ? [{ name: 'Gambar', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
      : [
          { name: 'Semua file', extensions: ['*'] },
          { name: 'Teks/Kode', extensions: ['txt', 'md', 'json', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'py', 'cs', 'ps1', 'bat', 'yml', 'yaml', 'csv', 'log'] },
          { name: 'Gambar', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        ];
    const res = await dialog.showOpenDialog(win!, {
      title: isImageMode ? 'Pilih gambar' : 'Pilih file',
      properties: ['openFile', 'multiSelections'],
      filters,
    });
    if (res.canceled || !res.filePaths.length) return { ok: true, files: [] };

    const fsP = await import('fs/promises');
    const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
    const files: any[] = [];
    for (const p of res.filePaths.slice(0, 10)) {
      try {
        const st = await fsP.stat(p);
        const name = path.basename(p);
        if (IMG_EXT.test(p) && st.size < 8 * 1024 * 1024) {
          const buf = await fsP.readFile(p);
          const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg');
          files.push({ kind: 'image', path: p, name, size: st.size, dataUrl: `data:image/${ext};base64,` + buf.toString('base64') });
        } else if (st.size < 300 * 1024) {
          const txt = await fsP.readFile(p, 'utf8');
          files.push({ kind: 'text', path: p, name, size: st.size, content: txt.slice(0, 120000) });
        } else {
          files.push({ kind: 'meta', path: p, name, size: st.size });
        }
      } catch (err: any) {
        files.push({ kind: 'error', path: p, error: err?.message || String(err) });
      }
    }
    return { ok: true, files };
  } catch (err: any) {
    return { error: err?.message || String(err), files: [] };
  }
});

// ===========================================================================
// Export sesi (Markdown / JSON / ZIP) + feedback pengguna.
// ===========================================================================
ipcMain.handle('session:export', async (_e, payload: { name?: string; content: string; format?: 'md' | 'json' | 'zip' }) => {
  try {
    const fmt = payload?.format || 'md';
    const safeName = (payload?.name || 'oflabot-session').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
    const res = await dialog.showSaveDialog(win!, {
      title: 'Simpan sesi',
      defaultPath: `${safeName}.${fmt}`,
      filters: fmt === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : fmt === 'zip'
          ? [{ name: 'ZIP', extensions: ['zip'] }]
          : [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return { ok: true, canceled: true };

    const fsP = await import('fs/promises');
    if (fmt === 'zip') {
      const tmpDir = path.join(os.tmpdir(), 'oflabot-export-' + Date.now());
      await fsP.mkdir(tmpDir, { recursive: true });
      const mdPath = path.join(tmpDir, `${safeName}.md`);
      await fsP.writeFile(mdPath, payload.content, 'utf8');
      await new Promise<void>((resolve, reject) => {
        const p = spawn('powershell.exe', ['-NoProfile', '-Command',
          `Compress-Archive -Path '${mdPath}' -DestinationPath '${res.filePath}' -Force`]);
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Compress-Archive exit ' + code))));
        p.on('error', reject);
      });
      try { await fsP.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      await fsP.writeFile(res.filePath, payload.content, 'utf8');
    }
    return { ok: true, path: res.filePath };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
});

ipcMain.handle('feedback:save', async (_e, entry: any) => {
  try {
    const fsP = await import('fs/promises');
    const file = path.join(userDataDir || os.tmpdir(), 'feedback.json');
    let arr: any[] = [];
    try { arr = JSON.parse(await fsP.readFile(file, 'utf8')); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.push({ ...entry, at: new Date().toISOString(), appVersion: app.getVersion() });
    await fsP.writeFile(file, JSON.stringify(arr, null, 2), 'utf8');
    return { ok: true, total: arr.length, file };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
});

ipcMain.handle('app:info', () => ({
  name: APP_NAME,
  version: app.getVersion(),
  userData: userDataDir,
  donateUrl: 'https://saweria.co/OflaCo',
}));

ipcMain.handle('ui:openExternal', async (_e, url: string) => {
  if (!/^https?:\/\//i.test(url || '')) return { error: 'URL tidak valid' };

  // 1) shell.openExternal (cara standar)
  try {
    await shell.openExternal(url);
    return { ok: true, via: 'shell' };
  } catch { /* lanjut ke fallback */ }

  // 2) Fallback: ShellExecute lewat rundll32 / start
  const attempts: Array<[string, string[]]> = [
    ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
    ['cmd.exe', ['/c', 'start', '', url]],
    ['explorer.exe', [url]],
  ];
  for (const [file, args] of attempts) {
    try {
      const res = await new Promise<boolean>((resolve) => {
        try {
          const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
          child.on('error', () => resolve(false));
          child.on('spawn', () => resolve(true));
          setTimeout(() => resolve(true), 800);
        } catch { resolve(false); }
      });
      if (res) return { ok: true, via: file };
    } catch { /* coba berikutnya */ }
  }

  return { error: 'Tidak bisa membuka browser default. Buka manual: ' + url };
});

// ===========================================================================
// Daftar model per provider (dropdown) — membaca langsung dari API provider
// ===========================================================================
function joinUrl(base: string, suffix: string) {
  const b = (base || '').trim().replace(/\/+$/, '');
  return b + suffix;
}

function withV1(base: string) {
  const b = (base || '').trim().replace(/\/+$/, '');
  if (!b) return b;
  if (/\/v\d+[a-z0-9]*$/i.test(b)) return b;
  return b + '/v1';
}

ipcMain.handle('models:list', async (_e, cfg: any) => {
  const { provider, baseUrl, apiKey } = cfg || {};
  const timeout = 20000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    // Ollama: endpoint khusus
    if (provider === 'ollama') {
      const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
      const r = await fetch(joinUrl(base, '/api/tags'), { signal: ctrl.signal });
      const j: any = await r.json();
      if (!r.ok) return { error: j, models: [] };
      const models = (j.models || []).map((m: any) => m.name || m.model).filter(Boolean);
      return { models, count: models.length, source: 'ollama' };
    }

    // Anthropic-compatible (& Syncera Anthropic/Codex): GET /v1/models
    if (cfg.protocol === 'anthropic') {
      const base = withV1(baseUrl || 'https://api.anthropic.com').replace(/\/v1$/, '');
      const r = await fetch(joinUrl(base, '/v1/models?limit=200'), {
        headers: {
          'x-api-key': apiKey || '',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        signal: ctrl.signal,
      });
      const j: any = await r.json();
      if (!r.ok) return { error: j, models: [] };
      const models = (j.data || []).map((m: any) => m.id || m.name).filter(Boolean);
      return { models, count: models.length, source: 'anthropic' };
    }

    // OpenAI-compatible: GET {base}/models
    const base = withV1(baseUrl || 'https://api.openai.com');
    const r = await fetch(joinUrl(base, '/models'), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    const j: any = await r.json();
    if (!r.ok) return { error: j, models: [] };
    let models: string[] = (j.data || j.models || [])
      .map((m: any) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean);
    models = models.sort((a, b) => a.localeCompare(b));
    return { models, count: models.length, source: 'openai' };
  } catch (err: any) {
    return { error: err?.message || String(err), models: [] };
  } finally {
    clearTimeout(timer);
  }
});

// ===========================================================================
// Memory & Skill — dipakai agent untuk mengingat hal penting dan belajar skill
// ===========================================================================
const MEMORY_FILE = () => path.join(userDataDir || os.tmpdir(), 'memory.json');

type MemEntry = {
  id: string;
  kind: 'memory' | 'skill';
  title: string;
  body: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  uses?: number;
};

function readMemory(): { entries: MemEntry[] } {
  try {
    const raw = fs.readFileSync(MEMORY_FILE(), 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.entries)) return j;
  } catch { /* file belum ada */ }
  return { entries: [] };
}

function writeMemory(data: { entries: MemEntry[] }) {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE()), { recursive: true });
    fs.writeFileSync(MEMORY_FILE(), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

ipcMain.handle('memory:list', (_e, filter?: { kind?: string; q?: string }) => {
  const data = readMemory();
  let entries = data.entries;
  if (filter?.kind) entries = entries.filter((e) => e.kind === filter.kind);
  if (filter?.q) {
    const q = filter.q.toLowerCase();
    entries = entries.filter((e) => (e.title + ' ' + e.body + ' ' + (e.tags || []).join(' ')).toLowerCase().includes(q));
  }
  entries = entries.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  return { entries, total: data.entries.length };
});

ipcMain.handle('memory:add', (_e, input: Partial<MemEntry>) => {
  const data = readMemory();
  const now = Date.now();
  const title = (input.title || '').trim() || (input.body || '').trim().slice(0, 60) || 'Catatan';
  const body = (input.body || '').trim();
  if (!body && !title) return { error: 'kosong' };
  // dedupe sederhana: kalau judul+body sama, perbarui
  const existing = data.entries.find(
    (e) => e.kind === (input.kind || 'memory') && e.title.toLowerCase() === title.toLowerCase(),
  );
  if (existing) {
    existing.body = body || existing.body;
    existing.tags = input.tags || existing.tags;
    existing.updatedAt = now;
    writeMemory(data);
    return { ok: true, entry: existing, updated: true };
  }
  const entry: MemEntry = {
    id: newId(),
    kind: input.kind === 'skill' ? 'skill' : 'memory',
    title,
    body,
    tags: input.tags || [],
    createdAt: now,
    updatedAt: now,
    uses: 0,
  };
  data.entries.push(entry);
  writeMemory(data);
  return { ok: true, entry };
});

ipcMain.handle('memory:delete', (_e, id: string) => {
  const data = readMemory();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.id !== id);
  writeMemory(data);
  return { ok: true, removed: before - data.entries.length };
});

ipcMain.handle('memory:clear', (_e, kind?: string) => {
  const data = readMemory();
  data.entries = kind ? data.entries.filter((e) => e.kind !== kind) : [];
  writeMemory(data);
  return { ok: true, total: data.entries.length };
});

// Konteks memory untuk system prompt (dipakai renderer saat menyusun prompt).
ipcMain.handle('memory:context', (_e, limit = 40) => {
  const data = readMemory();
  const memories = data.entries.filter((e) => e.kind === 'memory').slice(-limit);
  const skills = data.entries.filter((e) => e.kind === 'skill').slice(-limit);
  return { memories, skills, total: data.entries.length };
});

// ===========================================================================
// Skills dari GitHub — format Claude Code / Claude Desktop / Codex / OpenCode /
// Hermes / VS Code (file SKILL.md dengan frontmatter YAML).
// Skill yang terpasang di-inject ke system prompt (nama + deskripsi), isi penuh
// dibaca agent saat dibutuhkan lewat tool skill_read (progressive disclosure).
// ===========================================================================
const SKILLS_DIR = () => path.join(userDataDir || os.tmpdir(), 'skills');
const SKILLS_INDEX = () => path.join(userDataDir || os.tmpdir(), 'skills.json');

type SkillMeta = {
  slug: string;
  name: string;
  description: string;
  source: string;
  path: string;
  enabled: boolean;
  installedAt: number;
  origin?: string;
};

type SkillsIndex = { skills: SkillMeta[] };

function readSkillsIndex(): SkillsIndex {
  try {
    const j = JSON.parse(fs.readFileSync(SKILLS_INDEX(), 'utf8'));
    if (j && Array.isArray(j.skills)) return j;
  } catch { /* belum ada */ }
  return { skills: [] };
}

function writeSkillsIndex(idx: SkillsIndex) {
  try {
    fs.mkdirSync(path.dirname(SKILLS_INDEX()), { recursive: true });
    fs.writeFileSync(SKILLS_INDEX(), JSON.stringify(idx, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

function slugify(s: string) {
  return (s || 'skill')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'skill';
}

function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md || '');
  if (!m) return { meta, body: md || '' };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const r = await fetch(url, { headers: headers || { 'User-Agent': 'OflaBot' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return await r.text();
}

/** Terima "owner/repo", "https://github.com/owner/repo", beserta /tree/branch/path. */
function parseRepoInput(input: string) {
  const raw = (input || '').trim();
  if (!raw) throw new Error('URL repo kosong');
  let owner = '', repo = '', branch = '', subPath = '';
  const url = raw.match(/github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s]+)(?:\/([^\s]*))?)?/i);
  if (url) {
    owner = url[1];
    repo = url[2].replace(/\.git$/i, '');
    branch = url[3] || '';
    subPath = (url[4] || '').replace(/\/+$/, '');
  } else {
    const short = raw.match(/^([^/\s]+)\/([^/\s#]+)$/);
    if (!short) throw new Error('Format repo tidak dikenali. Contoh: owner/repo atau https://github.com/owner/repo');
    owner = short[1];
    repo = short[2].replace(/\.git$/i, '');
  }
  return { owner, repo, branch, subPath };
}

async function listTree(owner: string, repo: string, branch: string) {
  const b = branch || 'HEAD';
  const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(b)}?recursive=1`;
  const txt = await fetchText(api, { 'User-Agent': 'OflaBot', Accept: 'application/vnd.github+json' });
  const j: any = JSON.parse(txt);
  if (j.message) throw new Error(j.message);
  return (j.tree || []) as Array<{ path: string; type: string; size?: number }>;
}

async function installSkillsFromRepo(input: string): Promise<any> {
  const { owner, repo, branch, subPath } = parseRepoInput(input);
  const tree = await listTree(owner, repo, branch);
  const ref = branch || 'HEAD';
  const mdFiles = tree.filter(
    (t) => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path) && (!subPath || t.path.startsWith(subPath + '/')),
  );
  if (!mdFiles.length) {
    return { error: 'Repo ini tidak berisi SKILL.md. Format yang didukung: SKILL.md (Claude Code/Desktop, Codex, OpenCode, Hermes, VS Code).', found: 0 };
  }
  const idx = readSkillsIndex();
  const installed: any[] = [];
  for (const f of mdFiles.slice(0, 50)) {
    try {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
      const md = await fetchText(url);
      const { meta, body } = parseFrontmatter(md);
      const name = meta.name || f.path.split('/').slice(-2, -1)[0] || 'skill';
      const slug = slugify(`${repo}-${name}`);
      const dir = path.join(SKILLS_DIR(), slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
      const entry: SkillMeta = {
        slug,
        name,
        description: meta.description || body.trim().split(/\r?\n/)[0] || '',
        source: `github:${owner}/${repo}`,
        path: path.join(dir, 'SKILL.md'),
        enabled: true,
        installedAt: Date.now(),
        origin: `https://github.com/${owner}/${repo}/blob/${ref}/${f.path}`,
      };
      const i = idx.skills.findIndex((s) => s.slug === slug);
      if (i >= 0) idx.skills[i] = entry; else idx.skills.push(entry);
      installed.push(entry);
    } catch (err: any) {
      installed.push({ error: err?.message || String(err), path: f.path });
    }
  }
  writeSkillsIndex(idx);
  return { ok: true, found: mdFiles.length, installed };
}

function skillLocalDirs(): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.claude', 'plugins'),
    path.join(appData, 'Claude', 'skills'),
    path.join(home, '.config', 'opencode', 'skills'),
    path.join(appData, 'opencode', 'skills'),
    path.join(home, '.codex', 'skills'),
    path.join(home, '.hermes', 'skills'),
    path.join(home, '.vscode', 'skills'),
    path.join(process.cwd(), '.claude', 'skills'),
    SKILLS_DIR(),
  ];
}

function scanLocalSkills(): any[] {
  const found: any[] = [];
  for (const base of skillLocalDirs()) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        const dir = path.join(base, name);
        const file = path.join(dir, 'SKILL.md');
        if (fs.existsSync(file)) {
          const md = fs.readFileSync(file, 'utf8');
          const { meta } = parseFrontmatter(md);
          found.push({
            slug: slugify(`${name}`),
            name: meta.name || name,
            description: meta.description || '',
            path: file,
            source: `local:${base}`,
          });
        }
      }
    } catch { /* abaikan folder yang tidak bisa dibaca */ }
  }
  return found;
}

ipcMain.handle('skills:list', () => {
  const idx = readSkillsIndex();
  return { skills: idx.skills, dir: SKILLS_DIR() };
});

ipcMain.handle('skills:installRepo', async (_e, input: string) => {
  try { return await installSkillsFromRepo(input); }
  catch (err: any) { return { error: err?.message || String(err) }; }
});

ipcMain.handle('skills:importLocal', () => {
  const idx = readSkillsIndex();
  const local = scanLocalSkills();
  let added = 0;
  for (const s of local) {
    const exists = idx.skills.find((x) => x.path === s.path);
    if (exists) continue;
    idx.skills.push({ ...s, enabled: true, installedAt: Date.now() });
    added++;
  }
  writeSkillsIndex(idx);
  return { ok: true, found: local.length, added, skills: idx.skills };
});

ipcMain.handle('skills:toggle', (_e, slug: string, enabled: boolean) => {
  const idx = readSkillsIndex();
  const s = idx.skills.find((x) => x.slug === slug);
  if (!s) return { error: 'skill tidak ditemukan' };
  s.enabled = !!enabled;
  writeSkillsIndex(idx);
  return { ok: true, skill: s };
});

ipcMain.handle('skills:remove', (_e, slug: string) => {
  const idx = readSkillsIndex();
  const s = idx.skills.find((x) => x.slug === slug);
  idx.skills = idx.skills.filter((x) => x.slug !== slug);
  writeSkillsIndex(idx);
  // hapus folder hanya kalau hasil instalasi kita sendiri
  try {
    if (s && s.path.startsWith(SKILLS_DIR())) {
      const dir = path.dirname(s.path);
      if (dir.startsWith(SKILLS_DIR()) && dir !== SKILLS_DIR()) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* abaikan */ }
  return { ok: true };
});

ipcMain.handle('skills:read', (_e, slug: string) => {
  const idx = readSkillsIndex();
  const s = idx.skills.find((x) => x.slug === slug || x.name.toLowerCase() === String(slug).toLowerCase());
  if (!s) return { error: 'skill tidak ditemukan' };
  try {
    const md = fs.readFileSync(s.path, 'utf8');
    const { body } = parseFrontmatter(md);
    return { ok: true, slug: s.slug, name: s.name, description: s.description, body: body.slice(0, 20000) };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
});

ipcMain.handle('skills:searchGithub', async (_e, query: string) => {
  try {
    const q = encodeURIComponent(`${query || 'claude skill'} SKILL.md in:readme`);
    const txt = await fetchText(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query || 'claude skills')}&sort=stars&per_page=12`,
      { 'User-Agent': 'OflaBot', Accept: 'application/vnd.github+json' },
    );
    const j: any = JSON.parse(txt);
    if (j.message) return { error: j.message, items: [] };
    const items = (j.items || []).map((r: any) => ({
      fullName: r.full_name,
      description: r.description,
      stars: r.stargazers_count,
      url: r.html_url,
    }));
    return { items };
  } catch (err: any) {
    return { error: err?.message || String(err), items: [] };
  }
});

// Konteks skill untuk system prompt (nama + deskripsi saja).
ipcMain.handle('skills:context', () => {
  const idx = readSkillsIndex();
  const enabled = idx.skills.filter((s) => s.enabled);
  return {
    total: idx.skills.length,
    enabled: enabled.map((s) => ({ slug: s.slug, name: s.name, description: s.description, source: s.source })),
  };
});
