'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { readChecked } = require('../../infrastructure/media.cjs');
const { assetResolvers } = require('./assets.cjs');
const { computeSorts, indexSorts, sectionKey } = require('./sorts.cjs');
const keyOf = (kind, id) => `${kind}:${id}`;
const validId = id => Number.isSafeInteger(id) && id > 0;
const emptyBindings = () => ({ tabs: {}, blocks: {}, content: {}, media: {}, files: {} });
const hasStoredSorts = sorts => !!(sorts && (Object.keys(sorts.tabs || {}).length
  || Object.values(sorts.sections || {}).some(list => list && typeof list === 'object' && Object.keys(list).length)));

// Transport/destination guards and binary spooling are shared with the legacy
// journal reader; only object operations can be sent by this queue.
module.exports = (Base, { desired, digest, legacyId, snapshotAssets, withoutReview }) => class BegetSync extends Base {
  record(jobId, attempt) {
    const key = this.key(jobId, attempt); if (this.records.has(key)) return this.records.get(key);
    const file = this.file(jobId);
    const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
      version: 2, jobId, scopeId: key, acknowledged: null, inFlight: null, company: null,
      pending: {}, lastError: '', failures: 0, nextAt: 0
    };
    if (![1, 2].includes(value.version) || value.jobId !== jobId || value.scopeId !== key) throw new Error('Повреждена очередь синхронизации Beget');
    if (value.version === 1) {
      // Preserve the original bytes, including any unresolved immutable flight.
      // Never replay the old whole-page request after migrating the journal.
      const backup = `${file}.v1-backup`;
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      value.version = 2; value.pending = {};
      if (value.inFlight) value.inFlight.legacySnapshot = true;
      this.persist(value);
    }
    // A journal from before sticky sorts carries no sorts at all; treat it as
    // empty history. The first enqueue fills the real values and rebases the
    // old index-based receipts, so nothing is re-sent for the migration alone.
    if (!value.sorts || typeof value.sorts !== 'object' || Array.isArray(value.sorts)) value.sorts = { tabs: {}, sections: {} };
    if (!value.pending || typeof value.pending !== 'object' || Array.isArray(value.pending)) throw new Error('Повреждена объектная очередь Beget');
    this.records.set(key, value); return value;
  }
  objects(record, document) {
    const sorts = computeSorts(record.sorts || null, document), target = desired(document, sorts), result = {};
    document.tabs.forEach(tab => { result[keyOf('tabs', tab.id)] = {
      kind: 'tabs', localId: tab.id, hash: target.tabs[tab.id], sort: sorts.tabs[tab.id],
      section: null, data: { id: tab.id, title: tab.title }
    }; });
    [document.common, ...document.tabs].forEach(section => {
      const key = sectionKey(document, section);
      section.blocks.forEach(block => {
        result[keyOf('blocks', block.id)] = { kind: 'blocks', localId: block.id,
          hash: target.blocks[block.id], sort: sorts.sections[key][block.id],
          contentHash: digest(withoutReview(block)),
          section: section === document.common ? null : section.id, data: structuredClone(block) };
      });
    });
    return result;
  }
  enqueue(jobId, attempt, document, documentRevision) {
    const record = this.record(jobId, attempt), ack = record.acknowledged;
    if (this.queue.get(jobId).attempts.at(-1).number !== attempt) return record;
    const sorts = computeSorts(record.sorts || null, document), objects = this.objects(record, document);
    // A journal written before sticky sorts hashed `sort` as the list index.
    // Rebase the matching receipts once so adopting an old journal does not
    // phantom-update every already synchronized object.
    let rebased = false;
    if (!hasStoredSorts(record.sorts) && ack) {
      const legacy = desired(document, indexSorts(document));
      for (const object of Object.values(objects)) {
        const received = ack[object.kind]?.[object.localId];
        if (received !== undefined && received === legacy[object.kind]?.[object.localId] && received !== object.hash) {
          ack[object.kind][object.localId] = object.hash; rebased = true;
        }
      }
      if (rebased) ack.hash = digest({ tabs: ack.tabs, blocks: ack.blocks });
    }
    let learnedContent = false;
    const pending = {};
    for (const [key, object] of Object.entries(objects)) {
      const flight = record.inFlight;
      const uncertain = flight?.legacySnapshot || flight?.key === key;
      if (ack?.[object.kind]?.[object.localId] === object.hash && !uncertain) {
        // A matching legacy hash proves the raw draft belongs to the receipt;
        // seed the content-only hash so later moves do not rewrite its content.
        if (object.kind === 'blocks' && ack.blockContent?.[object.localId] !== object.contentHash) {
          ack.blockContent ||= {}; ack.blockContent[object.localId] = object.contentHash; learnedContent = true;
        }
        continue;
      }
      const previous = record.pending[key], unchanged = previous?.hash === object.hash && previous.attempt === attempt;
      pending[key] = { ...object, action: validId(ack?.bindings?.[object.kind]?.[object.localId])
        ? object.kind === 'blocks' && ack.blockContent?.[object.localId] === object.contentHash ? 'move' : 'update' : 'create',
        attempt, documentRevision, ...(unchanged ? { failures: previous.failures || 0, nextAt: previous.nextAt || 0, lastError: previous.lastError || '', blocked: previous.blocked || false } : {}) };
    }
    for (const kind of ['blocks', 'tabs']) {
      const ids = new Set(Object.keys(ack?.[kind] || {}));
      if (record.inFlight?.target && !record.inFlight.legacySnapshot && record.inFlight.target.kind === kind) ids.add(record.inFlight.target.localId);
      for (const id of ids) {
        const key = keyOf(kind, id); if (objects[key]) continue;
        const previous = record.pending[key];
        pending[key] = { kind, localId: id, action: 'delete', hash: null, section: null, attempt, documentRevision,
          ...(previous?.action === 'delete' ? { failures: previous.failures || 0, nextAt: previous.nextAt || 0, lastError: previous.lastError || '', blocked: previous.blocked || false } : {}) };
      }
    }
    const sortsChanged = JSON.stringify(record.sorts || null) !== JSON.stringify(sorts);
    record.sorts = sorts;
    if (JSON.stringify(record.pending) !== JSON.stringify(pending) || learnedContent || sortsChanged || rebased) { record.pending = pending; this.persist(record); }
    return record;
  }
  mayBeChangedByFlight(record, kind, id) {
    const flight = record.inFlight; if (!flight?.applyStarted) return false;
    return flight.legacySnapshot ? super.mayBeChangedByFlight(record, kind, id) : flight.target.kind === kind && flight.target.localId === id;
  }
  projection(jobId, attempt, document) {
    const result = super.projection(jobId, attempt, document), record = this.record(jobId, attempt);
    for (const kind of ['tabs', 'blocks']) for (const [id, state] of Object.entries(result[kind])) {
      const entry = record.pending[keyOf(kind, id)]; if (entry?.lastError) state.error = entry.lastError;
    }
    // Deleted objects still count while a create/delete receipt is unresolved,
    // including a create whose ID has not yet reached this machine.
    const absent = new Set();
    for (const kind of ['tabs', 'blocks']) for (const id of Object.keys(record.acknowledged?.[kind] || {})) {
      if (!Object.hasOwn(result[kind], id)) absent.add(keyOf(kind, id));
    }
    for (const [key, entry] of Object.entries(record.pending)) if (entry.attempt === attempt && !Object.hasOwn(result[entry.kind], entry.localId)) absent.add(key);
    result.pendingCount = Object.values(result.tabs).concat(Object.values(result.blocks)).filter(state => state.status !== 'synced').length + absent.size;
    result.lastError ||= Object.values(record.pending).find(entry => entry.lastError)?.lastError || '';
    result.version = digest({ base: result.version, pending: record.pending });
    return result;
  }
  currentObject(record, flight) {
    if (this.closed || this.queue.get(record.jobId).attempts.at(-1)?.number !== flight.attempt) return false;
    const page = this.queue.pageBuilder.read(record.jobId, { attempt: flight.attempt, create: false });
    if (!page?.syncRequested) return false;
    const object = this.objects(record, page.document)[flight.key];
    return flight.target.action === 'delete' ? !object : object?.hash === flight.target.hash;
  }
  refresh(record) {
    const attempt = this.queue.get(record.jobId).attempts.at(-1).number;
    const page = this.queue.pageBuilder.read(record.jobId, { attempt, create: false });
    if (page?.syncRequested) this.enqueue(record.jobId, attempt, page.document, page.revision);
  }
  acknowledge(record, result) {
    this.assertDestination(record); const flight = record.inFlight;
    if (flight?.legacySnapshot) {
      super.acknowledge(record, result);
      if (result.block_tabs) { record.acknowledged.blockTabs = result.block_tabs; this.persist(record); }
      this.refresh(record); return;
    }
    if (!flight || result.operation_id !== flight.operationId || result.epoch !== flight.attempt
      || result.revision !== flight.baseRevision + 1 || !/^[a-f0-9]{64}$/.test(result.fingerprint || '') || !result.bindings
      || result.object?.kind !== (flight.target.kind === 'tabs' ? 'tab' : 'block')
      || result.object?.local_id !== flight.target.localId || result.object?.action !== flight.target.action) throw new Error('Подтверждение Beget не соответствует отправленной операции');
    const target = flight.target;
    if (!validId(result.object.id) || target.action !== 'create' && result.object.id !== flight.object.id
      || target.action !== 'delete' && result.bindings[target.kind]?.[target.localId] !== result.object.id
      || target.action === 'delete' && Object.hasOwn(result.bindings[target.kind] || {}, target.localId)) throw new Error('Beget не подтвердил ID объекта');
    const ack = record.acknowledged || { tabs: {}, blocks: {}, bindings: emptyBindings(), assets: { media: {}, files: {} }, blockTabs: {} };
    if (target.action === 'delete') {
      delete ack[target.kind][target.localId];
      if (target.kind === 'blocks') { delete ack.blockTabs?.[target.localId]; delete ack.blockContent?.[target.localId]; }
    } else {
      ack[target.kind][target.localId] = target.hash;
      if (target.kind === 'blocks') { ack.blockContent ||= {}; ack.blockContent[target.localId] = target.contentHash; }
    }
    Object.assign(ack, { attempt: flight.attempt, revision: result.revision, fingerprint: result.fingerprint,
      bindings: result.bindings, documentRevision: flight.documentRevision });
    ack.assets ||= { media: {}, files: {} };
    const assets = snapshotAssets({ media: flight.object.media, files: flight.object.files });
    Object.assign(ack.assets.media, assets.media); Object.assign(ack.assets.files, assets.files);
    ack.blockTabs ||= {};
    if (result.block_tabs) Object.assign(ack.blockTabs, result.block_tabs);
    else if (target.kind === 'blocks' && target.action !== 'delete') ack.blockTabs[target.localId] = flight.object.tab_id || 0;
    ack.hash = digest({ tabs: ack.tabs, blocks: ack.blocks }); record.acknowledged = ack;
    record.inFlight = null; record.lastError = ''; record.failures = 0; record.nextAt = 0;
    this.persist(record); this.cleanupBlobs(record); this.refresh(record);
  }
  async upload(record, identity) {
    const flight = record.inFlight;
    for (const asset of flight.uploads || []) {
      const bytes = readChecked(this.queue.root, path.join(this.root, record.jobId, 'blobs', asset.sha256), 256 * 1024 * 1024);
      if (bytes.length !== asset.size || crypto.createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Локальная копия отправляемого файла повреждена');
      let offset = 0;
      while (offset < bytes.length) {
        if (this.closed) return false;
        const response = await this.request('upload_chunk', { ...identity, epoch: flight.attempt, asset, offset, base64: bytes.subarray(offset, offset + 384 * 1024).toString('base64') }, record);
        if (response.sha256 !== asset.sha256 || !Number.isSafeInteger(response.offset) || response.offset <= offset || response.offset > bytes.length || response.complete !== (response.offset === bytes.length)) throw new Error('Beget не подтвердил полученную часть файла');
        offset = response.offset;
        if (!flight.applyStarted && !this.currentObject(record, flight)) { record.inFlight = null; this.persist(record); this.refresh(record); return false; }
      }
    }
    return true;
  }
  async reconcile(record, identity) {
    const flight = record.inFlight;
    const status = await this.request('operation_status', { ...identity, epoch: flight.attempt, operation_id: flight.operationId }, record);
    if (status.state === 'applied') { this.acknowledge(record, status.result); return; }
    if (['in_progress', 'requires_reconciliation'].includes(status.state)) {
      record.lastError = 'Результат отправки не подтверждён; требуется сверка с Beget'; record.nextAt = this.clock() + 30000; this.persist(record); return;
    }
    if (status.state === 'failed') {
      const entry = record.pending[flight.key];
      if (entry && entry.hash === flight.target.hash) { entry.lastError = status.result?.error?.message || 'Сервер отменил операцию синхронизации'; entry.blocked = status.result?.error?.retryable !== true; }
      record.inFlight = null; this.persist(record); this.refresh(record); return;
    }
    if (status.state !== 'not_found') throw new Error('Неизвестный результат сверки Beget');
    // A not_found receipt permits replacing an unsent operation, never an
    // unresolved/in-progress operation. The old snapshot is never replayed.
    if (flight.legacySnapshot || flight.rejected || !this.currentObject(record, flight)) {
      if (flight.rejected) { const entry = record.pending[flight.key]; if (entry?.hash === flight.target.hash) entry.blocked = true; }
      record.inFlight = null; record.nextAt = 0; this.persist(record); this.cleanupBlobs(record); this.refresh(record); return;
    }
    await this.sendFlight(record, identity);
  }
  ready(record, entry) {
    if (entry.blocked || (entry.nextAt || 0) > this.clock()) return false;
    const bindings = record.acknowledged?.bindings || emptyBindings();
    if (entry.kind === 'blocks' && entry.action !== 'delete' && entry.section && !validId(bindings.tabs[entry.section])) return false;
    if (entry.kind === 'tabs' && entry.action === 'delete') {
      const tabId = bindings.tabs[entry.localId];
      // Moves out of this tab must finish too; the server also refuses a tab
      // deletion while any block (including foreign blocks) still belongs to it.
      if (Object.entries(record.acknowledged?.blockTabs || {}).some(([id, parent]) => Number(parent) === tabId && validId(bindings.blocks[id]))) return false;
    }
    return true;
  }
  async freeze(record, entry, remote) {
    const bindings = record.acknowledged?.bindings || emptyBindings(), kind = entry.kind === 'tabs' ? 'tab' : 'block';
    const object = { kind, action: entry.action, local_id: entry.localId };
    if (entry.action !== 'create') {
      object.id = bindings[entry.kind]?.[entry.localId];
      if (!validId(object.id)) throw new Error('Не подтверждён Bitrix ID изменяемого объекта');
    }
    if (kind === 'block') {
      object.tab_id = entry.section ? bindings.tabs[entry.section] : null;
      if (entry.action !== 'create') {
        const parent = record.acknowledged?.blockTabs?.[entry.localId];
        if (!Number.isSafeInteger(parent) || parent < 0) throw new Error('Не подтверждена принадлежность блока вкладке; требуется сверка');
        object.previous_tab_id = parent || null;
        if (entry.action === 'delete') object.tab_id = parent || null;
      }
    }
    let serialized = { media: [], files: [] };
    if (entry.action !== 'delete') {
      if (kind === 'tab') object.value = { local_id: entry.localId, name: entry.data.title, sort: entry.sort, parent_local_id: null };
      else if (entry.action === 'move') object.value = { local_id: entry.localId, tab_local_id: entry.section, sort: entry.sort };
      else {
        const serialize = this.serialize || require('./serialize.cjs').serialize;
        serialized = await serialize({ common: { blocks: [entry.data] }, tabs: [] }, {
          ...assetResolvers(this.queue, record.jobId), bindings, acknowledgedAssets: record.acknowledged?.assets
        });
        object.value = { ...serialized.blocks[0], tab_local_id: entry.section, sort: entry.sort };
        delete object.value.id; object.media = serialized.media; object.files = serialized.files;
      }
    }
    // Serialization may await file reads. A newer save cancels this freeze.
    const flight = { operationId: crypto.randomUUID(), key: keyOf(entry.kind, entry.localId),
      attempt: entry.attempt, documentRevision: entry.documentRevision, target: structuredClone(entry),
      baseRevision: remote.revision, baseFingerprint: remote.fingerprint, object, applyStarted: false };
    if (!this.currentObject(record, flight)) return false;
    flight.uploads = this.spool(record, serialized);
    record.inFlight = flight; this.persist(record); return true;
  }
  async sendFlight(record, identity) {
    const flight = record.inFlight;
    if (!await this.upload(record, identity)) return;
    if (!this.currentObject(record, flight) && !flight.applyStarted) { record.inFlight = null; this.persist(record); this.cleanupBlobs(record); this.refresh(record); return; }
    flight.applyStarted = true; this.persist(record);
    let response;
    try { response = await this.request('apply_object', { ...identity, epoch: flight.attempt, operation_id: flight.operationId,
      base_revision: flight.baseRevision, base_fingerprint: flight.baseFingerprint, object: flight.object }, record); }
    catch (error) { if (error.remote && !error.retryable) { flight.rejected = true; this.persist(record); } throw error; }
    this.acknowledge(record, response);
  }
  async state(record, identity, attempt) {
    const remote = await this.request('state', { ...identity, epoch: attempt }, record), ack = record.acknowledged;
    if (!Number.isSafeInteger(remote.revision) || remote.revision < 0 || !/^[a-f0-9]{64}$/.test(remote.fingerprint || '')) throw new Error('Некорректное состояние Beget');
    if (remote.live_fingerprint && remote.live_fingerprint !== remote.fingerprint
      || ack && (remote.revision !== ack.revision || remote.fingerprint !== ack.fingerprint)) {
      throw Object.assign(new Error('Страница Beget изменена извне; требуется сверка'), { externalConflict: true });
    }
    if (ack && ack.attempt !== attempt && !record.inFlight
      && this.queue.get(record.jobId).attempts.at(-1).number === attempt) {
      const page = this.queue.pageBuilder.read(record.jobId, { attempt, create: false });
      if (page?.syncRequested) {
        const fail = () => { throw Object.assign(new Error('Beget не подтвердил принадлежность прежних объектов; требуется сверка'), { externalConflict: true }); };
        if (remote.live_fingerprint !== remote.fingerprint || !remote.bindings || !remote.block_tabs) fail();
        // A receipt from an older attempt is only reusable after read-only
        // confirmation of the same server revision, IDs and owned parent tabs.
        for (const kind of ['tabs', 'blocks']) for (const [id, bitrixId] of Object.entries(ack.bindings?.[kind] || {})) {
          if (!validId(bitrixId) || remote.bindings[kind]?.[id] !== bitrixId) fail();
        }
        const objects = this.objects(record, page.document);
        for (const [id, bitrixId] of Object.entries(ack.bindings?.blocks || {})) {
          const parent = remote.block_tabs[id];
          if (!Number.isSafeInteger(parent) || parent < 0
            || parent > 0 && !Object.values(remote.bindings.tabs || {}).includes(parent)) fail();
          if (ack.blockTabs?.[id] !== undefined && ack.blockTabs[id] !== parent) fail();
          const object = objects[keyOf('blocks', id)];
          if (object && object.hash === ack.blocks[id]) {
            const expectedParent = object.section ? ack.bindings.tabs?.[object.section] : 0;
            if (parent !== expectedParent) fail();
          }
        }
        ack.attempt = attempt;
        ack.confirmedByState = { attempt, revision: remote.revision, fingerprint: remote.fingerprint, documentRevision: page.revision };
        this.persist(record);
      }
    }
    if (ack && remote.block_tabs) { ack.blockTabs = remote.block_tabs; this.persist(record); }
    return remote;
  }
  async drain() {
    const destinationError = this.destinationFailure();
    if (destinationError) { this.connection = 'error'; this.lastError = destinationError; return; }
    for (const job of this.queue.jobs) {
      if (this.closed) return;
      const attempt = job.attempts.at(-1); let record;
      try {
        this.queue.stage.media?.deletion.assertReady();
        const page = this.queue.pageBuilder.read(job.id, { attempt: attempt.number, create: false }); if (!page) continue;
        record = this.record(job.id, attempt.number);
        if (!page.syncRequested || !['complete', 'ready_with_issues'].includes(attempt.htmlMedia?.status)) continue;
        this.enqueue(job.id, attempt.number, page.document, page.revision);
        if (record.nextAt > this.clock()) continue;
        this.assertDestination(record);
        if (!record.company) {
          const oldId = legacyId(job.url), response = await this.request('lookup_company', { old_id: String(oldId) }, record);
          if (!validId(response.company?.id) || Number(response.company.old_id) !== oldId) throw new Error('Неоднозначный или некорректный ответ поиска компании');
          record.company = response.company; this.persist(record);
        }
        const identity = { company_id: record.company.id, scope_id: record.scopeId };
        // Resolve an interrupted operation before looking at any newer object.
        if (record.inFlight) { await this.reconcile(record, identity); continue; }
        // Identical objects are absent from the write outbox. A new attempt
        // still needs a state receipt before those hashes can unlock review.
        if (record.acknowledged && record.acknowledged.attempt !== attempt.number) await this.state(record, identity, attempt.number);
        const tried = new Set();
        while (!this.closed && job.attempts.at(-1).number === attempt.number) {
          this.refresh(record);
          const entries = Object.entries(record.pending).filter(([key, entry]) => !tried.has(key) && this.ready(record, entry))
            .sort(([, a], [, b]) => {
              const rank = item => item.action === 'delete' ? item.kind === 'blocks' ? 0 : 3 : item.kind === 'tabs' ? 1 : 2;
              return rank(a) - rank(b);
            });
          if (!entries.length) break;
          const [key, entry] = entries[0]; tried.add(key);
          try {
            const remote = await this.state(record, identity, attempt.number);
            if (await this.freeze(record, entry, remote)) await this.sendFlight(record, identity);
          } catch (error) {
            const pending = record.pending[key];
            if (pending?.hash === entry.hash) {
              pending.lastError = error.message; pending.failures = (pending.failures || 0) + 1;
              pending.nextAt = this.clock() + Math.min(60000, 1000 * 2 ** Math.min(pending.failures, 6));
              if (error.code === 'BEGET_SERIALIZE') pending.blocked = true;
            }
            record.lastError = error.message; this.persist(record);
            // An uncertain commit blocks newer operations until its receipt is
            // resolved. A local validation error only blocks its own object.
            if (record.inFlight || error.externalConflict || this.connection === 'offline' || error.transportKind) throw error;
          }
        }
        if (!record.inFlight && !Object.keys(record.pending).length) { record.lastError = ''; record.nextAt = 0; this.persist(record); }
      } catch (error) {
        if (record) {
          record.lastError = error.message; record.failures = (record.failures || 0) + 1;
          record.nextAt = this.clock() + Math.min(60000, 1000 * 2 ** Math.min(record.failures, 6)); this.persist(record);
        } else { this.lastError = error.message; this.connection = 'error'; }
        if (error.code === 'BEGET_DESTINATION') { this.connection = 'error'; this.lastError = error.message; return; }
        if (this.connection === 'offline' || ['authorization', 'configuration'].includes(error.transportKind)) return;
      }
    }
    if (!this.closed && (this.lastContactAt === undefined || this.clock() - this.lastContactAt >= 30000)) {
      try { await this.request('ping'); } catch { /* request updates connectivity */ }
    }
  }
};
