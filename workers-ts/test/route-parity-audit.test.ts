import { describe, expect, it } from "vitest";
import { maskPhpComments } from "../scripts/php-source";

describe("route parity PHP source handling", () => {
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
