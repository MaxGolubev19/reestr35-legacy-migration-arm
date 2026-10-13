'use strict';
const path = require('node:path'), crypto = require('node:crypto');
const { readChecked } = require('../../infrastructure/media.cjs');
function assetResolvers(queue, jobId) {
  return {
    resolveMedia(ref, url) {
      const media = queue.mediaPicker.resolve(jobId, ref, url);
      return { name: ref.filename, base64: media.bytes.toString('base64'), sha256: crypto.createHash('sha256').update(media.bytes).digest('hex') };
    },
    resolveDocument(ref, link) {
      const selected = queue.documentPicker.snapshot(jobId, ref.attempt, ref.revision);
      const item = selected.manifest.resources.find(item => item.id === ref.resourceId);
      // Validate the provenance, signature and link before exposing any bytes.
      const descriptor = queue.documentPicker.resolve(jobId, ref, link ?? item?.resolvedUrl ?? item?.originalUrl, ref.attempt, selected);
      const bytes = readChecked(queue.root, path.join(selected.dir, item.object), queue.stage.media.limits.maxFileBytes);
      return { name: descriptor.name, base64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
  };
}
module.exports = { assetResolvers };
