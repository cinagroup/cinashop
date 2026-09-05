import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

interface RouteDecision {
  surface: string;
  method: string;
  path: string;
  status: string;
  reason: string;
  evidence: string[];
  replacement: string;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if ([".ts", ".tsx", ".vue", ".js"].includes(extname(path))) {
      files.push(path);
    }
  }
  return files;
}

const authority = JSON.parse(
  readFileSync("audit/legacy-route-authority.json", "utf8"),
) as { surfaces: { api: Array<{ method: string; path: string; target: string }> } };
const decisions = JSON.parse(
  readFileSync("audit/legacy-route-decisions.json", "utf8"),
) as { decisions: RouteDecision[] };

describe("legacy dynamic statistics script retirement", () => {
  it("keeps the exact PHP route in authority and retires it with source evidence", () => {
    expect(authority.surfaces.api).toContainEqual(expect.objectContaining({
      method: "GET",
      path: "/api/get_script",
      target: "v1.PublicController/getScript",
    }));
    expect(decisions.decisions).toContainEqual(expect.objectContaining({
      surface: "api",
      method: "GET",
      path: "/api/get_script",
      status: "retired",
      evidence: expect.arrayContaining([
        "cinashop-php/route/api.php:26",
        "cinashop-php/app/controller/api/v1/PublicController.php:640",
        "cinashop-php/view/uniapp/App.vue:290",
      ]),
    }));
  });

  it("does not expose or consume the arbitrary-script contract in current sources", () => {
    const roots = [
      "src",
      "../view/admin-ts/src",
      "../view/pc-ts/src",
      "../view/supplier-ts/src",
      "../view/uniapp-ts/src",
      "../view/kefu-ts/src",
    ];
    const matches = roots.flatMap((root) => sourceFiles(root))
      .filter((file) => /get_script|system_statistics/.test(readFileSync(file, "utf8")));
    expect(matches).toEqual([]);
  });
});
