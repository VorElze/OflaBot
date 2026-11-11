/// <reference types="vite/client" />

type Rect = { x: number; y: number; width: number; height: number };

interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  visible: boolean;
  error?: string;
}

interface DshBrowserApi {
  show: (rect: Rect | null) => Promise<BrowserState>;
  hide: () => Promise<BrowserState>;
  state: () => Promise<BrowserState>;
  navigate: (url: string) => Promise<BrowserState>;
  action: (action: string) => Promise<BrowserState>;
  snapshot: () => Promise<{ dataUrl: string; state: BrowserState }>;
  execute: (code: string) => Promise<any>;
  devtools: () => Promise<any>;
  tool: (action: string, payload?: any) => Promise<any>;
  onState: (cb: (s: BrowserState) => void) => () => void;
  onRequestOpen: (cb: (p: { url: string }) => void) => () => void;
  onError: (cb: (p: any) => void) => () => void;
}

interface MemEntry {
  id: string;
  kind: 'memory' | 'skill';
  title: string;
  body: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  uses?: number;
}

interface DshMemoryApi {
  list: (filter?: { kind?: string; q?: string }) => Promise<{ entries: MemEntry[]; total: number }>;
  add: (entry: Partial<MemEntry>) => Promise<{ ok?: boolean; entry?: MemEntry; error?: string }>;
  remove: (id: string) => Promise<{ ok: boolean }>;
  clear: (kind?: string) => Promise<{ ok: boolean }>;
  context: (limit?: number) => Promise<{ memories: MemEntry[]; skills: MemEntry[]; total: number }>;
}

interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  source: string;
  path: string;
  enabled: boolean;
  installedAt: number;
  origin?: string;
}

interface DshSkillsApi {
  list: () => Promise<{ skills: SkillMeta[]; dir: string }>;
  installRepo: (input: string) => Promise<any>;
  importLocal: () => Promise<any>;
  toggle: (slug: string, enabled: boolean) => Promise<any>;
  remove: (slug: string) => Promise<any>;
  read: (slug: string) => Promise<any>;
  searchGithub: (q: string) => Promise<{ items: any[]; error?: string }>;
  context: () => Promise<{ total: number; enabled: any[] }>;
}

interface DshApi {
  chat: (payload: any) => Promise<any>;
  appInfo: () => Promise<{ name: string; version: string; userData: string; donateUrl: string }>;
  openExternal: (url: string) => Promise<{ ok?: boolean; error?: string }>;
  models: (cfg: any) => Promise<{ models: string[]; count?: number; error?: any }>;
  memory: DshMemoryApi;
  skills: DshSkillsApi;
  screenshot: () => Promise<{ dataUrl?: string; error?: string }>;
  exec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  launch: (exe: string, args?: string[]) => Promise<any>;
  keys: (keys: string) => Promise<any>;
  mouse: (action: string, x?: number, y?: number, button?: string) => Promise<any>;
  type: (text: string) => Promise<any>;
  fileRead: (p: string) => Promise<any>;
  fileWrite: (p: string, c: string) => Promise<any>;
  confirm: (msg: string) => Promise<boolean>;
  browser: DshBrowserApi;
}

interface Window { dsh: DshApi; }
