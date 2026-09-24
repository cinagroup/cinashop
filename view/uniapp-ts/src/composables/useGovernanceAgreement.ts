import { ref } from "vue";
import { onHide, onLoad, onShow, onUnload } from "@dcloudio/uni-app";
import { apiGovernanceAgreement, legalContentType, LEGAL_CONTENT_TITLES, type LegalContentType } from "@/api/governanceAgreements";
import { sanitizeArticleRichText } from "@/utils/articleRichText";

export function useGovernanceAgreement() {
  const type = ref<LegalContentType | null>(null);
  const title = ref("协议详情");
  const content = ref("");
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref("");
  let visible = false;
  let generation = 0;

  async function load(): Promise<void> {
    if (!visible || !type.value || loading.value) return;
    const currentType = type.value;
    const currentGeneration = ++generation;
    loading.value = true;
    loaded.value = false;
    content.value = "";
    error.value = "";
    try {
      const html = await apiGovernanceAgreement(currentType);
      if (visible && generation === currentGeneration && type.value === currentType) {
        content.value = sanitizeArticleRichText(html);
        loaded.value = true;
      }
    } catch (cause) {
      if (visible && generation === currentGeneration && type.value === currentType) {
        error.value = cause instanceof Error ? cause.message : "协议加载失败，请重试";
      }
    } finally {
      if (visible && generation === currentGeneration) loading.value = false;
    }
  }

  function suspend(): void {
    visible = false;
    generation++;
    content.value = "";
    loaded.value = false;
    loading.value = false;
  }

  onLoad((query) => {
    // Every known old deep link supplies type. An absent value cannot prove
    // which legal document the caller meant to show.
    type.value = legalContentType(query?.type);
    if (!type.value) {
      error.value = "协议类型不支持";
      return;
    }
    title.value = LEGAL_CONTENT_TITLES[type.value];
    uni.setNavigationBarTitle({ title: title.value });
  });
  onShow(() => {
    visible = true;
    if (type.value) void load();
  });
  onHide(suspend);
  onUnload(suspend);

  return { title, content, loading, loaded, error, load };
}
