using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("OflaBot")]
[assembly: AssemblyProduct("OflaBot")]
[assembly: AssemblyCompany("OflaBot")]
[assembly: AssemblyDescription("OflaBot launcher")]
[assembly: AssemblyVersion("0.2.8.0")]
[assembly: AssemblyFileVersion("0.2.8.0")]

// Launcher tipis: menjalankan OflaBot-core.exe (Electron) dengan argumen wajib
// sehingga user bisa double-click OflaBot.exe langsung tanpa .bat / flag manual.
static class Launcher
{
    const string CoreExe = "OflaBot-core.exe";
    const string FallbackExe = "OflaBot.exe";

    [STAThread]
    static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string core = Path.Combine(dir, CoreExe);
        if (!File.Exists(core)) core = Path.Combine(dir, FallbackExe);

        if (!File.Exists(core))
        {
            MessageBox.Show(
                "File aplikasi tidak ditemukan:" + Environment.NewLine + core + Environment.NewLine + Environment.NewLine +
                "Instalasi mungkin tidak lengkap. Jalankan installer OflaBot lagi.",
                "OflaBot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        bool hasNoSandbox = false;
        bool hasUserData = false;
        foreach (string a in args)
        {
            if (a == "--no-sandbox") hasNoSandbox = true;
            if (a.StartsWith("--user-data-dir")) hasUserData = true;
        }

        // Folder profil selalu di dalam folder aplikasi: dijamin bisa ditulis,
        // sehingga aplikasi tetap start walau %APPDATA% dibatasi/di-redirect.
        string userDataDir = Path.Combine(dir, "userdata");
        try { Directory.CreateDirectory(userDataDir); } catch { }

        var sb = new StringBuilder();
        foreach (string a in args) sb.Append(Quote(a)).Append(' ');
        if (!hasNoSandbox) sb.Append("--no-sandbox ");
        if (!hasUserData) sb.Append("--user-data-dir=").Append(Quote(userDataDir));

        var psi = new ProcessStartInfo(core, sb.ToString());
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        try
        {
            // Pastikan Electron tidak berjalan sebagai Node.
            if (psi.EnvironmentVariables.ContainsKey("ELECTRON_RUN_AS_NODE")) psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "";
        }
        catch { }

        try
        {
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show("Gagal menjalankan OflaBot: " + ex.Message, "OflaBot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static string Quote(string s)
    {
        if (string.IsNullOrEmpty(s)) return "\"\"";
        if (s.IndexOf(' ') < 0 && s.IndexOf('"') < 0 && s.IndexOf('\t') < 0) return s;
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}
