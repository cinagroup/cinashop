/**
 * Replace PHP comments with spaces while preserving source length and newlines.
 * Route offsets therefore still map to the original file for line reporting.
 */
export function maskPhpComments(source: string): string {
  const result = source.split("");
  let quote: "'" | '"' | "" = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  const mask = (index: number): void => {
    if (result[index] !== "\n" && result[index] !== "\r") result[index] = " ";
  };

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (current === "\n") lineComment = false;
      else mask(index);
      continue;
    }
    if (blockComment) {
      mask(index);
      if (current === "*" && next === "/") {
        mask(index + 1);
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      continue;
    }
    if (current === "/" && next === "/") {
      mask(index);
      mask(index + 1);
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "#") {
      mask(index);
      lineComment = true;
      continue;
    }
    if (current === "/" && next === "*") {
      mask(index);
      mask(index + 1);
      blockComment = true;
      index += 1;
    }
  }

  return result.join("");
}
