import { defineStore } from 'pinia';

export interface AdminSessionValue {
  token: string;
  id: number;
  label: string;
  expiresAt: number;
  permissions: string[];
}

type ExpiryTimer = ReturnType<typeof setTimeout>;
interface ArmedExpiry {
  timer: ExpiryTimer;
  version: number;
  token: string;
  id: number;
  expiresAt: number;
}
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const expiryTimers = new WeakMap<object, ArmedExpiry>();

// Deliberately memory-only and separate from the shopper's uni_token/uni_uid.
// Reload requires a fresh Admin login; this store never persists credentials or PII.
// The separate, explicitly disclosed checkout journal can persist delivery data.
export const useAdminSession = defineStore('assisted-admin-session', {
  state: () => ({ token: '', id: 0, label: '', expiresAt: 0, permissions: [] as string[], version: 0 }),
  getters: {
    authenticated: state => !!state.token && state.id > 0 && state.expiresAt > Date.now(),
    canAssist: state => state.permissions.includes('order.assisted'),
  },
  actions: {
    cancelExpiryTimer() {
      const armed = expiryTimers.get(this);
      if (armed) clearTimeout(armed.timer);
      expiryTimers.delete(this);
    },
    armExpiryTimer() {
      this.cancelExpiryTimer();
      if (!this.token || this.id <= 0) return;
      if (!Number.isSafeInteger(this.expiresAt) || this.expiresAt <= Date.now()) { this.clear(); return; }
      const owner = { version: this.version, token: this.token, id: this.id, expiresAt: this.expiresAt };
      const delay = Math.max(1, Math.min(owner.expiresAt - Date.now(), MAX_TIMER_DELAY_MS));
      const timer = setTimeout(() => {
        const armed = expiryTimers.get(this);
        if (armed?.timer !== timer) return;
        expiryTimers.delete(this);
        if (owner.version !== this.version || owner.token !== this.token || owner.id !== this.id
          || owner.expiresAt !== this.expiresAt) { this.ensureFresh(); return; }
        if (this.expiresAt <= Date.now()) this.clear();
        else this.armExpiryTimer();
      }, delay);
      expiryTimers.set(this, { ...owner, timer });
      // A background Node test must not stay alive for a one-hour Admin session.
      const nodeTimer = timer as unknown as { unref?: () => void };
      if (typeof nodeTimer.unref === 'function') nodeTimer.unref();
    },
    ensureFresh(): boolean {
      if (!this.token || this.id <= 0) return false;
      if (!Number.isSafeInteger(this.expiresAt) || this.expiresAt <= Date.now()) { this.clear(); return false; }
      const armed = expiryTimers.get(this);
      if (!armed || armed.version !== this.version || armed.token !== this.token || armed.id !== this.id
        || armed.expiresAt !== this.expiresAt) this.armExpiryTimer();
      return true;
    },
    install(value: AdminSessionValue) {
      this.cancelExpiryTimer(); this.version++; this.$patch(value); this.armExpiryTimer();
    },
    clear() {
      this.cancelExpiryTimer(); this.version++;
      this.$patch({ token: '', id: 0, label: '', expiresAt: 0, permissions: [] });
    },
  },
});
