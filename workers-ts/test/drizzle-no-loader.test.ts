import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const file = "vendor/drizzle-kit-0.31.10-no-esm-loader.tgz";
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const installed = JSON.parse(readFileSync(join(root, "node_modules/drizzle-kit/package.json"), "utf8"));

describe("TEST-004E Drizzle dev dependency retirement", () => {
  it("pins the manifest-only package and excludes the obsolete esbuild-kit chain", () => {
    const integrity = `sha512-${createHash("sha512").update(readFileSync(join(root, file))).digest("base64")}`;
    expect(packageJson.devDependencies["drizzle-kit"]).toBe(`file:${file}`);
    expect(lock.packages[""].devDependencies["drizzle-kit"]).toBe(`file:${file}`);
    expect(lock.packages["node_modules/drizzle-kit"]).toMatchObject({
      version: "0.31.10", resolved: `file:${file}`, integrity,
    });
    expect(installed.version).toBe("0.31.10");
    expect(installed.dependencies).not.toHaveProperty("@esbuild-kit/esm-loader");
    expect(lock.packages["node_modules/drizzle-kit"].dependencies).not.toHaveProperty("@esbuild-kit/esm-loader");
    expect(Object.entries(lock.packages).filter(([name, value]) =>
      name.includes("node_modules/@esbuild-kit/")
      || (name.endsWith("/esbuild") && (value as { version?: string }).version === "0.18.20"))).toEqual([]);
  });
});
