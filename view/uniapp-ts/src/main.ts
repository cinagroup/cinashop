import { createSSRApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import DiySuspendedNavigation from "@/components/diy/DiySuspendedNavigation.vue";

export function createApp() {
  const app = createSSRApp(App);
  app.use(createPinia());
  app.component("DiySuspendedNavigation", DiySuspendedNavigation);
  return {
    app,
  };
}
