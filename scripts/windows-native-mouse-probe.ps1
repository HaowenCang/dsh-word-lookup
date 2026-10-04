<#
.SYNOPSIS
  Phase 4.2.1 — a minimal, auditable Windows-native mouse input helper.

.DESCRIPTION
  Phase 4.2 measured the first-press / double-click overlap with CDP input, and
  CDP input has to be *told* the click multiplicity. That is not the same thing
  as Windows recognising a double click, so the overlap's reachability was still
  an open question. This helper is the smallest thing that can answer it: it
  injects real mouse input through `SendInput` — the queue the operating system
  itself feeds — and reads the system's own double-click metrics.

  It is deliberately a **slave, not a driver**. It owns no policy, decides
  nothing about the experiment and never touches DSH. It reads one JSON command
  per line on stdin and writes one JSON result per line on stdout, which is what
  lets the Node driver keep sub-millisecond control over the *spacing* of two
  presses while the events themselves come from Windows rather than from an
  automation protocol.

  What it is allowed to do
  ------------------------
  - read system metrics (`GetDoubleClickTime`, `SM_CXDOUBLECLK`,
    `SM_CYDOUBLECLK`, `SM_CXDRAG`, `SM_CYDRAG`, screen and virtual-screen
    geometry, per-monitor DPI);
  - read and move the cursor, press and release a mouse button, through
    `SendInput`;
  - find a top-level window by a title marker and bring it to the foreground;
  - restore the cursor position it recorded when it started.

  What it must never do
  ---------------------
  - change any system mouse setting (`SetDoubleClickTime`,
    `SPI_SETDOUBLECLKWIDTH`, `SPI_SETDOUBLECLKHEIGHT`, pointer speed,
    acceleration) — those entry points are not linked at all;
  - terminate a process, or touch a window it was not asked about;
  - start, stop, configure or read DSH, or persist anything to disk.

  DPI
  ---
  The process asks to be per-monitor-v2 DPI aware before it reads anything, so
  every coordinate it reports or accepts is a **physical** screen pixel when the
  request is granted. Whether it was granted is reported as
  `dpi.awarenessRequestGranted` rather than assumed: a process that silently
  stayed unaware would see virtualised metrics and a virtualised cursor, and a
  coordinate handed to `SendInput` would then be reinterpreted on the way in —
  the classic way a probe like this produces a confident wrong answer. The Node
  driver therefore *calibrates* the screen↔client transform by measurement
  instead of deriving it from these metrics.

  Absolute moves are used rather than relative ones on purpose: relative mouse
  deltas pass through the pointer-speed and "enhance pointer precision"
  transforms, so a requested 8 px of travel would not be the delivered 8 px and
  the movement sweep would be measuring the acceleration curve.

  Usage
  -----
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-native-mouse-probe.ps1 -SelfTest
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-native-mouse-probe.ps1   # JSON-lines slave
  ```

  Exit codes: 0 = ok, 1 = fatal, 2 = refused (not Windows).

.NOTES
  This file is a measurement instrument, not production code. It is excluded
  from `npm test`; it is driven by `scripts/phase421-native-input-probe.mjs`
  under the explicit `npm run test:native-input` command.
#>
#requires -Version 5.1
[CmdletBinding()]
param(
  # Print the metrics/DPI/cursor snapshot once and exit. Read-only.
  [switch]$SelfTest,
  # With -SelfTest, additionally prove SendInput is accepted by nudging the
  # cursor by one pixel and putting it back.
  [switch]$MoveTest
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  [Console]::Error.WriteLine('windows-native-mouse-probe: this helper only runs on Windows')
  exit 2
}

# ---------------------------------------------------------------------------
# Win32 interop. Compiled once; every entry point below is a thin wrapper.
# ---------------------------------------------------------------------------
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace DshWordLookup.NativeInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    public static class Win32
    {
        public const uint INPUT_MOUSE = 0;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_MOVE_NOCOALESCE = 0x2000;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

        public const int SM_CXSCREEN = 0;
        public const int SM_CYSCREEN = 1;
        public const int SM_CXDOUBLECLK = 36;
        public const int SM_CYDOUBLECLK = 37;
        public const int SM_CXDRAG = 68;
        public const int SM_CYDRAG = 69;
        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;
        public const int SM_CMONITORS = 80;

        public const int SW_RESTORE = 9;

        public const uint GA_ROOT = 2;
        public const uint MONITOR_DEFAULTTONEAREST = 2;
        public const int MDT_EFFECTIVE_DPI = 0;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        public static extern int GetDoubleClickTime();

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetricsForDpi(int nIndex, uint dpi);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

        [DllImport("shcore.dll")]
        public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetProcessDPIAware();

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        public static bool MakePerMonitorAwareV2()
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true;
            return SetProcessDPIAware();
        }

        public static string WindowText(IntPtr hWnd)
        {
            StringBuilder sb = new StringBuilder(1024);
            int n = GetWindowTextW(hWnd, sb, sb.Capacity);
            return n <= 0 ? string.Empty : sb.ToString();
        }

        public static string ClassName(IntPtr hWnd)
        {
            StringBuilder sb = new StringBuilder(512);
            int n = GetClassNameW(hWnd, sb, sb.Capacity);
            return n <= 0 ? string.Empty : sb.ToString();
        }

        public static List<IntPtr> TopLevelWindows()
        {
            List<IntPtr> found = new List<IntPtr>();
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                found.Add(hWnd);
                return true;
            }, IntPtr.Zero);
            return found;
        }

        public static uint ForegroundThreadId()
        {
            uint pid;
            return GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        }

        public static uint WindowPid(IntPtr hWnd)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            return pid;
        }

        // The INPUT aggregate is built here rather than from PowerShell on
        // purpose. PowerShell cannot faithfully assign to a field of a *nested*
        // struct: it reads `input.u` as a copy, writes `mi.dx` into the copy and
        // discards it. The event then goes to SendInput with `dwFlags == 0`,
        // which the OS accepts (insertion count 1) and does nothing with — a
        // silent no-op that looks exactly like a successful injection. Building
        // the whole aggregate in C# removes the failure mode instead of
        // documenting it.
        public static INPUT MakeMouseInput(int dx, int dy, uint flags, uint mouseData)
        {
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.u.mi.dx = dx;
            input.u.mi.dy = dy;
            input.u.mi.mouseData = mouseData;
            input.u.mi.dwFlags = flags;
            input.u.mi.time = 0;
            input.u.mi.dwExtraInfo = IntPtr.Zero;
            return input;
        }

        public static uint SendMouseInput(int dx, int dy, uint flags, out int lastError, out int sizeOfInput)
        {
            INPUT[] buffer = new INPUT[1];
            buffer[0] = MakeMouseInput(dx, dy, flags, 0);
            sizeOfInput = Marshal.SizeOf(typeof(INPUT));
            uint inserted = SendInput(1, buffer, sizeOfInput);
            lastError = Marshal.GetLastWin32Error();
            return inserted;
        }

        // `SendInput` queues into the system input queue; the cursor is warped
        // by the input thread afterwards. Reading `GetCursorPos` straight after
        // the call therefore reports the *previous* position, so the achieved
        // position is polled for rather than assumed.
        public static bool WaitForCursor(int x, int y, int timeoutMs, out POINT achieved, out int elapsedMs)
        {
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            POINT p;
            while (true)
            {
                GetCursorPos(out p);
                if (p.X == x && p.Y == y)
                {
                    achieved = p;
                    elapsedMs = (int)sw.ElapsedMilliseconds;
                    return true;
                }
                if (sw.ElapsedMilliseconds >= timeoutMs)
                {
                    achieved = p;
                    elapsedMs = (int)sw.ElapsedMilliseconds;
                    return false;
                }
                System.Threading.Thread.Sleep(1);
            }
        }
    }
}
'@

$awarenessGranted = [DshWordLookup.NativeInput.Win32]::MakePerMonitorAwareV2()

# ---------------------------------------------------------------------------
# Metrics, DPI and cursor — the only reads the helper performs.
# ---------------------------------------------------------------------------

function Get-OperatingSystemInfo {
  $os = Get-CimInstance Win32_OperatingSystem
  return [ordered]@{
    caption = $os.Caption
    version = $os.Version
    build = $os.BuildNumber
    architecture = $os.OSArchitecture
  }
}

function Get-CursorPoint {
  $p = New-Object DshWordLookup.NativeInput.POINT
  $null = [DshWordLookup.NativeInput.Win32]::GetCursorPos([ref]$p)
  return [ordered]@{ x = $p.X; y = $p.Y }
}

function Get-Snapshot {
  <#
    Read the system metrics this experiment is defined against.

    Every value is read, never written. `SM_CXDOUBLECLK` in particular is
    reported even when it is zero: a zero is a measurement, and the driver has
    to be able to see it rather than have the helper substitute a plausible
    default.
  #>
  $W = [DshWordLookup.NativeInput.Win32]
  $cursor = New-Object DshWordLookup.NativeInput.POINT
  $null = $W::GetCursorPos([ref]$cursor)

  $dpiX = [uint32]0
  $dpiY = [uint32]0
  $monitor = $W::MonitorFromPoint($cursor, $W::MONITOR_DEFAULTTONEAREST)
  $dpiResult = $W::GetDpiForMonitor($monitor, $W::MDT_EFFECTIVE_DPI, [ref]$dpiX, [ref]$dpiY)

  $foreground = $W::GetForegroundWindow()

  $regMouse = Get-ItemProperty -Path 'HKCU:\Control Panel\Mouse' -ErrorAction SilentlyContinue

  return [ordered]@{
    os = (Get-OperatingSystemInfo)
    doubleClickTimeMs = $W::GetDoubleClickTime()
    doubleClickWidth = $W::GetSystemMetrics($W::SM_CXDOUBLECLK)
    doubleClickHeight = $W::GetSystemMetrics($W::SM_CYDOUBLECLK)
    dragWidth = $W::GetSystemMetrics($W::SM_CXDRAG)
    dragHeight = $W::GetSystemMetrics($W::SM_CYDRAG)
    screenWidth = $W::GetSystemMetrics($W::SM_CXSCREEN)
    screenHeight = $W::GetSystemMetrics($W::SM_CYSCREEN)
    virtualScreen = [ordered]@{
      x = $W::GetSystemMetrics($W::SM_XVIRTUALSCREEN)
      y = $W::GetSystemMetrics($W::SM_YVIRTUALSCREEN)
      width = $W::GetSystemMetrics($W::SM_CXVIRTUALSCREEN)
      height = $W::GetSystemMetrics($W::SM_CYVIRTUALSCREEN)
    }
    monitorCount = $W::GetSystemMetrics($W::SM_CMONITORS)
    dpi = [ordered]@{
      awarenessRequestGranted = $awarenessGranted
      effectiveX = [int]$dpiX
      effectiveY = [int]$dpiY
      getDpiForMonitorResult = $dpiResult
      scalePercent = if ($dpiX -gt 0) { [math]::Round($dpiX * 100.0 / 96.0, 4) } else { $null }
      doubleClickWidthForDpi = if ($dpiX -gt 0) { $W::GetSystemMetricsForDpi($W::SM_CXDOUBLECLK, $dpiX) } else { $null }
      doubleClickHeightForDpi = if ($dpiX -gt 0) { $W::GetSystemMetricsForDpi($W::SM_CYDOUBLECLK, $dpiX) } else { $null }
    }
    registry = [ordered]@{
      doubleClickWidth = if ($regMouse -and $null -ne $regMouse.DoubleClickWidth) { [int]$regMouse.DoubleClickWidth } else { $null }
      doubleClickHeight = if ($regMouse -and $null -ne $regMouse.DoubleClickHeight) { [int]$regMouse.DoubleClickHeight } else { $null }
      doubleClickSpeed = if ($regMouse -and $null -ne $regMouse.DoubleClickSpeed) { [int]$regMouse.DoubleClickSpeed } else { $null }
    }
    cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
    foreground = [ordered]@{
      hwnd = [int64]$foreground
      title = $W::WindowText($foreground)
      className = $W::ClassName($foreground)
      pid = [int64]$W::WindowPid($foreground)
    }
  }
}

# ---------------------------------------------------------------------------
# SendInput wrappers.
#
# Every wrapper returns the `SendInput` insertion count alongside the action, so
# "the OS accepted this input" is a recorded fact rather than an assumption. A
# count below the number of requested events means the input was refused —
# almost always a foreground-window / integrity mismatch — and the driver treats
# that as an invalid probe rather than as a negative result.
# ---------------------------------------------------------------------------

function Get-MouseInputSize {
  return [System.Runtime.InteropServices.Marshal]::SizeOf([type][DshWordLookup.NativeInput.INPUT])
}

function Send-MouseEvent {
  param([int]$Dx, [int]$Dy, [uint32]$Flags, [uint32]$MouseData = 0)

  $W = [DshWordLookup.NativeInput.Win32]
  $lastError = 0
  $sizeOfInput = 0
  $inserted = $W::SendMouseInput($Dx, $Dy, $Flags, [ref]$lastError, [ref]$sizeOfInput)

  return [ordered]@{
    inserted = [int]$inserted
    requested = 1
    lastError = [int]$lastError
    insertedAll = ([int]$inserted -eq 1)
    sizeOfInput = [int]$sizeOfInput
  }
}

function Invoke-Move {
  <#
    Absolute move in **physical** screen pixels.

    `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` maps the normalised
    0..65535 range onto the whole virtual desktop, so the helper never has to
    assume a single monitor or a monitor at the origin. `MOUSEEVENTF_MOVE_NOCOALESCE`
    keeps each requested position a distinct move, which is what makes a
    multi-step drag a multi-step drag rather than one jump.
  #>
  param(
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y,
    # How long the move may take to be reflected by `GetCursorPos`, in ms.
    [int]$SettleMs = 150
  )

  $W = [DshWordLookup.NativeInput.Win32]
  $vx = $W::GetSystemMetrics($W::SM_XVIRTUALSCREEN)
  $vy = $W::GetSystemMetrics($W::SM_YVIRTUALSCREEN)
  $vw = $W::GetSystemMetrics($W::SM_CXVIRTUALSCREEN)
  $vh = $W::GetSystemMetrics($W::SM_CYVIRTUALSCREEN)

  $denomX = if ($vw -gt 1) { $vw - 1 } else { 1 }
  $denomY = if ($vh -gt 1) { $vh - 1 } else { 1 }
  $nx = [int][math]::Round(($X - $vx) * 65535.0 / $denomX)
  $ny = [int][math]::Round(($Y - $vy) * 65535.0 / $denomY)
  $nx = [math]::Max(0, [math]::Min(65535, $nx))
  $ny = [math]::Max(0, [math]::Min(65535, $ny))

  $flags = [uint32]($W::MOUSEEVENTF_MOVE -bor $W::MOUSEEVENTF_ABSOLUTE -bor $W::MOUSEEVENTF_VIRTUALDESK -bor $W::MOUSEEVENTF_MOVE_NOCOALESCE)
  $result = Send-MouseEvent -Dx $nx -Dy $ny -Flags $flags

  # `SendInput` only queues the event; the cursor is warped by the input thread
  # afterwards, so the position is polled for rather than sampled once. A move
  # that never settles is reported as such — `settled = false` with the position
  # that was actually reached — because a cursor that will not hold still is
  # either external interference or a refused injection, and both invalidate a
  # measurement rather than being a negative result.
  $achieved = New-Object DshWordLookup.NativeInput.POINT
  $elapsed = 0
  $settled = $W::WaitForCursor($X, $Y, $SettleMs, [ref]$achieved, [ref]$elapsed)

  $result['requested'] = [ordered]@{ x = $X; y = $Y; normalizedX = $nx; normalizedY = $ny }
  $result['cursor'] = [ordered]@{ x = $achieved.X; y = $achieved.Y }
  $result['settled'] = $settled
  $result['settleMs'] = $elapsed
  return $result
}

function Invoke-Button {
  param([Parameter(Mandatory = $true)][string]$Button, [Parameter(Mandatory = $true)][string]$Phase)

  $W = [DshWordLookup.NativeInput.Win32]
  $map = @{
    'left'   = @{ down = $W::MOUSEEVENTF_LEFTDOWN; up = $W::MOUSEEVENTF_LEFTUP }
    'right'  = @{ down = $W::MOUSEEVENTF_RIGHTDOWN; up = $W::MOUSEEVENTF_RIGHTUP }
    'middle' = @{ down = $W::MOUSEEVENTF_MIDDLEDOWN; up = $W::MOUSEEVENTF_MIDDLEUP }
  }
  if (-not $map.ContainsKey($Button)) { throw "unknown button '$Button'" }
  if ($Phase -ne 'down' -and $Phase -ne 'up') { throw "unknown phase '$Phase'" }

  $flags = [uint32]$map[$Button][$Phase]
  $result = Send-MouseEvent -Dx 0 -Dy 0 -Flags $flags
  # Tracked so that a driver that dies mid-gesture cannot leave a button held
  # down on the reader's desktop.
  $script:HeldButtons[$Button] = ($Phase -eq 'down')
  $result['cursor'] = Get-CursorPoint
  return $result
}

# ---------------------------------------------------------------------------
# Windows.
# ---------------------------------------------------------------------------

function Get-WindowInfo {
  param([Parameter(Mandatory = $true)][IntPtr]$Hwnd)

  $W = [DshWordLookup.NativeInput.Win32]
  $rect = New-Object DshWordLookup.NativeInput.RECT
  $null = $W::GetWindowRect($Hwnd, [ref]$rect)
  $client = New-Object DshWordLookup.NativeInput.RECT
  $null = $W::GetClientRect($Hwnd, [ref]$client)
  $origin = New-Object DshWordLookup.NativeInput.POINT
  $origin.X = 0
  $origin.Y = 0
  $null = $W::ClientToScreen($Hwnd, [ref]$origin)

  return [ordered]@{
    hwnd = [int64]$Hwnd
    pid = [int64]$W::WindowPid($Hwnd)
    title = $W::WindowText($Hwnd)
    className = $W::ClassName($Hwnd)
    visible = $W::IsWindowVisible($Hwnd)
    minimized = $W::IsIconic($Hwnd)
    windowRect = [ordered]@{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
    clientRectOnScreen = [ordered]@{
      left = $origin.X
      top = $origin.Y
      width = $client.Right - $client.Left
      height = $client.Bottom - $client.Top
    }
  }
}

function Find-WindowByTitle {
  <#
    Locate a top-level visible window by a marker in its title.

    A title marker is used rather than a process id because the marker can be
    made unique per run — which is what guarantees this helper can only ever
    foreground *this* run's isolated Chromium window and never the window the
    reader is actually using.
  #>
  param([Parameter(Mandatory = $true)][string]$Marker)

  $W = [DshWordLookup.NativeInput.Win32]
  $found = @()
  foreach ($hwnd in $W::TopLevelWindows()) {
    if (-not $W::IsWindowVisible($hwnd)) { continue }
    $title = $W::WindowText($hwnd)
    if ([string]::IsNullOrEmpty($title)) { continue }
    if ($title.IndexOf($Marker, [System.StringComparison]::Ordinal) -lt 0) { continue }
    $found += ,(Get-WindowInfo -Hwnd $hwnd)
  }
  return $found
}

function Invoke-Foreground {
  <#
    Bring one window to the foreground and *verify* it.

    `SetForegroundWindow` is allowed to fail — Windows only grants the right to
    a process that already owns the foreground, and normally the reader's own
    window does. The documented fallback is to attach to the foreground thread's
    input queue for the duration of the call, which the second attempt below
    does. Either way the result is verified against `GetForegroundWindow` rather
    than assumed, because an experiment that silently ran against the wrong
    window would produce a confident wrong answer.
  #>
  param([Parameter(Mandatory = $true)][IntPtr]$Hwnd)

  $W = [DshWordLookup.NativeInput.Win32]
  $attempts = @()

  if (-not $W::IsWindow($Hwnd)) { throw 'the requested window no longer exists' }

  $wasMinimized = $W::IsIconic($Hwnd)
  if ($wasMinimized) {
    $null = $W::ShowWindow($Hwnd, $W::SW_RESTORE)
    $attempts += 'restored-from-minimized'
  }

  $null = $W::BringWindowToTop($Hwnd)
  $null = $W::SetForegroundWindow($Hwnd)
  $holds = ([int64]$W::GetForegroundWindow() -eq [int64]$Hwnd)
  $attempts += "set-foreground-window:$holds"

  if (-not $holds) {
    $foregroundThread = $W::ForegroundThreadId()
    $ownThread = $W::GetCurrentThreadId()
    $attached = $W::AttachThreadInput($ownThread, $foregroundThread, $true)
    try {
      $null = $W::BringWindowToTop($Hwnd)
      $null = $W::SetForegroundWindow($Hwnd)
    } finally {
      if ($attached) { $null = $W::AttachThreadInput($ownThread, $foregroundThread, $false) }
    }
    $holds = ([int64]$W::GetForegroundWindow() -eq [int64]$Hwnd)
    $attempts += "attach-thread-input:$holds"
  }

  return [ordered]@{
    requested = [int64]$Hwnd
    foreground = [int64]$W::GetForegroundWindow()
    holds = $holds
    wasMinimized = $wasMinimized
    attempts = $attempts
    window = (Get-WindowInfo -Hwnd $Hwnd)
  }
}

# ---------------------------------------------------------------------------
# Command loop.
# ---------------------------------------------------------------------------

$script:OriginalCursor = Get-CursorPoint
$script:StartedAt = [System.Diagnostics.Stopwatch]::StartNew()
$script:Restored = $false
$script:HeldButtons = @{ left = $false; right = $false; middle = $false }

function Release-HeldButtons {
  <#
    Release anything this helper pressed.

    A driver that crashes between `down` and `up` would otherwise leave a button
    held down on the reader's own desktop, which is both alarming and hard to
    undo by hand. Releasing here makes the helper safe to kill at any point.
  #>
  foreach ($button in @('left', 'right', 'middle')) {
    if ($script:HeldButtons[$button] -ne $true) { continue }
    try {
      $null = Invoke-Button -Button $button -Phase 'up'
    } catch {
      [Console]::Error.WriteLine("windows-native-mouse-probe: could not release the $button button: $($_.Exception.Message)")
    }
  }
}

function Restore-OriginalCursor {
  if ($script:Restored) { return }
  $script:Restored = $true
  Release-HeldButtons
  try {
    $null = Invoke-Move -X ([int]$script:OriginalCursor.x) -Y ([int]$script:OriginalCursor.y)
  } catch {
    [Console]::Error.WriteLine("windows-native-mouse-probe: cursor restore failed: $($_.Exception.Message)")
  }
}

function Write-Result {
  param([Parameter(Mandatory = $true)][hashtable]$Payload)
  $Payload['t'] = [math]::Round($script:StartedAt.Elapsed.TotalMilliseconds, 3)
  [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Depth 14 -Compress))
  [Console]::Out.Flush()
}

function Invoke-Command {
  param([Parameter(Mandatory = $true)]$Command)

  $op = [string]$Command.op
  $id = if ($null -ne $Command.id) { [int]$Command.id } else { 0 }

  switch ($op) {
    'hello' {
      return @{
        id = $id; ok = $true; op = $op; pid = $PID
        originalCursor = $script:OriginalCursor
        sizeOfInput = (Get-MouseInputSize)
        awarenessRequestGranted = $awarenessGranted
      }
    }
    'snapshot' {
      return @{ id = $id; ok = $true; op = $op; snapshot = (Get-Snapshot) }
    }
    'metrics' {
      return @{ id = $id; ok = $true; op = $op; metrics = (Get-Snapshot) }
    }
    'cursor' {
      return @{ id = $id; ok = $true; op = $op; cursor = (Get-CursorPoint) }
    }
    'move' {
      $r = Invoke-Move -X ([int]$Command.x) -Y ([int]$Command.y)
      return @{
        id = $id; ok = $true; op = $op
        send = $r; cursor = $r['cursor']; requested = $r['requested']
        settled = $r['settled']; settleMs = $r['settleMs']
      }
    }
    'down' {
      $r = Invoke-Button -Button ([string]$Command.button) -Phase 'down'
      return @{ id = $id; ok = $true; op = $op; send = $r; cursor = $r['cursor']; button = [string]$Command.button }
    }
    'up' {
      $r = Invoke-Button -Button ([string]$Command.button) -Phase 'up'
      return @{ id = $id; ok = $true; op = $op; send = $r; cursor = $r['cursor']; button = [string]$Command.button }
    }
    'findWindow' {
      return @{ id = $id; ok = $true; op = $op; windows = @(Find-WindowByTitle -Marker ([string]$Command.title)) }
    }
    'windowInfo' {
      return @{ id = $id; ok = $true; op = $op; window = (Get-WindowInfo -Hwnd ([IntPtr][int64]$Command.hwnd)) }
    }
    'foreground' {
      return @{ id = $id; ok = $true; op = $op; result = (Invoke-Foreground -Hwnd ([IntPtr][int64]$Command.hwnd)) }
    }
    'restore' {
      $null = Invoke-Move -X ([int]$script:OriginalCursor.x) -Y ([int]$script:OriginalCursor.y)
      return @{ id = $id; ok = $true; op = $op; cursor = (Get-CursorPoint); originalCursor = $script:OriginalCursor }
    }
    'quit' {
      return @{ id = $id; ok = $true; op = $op; quitting = $true }
    }
    default {
      return @{ id = $id; ok = $false; op = $op; error = "unknown op '$op'" }
    }
  }
}

if ($SelfTest) {
  [Console]::Out.WriteLine(((Get-Snapshot) | ConvertTo-Json -Depth 14))
  [Console]::Out.Flush()
  if ($MoveTest) {
    $before = Get-CursorPoint
    $moved = Invoke-Move -X ([int]$before.x + 1) -Y ([int]$before.y)
    Start-Sleep -Milliseconds 60
    $afterMove = Get-CursorPoint
    $back = Invoke-Move -X ([int]$before.x) -Y ([int]$before.y)
    Start-Sleep -Milliseconds 60
    $afterBack = Get-CursorPoint
    [Console]::Out.WriteLine(([ordered]@{
          before = $before
          moveSend = $moved['inserted']
          afterMove = $afterMove
          backSend = $back['inserted']
          afterBack = $afterBack
          restored = ($afterBack.x -eq $before.x -and $afterBack.y -eq $before.y)
        } | ConvertTo-Json -Depth 6))
    [Console]::Out.Flush()
  }
  exit 0
}

$exitCode = 0
try {
  Write-Result @{ id = 0; ok = $true; op = 'ready'; pid = $PID; originalCursor = $script:OriginalCursor }

  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $command = $null
    try {
      $command = $line | ConvertFrom-Json
    } catch {
      Write-Result @{ id = 0; ok = $false; op = 'parse'; error = $_.Exception.Message }
      continue
    }
    try {
      $result = Invoke-Command -Command $command
      Write-Result $result
      if ($result['quitting'] -eq $true) { break }
    } catch {
      Write-Result @{ id = [int]$command.id; ok = $false; op = [string]$command.op; error = $_.Exception.Message }
    }
  }
} catch {
  [Console]::Error.WriteLine("windows-native-mouse-probe: fatal: $($_.Exception.Message)")
  $exitCode = 1
} finally {
  Restore-OriginalCursor
}

exit $exitCode
