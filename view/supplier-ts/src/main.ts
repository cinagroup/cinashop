import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import App from "./App.vue";
import router from "./router";
import "./styles.css";
import { loadStatisticsScript } from '../../common/statisticsScript';

createApp(App).use(createPinia()).use(router).use(ElementPlus).mount("#app");
loadStatisticsScript(import.meta.env.VITE_API_BASE_URL ?? '/supplierapi');
