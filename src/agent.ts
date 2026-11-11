// Definisi tool (format OpenAI function-calling) + executor.
// Tool "browser_*" bekerja pada browser TERTANAM di dalam aplikasi.

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description:
        'Buka URL di browser tertanam aplikasi (BUKAN Edge/Chrome eksternal). Halaman tampil di tab Browser. Gunakan ini untuk membuka website.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_action',
      description: 'Kontrol browser tertanam. action: back | forward | reload | stop.',
      parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Ambil gambar (screenshot) halaman browser tertanam. Pakai untuk "melihat" halaman web.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_text',
      description: 'Baca judul, URL, dan teks halaman browser tertanam (untuk memahami isi halaman).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Klik elemen di halaman tertanam, berdasarkan CSS selector atau teks tombol/tautan.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, text: { type: 'string' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description: 'Isi kolom input dihalaman tertanam (CSS selector + value).',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, value: { type: 'string' } },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Ambil screenshot SELURUH layar desktop (bukan hanya browser).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Jalankan perintah shell (cmd.exe) di Windows. Mengembalikan stdout/stderr/exit code.',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch',
      description: 'Buka aplikasi desktop Windows (mis. notepad, explorer, calc). URL akan dibuka di browser tertanam.',
      parameters: {
        type: 'object',
        properties: { exe: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
        required: ['exe'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mouse',
      description: 'Gerakkan/klik mouse di layar desktop. action: move|click|double; button left|right.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' } },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'type', description: 'Ketik teks pada fokus saat ini.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  },
  {
    type: 'function',
    function: {
      name: 'keys',
      description: 'Kirim tombol keyboard (format SendKeys, mis. "{ENTER}", "^c" untuk Ctrl+C).',
      parameters: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Baca file teks.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_write',
      description: 'Tulis file teks.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm',
      description: 'Minta izin pengguna sebelum aksi berbahaya. Mengembalikan boolean.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description:
        'Simpan memori jangka panjang atau skill yang bisa dipakai lagi. kind: "memory" (fakta/preferensi user) atau "skill" (prosedur/langkah yang berhasil). Gunakan setiap kali menemukan info penting yang layak diingat.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['memory', 'skill'] },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind', 'title', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: 'Cari memori/skill yang tersimpan berdasarkan kata kunci.',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: 'Hapus satu memori/skill berdasarkan id.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_list',
      description: 'Daftar skill terpasang (dari GitHub/lokal) beserta deskripsi singkat.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_read',
      description: 'Baca instruksi lengkap sebuah skill (pakai slug/nama). Jalankan sebelum memakai skill tersebut.',
      parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_dangerous',
      description: 'Minta izin pengguna sebelum aksi berbahaya. Mengembalikan boolean.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    },
  },
];

export const BROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_action',
  'browser_snapshot',
  'browser_text',
  'browser_click',
  'browser_fill',
];

export const MEMORY_TOOL_NAMES = ['memory_save', 'memory_search', 'memory_delete', 'skill_list', 'skill_read'];

export async function runTool(name: string, args: any): Promise<any> {
  const b = window.dsh.browser;
  const mem = window.dsh.memory;
  const sk = window.dsh.skills;
  switch (name) {
    case 'memory_save':
      return mem.add({ kind: args.kind === 'skill' ? 'skill' : 'memory', title: args.title, body: args.body, tags: args.tags });
    case 'memory_search':
      return mem.list({ q: args.q });
    case 'memory_delete':
      return mem.remove(args.id);
    case 'skill_list': {
      const r = await sk.list();
      return { skills: (r.skills || []).map((s) => ({ slug: s.slug, name: s.name, description: s.description, enabled: s.enabled })) };
    }
    case 'skill_read':
      return sk.read(args.slug);
    case 'browser_open': return b.tool('open', { url: args.url });
    case 'browser_action': return b.tool(args.action);
    case 'browser_snapshot': return b.tool('snapshot');
    case 'browser_text': return b.tool('text');
    case 'browser_click': return b.tool('click', { selector: args.selector, text: args.text });
    case 'browser_fill': return b.tool('fill', { selector: args.selector, value: args.value });
    case 'screenshot': return window.dsh.screenshot();
    case 'exec': return window.dsh.exec(args.cmd);
    case 'launch': return window.dsh.launch(args.exe, args.args);
    case 'mouse': return window.dsh.mouse(args.action, args.x, args.y, args.button);
    case 'type': return window.dsh.type(args.text);
    case 'keys': return window.dsh.keys(args.keys);
    case 'file_read': return window.dsh.fileRead(args.path);
    case 'file_write': return window.dsh.fileWrite(args.path, args.content);
    case 'confirm': return window.dsh.confirm(args.message);
    case 'confirm_dangerous': return window.dsh.confirm(args.message);
    default: return { error: 'unknown tool ' + name };
  }
}

// Aksi di dalam browser tertanam & memori tidak berbahaya.
export function isDangerous(name: string, _args: any): boolean {
  if (BROWSER_TOOL_NAMES.includes(name)) return false;
  if (MEMORY_TOOL_NAMES.includes(name)) return false;
  if (name === 'screenshot') return false;
  if (name === 'file_read') return false;
  if (name === 'confirm' || name === 'confirm_dangerous') return false;
  return true;
}

// Data gambar hasil tool → untuk dikirim ke model sebagai image.
export function extractImage(result: any): string | null {
  if (!result) return null;
  if (typeof result.dataUrl === 'string' && result.dataUrl.length > 100) return result.dataUrl;
  return null;
}
