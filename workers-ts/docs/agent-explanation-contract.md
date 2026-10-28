# PHP distribution explanation read contract

The PHP source at `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` serves `pages/users/user_distribution_info/index` with the content from public `/api/agreement/2`. It does not hide a configured document when its status is zero. The migrated page keeps that distinction: disabling new promoter applications does not remove the public explanation.

## Customer page and navigation

`/pages/user/agentExplanation` is a registered public page titled 分销说明. Both route registries resolve the original `/pages/users/user_distribution_info/index` to it. The finance page provides the same explanation entry using the original `public/statics/images/spread_sm.png` bytes; provenance records its immutable PHP ref, Git blob, size and SHA256. The body keeps PHP's white background and `15px 30rpx 40rpx` padding. Existing finance writes retain their existing authorization and storage guards.

The page renders safe persisted document structure, typography, tables, lists, links, pictures and video. It distinguishes missing configuration from an empty configured body. Failed requests and failed pictures offer an explicit read action. A reload clears the former document before waiting; hiding or unloading cancels ownership. Account/session replacement and persisted storage drift make earlier read and interaction callbacks inert. Guests require no login. Signed media expiration removes its playable/displayable source and provides a read action; it does not automatically poll or renew tickets.

## Additive public read

`GET /api/agent/explanation` takes no query, fragment or body. Nonzero/ambiguous content framing and unsupported methods fail validation. Ordinary Hono HEAD handling returns an empty body. The application envelope remains `{status,msg,data}` and the response declares `Cache-Control: private, no-store`.

The closed data projection is:

```ts
type AgentExplanation = {
  version: 1;
  member_explain: null | {
    id: number; // persisted signed int32, including historical zero/negative IDs
    type: 2;
    content_preview: string;
  };
};
```

The service reads only type 2, ordered by sort and ID descending. It does not filter status and does not fall back to type 1. Null SQL content becomes an empty body. The legacy `/api/agreement/:type`, `/api/user_agreement/:type`, promoter application and invitation contracts remain separate. The Admin editor keeps its existing CAS revision, permission and audit-log behavior.

The entire read uses a repeatable-read, read-only PostgreSQL transaction and a local five-second statement timeout. It accepts a complete body of at most 4,000,000 UTF8 bytes and at most 9,999 image/video slots, rejecting overflow instead of truncating. The final preview must also fit the complete byte limit after ticket expansion.

## Media and resource boundary

The existing safe DIY HTML grammar removes executable markup, event attributes and unsafe URLs while retaining supported inline typography and structure. Existing public platform image/video metadata rules authorize canonical local attachments. Historical absolute or signed local asset references are canonicalized before authorization. User and supplier private attachments, missing metadata and malformed references do not receive public tickets. Safe static/HTTPS references retain the common grammar; the reader does not fetch external content.

Approved canonical references use the existing 900-second signed asset capability. Issuing a projection reads metadata without probing R2. The later generic asset GET performs the actual object read and may return an empty 404 when an object is absent. A signed URL is a bounded bearer capability; this feature does not add immediate revocation or new upload authority. Picture decoding failure requires a fresh explicit read, and old image events cannot change or renew a replacement document.

The public read never modifies agreements, logs, funds, identities, table rows or sequences, and never writes R2, KV, queues, rate budgets or durable objects. Browser fixture controls and any existing Admin document save must be journaled separately from these public GET invariants.

## Validation scope

Focused tests exercise the actual Vue/Pinia request, lifecycle and rendering adapters as well as the legacy public agreements and existing link policies. Native PostgreSQL cases retain the actual migration's unique type index, use an independent SELECT-only LOGIN, compare all 283 tables and 229 sequences around reads, and verify actual PNG/MP4 delivery, signing, status-zero visibility, closed input and full-capacity boundaries. Mock query ordering covers historical duplicate records without altering the migrated schema.

Type checks, H5/Weixin/App builds, current audit bindings and actual Browser acceptance must be recorded before publication. Passing a prepared or syntax-only harness does not establish Browser or native execution.
