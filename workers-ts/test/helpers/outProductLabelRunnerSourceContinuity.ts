/** One exact runner successor for historical readers only. Native validation
 * executes the complete current runner with the added label test admitted. */
import { createHash } from 'node:crypto';

export const OUT_LABEL_RUNNER_FILE = 'workers-ts/scripts/run-local-finance-postgres.mjs';
export const outLabelRunnerSourceContinuity = Object.freeze({
  predecessorCommit: 'af2096c38c6b97e7cd27e5656b21c77b5bd73626',
  current: Object.freeze({ bytes: 139093, sha256: '40e3f1fc5545335fc7b57fb2244f5e67609c1238021e4fb7daed813bdb96b032',
    gitBlobSha1: '6bb5a028b007e7e21aa33b5fec2bb7236b6496eb' }),
  predecessor: Object.freeze({ bytes: 139045, sha256: '468b9d518cf793c6f7247e1c2392074d6ff2a1cf5371e42bc3ed264eb831b38b',
    gitBlobSha1: '9f01e4451cc6406aa59a80d9d52b30f1e0da1cfa' }),
});
const image = (source: string) => ({ bytes: Buffer.byteLength(source),
  sha256: createHash('sha256').update(source).digest('hex'),
  gitBlobSha1: createHash('sha1').update('blob ' + Buffer.byteLength(source) + '\0').update(source).digest('hex') });
export const isOutLabelRunnerSource = (file: string) => file === OUT_LABEL_RUNNER_FILE;
export function projectOutLabelRunnerPredecessor(file: string, source: string): string {
  if (!isOutLabelRunnerSource(file)) return source;
  if (typeof source !== 'string' || JSON.stringify(image(source)) !== JSON.stringify(outLabelRunnerSourceContinuity.current))
    throw Error('Out label runner complete current source differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const added = "    'test/out-product-labels-postgres.test.ts',\n";
  if (lines[824] !== "    'test/checkout-out-product-concurrency.test.ts',\n" || lines[825] !== added
    || lines[826] !== "    'test/account-cancellation-order-admission-postgres.test.ts',\n" || source.split(added).length !== 2)
    throw Error('Out label runner exact insertion differs');
  lines.splice(825, 1);
  const previous = lines.join('');
  if (JSON.stringify(image(previous)) !== JSON.stringify(outLabelRunnerSourceContinuity.predecessor))
    throw Error('Out label runner complete predecessor differs');
  return previous;
}
