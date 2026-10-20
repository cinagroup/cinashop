import { computed, ref, watch } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { apiCommunitySave } from "@/api/community";
import { apiCommunityVideo, type UploadedCommunityVideo } from "@/api/communityVideo";
import { apiCommunityImage, type UploadedCommunityImage } from "@/api/communityImage";
import { RequestError } from "@/utils/request";
import { useCommunityRelations } from "./useCommunityRelations";

export function useCommunityPublish() {
  const auth = useAuthStore();
  const title = ref(""), content = ref(""), video = ref<UploadedCommunityVideo | null>(null);
  const images = ref<UploadedCommunityImage[]>([]), cover = ref<UploadedCommunityImage | null>(null);
  const imageFailed = ref(false);
  const busy = ref(false), choosing = ref(false), unknown = ref(false), error = ref("");
  const publishedId = ref(0), videoWanted = ref(false);
  let generation = 0, visible = true, disposed = false;
  const locked = computed(() => busy.value || choosing.value || unknown.value || publishedId.value > 0);
  const relations = useCommunityRelations(locked);
  const identity = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const clear = () => { title.value = ""; content.value = ""; video.value = null; videoWanted.value = false; images.value = []; cover.value = null; imageFailed.value = false; error.value = ""; unknown.value = false; publishedId.value = 0; };
  function reset() { if (busy.value || choosing.value) return false; generation++; clear(); relations.clear(); return true; }
  function removeVideo() { if (!locked.value) { video.value = null; videoWanted.value = false; cover.value = null; imageFailed.value = false; error.value = ""; } }
  function removeImage(index: number) { if (!locked.value && Number.isInteger(index)) images.value.splice(index, 1); }
  function clearImages() { if (!locked.value) { images.value = []; imageFailed.value = false; error.value = ""; } }
  function removeCover() { if (!locked.value) { cover.value = null; imageFailed.value = false; error.value = ""; } }
  function selectImages(forCover: boolean) {
    if (!visible || disposed || locked.value || !auth.isLoggedIn
      || (forCover ? !video.value : videoWanted.value || images.value.length >= 9)) return;
    const count = forCover ? 1 : 9 - images.value.length, revision = ++generation, owner = identity();
    const current = () => !disposed && visible && revision === generation && owner === identity();
    choosing.value = true; error.value = "";
    uni.chooseImage({ count, sourceType: ["album", "camera"], sizeType: ["compressed"],
      async success(result) {
        if (!current()) return;
        choosing.value = false;
        const files = result.tempFiles, paths = result.tempFilePaths;
        if (!Array.isArray(files) || !Array.isArray(paths) || !files.length || files.length > count
          || files.length !== paths.length || files.some((file, i) => !Number.isFinite(file.size)
            || file.size <= 0 || file.size > 10 * 1024 * 1024 || !paths[i])) {
          imageFailed.value = true; error.value = "请选择每张不超过10 MiB的图片"; return;
        }
        busy.value = true;
        try {
          const uploaded: UploadedCommunityImage[] = [];
          for (const path of paths) {
            if (!current()) return;
            const item = await apiCommunityImage(path);
            if (!current()) return;
            uploaded.push(item);
          }
          if (forCover) cover.value = uploaded[0];
          else images.value.push(...uploaded);
          imageFailed.value = false;
        } catch (cause) {
          if (current()) { imageFailed.value = true; error.value = cause instanceof Error ? cause.message : "图片上传失败"; }
        } finally { busy.value = false; }
      },
      fail(result) {
        if (!current()) return;
        choosing.value = false;
        if (!result.errMsg?.includes("cancel")) error.value = "无法读取图片，请重新选择";
      },
    });
  }
  function chooseVideo() {
    if (!visible || disposed || locked.value || !auth.isLoggedIn || images.value.length || imageFailed.value) return;
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
    if (relations.loading.value || relations.pendingTopic.value) { error.value = "请先完成话题和商品选择"; return null; }
    if (imageFailed.value) { error.value = "请重新上传图片，或明确移除图片后发布"; return null; }
    if (videoWanted.value && !video.value) { error.value = "请完成视频上传，或取消视频后发布文字"; return null; }
    if (!content.value.trim()) { error.value = "内容不能为空"; return null; }
    const revision = ++generation, owner = identity();
    const current = () => !disposed && visible && revision === generation && owner === identity();
    busy.value = true; error.value = "";
    try {
      const result = await apiCommunitySave({ title: title.value.trim() || undefined, content: content.value.trim(),
        content_type: video.value ? 2 : 1, video_url: video.value?.url,
        ...(images.value.length ? { image: images.value[0].url, slider_image: images.value.map(item => item.url) } : {}),
        ...(video.value && cover.value ? { image: cover.value.url } : {}),
        topic_id: relations.selectedTopics.value.length ? relations.selectedTopics.value.map(item => item.id) : topicId ? [topicId] : undefined,
        ...(relations.selectedProducts.value.length ? { product_id: relations.selectedProducts.value.map(item => item.product_id) } : {}) });
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
  return { title, content, video, images, cover, imageFailed, busy, choosing, unknown, error, publishedId, videoWanted, relations,
    locked, reset, removeVideo, chooseVideo, chooseImages: () => selectImages(false), chooseCover: () => selectImages(true),
    removeImage, clearImages, removeCover, publish };
}
