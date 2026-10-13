# 旧 geoLbscoder 只读合同（2026-10-13，本地候选，未发布）

本批恢复 `GET /api/geoLbscoder?location=lat,lng` 一个精确旧 URL。来源为原仓库 `route/api.php:60`、`app/controller/api/v1/PublicController.php:445` 以及 `vendor/joypack/tencent-map/src/Bundle/LocationOption.php`、`Bundle/Location.php`、`Request.php`。原路由只要求 StationOpen、不要求登录；原控制器使用 `tengxun_map_key` 调用固定腾讯服务，再把 `result` 放进 PHP JSON 成功信封。原 UniApp `api/user.js:726` 使用纬度在前、经度在后的同一查询串。

`PublicGeocodingController` 保留公开/StationOpen边界和 `{status:200,msg:"ok",data:result}` 成功结构，错误使用旧 `{status:400,msg,data:null}` 信封。位置数据强制 `private, no-store` 与 `no-referrer`。客户端认证头不参与身份，也不向腾讯转发；客户端提供的 key、callback、URL 或其他参数不参与 provider 请求。只允许一个 location 参数，严格验证两段有限十进制坐标及 ±90/±180 边界，拒绝多段、科学计数、注入、非数字和超长输入。

服务从既有配置解析器读取 `tengxun_map_key`。没有有效配置就失败关闭。对外只有一次固定 HTTPS GET：`https://apis.map.qq.com/ws/geocoder/v1/`，参数只有服务器 key、规范化 location 与 `output=json`；不请求 POI、不自动重试，不发送用户、来源 IP、Cookie 或其它请求头。redirect=error，5 秒期限同时覆盖取得响应与流式读取，JSON 流的实际字节和声明长度均最多 32 KiB，拒绝异常 media type、非成功 HTTP、重定向、非法 UTF-8/JSON、provider 非零状态与畸形结果。所有 provider/network 错误统一为受控提示，不回显其原 message/error、URL 或 key。

结果投影保留腾讯文档与旧端结构中的 `address/location/formatted_addresses/address_component/ad_info/address_reference/poi_count/pois`，按原 snake_case 嵌套字段与数值返回，省市区、街道、推荐地址、参考地点、距离和行政代码不改名；未知顶层与嵌套字段被去掉。POI虽不请求，但 provider 若返回其文档字段，可保留最多20个合法条目。此投影是有意收紧：不复制 PHP 对任意 provider 字段的原样透传。

公开 provider 请求新增强一致预算：当前 Cloudflare 来源 HMAC 桶每分钟30次，站点全局每分钟300次。只相信 `CF-Connecting-IP`，缺失来源共用受限桶，不存储原 IP。预算耗尽返回带 Retry-After 的 HTTP429；预算服务或决定无效返回 HTTP503，均不读key或访问provider。固定预算是本地候选限制，不能替代运营确认真实腾讯配额及生产容量。来源预算与全局预算在两个顺序桶中消费，拒绝的全局尝试仍会消耗来源预算。

协议依据：[腾讯位置服务官方逆地址解析文档](https://lbs.qq.com/webservice_v1/guide-gcoder.html)（本轮只读访问）。原 Joypack 库也确认固定 HTTPS 主机及 `/ws/geocoder/v1` 路径；原 `LocationOption` 只设置 location，不开启 get_poi。

验证文件为 `test/public-geocoding.test.ts`。它直接加载实际 v1Routes，以合成配置/站点状态/配额和 fetch 检查原 envelope、路由身份边界、预算阻断、旧字段、安全投影、边界坐标、响应尺寸、网络/响应体超时及原错误脱敏；另覆盖非法 UTF-8、超时后迟到响应取消及畸形 DO 决定。本轮本机副本完整文件实际 **58／58 通过，exit 0**，原始输出及来源核对汇总于[并行迁移报告](php-ts-parallel-migration-20261013.md)。UNC首次启动无输出且按本机验证方案中断、本机普通沙箱 Vite realpath 的 EPERM 均保留；同参数审核提权后成功，不把零执行的失败算成测试通过。

本批没有生产配置查询、数据库写入/DDL、外部腾讯实调、提交、推送、部署或前端修改。现有配置解析器可能回填其普通 KV 配置缓存；没有新增位置结果缓存。腾讯真实key/授权来源/配额、真实位置精度/运营数据、Worker与DO真实运行时、旧/新前端及设备端到端、正式最小权限/容量与发布仍待验收。整体 PHP→TS 迁移与既有开放父项未关闭。
