import { API_BASE, getFormType, RequestError } from "@/utils/request";
import { useAuthStore } from "@/stores/auth";

export interface UploadedCommunityVideo { url: string; src: string; name: string }

export function apiCommunityVideo(filePath: string): Promise<UploadedCommunityVideo> {
  const auth = useAuthStore(), uid = auth.uid, token = auth.token, version = auth.sessionVersion;
  if (!uid || !token) return Promise.reject(Error("请先登录"));
  return new Promise((resolve, reject) => uni.uploadFile({
    url: `${API_BASE}/api/upload/video`, filePath, name: "file", timeout: 90000,
    header: { "Authori-zation": `Bearer ${token}`, "Form-type": getFormType() },
    success(result) {
      if (auth.uid !== uid || auth.token !== token || auth.sessionVersion !== version) {
        reject(Error("登录状态已变化，请重新操作")); return;
      }
      try {
        if (typeof result.data !== "string" || result.data.length > 16384) throw Error("视频上传回执无效");
        const body = JSON.parse(result.data);
        if (result.statusCode < 200 || result.statusCode >= 300 || body?.status !== 200) {
          throw new RequestError(typeof body?.msg === "string" ? body.msg : "视频上传失败", body?.status);
        }
        const value = body.data;
        if (!value || typeof value.url !== "string" || !/^\/api\/assets\/[1-9]\d*$/.test(value.url)
          || typeof value.src !== "string" || !value.src.startsWith(value.url + "?")
          || typeof value.name !== "string") throw Error("视频上传回执无效");
        resolve({ url: value.url, src: value.src, name: value.name });
      } catch (error) { reject(error); }
    },
    fail() { reject(Error("视频上传未确认，请重新选择文件后上传")); },
  }));
}
