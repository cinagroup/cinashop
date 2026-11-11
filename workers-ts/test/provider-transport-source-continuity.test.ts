import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_TRANSPORT_PROOF_FILE, PROVIDER_TRANSPORT_PROOF_SHA, providerTransportSourceContinuity as proof,
  projectProviderTransportPredecessor } from './helpers/providerTransportSourceContinuity';
import { projectRechargeRefundPredecessor, readRechargeRefundPredecessorFile } from './helpers/rechargeRefundSourceContinuity';
import { projectPurchasedLabelAuthorPredecessor } from './helpers/purchasedLabelAuthorSourceContinuity';
const root = resolve(import.meta.dirname, '../..');
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const physical = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('reviewed provider transport successor before unchanged historical proofs', () => {
  it('pins twelve providers, fifteen current contracts, two reader ports and the CI workflow to complete fixed353 Git originals', () => {
    expect(sha(readFileSync(resolve(root, PROVIDER_TRANSPORT_PROOF_FILE)))).toBe(PROVIDER_TRANSPORT_PROOF_SHA);
    expect(proof.sources).toHaveLength(30); expect(proof.sources.filter(row => row.kind === 'provider')).toHaveLength(12);
    expect(proof.sources.filter(row => row.kind === 'current-contract')).toHaveLength(15);
    expect(proof.sources.filter(row => row.kind === 'historical-reader').map(row => row.file)).toEqual([
      'workers-ts/test/helpers/rechargeRefundSourceContinuity.ts', 'workers-ts/test/recharge-refund-source-continuity.test.ts',
    ]);
    expect(proof.sources.filter(row => row.kind === 'validation-workflow').map(row => row.file)).toEqual(['.github/workflows/workers-runtime-linux.yml']);
    for (const row of proof.sources) {
      const before = execFileSync('git', ['cat-file', 'blob', proof.predecessorCommit + ':' + row.file], { cwd: root, encoding: 'utf8' });
      const current = physical(row.file);
      expect(projectProviderTransportPredecessor(row.file, current)).toBe(before);
      expect(sha(projectPurchasedLabelAuthorPredecessor(row.file, current))).toBe(row.current.sha256); expect(sha(before)).toBe(row.predecessor.sha256);
      expect(row.origin).toEqual({ commit: proof.predecessorCommit, path: row.file, gitBlobSha1: row.predecessor.gitBlobSha1 });
      expect(current).not.toBe(before);
    }
  });
  it.each(['prefix', 'suffix', 'CRLF', 'same-size edit', 'old complete image'])('rejects an unreviewed %s in every entire selected source', kind => {
    for (const row of proof.sources) {
      const current = physical(row.file), before = projectProviderTransportPredecessor(row.file, current);
      const changed = kind === 'prefix' ? '// unknown\n' + current : kind === 'suffix' ? current + '\n// unknown\n'
        : kind === 'CRLF' ? current.replaceAll('\n', '\r\n') : kind === 'same-size edit' ? 'X' + current.slice(1) : before;
      expect(changed).not.toBe(current);
      expect(() => projectProviderTransportPredecessor(row.file, changed)).toThrow('complete current source differs');
    }
  });
  it('limits historical read ports to the complete reviewed images, while native runtime and unknown paths stay current', () => {
    const target = 'workers-ts/src/services/wechat/WechatNotificationProvider.ts', current = physical(target);
    expect(current).toContain("redirect: 'manual'");
    expect(readRechargeRefundPredecessorFile(resolve(root, target), 'utf8')).toBe(projectProviderTransportPredecessor(target, current));
    for (const row of proof.sources) {
      const fixed353 = projectProviderTransportPredecessor(row.file, physical(row.file));
      const expected = row.kind === 'validation-workflow' || row.file === 'workers-ts/test/ci-gate-capacity.test.ts'
        ? projectRechargeRefundPredecessor(row.file, fixed353) : fixed353;
      expect(readRechargeRefundPredecessorFile(resolve(root, row.file), 'utf8')).toBe(expected);
    }
    expect(projectProviderTransportPredecessor('unrelated.ts', 'native bytes')).toBe('native bytes');
    expect(Object.isFrozen(proof.sources[0].inverseEdits[0].before)).toBe(true);
  });
});
