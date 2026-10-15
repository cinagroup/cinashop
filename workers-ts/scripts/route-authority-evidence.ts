// The get_script retirement was superseded by an explicit restoration choice.
// Its original PHP evidence remains part of the reviewed authority inventory.
export const RESTORED_STATISTICS_EVIDENCE = [
  'cinashop-php/route/api.php',
  'cinashop-php/app/controller/api/v1/PublicController.php',
  'cinashop-php/view/uniapp/App.vue',
  'cinashop-php/app/services/system/config/SystemConfigServices.php',
] as const;

export function legacyRouteAuthorityEvidenceFiles(
  routeFiles: readonly string[],
  decisions: ReadonlyArray<{ evidence: readonly string[] }>,
): string[] {
  const files = new Set<string>([...routeFiles, ...RESTORED_STATISTICS_EVIDENCE]);
  for (const decision of decisions) {
    for (const evidence of decision.evidence ?? []) {
      const reference = /^(cinashop-php\/[A-Za-z0-9_./-]+):(\d+)$/.exec(evidence)?.[1];
      if (reference) files.add(reference);
    }
  }
  return [...files].sort();
}
