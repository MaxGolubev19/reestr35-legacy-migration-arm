'use strict';
// Explicit, reproducible import; this development command is never used at runtime.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function importHtml(domainsFile, paidDir, destination) {
  const bytes = fs.readFileSync(domainsFile), domains = JSON.parse(bytes), owners = new Map();
  for (const [id, hostname] of Object.entries(domains)) {
    if (!/^(?:[a-z0-9-]+\.)+reestr35\.ru$/.test(hostname)) throw new Error('Invalid hostname: ' + hostname);
    owners.set(hostname, [...(owners.get(hostname) || []), id]);
  }
  fs.mkdirSync(path.join(destination, 'html'), { recursive: true });
  fs.copyFileSync(domainsFile, path.join(destination, 'domains.json'));
  const report = { version: 1, domainsSha256: crypto.createHash('sha256').update(bytes).digest('hex'), copied: [], missing: [], ambiguous: [], unmatched: [] };
  for (const [hostname, ids] of owners) {
    if (ids.length !== 1) { report.ambiguous.push({ hostname, ids }); continue; }
    const file = path.join(paidDir, ids[0] + '.html');
    if (!fs.existsSync(file)) { report.missing.push(hostname); continue; }
    fs.copyFileSync(file, path.join(destination, 'html', hostname + '.html'));
    report.copied.push({ hostname, id: ids[0], sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  }
  for (const name of fs.readdirSync(paidDir)) if (/\.html$/i.test(name) && !Object.hasOwn(domains, name.slice(0, -5))) report.unmatched.push(name);
  fs.writeFileSync(path.join(destination, 'import-report.json'), JSON.stringify(report, null, 2));
  return report;
}
if (require.main === module) { const report = importHtml(...process.argv.slice(2)); console.log(JSON.stringify({ copied: report.copied.length, missing: report.missing.length, ambiguous: report.ambiguous.length, unmatched: report.unmatched })); }
module.exports = { importHtml };
