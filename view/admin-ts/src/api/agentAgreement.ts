import request, { getData } from '@/utils/request';

export interface AgentAgreement {
  id: number;
  type: 2;
  title: string;
  content: string;
  sort: number;
  status: 0 | 1;
  add_time: number;
  revision: string;
}

export function parseAgentAgreement(value: unknown): AgentAgreement {
  if (Array.isArray(value) && value.length === 0) {
    return { id: 0, type: 2, title: '分销说明', content: '', sort: 0,
      status: 1, add_time: 0, revision: 'absent' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('分销说明响应无效');
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.id) || (row.id as number) <= 0 || row.type !== 2 ||
    typeof row.title !== 'string' || typeof row.content !== 'string' || row.content.length > 200_000 ||
    !Number.isSafeInteger(row.sort) || ![0, 1].includes(row.status as number) ||
    !Number.isSafeInteger(row.add_time) || typeof row.revision !== 'string' ||
    !/^[0-9]{1,20}$/.test(row.revision)) throw new Error('分销说明响应无效');
  return row as unknown as AgentAgreement;
}

export async function apiAgentAgreement(signal?: AbortSignal): Promise<AgentAgreement> {
  return parseAgentAgreement(await getData<unknown>(request.get('/agent/get_agent_agreement', { signal })));
}

export async function apiSaveAgentAgreement(
  row: Pick<AgentAgreement, 'id' | 'content' | 'status' | 'revision'>,
  signal?: AbortSignal,
): Promise<AgentAgreement> {
  const result = await getData<unknown>(request.post(`/agent/set_agent_agreement/${row.id}`,
    { content: row.content, status: row.status, revision: row.revision }, { signal }));
  const parsed = parseAgentAgreement(result);
  if (parsed.id <= 0) throw new Error('分销说明保存响应无效');
  return parsed;
}
