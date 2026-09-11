'use strict';
function slug(value) {
  let s = value.normalize('NFKC').toLowerCase().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-+/g, '-').replace(/^[. -]+|[. -]+$/g, '');
  s = Array.from(s).slice(0, 65).join('').replace(/[. -]+$/g, '') || 'без-названия';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s = '_' + s;
  return s;
}
module.exports = { slug };
