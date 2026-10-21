import { createHash } from "node:crypto";

export interface RouteSourceIncrement {
  before_sha256: string;
  after_sha256: string;
  inserted_line: number;
  inserted_source: string;
}

/** Reverse one dated, whole-source-pinned addition; never filter arbitrary routes. */
export function reverseRouteSourceIncrement(source: string, proof: RouteSourceIncrement): string {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const lines = source.split("\n");
  if (!Number.isSafeInteger(proof.inserted_line) || proof.inserted_line < 1
    || proof.inserted_source.includes("\n") || proof.inserted_source.includes("\r")
    || lines[proof.inserted_line - 1] !== proof.inserted_source
    || lines.filter(line => line === proof.inserted_source).length !== 1) {
    throw new Error("Expected exactly one source addition at its recorded line");
  }
  if (digest(source) !== proof.after_sha256) throw new Error("Current route source differs from the dated increment");
  lines.splice(proof.inserted_line - 1, 1);
  const previous = lines.join("\n");
  if (digest(previous) !== proof.before_sha256) throw new Error("Reversed route source differs from the dated predecessor");
  return previous;
}
