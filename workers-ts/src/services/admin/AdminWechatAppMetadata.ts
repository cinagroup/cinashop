import type { systemConfig } from '@/models/schema';
import type { WechatAppKey } from '../../../../view/common/wechatApp';

/** Missing-row insert metadata from fixed PHP
 * 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5:public/install/crmeb.sql:8153–8154.
 * The twelve fields below reproduce rows348/349; IDs and seed values are not
 * installed. Existing metadata and shadow rows remain the author's concern to
 * preserve. Both fields belong to tab73, independently of website Open/PC. */
export type WechatAppInsertMetadata = Required<Pick<typeof systemConfig.$inferInsert,
  'type' | 'inputType' | 'configTabId' | 'parameter' | 'uploadType' | 'required'
  | 'width' | 'high' | 'info' | 'desc' | 'sort' | 'status'>>;

export const WECHAT_APP_INSERT_METADATA = {
  "wechat_app_appid": {
    "type": "text",
    "inputType": "input",
    "configTabId": 73,
    "parameter": "",
    "uploadType": 0,
    "required": "",
    "width": 100,
    "high": 0,
    "info": "移动应用APPID",
    "desc": "公众平台开放移动应用的APPID",
    "sort": 0,
    "status": 1
  },
  "wechat_app_appsecret": {
    "type": "text",
    "inputType": "input",
    "configTabId": 73,
    "parameter": "",
    "uploadType": 0,
    "required": "",
    "width": 100,
    "high": 0,
    "info": "移动应用AppSecret",
    "desc": "公众平台开放移动应用的AppSecret",
    "sort": 0,
    "status": 1
  }
} as const satisfies Readonly<Record<WechatAppKey, WechatAppInsertMetadata>>;
