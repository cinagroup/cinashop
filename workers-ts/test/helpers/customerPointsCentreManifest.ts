import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../fixtures/customer-points-centre-manifest-20261025.json'), 'utf8');
if (sha(raw) !== '008cc87b7a91918b04ff949d7684dff38b05324df8544af41ad25d59d7ef5d8d') throw Error('Points centre manifest proof differs');
export const pointsCentreManifest = JSON.parse(raw) as { schema: string; base_ref: string; file: string; before_sha256: string; after_sha256: string; before_bytes: number; after_bytes: number; inserted_line: number; inserted_source: string };
export function reversePointsCentreManifest(source: string): string {
  const proof = pointsCentreManifest;
  if (proof.schema !== 'cinashop.customer-points-centre-manifest-increment.v1' || proof.base_ref !== 'b004692bace893213816e1ad2cdffc251ed2d2c5' || proof.file !== 'view/uniapp-ts/src/pages.json'
    || sha(source) !== proof.after_sha256 || Buffer.byteLength(source) !== proof.after_bytes || source.split(proof.inserted_source).length !== 2
    || source.slice(0, source.indexOf(proof.inserted_source)).split('\n').length !== proof.inserted_line) throw Error('Current points centre manifest differs');
  const previous = source.replace(proof.inserted_source, '');
  if (sha(previous) !== proof.before_sha256 || Buffer.byteLength(previous) !== proof.before_bytes) throw Error('Previous points centre manifest differs');
  return previous;
}
