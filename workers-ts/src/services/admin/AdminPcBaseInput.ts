/** PREPARATION ONLY: no route or service imports this candidate. */
import { PC_BASE_MAX_BODY_BYTES } from '../../../../view/common/pcBase';
import type { PcBaseIntentSave } from '../../../../view/common/pcBaseIntent';
import { parsePcBaseIntentRequestText } from './AdminPcBaseIntentPlan';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';

/** The sole modern HTTP input is the complete keep/replace fields intent.
 * Reuse its byte/depth/duplicate-key checks without accepting the old full
 * settings proposal. This adapter performs no SQL/KV or provider calls. */
export function parsePcBaseRequestText(text: string): PcBaseIntentSave {
  try { return parsePcBaseIntentRequestText(text); }
  catch (error) { throw new ValidateException(error instanceof Error ? error.message : 'PC配置输入无效'); }
}
export async function readPcBaseSaveRequest(request: Request): Promise<PcBaseIntentSave> {
  const text = await readBoundedUtf8Text(request, PC_BASE_MAX_BODY_BYTES);
  return parsePcBaseRequestText(text);
}
