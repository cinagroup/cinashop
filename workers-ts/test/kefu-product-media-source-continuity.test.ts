import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEFU_PRODUCT_MEDIA_PREDECESSOR, KEFU_PRODUCT_MEDIA_PROOF_FILE, KEFU_PRODUCT_MEDIA_PROOF_SHA256,
  KEFU_PRODUCT_MEDIA_SOURCES, kefuProductMediaImage, kefuProductMediaProof as proof,
  isKefuProductMediaSource, projectKefuProductMediaPredecessor } from './helpers/kefuProductMediaSourceContinuity';
import { isProviderTransportSource, projectProviderTransportPredecessor,
  projectProviderTransportFromFirstOrderAuthorityView } from './helpers/providerTransportSourceContinuity';
import { projectFirstOrderAuthorityPredecessor } from './helpers/firstOrderAuthoritySourceContinuity';
const root = resolve(import.meta.dirname, '../..');
const physical = (file: string) => readFileSync(resolve(root, file), 'utf8');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sources = [
  "view/kefu-ts/src/styles/main.css",
  "workers-ts/scripts/run-local-finance-postgres.mjs",
  "workers-ts/src/controllers/kefu/KefuController.ts",
  "workers-ts/src/services/kefu/KefuProductService.ts",
  "workers-ts/src/services/kefu/KefuTouristService.ts",
  "workers-ts/test/first-order-authority-source-continuity.test.ts",
  "workers-ts/test/helpers/providerTransportSourceContinuity.ts",
  "workers-ts/test/out-product-label-runner-source-continuity.test.ts",
  "workers-ts/test/public-product-estimate-source-continuity.test.ts",
  "workers-ts/test/purchased-label-author-source-continuity.test.ts",
  "workers-ts/test/purchased-label-operations-source-continuity.test.ts",
  "workers-ts/test/purchased-label-storage-runner-source-continuity.test.ts"
];
const immutablePredecessors = [
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
  }
];

describe('Kefu product media exact physical current source before fixed9d historical views', () => {
  it('pins the entire immutable proof, twelve-source literal inventory and complete fixed9d origins', () => {
    expect(sha(readFileSync(resolve(root, KEFU_PRODUCT_MEDIA_PROOF_FILE)))).toBe(KEFU_PRODUCT_MEDIA_PROOF_SHA256);
    expect(proof.schema).toBe('kefu-product-media-source-continuity/v1');
    expect(proof.predecessorCommit).toBe('9d1d455e844e01efc389646bb8ed43963134f7f7');
    expect(KEFU_PRODUCT_MEDIA_PREDECESSOR).toBe(proof.predecessorCommit);
    expect(KEFU_PRODUCT_MEDIA_SOURCES).toEqual(sources);
    expect(proof.sources.map(row => row.file)).toEqual(sources);
    expect(new Set(sources).size).toBe(12);
    expect(Object.isFrozen(KEFU_PRODUCT_MEDIA_SOURCES)).toBe(true);
    expect(Reflect.set(KEFU_PRODUCT_MEDIA_SOURCES, '0', 'unknown')).toBe(false);
    expect(sources.every(file => isKefuProductMediaSource(file) && isProviderTransportSource(file))).toBe(true);
  });
  for (const row of proof.sources) {
    it('binds every physical current byte and reconstructs the complete fixed9d Git image for ' + row.file, () => {
      const current = physical(row.file);
      expect(kefuProductMediaImage(current)).toEqual(row.current);
      const previous = projectKefuProductMediaPredecessor(row.file, current);
      expect(previous).not.toBe(current);
      expect(kefuProductMediaImage(previous)).toEqual(row.predecessor);
      expect(row.origin).toEqual({ commit: proof.predecessorCommit, path: row.file, gitBlobSha1: row.predecessor.gitBlobSha1 });
      if (row.file === 'workers-ts/scripts/run-local-finance-postgres.mjs') {
        // Preserve the already-failed older collection boundary exactly. This
        // projection test never reclassifies the historical suite as passing.
        const message = 'Purchased label operations complete current source differs';
        expect(() => projectProviderTransportFromFirstOrderAuthorityView(row.file, previous)).toThrow(message);
        expect(() => projectProviderTransportPredecessor(row.file, current)).toThrow(message);
      } else {
        const fixedView = projectProviderTransportFromFirstOrderAuthorityView(row.file, previous);
        expect(projectProviderTransportPredecessor(row.file, current)).toBe(fixedView);
      }
      expect(physical(row.file)).toBe(current);
    });
    it('rejects tampering, duplicate forms and old complete images as current for ' + row.file, () => {
      const current = physical(row.file), previous = projectKefuProductMediaPredecessor(row.file, current);
      const older = projectFirstOrderAuthorityPredecessor(row.file, previous);
      const invalid = ['// unknown\n' + current, current + '\n// unknown\n', current.replaceAll('\n', '\r\n'),
        'X' + current.slice(1), previous, older, current + current, '', current.slice(0, -1)];
      for (const input of invalid) {
        expect(input).not.toBe(current);
        expect(() => projectKefuProductMediaPredecessor(row.file, input)).toThrow('complete current source differs');
        expect(() => projectProviderTransportPredecessor(row.file, input)).toThrow('complete current source differs');
      }
    });
  }
  it('keeps selectors literal and passes unrelated or new sources through in their real current form', () => {
    for (const file of ['unrelated.ts', '/workers-ts/src/services/kefu/KefuProductService.ts',
      'workers-ts/src/services/kefu/../kefu/KefuProductService.ts', 'workers-ts\\src\\services\\kefu\\KefuProductService.ts',
      'workers-ts/src/services/kefu/KefuProductService.ts.extra',
      'workers-ts/src/services/kefu/KefuProductMediaPolicy.ts',
      'workers-ts/test/helpers/kefuProductMediaFixture.ts', 'workers-ts/test/kefu-product-media-postgres.test.ts',
      'workers-ts/test/kefu-product-media-source-continuity.test.ts', 'workers-ts/test/helpers/kefuProductMediaSourceContinuity.ts']) {
      expect(isKefuProductMediaSource(file)).toBe(false);
      const bytes = file.startsWith('workers-ts/test/') || file.endsWith('KefuProductMediaPolicy.ts') ? physical(file) : 'literal unknown bytes\0\r\n';
      expect(projectKefuProductMediaPredecessor(file, bytes)).toBe(bytes);
    }
  });
  it('retains every old proof and unchanged helper without replacing old fixture bytes or hashes', () => {
    for (const entry of immutablePredecessors) expect(sha(readFileSync(resolve(root, entry.path)))).toBe(entry.sha256);
  });
  it('makes complete current/predecessor images, fixed origins and unique-anchor inverses deeply immutable', () => {
    expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.sources)).toBe(true);
    for (const row of proof.sources) {
      expect(Object.isFrozen(row)).toBe(true); expect(Object.isFrozen(row.current)).toBe(true);
      expect(Object.isFrozen(row.predecessor)).toBe(true); expect(Object.isFrozen(row.origin)).toBe(true);
      expect(Object.isFrozen(row.inverseEdits)).toBe(true); expect(row.inverseEdits.length).toBeGreaterThan(0);
      for (const edit of row.inverseEdits) {
        expect(Object.isFrozen(edit)).toBe(true); expect(Object.isFrozen(edit.after)).toBe(true);
        expect(Object.isFrozen(edit.before)).toBe(true); expect(Object.isFrozen(edit.anchor)).toBe(true);
        expect(Reflect.set(edit, 'start', edit.start + 1)).toBe(false);
        expect(Reflect.set(edit.anchor, '0', 'unreviewed\n')).toBe(false);
      }
      expect(Reflect.set(row.current, 'sha256', row.predecessor.sha256)).toBe(false);
      expect(Reflect.set(row.origin, 'commit', 'unknown')).toBe(false);
      expect(kefuProductMediaImage(projectKefuProductMediaPredecessor(row.file, physical(row.file)))).toEqual(row.predecessor);
    }
    expect(sha(readFileSync(resolve(root, KEFU_PRODUCT_MEDIA_PROOF_FILE)))).toBe(KEFU_PRODUCT_MEDIA_PROOF_SHA256);
  });
});
