import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../fixtures/customer-sign-centre-manifest-20261025.json'), 'utf8');
if (sha(raw) !== '1363555e325961e69a5f1632b8d901246f206f435ba74c7c6d0517c846045d0a') throw Error('Sign centre manifest proof bytes differ');
export const signCentreManifest = JSON.parse(raw) as { schema: string; base_ref: string; file: string; before_sha256: string; after_sha256: string; before_bytes: number; after_bytes: number; inserted_line: number; inserted_source: string };
/** Peel only the one new registered sign-history page before dated footer/checklist proofs. */
export function reverseSignCentreManifest(source: string): string {
  const proof = signCentreManifest;
  if (proof.schema !== 'cinashop.customer-sign-centre-manifest-increment.v1' || proof.base_ref !== 'b3760bf8b10f58913afaeafc04ebb133f09de967' || proof.file !== 'view/uniapp-ts/src/pages.json'
    || sha(source) !== proof.after_sha256 || Buffer.byteLength(source) !== proof.after_bytes || source.split(proof.inserted_source).length !== 2
    || source.slice(0, source.indexOf(proof.inserted_source)).split('\n').length !== proof.inserted_line) throw Error('Current sign centre manifest differs');
  const previous = source.replace(proof.inserted_source, '');
  if (sha(previous) !== proof.before_sha256 || Buffer.byteLength(previous) !== proof.before_bytes) throw Error('Previous sign centre manifest differs');
  return previous;
}
