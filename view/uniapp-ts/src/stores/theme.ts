import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { apiTheme } from '@/api/theme';
import { isThemeStatus, themePreset, themeStyle, themeVariables, type ThemeStatus } from '../../../common/theme';
const CACHE_KEY = 'cinashop_theme_v1';
export const useThemeStore = defineStore('shop-theme', () => {
  const cached = uni.getStorageSync(CACHE_KEY) as unknown;
  const initial = cached && typeof cached === 'object' && !Array.isArray(cached) && (cached as { version?: unknown }).version === 1 && isThemeStatus((cached as { status?: unknown }).status) ? (cached as { status: ThemeStatus }).status : null;
  const status = ref<ThemeStatus | null>(initial), configured = ref(false), stale = ref(true), issues = ref<string[]>([]), error = ref(''), loading = ref(false);
  let generation = 0, active = true, inFlight: Promise<void> | null = null;
  const displayStatus = computed(() => status.value ?? 3), preset = computed(() => themePreset(displayStatus.value)), variables = computed(() => themeVariables(displayStatus.value)), style = computed(() => themeStyle(displayStatus.value));
  function syncPlatform() {
    // Page hosts provide the same variables on MP/APP; document is only an H5 supplement.
    // #ifdef H5
    if (typeof document !== 'undefined') for (const [key, value] of Object.entries(variables.value)) document.documentElement.style.setProperty(key, value);
    // #endif
    uni.setTabBarStyle?.({ selectedColor: preset.value.theme, fail: () => { /* A non-tab page may have no native tabbar. The next host retries. */ } });
  }
  async function refresh(force = false): Promise<void> {
    active = true;
    if (inFlight && !force) return inFlight;
    const current = ++generation; loading.value = true; error.value = '';
    const work = (async () => {
      try {
        const value = await apiTheme(); if (!active || current !== generation) return;
        status.value = isThemeStatus(value.status) ? value.status : null; configured.value = status.value !== null; stale.value = false; issues.value = value.theme_issues;
        if (status.value !== null) uni.setStorageSync(CACHE_KEY, { version: 1, status: status.value }); else uni.removeStorageSync(CACHE_KEY);
        syncPlatform();
      } catch (reason) { if (active && current === generation) { stale.value = true; error.value = reason instanceof Error ? reason.message : '读取主题失败'; } }
      finally { if (current === generation) { loading.value = false; inFlight = null; } }
    })(); inFlight = work; return work;
  }
  function pause() { active = false; generation++; inFlight = null; loading.value = false; }
  return { status, configured, stale, issues, error, loading, displayStatus, preset, variables, style, refresh, pause, syncPlatform };
});
