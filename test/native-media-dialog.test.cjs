'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MediaPicker } = require('../src/stages/page-builder/media-picker.cjs');

const sequenceScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SequencePicker {
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr parent);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
  public static void SetFilename(IntPtr dialog, string filename) {
    IntPtr edit = IntPtr.Zero;
    string controls = "";
    EnumChildWindows(dialog, (window, data) => {
      StringBuilder name = new StringBuilder(64); GetClassName(window, name, name.Capacity);
      if (name.ToString() == "Edit") {
        int id = GetDlgCtrlID(window); controls += id + ",";
        if (id == 1148 || id == 1001) edit = window;
      }
      return true;
    }, IntPtr.Zero);
    if (edit == IntPtr.Zero) throw new Exception("Filename control missing: " + controls);
    IntPtr result;
    if (SendMessageTimeout(edit, 0xC, IntPtr.Zero, filename, 2, 3000, out result) == IntPtr.Zero) throw new Exception("Setting filename timed out");
  }
  public static IntPtr Find(uint target) {
    for (IntPtr window = GetTopWindow(IntPtr.Zero); window != IntPtr.Zero; window = GetWindow(window, 2)) {
      uint processId; GetWindowThreadProcessId(window, out processId);
      if (processId != target || !IsWindowVisible(window)) continue;
      StringBuilder name = new StringBuilder(64); GetClassName(window, name, name.Capacity);
      if (name.ToString() == "#32770") return window;
    }
    return IntPtr.Zero;
  }
}
'@
$target = [uint32]$env:ARM_PICKER_PID
$window = [IntPtr]::Zero
for ($poll = 0; $poll -lt 100; $poll++) {
  $window = [SequencePicker]::Find($target)
  if ($window -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 50
}
if ($window -eq [IntPtr]::Zero) { throw 'Dialog did not become visible' }
# Observe the SAME real HWND for two seconds before issuing any user action.
for ($poll = 0; $poll -lt 40; $poll++) {
  Start-Sleep -Milliseconds 50
  $current = [SequencePicker]::Find($target)
  if ($current -ne $window) { throw ('Dialog closed before user action: original=' + $window + ', current=' + $current) }
}
if ($env:ARM_PICKER_ACTION -eq 'FILE') {
  [SequencePicker]::SetFilename($window, $env:ARM_PICKER_FILE)
  if (-not [SequencePicker]::PostMessage($window, 0x111, [IntPtr]1, [IntPtr]::Zero)) { throw 'Open failed' }
} else {
  if (-not [SequencePicker]::PostMessage($window, 0x111, [IntPtr]2, [IntPtr]::Zero)) { throw 'Cancel failed' }
}
Write-Output 'held-until-action'
`;

test('native selections and Cancel keep each subsequent dialog open until user action', {
  skip: process.platform !== 'win32' || process.env.ARM_TEST_NATIVE_DIALOG !== '1', timeout: 90000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-native-sequence-'));
  const file = path.join(directory, 'test.png');
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const picker = new MediaPicker(null);
  try {
    await picker.warmup();
    for (const [index, action] of ['FILE', 'FILE', 'CANCEL', 'FILE', 'CANCEL', 'CANCEL', 'FILE', 'CANCEL'].entries()) {
      const controller = new AbortController();
      const dialog = picker.openDialog(directory, controller.signal);
      dialog.catch(() => {});
      const protocol = [];
      dialog.child.stdout.on('data', chunk => protocol.push(chunk.toString()));
      try {
        // Yield so choose() sends the request before the synchronous observer starts.
        await new Promise(resolve => setImmediate(resolve));
        const observer = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(sequenceScript, 'utf16le').toString('base64')], {
          env: { ...process.env, ARM_PICKER_PID: String(dialog.child.pid), ARM_PICKER_ACTION: action, ARM_PICKER_FILE: file },
          encoding: 'utf8', windowsHide: true, timeout: 12000
        });
        if (observer.status !== 0) await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(observer.status, 0, `iteration ${index + 1} (${action}), protocol=${protocol.join('')}, exit=${dialog.child.exitCode}: ${observer.stderr || observer.error?.message}`);
        assert.match(observer.stdout, /held-until-action/);
        const timeout = setTimeout(() => controller.abort(), 5000);
        try { assert.equal(await dialog, action === 'FILE' ? file : null); }
        finally { clearTimeout(timeout); }
      } finally { controller.abort(); await dialog.catch(() => {}); }
    }
  } finally {
    await picker.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Opt in explicitly: this briefly shows a real Windows picker on the desktop.
test('native image dialog is visible in the topmost z-order band', {
  skip: process.platform !== 'win32' || process.env.ARM_TEST_NATIVE_DIALOG !== '1', timeout: 30000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-native-picker-'));
  const controller = new AbortController();
  const picker = new MediaPicker(null);
  const dialog = picker.openDialog(directory, controller.signal);
  dialog.catch(() => {});
  const inspectScript = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WindowOrder {
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr parent);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
}
'@
$target = [uint32]$env:ARM_PICKER_PID
$window = [WindowOrder]::GetTopWindow([IntPtr]::Zero)
$rank = 0; $nonTopmostBefore = 0; $result = $null
while ($window -ne [IntPtr]::Zero -and $rank -lt 10000) {
  if ([WindowOrder]::IsWindowVisible($window)) {
    $processId = [uint32]0
    [void][WindowOrder]::GetWindowThreadProcessId($window, [ref]$processId)
    $name = New-Object System.Text.StringBuilder 128
    [void][WindowOrder]::GetClassName($window, $name, $name.Capacity)
    $topmost = (([WindowOrder]::GetWindowLongPtr($window, -20).ToInt64() -band 8) -ne 0)
    if ($processId -eq $target -and $name.ToString() -eq '#32770') {
      $owner = [WindowOrder]::GetWindow($window, 4)
      $ownerProcess = [uint32]0
      [void][WindowOrder]::GetWindowThreadProcessId($owner, [ref]$ownerProcess)
      $result = [pscustomobject]@{ hwnd = $window.ToInt64(); ownerHwnd = $owner.ToInt64(); ownerVisible = [WindowOrder]::IsWindowVisible($owner); ownerProcess = $ownerProcess; visible = $true; topmost = $topmost; foreground = ([WindowOrder]::GetForegroundWindow() -eq $window); rank = $rank; nonTopmostBefore = $nonTopmostBefore }
      break
    }
    if (-not $topmost) { $nonTopmostBefore++ }
  }
  $window = [WindowOrder]::GetWindow($window, 2)
  $rank++
}
if ($null -eq $result) { $result = [pscustomobject]@{ hwnd = 0; ownerHwnd = 0; visible = $false; topmost = $false; foreground = $false; rank = -1; nonTopmostBefore = -1 } }
$result | ConvertTo-Json -Compress
`;
  const inspect = () => {
    const command = Buffer.from(inspectScript, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      env: { ...process.env, ARM_PICKER_PID: String(dialog.child.pid) }, encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Window inspection failed');
    return JSON.parse(result.stdout);
  };
  try {
    let window;
    for (let attempt = 0; attempt < 12; attempt++) {
      window = inspect();
      if (window.visible && window.topmost && window.nonTopmostBefore === 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(window.visible, true, 'the system dialog has a visible HWND');
    assert.notEqual(window.ownerHwnd, 0, 'the modal dialog retains its native owner');
    assert.equal(window.ownerVisible, false, 'the native owner adds no visible overlay');
    assert.equal(window.ownerProcess, dialog.child.pid, 'the native owner belongs to this helper');
    assert.equal(window.topmost, true, 'the dialog HWND itself has WS_EX_TOPMOST');
    assert.equal(window.nonTopmostBefore, 0, 'no ordinary window precedes the picker in z-order');
    const demoteScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DemotePicker {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
}
'@
if (-not [DemotePicker]::SetWindowPos([IntPtr][long]$env:ARM_PICKER_HWND, [IntPtr](-2), 0, 0, 0, 0, 0x53)) { exit 1 }
`;
    const demoted = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(demoteScript, 'utf16le').toString('base64')], {
      env: { ...process.env, ARM_PICKER_HWND: String(window.hwnd) }, encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    assert.equal(demoted.status, 0, demoted.stderr || 'could not demote test dialog');
    for (let attempt = 0; attempt < 12; attempt++) {
      window = inspect();
      if (window.topmost && window.nonTopmostBefore === 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(window.topmost, true, 'monitor restores topmost after later z-order change');
    assert.equal(window.nonTopmostBefore, 0, 'monitor restores the actual z-order');
  } finally {
    controller.abort();
    await assert.rejects(dialog, { name: 'AbortError' });
    await picker.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('startup warmup, prompt native dialogs, repeated Cancel and helper shutdown', {
  skip: process.platform !== 'win32' || process.env.ARM_TEST_NATIVE_DIALOG !== '1', timeout: 30000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-native-repeat-'));
  const picker = new MediaPicker(null);
  const warmStart = Date.now();
  await picker.warmup();
  assert.ok(Date.now() - warmStart < 10000, 'picker helper becomes ready at startup');
  const worker = picker.dialogWorker.child;
  assert.ok(worker?.pid, 'helper remains alive after warmup');
  const closeScript = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ClosePicker {
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr parent);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$target = [uint32]$env:ARM_PICKER_PID
$window = [ClosePicker]::GetTopWindow([IntPtr]::Zero)
while ($window -ne [IntPtr]::Zero) {
  $processId = [uint32]0
  [void][ClosePicker]::GetWindowThreadProcessId($window, [ref]$processId)
  if ($processId -eq $target -and [ClosePicker]::IsWindowVisible($window)) {
    $name = New-Object System.Text.StringBuilder 64
    [void][ClosePicker]::GetClassName($window, $name, $name.Capacity)
    if ($name.ToString() -eq '#32770') {
      if (-not [ClosePicker]::PostMessage($window, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) { exit 1 }
      Write-Output $window.ToInt64()
      exit 0
    }
  }
  $window = [ClosePicker]::GetWindow($window, 2)
}
`;
  try {
    const startupProbe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(closeScript, 'utf16le').toString('base64')], {
      env: { ...process.env, ARM_PICKER_PID: String(worker.pid) }, encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    assert.equal(startupProbe.status, 0, startupProbe.stderr);
    assert.equal(startupProbe.stdout.trim(), '', 'warmup does not display a file dialog');
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const started = Date.now();
      const dialog = picker.openDialog(directory, controller.signal);
      dialog.catch(() => {});
      try {
        let closed = false;
        for (let poll = 0; poll < 12; poll++) {
          const command = Buffer.from(closeScript, 'utf16le').toString('base64');
          const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
            env: { ...process.env, ARM_PICKER_PID: String(dialog.child.pid) }, encoding: 'utf8', windowsHide: true, timeout: 5000
          });
          if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Could not close native picker');
          if (result.stdout.trim()) { closed = true; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!closed) {
          const outcome = await Promise.race([dialog.then(value => `resolved ${value}`, error => `rejected ${error.message}`), new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
          assert.fail(`dialog ${attempt + 1} did not become visible (${outcome})`);
        }
        assert.ok(Date.now() - started < 5000, `warmed dialog ${attempt + 1} appears promptly`);
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`dialog ${attempt + 1} child did not exit after WM_CLOSE`)), 5000);
          dialog.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
        });
        assert.equal(result, null, 'ordinary Cancel returns without killing the process');
        assert.notEqual(dialog.child.exitCode ?? dialog.child.signalCode, null, 'completed helper exits after Cancel');
        assert.ok(picker.dialogWorker.child?.pid, 'replacement is warmed before the next selection');
      } finally { controller.abort(); await dialog.catch(() => {}); }
    }
  } finally {
    await picker.shutdown();
    assert.notEqual(worker.exitCode ?? worker.signalCode, null, 'shutdown reaps the helper');
    assert.equal(picker.dialogWorker.child, null, 'shutdown reaps the current helper');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
