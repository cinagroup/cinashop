import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEFU_ORDER_MEDIA_PREDECESSOR, KEFU_ORDER_MEDIA_PROOF_FILE, KEFU_ORDER_MEDIA_PROOF_SHA256,
  KEFU_ORDER_MEDIA_SOURCES, kefuOrderMediaImage, kefuOrderMediaProof as proof,
  isKefuOrderMediaSource, projectKefuOrderMediaPredecessor } from './helpers/kefuOrderMediaSourceContinuity';
const root = resolve(import.meta.dirname, '../..');
const physical = (file: string) => readFileSync(resolve(root, file), 'utf8');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sources = [
  "workers-ts/scripts/run-local-finance-postgres.mjs",
  "workers-ts/src/controllers/kefu/KefuController.ts",
  "workers-ts/src/services/kefu/KefuOrderService.ts",
  "workers-ts/test/helpers/kefuProductMediaSourceContinuity.ts",
  "workers-ts/test/helpers/providerTransportSourceContinuity.ts",
  "workers-ts/test/kefu-product-media-source-continuity.test.ts"
];
const retained = [
  {
    "path": "workers-ts/test/fixtures/first-order-authority-source-continuity-20261116.json",
    "sha256": "97fab9c318a99855eaea69dc2bad115eb0c4ae32898d0f4bbbd7768464d1bfd2"
  },
  {
    "path": "workers-ts/test/fixtures/membership-contract-source-continuity-20261104.json",
    "sha256": "e789b6ee0349439223c54ddde8341464537189d70a9487a138c1149ef13d0f58"
  },
  {
    "path": "workers-ts/test/fixtures/provider-transport-source-continuity-20261109.json",
    "sha256": "be895c2c4a72e33c120aadd7da13fb71eae93b9ff6ff37e495ee6b8fcf81d1b1"
  },
  {
    "path": "workers-ts/test/fixtures/public-product-estimate-source-continuity-20261115.json",
    "sha256": "bb78b85fe23a3ede3dbe57a97d13665a3c1367ad1a1803394d28fdbbc97388b2"
  },
  {
    "path": "workers-ts/test/fixtures/purchased-label-author-continuity-20261110.json",
    "sha256": "ecc4a0945f00150af49582f54eb87f0a0a695e761817c1d299d67bdccbf1fcd8"
  },
  {
    "path": "workers-ts/test/fixtures/purchased-label-operations-continuity-20261110.json",
    "sha256": "60144df5fb7fe5d781e24ba935060434d23efce30c24d06841b85f16c40271de"
  },
  {
    "path": "workers-ts/test/fixtures/purchased-label-storage-runner-continuity-20261110.json",
    "sha256": "946bffa54ae23fde86b310e92edf59ad3aa62f17e8ffc3835bdc15aa0629b026"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-notice-source-continuity-20261105.json",
    "sha256": "ce930c5917bebc96bc9faac7b831a053d473299c5f8b293a8ac339797f68c934"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-callback-economic-source-continuity-20261108.json",
    "sha256": "5f228fadf2d1c41e5e0fae415562829364414ea5d8a063bd38a148e8557168c4"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-callback-http-source-continuity-20261109.json",
    "sha256": "702d22cb0c986a0aa43bd77951f61ca19e296be4a7cef39ddb888b76908ae3a9"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-callback-source-continuity-20261108.json",
    "sha256": "2f93be012b6e19cf009e7da91d9abb7889852713e83d692d8f9614276a421aa6"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-counted-first-source-continuity-20261109.json",
    "sha256": "f786143d31046a6820b2a99f9f44839e3c23b801dc6fdd12c717f5e0b72391e4"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-http-source-continuity-20261108.json",
    "sha256": "adf570f96a4283154cac18141208fe71d6b9699a926262769ed987a2ff36f0d0"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-mixed-recovery-source-continuity-20261108.json",
    "sha256": "9e36eee479443be268d30a261741f0cf36a10f7493df3f6fc7de4a724545dfaf"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-notice-consumer-source-continuity-20261109.json",
    "sha256": "dc74c4abd38298c3feed1afa7a1578d57e2f753360115538e5716e4f68257532"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-query-source-continuity-20261108.json",
    "sha256": "f9fd32f0fb94085336b4144abc5ee43f8f7e887e764ffe66f641c926404cc44e"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-recovery-source-continuity-20261108.json",
    "sha256": "5173c5c64c4781e93830195d9c7517d07fee813b6261be57df72d4aa066dd473"
  },
  {
    "path": "workers-ts/test/fixtures/recharge-refund-source-continuity-20261108.json",
    "sha256": "ba9345a4e12e60f260966d068e38de9b1d93a98ba59f78f4fc942f81242ee79c"
  },
  {
    "path": "workers-ts/test/fixtures/unit-discovery-source-continuity-20261109.json",
    "sha256": "68974165ff71c032f833bca3e5bd4711918b408b970ca4c2d6214cebebed1f4c"
  },
  {
    "path": "workers-ts/test/helpers/firstOrderAuthoritySourceContinuity.ts",
    "sha256": "0524df4a437972d0c83662074bb4f47a434d464930832fd56440b41c0222f13a"
  },
  {
    "path": "workers-ts/test/helpers/membershipContractSourceContinuity.ts",
    "sha256": "dffde293de61d168a9d2406b81db0f7bfdb4f8d8aad548f82eaefa6b4c57d03a"
  },
  {
    "path": "workers-ts/test/helpers/outProductLabelRunnerSourceContinuity.ts",
    "sha256": "772d711e452734f3d4b35eec7d80db449f51c9585953606283a293955656281a"
  },
  {
    "path": "workers-ts/test/helpers/publicProductEstimateSourceContinuity.ts",
    "sha256": "bc927b71a0e451b45737521e4ee7f4708b10a727594bdbc25a91c30b7f798407"
  },
  {
    "path": "workers-ts/test/helpers/purchasedLabelAuthorSourceContinuity.ts",
    "sha256": "63e199a19fbf2aaf501c9db2b67a072df24739608246c78b59f206b4a311fa71"
  },
  {
    "path": "workers-ts/test/helpers/purchasedLabelOperationsSourceContinuity.ts",
    "sha256": "b976a074ac7d89c19ac361b7af584bdcc57268f98a330aded4d37f6039ef46ed"
  },
  {
    "path": "workers-ts/test/helpers/purchasedLabelStorageRunnerSourceContinuity.ts",
    "sha256": "acb158942aa01dbe6611a6b285b88085e4d17687672d24c544d3ef69ae9de5b2"
  },
  {
    "path": "workers-ts/test/helpers/rechargeNoticeSourceContinuity.ts",
    "sha256": "e12c89869a929e3f913a8c7ef34d218652f64536edb8928bf426e74f268c380e"
  },
  {
    "path": "workers-ts/test/helpers/rechargeRefundSourceContinuity.ts",
    "sha256": "f6cff6ef5ff9d156fa555fa9ed87e21db1568d3597190647ffcda16b21297f6e"
  },
  {
    "path": "workers-ts/test/helpers/unitDiscoverySourceContinuity.ts",
    "sha256": "ff5788e9afaf87fe4678d8a47f3b9b75344357981674d248e70adbc548c7e5f5"
  },
  {
    "path": "workers-ts/test/fixtures/kefu-product-media-source-continuity-20261116.json",
    "sha256": "05bd3e48df227081194a13eee8c3c8737a8ebae048b443aaee56f7a095aa6918"
  }
];
describe('Kefu order media complete physical current sources before fixed4428 historical views', () => {
  it('pins the complete immutable six-source inventory and fixed Git origins', () => {
    expect(sha(readFileSync(resolve(root, KEFU_ORDER_MEDIA_PROOF_FILE)))).toBe(KEFU_ORDER_MEDIA_PROOF_SHA256);
    expect(proof.schema).toBe('kefu-order-media-source-continuity/v1');
    expect(proof.predecessorCommit).toBe('4428de3da07bd2818bc07e9ed70c33425d24fcf7'); expect(KEFU_ORDER_MEDIA_PREDECESSOR).toBe('4428de3da07bd2818bc07e9ed70c33425d24fcf7');
    expect(KEFU_ORDER_MEDIA_SOURCES).toEqual(sources); expect(proof.sources.map(row => row.file)).toEqual(sources);
    expect(new Set(sources).size).toBe(6); expect(Object.isFrozen(KEFU_ORDER_MEDIA_SOURCES)).toBe(true);
    expect(Reflect.set(KEFU_ORDER_MEDIA_SOURCES, '0', 'unknown')).toBe(false);
    expect(sources.every(isKefuOrderMediaSource)).toBe(true);
  });
  for (const row of proof.sources) {
    it('binds the entire physical source and reconstructs its complete fixed4428 Git blob for ' + row.file, () => {
      const current = physical(row.file); expect(kefuOrderMediaImage(current)).toEqual(row.current);
      const previous = projectKefuOrderMediaPredecessor(row.file, current);
      expect(previous).not.toBe(current); expect(kefuOrderMediaImage(previous)).toEqual(row.predecessor);
      expect(row.origin).toEqual({ commit: '4428de3da07bd2818bc07e9ed70c33425d24fcf7', path: row.file, gitBlobSha1: row.predecessor.gitBlobSha1 });
      expect(physical(row.file)).toBe(current);
    });
    it('rejects all previous, tampered, duplicate and nonliteral current images for ' + row.file, () => {
      const current = physical(row.file), previous = projectKefuOrderMediaPredecessor(row.file, current);
      for (const input of ['// unknown\n' + current, current + '\n// unknown\n', current.replaceAll('\n', '\r\n'),
        'X' + current.slice(1), previous, current + current, '', current.slice(0, -1)]) {
        expect(input).not.toBe(current);
        expect(() => projectKefuOrderMediaPredecessor(row.file, input)).toThrow('complete current source differs');
      }
    });
  }
  it('keeps selectors literal and new production/native/browser sources in physical form', () => {
    for (const file of ['unrelated.ts', '/workers-ts/src/services/kefu/KefuOrderService.ts',
      'workers-ts/src/services/kefu/../kefu/KefuOrderService.ts', 'workers-ts\\src\\services\\kefu\\KefuOrderService.ts',
      'workers-ts/src/services/kefu/KefuOrderService.ts.extra', 'workers-ts/src/services/kefu/KefuOrderMediaPolicy.ts',
      'workers-ts/test/helpers/kefuOrderMediaFixture.ts', 'workers-ts/test/kefu-order-media-postgres.test.ts',
      'workers-ts/test/browser/kefu-order-media.acceptance.ts', 'workers-ts/test/helpers/kefuOrderMediaSourceContinuity.ts',
      'workers-ts/test/kefu-order-media-source-continuity.test.ts']) {
      expect(isKefuOrderMediaSource(file)).toBe(false);
      const value = file.startsWith('workers-ts/test/') || file.endsWith('KefuOrderMediaPolicy.ts') ? physical(file) : 'unknown\0\r\n';
      expect(projectKefuOrderMediaPredecessor(file, value)).toBe(value);
    }
  });
  it('preserves every earlier immutable proof and unchanged helper byte', () => {
    for (const row of retained) expect(sha(readFileSync(resolve(root, row.path)))).toBe(row.sha256);
  });
  it('deep-freezes proof images, origins and exact unique inverse anchors', () => {
    expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.sources)).toBe(true);
    for (const row of proof.sources) {
      for (const value of [row, row.current, row.predecessor, row.origin, row.inverseEdits]) expect(Object.isFrozen(value)).toBe(true);
      expect(row.inverseEdits.length).toBeGreaterThan(0);
      for (const edit of row.inverseEdits) {
        for (const value of [edit, edit.after, edit.before, edit.anchor]) expect(Object.isFrozen(value)).toBe(true);
        expect(Reflect.set(edit, 'start', edit.start + 1)).toBe(false); expect(Reflect.set(edit.anchor, '0', 'tamper\n')).toBe(false);
      }
      expect(Reflect.set(row.current, 'sha256', row.predecessor.sha256)).toBe(false);
      expect(Reflect.set(row.origin, 'commit', 'unknown')).toBe(false);
      expect(kefuOrderMediaImage(projectKefuOrderMediaPredecessor(row.file, physical(row.file)))).toEqual(row.predecessor);
    }
  });
});
