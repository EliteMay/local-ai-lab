using System.Reflection;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        try
        {
            var assembly = Assembly.Load("PcAgentPrototype");
            var formType = assembly.GetType("PcAgentPrototype.MainForm", throwOnError: true)!;
            using var form = (Form)Activator.CreateInstance(formType, nonPublic: true)!;

            // Avoid deadlocking this console regression harness on a WinForms SynchronizationContext.
            SynchronizationContext.SetSynchronizationContext(null);

            var method = formType.GetMethod(
                "RunNamedPipeSelfTestAsync",
                BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new MissingMethodException("RunNamedPipeSelfTestAsync not found.");

            var task = (Task?)method.Invoke(form, null)
                ?? throw new InvalidOperationException("IPC self-test did not return a Task.");

            if (!task.Wait(TimeSpan.FromSeconds(8)))
            {
                Console.Error.WriteLine("IPC regression: timed out after 8 seconds.");
                return 1;
            }

            task.GetAwaiter().GetResult();

            var resultField = formType.GetField(
                "_lastIpcResult",
                BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new MissingFieldException("_lastIpcResult not found.");

            var result = resultField.GetValue(form) as string;
            Console.WriteLine($"IPC regression result: {result}");

            if (!string.Equals(result, "Named Pipe self-test: OK", StringComparison.Ordinal))
            {
                Console.Error.WriteLine("IPC regression: expected successful PING/PONG round-trip.");
                return 1;
            }

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }
}
