'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { safeFile, readJson } = require('../../../infrastructure/files.cjs');
const { normalizeUrl } = require('../../../pipeline/url.cjs');
const { layout } = require('../paths.cjs');
const { slug } = require('./naming.cjs');
const { readPng } = require('./png.cjs');
function captureInventory(report) {
  const pick = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : null;
  const messages = values => Array.isArray(values) ? values.map(value => String(value).split(/\r?\n/)[0]) : [];
  const model = report.model;
  return {
    layout: model?.layout ?? null, root: model && Object.hasOwn(model, 'root') ? model.root : 'missing', viewport: report.viewport ?? null,
    groups: Array.isArray(model?.groups) ? model.groups.map(group => pick(group, ['id', 'labels', 'children', 'items'])) : null,
    segments: Array.isArray(report.segments) ? report.segments.map(segment => {
      const normalized = pick(segment, ['file', 'spec', 'chain', 'status', 'box', 'png', 'absent', 'empty', 'meaningful', 'overflow', 'overlays']);
      if (!normalized) return null;
      const resources = segment.resources || {};
      return { ...normalized, diagnostics: {
        issues: messages(segment.issues), error: segment.error ? messages([segment.error])[0] : null,
        fonts: resources.fonts && resources.fonts !== 'loaded' ? resources.fonts : null,
        images: Array.isArray(resources.images) ? resources.images.filter(item => !item?.ok).map(item => pick(item, ['src', 'original', 'complete', 'naturalWidth', 'ok'])) : [],
        frames: Array.isArray(resources.frames) ? resources.frames.map(item => pick(item, ['src', 'url', 'ok', 'reason', 'posterReady', 'loading', 'requiresVisualReview', 'text'])) : [],
      } };
    }) : null,
    errors: messages(report.errors),
  };
}

function captureCoverage(inventory, files) {
  const issues = [], expected = [];
  const fail = message => { throw new Error(message); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort());
  const semantic = spec => `${spec.kind}:${spec.group ?? ''}:${spec.index ?? ''}`;
  const add = (name, spec, chain, optional = false, empty = false) => expected.push({ name, spec, chain, optional, empty });
  try {
    if (!Array.isArray(inventory.groups) || !Array.isArray(inventory.segments)) fail('Нет полного model.groups/segments');
    if (inventory.layout === 'plain') {
      if (inventory.root !== null || inventory.groups.length) fail('Plain содержит root или группы вкладок');
      add('00_страница.png', { kind: 'page' }, []);
    } else if (inventory.layout === 'tabs') {
      const groups = new Map();
      for (const group of inventory.groups) {
        if (!group || !Number.isInteger(group.id) || group.id !== groups.size || groups.has(group.id)) fail('Некорректный или повторный id/index группы');
        if (!Array.isArray(group.labels) || !group.labels.length || !group.labels.every(label => typeof label === 'string') ||
            !Array.isArray(group.children) || group.children.length !== group.labels.length || !Array.isArray(group.items) || group.items.length !== group.labels.length) fail(`Группа ${group.id}: labels/children/items не соответствуют кнопкам`);
        let unmatched = false;
        for (let index = 0; index < group.labels.length; index++) {
          const item = group.items[index], children = group.children[index];
          if (!item || !['pane', 'neighbor', 'empty'].includes(item.mode) || typeof item.empty !== 'boolean' || item.empty !== (item.mode === 'empty')) fail(`Группа ${group.id}: некорректный mode/empty кнопки ${index}`);
          if (!Array.isArray(children) || children.length > 1 || !children.every(id => Number.isInteger(id) && id >= 0) || (item.mode !== 'pane' && children.length)) fail(`Группа ${group.id}: некорректная вложенность кнопки ${index}`);
          if (item.mode === 'pane' && unmatched) fail(`Группа ${group.id}: не завершающая unmatched кнопка`);
          if (item.mode !== 'pane') unmatched = true;
        }
        if (group.items[0].mode !== 'pane' || (group.items.some(item => item.mode === 'neighbor') && group.items.filter(item => item.mode !== 'pane').length !== 1)) fail(`Группа ${group.id}: неподдержанное сопоставление панелей`);
        groups.set(group.id, group);
      }
      if (!Number.isInteger(inventory.root) || !groups.has(inventory.root)) fail('Некорректный root');
      const owners = new Map();
      for (const group of groups.values()) for (const children of group.children) for (const child of children) {
        if (!groups.has(child) || owners.has(child)) fail('Неизвестная группа или несколько владельцев вложенной группы');
        owners.set(child, group.id);
      }
      if (owners.has(inventory.root)) fail('Root принадлежит другой группе или циклу');
      const first = [{ group: inventory.root, index: 0 }], visited = new Set();
      add('00_header.png', { kind: 'header' }, first);
      // Iterative traversal avoids recursion overflow on malformed/deep reports.
      const tasks = [{ id: inventory.root, numbers: [], labels: [], chain: [] }];
      while (tasks.length) {
        const task = tasks.pop();
        if (task.segment) { add(...task.segment); continue; }
        if (visited.has(task.id)) fail('Цикл или повторный обход группы');
        visited.add(task.id);
        const group = groups.get(task.id);
        for (let index = group.labels.length - 1; index >= 0; index--) {
          const numbers = [...task.numbers, String(index + 1).padStart(2, '0')], labels = [...task.labels, slug(group.labels[index])];
          const chain = [...task.chain, { group: group.id, index }], name = `${numbers.join('.')}_${labels.join('__')}`;
          if (group.children[index].length) {
            tasks.push({ segment: [name + '__продолжение.png', { kind: 'tail', group: group.id, index }, chain, true] });
            tasks.push({ id: group.children[index][0], numbers, labels, chain });
          }
          tasks.push({ segment: [name + '.png', { kind: 'tab', group: group.id, index }, chain, false, group.items[index].empty] });
        }
      }
      if (visited.size !== groups.size) fail('Недостижимая группа или изолированный цикл');
      add('99_footer.png', { kind: 'footer' }, first, true);
    } else fail('Неизвестный layout');
    const byKey = new Map(expected.map(segment => [semantic(segment.spec), segment])), seen = new Set(), names = new Set();
    let lastPosition = -1;
    for (const segment of inventory.segments) {
      if (!segment || !exactKeys(segment.spec, ['tab', 'tail'].includes(segment.spec?.kind) ? ['kind', 'group', 'index'] : ['kind'])) fail('Некорректный spec сегмента');
      const key = semantic(segment.spec), match = byKey.get(key);
      if (!match || seen.has(key)) fail('Посторонний или повторный semantic сегмент: ' + key);
      if (segment.spec.group !== match.spec.group || segment.spec.index !== match.spec.index) fail('Некорректные индексы spec: ' + key);
      const position = expected.indexOf(match);
      if (position <= lastPosition) fail('Неверный порядок сегментов: ' + key);
      lastPosition = position;
      seen.add(key);
      if (!Array.isArray(segment.chain) || !segment.chain.every(link => exactKeys(link, ['group', 'index']) && Number.isInteger(link.group) && Number.isInteger(link.index)) || !same(segment.chain.map(link => ({ group: link.group, index: link.index })), match.chain)) fail('Неверная chain сегмента: ' + key);
      if (segment.status === 'absent') {
        if (!match.optional || Object.hasOwn(segment, 'file') || Object.hasOwn(segment, 'png') || segment.absent !== true || segment.meaningful !== 0) fail('Недопустимый absent: ' + key);
        // Helper omits box for zero geometry, but may retain a positive rectangle
        // containing only empty space. Positive box alone does not imply content.
        if (Object.hasOwn(segment, 'box') && (!segment.box || !['x', 'y', 'width', 'height'].every(field => Number.isInteger(segment.box[field])) || segment.box.width <= 0 || segment.box.height <= 0)) fail('Некорректный box absent: ' + key);
        continue;
      }
      if (segment.absent === true || segment.file !== match.name || names.has(segment.file)) fail('Неверное/повторное имя PNG: ' + key);
      names.add(segment.file);
      if (!files.some(file => file.kind === 'png' && file.name === segment.file)) fail('Нет PNG сегмента: ' + key);
      if (match.empty && segment.empty !== true) fail('Пустая вкладка не отмечена в сегменте: ' + key);
      if (!['ok', 'incomplete', 'failed'].includes(segment.status)) fail('Неизвестный статус сегмента: ' + key);
    }
    for (const segment of expected) if (!seen.has(semantic(segment.spec))) issues.push('Отсутствует сегмент: ' + semantic(segment.spec));
    for (const file of files.filter(file => file.kind === 'png')) if (!names.has(file.name)) issues.push('Посторонний PNG: ' + file.name);
  } catch (error) { issues.push(error.message); }
  return { valid: issues.length === 0, expected, issues };
}

function inspectArtifacts(root, job, attempt, pngCache) {
  const locations = layout(root, job, attempt);
  const files = [];
  let report;
  try {
    report = readJson(safeFile(root, safeFile(locations.dir, locations.report)));
    files.push({ name: 'capture-report.json', kind: 'report' });
  } catch (error) { return { files, error: `Отчёт недоступен: ${error.message}` }; }
  const issues = [];
  try { if (normalizeUrl(report.url) !== job.url) issues.push('URL отчёта не совпадает с заданием'); }
  catch { issues.push('Недопустимый URL отчёта'); }
  try {
    if (new URL(normalizeUrl(report.finalUrl)).origin !== new URL(job.url).origin) throw new Error('invalid final URL');
  } catch { issues.push('Отсутствует корректный canonical finalUrl того же origin'); }
  if (!Array.isArray(report.segments) || !report.segments.length) return { files, report, error: 'В отчёте нет сегментов' };
  const expected = [];
  for (const segment of report.segments) {
    if (!segment || typeof segment !== 'object') { issues.push('Некорректный сегмент'); continue; }
    if (segment.status === 'absent' && !segment.file) continue;
    if (typeof segment.file !== 'string' || !/^[^/\\:<>"|?*\x00-\x1f]+\.png$/i.test(segment.file) || segment.file.startsWith('.')) {
      issues.push('Некорректное имя PNG'); continue;
    }
    if (expected.includes(segment.file)) { issues.push('Повтор имени PNG в отчёте'); continue; }
    expected.push(segment.file);
    try {
      const file = safeFile(root, safeFile(locations.dir, path.join(locations.hostDir, segment.file)));
      const { bytes, sha256, width, height } = pngCache ? pngCache.read(file) : readPng(file).png;
      files.push({ name: segment.file, kind: 'png', bytes, sha256, segmentStatus: segment.status, qaStatus: 'unreviewed' });
      if (![segment.png, segment.box].every(size => size && Number.isInteger(size.width) && Number.isInteger(size.height) && size.width === width && size.height === height)) issues.push(`${segment.file}: IHDR dimensions не соответствуют segment.png/box`);
      if (segment.png?.sha256 && (segment.png.sha256 !== sha256 || segment.png.bytes !== bytes)) issues.push(`${segment.file}: SHA-256/bytes не соответствуют capture checkpoint`);
    } catch (error) { issues.push(`${segment.file}: ${error.message}`); }
    if (segment.status !== 'ok') issues.push(`${segment.file}: статус ${segment.status}`);
  }
  if (!expected.length) issues.push('Нет ожидаемых PNG');
  if (report.status === 'complete' && (!Array.isArray(report.errors) || report.errors.length)) issues.push('Отчёт complete содержит ошибки или не имеет массива errors');
  let actualNames;
  try {
    actualNames = fs.readdirSync(locations.hostDir).filter(name => /\.png$/i.test(name)).sort();
    if (actualNames.some(name => !expected.includes(name))) issues.push('Есть PNG, не перечисленные в отчёте');
  } catch (error) { issues.push(error.message); }
  return { files, report, expected, issues, actualNames };
}

module.exports = { captureInventory, captureCoverage, inspectArtifacts };
