/**
 * 通用键值配置编辑器有泄露或覆盖支付、微信等密钥的风险，因此不提供
 * “读取全部 / 任意键批量写入”接口。配置迁移应使用按业务域定义的专用 API。
 */
export const GENERIC_CONFIG_EDITOR_DISABLED = true as const;
