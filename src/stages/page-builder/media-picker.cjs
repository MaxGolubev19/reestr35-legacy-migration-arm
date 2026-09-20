'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { verifiedRasterMime, extensions, mediaMime, detectLegacyImages, checkedPath, readChecked, filename, provenance } = require('../../infrastructure/media.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const dialogScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
public static class PickerWindow {
  private static Timer monitor;
  private static int activated;
  private static int running;
  private static int stopping;
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr parent);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  public static IntPtr FindDialog() {
    uint ownProcess = GetCurrentProcessId();
    IntPtr window = GetTopWindow(IntPtr.Zero);
    for (int count = 0; window != IntPtr.Zero && count < 10000; count++, window = GetWindow(window, 2)) {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (processId != ownProcess || !IsWindowVisible(window)) continue;
      StringBuilder name = new StringBuilder(64);
      GetClassName(window, name, name.Capacity);
      if (name.ToString() == "#32770") return window;
    }
    return IntPtr.Zero;
  }
  public static bool NeedsRaise(IntPtr dialog) {
    if ((GetWindowLongPtr(dialog, -20).ToInt64() & 8) == 0) return true;
    IntPtr window = GetTopWindow(IntPtr.Zero);
    for (int count = 0; window != IntPtr.Zero && count < 10000; count++, window = GetWindow(window, 2)) {
      if (window == dialog) return false;
      if (IsWindowVisible(window) && (GetWindowLongPtr(window, -20).ToInt64() & 8) == 0) return true;
    }
    return false;
  }
  public static void StartMonitor() {
    Interlocked.Exchange(ref stopping, 0);
    Interlocked.Exchange(ref activated, 0);
    monitor = new Timer(_ => {
      if (Interlocked.CompareExchange(ref running, 1, 0) != 0) return;
      try {
        if (Volatile.Read(ref stopping) != 0) return;
        IntPtr window = FindDialog();
        if (window == IntPtr.Zero || Volatile.Read(ref stopping) != 0 || !IsWindow(window)) return;
        if (Interlocked.CompareExchange(ref activated, 1, 0) == 0) {
          // Keep ShowDialog's invisible owner intact for the modal lifetime.
          // Detaching GWLP_HWNDPARENT here can hide subsequent dialogs after
          // Cancel while ShowDialog remains blocked. Raise the dialog itself.
          SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x4043);
          SetForegroundWindow(window);
        } else if (Volatile.Read(ref stopping) == 0 && IsWindow(window) && NeedsRaise(window)) {
          // Keep it visible if the browser later retakes foreground. Do not
          // retake keyboard focus from a user who intentionally switched away.
          SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x4053);
        }
      } catch { /* A closing dialog may disappear between enumeration and use. */ }
      finally { Volatile.Write(ref running, 0); }
    }, null, 100, 100);
  }
  public static void StopMonitor() {
    Interlocked.Exchange(ref stopping, 1);
    Timer timer = Interlocked.Exchange(ref monitor, null);
    if (timer != null) timer.Dispose();
  }
}
'@
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.WriteLine('READY')
while ($null -ne ($request = [Console]::In.ReadLine())) {
  if ($request -eq 'STOP') { break }
  $dialog = $null
  try {
    $directory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request))
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.InitialDirectory = $directory
    $dialog.Filter = 'Изображения|*.png;*.jpg;*.gif;*.webp;*.avif;*.bmp'
    $dialog.Multiselect = $false
    $dialog.CheckFileExists = $true
    $dialog.RestoreDirectory = $true
    [PickerWindow]::StartMonitor()
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      [Console]::Out.WriteLine('FILE ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.FileName)))
    } else { [Console]::Out.WriteLine('CANCEL') }
  } catch {
    [Console]::Out.WriteLine('ERROR ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message)))
  } finally {
    [PickerWindow]::StopMonitor()
    if ($null -ne $dialog) { $dialog.Dispose() }
  }
}
`;
const abortedDialog = () => Object.assign(new Error('Выбор изображения отменён'), { name: 'AbortError' });
class WindowsDialogWorker {
  constructor({ spawnProcess = spawn, platform = process.platform } = {}) { this.spawnProcess = spawnProcess; this.platform = platform; this.child = null; this.ready = null; this.pending = null; this.closed = false; }
  start() {
    if (this.closed) return Promise.reject(new Error('Приложение завершает работу'));
    if (this.platform !== 'win32') return Promise.resolve();
    if (this.ready) return this.ready;
    const command = Buffer.from(dialogScript, 'utf16le').toString('base64');
    const child = this.spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', command], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    const childClosed = new Promise(resolve => child.once('close', resolve));
    this.childClosed = childClosed;
    let settled = false, output = '', errors = '';
    this.ready = new Promise((resolve, reject) => {
      const fail = error => {
        if (!settled) { settled = true; reject(error); }
        if (this.pending) { this.pending.reject(error); this.pending = null; }
      };
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8');
        if (output.length > 65536) { child.kill(); return; }
        let newline;
        while ((newline = output.indexOf('\n')) !== -1) {
          const line = output.slice(0, newline).trim(); output = output.slice(newline + 1);
          if (!settled && line === 'READY') { settled = true; resolve(); continue; }
          if (this.pending) {
            const pending = this.pending; this.pending = null;
            if (line === 'CANCEL') pending.resolve(null);
            else if (line.startsWith('FILE ')) pending.resolve(Buffer.from(line.slice(5), 'base64').toString('utf8'));
            else pending.reject(new Error('Не удалось выбрать изображение: ' + (line.startsWith('ERROR ') ? Buffer.from(line.slice(6), 'base64').toString('utf8') : line)));
          }
        }
      });
      child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-4096); });
      // write() can report EPIPE through the stream's error event even when
      // its callback is supplied. Keep this listener for the child's lifetime.
      child.stdin.on('error', error => { fail(error); child.kill(); });
      child.once('error', fail);
      child.once('close', code => {
        fail(new Error(`Процесс выбора изображения завершился: ${errors.trim() || `код ${code}`}`));
        if (this.child === child) { this.child = null; this.childClosed = null; this.ready = null; }
      });
    });
    // Warmup runs without an awaiting caller; avoid unhandled rejection.
    this.ready.catch(() => {});
    return this.ready;
  }
  choose(directory, signal) {
    if (this.platform !== 'win32') throw new Error('Выбор изображения доступен только в Windows');
    if (signal?.aborted) throw abortedDialog();
    const ready = this.start(), child = this.child;
    const completion = (async () => {
      await ready;
      if (signal?.aborted) throw abortedDialog();
      if (this.pending) throw new Error('Окно выбора изображения уже открыто');
      return new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        try {
          this.child.stdin.write(Buffer.from(directory, 'utf8').toString('base64') + '\n', error => {
            if (error && this.pending) { this.pending = null; reject(error); }
          });
        } catch (error) { this.pending = null; reject(error); }
      });
    })();
    const abort = () => this.child?.kill();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const result = completion.catch(error => { if (signal?.aborted) throw abortedDialog(); throw error; }).finally(async () => {
      signal?.removeEventListener('abort', abort);
      // Native common dialogs can retain modal window state across calls.
      // Replace the helper after each selection so the next click gets a fresh,
      // already initialized STA process and no native dialog exists meanwhile.
      if (!this.closed) {
        try {
          if (this.child === child) await this.stopCurrent();
          if (!this.closed) await this.start();
        } catch {
          // Warmup is for the next click. A failed replacement must not turn
          // the completed FILE/CANCEL response into an error for this click.
          if (this.child) await this.stopCurrent().catch(() => {});
        }
      }
    });
    result.child = child;
    return result;
  }
  async stopCurrent() {
    const child = this.child;
    if (!child) return;
    const childClosed = this.childClosed;
    // An active ShowDialog cannot read STOP. Kill only in that case.
    if (this.pending) child.kill();
    else { try { child.stdin.write('STOP\n'); } catch { child.kill(); } }
    const timer = setTimeout(() => child.kill(), 2000); timer.unref?.();
    try { await childClosed; } finally { clearTimeout(timer); }
  }
  async shutdown() { this.closed = true; await this.stopCurrent(); }
}
class MediaPicker {
  constructor(queue) { this.queue = queue; this.tokens = new Map(); this.dialogWorker = new WindowsDialogWorker(); this.openDialog = (directory, signal) => this.dialogWorker.choose(directory, signal); this.dialogBusy = false; this.dialogChild = null; this.dialogPromise = null; this.dialogAbort = null; }
  warmup() { return this.dialogWorker.start(); }
  context(jobId, revision, attemptNumber) {
    const job = this.queue.get(jobId), attempt = job.attempts.find(item => item.number === attemptNumber);
    if (!attempt) throw conflict('Попытка шага 3 не найдена');
    if (this.queue.pageBuilder.read(jobId, { attempt: attemptNumber }).revision !== revision) throw conflict('Данные шага 3 изменились; откройте редактор снова');
    if (!attempt?.htmlMedia?.revision) throw new Error('В текущей попытке ещё нет медиа шага 2');
    return { job, attempt, revision: attempt.htmlMedia.revision };
  }
  resolve(jobId, ref, url) {
    provenance(ref);
    const job = this.queue.get(jobId), attempt = job.attempts.find(item => item.number === ref.attempt);
    if (!attempt) throw new Error('Попытка медиа не найдена');
    const dir = this.queue.stage.media.directory(job, attempt, ref.revision);
    const manifest = JSON.parse(readChecked(this.queue.root, path.join(dir, 'manifest.json'), 24 * 1024 * 1024));
    if (manifest.jobId !== job.id || manifest.attempt !== ref.attempt || manifest.revision !== ref.revision) throw new Error('Происхождение manifest изменено');
    detectLegacyImages(this.queue.root, dir, manifest.resources, this.queue.stage.media.limits.maxFileBytes);
    const item = manifest.resources.find(item => item.status === 'downloaded' && extensions[mediaMime(item)] && item.sha256 === ref.sha256 && filename(item) === ref.filename && (!url || [item.originalUrl, item.resolvedUrl, item.finalUrl].includes(url)));
    if (!item || item.object !== `objects/${ref.sha256}`) throw new Error('Изображение не входит в manifest шага 2');
    const bytes = readChecked(this.queue.root, path.join(dir, item.object), this.queue.stage.media.limits.maxFileBytes);
    if (bytes.length !== item.bytes || hash(bytes) !== ref.sha256 || !verifiedRasterMime(item, bytes)) throw new Error('Изображение изменено или не соответствует SHA/MIME');
    return { bytes, mime: mediaMime(item), url: item.resolvedUrl || item.originalUrl, dir };
  }
  selectionContext(jobId, request) {
    if (this.closed || this.queue.closing) throw conflict('Приложение завершает работу; выбор изображения недоступен');
    if (!request || Object.keys(request).sort().join(',') !== 'attempt,htmlRevision,revision' || !Object.values(request).every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Разрешены только revision, attempt и htmlRevision');
    const context = this.context(jobId, request.revision, request.attempt);
    if (context.attempt.number !== request.attempt || context.revision !== request.htmlRevision) throw conflict('Попытка или HTML шага 2 изменились; откройте редактор снова');
    const { job, attempt, revision } = context, dir = this.queue.stage.media.directory(job, attempt);
    const manifestBytes = readChecked(this.queue.root, path.join(dir, 'manifest.json'), 24 * 1024 * 1024);
    const manifest = JSON.parse(manifestBytes);
    if (manifest.jobId !== job.id || manifest.attempt !== attempt.number || manifest.revision !== revision) throw conflict('Медиа шага 2 изменились; откройте редактор снова');
    const legacyImages = detectLegacyImages(this.queue.root, dir, manifest.resources, this.queue.stage.media.limits.maxFileBytes);
    return { job, attempt, revision, dir, manifest, legacyImages, manifestHash: hash(manifestBytes) };
  }
  assertCurrent(jobId, request, selected) {
    const current = this.context(jobId, request.revision, request.attempt);
    if (current.attempt.number !== selected.attempt.number || current.revision !== selected.revision || hash(readChecked(this.queue.root, path.join(selected.dir, 'manifest.json'), 24 * 1024 * 1024)) !== selected.manifestHash) throw conflict('Медиа шага 2 изменились; откройте редактор снова');
  }
  async pickPrepared(jobId, request, requestSignal) {
    const selected = this.selectionContext(jobId, request);
    this.assertCurrent(jobId, request, selected);
    if (requestSignal?.aborted) throw abortedDialog();
    this.queue.stage.media.prepareLegacyImages(selected.job, selected.attempt, selected.legacyImages);
    const target = path.join(selected.dir, 'images');
    if (!fs.existsSync(target)) throw new Error('Папка изображений не найдена; откройте редактор снова');
    const directory = checkedPath(this.queue.root, target);
    if (!fs.statSync(directory).isDirectory()) throw new Error('Папка изображений не найдена; откройте редактор снова');
    this.assertCurrent(jobId, request, selected);
    if (this.dialogBusy) throw conflict('Окно выбора изображения уже открыто');
    if (requestSignal?.aborted) throw abortedDialog();
    this.dialogBusy = true;
    const controller = new AbortController(); this.dialogAbort = controller;
    const abort = () => controller.abort();
    requestSignal?.addEventListener('abort', abort, { once: true });
    try {
      if (requestSignal?.aborted) controller.abort();
      const dialog = this.openDialog(directory, controller.signal);
      this.dialogChild = dialog?.child || null;
      this.dialogPromise = Promise.resolve(dialog);
      const file = await this.dialogPromise;
      if (controller.signal.aborted) throw abortedDialog();
      if (!file) return { cancelled: true };
      if (path.dirname(path.resolve(file)).toLowerCase() !== directory.toLowerCase()) throw new Error('Выберите файл из папки изображений шага 2');
      const bytes = readChecked(directory, file, this.queue.stage.media.limits.maxFileBytes);
      this.assertCurrent(jobId, request, selected);
      return this.choose(jobId, request, path.basename(file), bytes);
    } catch (error) {
      if (controller.signal.aborted) throw abortedDialog();
      throw error;
    } finally {
      requestSignal?.removeEventListener('abort', abort);
      this.dialogChild = null; this.dialogPromise = null; this.dialogAbort = null; this.dialogBusy = false;
    }
  }
  choose(jobId, request, name, bytes) {
    const selected = this.selectionContext(jobId, request);
    if (typeof name !== 'string' || !/^[\p{L}\p{N}_-]+\.(png|jpg|gif|webp|avif|bmp)$/u.test(name) || name.length > 100) throw new Error('Файл не входит в список изображений шага 2');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > this.queue.stage.media.limits.maxFileBytes) throw new Error('Размер выбранного изображения недопустим');
    const item = selected.manifest.resources.find(value => value.status === 'downloaded' && extensions[mediaMime(value)] && filename(value) === name);
    if (!item) throw new Error('Файл не входит в список изображений шага 2');
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256 || !verifiedRasterMime(item, bytes)) throw new Error('Выбранное изображение не совпадает с медиа шага 2');
    const ref = { attempt: selected.attempt.number, revision: selected.revision, sha256: item.sha256, filename: name };
    const verified = this.resolve(jobId, ref);
    this.assertCurrent(jobId, request, selected);
    const token = crypto.randomBytes(32).toString('hex');
    for (const [key, value] of this.tokens) if (value.expires < Date.now()) this.tokens.delete(key);
    while (this.tokens.size >= 100) this.tokens.delete(this.tokens.keys().next().value);
    this.tokens.set(token, { jobId, ref, revision: request.revision, expires: Date.now() + 60 * 60 * 1000 });
    return { cancelled: false, media: ref, url: verified.url, preview: `/api/page-builder/${jobId}/selection/${token}` };
  }
  async shutdown() {
    this.closed = true; this.tokens.clear();
    // Mark the worker closed before abort settles dialogPromise: its finally
    // must not start a replacement helper while shutdown is waiting.
    const workerStopped = this.dialogWorker.shutdown();
    this.dialogAbort?.abort();
    await this.dialogPromise?.catch(() => {});
    await workerStopped;
  }
  preview(jobId, token) {
    const entry = this.tokens.get(token);
    if (!entry || entry.jobId !== jobId || entry.expires < Date.now()) throw new Error('Предпросмотр устарел; выберите изображение снова');
    const current = this.context(jobId, entry.revision, entry.ref.attempt);
    if (current.attempt.number !== entry.ref.attempt || current.revision !== entry.ref.revision) throw conflict('Медиа шага 2 изменились');
    return this.resolve(jobId, entry.ref);
  }
  validateDocument(jobId, document, previous, attemptNumber) {
    const old = new Set([previous.common, ...previous.tabs].flatMap(section => section.blocks.flatMap(block => block.media.flatMap(asset => ['original', 'big'].filter(kind => asset[`${kind}Media`]).map(kind => JSON.stringify([asset[`${kind}Media`], asset[`${kind}Url`]]))))));
    for (const section of [document.common, ...document.tabs]) for (const block of section.blocks) for (const asset of block.media) for (const kind of ['original', 'big']) {
      const ref = asset[`${kind}Media`]; if (!ref) continue;
      this.resolve(jobId, ref, asset[`${kind}Url`]);
      if (!old.has(JSON.stringify([ref, asset[`${kind}Url`]]))) {
        const attempt = this.queue.get(jobId).attempts.find(item => item.number === attemptNumber);
        if (attempt.number !== ref.attempt || attempt.htmlMedia?.revision !== ref.revision) throw conflict('Выбранное изображение относится к устаревшей попытке или HTML');
      }
    }
  }
}
module.exports = { MediaPicker, WindowsDialogWorker, provenance, checkedPath, filename, extensions };
