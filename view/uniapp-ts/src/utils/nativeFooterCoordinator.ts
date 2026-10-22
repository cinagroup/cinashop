export interface NativeFooterClaim { active: boolean; custom: boolean; modal: boolean; tab: boolean; actor?: string }
interface Entry extends NativeFooterClaim { order: number }
/** Serialize platform side effects: stale callbacks still changed the OS bar. */
export function createNativeFooterCoordinator(
  apply: (hide: boolean, done: (error?: string) => void) => void,
  changed: (owner: string | null, error: string, pending: boolean, hidden: boolean | undefined) => void,
) {
  const claims = new Map<string, Entry>();
  let order = 0, applied: boolean | undefined, running = false, failed = '', failedTarget = '', revision = 0, physicalEpoch = 0, held = false;
  const target = () => [...claims].filter(([, claim]) => claim.active).sort((a, b) => b[1].order - a[1].order)[0];
  function sync(force = false) {
    const current = target(), owner = current?.[0] ?? null;
    const hide = !current || !current[1].tab || current[1].custom || current[1].modal;
    const key = `${owner}:${hide}:${revision}`;
    if (held) return;
    if (running) return;
    if (!force && (applied === hide || failedTarget === key)) { changed(owner, failedTarget === key ? failed : '', false, applied); return; }
    running = true; changed(owner, '', true, applied);
    let complete = false; const issuingPhysicalEpoch = physicalEpoch;
    apply(hide, error => {
      if (complete) return; complete = true; running = false;
      if (!error && issuingPhysicalEpoch === physicalEpoch) applied = hide;
      const latest = target(), latestHide = !latest || !latest[1].tab || latest[1].custom || latest[1].modal;
      if (issuingPhysicalEpoch !== physicalEpoch || (latest?.[0] ?? null) !== owner || latestHide !== hide || key !== `${latest?.[0] ?? null}:${latestHide}:${revision}`) { sync(); return; }
      failed = error ?? ''; failedTarget = error ? key : '';
      changed(owner, failed, false, applied);
    });
  }
  return {
    // Page transitions may recreate the native bar outside our API calls.
    // Revoke cached confirmation before render and hold until the Vue flush.
    invalidatePhysical() { physicalEpoch++; held = true; applied = undefined; failed = ''; failedTarget = ''; changed(target()?.[0] ?? null, '', true, undefined); return physicalEpoch; },
    reconcilePhysical(ticket: number) { if (ticket !== physicalEpoch) return; held = false; sync(); },
    claim(id: string, claim: NativeFooterClaim) {
      const previous = claims.get(id);
      if (previous && previous.active === claim.active && previous.custom === claim.custom && previous.modal === claim.modal && previous.tab === claim.tab && previous.actor === claim.actor) return;
      claims.set(id, { ...claim, order: claim.active && !previous?.active ? ++order : previous?.order ?? ++order }); revision++; sync();
    },
    release(id: string) { if (claims.delete(id)) { revision++; sync(); } },
    retry() { failedTarget = ''; sync(true); },
    owner: () => target()?.[0] ?? null,
  };
}
