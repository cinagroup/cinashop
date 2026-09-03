<template>
  <div class="commerce-settings" v-loading="loading">
    <div class="page-heading">
      <div>
        <h2>商城运行设置</h2>
        <p>仅开放新版 Worker 已确认的数据字段；支付密钥继续由 Cloudflare Secret 管理。</p>
      </div>
      <div class="heading-actions">
        <el-button :disabled="loading || saving" @click="load">重新加载</el-button>
        <el-button type="primary" :loading="saving" :disabled="!canSave" @click="save">
          保存全部设置
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="!canSave"
      type="warning"
      :closable="false"
      show-icon
      title="当前账号只有查看权限，需要 config.manage 才能保存。"
    />
    <el-alert
      v-if="form.missing_config_keys.length"
      type="warning"
      :closable="false"
      show-icon
      :title="`${form.missing_config_keys.length} 个旧配置键在数据库中缺失`"
      description="页面正在显示安全默认值；保存后会在同一事务内补齐缺失键。"
    />

    <el-tabs v-model="activeTab" class="settings-tabs">
      <el-tab-pane label="基础设置" name="basic">
        <el-card shadow="never" class="section-card">
          <template #header><strong>站点与客户端</strong></template>
          <el-form label-position="top">
            <div class="form-grid three">
              <el-form-item label="站点状态">
                <el-switch v-model="form.basic.station_open" :active-value="1" :inactive-value="0" active-text="开放" inactive-text="关闭" />
              </el-form-item>
              <el-form-item label="网站名称">
                <el-input v-model="form.basic.site_name" maxlength="100" />
              </el-form-item>
              <el-form-item label="联系电话">
                <el-input v-model="form.basic.site_phone" maxlength="32" />
              </el-form-item>
              <el-form-item label="HTTPS 网站地址">
                <el-input v-model="form.basic.site_url" maxlength="2048" placeholder="https://shop.example.com" />
              </el-form-item>
              <el-form-item label="备案号">
                <el-input v-model="form.basic.record_No" maxlength="100" />
              </el-form-item>
              <el-form-item label="商品分享海报标题">
                <el-input v-model="form.basic.product_poster_title" maxlength="25" show-word-limit />
              </el-form-item>
            </div>
            <div class="switch-grid">
              <label><span>悬浮菜单</span><el-switch v-model="form.basic.navigation_open" :active-value="1" :inactive-value="0" /></label>
              <label><span>短视频功能</span><el-switch v-model="form.basic.video_func_status" :active-value="1" :inactive-value="0" /></label>
              <label><span>商品列表视频</span><el-switch v-model="form.basic.product_video_status" :active-value="1" :inactive-value="0" /></label>
            </div>
          </el-form>
        </el-card>

        <el-card shadow="never" class="section-card">
          <template #header><strong>品牌图片</strong></template>
          <el-alert
            type="info"
            :closable="false"
            title="支持 HTTPS 地址或 / 开头的站内素材路径；本页不会读取文件系统或回显任何第三方凭据。"
            class="inline-alert"
          />
          <el-form label-position="top">
            <div class="form-grid two">
              <el-form-item v-for="item in assetFields" :key="item.key" :label="item.label">
                <div class="asset-control">
                  <el-input v-model="form.basic[item.key]" maxlength="2048" :placeholder="item.placeholder" />
                  <el-button @click="openAssetPicker(item.key)">从素材中心选择</el-button>
                </div>
                <el-image
                  v-if="form.basic[item.key]"
                  :src="assetPreview(form.basic[item.key])"
                  fit="contain"
                  class="asset-preview"
                />
              </el-form-item>
            </div>
          </el-form>
        </el-card>

        <el-card shadow="never" class="section-card">
          <template #header><strong>登录轮播图与浏览器图标</strong></template>
          <el-alert
            type="info"
            :closable="false"
            title="素材中心使用私有 R2：配置保存稳定素材引用，登录页读取时由 Worker 重新签名；轮播图最多 5 张。favicon 可使用 PNG、JPEG 或 WebP。"
            class="inline-alert"
          />
          <div class="slide-toolbar">
            <strong>后台登录轮播图（{{ form.basic.admin_login_slide.length }}/5）</strong>
            <el-button :disabled="form.basic.admin_login_slide.length >= 5" @click="openAssetPicker('admin_login_slide')">
              添加素材
            </el-button>
          </div>
          <div v-if="form.basic.admin_login_slide.length" class="slide-grid">
            <article v-for="(slide, index) in form.basic.admin_login_slide" :key="`${slide}-${index}`" class="slide-card">
              <el-image :src="assetPreview(slide)" fit="cover" />
              <div>
                <el-button link :disabled="index === 0" @click="moveSlide(index, -1)">前移</el-button>
                <el-button link :disabled="index === form.basic.admin_login_slide.length - 1" @click="moveSlide(index, 1)">后移</el-button>
                <el-button link type="danger" @click="removeSlide(index)">移除</el-button>
              </div>
            </article>
          </div>
          <el-empty v-else :image-size="68" description="未配置时登录页使用安全的渐变背景" />
          <el-form label-position="top" class="favicon-form">
            <el-form-item label="浏览器 favicon">
              <div class="asset-control">
                <el-input v-model="form.basic.ico_path" maxlength="2048" placeholder="/api/assets/123" />
                <el-button @click="openAssetPicker('ico_path')">从素材中心选择</el-button>
              </div>
              <el-image v-if="form.basic.ico_path" :src="assetPreview(form.basic.ico_path)" fit="contain" class="favicon-preview" />
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never" class="section-card">
          <template #header><strong>微信默认分享</strong></template>
          <el-alert
            type="info"
            :closable="false"
            title="首页小程序分享与 H5/PC 页面元信息通过 /api/share 消费这里的默认值；商品详情仍可使用自己的商品标题和图片覆盖。"
            class="inline-alert"
          />
          <el-form label-position="top">
            <div class="form-grid two">
              <el-form-item label="分享标题">
                <el-input v-model="form.basic.wechat_share_title" maxlength="100" show-word-limit />
              </el-form-item>
              <el-form-item label="分享图片">
                <div class="asset-control">
                  <el-input v-model="form.basic.wechat_share_img" maxlength="2048" placeholder="/api/assets/123" />
                  <el-button @click="openAssetPicker('wechat_share_img')">从素材中心选择</el-button>
                </div>
                <el-image v-if="form.basic.wechat_share_img" :src="assetPreview(form.basic.wechat_share_img)" fit="contain" class="asset-preview" />
              </el-form-item>
            </div>
            <el-form-item label="分享简介">
              <el-input v-model="form.basic.wechat_share_synopsis" type="textarea" :rows="3" maxlength="200" show-word-limit />
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never" class="section-card">
          <template #header><strong>Worker 固定安全策略</strong></template>
          <el-alert
            type="success"
            :closable="false"
            title="旧 PHP 的密码长度、登录锁定与参数过滤开关不再提供任意编辑；下列策略由 Worker 代码、Durable Object 与 Cloudflare Secret 强制执行。"
            class="inline-alert"
          />
          <el-descriptions :column="2" border class="security-policy">
            <el-descriptions-item label="来源登录限流">{{ form.security_policy.admin_login_source_limit }}</el-descriptions-item>
            <el-descriptions-item label="账号登录限流">{{ form.security_policy.admin_login_account_limit }}</el-descriptions-item>
            <el-descriptions-item label="新管理员密码">{{ form.security_policy.new_admin_password }}</el-descriptions-item>
            <el-descriptions-item label="本页请求体上限">{{ form.security_policy.commerce_request_body_limit }}</el-descriptions-item>
            <el-descriptions-item label="参数策略" :span="2">{{ form.security_policy.request_validation }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="商品与交易" name="trade">
        <el-card shadow="never" class="section-card">
          <template #header><strong>库存警戒</strong></template>
          <div class="single-control">
            <div>
              <div class="control-label">警戒库存</div>
              <small>保存阈值后会同步重算商品与普通 SKU 的库存警戒状态。</small>
            </div>
            <el-input-number v-model="form.product.store_stock" :min="0" :max="2147483647" controls-position="right" />
          </div>
        </el-card>

        <el-card shadow="never" class="section-card">
          <template #header><strong>未支付订单取消时间（小时）</strong></template>
          <el-alert
            type="info"
            :closable="false"
            title="单项活动时间设为 0 时，沿用活动商品默认时间。"
            class="inline-alert"
          />
          <el-form label-position="top">
            <div class="form-grid three">
              <el-form-item v-for="item in cancelTimeFields" :key="item.key" :label="item.label">
                <el-input-number v-model="form.trade[item.key]" :min="0" :max="8760" controls-position="right" />
              </el-form-item>
            </div>
          </el-form>
        </el-card>

        <el-card shadow="never" class="section-card">
          <template #header><strong>自动处理与售后期限</strong></template>
          <el-form label-position="top">
            <div class="form-grid three">
              <el-form-item label="自动收货（天，0 为关闭）">
                <el-input-number v-model="form.trade.system_delivery_time" :min="0" :max="3650" controls-position="right" />
              </el-form-item>
              <el-form-item label="自动默认好评（天，0 为关闭）">
                <el-input-number v-model="form.trade.system_comment_time" :min="0" :max="3650" controls-position="right" />
              </el-form-item>
              <el-form-item label="收货后可申请售后（天，0 为不限）">
                <el-input-number v-model="form.trade.refund_time_available" :min="0" :max="3650" controls-position="right" />
              </el-form-item>
            </div>
          </el-form>
        </el-card>

        <el-card shadow="never" class="section-card">
          <template #header><strong>退货信息</strong></template>
          <el-alert
            type="warning"
            :closable="false"
            title="收货人、电话和地址会继续保存为兼容字段；新版订单详情尚未展示这三项，退货理由与售后期限已生效。"
            class="inline-alert"
          />
          <el-form label-position="top">
            <div class="form-grid three">
              <el-form-item label="退货收货人">
                <el-input v-model="form.trade.refund_name" maxlength="100" />
              </el-form-item>
              <el-form-item label="退货联系电话">
                <el-input v-model="form.trade.refund_phone" maxlength="32" />
              </el-form-item>
              <el-form-item label="退货地址">
                <el-input v-model="form.trade.refund_address" maxlength="500" />
              </el-form-item>
            </div>
            <el-form-item label="退货理由（每行一条，最多 100 条）">
              <el-input v-model="form.trade.stor_reason" type="textarea" :rows="8" maxlength="5000" show-word-limit />
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="支付设置" name="payment">
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="商户号和商户API证书序列号可在本页受控保存；私钥、证书内容与 API Key 必须通过 Cloudflare Secret 注入，页面不会读取或保存这些值。"
          class="section-card"
        />
        <div class="readiness-grid">
          <el-card v-for="item in paymentCards" :key="item.key" shadow="never" class="readiness-card">
            <div class="readiness-heading">
              <strong>{{ item.label }}</strong>
              <el-tag :type="item.state.enabled ? 'success' : 'warning'">
                {{ item.state.enabled ? "可用" : "不可用" }}
              </el-tag>
            </div>
            <p>{{ item.state.enabled ? "数据库开关与运行时依赖均已满足。" : item.state.reason }}</p>
          </el-card>
        </div>
        <el-card shadow="never" class="section-card">
          <template #header><strong>业务开关</strong></template>
          <div class="switch-grid payment-switches">
            <label><span>余额功能总开关</span><el-switch v-model="form.payment.balance_func_status" :active-value="1" :inactive-value="0" /></label>
            <label><span>余额支付</span><el-switch v-model="form.payment.yue_pay_status" :active-value="1" :inactive-value="2" /></label>
            <label><span>微信支付</span><el-switch v-model="form.payment.pay_weixin_open" :active-value="1" :inactive-value="0" /></label>
            <label><span>支付宝支付</span><el-switch v-model="form.payment.ali_pay_status" :active-value="1" :inactive-value="0" /></label>
            <label><span>线下支付</span><el-switch v-model="form.payment.offline_pay_status" :active-value="1" :inactive-value="2" /></label>
          </div>
        </el-card>
        <el-card shadow="never" class="section-card">
          <template #header><strong>微信 APIv3 公共商户配置（非密钥）</strong></template>
          <el-alert
            type="info"
            :closable="false"
            show-icon
            title="公众号/H5/PC、小程序和 App 共享这一套商户号与部署凭据，各自使用已配置并绑定到该商户的 AppID。旧版独立小程序商户号开关不再参与下单。"
            description="商户私钥、APIv3 Key、微信支付平台公钥及其内容仍只允许在部署期注入；保存与审计日志只记录配置键数量，不记录字段值。"
            class="inline-alert"
          />
          <el-form label-position="top">
            <div class="form-grid two">
              <el-form-item label="微信支付商户号">
                <el-input
                  v-model="form.payment.pay_weixin_mchid"
                  maxlength="32"
                  placeholder="1～32 位数字"
                  inputmode="numeric"
                />
              </el-form-item>
              <el-form-item label="商户API证书序列号">
                <el-input
                  v-model="form.payment.pay_weixin_serial_no"
                  maxlength="64"
                  placeholder="1～64 位十六进制字符"
                  @input="normalizeWechatSerial"
                />
              </el-form-item>
            </div>
          </el-form>
          <div class="readiness-grid profile-readiness-grid">
            <el-card v-for="item in wechatProfileCards" :key="item.key" shadow="never" class="readiness-card">
              <div class="readiness-heading">
                <strong>{{ item.label }}</strong>
                <el-tag :type="item.state.enabled ? 'success' : 'warning'">
                  {{ item.state.enabled ? "可用" : "不可用" }}
                </el-tag>
              </div>
              <p>{{ item.state.enabled ? "AppID、公共商户配置与部署凭据均已满足。" : item.state.reason }}</p>
            </el-card>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="事业部" name="division">
        <el-card shadow="never" class="section-card">
          <template #header><strong>团队入口</strong></template>
          <div class="switch-grid division-switches">
            <label><span>事业部团队功能</span><el-switch v-model="form.division.division_open" :active-value="1" :inactive-value="0" @change="onDivisionOpenChange" /></label>
            <label>
              <span>代理商自助申请</span>
              <el-switch
                v-model="form.division.division_apply_open"
                :active-value="1"
                :inactive-value="0"
                :disabled="form.division.division_open !== 1"
              />
            </label>
          </div>
          <el-alert
            type="info"
            :closable="false"
            title="成员、代理商、分佣比例与申请审核继续在“事业部管理”中维护。"
            class="division-note"
          />
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="assetDialog" title="选择私有 R2 素材" width="min(920px, calc(100vw - 24px))">
      <div class="picker-toolbar">
        <el-input v-model="assetQuery.name" clearable placeholder="搜索文件名" @keyup.enter="loadAssets" />
        <el-button @click="loadAssets">查询</el-button>
        <el-upload
          :show-file-list="false"
          accept="image/jpeg,image/png,image/webp,image/gif"
          :http-request="uploadAsset"
        >
          <el-button type="primary" :loading="assetUploading">上传并选择</el-button>
        </el-upload>
      </div>
      <p class="picker-note">仅接受经服务端魔数校验的 JPEG、PNG、WebP、GIF，单张最大 10 MiB；配置中不会保存短期签名参数。</p>
      <div v-loading="assetLoading" class="picker-grid">
        <button v-for="item in assetItems" :key="item.att_id" type="button" class="picker-card" @click="chooseAsset(item)">
          <el-image :src="item.satt_dir || item.att_dir" fit="cover" />
          <span :title="item.real_name">{{ item.real_name }}</span>
          <small>{{ item.att_size }}</small>
        </button>
        <el-empty v-if="!assetLoading && !assetItems.length" description="暂无可选素材" />
      </div>
      <el-pagination
        v-if="assetCount > assetQuery.limit"
        v-model:current-page="assetQuery.page"
        :page-size="assetQuery.limit"
        :total="assetCount"
        layout="prev, pager, next"
        @current-change="loadAssets"
      />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  apiCommerceSettings,
  apiSaveCommerceSettings,
  type BasicCommerceSettings,
  type CommerceSettings,
  type PaymentMethod,
  type TradeCommerceSettings,
  type WechatPaymentProfile,
} from "@/api/commerceSettings";
import { useAuthStore } from "@/stores/auth";
import type { UploadRequestOptions } from "element-plus";
import {
  apiAttachmentList,
  apiAttachmentUpload,
  type AttachmentItem,
} from "@/api/attachment";

type AssetKey =
  | "site_logo"
  | "site_logo_square"
  | "login_logo"
  | "wap_login_logo"
  | "ico_path"
  | "wechat_share_img";
type AssetTarget = AssetKey | "admin_login_slide";
type CancelTimeKey =
  | "order_cancel_time"
  | "order_activity_time"
  | "order_bargain_time"
  | "order_seckill_time"
  | "order_pink_time"
  | "rebate_points_orders_time"
  | "reminder_deadline_second_card_time";

const authStore = useAuthStore();
const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const canSave = computed(() => previewMode || authStore.userInfo?.level === 0 || authStore.uniqueAuth.includes("config.manage"));
const loading = ref(false);
const saving = ref(false);
const activeTab = ref("basic");
const assetDialog = ref(false);
const assetTarget = ref<AssetTarget>("site_logo");
const assetItems = ref<AttachmentItem[]>([]);
const assetCount = ref(0);
const assetLoading = ref(false);
const assetUploading = ref(false);
const assetQuery = ref({ page: 1, limit: 12, pid: 0, name: "" });

const emptySettings = (): CommerceSettings => ({
  basic: {
    station_open: 1,
    site_name: "",
    site_url: "",
    site_phone: "",
    site_logo: "",
    site_logo_square: "",
    login_logo: "",
    wap_login_logo: "",
    admin_login_slide: [],
    ico_path: "",
    wechat_share_img: "",
    wechat_share_title: "",
    wechat_share_synopsis: "",
    navigation_open: 1,
    video_func_status: 1,
    product_video_status: 1,
    product_poster_title: "",
    record_No: "",
  },
  product: { store_stock: 20 },
  trade: {
    order_cancel_time: 1,
    order_activity_time: 1,
    order_bargain_time: 1,
    order_seckill_time: 1,
    order_pink_time: 1,
    rebate_points_orders_time: 1,
    reminder_deadline_second_card_time: 1,
    system_delivery_time: 1,
    system_comment_time: 0,
    refund_name: "",
    refund_phone: "",
    refund_address: "",
    stor_reason: "",
    refund_time_available: 0,
  },
  payment: {
    balance_func_status: 1,
    yue_pay_status: 1,
    offline_pay_status: 1,
    pay_weixin_open: 1,
    pay_weixin_mchid: "",
    pay_weixin_serial_no: "",
    ali_pay_status: 1,
  },
  division: { division_open: 1, division_apply_open: 1 },
  payment_readiness: {
    yue: { enabled: false, reason: "尚未读取" },
    weixin: { enabled: false, reason: "尚未读取" },
    alipay: { enabled: false, reason: "尚未读取" },
    offline: { enabled: false, reason: "尚未读取" },
  },
  wechat_profile_readiness: {
    wechat: { enabled: false, reason: "尚未读取" },
    routine: { enabled: false, reason: "尚未读取" },
    app: { enabled: false, reason: "尚未读取" },
  },
  missing_config_keys: [],
  asset_previews: {},
  security_policy: {
    admin_login_source_limit: "10次/60秒",
    admin_login_account_limit: "30次/15分钟",
    new_admin_password: "至少12位；bcrypt cost 12",
    commerce_request_body_limit: "32 KiB",
    request_validation: "固定字段白名单、长度/类型校验、参数化数据库操作",
    legacy_editable_filters: false,
  },
});

const form = ref<CommerceSettings>(emptySettings());

const assetFields: Array<{ key: AssetKey; label: string; placeholder: string }> = [
  { key: "site_logo", label: "后台大 LOGO", placeholder: "/uploads/system/logo-wide.png" },
  { key: "site_logo_square", label: "后台小 LOGO", placeholder: "/uploads/system/logo-square.png" },
  { key: "login_logo", label: "后台登录页 LOGO", placeholder: "/uploads/system/login-logo.png" },
  { key: "wap_login_logo", label: "移动端登录 LOGO", placeholder: "/uploads/system/mobile-logo.png" },
];

function assetPreview(reference: string): string {
  return form.value.asset_previews[reference] || reference;
}

async function loadAssets() {
  assetLoading.value = true;
  try {
    const result = await apiAttachmentList(assetQuery.value);
    assetItems.value = result.list;
    assetCount.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "素材加载失败");
  } finally {
    assetLoading.value = false;
  }
}

function openAssetPicker(target: AssetTarget) {
  assetTarget.value = target;
  assetQuery.value.page = 1;
  assetDialog.value = true;
  void loadAssets();
}

function chooseAsset(item: AttachmentItem) {
  const reference = item.canonical_url || item.att_dir;
  form.value.asset_previews[reference] = item.att_dir;
  if (assetTarget.value === "admin_login_slide") {
    if (form.value.basic.admin_login_slide.includes(reference)) {
      ElMessage.warning("该轮播图已添加");
      return;
    }
    if (form.value.basic.admin_login_slide.length >= 5) {
      ElMessage.warning("登录轮播图最多 5 张");
      return;
    }
    form.value.basic.admin_login_slide.push(reference);
    ElMessage.success("已添加，可继续选择");
    return;
  }
  form.value.basic[assetTarget.value] = reference;
  assetDialog.value = false;
}

async function uploadAsset(options: UploadRequestOptions) {
  assetUploading.value = true;
  try {
    await apiAttachmentUpload(options.file, 0);
    await loadAssets();
    ElMessage.success("上传成功，请从列表中选择");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "上传失败");
  } finally {
    assetUploading.value = false;
  }
}

function moveSlide(index: number, offset: -1 | 1) {
  const target = index + offset;
  if (target < 0 || target >= form.value.basic.admin_login_slide.length) return;
  const [slide] = form.value.basic.admin_login_slide.splice(index, 1);
  form.value.basic.admin_login_slide.splice(target, 0, slide);
}

function removeSlide(index: number) {
  form.value.basic.admin_login_slide.splice(index, 1);
}

const cancelTimeFields: Array<{ key: CancelTimeKey; label: string }> = [
  { key: "order_cancel_time", label: "普通商品" },
  { key: "order_activity_time", label: "活动商品默认" },
  { key: "order_bargain_time", label: "砍价商品" },
  { key: "order_seckill_time", label: "秒杀商品" },
  { key: "order_pink_time", label: "拼团商品" },
  { key: "rebate_points_orders_time", label: "积分商品" },
  { key: "reminder_deadline_second_card_time", label: "次卡临期提醒" },
];

const paymentLabels: Record<PaymentMethod, string> = {
  yue: "余额支付",
  weixin: "微信支付",
  alipay: "支付宝支付",
  offline: "线下支付",
};

const paymentCards = computed(() => (
  (Object.keys(paymentLabels) as PaymentMethod[]).map((key) => ({
    key,
    label: paymentLabels[key],
    state: form.value.payment_readiness[key],
  }))
));

const wechatProfileLabels: Record<WechatPaymentProfile, string> = {
  wechat: "公众号 / H5 / PC",
  routine: "小程序",
  app: "App",
};

const wechatProfileCards = computed(() => (
  (Object.keys(wechatProfileLabels) as WechatPaymentProfile[]).map((key) => ({
    key,
    label: wechatProfileLabels[key],
    state: form.value.wechat_profile_readiness[key],
  }))
));

function normalizeWechatSerial(value: string) {
  form.value.payment.pay_weixin_serial_no = value.replace(/\s+/g, "").toUpperCase();
}

function replace(value: CommerceSettings) {
  form.value = value;
  if (form.value.division.division_open !== 1) form.value.division.division_apply_open = 0;
}

function onDivisionOpenChange(value: string | number | boolean) {
  if (Number(value) !== 1) form.value.division.division_apply_open = 0;
}

async function load() {
  loading.value = true;
  try {
    replace(await apiCommerceSettings());
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "商城运行设置加载失败");
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    replace(await apiSaveCommerceSettings({
      basic: { ...form.value.basic } as BasicCommerceSettings,
      product: { ...form.value.product },
      trade: { ...form.value.trade } as TradeCommerceSettings,
      payment: { ...form.value.payment },
      division: { ...form.value.division },
    }));
    ElMessage.success("商城运行设置已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.commerce-settings { display: grid; gap: 16px; min-width: 0; max-width: 1280px; margin: 0 auto; }
.page-heading, .heading-actions, .single-control, .readiness-heading { display: flex; align-items: center; }
.page-heading, .single-control, .readiness-heading { justify-content: space-between; }
.page-heading { gap: 18px; }
.page-heading h2 { margin: 0 0 6px; font-size: 22px; }
.page-heading p, .readiness-card p { margin: 0; color: var(--el-text-color-secondary); }
.heading-actions { gap: 10px; flex: 0 0 auto; }
.settings-tabs { min-width: 0; }
.section-card { margin-bottom: 16px; min-width: 0; }
.inline-alert { margin-bottom: 16px; }
.form-grid { display: grid; gap: 0 20px; }
.form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.switch-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.switch-grid label { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 9px; background: var(--el-fill-color-lighter); }
.single-control { gap: 20px; }
.control-label { margin-bottom: 6px; font-weight: 600; }
small { color: var(--el-text-color-secondary); }
.readiness-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
.readiness-heading { gap: 12px; }
.readiness-card p { min-height: 44px; margin-top: 12px; font-size: 13px; line-height: 1.55; }
.payment-switches { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.division-switches { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.division-note { margin-top: 16px; }
.asset-control, .slide-toolbar, .picker-toolbar { display: flex; align-items: center; gap: 10px; width: 100%; }
.asset-preview { width: 100%; height: 92px; margin-top: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; background: var(--el-fill-color-light); }
.favicon-form { margin-top: 18px; }
.favicon-preview { width: 48px; height: 48px; margin: 10px 0 0 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
.slide-toolbar { justify-content: space-between; }
.slide-grid, .picker-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.slide-card, .picker-card { overflow: hidden; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; background: #fff; }
.slide-card :deep(.el-image), .picker-card :deep(.el-image) { width: 100%; height: 124px; }
.slide-card > div { display: flex; justify-content: center; padding: 4px; }
.picker-toolbar .el-input { max-width: 300px; }
.picker-note { margin: 10px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.picker-grid { min-height: 180px; margin-bottom: 16px; }
.picker-card { display: grid; gap: 4px; padding: 0 0 10px; color: inherit; text-align: left; cursor: pointer; }
.picker-card:hover { border-color: var(--el-color-primary); }
.picker-card span, .picker-card small { overflow: hidden; padding: 0 10px; text-overflow: ellipsis; white-space: nowrap; }
.security-policy { max-width: 980px; }
@media (max-width: 960px) {
  .form-grid.three, .switch-grid, .payment-switches { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .readiness-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .slide-grid, .picker-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .page-heading { align-items: stretch; flex-direction: column; }
  .heading-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .form-grid.three, .form-grid.two, .switch-grid, .payment-switches, .division-switches, .readiness-grid { grid-template-columns: 1fr; }
  .single-control { align-items: flex-start; flex-direction: column; }
  .single-control :deep(.el-input-number) { width: 100%; }
  .asset-control, .picker-toolbar { align-items: stretch; flex-direction: column; }
  .asset-control .el-button, .picker-toolbar > * { width: 100%; max-width: none; }
  .slide-grid { grid-template-columns: 1fr; }
  .security-policy :deep(.el-descriptions__body) { overflow-x: auto; }
}
</style>
