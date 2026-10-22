import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("enforces the installed Worker mocker boundary, including nested lock copies", () => {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1",
    "../view/common/mocker-security.test.mjs", "../view/common/mocker-advisory-20261022.test.mjs"], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 20_000);
