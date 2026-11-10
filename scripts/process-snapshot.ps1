param([Parameter(Mandatory=$true)][int]$AppProcessId, [switch]$Minimize, [switch]$Close)
$ErrorActionPreference = 'Stop'
if ($Minimize -or $Close) {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class TinyWindow { public delegate bool EnumCallback(IntPtr window, IntPtr data); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr data); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int count); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam); }'
  $script:tinyWindowHandle = [IntPtr]::Zero
  $callback = [TinyWindow+EnumCallback]{ param($windowHandle,$callbackData)
    [uint32]$ownerId = 0
    [void][TinyWindow]::GetWindowThreadProcessId($windowHandle, [ref]$ownerId)
    if ($ownerId -eq $AppProcessId) {
      $title = [System.Text.StringBuilder]::new(256)
      [void][TinyWindow]::GetWindowText($windowHandle,$title,256)
      if ($title.ToString() -eq 'Tiny') { $script:tinyWindowHandle = $windowHandle; return $false }
    }
    return $true
  }
  [void][TinyWindow]::EnumWindows($callback,[IntPtr]::Zero)
  if ($script:tinyWindowHandle -eq [IntPtr]::Zero) { throw 'Tiny has no native window to control.' }
  if ($Minimize) { [void][TinyWindow]::ShowWindowAsync($script:tinyWindowHandle,6) }
  if ($Close) { [void][TinyWindow]::PostMessage($script:tinyWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero); exit 0 }
}
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
$tracked = [System.Collections.Generic.HashSet[int]]::new()
[void]$tracked.Add($AppProcessId)
do {
  $added = $false
  foreach ($entry in $processes) {
    if ($tracked.Contains([int]$entry.ParentProcessId) -and $tracked.Add([int]$entry.ProcessId)) { $added = $true }
  }
} while ($added)
$rows = @(foreach ($processId in $tracked) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    [PSCustomObject]@{ id = $process.Id; name = $process.ProcessName; cpuMs = $process.TotalProcessorTime.TotalMilliseconds; workingSet = $process.WorkingSet64; privateCommit = $process.PrivateMemorySize64 }
  }
})
[PSCustomObject]@{ sampledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes = $rows } | ConvertTo-Json -Depth 4 -Compress
