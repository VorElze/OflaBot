import { contextBridge, ipcRenderer } from 'electron';

type Rect = { x: number; y: number; width: number; height: number } | null;

contextBridge.exposeInMainWorld('dsh', {
  // --- chat / provider ---
  chat: (payload: any) => ipcRenderer.invoke('chat:send', payload),

  clipboard: { image: () => ipcRenderer.invoke('clipboard:image') },

  // --- export & feedback ---
  sessionExport: (payload: any) => ipcRenderer.invoke('session:export', payload),
  feedback: (entry: any) => ipcRenderer.invoke('feedback:save', entry),

  // --- lampiran (menu +) ---
  files: {
    pick: (mode?: string) => ipcRenderer.invoke('dialog:pickFiles', mode),
  },

  // --- info & tautan ---
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url: string) => ipcRenderer.invoke('ui:openExternal', url),

  // --- daftar model provider ---
  models: (cfg: any) => ipcRenderer.invoke('models:list', cfg),

  // --- memory & skill ---
  memory: {
    list: (filter?: any) => ipcRenderer.invoke('memory:list', filter),
    add: (entry: any) => ipcRenderer.invoke('memory:add', entry),
    remove: (id: string) => ipcRenderer.invoke('memory:delete', id),
    clear: (kind?: string) => ipcRenderer.invoke('memory:clear', kind),
    context: (limit?: number) => ipcRenderer.invoke('memory:context', limit),
  },

  // --- skills (import dari GitHub / lokal) ---
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    installRepo: (input: string) => ipcRenderer.invoke('skills:installRepo', input),
    importLocal: () => ipcRenderer.invoke('skills:importLocal'),
    toggle: (slug: string, enabled: boolean) => ipcRenderer.invoke('skills:toggle', slug, enabled),
    remove: (slug: string) => ipcRenderer.invoke('skills:remove', slug),
    read: (slug: string) => ipcRenderer.invoke('skills:read', slug),
    searchGithub: (q: string) => ipcRenderer.invoke('skills:searchGithub', q),
    context: () => ipcRenderer.invoke('skills:context'),
  },

  // --- desktop tools ---
  screenshot: () => ipcRenderer.invoke('tool:screenshot'),
  exec: (cmd: string, opts?: { timeoutMs?: number; cwd?: string }) => ipcRenderer.invoke('tool:exec', cmd, opts),
  execKill: () => ipcRenderer.invoke('tool:kill'),
  fs: {
    list: (dir: string, opts?: any) => ipcRenderer.invoke('fs:list', dir, opts),
    mkdir: (dir: string) => ipcRenderer.invoke('fs:mkdir', dir),
    move: (src: string, dest: string, opts?: any) => ipcRenderer.invoke('fs:move', src, dest, opts),
    read: (file: string, maxBytes?: number) => ipcRenderer.invoke('fs:read', file, maxBytes),
  },
  launch: (exe: string, args?: string[]) => ipcRenderer.invoke('tool:launch', exe, args),
  keys: (keys: string) => ipcRenderer.invoke('tool:keys', keys),
  mouse: (action: string, x?: number, y?: number, button?: string) => ipcRenderer.invoke('tool:mouse', action, x, y, button),
  type: (text: string) => ipcRenderer.invoke('tool:type', text),
  fileRead: (p: string) => ipcRenderer.invoke('file:read', p),
  fileWrite: (p: string, c: string) => ipcRenderer.invoke('file:write', p, c),
  confirm: (msg: string) => ipcRenderer.invoke('ui:confirm', msg),

  // --- embedded browser ---
  browser: {
    show: (rect: Rect) => ipcRenderer.invoke('browser:show', rect),
    hide: () => ipcRenderer.invoke('browser:hide'),
    state: () => ipcRenderer.invoke('browser:state'),
    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    action: (action: string) => ipcRenderer.invoke('browser:action', action),
    snapshot: () => ipcRenderer.invoke('browser:snapshot'),
    execute: (code: string) => ipcRenderer.invoke('browser:execute', code),
    devtools: () => ipcRenderer.invoke('browser:devtools'),
    tool: (action: string, payload?: any) => ipcRenderer.invoke('tool:browser', action, payload),
    onState: (cb: (s: any) => void) => {
      const handler = (_e: any, s: any) => cb(s);
      ipcRenderer.on('browser:state', handler);
      return () => ipcRenderer.removeListener('browser:state', handler);
    },
    onRequestOpen: (cb: (p: { url: string }) => void) => {
      const handler = (_e: any, p: any) => cb(p);
      ipcRenderer.on('browser:request-open', handler);
      return () => ipcRenderer.removeListener('browser:request-open', handler);
    },
    onError: (cb: (p: any) => void) => {
      const handler = (_e: any, p: any) => cb(p);
      ipcRenderer.on('browser:error', handler);
      return () => ipcRenderer.removeListener('browser:error', handler);
    },
  },
});
