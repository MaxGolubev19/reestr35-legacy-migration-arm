'use strict';
const ACTIVE = new Set(['running', 'pausing', 'validating', 'stopping']);
const TERMINAL = new Set(['needs_review', 'complete', 'incomplete', 'failed', 'cancelled', 'interrupted']);

module.exports = { ACTIVE, TERMINAL };
