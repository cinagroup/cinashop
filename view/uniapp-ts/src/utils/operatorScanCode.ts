export type OperatorScanCode = { kind: "order" | "member"; code: string };

const SCAN_PATHS = new Set([
  "/pages/admin/order_cancellation/index", // inherited member-code QR target
  "/pages/operator/writeoff",
]);

function codeValue(value: string): OperatorScanCode | null {
  const code = value.trim();
  if (!code || code.length > 32 || code === "undefined" || /[\u0000-\u001f\u007f]/u.test(code)) return null;
  return { kind: /^\d{12}$/u.test(code) ? "order" : "member", code };
}

/** H5's deployed origin is the only implicit site origin. Native builds need an explicit allowlist. */
export function operatorScanSiteOrigins(): string[] {
  if (typeof window === "undefined") return [];
  const origin = window.location?.origin;
  if (typeof origin !== "string") return [];
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.origin === origin ? [origin] : [];
  } catch { return []; }
}

/** Decode only known scan destinations from approved origins. URL auth never grants a role. */
export function parseOperatorScanCode(value: unknown, allowedSiteOrigins: readonly string[] = []): OperatorScanCode | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 1024) return null;
  if (!text.includes("/") && !text.includes("?") && !text.includes("&")) return codeValue(text);
  if (text.startsWith("//")) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(text);
  if (hasScheme && !/^https?:\/\//iu.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text, "https://operator-scan.invalid");
  } catch {
    return null;
  }
  if (hasScheme && (url.username || url.password
    || !allowedSiteOrigins.some((allowed) => allowed === url.origin))) return null;
  if (!SCAN_PATHS.has(url.pathname) || !["http:", "https:"].includes(url.protocol)) return null;
  const codes = url.searchParams.getAll("code");
  const scenes = url.searchParams.getAll("scene");
  if (codes.length + scenes.length !== 1) return null;
  if (codes.length === 1) return codes[0].includes("%") ? null : codeValue(codes[0]);
  // URLSearchParams has already decoded this query value once.
  return parseDecodedScene(scenes[0]);
}

function parseDecodedScene(decoded: string): OperatorScanCode | null {
  if (!decoded || decoded.length > 256 || decoded.includes("%")) return null;
  const query = new URLSearchParams(decoded);
  if (query.getAll("code").length !== 1) return null;
  return codeValue(query.get("code") ?? "");
}

/** Mini Program scene contains only URL query pairs for its published page. */
export function parseOperatorScene(value: unknown): OperatorScanCode | null {
  if (typeof value !== "string" || !value || value.length > 256) return null;
  try {
    // Old mini-program scenes encode the whole `auth=3&code=...` query once.
    // Decode that envelope once; reject a second encoded layer and bad escapes.
    return parseDecodedScene(decodeURIComponent(value));
  } catch {
    return null;
  }
}
