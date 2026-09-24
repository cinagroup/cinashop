import { createSSRApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import DiySuspendedNavigation from "@/components/diy/DiySuspendedNavigation.vue";
import { bindAuthStores } from '@/stores/session';
import { prepareWorkOAuthRoute } from "@/composables/workContext";

prepareWorkOAuthRoute();

export function createApp() {
  const app = createSSRApp(App);
  const pinia = createPinia();
  app.use(pinia);
  bindAuthStores(pinia);
  app.component("DiySuspendedNavigation", DiySuspendedNavigation);
  return {
    app,
  };
}
