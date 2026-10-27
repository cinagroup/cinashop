import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';

export const MAX_PROFILE_BODY_BYTES = 64 * 1024;
export type ProfileValue = string | number;
export interface ProfileEditInput {
  profile?: 1; revision?: string; version?: string; nickname?: string; avatar?: string;
  extend_info?: Array<{ info: string; value: ProfileValue }>;
}
export function profileObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('个人资料须为对象');
  return value as Record<string, unknown>;
}
export function profileText(value: unknown, max: number, label: string, empty = true): string {
  if (typeof value !== 'string' || [...value].length > max || (!empty && !value.trim())
    || /[\u0000-\u001f\u007f]/u.test(value) || [...value].some(c => { const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff; })) throw new ValidateException(`${label}格式或长度无效`);
  return value;
}
export function profileKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key=>!allowed.includes(key))) throw new ValidateException('个人资料包含不支持的字段');
}
export function parseProfileQuery(query: URLSearchParams): boolean {
  const values=query.getAll('profile');
  if (!values.length) return false;
  if(values.length!==1||values[0]!=='1')throw new ValidateException('个人资料读取标记无效');
  return true;
}
export async function readProfileInput(request: Request): Promise<ProfileEditInput> {
  return parseProfileInput(parseLevelActivationJson(await readBoundedUtf8Text(request,MAX_PROFILE_BODY_BYTES)));
}
export function parseProfileInput(value: unknown): ProfileEditInput {
  const body=profileObject(value),modern=Object.hasOwn(body,'profile');
  profileKeys(body,modern?['profile','revision','version','nickname','avatar','extend_info']:['nickname','avatar']);
  if(modern&&body.profile!==1)throw new ValidateException('个人资料保存标记无效');
  const result:ProfileEditInput={};
  if(modern){
    for(const key of ['revision','version'] as const)if(typeof body[key]!=='string'||!/^[a-f0-9]{64}$/.test(body[key]))throw new ValidateException('个人资料版本无效，请重新读取');
    result.profile=1;result.revision=body.revision as string;result.version=body.version as string;
    if(!Object.hasOwn(body,'nickname')||!Object.hasOwn(body,'avatar'))throw new ValidateException('请完整提交昵称和头像');
    if(!Array.isArray(body.extend_info)||body.extend_info.length>64)throw new ValidateException('扩展资料须为至多64项数组');
    result.extend_info=body.extend_info.map(value=>{
      const field=profileObject(value);profileKeys(field,['info','value']);
      const info=profileText(field.info,80,'资料名称',false),v=field.value;
      if((typeof v!=='string'&&typeof v!=='number')||(typeof v==='number'&&!Number.isFinite(v)))throw new ValidateException('资料值须为文本或有限数字');
      profileText(String(v),4096,'资料值');return{info,value:v as ProfileValue};
    });
    if(new Set(result.extend_info.map(field=>field.info)).size!==result.extend_info.length)throw new ValidateException('扩展资料不能重复');
  }
  if(Object.hasOwn(body,'nickname')){const nickname=profileText(body.nickname,modern?255:16,'昵称',!modern);if(modern)result.nickname=nickname;else if(nickname.trim())result.nickname=nickname.trim();}
  if(Object.hasOwn(body,'avatar'))result.avatar=profileText(body.avatar,4096,'头像');
  if(!modern&&result.avatar==='')delete result.avatar;
  if(!modern&&result.nickname===undefined&&(!result.avatar||!result.avatar.trim()))throw new ValidateException('请输入昵称或者选择头像');
  return result;
}
