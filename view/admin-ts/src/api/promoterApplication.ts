import request, { getData } from '@/utils/request';

export type PromoterApplicationStatus = 0 | 1 | 2;
export interface PromoterApplication {
  id: number;
  uid: number;
  nickname: string;
  real_name: string;
  phone: string;
  status: PromoterApplicationStatus;
  add_time: string;
  status_time: string;
  refusal_reason: string;
  revision: string;
}
export interface PromoterApplicationQuery {
  page: number;
  limit: number;
  keyword?: string;
  status?: 'all' | PromoterApplicationStatus;
}
export interface PromoterApplicationPage {
  list: PromoterApplication[];
  count: number;
  page: number;
  limit: number;
}

export function parsePromoterApplicationPage(value: unknown, query: PromoterApplicationQuery): PromoterApplicationPage {
  const page = value as PromoterApplicationPage | null;
  if (!page || !Array.isArray(page.list) || !Number.isSafeInteger(page.count) || page.count < 0 ||
    page.page !== query.page || page.limit !== query.limit || page.list.length > query.limit || page.list.length > page.count) {
    throw new Error('分销员申请分页响应格式错误');
  }
  const ids = new Set<number>();
  for (const row of page.list) {
    if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id) ||
      !Number.isSafeInteger(row.uid) || row.uid <= 0 || ![0, 1, 2].includes(row.status) ||
      typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(row.revision) ||
      !['nickname', 'real_name', 'phone', 'add_time', 'status_time', 'refusal_reason'].every(key =>
        typeof row[key as keyof PromoterApplication] === 'string')) {
      throw new Error('分销员申请记录格式错误');
    }
    ids.add(row.id);
  }
  return page;
}

export async function apiPromoterApplicationList(params: PromoterApplicationQuery, signal?: AbortSignal): Promise<PromoterApplicationPage> {
  const data = await getData<unknown>(request.get('/promoter/apply/list', { params, signal }));
  return parsePromoterApplicationPage(data, params);
}

export function apiPromoterApplicationReview(id: number, uid: number, status: 1 | 2, revision: string, refusalReason = '', signal?: AbortSignal): Promise<null> {
  return getData(request.post(`/promoter/apply/examine/${id}/${uid}/${status}`,
    status === 2 ? { revision, refusal_reason: refusalReason } : { revision }, { signal }));
}

export function apiPromoterApplicationDelete(id: number, revision: string, signal?: AbortSignal): Promise<null> {
  return getData(request.delete(`/promoter/apply/del/${id}`, { data: { revision }, signal }));
}
