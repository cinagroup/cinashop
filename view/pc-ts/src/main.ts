import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import App from "./App.vue";
import router from "./router";
import { bindAuthStores } from "./stores/session";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
const unbindAuthStores = bindAuthStores(pinia);
if (import.meta.hot) import.meta.hot.dispose(unbindAuthStores);
app.use(router);
app.use(ElementPlus);
app.mount("#app");
