import type { systemConfig } from '@/models/schema';
import type { PcBaseKey } from '../../../../view/common/pcBase';

/** Missing-row inserts only. Extracted field-by-field from fixed PHP
 * 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5:public/install/crmeb.sql.
 * Seed IDs and seed values are intentionally never installed. Existing row
 * metadata, including malformed metadata and losing duplicates, is immutable
 * to this author. No generic text/tab74 fallback is permitted. */
type PcBaseMetadata = Required<Pick<typeof systemConfig.$inferInsert,
  'type' | 'inputType' | 'configTabId' | 'parameter' | 'uploadType' | 'required'
  | 'width' | 'high' | 'info' | 'desc' | 'sort' | 'status'>>;
export const PC_BASE_INSERT_METADATA = {
  "pc_logo": {
    "type": "upload",
    "inputType": "",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 1,
    "required": "",
    "width": 0,
    "high": 0,
    "info": "PC端LOGO",
    "desc": "PC端右上角展示LOGO，建议尺寸：140 * 60px",
    "sort": 0,
    "status": 1
  },
  "bast_number": {
    "type": "text",
    "inputType": "number",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 0,
    "required": "required:true,digits:true,min:1",
    "width": 100,
    "high": 0,
    "info": "精品推荐个数",
    "desc": "首页配置精品推荐个数",
    "sort": 0,
    "status": 1
  },
  "first_number": {
    "type": "text",
    "inputType": "number",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 0,
    "required": "required:true,digits:true,min:1",
    "width": 100,
    "high": 0,
    "info": "首发新品个数",
    "desc": "首页配置首发新品个数",
    "sort": 0,
    "status": 1
  },
  "product_phone_buy_url": {
    "type": "radio",
    "inputType": "",
    "configTabId": 74,
    "parameter": "1=>公众号\n2=>小程序",
    "uploadType": 0,
    "required": "",
    "width": 0,
    "high": 0,
    "info": "商品手机购买跳转地址",
    "desc": "商品手机购买跳转地址（小程序|公众号）",
    "sort": 0,
    "status": 1
  },
  "contact_number": {
    "type": "text",
    "inputType": "input",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 0,
    "required": "",
    "width": 100,
    "high": 0,
    "info": "联系电话",
    "desc": "",
    "sort": 0,
    "status": 1
  },
  "company_address": {
    "type": "text",
    "inputType": "input",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 0,
    "required": "",
    "width": 100,
    "high": 0,
    "info": "公司地址",
    "desc": "",
    "sort": 0,
    "status": 1
  },
  "copyright": {
    "type": "text",
    "inputType": "input",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 0,
    "required": "",
    "width": 100,
    "high": 0,
    "info": "版权信息",
    "desc": "",
    "sort": 0,
    "status": 1
  },
  "seo_title": {
    "type": "text",
    "inputType": "input",
    "configTabId": 26,
    "parameter": "",
    "uploadType": 0,
    "required": "required:true",
    "width": 100,
    "high": 0,
    "info": "SEO标题",
    "desc": "",
    "sort": 0,
    "status": 0
  },
  "site_keywords": {
    "type": "text",
    "inputType": "input",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 0,
    "required": "",
    "width": 100,
    "high": 0,
    "info": "关键词",
    "desc": "",
    "sort": 0,
    "status": 1
  },
  "site_description": {
    "type": "textarea",
    "inputType": "",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 0,
    "required": "",
    "width": 100,
    "high": 5,
    "info": "网站描述",
    "desc": "",
    "sort": 0,
    "status": 1
  },
  "links_open": {
    "type": "radio",
    "inputType": "",
    "configTabId": 74,
    "parameter": "1=>开启\r\n0=>关闭",
    "uploadType": 1,
    "required": "",
    "width": 0,
    "high": 0,
    "info": "友情链接开关",
    "desc": "友情链接开关",
    "sort": 0,
    "status": 1
  },
  "links_list": {
    "type": "textarea",
    "inputType": "",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 1,
    "required": "",
    "width": 100,
    "high": 5,
    "info": "友情链接列表",
    "desc": "友情链接列表",
    "sort": 0,
    "status": 1
  },
  "filing_list": {
    "type": "textarea",
    "inputType": "",
    "configTabId": 74,
    "parameter": "",
    "uploadType": 1,
    "required": "",
    "width": 100,
    "high": 5,
    "info": "底部自定义",
    "desc": "PC底部自定义（公安备案、市场监管等）",
    "sort": 0,
    "status": 1
  }
} as const satisfies Record<PcBaseKey, PcBaseMetadata>;
