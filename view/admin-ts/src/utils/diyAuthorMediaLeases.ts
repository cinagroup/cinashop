interface MediaLeaseContext {
  current: () => boolean;
  identity: () => string;
  raw: () => string;
  references: () => unknown[];
  stable: (value: unknown) => string;
  resolve: (reference: unknown, capability: unknown) => string;
  read: () => Record<string, string>;
  write: (leases: Record<string, string>) => void;
}
interface OwnEcho {
  before: string;
  after: string;
  context: string;
  leases: Record<string, string>;
  echoed: boolean;
}

/** Preview tickets belong to one editor context and one exact parent echo.
 * An unrelated document replacement, even one with equal image IDs, cannot
 * re-adopt tickets from an earlier owner, selection, or publication state. */
export function createDiyAuthorMediaLeases(context: MediaLeaseContext) {
  let pending: OwnEcho | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  function clear(preserveEcho = false) {
    generation++;
    clearTimeout(timer); timer = undefined;
    if (!preserveEcho) pending = null;
    context.write({});
  }
  function renew(source: Record<string, string>) {
    generation++;
    clearTimeout(timer); timer = undefined;
    const next: Record<string, string> = {};
    if (context.current()) for (const reference of context.references()) {
      const key = context.stable(reference), capability = source[key];
      if (capability && context.resolve(reference, capability)) next[key] = capability;
    }
    context.write(next);
    const expires = Object.values(next).flatMap(value => {
      const match = /^\/api\/assets\/[1-9]\d*\?(?:[^#]*&)?expires=([1-9]\d*)(?:&|$)/u.exec(value);
      return match ? [Number(match[1]) * 1000] : [];
    });
    if (!expires.length) return;
    const issued = generation, identity = context.identity();
    timer = setTimeout(() => {
      if (issued !== generation) return;
      if (!context.current() || identity !== context.identity()) { clear(); return; }
      renew(context.read());
    }, Math.min(2147483647, Math.max(1, Math.min(...expires) - Date.now() + 1)));
  }
  function capture(before: string, after: string): OwnEcho {
    return { before, after, context: context.identity(), leases: { ...context.read() }, echoed: false };
  }
  function expect(echo: OwnEcho) { pending = echo; }
  function current(echo: OwnEcho | null): echo is OwnEcho {
    return !!echo && pending === echo && echo.echoed && context.current()
      && echo.context === context.identity() && echo.after === context.raw();
  }
  function adopt(after: string, before: string | undefined) {
    const echo = pending;
    if (!echo || echo.echoed || before !== echo.before || after !== echo.after
      || !context.current() || echo.context !== context.identity()) return false;
    echo.echoed = true;
    return true;
  }
  function settle(echo: OwnEcho) {
    if (!current(echo)) { if (pending === echo) pending = null; return false; }
    renew(echo.leases);
    return true;
  }
  return { clear, renew, capture, expect, current, adopt, settle, pending: () => pending };
}
