import { computed, ref, watch } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { apiCommunitySave } from "@/api/community";
import { apiCommunityVideo, type UploadedCommunityVideo } from "@/api/communityVideo";
import { RequestError } from "@/utils/request";

export function useCommunityPublish() {
  const auth = useAuthStore();
  const title = ref(""), content = ref(""), video = ref<UploadedCommunityVideo | null>(null);
  const busy = ref(false), choosing = ref(false), unknown = ref(false), error = ref("");
  const publishedId = ref(0), videoWanted = ref(false);
  let generation = 0, visible = true, disposed = false;
  const locked = computed(() => busy.value || choosing.value || unknown.value || publishedId.value > 0);
  const identity = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const clear = () => { title.value = ""; content.value = ""; video.value = null; videoWanted.value = false; error.value = ""; unknown.value = false; publishedId.value = 0; };
  function reset() { if (busy.value || choosing.value) return false; generation++; clear(); return true; }
  function removeVideo() { if (!locked.value) { video.value = null; videoWanted.value = false; error.value = ""; } }
  function chooseVideo() {
    if (!visible || disposed || locked.value || !auth.isLoggedIn) return;
    const revision = ++generation, owner = identity();
    const current = () => !disposed && visible && revision === generation && owner === identity();
    choosing.value = true; error.value = "";
    uni.chooseVideo({ sourceType: ["album", "camera"], compressed: true,
      async success(result) {
        if (!current()) return;
        choosing.value = false; videoWanted.value = true;
        if (!Number.isFinite(result.size) || result.size <= 0 || result.size > 50 * 1024 * 1024 || !result.tempFilePath) {
          error.value = "请选择不超过50 MiB的MP4视频"; return;
        }
        busy.value = true; video.value = null;
        try { const value = await apiCommunityVideo(result.tempFilePath); if (current()) video.value = value; }
        catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : "视频上传失败"; }
        finally { busy.value = false; }
      },
      fail(result) {
        if (!current()) return;
        choosing.value = false;
        if (!result.errMsg?.includes("cancel")) error.value = "无法读取视频，请重新选择";
      },
    });
  }
  async function publish(topicId?: number): Promise<number | null> {
    if (!visible || disposed || locked.value || !auth.isLoggedIn) return null;
    if (videoWanted.value && !video.value) { error.value = "请完成视频上传，或取消视频后发布文字"; return null; }
    if (!content.value.trim()) { error.value = "内容不能为空"; return null; }
    const revision = ++generation, owner = identity();
    const current = () => !disposed && visible && revision === generation && owner === identity();
    busy.value = true; error.value = "";
    try {
      const result = await apiCommunitySave({ title: title.value.trim() || undefined, content: content.value.trim(),
        content_type: video.value ? 2 : 1, video_url: video.value?.url, topic_id: topicId ? [topicId] : undefined });
      if (!current()) return null;
      if (!Number.isSafeInteger(result?.id) || result.id <= 0) throw Error("发布回执无效");
      publishedId.value = result.id; return result.id;
    } catch (cause) {
      if (current()) {
        // HTTP/server/transport failures may occur after commit. Do not replay a non-idempotent save.
        const rejected = cause instanceof RequestError && cause.status !== undefined
          && cause.status >= 400 && cause.status < 500 && (cause.httpStatus === undefined || cause.httpStatus < 500);
        unknown.value = !rejected;
        error.value = rejected ? cause.message : "发布结果未确认，帖子可能已提交审核。请先查看帖子，勿重复发布。";
      }
      return null;
    } finally { busy.value = false; }
  }
  function leave() {
    visible = false; generation++;
    if (busy.value) { unknown.value = true; error.value = "操作结果未确认，请先查看帖子，勿重复发布。"; }
    choosing.value = false;
  }
  onHide(leave);
  onShow(() => { if (!disposed) visible = true; });
  onUnload(() => { leave(); disposed = true; });
  watch(identity, () => { generation++; clear(); choosing.value = false; }, { flush: "sync" });
  return { title, content, video, busy, choosing, unknown, error, publishedId, videoWanted, locked, reset, removeVideo, chooseVideo, publish };
}
