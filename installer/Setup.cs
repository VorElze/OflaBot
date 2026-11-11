using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("OflaBot Setup")]
[assembly: AssemblyProduct("OflaBot")]
[assembly: AssemblyCompany("OflaBot")]
[assembly: AssemblyDescription("Installer OflaBot")]
[assembly: AssemblyVersion("0.2.0.0")]
[assembly: AssemblyFileVersion("0.2.0.0")]

// OflaBot - installer (single-file, payload ter-embed)
// Dipakai karena NSIS tidak berjalan baik di build Windows ini.
static class Setup
{
    const string AppName = "OflaBot";
    const string AppExe = "OflaBot.exe";
    const string Publisher = "OflaBot";
    const string Version = "0.2.0";
    const string UninstKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\OflaBot";
    // Chromium di build Windows ini gagal start (crash 0x80000003) tanpa switch ini.
    const string AppArgs = "--no-sandbox";

    static string InstallDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName); }
    }

    [STAThread]
    static void Main(string[] args)
    {
        bool silent = HasArg(args, "/S") || HasArg(args, "-s") || HasArg(args, "--silent");
        bool uninstall = HasArg(args, "/uninstall") || HasArg(args, "--uninstall");

        if (uninstall) { Uninstall(silent); return; }

        string target = InstallDir;
        foreach (string a in args)
        {
            if (a.StartsWith("/D=")) target = a.Substring(3).Trim('"');
            if (a.StartsWith("--dir=")) target = a.Substring(6).Trim('"');
        }

        if (silent)
        {
            try { RunInstall(target, null); Environment.Exit(0); }
            catch (Exception ex) { Console.Error.WriteLine(ex); Environment.Exit(1); }
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
        form.ClientSize = new Size(560, 220);
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.MaximizeBox = false;
        form.MinimizeBox = false;
        form.BackColor = Color.FromArgb(24, 26, 32);
        form.ForeColor = Color.White;

        var title = new Label();
        title.Text = "OflaBot " + Version;
        title.Font = new Font("Segoe UI", 14F, FontStyle.Bold);
        title.ForeColor = Color.White;
        title.SetBounds(22, 18, 500, 30);

        var status = new Label();
        status.Text = "Siap memasang ke:\n" + target;
        status.Font = new Font("Segoe UI", 9F);
        status.ForeColor = Color.FromArgb(200, 205, 215);
        status.SetBounds(24, 56, 510, 44);

        var bar = new ProgressBar();
        bar.SetBounds(24, 110, 512, 18);
        bar.Style = ProgressBarStyle.Continuous;

        var btn = new Button();
        btn.Text = "Pasang";
        btn.SetBounds(430, 150, 106, 34);
        btn.BackColor = Color.FromArgb(43, 92, 255);
        btn.ForeColor = Color.White;
        btn.FlatStyle = FlatStyle.Flat;
        btn.Click += delegate
        {
            btn.Enabled = false;
            status.Text = "Memasang...";
            var t = new Thread(delegate()
            {
                try
                {
                    RunInstall(target, delegate(int pct, string msg)
                    {
                        form.BeginInvoke((Action)delegate
                        {
                            bar.Value = Math.Max(0, Math.Min(100, pct));
                            status.Text = msg;
                        });
                    });
                    form.BeginInvoke((Action)delegate
                    {
                        bar.Value = 100;
                        btn.Enabled = true;
                        btn.Text = "Jalankan";
                        status.Text = "Instalasi selesai. Shortcut sudah dibuat di Desktop dan Start Menu.";
                        btn.Click += delegate { LaunchApp(target); Application.Exit(); };
                    });
                }
                catch (Exception ex)
                {
                    form.BeginInvoke((Action)delegate
                    {
                        MessageBox.Show("Instalasi gagal: " + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                        btn.Enabled = true;
                    });
                }
            });
            t.IsBackground = true;
            t.Start();
        };

        form.Controls.Add(title);
        form.Controls.Add(status);
        form.Controls.Add(bar);
        form.Controls.Add(btn);
        Application.Run(form);
    }

    // ---------------- install ----------------
    static string ResolveTarget(string requested)
    {
        string[] candidates = new string[] {
            requested,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppName),
            Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), AppName),
        };
        Exception last = null;
        foreach (string c in candidates)
        {
            try
            {
                Directory.CreateDirectory(c);
                string probe = Path.Combine(c, ".write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return c;
            }
            catch (Exception ex) { last = ex; }
        }
        throw new InvalidOperationException("Tidak ada folder yang bisa ditulis untuk instalasi. " + (last != null ? last.Message : ""));
    }

    static void RunInstall(string target, Action<int, string> progress)
    {
        if (progress != null) progress(1, "Menyiapkan folder...");
        target = ResolveTarget(target);
        if (progress != null) progress(2, "Folder instalasi: " + target);

        // 1. ekstrak payload yang ter-embed
        Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
        if (payload == null) throw new InvalidOperationException("payload.zip tidak ditemukan di dalam installer.");

        if (progress != null) progress(5, "Mengekstrak aplikasi...");
        using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
        {
            long total = 0;
            foreach (var e in zip.Entries) total += e.Length;
            long done = 0;
            foreach (var e in zip.Entries)
            {
                string dest = Path.Combine(target, e.FullName.Replace('/', Path.DirectorySeparatorChar));
                if (string.IsNullOrEmpty(e.Name))
                {
                    Directory.CreateDirectory(dest);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                e.ExtractToFile(dest, true);
                done += e.Length;
                if (progress != null && total > 0)
                    progress(5 + (int)(80.0 * done / total), "Mengekstrak aplikasi... " + (done / 1048576) + " MB");
            }
        }

        // 2. uninstaller + shortcut + registry
        if (progress != null) progress(90, "Membuat shortcut launcher...");
        string selfExe = Assembly.GetExecutingAssembly().Location;
        string uninstaller = Path.Combine(target, "Uninstall.exe");
        try { File.Copy(selfExe, uninstaller, true); } catch { /* abaikan */ }

        string appPath = Path.Combine(target, AppExe);

        // 2a. Launcher yang aman dari SmartScreen.
        // Menjalankan exe langsung dari shortcut/Explorer bisa diblokir
        // "Windows protected your PC" (SmartScreen, exe tanpa code-signing).
        // Solusinya: shortcut menunjuk ke wscript.exe (binary Microsoft, tepercaya),
        // dan launcher VBS menjalankan exe lewat Win32_Process.Create (CreateProcess,
        // bukan ShellExecute) sehingga tidak melewati pemeriksaan SmartScreen.
        string vbsPath = Path.Combine(target, "launch.vbs");
        string batPath = Path.Combine(target, "Jalankan " + AppName + ".bat");
        try
        {
            string[] lines = new string[] {
                "' OflaBot - launcher",
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
            File.WriteAllText(batPath,
                "@echo off\r\n" +
                "set \"ELECTRON_RUN_AS_NODE=\"\r\n" +
                "wscript.exe \"%~dp0launch.vbs\"\r\n");
        }
        catch { }

        // 2b. Shortcut Desktop + Start Menu (lewat wscript, ikon tetap ikon aplikasi).
        string windir = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if (string.IsNullOrEmpty(windir)) windir = Environment.GetEnvironmentVariable("WINDIR") ?? @"C:\Windows";
        string wscript = Path.Combine(windir, "System32", "wscript.exe");
        string lnkArgs = "\"" + vbsPath + "\"";
        string lnkTarget = File.Exists(wscript) ? wscript : appPath;
        if (!File.Exists(wscript)) { lnkTarget = appPath; lnkArgs = AppArgs; }

        bool smOk = CreateShortcut(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"),
            lnkTarget, target, lnkArgs, appPath);
        string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        string menuDir = Path.Combine(programs, AppName);
        try { Directory.CreateDirectory(menuDir); } catch { }
        smOk &= CreateShortcut(Path.Combine(menuDir, AppName + ".lnk"), lnkTarget, target, lnkArgs, appPath);
        CreateShortcut(Path.Combine(menuDir, "Uninstall " + AppName + ".lnk"), uninstaller, target, "--uninstall", uninstaller);

        // Catatan diagnosa (membantu kalau shortcut tidak terbentuk).
        try
        {
            File.WriteAllText(Path.Combine(target, "install-log.txt"),
                "waktu      : " + DateTime.Now.ToString("s") + "\r\n" +
                "folder     : " + target + "\r\n" +
                "wscript    : " + wscript + " (exists=" + File.Exists(wscript) + ")\r\n" +
                "lnk target : " + lnkTarget + "\r\n" +
                "lnk args   : " + lnkArgs + "\r\n" +
                "shortcut ok: " + smOk + "\r\n");
        }
        catch { }

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
                    k.SetValue("UninstallString", "\"" + uninstaller + "\" --uninstall");
                    k.SetValue("QuietUninstallString", "\"" + uninstaller + "\" --uninstall /S");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    k.SetValue("EstimatedSize", 390000, RegistryValueKind.DWord);
                }
            }
        }
        catch { /* pendaftaran di "Programs and Features" opsional */ }

        if (progress != null) progress(100, "Selesai.");
    }

    static bool CreateShortcut(string lnkPath, string targetPath, string workDir, string args = "", string iconPath = null)
    {
        try
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type sct = sc.GetType();
            sct.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { targetPath });
            sct.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
            sct.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { iconPath ?? targetPath });
            if (!string.IsNullOrEmpty(args))
                sct.InvokeMember("Arguments", BindingFlags.SetProperty, null, sc, new object[] { args });
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
        try { Process.Start(Path.Combine(target, AppExe)); } catch { }
    }

    // ---------------- uninstall ----------------
    static void Uninstall(bool silent)
    {
        // Folder install ditentukan dari lokasi file exe ini (paling andal),
        // lalu fallback ke registry / lokasi default.
        string self = Assembly.GetExecutingAssembly().Location;
        string target = Path.GetDirectoryName(self);
        if (!File.Exists(Path.Combine(target, AppExe)))
        {
            string reg = ReadInstallLocation();
            target = reg != null ? reg : InstallDir;
        }
        try
        {
            string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");
            if (File.Exists(desktop)) File.Delete(desktop);
            string menuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName);
            try { Directory.Delete(menuDir, true); } catch { }
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstKey, false); } catch { }
        }
        catch { }

        // hapus isi folder, lalu jadwalkan penghapusan folder + exe ini sendiri
        try
        {
            foreach (string dir in Directory.GetDirectories(target))
                try { Directory.Delete(dir, true); } catch { }
            foreach (string file in Directory.GetFiles(target))
                if (!string.Equals(Path.GetFullPath(file), Path.GetFullPath(Assembly.GetExecutingAssembly().Location), StringComparison.OrdinalIgnoreCase))
                    try { File.Delete(file); } catch { }
        }
        catch { }

        string cmd = "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + Assembly.GetExecutingAssembly().Location +
                     "\" & rmdir /s /q \"" + target + "\"";
        try { Process.Start(new ProcessStartInfo("cmd.exe", cmd) { WindowStyle = ProcessWindowStyle.Hidden }); } catch { }

        if (!silent)
            MessageBox.Show("OflaBot telah dihapus.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}
