# OflaBot

<p align="center">
  <img src="build/icon.png" width="120" alt="OflaBot" />
</p>

<p align="center">
  <b>AI desktop agent untuk Windows</b> — browser tertanam, memory & auto-skill,
  install skill dari GitHub, dan dukungan banyak provider AI.
</p>

<p align="center">
  <a href="https://github.com/VorElze/OflaBot/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/VorElze/OflaBot?style=flat" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078D6" />
</p>

---

## ⬇️ Download

Rilis siap pakai (installer Windows):
**[github.com/VorElze/OflaBot/releases](https://github.com/VorElze/OflaBot/releases/latest)**

1. Unduh `OflaBot-Setup-<versi>.exe`
2. Jalankan installer — jika muncul **"Windows protected your PC"**, klik
   **More info → Run anyway** (aplikasi belum code-signing).
3. Shortcut **OflaBot** dibuat di Desktop & Start Menu.

Verifikasi unduhan dengan file `.sha256` yang disertakan di halaman rilis.

## ✨ Fitur

| Fitur | Keterangan |
|---|---|
| 🌐 **Browser tertanam** | Semua navigasi web terjadi **di dalam aplikasi** (bukan Edge/Chrome). Agent bisa membuka URL, membaca isi halaman, klik, isi form, dan screenshot halaman. |
| 🤖 **Agents** | `OflaBot`, `Web Agent`, `Desktop Agent`, `Coder`, `Researcher` — masing-masing punya set tool sendiri. |
| 🗂 **Sessions** | Riwayat percakapan tersimpan otomatis, bisa dibuat/dipindah/dihapus. |
| 🧠 **Memory jangka panjang** | Agent menyimpan fakta & preferensi penting dan memakainya lagi di sesi berikutnya. |
| 🎓 **Belajar skill otomatis** | Setelah sesi, agent merefleksikan percakapan dan menyimpan prosedur yang bisa dipakai ulang (gaya Hermes). Bisa dimatikan di Settings. |
| 🧩 **Skill dari GitHub** | Pasang skill `SKILL.md` dari repo mana pun — kompatibel dengan skill Claude Code / Claude Desktop / Codex / OpenCode / Hermes / VS Code. Bisa juga impor dari folder lokal. |
| 🔀 **Dropdown model otomatis** | Daftar model dibaca langsung dari API provider — tidak perlu mengetik nama model. |
| 🖥 **Kontrol desktop** | Jalankan perintah, buka aplikasi, mouse, keyboard, baca/tulis file (dengan konfirmasi untuk aksi berbahaya). |
| ❤ **Donasi** | Menu dukungan langsung ke [Saweria](https://saweria.co/OflaCo). |

![Browser tertanam](docs/screenshot-browser.png)

![Antarmuka OflaBot](docs/screenshot-chat.png)

## 🔌 Provider yang didukung

| Provider | Protokol | Daftar model |
|---|---|---|
| OpenAI, DeepSeek, Groq, OpenRouter, MiniMax, NVIDIA NIM, Gemini, 9Router, Custom | OpenAI-compatible | `GET {base}/models` |
| Anthropic, **Syncera.id (Anthropic)**, Claude Code | Anthropic | `GET /v1/models` |
| **Syncera.id (Codex)** | OpenAI-compatible | `GET {base}/models` |
| **OpenCode Console (Free)** | OpenAI-compatible | `https://opencode.ai/inference/openai/v1` |
| **opencode-go (Subscription)** | OpenAI-compatible | endpoint yang sama, API key langganan |
| Ollama (lokal) | OpenAI-compatible | `GET /api/tags` |

Kalau provider tidak menyediakan endpoint daftar model, OflaBot memakai daftar
cadangan dan tetap menyediakan mode **ketik manual**.

## 📦 Build sendiri

Prasyarat: **Node.js 20+** dan Windows 10/11.

```bash
git clone https://github.com/VorElze/OflaBot.git
cd OflaBot
npm install
npm run dev        # mode pengembangan (Vite + Electron)
```

Membuat installer `.exe`:

```bash
npm run dist       # -> release\OflaBot-Setup-<versi>.exe
```

Catatan build:

- Installer dibuat dengan **.NET (`csc.exe`)**, bukan NSIS — NSIS gagal pada
  beberapa build Windows.
- Shortcut menunjuk `wscript.exe` → `launch.vbs` supaya aplikasi tidak diblokir
  dialog **SmartScreen** ("Windows protected your PC").
- Aplikasi dijalankan dengan `--no-sandbox` (dibutuhkan Chromium di sebagian
  build Windows). Kalau menjalankan exe langsung, tambahkan flag itu.

Opsional — indeks kode untuk kontributor/AI agent (menghemat pembacaan file):

```bash
npm run graph:update     # butuh graphify CLI: https://github.com/graphify-dev/graphify
graphify explain "agentLoop"      # siapa memanggil apa (ringkas, ~250 token)
graphify affected "toolSignature" # dampak perubahan sebelum refactor
```

Hasil indeks ada di `graphify-out/` dan **tidak di-commit** (masuk `.gitignore`).
Jalankan `npm run graph:update` lagi setelah mengubah kode agar line number akurat.

## 🧩 Contoh memasang skill dari GitHub

1. Buka panel **Skills** di sidebar.
2. Tempel `owner/repo` atau `https://github.com/owner/repo` (boleh dengan
   `/tree/branch/folder`).
3. Klik **Install** — OflaBot mengunduh semua `SKILL.md` dan mendaftarkannya.
4. Atau klik **Import dari folder lokal** untuk memindai:
   `~/.claude/skills`, `~/.claude/plugins`, `~/AppData/Roaming/Claude/skills`,
   `~/.config/opencode/skills`, `~/.codex/skills`, `~/.hermes/skills`,
   `~/.vscode/skills`, dan `.claude/skills` di folder kerja.

Format skill yang dibaca:

```markdown
---
name: contoh-skill
description: Kapan skill ini dipakai
---

# Langkah-langkah
1. ...
2. ...
```

## 🗂 Struktur proyek

```
electron/main.ts     window, IPC provider, browser tertanam, memory, skills, model list
electron/preload.ts  bridge aman (contextIsolation)
src/App.tsx          UI: sidebar Agents/Sessions, tab Chat & Browser, panel Memory/Skills/Donasi
src/agents.ts        definisi Agent + aturan memory/skill
src/agent.ts         definisi & eksekutor tool
src/providers.ts     katalog provider + default model
src/styles.css       tema gelap
installer/Setup.cs   installer .NET (payload ter-embed)
build/               ikon aplikasi
build-exe.ps1        skrip build installer
```

## 🔐 Privasi & keamanan

- API key hanya disimpan lokal di profil aplikasi (`localStorage`), tidak
  dikirim ke mana pun selain provider yang Anda pilih.
- Aksi desktop berbahaya (exec, tulis file, launch, mouse/keyboard) meminta
  konfirmasi lebih dulu.
- Skill dari GitHub diunduh sebagai teks (`SKILL.md`) dan hanya dibaca agent;
  **periksa dulu** isi skill sebelum mengaktifkannya.

## ❤ Dukungan

Kalau OflaBot membantu pekerjaan Anda:
**[saweria.co/OflaCo](https://saweria.co/OflaCo)**

## 📄 Lisensi

[MIT](LICENSE)

## 🔓 Mode akses (Full Access)

- Toolbar kanan: tombol **🔓 Normal / 🔒 Full Access** — klik untuk berganti.
- **Settings → Full Access** juga tersedia.
- Mode Normal: dialog izin muncul sekali; klik **Allow** lalu semua aksi berikutnya
  di sesi itu otomatis diizinkan. Klik **Cancel** untuk menolak aksi tersebut.

## 🧹 Uninstall menyeluruh

Jalankan `uninstall.cmd` di folder instalasi (atau Start Menu → OflaBot → Uninstall).
Yang dihapus: proses aplikasi, shortcut Desktop + Start Menu, entri registry,
folder instalasi, serta cache/profil (`%APPDATA%\OflaBot`,
`%APPDATA%\grokbot-desktop`, `%LOCALAPPDATA%\OflaBot`).

## 🛡 Keandalan agent (v0.2.3, diperkuat v0.2.7)

Berdasarkan pembandingan dengan artefak OpenCode Desktop (`app.asar`: tool `todowrite`,
kompaksi konteks, penanganan `tool-error`) dan perilaku agent GrokBot:

- **Pengaman loop**: panggilan tool dengan argumen sama (setelah dinormalisasi) tidak
  dieksekusi ulang — hasil sebelumnya dipakai (cache), agent diberi instruksi untuk
  mengubah pendekatan / bertanya. (Diuji dengan mock
  provider yang selalu memanggil tool sama: panggilan ke-2 memakai hasil cache, lalu lanjut jawaban final.)
- **Retry provider** otomatis 3× untuk error transien (429/5xx/timeout).
- **Respons kosong** tidak lagi menjadi bubble "(tanpa jawaban)" — muncul notifikasi jelas.
- **Tanpa batas langkah tetap** (v0.2.6+): agent berjalan sampai Anda klik Stop, model error,
  atau pengaman kemajuan mendeteksi stuck (banyak baca tanpa aksi). Tidak ada tombol "Lanjutkan".
- **Tool file native** (menggantikan pola shell loop): `file_list`, `file_move`,
  `file_mkdir`, `file_stat`.
- **Todo/rencana tugas** (`todo_write`) tampil sebagai panel 📋 — agent wajib memakainya
  untuk tugas multi-langkah.
- **exec** kini punya `timeoutMs` (default 120s) dan `cwd`, output dipotong 200 KB
  dengan penanda `truncated`/`timedOut`.

## 🧠 Engine agent (v0.2.7) — selaras DSH & OpenCode Desktop

Hasil pembandingan langsung dengan kode DSH dan OpenCode Desktop (v2.2.7):

- **Tool call dikelompokkan**: semua pemanggilan berurutan jadi **satu kartu** dengan judul
  kategori gaya DSH/OpenCode — "Membaca file", "Membaca file dan menjalankan perintah",
  bukan 12 baris "Used file_list". Jumlah langkah tampil kecil di kanan ("12 langkah · detail").
- **Dedup + cache**: panggilan dengan argumen sama (dinormalisasi: path case/garis miring,
  `max`, `cwd` diabaikan) **tidak dieksekusi ulang** — hasil sebelumnya dikembalikan dengan
  penanda `cached`. Ini menghentikan loop yang dialami v0.2.6 (281× `file_list`).
- **Pengaman kemajuan** (bukan batas langkah): kalau 8 panggilan baca berturut tanpa aksi,
  model diingatkan; pada 11 diperingatkan keras; pada 14 tool dimatikan dan model wajib
  menyimpulkan. Counter reset setiap kali ada aksi nyata (file_move/write/exec).
- **Auto-compaction**: konteks > ~110 ribu karakter diringkas otomatis (ringkasan heuristik
  riwayat lama, potong di batas pesan user agar pasangan tool-call tetap utuh).
- **Pemangkasan output gaya DSH**: hasil tool dipotong tengah (head+tail + penanda
  `[... N karakter tengah dipotong ...]`), daftar file diringkas ke sampel nama + hitungan.
- **Tool `session_log`**: saat Anda minta laporan ("apa yang tadi dikerjakan / kenapa error"),
  agent membaca log sesinya sendiri — bukan menebak atau membuka folder lain.
- **Keyboard**: menu Edit (Cut/Copy/Paste/Select All) dipasang di main process supaya
  Ctrl+C / Ctrl+V bekerja di seluruh kolom teks; menu bar disembunyikan.
- **Ctrl+V gambar**: handler `onPaste` + listener global + fallback IPC clipboard
  (`clipboard.read()` ClipboardItem → PNG). Gambar dinormalisasi (≤1600px / ≤3 MB)
  sebelum dikirim ke model vision.

## ➕ Menu composer (v0.2.5)

Tombol **＋** di kotak pesan (mirip DSH):

| Add | Fungsi |
|---|---|
| 📎 File (Ctrl+U) | lampirkan gambar (vision) atau file teks (konteks) |
| 🖼 Tempel gambar | ambil screenshot dari clipboard (sama seperti Ctrl+V) |
| 🎯 Goal | tujuan jangka panjang sesi (banner, selalu diingat model) |
| 🗒 Plan | mode rencana: hanya menyusun langkah, tidak mengubah apa pun |
| 💬 Feedback | rating ★ + catatan, tersimpan lokal |

| Commands | Fungsi |
|---|---|
| ◐ Compact | ringkas riwayat lama agar context hemat |
| 🛡 Permission | Read Only / Workspace Write / Full access |
| 🧠 Model | pilih model (dropdown dari API provider) |
| ⬇ Export | simpan log sesi (Markdown/JSON/ZIP) |
| ▸ Shell command | jalankan perintah tanpa AI |

## ⚡ Token Saver (v0.2.6)

Menu sidebar **⚡ Token Saver** — fitur hemat token yang bisa dinyalakan/dimatikan:

| Fitur | Efek |
|---|---|
| **Compress tool output** (RTK) | hasil tool diringkas sebelum dikirim ke model (UI tetap lengkap) |
| **Compress LLM output** (Caveman) | model menjawab gaya telegrafis, token output hemat |
| **Lazy senior dev** (Ponytail) | bias solusi minimal: YAGNI, reuse library, hapus > menambah |

## 🚦 Anti putar-putar (v0.2.8)

Dari log sesi nyata: 98× `exec` (76 perintah unik, 22 error sintaks, 0× `file_move`) — bot memeriksa
terus tanpa pernah mengubah apa pun. Perbaikan:

- **Perintah baca tidak dihitung kemajuan**: `dir`, `Get-ChildItem`, `tree`, `echo`, `whoami`, dst.
  dihitung sebagai "memeriksa". Kalau 8× tanpa aksi → diingatkan, 11× → peringatan keras,
  14× → tool dimatikan dan model wajib menyimpulkan.
- **Dedupe perintah setara**: `dir /b C:\` = `dir C:\ /b` = `cmd /c "dir C:\ /b"` =
  `powershell -Command Get-ChildItem C:\` → variasi penulisan tidak lagi dieksekusi ulang.
- **Path sistem dilindungi**: `C:\Windows`, `C:\Program Files`, `C:\ProgramData`, `AppData`,
  `Recovery`, `System Volume Information` tidak bisa dipindah/dihapus otomatis — muncul alasan jelas.
- **Tombol Stop benar-benar menghentikan** perintah yang sedang berjalan (kill process tree,
  tidak menunggu timeout 120 detik).
- **Indikator langkah**: "Thinking… (langkah 7)" supaya terlihat progresnya.
- **Aturan prompt baru**: dilarang `exec dir` untuk daftar file, dilarang `Get-ChildItem -Recurse C:\`,
  wajib pakai `file_list` + `file_move` per folder.

## Tempel screenshot

Tekan **Ctrl+V** di kotak pesan untuk melampirkan screenshot dari clipboard
(Win+Shift+S → Ctrl+V). Bisa juga **＋ → Tempel gambar**, **Ctrl+U**, atau **＋ → File**.
Gambar otomatis diperkecil bila terlalu besar (maks 1600 px / 3 MB).