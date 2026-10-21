import { createHash } from "node:crypto";

export interface RouteSourceIncrement {
  before_sha256: string;
  after_sha256: string;
  inserted_line: number;
  inserted_source: string;
}

export interface RouteSourceFollowup {
  before_sha256: string;
  after_sha256: string;
  edits: Array<{ before_source: string; after_source: string; before_line?: number; after_line: number }>;
}

/** A later batch may replace exact registered calls as well as adding an import. */
export function reverseRouteSourceFollowup(source: string, proof: RouteSourceFollowup): string {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  if (digest(source) !== proof.after_sha256) throw new Error("Current route source differs from the exact followup");
  for (const edit of proof.edits) {
    if (!edit.after_source || source.split(edit.after_source).length !== 2
      || source.slice(0, source.indexOf(edit.after_source)).split("\n").length !== edit.after_line) {
      throw new Error("Expected one exact source replacement at its recorded line");
    }
  }
  let previous = source;
  for (const edit of proof.edits) previous = previous.replace(edit.after_source, edit.before_source);
  if (digest(previous) !== proof.before_sha256) throw new Error("Reversed route source differs from the followup predecessor");
  for (const edit of proof.edits) {
    if (edit.before_source && (previous.split(edit.before_source).length !== 2
      || previous.slice(0, previous.indexOf(edit.before_source)).split("\n").length !== edit.before_line)) {
      throw new Error("Expected one exact predecessor registration at its recorded line");
    }
  }
  return previous;
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
