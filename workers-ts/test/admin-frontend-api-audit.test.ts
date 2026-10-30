import { readAdminProfilePredecessor as readCurrentFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { applyConfigClassReport } from './helpers/configClassSourceBinding';
import { reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
import { reverseLiveBroadcastAuthorSource, applyLiveBroadcastAuthorReport } from './helpers/diyLiveBroadcastAuthorSourceBinding';
import { reverseSeckillAuthorSource, applySeckillAuthorReport } from './helpers/diySeckillAuthorSourceBinding';
import { reverseBargainAuthorSource, applyBargainAuthorReport } from './helpers/diyBargainAuthorSourceBinding';
import { reverseCombinationAuthorSource, applyCombinationAuthorReport } from './helpers/diyCombinationAuthorSourceBinding';
import { reversePresaleAuthorSource, applyPresaleAuthorReport } from './helpers/diyPresaleAuthorSourceBinding';
import { reversePointsAuthorSource, applyPointsAuthorReport } from './helpers/diyPointsAuthorSourceBinding';
import { reverseCouponAuthorSource, applyCouponAuthorReport } from './helpers/diyCouponAuthorSourceBinding';
import { reversePromotionAuthorSource, applyPromotionAuthorReport } from './helpers/diyPromotionAuthorSourceBinding';
import { reverseCommunityAuthorSource, applyCommunityAuthorReport } from './helpers/diyCommunityAuthorSourceBinding';
import { reverseEditorialAuthorSource, applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBinding';
import { reverseFollowAuthorSource, applyFollowAuthorReport } from './helpers/diyFollowAuthorSourceBinding';
import { reverseListAuthorSource, applyListAuthorReport } from './helpers/diyListAuthorSourceBinding';
import { reverseCarouselAuthorSource, applyCarouselAuthorReport, carouselAuthorSourceBinding as carouselBinding } from './helpers/diyCarouselAuthorSourceBinding';
import { reverseNavigationAuthorSource, applyNavigationAuthorReport, navigationAuthorSourceBinding as navigationBinding } from './helpers/diyNavigationAuthorSourceBinding';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reverseRouteSourceIncrement, reverseRouteSourceFollowup, type RouteSourceFollowup } from "./helpers/routeSourceIncrement";
import { normalizeAdminAuditSource } from "../scripts/admin-frontend-api-audit";
import { buildAdminProfilePredecessorApiAuditReport as buildAdminFrontendApiAuditReport } from "./helpers/wechatAppAuthorSourceBinding";

// Exact additive state-author adapter; original definitions and dated proofs below remain intact.
const stateAuthorHistoricalRaw = readFileSync(resolve(import.meta.dirname, 'fixtures/diy-state-author-historical-bindings-20261024.json'), 'utf8');
const stateAuthorHash = (value: string) => createHash('sha256').update(value).digest('hex');
if (stateAuthorHash(stateAuthorHistoricalRaw) !== '8ddc626ef49c2ada520940518c99a3b3bb803df5b1047308af9d4241ff96a7d9') throw Error('State historical fixture bytes differ');
const stateAuthorHistorical = JSON.parse(stateAuthorHistoricalRaw) as {
  source: RouteSourceFollowup & { file: string };
  previous_report: { original_file: string; sha256: string; raw_utf8: string };
  current_report: { file: string; sha256: string };
  report_changes: Array<{ array: 'frontendSources' | 'calls'; index: number; before: Record<string, unknown>; after: Record<string, unknown> }>;
};
if (stateAuthorHash(stateAuthorHistorical.previous_report.raw_utf8) !== '31c8996982ab02e35fa6b7a30910ed1d915a807a3e3f10006d8b42258dd79a73') throw Error('Archived complete list report bytes differ');
function beforeStateAuthorSource(file: string, source: string): string {
  const previous = reverseFollowAuthorSource(file, reverseEditorialAuthorSource(file, reverseCommunityAuthorSource(file, reversePromotionAuthorSource(file, reverseCouponAuthorSource(file, reversePointsAuthorSource(file, reversePresaleAuthorSource(file, reverseCombinationAuthorSource(file, reverseBargainAuthorSource(file, reverseSeckillAuthorSource(file, reverseLiveBroadcastAuthorSource(file, reverseSearchHotwordsSource(file, source))))))))))));
  return file === stateAuthorHistorical.source.file ? reverseRouteSourceFollowup(previous, stateAuthorHistorical.source) : previous;
}
function applyStateAuthorReport<T>(before: T): T {
  if (stateAuthorHash(JSON.stringify(before, null, 2) + '\n') !== stateAuthorHistorical.previous_report.sha256) throw Error('State report complete predecessor differs');
  const updated = structuredClone(before) as unknown as { frontendSources: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>> };
  for (const change of stateAuthorHistorical.report_changes) {
    const values = updated[change.array];
    if (!['frontendSources', 'calls'].includes(change.array) || JSON.stringify(values?.[change.index]) !== JSON.stringify(change.before)) throw Error('State report exact predecessor row differs');
    values[change.index] = structuredClone(change.after);
  }
  if (stateAuthorHash(JSON.stringify(updated, null, 2) + '\n') !== stateAuthorHistorical.current_report.sha256) throw Error('State report complete result differs');
  return applyLiveBroadcastAuthorReport(applySeckillAuthorReport(applyBargainAuthorReport(applyCombinationAuthorReport(applyPresaleAuthorReport(applyPointsAuthorReport(applyCouponAuthorReport(applyPromotionAuthorReport(applyCommunityAuthorReport(applyEditorialAuthorReport(applyFollowAuthorReport(updated as unknown as T)))))))))));
}

interface ApiAuditReport {
  version: number;
  methodology: Record<string, string>;
  backend: {
    file: string;
    sha256: string;
    rootRouteSources?: Array<{ file: string; sha256: string }>;
    registeredRoutes: Array<{
      source?: string;
      method: string;
      path: string;
      line: number;
      handler: string;
      availability: "executable" | "controlled_unavailable";
    }>;
  };
  frontendSources: Array<{ file: string; sha256: string }>;
  counts: {
    callSites: number;
    pathVariants: number;
    registered: number;
    executable: number;
    controlledUnavailable: number;
    unregistered: number;
    unresolved: number;
  };
  unregistered: unknown[];
  unresolved: unknown[];
  controlledUnavailable: unknown[];
  calls: Array<{
    method: string;
    path: string;
    source: string;
    line: number;
    registered: boolean;
    matchedRoute: string | null;
    matchedHandler: string | null;
    availability: "executable" | "controlled_unavailable" | "unregistered";
  }>;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(testDir, "..");
const guestFollowupRaw = readFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts-guest-invoice-manual-red-note-followup-20261013.json"), "utf8");
const guestFollowup = JSON.parse(guestFollowupRaw) as ApiAuditReport;
const current = JSON.parse(readCurrentFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts.json"), "utf8")) as ApiAuditReport;
const merged = JSON.parse(readFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts-merged-work-branches-20261015.json"), "utf8")) as ApiAuditReport;
const rootSourceRefresh = JSON.parse(readFileSync(
  join(workerRoot, "audit", "admin-api-root-source-refresh-20261021.json"), "utf8")) as {
    route_file: string; before_sha256: string; after_sha256: string; inserted_line: number;
    inserted_source: string; shifted_route_records: number; historical_report_file: string;
    historical_report_sha256: string; current_report_file: string; current_report_sha256: string;
  };
const stateSourceIncrement = JSON.parse(readFileSync(
  join(workerRoot, "audit", "community-state-root-source-increment-20261021.json"), "utf8")) as typeof rootSourceRefresh & {
    previous_current_report_sha256: string;
    semantic_admin_changes: number;
    historical_video_proof: { file: string; sha256: string };
    statistics_restoration: { file: string; sha256: string };
  };
const availabilityFollowup = JSON.parse(readFileSync(
  join(workerRoot, "audit", "community-availability-root-source-followup-20261021.json"), "utf8")) as RouteSourceFollowup & {
    route_file: string; shifted_route_records: number; previous_current_report_sha256: string;
    current_report_file: string; current_report_sha256: string; semantic_admin_changes: number;
    prior_state_proof: { file: string; sha256: string };
  };
const footerBindingRaw = readFileSync(join(workerRoot, 'audit', 'diy-footer-source-binding-20261022.json'), 'utf8');
const footerBinding = JSON.parse(footerBindingRaw) as { admin_current_report: {
  file:string;sha256:string;previous_report_sha256:string;backend_equal:boolean;
  frontend_source_changes:Array<{file:string;before_sha256:string;after_sha256:string}>;
  call_line_changes:Array<{method:string;path:string;source:string;before_line:number;after_line:number}>;
} };
const presentationBindingRaw = readFileSync(join(workerRoot, 'audit', 'diy-presentation-source-binding-20261022.json'), 'utf8');
const presentationBinding = JSON.parse(presentationBindingRaw) as typeof footerBinding & { sources:Array<{
  file:string;before_sha256:string;after_sha256:string;
  edits:Array<{before_source:string;after_source:string}>;
}> };
const customerBinding = JSON.parse(readFileSync(join(workerRoot, 'audit', 'diy-customer-service-source-binding-20261023.json'), 'utf8')) as typeof presentationBinding;
const pageSettingsBinding = JSON.parse(readFileSync(join(workerRoot, 'audit', 'diy-page-settings-source-binding-20261023.json'), 'utf8')) as typeof presentationBinding;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const previousNavigationReport = JSON.parse(readFileSync(join(workerRoot, '..', navigationBinding.previous_report.file), 'utf8')) as ApiAuditReport;
function beforeNavigationSource(file: string, supplied?: string): string { return reverseNavigationAuthorSource(file, reverseCarouselAuthorSource(file, reverseListAuthorSource(file, beforeStateAuthorSource(file, normalizeAdminAuditSource(supplied ?? readFileSync(join(workerRoot, '..', file), 'utf8')))))); }

function beforePageSettingsSource(file:string, supplied?:string):string {
  let source=beforeNavigationSource(file,supplied);
  const proof=pageSettingsBinding.sources.find(row=>row.file===file);
  if(!proof)return source;
  expect(sha256(source)).toBe(proof.after_sha256);
  for(const edit of [...proof.edits].reverse()) {
    expect(source.split(edit.after_source)).toHaveLength(2);
    source=source.replace(edit.after_source,edit.before_source);
  }
  expect(sha256(source)).toBe(proof.before_sha256);
  return source;
}

function beforeCustomerSource(file:string, supplied?:string):string {
  let source=beforePageSettingsSource(file,supplied);
  const proof=customerBinding.sources.find(row=>row.file===file);
  if(!proof)return source;
  expect(sha256(source)).toBe(proof.after_sha256);
  for(const edit of [...proof.edits].reverse()) {
    expect(source.split(edit.after_source)).toHaveLength(2);
    source=source.replace(edit.after_source,edit.before_source);
  }
  expect(sha256(source)).toBe(proof.before_sha256);
  return source;
}

function beforePresentationSource(file:string):string {
  const proof=presentationBinding.sources.find(row=>row.file===file)!;
  expect(proof).toBeDefined();
  let source=beforeCustomerSource(file);
  expect(sha256(source)).toBe(proof.after_sha256);
  for(const edit of [...proof.edits].reverse()) {
    expect(source.split(edit.after_source)).toHaveLength(2);
    source=source.replace(edit.after_source,edit.before_source);
  }
  expect(sha256(source)).toBe(proof.before_sha256);
  return source;
}

function applyReportSourceIncrement(before: ApiAuditReport, proof: Pick<typeof rootSourceRefresh, "route_file" | "before_sha256" | "after_sha256" | "inserted_line" | "shifted_route_records">): ApiAuditReport {
  const expected = structuredClone(before);
  const rootProof = expected.backend.rootRouteSources!.find(row => row.file === proof.route_file)!;
  expect(rootProof.sha256).toBe(proof.before_sha256);
  rootProof.sha256 = proof.after_sha256;
  let shifted = 0;
  for (const route of expected.backend.registeredRoutes) {
    if (route.source === proof.route_file && route.line >= proof.inserted_line) { route.line++; shifted++; }
  }
  expect(shifted).toBe(proof.shifted_route_records);
  return expected;
}

const historicalRaw = readFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts-legacy-role-operations-followup-20261009.json"),
  "utf8",
);
const historical = JSON.parse(historicalRaw) as ApiAuditReport;

function withoutLine<T extends { line: number }>(entry: T): Omit<T, "line"> {
  const { line: _line, ...semantic } = entry;
  return semantic;
}

function semanticCounts(entries: Array<{ line: number }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = JSON.stringify(withoutLine(entry));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe("Admin frontend API registration audit", () => {
  it.each(["\n", "\r\n", "\r"])("canonicalizes source line endings %j without changing handler text", (ending) => {
    const lines = ["(c) =>", "  c.json({ status: 200 })", ""];
    expect(normalizeAdminAuditSource(lines.join(ending))).toBe(lines.join("\n"));
  });

  it("has no statically unregistered or unresolved request paths", () => {
    expect(current.version).toBe(2);
    expect(current.counts.callSites).toBeGreaterThan(250);
    expect(current.counts.pathVariants).toBe(current.calls.length);
    expect(current.counts.registered).toBe(current.calls.length);
    expect(current.counts.executable + current.counts.controlledUnavailable).toBe(current.calls.length);
    expect(current.counts.controlledUnavailable).toBe(current.controlledUnavailable.length);
    expect(current.counts.unregistered).toBe(0);
    expect(current.counts.unresolved).toBe(0);
    expect(current.unregistered).toEqual([]);
    expect(current.unresolved).toEqual([]);
    expect(current.calls.every((call) => call.registered && call.matchedRoute && call.matchedHandler)).toBe(true);
  });

  it("recomputes the same deterministic report from the current frontend and routes", () => {
    expect(buildAdminFrontendApiAuditReport()).toEqual(current);
  });

  it("retains the dated video inventory and applies only the later community state source increment", () => {
    expect(rootSourceRefresh.route_file).toBe("workers-ts/src/routes/v1/index.ts");
    expect(rootSourceRefresh.inserted_source).toBe('v1Routes.post("/upload/video", authMiddleware({ force: true }), AttachmentController.userUploadVideo);');
    expect(stateSourceIncrement.route_file).toBe(rootSourceRefresh.route_file);
    expect(stateSourceIncrement.inserted_source).toBe('v1Routes.get("/community/state/:id", authMiddleware({ force: false }), CommunityController.communityState);');
    expect(stateSourceIncrement.inserted_line).toBe(972);
    expect(stateSourceIncrement.shifted_route_records).toBe(716);
    expect(stateSourceIncrement.semantic_admin_changes).toBe(0);
    expect(stateSourceIncrement.before_sha256).toBe(rootSourceRefresh.after_sha256);
    const routeSource = beforeNavigationSource(rootSourceRefresh.route_file);
    const stateSource = reverseRouteSourceFollowup(routeSource, availabilityFollowup);
    const videoSource = reverseRouteSourceIncrement(stateSource, stateSourceIncrement);
    reverseRouteSourceIncrement(videoSource, rootSourceRefresh);
    expect(stateSourceIncrement.historical_video_proof).toEqual({
      file: "workers-ts/audit/admin-api-root-source-refresh-20261021.json",
      sha256: "f9d8a11715cb1a07bcf9aa14b806527788be6d197978807639320a3d10127cc7",
    });
    expect(stateSourceIncrement.statistics_restoration).toEqual({
      file: "workers-ts/audit/statistics-script-restoration-20261015.json",
      sha256: "68dbcb37e31f6ed8c57efe0ab0c41684f1e1edda9394a547129cf235ab5cf8f1",
    });
    for (const proof of [stateSourceIncrement.historical_video_proof, stateSourceIncrement.statistics_restoration]) {
      expect(sha256(readFileSync(join(workerRoot, "..", proof.file)))).toBe(proof.sha256);
    }
    expect(sha256(readFileSync(join(workerRoot, "..", rootSourceRefresh.historical_report_file))))
      .toBe(rootSourceRefresh.historical_report_sha256);
    expect(rootSourceRefresh.historical_report_sha256).toBe("707ff4a109977b12bbf13caf8a48ec9edb116579e189d0873972fc1bc96c9cb8");
    const videoReport = applyReportSourceIncrement(merged, rootSourceRefresh);
    expect(sha256(JSON.stringify(videoReport, null, 2) + "\n")).toBe(rootSourceRefresh.current_report_sha256);
    expect(stateSourceIncrement.previous_current_report_sha256).toBe(rootSourceRefresh.current_report_sha256);
    const stateReport = applyReportSourceIncrement(videoReport, stateSourceIncrement);
    expect(sha256(JSON.stringify(stateReport, null, 2) + "\n")).toBe(stateSourceIncrement.current_report_sha256);
    expect(availabilityFollowup.prior_state_proof).toEqual({
      file: "workers-ts/audit/community-state-root-source-increment-20261021.json",
      sha256: "dd1c00d3d717e1ba8d68c675af276f3605c8aea33772713a295ab2285b646d73",
    });
    expect(sha256(readFileSync(join(workerRoot, "..", availabilityFollowup.prior_state_proof.file))))
      .toBe(availabilityFollowup.prior_state_proof.sha256);
    expect(availabilityFollowup.previous_current_report_sha256).toBe(stateSourceIncrement.current_report_sha256);
    expect(availabilityFollowup.semantic_admin_changes).toBe(0);
    expect(availabilityFollowup.route_file).toBe(stateSourceIncrement.route_file);
    const prior = applyReportSourceIncrement(stateReport, {
      ...availabilityFollowup, inserted_line: availabilityFollowup.edits[0].after_line,
    });
    expect(sha256(JSON.stringify(prior, null, 2) + '\n')).toBe(availabilityFollowup.current_report_sha256);
    expect(sha256(footerBindingRaw)).toBe('88ada866df4f97a5f50e3cce0321ac7accf16f0989198e2877d4455c7f51b2dd');
    const footer = footerBinding.admin_current_report;
    expect(footer.previous_report_sha256).toBe(availabilityFollowup.current_report_sha256);
    expect(footer.backend_equal).toBe(true);
    const updated = structuredClone(prior);
    expect(footer.frontend_source_changes).toHaveLength(1);
    expect(footer.frontend_source_changes[0].file).toBe('view/admin-ts/src/pages/content/DiseList.vue');
    for (const change of footer.frontend_source_changes) {
      const row = updated.frontendSources.find(item=>item.file===change.file)!;
      expect(row.sha256).toBe(change.before_sha256); row.sha256=change.after_sha256;
      expect(sha256(beforePresentationSource(change.file))).toBe(change.after_sha256);
    }
    expect(footer.call_line_changes).toHaveLength(3);
    for (const change of footer.call_line_changes) {
      const rows=updated.calls.filter(item=>item.method===change.method&&item.path===change.path&&item.source===change.source);
      expect(rows).toHaveLength(1); expect(rows[0].line).toBe(change.before_line); rows[0].line=change.after_line;
    }
    expect(stateSourceIncrement.current_report_file).toBe(footer.file);
    expect(sha256(JSON.stringify(updated,null,2)+'\n')).toBe(footer.sha256);
    expect(sha256(presentationBindingRaw)).toBe('ebd5c6c880685b6fe276cb9b21e894257e00dc2e7f160bdf8bde094dd2c859b6');
    const presentation=presentationBinding.admin_current_report;
    expect(presentation.previous_report_sha256).toBe(footer.sha256);
    expect(presentation.backend_equal).toBe(true);
    expect(presentation.frontend_source_changes).toHaveLength(1);
    expect(presentation.frontend_source_changes[0].file).toBe('view/admin-ts/src/pages/content/DiseList.vue');
    expect(presentationBinding.sources.map(row=>row.file)).toEqual(['view/admin-ts/src/pages/content/DiseList.vue','view/admin-ts/src/components/ProductVideoUploader.vue']);
    for(const proof of presentationBinding.sources) beforePresentationSource(proof.file);
    for(const change of presentation.frontend_source_changes) {
      const row=updated.frontendSources.find(item=>item.file===change.file)!;
      expect(row.sha256).toBe(change.before_sha256);row.sha256=change.after_sha256;
      expect(sha256(beforeCustomerSource(change.file))).toBe(change.after_sha256);
    }
    expect(presentation.call_line_changes).toHaveLength(3);
    for(const change of presentation.call_line_changes) {
      const rows=updated.calls.filter(item=>item.method===change.method&&item.path===change.path&&item.source===change.source);
      expect(rows).toHaveLength(1);expect(rows[0].line).toBe(change.before_line);rows[0].line=change.after_line;
    }
    expect(presentation.file).toBe(footer.file);
    expect(sha256(JSON.stringify(updated,null,2)+'\n')).toBe(presentation.sha256);
    const customer=customerBinding.admin_current_report;
    expect(customer.previous_report_sha256).toBe(presentation.sha256);
    expect(customer.backend_equal).toBe(true);
    expect(customerBinding.sources.map(row=>row.file)).toEqual(['view/admin-ts/src/pages/content/DiseList.vue']);
    expect(customer.frontend_source_changes).toHaveLength(1);
    for(const change of customer.frontend_source_changes) {
      const row=updated.frontendSources.find(item=>item.file===change.file)!;
      expect(row.sha256).toBe(change.before_sha256);
      expect(sha256(beforeCustomerSource(change.file))).toBe(change.before_sha256);
      row.sha256=change.after_sha256;
      expect(sha256(beforePageSettingsSource(change.file))).toBe(change.after_sha256);
    }
    expect(customer.call_line_changes).toHaveLength(3);
    for(const change of customer.call_line_changes) {
      const rows=updated.calls.filter(item=>item.method===change.method&&item.path===change.path&&item.source===change.source);
      expect(rows).toHaveLength(1);expect(rows[0].line).toBe(change.before_line);rows[0].line=change.after_line;
    }
    expect(sha256(JSON.stringify(updated,null,2)+'\n')).toBe(customer.sha256);
    const settings=pageSettingsBinding.admin_current_report;
    expect(settings.previous_report_sha256).toBe(customer.sha256);expect(settings.backend_equal).toBe(true);
    expect(pageSettingsBinding.sources.map(row=>row.file)).toEqual(['view/admin-ts/src/pages/content/DiseList.vue']);
    expect(settings.frontend_source_changes).toHaveLength(1);
    for(const change of settings.frontend_source_changes) {
      const row=updated.frontendSources.find(item=>item.file===change.file)!;
      expect(row.sha256).toBe(change.before_sha256);expect(sha256(beforePageSettingsSource(change.file))).toBe(change.before_sha256);
      row.sha256=change.after_sha256;expect(sha256(beforeNavigationSource(change.file))).toBe(change.after_sha256);
    }
    expect(settings.call_line_changes).toHaveLength(3);
    for(const change of settings.call_line_changes) {
      const rows=updated.calls.filter(item=>item.method===change.method&&item.path===change.path&&item.source===change.source);
      expect(rows).toHaveLength(1);expect(rows[0].line).toBe(change.before_line);rows[0].line=change.after_line;
    }
    expect(previousNavigationReport).toEqual(updated);expect(applyConfigClassReport(applyStateAuthorReport(applyListAuthorReport(applyCarouselAuthorReport(applyNavigationAuthorReport(updated)))))).toEqual(current);expect(settings.file).toBe(customer.file);
    expect(sha256(JSON.stringify(updated,null,2)+'\n')).toBe(settings.sha256);
    expect(navigationBinding.previous_report.sha256).toBe(settings.sha256);
    expect(sha256(readFileSync(join(workerRoot,'..',navigationBinding.previous_report.file)))).toBe(settings.sha256);
    expect(sha256(readFileSync(join(workerRoot,'..',carouselBinding.previous_report.file)))).toBe(navigationBinding.current_report.sha256);
  });

  it('rejects unreviewed page-settings editor wiring and metadata preservation changes before reconstructing historical inventories',()=>{
    const file='view/admin-ts/src/pages/content/DiseList.vue',source=readFileSync(join(workerRoot,'..',file),'utf8');
    for(const changed of [source+'\n// unreviewed edit\n',source.replace('<DiyPageSettingsEditor ','<DiyCustomerServiceEditor '),source.replace('metadataOnly ? {id: form.id, ...metadata}','metadataOnly ? {id: form.id, value, ...metadata}')]) {
      expect(changed).not.toBe(source);expect(()=>beforePageSettingsSource(file,changed)).toThrow();
    }
  });

  it('rejects unreviewed customer editor wiring and canonical save changes instead of absorbing them into the historical presentation inventory',()=>{
    const file='view/admin-ts/src/pages/content/DiseList.vue',source=readFileSync(join(workerRoot,'..',file),'utf8');
    for(const changed of [source+'\n// extra edit\n',source.replace('<DiyCustomerServiceEditor ','<DiyPresentationEditor '),source.replace('canonicalCustomerServiceValue(canonicalPresentationValue(canonicalFooterValue(value)))','canonicalPresentationValue(canonicalFooterValue(value))')]) {
      expect(changed).not.toBe(source);
      expect(()=>beforeCustomerSource(file,changed)).toThrow();
    }
  });

  it.each([
    ["duplicate state registration", (source: string) => source + stateSourceIncrement.inserted_source + "\n"],
    ["changed state authentication", (source: string) => source.replace(stateSourceIncrement.inserted_source,
      stateSourceIncrement.inserted_source.replace("force: false", "force: true"))],
    ["changed state handler", (source: string) => source.replace("CommunityController.communityState);", "CommunityController.communityDetail);")],
    ["extra source line", (source: string) => source + "// unrelated source change\n"],
    ["changed statistics registration", (source: string) => source.replace("'/get_script'", "'/get_script_changed'")],
  ])("rejects %s instead of absorbing source drift into the dated proof", (_name, mutate) => {
    const routeSource = beforeNavigationSource(stateSourceIncrement.route_file);
    const changed = mutate(reverseRouteSourceFollowup(routeSource, availabilityFollowup));
    expect(changed).not.toBe(reverseRouteSourceFollowup(routeSource, availabilityFollowup));
    expect(() => reverseRouteSourceIncrement(changed, stateSourceIncrement)).toThrow();
  });

  it("checks the predecessor hash as well as the current hash and exact insertion", () => {
    const source = beforeNavigationSource(stateSourceIncrement.route_file);
    expect(() => reverseRouteSourceIncrement(reverseRouteSourceFollowup(source, availabilityFollowup), { ...stateSourceIncrement, before_sha256: "0".repeat(64) })).toThrow(/predecessor/);
  });

  it("expands the moderation mode type alias into both registered form routes", () => {
    const forms = current.calls.filter(call => call.source === "view/admin-ts/src/api/productModeration.ts"
      && call.method === "GET" && /^\/product\/product\/(verify|remove)\/:param$/.test(call.path));
    expect(forms.map(call => ({ path: call.path, route: call.matchedRoute, handler: call.matchedHandler,
      registered: call.registered, availability: call.availability }))).toEqual([
      { path: "/product/product/verify/:param", route: "/product/product/verify/:id",
        handler: "AdminProductModeration.verifyForm", registered: true, availability: "executable" },
      { path: "/product/product/remove/:param", route: "/product/product/remove/:id",
        handler: "AdminProductModeration.removeForm", registered: true, availability: "executable" },
    ]);
  });

  it('accounts for all six durable video upload endpoints through their actual Admin handlers', () => {
    const actual=current.calls.filter(call=>call.source==='view/admin-ts/src/api/productVideoUpload.ts')
      .map(call=>({method:call.method,path:call.path,route:call.matchedRoute,handler:call.matchedHandler,
        registered:call.registered,availability:call.availability})).sort((a,b)=>(a.method+a.path).localeCompare(b.method+b.path));
    const expected=[
      ['GET','/file/video_uploads/:param','/file/video_uploads/:uploadId','query'],
      ['GET','/file/video_uploads/:param/preview','/file/video_uploads/:uploadId/preview','preview'],
      ['POST','/file/video_uploads/:param','/file/video_uploads/:uploadId','initialize'],
      ['POST','/file/video_uploads/:param/cancel','/file/video_uploads/:uploadId/cancel','cancel'],
      ['POST','/file/video_uploads/:param/complete','/file/video_uploads/:uploadId/complete','complete'],
      ['PUT','/file/video_uploads/:param/parts/:param','/file/video_uploads/:uploadId/parts/:part','part'],
    ].map(([method,path,route,handler])=>({method,path,route,handler:'AdminProductVideo.'+handler,registered:true,availability:'executable'}))
      .sort((a,b)=>(a.method+a.path).localeCompare(b.method+b.path));
    expect(actual).toEqual(expected);
  });

  it("resolves the absolute ERP consumer through the real mounted v1 Admin root and pins every source", () => {
    expect(current.calls.find(call => call.method === "GET" && call.path === "/api/admin/erp/config"))
      .toMatchObject({ source: "view/admin-ts/src/api/productStock.ts", registered: true,
        matchedRoute: "/api/admin/erp/config", matchedHandler: "AdminController.adminErpConfig", availability: "executable" });
    const route = current.backend.registeredRoutes.find(route => route.method === "GET" && route.path === "/api/admin/erp/config");
    expect(route).toMatchObject({ source: "workers-ts/src/routes/v1/index.ts", handler: "AdminController.adminErpConfig" });
    expect(route?.line).toBeGreaterThan(0);
    expect(current.backend.rootRouteSources?.map(source => source.file)).toEqual([
      "workers-ts/src/app.ts", "workers-ts/src/routes/index.ts", "workers-ts/src/routes/v1/index.ts",
    ]);
    for (const source of current.backend.rootRouteSources ?? []) {
      const text = readCurrentFileSync(join(workerRoot, "..", source.file), "utf8");
      expect(source.sha256).toBe(createHash("sha256").update(normalizeAdminAuditSource(text)).digest("hex"));
    }
    expect(current.backend.registeredRoutes.some(route => route.path === "/api/v1/admin/erp/config")).toBe(false);
  });

  it("retains the reviewed October 9 inventory and adds exactly the four manual red-note API contracts", () => {
    expect(createHash("sha256").update(normalizeAdminAuditSource(guestFollowupRaw)).digest("hex"))
      .toBe("570b1f0ae132e3fd9b52ace2d7d6ecfceb31f1bd38d0d36c9c144b6c2320611e");
    expect(createHash("sha256").update(normalizeAdminAuditSource(historicalRaw)).digest("hex"))
      .toBe("2f870baccb6152d19d62327b52ba58f3954119e4789201c9040dbb7f84858ab9");
    const routes = [
      { method: "GET", path: "/order/invoices/:id/red-notes", handler: "AdminInvoiceRedNote.list", availability: "executable" },
      { method: "POST", path: "/order/invoices/:id/red-notes", handler: "AdminInvoiceRedNote.record", availability: "executable" },
      { method: "POST", path: "/order/invoices/:id/red-notes/:recordId/review", handler: "AdminInvoiceRedNote.review", availability: "executable" },
      { method: "GET", path: "/order/invoices/:id/red-notes/operations/:requestId", handler: "AdminInvoiceRedNote.operation", availability: "executable" },
    ];
    const calls = routes.map((route) => ({
      method: route.method,
      path: route.path.replace(/:[A-Za-z][A-Za-z0-9]*/g, ":param"),
      source: "view/admin-ts/src/api/invoiceManagement.ts",
      registered: true,
      matchedRoute: route.path,
      matchedHandler: route.handler,
      availability: route.availability,
    }));
    const isManualRoute = (route: { method: string; path: string }) =>
      routes.some((expected) => route.method === expected.method && route.path === expected.path);
    const isManualCall = (call: { method: string; path: string }) =>
      calls.some((expected) => call.method === expected.method && call.path === expected.path);
    expect(historical.backend.registeredRoutes.some(isManualRoute)).toBe(false);
    expect(historical.calls.some(isManualCall)).toBe(false);
    expect(guestFollowup.backend.registeredRoutes.filter(isManualRoute).map(withoutLine)).toEqual(routes);
    expect(guestFollowup.calls.filter(isManualCall).map(withoutLine)).toEqual(calls);
    expect(semanticCounts(guestFollowup.backend.registeredRoutes.filter((route) => !isManualRoute(route))))
      .toEqual(semanticCounts(historical.backend.registeredRoutes));
    expect(semanticCounts(guestFollowup.calls.filter((call) => !isManualCall(call))))
      .toEqual(semanticCounts(historical.calls));
    expect(guestFollowup.counts).toEqual({
      ...historical.counts,
      callSites: historical.counts.callSites + calls.length,
      pathVariants: historical.counts.pathVariants + calls.length,
      registered: historical.counts.registered + calls.length,
      executable: historical.counts.executable + calls.length,
    });
    expect(guestFollowup.methodology).toEqual(historical.methodology);
    expect(guestFollowup.backend.file).toBe(historical.backend.file);
    expect(guestFollowup.frontendSources).toEqual(historical.frontendSources.map((entry) =>
      entry.file === "view/admin-ts/src/api/invoiceManagement.ts"
        ? { ...entry, sha256: "9678c08907accc39f13a7fcf4e785709b0821ba68264abbaa2a0a37fcc700aec" }
        : entry));
    expect(guestFollowup.controlledUnavailable).toEqual(historical.controlledUnavailable);
    expect(guestFollowup.unregistered).toEqual(historical.unregistered);
    expect(guestFollowup.unresolved).toEqual(historical.unresolved);
  });
});
