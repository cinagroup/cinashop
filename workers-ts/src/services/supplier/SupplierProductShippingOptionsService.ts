import { and, eq } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { shippingTemplates } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { SupplierShippingTemplateService } from './SupplierShippingTemplateService';

/** Product selection exposes metadata, never editor rules or revision tokens. */
export class SupplierProductShippingOptionsService {
  constructor(private readonly container: Container) {}

  async list(supplierId: number, query: Record<string, string>) {
    // Reuse the bounded, tenant-scoped single-statement page/count snapshot.
    const page = await new SupplierShippingTemplateService(this.container).list(supplierId, query);
    return { count: page.count, data: page.data.map(({ id, name, type }) => ({ id, name, type })) };
  }

  async detail(supplierId: number, id: number) {
    if (!Number.isSafeInteger(supplierId) || supplierId < 1 || supplierId > 2_147_483_647) throw new ValidateException('供应商ID错误');
    if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) throw new ValidateException('运费模板ID错误');
    const [row] = await this.container.db.select({ id: shippingTemplates.id, name: shippingTemplates.name, type: shippingTemplates.type })
      .from(shippingTemplates).where(and(eq(shippingTemplates.id, id), eq(shippingTemplates.ownerType, 2),
        eq(shippingTemplates.relationId, supplierId), eq(shippingTemplates.isDel, 0))).limit(1);
    if (!row) throw new NotFoundException('运费模板不存在或不属于当前供应商');
    const types: Record<number, string> = { 1: '按件数', 2: '按重量', 3: '按体积' };
    return { id: row.id, name: row.name, type: types[row.type] ?? '' };
  }
}
