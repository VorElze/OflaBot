using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("OflaBot Setup")]
[assembly: AssemblyProduct("OflaBot")]
[assembly: AssemblyCompany("OflaBot")]
[assembly: AssemblyDescription("Installer OflaBot")]
[assembly: AssemblyVersion("0.3.0.0")]
[assembly: AssemblyFileVersion("0.3.0.0")]

// OflaBot - installer (single-file, payload ter-embed).
// Fitur: pilih folder instalasi, shortcut Desktop + Start Menu (dengan fallback
// PowerShell), uninstaller lengkap (folder + cache + registry + shortcut).
static class Setup
{
    const string AppName = "OflaBot";
    const string AppExe = "OflaBot.exe";          // launcher (aman SmartScreen)
    const string CoreExe = "OflaBot-core.exe";    // binary Electron
    const string Publisher = "OflaBot";
    const string Version = "0.3.0";
    const string UninstKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\OflaBot";
    const string AppArgs = "--no-sandbox";

    static string DefaultInstallDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName); }
    }

    static string ActiveLog = Path.Combine(Path.GetTempPath(), "oflabot-install.log");
    static string ScriptDir = Path.GetTempPath();

    static string LogPath(string dir)
    {
        try { return Path.Combine(dir, "install-log.txt"); } catch { return Path.Combine(Path.GetTempPath(), "oflabot-install.log"); }
    }

    static void Log(string file, string text)
    {
        try { File.AppendAllText(file, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + text + Environment.NewLine); } catch { }
    }

    [STAThread]
    static void Main(string[] args)
    {
        bool silent = HasArg(args, "/S") || HasArg(args, "-s") || HasArg(args, "--silent");
        bool uninstall = HasArg(args, "/uninstall") || HasArg(args, "--uninstall");

        if (uninstall) { Uninstall(silent); return; }

        string target = DefaultInstallDir;
        foreach (string a in args)
        {
            if (a.StartsWith("/D=")) target = a.Substring(3).Trim('"');
            if (a.StartsWith("--dir=")) target = a.Substring(6).Trim('"');
        }

        if (silent)
        {
            try { RunInstall(target, null); Environment.Exit(0); }
            catch (Exception ex)
            {
                try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "oflabot-install-error.log"), ex.ToString()); } catch { }
                Environment.Exit(1);
            }
        }
        else RunGui(target);
    }

    static bool HasArg(string[] args, string name)
    {
        foreach (string a in args) if (string.Equals(a, name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    // ---------------- GUI ----------------
    static void RunGui(string target)
    {
        Application.EnableVisualStyles();
        var form = new Form();
        form.Text = AppName + " - Instalasi";
        form.ClientSize = new Size(600, 300);
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.MaximizeBox = false;
        form.MinimizeBox = false;
        form.BackColor = Color.FromArgb(24, 26, 32);
        form.ForeColor = Color.White;

        var title = new Label();
        title.Text = AppName + " " + Version;
        title.Font = new Font("Segoe UI", 14F, FontStyle.Bold);
        title.ForeColor = Color.White;
        title.SetBounds(22, 16, 540, 30);

        var lblFolder = new Label();
        lblFolder.Text = "Folder instalasi";
        lblFolder.Font = new Font("Segoe UI", 9F);
        lblFolder.ForeColor = Color.FromArgb(160, 168, 180);
        lblFolder.SetBounds(24, 56, 200, 18);

        var txtFolder = new TextBox();
        txtFolder.Text = target;
        txtFolder.SetBounds(24, 76, 440, 26);
        txtFolder.BackColor = Color.FromArgb(16, 18, 24);
        txtFolder.ForeColor = Color.White;
        txtFolder.BorderStyle = BorderStyle.FixedSingle;

        var btnPick = new Button();
        btnPick.Text = "Pilih…";
        btnPick.SetBounds(472, 75, 100, 28);
        btnPick.BackColor = Color.FromArgb(40, 44, 56);
        btnPick.ForeColor = Color.White;
        btnPick.FlatStyle = FlatStyle.Flat;
        btnPick.Click += delegate
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Pilih folder untuk memasang " + AppName;
                try { if (Directory.Exists(txtFolder.Text)) dlg.SelectedPath = txtFolder.Text; } catch { }
                if (dlg.ShowDialog(form) == DialogResult.OK && !string.IsNullOrEmpty(dlg.SelectedPath))
                {
                    txtFolder.Text = Path.Combine(dlg.SelectedPath, AppName);
                }
            }
        };

        var status = new Label();
        status.Text = "Klik Pasang untuk mulai.";
        status.Font = new Font("Segoe UI", 9F);
        status.ForeColor = Color.FromArgb(200, 205, 215);
        status.SetBounds(24, 116, 548, 40);

        var bar = new ProgressBar();
        bar.SetBounds(24, 162, 548, 16);
        bar.Style = ProgressBarStyle.Continuous;

        var btn = new Button();
        btn.Text = "Pasang";
        btn.SetBounds(466, 200, 106, 34);
        btn.BackColor = Color.FromArgb(43, 92, 255);
        btn.ForeColor = Color.White;
        btn.FlatStyle = FlatStyle.Flat;

        var btnCancel = new Button();
        btnCancel.Text = "Batal";
        btnCancel.SetBounds(352, 200, 106, 34);
        btnCancel.BackColor = Color.FromArgb(40, 44, 56);
        btnCancel.ForeColor = Color.White;
        btnCancel.FlatStyle = FlatStyle.Flat;
        btnCancel.Click += delegate { form.Close(); };

        bool installed = false;
        string installedTo = target;

        btn.Click += delegate
        {
            if (installed) { LaunchApp(installedTo); Application.Exit(); return; }
            string chosen = (txtFolder.Text ?? "").Trim();
            if (string.IsNullOrEmpty(chosen)) { MessageBox.Show("Folder instalasi belum dipilih.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            chosen = Path.GetFullPath(chosen);

            btn.Enabled = false;
            btnPick.Enabled = false;
            txtFolder.Enabled = false;
            status.Text = "Memasang ke: " + chosen;
            var t = new Thread(delegate()
            {
                try
                {
                    RunInstall(chosen, delegate(int pct, string msg)
                    {
                        form.BeginInvoke((Action)delegate
                        {
                            bar.Value = Math.Max(0, Math.Min(100, pct));
                            status.Text = msg;
                        });
                    });
                    installedTo = chosen;
                    form.BeginInvoke((Action)delegate
                    {
                        installed = true;
                        bar.Value = 100;
                        btn.Enabled = true;
                        btn.Text = "Jalankan";
                        status.Text = "Selesai dipasang di: " + chosen + Environment.NewLine + "Shortcut OflaBot dibuat di Desktop dan Start Menu.";
                    });
                }
                catch (Exception ex)
                {
                    form.BeginInvoke((Action)delegate
                    {
                        status.Text = "Instalasi gagal.";
                        MessageBox.Show(
                            "Instalasi gagal: " + ex.Message + Environment.NewLine + Environment.NewLine +
                            "Pilih folder lain (mis. di D:\\OflaBot) atau jalankan installer sebagai Administrator.",
                            AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                        btn.Enabled = true;
                        btnPick.Enabled = true;
                        txtFolder.Enabled = true;
                    });
                }
            });
            t.IsBackground = true;
            t.Start();
        };

        form.Controls.Add(title);
        form.Controls.Add(lblFolder);
        form.Controls.Add(txtFolder);
        form.Controls.Add(btnPick);
        form.Controls.Add(status);
        form.Controls.Add(bar);
        form.Controls.Add(btnCancel);
        form.Controls.Add(btn);
        Application.Run(form);
    }

    // ---------------- install ----------------
    /// <summary>Pastikan folder tujuan bisa ditulis. Gagal = exception (tanpa fallback diam-diam).</summary>
    static void EnsureWritable(string dir)
    {
        Directory.CreateDirectory(dir);
        string probe = Path.Combine(dir, ".oflabot-write-test");
        File.WriteAllText(probe, "ok");
        File.Delete(probe);
    }

    static void RunInstall(string target, Action<int, string> progress)
    {
        if (string.IsNullOrEmpty(target)) throw new InvalidOperationException("Folder instalasi kosong.");
        target = Path.GetFullPath(target);
        string log = LogPath(target);

        if (progress != null) progress(1, "Menyiapkan folder: " + target);
        string parent = Path.GetDirectoryName(target);
        if (!string.IsNullOrEmpty(parent)) { try { Directory.CreateDirectory(parent); } catch { } }
        EnsureWritable(target);
        try { File.Delete(log); } catch { }
        ActiveLog = log;
        ScriptDir = target;
        Log(log, "install ke " + target);

        // 1. Ekstrak payload.
        Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
        if (payload == null) throw new InvalidOperationException("payload.zip tidak ditemukan di installer.");

        if (progress != null) progress(5, "Mengekstrak aplikasi…");
        using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
        {
            long total = 0;
            foreach (var e in zip.Entries) total += e.Length;
            long done = 0;
            foreach (var e in zip.Entries)
            {
                string dest = Path.Combine(target, e.FullName.Replace('/', Path.DirectorySeparatorChar));
                if (string.IsNullOrEmpty(e.Name)) { Directory.CreateDirectory(dest); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                e.ExtractToFile(dest, true);
                done += e.Length;
                if (progress != null && total > 0) progress(5 + (int)(80.0 * done / total), "Mengekstrak aplikasi… " + (done / 1048576) + " MB");
            }
        }
        if (!File.Exists(Path.Combine(target, CoreExe)) && !File.Exists(Path.Combine(target, AppExe)))
            throw new InvalidOperationException("Aplikasi tidak ditemukan setelah ekstrak (payload rusak).");
        Log(log, "ekstrak selesai");

        string appPath = Path.Combine(target, AppExe);

        // 2. Launcher aman SmartScreen (wscript -> vbs -> CreateProcess/Win32_Process).
        if (progress != null) progress(88, "Menyiapkan launcher…");
        string vbsPath = Path.Combine(target, "launch.vbs");
        try
        {
            string[] lines = new string[] {
                "' " + AppName + " - launcher",
                "' Menjalankan exe via Win32_Process.Create (CreateProcess), bukan shell,",
                "' supaya tidak terkena dialog SmartScreen \"Windows protected your PC\".",
                "Dim fso, wmi, proc, exePath, workDir, cmd",
                "Set fso = CreateObject(\"Scripting.FileSystemObject\")",
                "Set wmi = GetObject(\"winmgmts:\\\\.\\root\\cimv2\")",
                "Set proc = wmi.Get(\"Win32_Process\")",
                "workDir = fso.GetParentFolderName(WScript.ScriptFullName)",
                "exePath = workDir & \"\\" + AppExe + "\"",
                "cmd = \"\"\"\" & exePath & \"\"\" " + AppArgs + "\"",
                "proc.Create cmd, workDir, Null",
            };
            File.WriteAllText(vbsPath, string.Join("\r\n", lines) + "\r\n");
        }
        catch { }
        try
        {
            File.WriteAllText(Path.Combine(target, "Jalankan " + AppName + ".bat"),
                "@echo off\r\nset \"ELECTRON_RUN_AS_NODE=\"\r\nstart \"\" \"%~dp0" + AppExe + "\" " + AppArgs + "\r\n");
        }
        catch { }

        // 3. Uninstaller batch (bisa berjalan walau folder sedang dipakai).
        string uninstaller = Path.Combine(target, "uninstall.cmd");
        try { File.WriteAllText(uninstaller, BuildUninstallCmd(), System.Text.Encoding.Default); } catch { }

        // 4. Shortcut Desktop + Start Menu (PowerShell WScript.Shell; fallback COM langsung).
        if (progress != null) progress(92, "Membuat shortcut…");
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        string menuDir = Path.Combine(programs, AppName);
        try { Directory.CreateDirectory(menuDir); } catch { }

        string lnkTarget = File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "wscript.exe"))
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "wscript.exe")
            : appPath;
        string lnkArgs = lnkTarget.ToLower().EndsWith("wscript.exe") ? "\"" + vbsPath + "\"" : AppArgs;

        bool okDesktop = CreateShortcutRobust(Path.Combine(desktop, AppName + ".lnk"), lnkTarget, target, lnkArgs, appPath);
        bool okMenu = CreateShortcutRobust(Path.Combine(menuDir, AppName + ".lnk"), lnkTarget, target, lnkArgs, appPath);
        CreateShortcutRobust(Path.Combine(menuDir, "Uninstall " + AppName + ".lnk"), "cmd.exe", target, "/c \"\"" + uninstaller + "\"\"", uninstaller);
        Log(log, "shortcut desktop=" + okDesktop + " startmenu=" + okMenu + " target=" + lnkTarget);

        // 5. Registri Programs & Features.
        try
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstKey))
            {
                if (k != null)
                {
                    k.SetValue("DisplayName", AppName);
                    k.SetValue("DisplayVersion", Version);
                    k.SetValue("Publisher", Publisher);
                    k.SetValue("DisplayIcon", appPath);
                    k.SetValue("InstallLocation", target);
                    k.SetValue("UninstallString", "cmd.exe /c \"\"" + uninstaller + "\"\"");
                    k.SetValue("QuietUninstallString", "cmd.exe /c \"\"" + uninstaller + "\"\"");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    k.SetValue("EstimatedSize", 400000, RegistryValueKind.DWord);
                }
            }
        }
        catch { }

        Log(log, "selesai");
        if (progress != null) progress(100, "Selesai: " + target);
    }

    static string BuildUninstallCmd()
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("@echo off");
        sb.AppendLine("setlocal enableextensions");
        sb.AppendLine("if /i \"%~1\"==\"--clean\" goto :clean");
        sb.AppendLine("set \"APPDIR=%~dp0\"");
        sb.AppendLine("if \"%APPDIR:~-1%\"==\"\\\" set \"APPDIR=%APPDIR:~0,-1%\"");
        sb.AppendLine("echo Menghapus " + AppName + "...");
        sb.AppendLine("taskkill /f /im \"" + CoreExe + "\" >nul 2>&1");
        sb.AppendLine("taskkill /f /im \"" + AppExe + "\" >nul 2>&1");
        sb.AppendLine("ping 127.0.0.1 -n 3 >nul");
        sb.AppendLine("del /f /q \"%USERPROFILE%\\Desktop\\" + AppName + ".lnk\" >nul 2>&1");
        sb.AppendLine("del /f /q \"%PUBLIC%\\Desktop\\" + AppName + ".lnk\" >nul 2>&1");
        sb.AppendLine("del /f /q \"%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\" + AppName + "\\" + AppName + ".lnk\" >nul 2>&1");
        sb.AppendLine("del /f /q \"%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\" + AppName + "\\Uninstall " + AppName + ".lnk\" >nul 2>&1");
        sb.AppendLine("rmdir /s /q \"%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\" + AppName + "\" >nul 2>&1");
        sb.AppendLine("reg delete \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OflaBot\" /f >nul 2>&1");
        sb.AppendLine("reg delete \"HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OflaBot\" /f >nul 2>&1");
        // cache / profil / konfigurasi
        sb.AppendLine("rmdir /s /q \"%APPDATA%\\OflaBot\" >nul 2>&1");
        sb.AppendLine("rmdir /s /q \"%APPDATA%\\grokbot-desktop\" >nul 2>&1");
        sb.AppendLine("rmdir /s /q \"%APPDATA%\\GrokBot Desktop Agent\" >nul 2>&1");
        sb.AppendLine("rmdir /s /q \"%LOCALAPPDATA%\\OflaBot\" >nul 2>&1");
        sb.AppendLine("del /f /q \"%LOCALAPPDATA%\\Temp\\oflabot-*\" >nul 2>&1");
        sb.AppendLine("copy /y \"%~f0\" \"%TEMP%\\oflabot-uninstall-run.cmd\" >nul 2>&1");
        sb.AppendLine("start \"\" /min cmd /c \"\"%TEMP%\\oflabot-uninstall-run.cmd\" --clean \"%APPDIR%\"\"");
        sb.AppendLine("exit /b 0");
        sb.AppendLine(":clean");
        sb.AppendLine("ping 127.0.0.1 -n 3 >nul");
        sb.AppendLine("for /l %%i in (1,1,30) do (");
        sb.AppendLine("  if not exist \"%~2\" goto :done");
        sb.AppendLine("  rd /s /q \"%~2\" >nul 2>&1");
        sb.AppendLine("  if not exist \"%~2\" goto :done");
        sb.AppendLine("  ping 127.0.0.1 -n 2 >nul");
        sb.AppendLine(")");
        sb.AppendLine(":done");
        sb.AppendLine("del /f /q \"%~f0\" >nul 2>&1");
        sb.AppendLine("exit /b 0");
        return sb.ToString();
    }

    /// <summary>Buat shortcut: coba COM langsung, lalu PowerShell (file .ps1), lalu .url fallback.</summary>
    static bool CreateShortcutRobust(string lnkPath, string targetPath, string workDir, string args, string iconPath)
    {
        Log(ActiveLog, "shortcut com -> " + lnkPath);
        if (CreateShortcutCom(lnkPath, targetPath, workDir, args, iconPath)) return true;

        // PowerShell lewat file .ps1 (lebih andal daripada -Command karena kutip tidak
        // di-mangle oleh parsing argumen Windows).
        try
        {
            string script = Path.Combine(ScriptDir, "oflabot-mkshortcut.ps1");
            var sb = new StringBuilder();
            sb.AppendLine("$ErrorActionPreference = 'Stop'");
            sb.AppendLine("$ws = New-Object -ComObject WScript.Shell");
            sb.AppendLine("$s = $ws.CreateShortcut('" + Esc(lnkPath) + "')");
            sb.AppendLine("$s.TargetPath = '" + Esc(targetPath) + "'");
            sb.AppendLine("$s.WorkingDirectory = '" + Esc(workDir) + "'");
            sb.AppendLine("$s.IconLocation = '" + Esc(iconPath) + ",0'");
            if (!string.IsNullOrEmpty(args)) sb.AppendLine("$s.Arguments = '" + Esc(args) + "'");
            sb.AppendLine("$s.Save()");
            Log(ActiveLog, "tulis script shortcut: " + script);
            File.WriteAllText(script, sb.ToString(), System.Text.Encoding.UTF8);
            Log(ActiveLog, "script ok: " + File.Exists(script));

            var psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            var p = Process.Start(psi);
            string psErr = "", psOut = "";
            if (p != null)
            {
                psOut = p.StandardOutput.ReadToEnd();
                psErr = p.StandardError.ReadToEnd();
                p.WaitForExit(20000);
            }
            Log(ActiveLog, "shortcut ps exit=" + (p != null ? p.ExitCode : -1) + " lnk=" + File.Exists(lnkPath) + " out=" + psOut.Trim() + " err=" + psErr.Trim().Replace(Environment.NewLine, " | "));
            try { File.Delete(script); } catch { }
            if (File.Exists(lnkPath)) return true;
        }
        catch { }

        // fallback terakhir: file .url (masih bisa diklik user)
        try
        {
            File.WriteAllText(Path.ChangeExtension(lnkPath, ".url"),
                "[InternetShortcut]" + Environment.NewLine + "URL=file:///" + targetPath + Environment.NewLine + "IconFile=" + iconPath + Environment.NewLine);
        }
        catch { }
        return false;
    }

    static string Esc(string s)
    {
        return (s ?? "").Replace("'", "''");
    }

    static bool CreateShortcutCom(string lnkPath, string targetPath, string workDir, string args, string iconPath)
    {
        try
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) return false;
            object shell = Activator.CreateInstance(t);
            object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type sct = sc.GetType();
            sct.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { targetPath });
            sct.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
            sct.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { iconPath });
            if (!string.IsNullOrEmpty(args)) sct.InvokeMember("Arguments", BindingFlags.SetProperty, null, sc, new object[] { args });
            sct.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
            return File.Exists(lnkPath);
        }
        catch { return false; }
    }

    static string ReadInstallLocation()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(UninstKey))
            {
                if (k == null) return null;
                object v = k.GetValue("InstallLocation");
                return v == null ? null : v.ToString();
            }
        }
        catch { return null; }
    }

    static void LaunchApp(string target)
    {
        try
        {
            string vbs = Path.Combine(target, "launch.vbs");
            if (File.Exists(vbs)) Process.Start("wscript.exe", "\"" + vbs + "\"");
            else Process.Start(Path.Combine(target, AppExe), AppArgs);
        }
        catch { }
    }

    // ---------------- uninstall ----------------
    static void KillRunningApp()
    {
        foreach (string image in new string[] { CoreExe, AppExe })
        {
            try
            {
                var psi = new ProcessStartInfo("taskkill.exe", "/F /T /IM \"" + image + "\"")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                var p = Process.Start(psi);
                if (p != null) p.WaitForExit(8000);
            }
            catch { }
        }
        Thread.Sleep(1200);
    }

    static void TryDeleteFile(string path, int attempts = 6)
    {
        for (int i = 0; i < attempts; i++)
        {
            try { if (File.Exists(path)) File.Delete(path); return; }
            catch { Thread.Sleep(300); }
        }
    }

    static void TryDeleteDir(string path, int attempts = 6)
    {
        for (int i = 0; i < attempts; i++)
        {
            try { if (Directory.Exists(path)) Directory.Delete(path, true); return; }
            catch { Thread.Sleep(300); }
        }
    }

    static void Uninstall(bool silent)
    {
        string self = Assembly.GetExecutingAssembly().Location;
        string target = Path.GetDirectoryName(self);
        if (!File.Exists(Path.Combine(target, CoreExe)) && !File.Exists(Path.Combine(target, AppExe)))
        {
            string reg = ReadInstallLocation();
            target = !string.IsNullOrEmpty(reg) ? reg : DefaultInstallDir;
        }

        KillRunningApp();

        // Shortcut (user + publik) + Start Menu.
        foreach (string desk in new string[] {
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory) })
        {
            if (string.IsNullOrEmpty(desk)) continue;
            TryDeleteFile(Path.Combine(desk, AppName + ".lnk"));
        }
        foreach (string prog in new string[] {
            Environment.GetFolderPath(Environment.SpecialFolder.Programs),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms) })
        {
            if (string.IsNullOrEmpty(prog)) continue;
            TryDeleteDir(Path.Combine(prog, AppName));
            TryDeleteFile(Path.Combine(prog, AppName + ".lnk"));
        }

        // Registry.
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstKey, false); } catch { }
        try { Registry.LocalMachine.DeleteSubKeyTree(UninstKey, false); } catch { }

        // Cache / profil aplikasi (termasuk profil versi lama GrokBot).
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        foreach (string dir in new string[] {
            Path.Combine(appData, AppName),
            Path.Combine(appData, "grokbot-desktop"),
            Path.Combine(appData, "GrokBot Desktop Agent"),
            Path.Combine(localAppData, AppName) })
        {
            TryDeleteDir(dir);
        }

        // Isi folder instalasi (kecuali diri sendiri).
        try
        {
            foreach (string dir in Directory.GetDirectories(target)) TryDeleteDir(dir);
            foreach (string file in Directory.GetFiles(target))
            {
                if (string.Equals(Path.GetFullPath(file), Path.GetFullPath(self), StringComparison.OrdinalIgnoreCase)) continue;
                TryDeleteFile(file);
            }
        }
        catch { }

        // Sisa folder + diri sendiri dihapus setelah proses keluar.
        string cmd =
            "/c ping 127.0.0.1 -n 3 >nul & " +
            "(for /l %i in (1,1,20) do (del /f /q \"" + self + "\" >nul 2>&1 & " +
            "rmdir /s /q \"" + target + "\" >nul 2>&1 & " +
            "if not exist \"" + target + "\" exit /b 0 & ping 127.0.0.1 -n 2 >nul))";
        try
        {
            Process.Start(new ProcessStartInfo("cmd.exe", cmd)
            {
                WindowStyle = ProcessWindowStyle.Hidden,
                CreateNoWindow = true,
                UseShellExecute = false,
            });
        }
        catch { }

        if (!silent)
            MessageBox.Show(AppName + " telah dihapus." + Environment.NewLine + target, AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}
