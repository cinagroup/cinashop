const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'user-routine-candidate-local-prepare.json'), 'utf8'));
const candidate = JSON.parse(fs.readFileSync(path.join(root, 'user-routine-alias-candidate-summary.json'), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const layout = bytes => {
  const text = bytes.toString('utf8');
  return { bom: text.startsWith('\ufeff'), crlf: (text.match(/\r\n/g) || []).length, loneLf: (text.match(/(?<!\r)\n/g) || []).length };
};
const rows = candidate.ownedInputs.map(input => {
  const localBytes = fs.readFileSync(path.join(baseline.local, input.path));
  if (hash(localBytes) !== input.sha256) throw Error('Local candidate changed: ' + input.path);
  const original = baseline.rows.find(row => row.path === input.path);
  const sourcePath = path.join(baseline.source, input.path);
  const sourceBytes = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath) : null;
  if (original && (!sourceBytes || hash(sourceBytes) !== original.sourceBaselineSha256)) throw Error('Source baseline changed: ' + input.path);
  if (!original && sourceBytes) throw Error('New Source test already exists: ' + input.path);
  return { path: input.path, candidateSha256: input.sha256, sourceBaselineSha256: original?.sourceBaselineSha256 ?? null, sourceExists: !!sourceBytes, sourceLayout: sourceBytes ? layout(sourceBytes) : null, candidateLayout: layout(localBytes) };
});
console.log(JSON.stringify({ sourceWritten: false, checkedAt: new Date().toISOString(), rows }));
