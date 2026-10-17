'use strict';

// Sticky SORT for Beget tabs and blocks. The sync journal (state.json) keeps
// the last computed sort of every object, so an untouched object keeps its sort
// and the desired hash of a block no longer depends on its neighbours. A pure
// move is then exactly one operation. Each list is solved independently: the
// tab order and every section's block order never renumber one another.

const LIMIT = 2147483647; // arm_int contract: SORT is strictly an integer in 0..2147483647.
const validSort = value => Number.isSafeInteger(value) && value >= 0 && value <= LIMIT;

// Previous order: ids with a usable stored sort, ordered by that sort. Equal
// sorts never occur in values written by this module and can only come from a
// damaged journal; the id tie-break keeps the function deterministic anyway.
function history(previous) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return [];
  return Object.entries(previous).filter(([, sort]) => validSort(sort))
    .sort(([left, first], [right, second]) => first - second || (left < right ? -1 : left > right ? 1 : 0));
}

// Longest common subsequence of the two id sequences. Its members keep their
// relative order in both the previous and the new list, which makes them the
// anchors that preserve their previous sort.
function subsequence(previous, next) {
  const suffix = Array.from({ length: previous.length + 1 }, () => new Array(next.length + 1).fill(0));
  for (let i = previous.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) {
    suffix[i][j] = previous[i] === next[j] ? suffix[i + 1][j + 1] + 1 : Math.max(suffix[i + 1][j], suffix[i][j + 1]);
  }
  const result = [];
  for (let i = 0, j = 0; i < previous.length && j < next.length;) {
    if (previous[i] === next[j]) { result.push(previous[i]); i++; j++; }
    else if (suffix[i + 1][j] >= suffix[i][j + 1]) i++;
    else j++;
  }
  return result;
}

// Sorts for a run of moved or new objects: evenly spaced strictly inside the
// neighbouring anchors, or the outermost decade beyond the first/last anchor.
// null means the gap or the arm_int range cannot fit the run and the whole
// list has to be renumbered.
function spread(before, after, count) {
  if (before === null && after === null) return null;
  if (before === null) {
    const first = after - 10 * count;
    return first >= 0 ? Array.from({ length: count }, (_, index) => first + 10 * index) : null;
  }
  if (after === null) {
    const last = before + 10 * count;
    return last <= LIMIT ? Array.from({ length: count }, (_, index) => before + 10 * (index + 1)) : null;
  }
  const step = Math.floor((after - before) / (count + 1));
  return step >= 1 ? Array.from({ length: count }, (_, index) => before + step * (index + 1)) : null;
}

const renumbered = ids => Object.fromEntries(ids.map((id, index) => [id, (index + 1) * 10]));

function computeList(previous, ids) {
  const order = history(previous), present = new Set(ids);
  const keep = new Set(subsequence(order.map(([id]) => id).filter(id => present.has(id)), ids));
  if (keep.size) {
    const stored = new Map(order);
    const values = ids.map(id => keep.has(id) ? stored.get(id) : undefined);
    let index = 0, fitted = true;
    while (index < ids.length) {
      if (values[index] !== undefined) { index++; continue; }
      let end = index;
      while (end < ids.length && values[end] === undefined) end++;
      const run = spread(index > 0 ? values[index - 1] : null, end < ids.length ? values[end] : null, end - index);
      if (!run) { fitted = false; break; }
      for (let offset = 0; offset < run.length; offset++) values[index + offset] = run[offset];
      index = end;
    }
    // Defence in depth: anything that is not a strictly increasing sequence of
    // valid integers falls back to renumbering this list by tens.
    if (fitted && values.every((sort, position) => validSort(sort) && (position === 0 || sort > values[position - 1]))) {
      return Object.fromEntries(ids.map((id, position) => [id, values[position]]));
    }
  }
  return renumbered(ids);
}

// The sorts journal keys a section by its role, never by its bare id: the
// common section always owns the fixed 'common' key whatever id its document
// carries, and every tab is prefixed, so ids the store accepts — a tab named
// 'common' next to a differently named common section — cannot collide and
// overwrite the other list. The block hash itself still uses the real id.
const sectionKey = (document, section) => section === document.common ? 'common' : `tab:${section.id}`;

function sections(document) {
  return [document.common, ...(document.tabs || [])].map(section => ({ key: sectionKey(document, section), blocks: section?.blocks || [] }));
}

// Pure and idempotent: computeSorts(computeSorts(previous, document), document)
// equals computeSorts(previous, document), so read paths can recompute the
// sorts freely without persisting them. Objects missing from the document drop
// out of the result, deleted ones included.
function computeSorts(previous, document) {
  const result = { tabs: computeList(previous?.tabs, (document.tabs || []).map(item => item.id)), sections: {} };
  for (const { key, blocks } of sections(document)) {
    result.sections[key] = computeList(previous?.sections?.[key], blocks.map(block => block.id));
  }
  return result;
}

// Position-based sorts exactly as desired() hashed them before sticky sorts:
// the zero-based list index. Used once to rebase the receipts of a journal
// written by an older ARM so the adoption sends no phantom updates.
function indexSorts(document) {
  const result = { tabs: {}, sections: {} };
  (document.tabs || []).forEach((item, index) => { result.tabs[item.id] = index; });
  for (const { key, blocks } of sections(document)) result.sections[key] = Object.fromEntries(blocks.map((block, index) => [block.id, index]));
  return result;
}

module.exports = { computeSorts, indexSorts, sectionKey };
