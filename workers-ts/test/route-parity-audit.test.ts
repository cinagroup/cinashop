import { describe, expect, it } from "vitest";
import { maskPhpComments } from "../scripts/php-source";
import { readFileSync } from "node:fs";
import { legacyRouteAuthorityEvidenceFiles, RESTORED_STATISTICS_EVIDENCE } from "../scripts/route-authority-evidence";

describe("route parity PHP source handling", () => {
  it("preserves the complete reviewed evidence inventory after the statistics retirement is superseded", () => {
    const authority = JSON.parse(readFileSync("audit/legacy-route-authority.json", "utf8"));
    const decisions = JSON.parse(readFileSync("audit/legacy-route-decisions.json", "utf8"));
    const restoration = JSON.parse(readFileSync("audit/statistics-script-restoration-20261015.json", "utf8"));
    const routes = ["api", "admin", "supplier", "kefu", "out", "erp"].map(name => `cinashop-php/route/${name}.php`);
    expect(RESTORED_STATISTICS_EVIDENCE).toEqual(restoration.php_sources.map((proof: { file: string }) => proof.file));
    expect(decisions.decisions.some((decision: { path: string }) => decision.path === "/api/get_script")).toBe(false);
    const actual = legacyRouteAuthorityEvidenceFiles(routes, decisions.decisions);
    expect(actual).toHaveLength(26);
    expect(actual).toEqual(Object.keys(authority.files).sort());
    // Keeping the old decision as historical input neither drops nor duplicates
    // evidence. It is not reintroduced into the live retirement manifest.
    expect(legacyRouteAuthorityEvidenceFiles(routes, [...decisions.decisions, restoration.previous_retirement])).toEqual(actual);
  });

  it("masks disabled route declarations without changing offsets or lines", () => {
    const source = [
      "Route::get('active', 'Active@index');",
      "// Route::get('disabled', 'Disabled@index');",
      "# Route::post('disabled-hash', 'Disabled@save');",
      "/* Route::delete('disabled-block', 'Disabled@delete'); */",
      "Route::get('tail', 'Tail@index');",
    ].join("\n");
    const masked = maskPhpComments(source);

    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).toContain("Route::get('active'");
    expect(masked).toContain("Route::get('tail'");
    expect(masked).not.toContain("disabled");
  });

  it("does not treat comment markers inside quoted strings as comments", () => {
    const source = [
      "Route::get('https://example.test/path#fragment', 'Url@index');",
      "Route::get('escaped-\\\'//value', 'Escaped@index');",
      "// Route::get('disabled', 'Disabled@index');",
    ].join("\n");
    const masked = maskPhpComments(source);

    expect(masked).toContain("https://example.test/path#fragment");
    expect(masked).toContain("escaped-\\\'//value");
    expect(masked).not.toContain("disabled");
  });
});
