import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { platformMetadataOwner, ProductMetadataService } from '@/services/product/ProductMetadataService';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const legacyTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** The old parameter-template table displays add_time directly. Keep its PHP
 * date projection here; the existing TS metadata endpoint still returns Unix seconds. */
export async function specsList(c: C) {
  const result = await new ProductMetadataService(c.get('container'))
    .specTemplateList(platformMetadataOwner, c.req.query());
  return jsonOk(c, { ...result, list: result.list.map(item => {
    const parts = item.add_time ? Object.fromEntries(legacyTime
      .formatToParts(new Date(item.add_time * 1000)).map(part => [part.type, part.value])) : null;
    return { ...item, add_time: parts
      ? `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` : '' };
  }) });
}
