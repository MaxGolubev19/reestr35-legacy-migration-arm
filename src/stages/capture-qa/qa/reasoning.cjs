'use strict';
const fs = require('node:fs');

const TAIL_LIMIT = 200;
const BUFFER_CHARS = 2000;

// Streams the QA agent's reasoning into the attempt's reasoning.log and keeps
// the latest finished line as the queue-panel "current thought". Deltas arrive
// in arbitrary chunks, so the tail is recomputed from a bounded suffix only.
function createReasoningJournal({ file, onTail }) {
  let buffer = '';
  const publishTail = () => {
    const line = buffer.split(/\r?\n/).map(part => part.trim()).filter(Boolean).at(-1) || '';
    onTail(line.length > TAIL_LIMIT ? `${[...line].slice(0, TAIL_LIMIT).join('').trimEnd()}…` : line);
  };
  return {
    append(text) {
      if (!text) return;
      buffer += text;
      if (buffer.length > BUFFER_CHARS * 2) buffer = [...buffer].slice(-BUFFER_CHARS).join('');
      try { fs.appendFileSync(file, text); } catch { /* the journal is diagnostic */ }
      publishTail();
    }
  };
}
module.exports = { createReasoningJournal, TAIL_LIMIT };
