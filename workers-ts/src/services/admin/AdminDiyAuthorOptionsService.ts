import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { ProductWordsService } from '@/services/product/ProductWordsService';
import { ValidateException } from '@/utils/errors';
import { AdminFabLinkCatalogService, type FabLinkTarget } from './AdminFabLinkCatalogService';

/** Typed identities map directly to the active authored microPage/classPage
 * slot. The safe URL remains available for display, never parsed for identity. */
export type DiyAuthorTabSelection =
  | { kind: 'micro'; id: number; name: string }
  | { kind: 'category'; id: number; name: string };
export type DiyAuthorTabTarget = FabLinkTarget & { selection: DiyAuthorTabSelection | null };

function noQuery(parameters: URLSearchParams): void {
  if (parameters.size) throw new ValidateException('作者选项接口不接受查询参数');
}

function tabTarget(item: FabLinkTarget): DiyAuthorTabTarget {
  if (item.kind !== 'special' && item.kind !== 'product_category') {
    throw new ValidateException('选项卡目录包含未知类型');
  }
  if (!item.selectable) return { ...item, selection: null };
  if (!Number.isSafeInteger(item.id) || item.id <= 0 || item.id > 2147483647) {
    throw new ValidateException('选项卡目标身份无效');
  }
  return { ...item, selection: { kind: item.kind === 'special' ? 'micro' : 'category',
    id: item.id, name: item.name } };
}

/** Read-only reuse of existing public-safe option projections. This service
 * grants neither access to private content nor any purchase/publishing right. */
export class AdminDiyAuthorOptionsService {
  private readonly catalog: AdminFabLinkCatalogService;
  private readonly words: ProductWordsService;
  constructor(container: Container, env: Pick<Env, 'APP_KEY'>) {
    this.catalog = new AdminFabLinkCatalogService(container, env);
    this.words = new ProductWordsService(container);
  }
  async hotWords(parameters = new URLSearchParams()) {
    noQuery(parameters);
    // Complete platform-visible author list; publicKeywords() would silently
    // limit the original author catalog to twenty and expose a different DTO.
    return { list: await this.words.allVisible() };
  }
  async linkCategories(parameters = new URLSearchParams()) {
    return this.catalog.categories(parameters);
  }
  async linkTargets(parameters: URLSearchParams) {
    return this.catalog.targets(parameters);
  }
  async tabCategories(parameters = new URLSearchParams()) {
    const result = await this.catalog.categories(parameters);
    return { ...result, list: result.list.filter(item =>
      item.kind === 'special' || item.kind === 'product_category') };
  }
  async tabTargets(parameters: URLSearchParams) {
    const result = await this.catalog.diyTabTargets(parameters);
    return { ...result, list: result.list.map(tabTarget) };
  }
}
