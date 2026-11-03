import { createHash } from 'node:crypto';

// The actual installation source keeps its reviewed PostgreSQL constraint
// name. Only the historical declaration assertion receives its exact parent.
export const WRITEOFF_SOURCE_SUCCESSOR = Object.freeze({
  file: 'src/migrations/customerWriteoffOperation.ts',
  commit: 'd715da71abf6ce6f3dba6f2ee1b57e143744ebe3',
  parent: '4094ce1e033bdd8b4dc4ccf43da9057a76514228',
  historicalSha256: '044d8aa876e686e3e8b238b8cb4233240082f293060fc426ef00b7c5b1d952f0',
  currentSha256: '05b10c0c3c583c3dd2531116cbdb421381743482402506a7a06243a8a5e3df1f',
  historicalBytes: 15619,
  currentBytes: 15653,
  before: ' CONSTRAINT cwo_pk PRIMARY KEY(actor_uid,request_key),\n',
  after: ' CONSTRAINT customer_writeoff_operation_request_pkey PRIMARY KEY(actor_uid,request_key),\n',
});
const sha = (source: string) => createHash('sha256').update(source).digest('hex');

export function historicalWriteoffOperationSource(source: string): string {
  const proof = WRITEOFF_SOURCE_SUCCESSOR;
  if (sha(source) !== proof.currentSha256 || Buffer.byteLength(source) !== proof.currentBytes)
    throw new Error('Current complete writeoff source differs from the reviewed constraint successor');
  const index = source.indexOf(proof.after);
  if (index < 0 || source.indexOf(proof.after, index + 1) >= 0)
    throw new Error('Writeoff constraint successor must be one exact complete line');
  const historical = source.slice(0, index) + proof.before + source.slice(index + proof.after.length);
  if (sha(historical) !== proof.historicalSha256 || Buffer.byteLength(historical) !== proof.historicalBytes)
    throw new Error('Complete historical writeoff source differs after the exact inverse');
  return historical;
}
