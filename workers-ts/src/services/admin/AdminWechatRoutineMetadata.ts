import type { systemConfig } from '@/models/schema';
import type { WechatRoutineKey } from '../../../../view/common/wechatRoutine';

/** Missing-row metadata from fixed PHP
 * 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5:public/install/crmeb.sql
 * lines8045,8046,8050,8168,8274. The actual routine/download Vue page uses the
 * same five names and numeric0/1 radios. Avatar policy belongs to tab26, not7.
 * Seed IDs/values are not installed; existing metadata/shadows are not reset. */
export type WechatRoutineInsertMetadata = Required<Pick<typeof systemConfig.$inferInsert,
  'type' | 'inputType' | 'configTabId' | 'parameter' | 'uploadType' | 'required'
  | 'width' | 'high' | 'info' | 'desc' | 'sort' | 'status'>>;

export const WECHAT_ROUTINE_INSERT_METADATA = {
  routine_appId: {
    type: 'text', inputType: 'input', configTabId: 7, parameter: '', uploadType: 0,
    required: '', width: 100, high: 0, info: 'appId', desc: '小程序appID', sort: 0, status: 1,
  },
  routine_appsecret: {
    type: 'text', inputType: 'input', configTabId: 7, parameter: '', uploadType: 0,
    required: '', width: 100, high: 0, info: 'AppSecret', desc: '小程序AppSecret', sort: 0, status: 1,
  },
  routine_name: {
    type: 'text', inputType: 'input', configTabId: 7, parameter: '', uploadType: 0,
    required: '', width: 100, high: 0, info: '小程序名称', desc: '', sort: 0, status: 1,
  },
  routine_contact_type: {
    type: 'radio', inputType: '', configTabId: 7, parameter: '1=>小程序客服\n0=>系统客服', uploadType: 0,
    required: '', width: 0, high: 0, info: '小程序客服类型', desc: '小程序客服类型', sort: 0, status: 1,
  },
  store_user_avatar: {
    type: 'radio', inputType: '', configTabId: 26, parameter: '1=>开启\n0=>关闭', uploadType: 0,
    required: '', width: 0, high: 0, info: '强制获取昵称头像',
    desc: '是否在小程序用户授权之后，弹窗获取用户的昵称和头像', sort: 0, status: 1,
  },
} as const satisfies Readonly<Record<WechatRoutineKey, WechatRoutineInsertMetadata>>;
