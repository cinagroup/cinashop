export interface PublicBranding {
  record_No: string;
  site_name: string;
  site_logo: string;
  site_logo_square: string;
  login_logo: string;
  ico_path: string;
  admin_login_slide: string[];
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

let request: Promise<PublicBranding> | null = null;

function previewBranding(): PublicBranding {
  return {
    record_No: "ICP备案示例",
    site_name: "CinaShop",
    site_logo: "/logo.png",
    site_logo_square: "/logo.png",
    login_logo: "/logo.png",
    ico_path: "/favicon.ico",
    admin_login_slide: [
      "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=1400&h=1200&fit=crop",
      "https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1400&h=1200&fit=crop",
    ],
  };
}

export function apiPublicBranding(): Promise<PublicBranding> {
  if (previewMode) return Promise.resolve(previewBranding());
  if (!request) {
    request = fetch("/api/site_config", { credentials: "omit" })
      .then(async (response) => {
        if (!response.ok) throw new Error("站点品牌配置加载失败");
        const body = await response.json() as { status?: number; msg?: string; data?: PublicBranding };
        if (body.status !== 200 || !body.data) throw new Error(body.msg || "站点品牌配置加载失败");
        return body.data;
      })
      .catch((error) => {
        request = null;
        throw error;
      });
  }
  return request;
}

export function applyFavicon(url: string): void {
  if (!url) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.href = url;
}
