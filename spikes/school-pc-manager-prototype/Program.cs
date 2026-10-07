using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace PcAgentPrototype;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length >= 1 && args[0] == "--self-test-child")
        {
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }

        if (args.Length >= 1 && args[0] == "--shutdown-self-test")
        {
            return ShutdownSmokeTest.Run();
        }

        if (args.Length >= 2 && args[0] == "--dummy-agent")
        {
            DummyAgent.RunAsync(args[1]).GetAwaiter().GetResult();
            return 0;
        }

        AppLogger.Write("Application starting");
        Application.ThreadException += (_, e) => AppLogger.Write($"UI UNHANDLED: {e.Exception}");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => AppLogger.Write($"UNHANDLED: {e.ExceptionObject}");

        try
        {
            Application.SetHighDpiMode(HighDpiMode.SystemAware);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
            AppLogger.Write("Application exited normally");
            return 0;
        }
        catch (Exception ex)
        {
            AppLogger.Write($"FATAL: {ex}");
            return 1;
        }
    }
}

internal sealed class MainForm : Form
{
    private const string SupabaseHealthUrl = "https://vtnwbgejlaqpnwmlzbjy.supabase.co/auth/v1/health";
    private const string OAuthReadonlyGatewayUrl = "https://vtnwbgejlaqpnwmlzbjy.supabase.co/functions/v1/kaito-pc-agent-oauth-readonly";

    private readonly Label _managerStatus = NewStatusLabel("Manager: Running");
    private readonly Label _supabaseStatus = NewStatusLabel("Supabase: 未確認");
    private readonly Label _gatewayStatus = NewStatusLabel("OAuth Gateway: 未確認");
    private readonly Label _agentStatus = NewStatusLabel("Dummy Agent: 停止中");
    private readonly Label _ipcStatus = NewStatusLabel("IPC: 未確認");
    private readonly Label _heartbeatStatus = NewStatusLabel("Heartbeat: 未確認");
    private readonly TextBox _log = new()
    {
        Multiline = true,
        ReadOnly = true,
        ScrollBars = ScrollBars.Vertical,
        Dock = DockStyle.Fill,
        BackColor = Color.FromArgb(18, 18, 18),
        ForeColor = Color.Gainsboro,
        BorderStyle = BorderStyle.FixedSingle
    };

    private Process? _dummyProcess;
    private NamedPipeServerStream? _dummyPipeServer;
    private CancellationTokenSource? _dummyPipeCts;
    private string _lastCloudResult = "未実行";
    private string _lastIpcResult = "未実行";
    private volatile bool _isClosing;

    public MainForm()
    {
        Text = "PC Agent - School PC Prototype";
        Width = 760;
        Height = 620;
        MinimumSize = new Size(680, 540);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(28, 28, 30);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10F);

        var title = new Label
        {
            Text = "PC Agent Prototype",
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 17F),
            ForeColor = Color.White,
            Margin = new Padding(0, 0, 0, 12)
        };

        var note = new Label
        {
            Text = "学校PC向けの安全な検証版です。PC操作・自動起動・レジストリ変更・通常ファイル編集は行いません。診断用ログのみ一時フォルダへ保存します。",
            AutoSize = true,
            MaximumSize = new Size(700, 0),
            ForeColor = Color.Silver,
            Margin = new Padding(0, 0, 0, 16)
        };

        var statusPanel = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
            Dock = DockStyle.Top,
            Margin = new Padding(0, 0, 0, 12)
        };
        statusPanel.Controls.AddRange(new Control[]
        {
            _managerStatus,
            _supabaseStatus,
            _gatewayStatus,
            _agentStatus,
            _ipcStatus,
            _heartbeatStatus
        });

        var cloudButton = NewButton("接続テスト");
        cloudButton.Click += async (_, _) => await RunCloudDiagnosticsAsync();

        var ipcButton = NewButton("IPC自己テスト");
        ipcButton.Click += async (_, _) => await RunNamedPipeSelfTestAsync();

        var startAgentButton = NewButton("Dummy Agent 起動");
        startAgentButton.Click += async (_, _) => await StartDummyAgentAsync();

        var stopAgentButton = NewButton("Dummy Agent 停止");
        stopAgentButton.Click += async (_, _) => await StopDummyAgentAsync();

        var copyButton = NewButton("診断結果をコピー");
        copyButton.Click += (_, _) => CopyDiagnostics();

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            WrapContents = true,
            Margin = new Padding(0, 0, 0, 12)
        };
        buttons.Controls.AddRange(new Control[]
        {
            cloudButton,
            ipcButton,
            startAgentButton,
            stopAgentButton,
            copyButton
        });

        var logLabel = new Label
        {
            Text = "ログ",
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 11F),
            Margin = new Padding(0, 6, 0, 6)
        };

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 6,
            Padding = new Padding(22)
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        root.Controls.Add(title, 0, 0);
        root.Controls.Add(note, 0, 1);
        root.Controls.Add(statusPanel, 0, 2);
        root.Controls.Add(buttons, 0, 3);
        root.Controls.Add(logLabel, 0, 4);
        root.Controls.Add(_log, 0, 5);
        Controls.Add(root);

        AppendLog($"起動: {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}");
        AppendLog($"OS: {RuntimeInformation.OSDescription}");
        AppendLog($"Architecture: {RuntimeInformation.OSArchitecture} / Process {RuntimeInformation.ProcessArchitecture}");
        AppendLog($".NET: {RuntimeInformation.FrameworkDescription}");
        AppendLog("診断ログを一時フォルダへ記録中");
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _isClosing = true;
        AppLogger.Write("Window closing: bounded synchronous cleanup start");

        // Do not call an async method synchronously here. WinForms has a UI SynchronizationContext;
        // blocking on an awaited continuation can deadlock the UI thread during shutdown.
        StopDummyAgentForShutdown();

        AppLogger.Write("Window closing: cleanup finished");
        base.OnFormClosing(e);
    }

    private async Task RunCloudDiagnosticsAsync()
    {
        SetStatus(_supabaseStatus, "Supabase: 接続中...");
        SetStatus(_gatewayStatus, "OAuth Gateway: 接続中...");
        AppendLog("Cloud診断開始");

        using var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false
        };
        using var client = new HttpClient(handler)
        {
            Timeout = TimeSpan.FromSeconds(10)
        };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("PcAgentSchoolPrototype/0.2");

        var report = new StringBuilder();

        try
        {
            using var health = await client.GetAsync(SupabaseHealthUrl);
            var ok = health.IsSuccessStatusCode;
            SetStatus(_supabaseStatus, ok
                ? $"Supabase: 到達 ({(int)health.StatusCode})"
                : $"Supabase: 応答あり ({(int)health.StatusCode})");
            report.AppendLine($"Supabase health: {(int)health.StatusCode} {health.StatusCode}");
            AppendLog($"Supabase health -> {(int)health.StatusCode} {health.StatusCode}");
        }
        catch (Exception ex)
        {
            SetStatus(_supabaseStatus, "Supabase: 接続失敗");
            report.AppendLine($"Supabase health: ERROR {ex.GetType().Name}: {ex.Message}");
            AppendLog($"Supabase health ERROR: {ex.Message}");
        }

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, OAuthReadonlyGatewayUrl);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
            request.Content = new StringContent(
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}",
                Encoding.UTF8,
                "application/json");

            using var response = await client.SendAsync(request);
            var code = (int)response.StatusCode;

            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                SetStatus(_gatewayStatus, $"OAuth Gateway: 到達・認証保護あり ({code})");
            }
            else if (response.IsSuccessStatusCode)
            {
                SetStatus(_gatewayStatus, $"OAuth Gateway: 到達 ({code}) ※未認証成功を要確認");
            }
            else
            {
                SetStatus(_gatewayStatus, $"OAuth Gateway: 応答あり ({code})");
            }

            report.AppendLine($"OAuth gateway: {code} {response.StatusCode}");
            if (response.Headers.WwwAuthenticate.Count > 0)
            {
                report.AppendLine("OAuth protection: WWW-Authenticate header present");
            }

            AppendLog($"OAuth gateway -> {code} {response.StatusCode}");
        }
        catch (Exception ex)
        {
            SetStatus(_gatewayStatus, "OAuth Gateway: 接続失敗");
            report.AppendLine($"OAuth gateway: ERROR {ex.GetType().Name}: {ex.Message}");
            AppendLog($"OAuth gateway ERROR: {ex.Message}");
        }

        _lastCloudResult = report.ToString().Trim();
        AppendLog("Cloud診断終了");
    }

    private async Task RunNamedPipeSelfTestAsync()
    {
        SetStatus(_ipcStatus, "IPC: テスト中...");
        var pipeName = $"PcAgentPrototypeSelfTest-{Guid.NewGuid():N}";
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        try
        {
            using var server = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

            var serverTask = Task.Run(async () =>
            {
                await server.WaitForConnectionAsync(cts.Token);
                using var reader = new StreamReader(server, Encoding.UTF8, false, 1024, leaveOpen: true);
                using var writer = new StreamWriter(server, Encoding.UTF8, 1024, leaveOpen: true) { AutoFlush = true };
                var message = await reader.ReadLineAsync(cts.Token);
                if (message != "PING")
                {
                    throw new InvalidOperationException($"Unexpected IPC message: {message}");
                }

                await writer.WriteLineAsync("PONG");
            }, cts.Token);

            using var client = new NamedPipeClientStream(
                ".",
                pipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous);

            await client.ConnectAsync(cts.Token);
            using var clientReader = new StreamReader(client, Encoding.UTF8, false, 1024, leaveOpen: true);
            using var clientWriter = new StreamWriter(client, Encoding.UTF8, 1024, leaveOpen: true) { AutoFlush = true };
            await clientWriter.WriteLineAsync("PING");
            var result = await clientReader.ReadLineAsync(cts.Token);
            await serverTask;

            if (result != "PONG")
            {
                throw new InvalidOperationException($"Unexpected IPC response: {result}");
            }

            SetStatus(_ipcStatus, "IPC: OK (CurrentUserOnly Named Pipe)");
            _lastIpcResult = "Named Pipe self-test: OK";
            AppendLog("IPC自己テスト -> OK");
        }
        catch (Exception ex)
        {
            SetStatus(_ipcStatus, "IPC: 失敗");
            _lastIpcResult = $"Named Pipe self-test: ERROR {ex.GetType().Name}: {ex.Message}";
            AppendLog($"IPC自己テスト ERROR: {ex.Message}");
        }
    }

    private async Task StartDummyAgentAsync()
    {
        if (_dummyProcess is { HasExited: false })
        {
            AppendLog("Dummy Agentは既に起動中");
            return;
        }

        await StopDummyAgentAsync();
        SetStatus(_agentStatus, "Dummy Agent: 起動中...");
        SetStatus(_heartbeatStatus, "Heartbeat: 待機中...");

        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable))
        {
            SetStatus(_agentStatus, "Dummy Agent: 起動失敗");
            AppendLog("Environment.ProcessPath が取得できませんでした");
            return;
        }

        var pipeName = $"PcAgentPrototypeAgent-{Guid.NewGuid():N}";
        _dummyPipeCts = new CancellationTokenSource();
        _dummyPipeServer = new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

        var psi = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = AppContext.BaseDirectory
        };
        psi.ArgumentList.Add("--dummy-agent");
        psi.ArgumentList.Add(pipeName);

        try
        {
            _dummyProcess = Process.Start(psi);
            if (_dummyProcess is null)
            {
                throw new InvalidOperationException("Process.Start returned null.");
            }

            _dummyProcess.EnableRaisingEvents = true;
            _dummyProcess.Exited += (_, _) => SafeUi(() =>
            {
                SetStatus(_agentStatus, "Dummy Agent: 停止");
                SetStatus(_heartbeatStatus, "Heartbeat: 停止");
                AppendLog("Dummy Agent process exited");
            });

            using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(_dummyPipeCts.Token);
            connectTimeout.CancelAfter(TimeSpan.FromSeconds(7));
            await _dummyPipeServer.WaitForConnectionAsync(connectTimeout.Token);

            SetStatus(_agentStatus, $"Dummy Agent: Running (PID {_dummyProcess.Id})");
            SetStatus(_ipcStatus, "IPC: Agent接続済み");
            AppendLog($"Dummy Agent起動 -> PID {_dummyProcess.Id}");
            _ = MonitorDummyAgentPipeAsync(_dummyPipeServer, _dummyPipeCts.Token);
        }
        catch (Exception ex)
        {
            SetStatus(_agentStatus, "Dummy Agent: 起動失敗");
            SetStatus(_heartbeatStatus, "Heartbeat: 失敗");
            AppendLog($"Dummy Agent起動 ERROR: {ex.Message}");
            await StopDummyAgentAsync();
        }
    }

    private async Task MonitorDummyAgentPipeAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
    {
        try
        {
            using var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, leaveOpen: true);
            while (!cancellationToken.IsCancellationRequested && pipe.IsConnected)
            {
                var line = await reader.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    break;
                }

                if (line.StartsWith("HELLO|", StringComparison.Ordinal))
                {
                    SafeUi(() => AppendLog($"Agent IPC: {line}"));
                }
                else if (line.StartsWith("HEARTBEAT|", StringComparison.Ordinal))
                {
                    var timestamp = line["HEARTBEAT|".Length..];
                    SafeUi(() => SetStatus(_heartbeatStatus, $"Heartbeat: OK {timestamp}"));
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Expected during stop.
        }
        catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested || _isClosing)
        {
            // Expected when the pipe is disposed during shutdown.
        }
        catch (Exception ex)
        {
            SafeUi(() =>
            {
                SetStatus(_heartbeatStatus, "Heartbeat: 失敗");
                AppendLog($"Heartbeat ERROR: {ex.Message}");
            });
            AppLogger.Write($"Heartbeat monitor ERROR: {ex}");
        }
    }

    private async Task StopDummyAgentAsync()
    {
        var cts = _dummyPipeCts;
        var pipe = _dummyPipeServer;
        var process = _dummyProcess;

        _dummyPipeCts = null;
        _dummyPipeServer = null;
        _dummyProcess = null;

        cts?.Cancel();

        try
        {
            pipe?.Dispose();
        }
        catch (Exception ex)
        {
            AppendLog($"Pipe停止 ERROR: {ex.Message}");
        }

        if (process is not null)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2));
                }
            }
            catch (TimeoutException)
            {
                AppendLog("Dummy Agent停止: 2秒以内に終了確認できませんでした");
            }
            catch (Exception ex)
            {
                AppendLog($"Dummy Agent停止 ERROR: {ex.Message}");
            }
            finally
            {
                process.Dispose();
            }
        }

        cts?.Dispose();
        SetStatus(_agentStatus, "Dummy Agent: 停止中");
        SetStatus(_heartbeatStatus, "Heartbeat: 停止");
    }

    private void StopDummyAgentForShutdown()
    {
        var cts = _dummyPipeCts;
        var pipe = _dummyPipeServer;
        var process = _dummyProcess;

        _dummyPipeCts = null;
        _dummyPipeServer = null;
        _dummyProcess = null;

        try
        {
            cts?.Cancel();
        }
        catch (Exception ex)
        {
            AppLogger.Write($"Shutdown cancel ERROR: {ex.Message}");
        }

        try
        {
            pipe?.Dispose();
        }
        catch (Exception ex)
        {
            AppLogger.Write($"Shutdown pipe dispose ERROR: {ex.Message}");
        }

        if (process is not null)
        {
            ProcessShutdown.TryTerminateProcessTree(
                process,
                TimeSpan.FromSeconds(1),
                message => AppLogger.Write($"Shutdown process: {message}"));
            process.Dispose();
        }

        cts?.Dispose();
    }

    private void CopyDiagnostics()
    {
        var report = new StringBuilder();
        report.AppendLine("PC Agent - School PC Prototype Diagnostic");
        report.AppendLine($"Timestamp: {DateTimeOffset.Now:O}");
        report.AppendLine($"OS: {RuntimeInformation.OSDescription}");
        report.AppendLine($"OS Architecture: {RuntimeInformation.OSArchitecture}");
        report.AppendLine($"Process Architecture: {RuntimeInformation.ProcessArchitecture}");
        report.AppendLine($"Framework: {RuntimeInformation.FrameworkDescription}");
        report.AppendLine();
        report.AppendLine(_managerStatus.Text);
        report.AppendLine(_supabaseStatus.Text);
        report.AppendLine(_gatewayStatus.Text);
        report.AppendLine(_agentStatus.Text);
        report.AppendLine(_ipcStatus.Text);
        report.AppendLine(_heartbeatStatus.Text);
        report.AppendLine();
        report.AppendLine("Cloud detail:");
        report.AppendLine(_lastCloudResult);
        report.AppendLine();
        report.AppendLine("IPC detail:");
        report.AppendLine(_lastIpcResult);

        try
        {
            Clipboard.SetText(report.ToString());
            AppendLog("診断結果をクリップボードへコピーしました");
        }
        catch (Exception ex)
        {
            AppendLog($"Clipboard ERROR: {ex.Message}");
        }
    }

    private void AppendLog(string message)
    {
        AppLogger.Write(message);

        if (_isClosing || IsDisposed || Disposing)
        {
            return;
        }

        if (InvokeRequired)
        {
            SafeUi(() => AppendLog(message));
            return;
        }

        if (!_log.IsDisposed)
        {
            _log.AppendText($"[{DateTime.Now:HH:mm:ss}] {message}{Environment.NewLine}");
        }
    }

    private void SetStatus(Label label, string text)
    {
        if (_isClosing || label.IsDisposed)
        {
            return;
        }

        if (label.InvokeRequired)
        {
            SafeUi(() => label.Text = text);
            return;
        }

        label.Text = text;
    }

    private void SafeUi(Action action)
    {
        if (_isClosing || IsDisposed || Disposing || !IsHandleCreated)
        {
            return;
        }

        try
        {
            if (InvokeRequired)
            {
                BeginInvoke(action);
            }
            else
            {
                action();
            }
        }
        catch (InvalidOperationException) when (_isClosing || IsDisposed || Disposing)
        {
            // Window is shutting down.
        }
        catch (ObjectDisposedException)
        {
            // Window is shutting down.
        }
    }

    private static Button NewButton(string text) => new()
    {
        Text = text,
        AutoSize = true,
        Padding = new Padding(10, 6, 10, 6),
        Margin = new Padding(0, 0, 8, 8),
        FlatStyle = FlatStyle.Flat,
        BackColor = Color.FromArgb(45, 45, 48),
        ForeColor = Color.White,
        UseVisualStyleBackColor = false
    };

    private static Label NewStatusLabel(string text) => new()
    {
        Text = text,
        AutoSize = true,
        Margin = new Padding(0, 0, 0, 5),
        ForeColor = Color.Gainsboro
    };
}

internal static class ProcessShutdown
{
    public static bool TryTerminateProcessTree(Process process, TimeSpan timeout, Action<string>? log = null)
    {
        try
        {
            if (process.HasExited)
            {
                log?.Invoke("already exited");
                return true;
            }

            process.Kill(entireProcessTree: true);
            var timeoutMs = Math.Clamp((int)timeout.TotalMilliseconds, 1, 10_000);
            var exited = process.WaitForExit(timeoutMs);
            log?.Invoke(exited ? "terminated" : $"timeout after {timeoutMs} ms");
            return exited;
        }
        catch (InvalidOperationException)
        {
            // The process exited between the state check and termination.
            return true;
        }
        catch (Exception ex)
        {
            log?.Invoke($"ERROR {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }
}

internal static class ShutdownSmokeTest
{
    public static int Run()
    {
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable))
        {
            return 10;
        }

        var psi = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = AppContext.BaseDirectory
        };
        psi.ArgumentList.Add("--self-test-child");

        using var child = Process.Start(psi);
        if (child is null)
        {
            return 11;
        }

        Thread.Sleep(250);
        var stopwatch = Stopwatch.StartNew();
        var stopped = ProcessShutdown.TryTerminateProcessTree(child, TimeSpan.FromSeconds(2));
        stopwatch.Stop();

        return stopped && stopwatch.Elapsed < TimeSpan.FromSeconds(3) ? 0 : 12;
    }
}

internal static class AppLogger
{
    private static readonly object Gate = new();
    private static readonly string DirectoryPath = Path.Combine(Path.GetTempPath(), "PC-Agent-Prototype");
    public static string LogPath { get; } = Path.Combine(DirectoryPath, "prototype.log");

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(DirectoryPath);
                File.AppendAllText(
                    LogPath,
                    $"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}",
                    Encoding.UTF8);
            }
        }
        catch
        {
            // Diagnostics must never make the prototype fail.
        }
    }
}

internal static class DummyAgent
{
    public static async Task RunAsync(string pipeName)
    {
        using var client = new NamedPipeClientStream(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(7));
        await client.ConnectAsync(timeout.Token);

        using var writer = new StreamWriter(client, Encoding.UTF8, 1024, leaveOpen: true)
        {
            AutoFlush = true
        };

        await writer.WriteLineAsync($"HELLO|PID={Environment.ProcessId}");

        try
        {
            while (client.IsConnected)
            {
                await writer.WriteLineAsync($"HEARTBEAT|{DateTimeOffset.Now:HH:mm:ss}");
                await Task.Delay(TimeSpan.FromSeconds(2));
            }
        }
        catch (IOException)
        {
            // Manager closed or pipe was disposed.
        }
        catch (ObjectDisposedException)
        {
            // Manager closed or pipe was disposed.
        }
    }
}
