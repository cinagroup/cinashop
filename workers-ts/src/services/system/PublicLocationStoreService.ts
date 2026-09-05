import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { cityArea, storeUser, systemCity, systemStore } from "@/models/schema";
import { signAttachmentReferences } from "@/services/system/AttachmentService";
import { PublicBrandingService } from "@/services/system/PublicBrandingService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { parseConfigInteger } from "@/utils/config";
import { ValidateException } from "@/utils/errors";

const MAX_CITY_AREA_CHILDREN = 1_000;
const MAX_SYSTEM_CITIES = 10_000;
const MAX_STORE_PAGE_SIZE = 100;
const DEFAULT_STORE_PAGE_SIZE = 10;
const MAX_STORE_OFFSET = 10_000;
const STORED_COORDINATE_PATTERN = "^[+-]?[0-9]{1,3}(\\.[0-9]+)?$";

export interface LegacyCoordinates {
  latitude: number;
  longitude: number;
}

export interface PublicStoreRow {
  id: number;
  name: string;
  introduction: string;
  phone: string;
  address: string;
  province: number;
  city: number;
  area: number;
  street: number | null;
  detailedAddress: string;
  image: string;
  oblongImage: string;
  latitude: string;
  longitude: string;
  validTime: string;
  validRange: number;
  dayTime: string;
  dayStart: string | null;
  dayEnd: string;
  isShow: number;
  isStore: number;
  distance: number | string | null;
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, maximum)
    : "";
}

function safePublicAsset(value: unknown): string {
  const text = boundedText(value, 2_048);
  if (!text) return "";
  if (/^\/(?!\/)/u.test(text)) return text;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function coordinate(value: unknown, kind: "latitude" | "longitude"): number | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const pattern = kind === "longitude"
    ? /^-?\d{1,3}(?:\.\d+)?$/u
    : /^[+-]?(?:[0-8]?\d(?:\.\d+)?|90(?:\.0+)?)$/u;
  const parsed = Number(text);
  const maximum = kind === "longitude" ? 180 : 90;
  if (!pattern.test(text) || !Number.isFinite(parsed) || parsed < -maximum || parsed > maximum) {
    throw new ValidateException("参数错误");
  }
  return parsed;
}

/** PHP validates each supplied coordinate but only enables distance ordering when both exist. */
export function parseLegacyCoordinates(latitude: unknown, longitude: unknown): LegacyCoordinates | null {
  const parsedLatitude = coordinate(latitude, "latitude");
  const parsedLongitude = coordinate(longitude, "longitude");
  return parsedLatitude === null || parsedLongitude === null
    ? null
    : { latitude: parsedLatitude, longitude: parsedLongitude };
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/u.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function parseLegacyStorePage(query: Record<string, string | undefined>): {
  page: number;
  limit: number;
  offset: number;
} {
  const page = Math.max(1, nonNegativeInteger(query.page, 1));
  const limit = Math.min(MAX_STORE_PAGE_SIZE, Math.max(1, nonNegativeInteger(query.limit, DEFAULT_STORE_PAGE_SIZE)));
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset > MAX_STORE_OFFSET) {
    throw new ValidateException("分页范围过大");
  }
  return { page, limit, offset };
}

function nonNegativeId(value: unknown, label: string): number {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/u.test(text)) return 0;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function roundedDistance(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

export function formatPickupRange(distance: number | null): string {
  if (distance === null) return "0";
  if (distance < 1_000) return `${distance}m`;
  return `${(Math.trunc(distance / 100) / 10).toFixed(1)}km`;
}

export function formatNearbyRange(distance: number | null): number | string {
  return distance === null ? 0 : (Math.trunc(distance / 100) / 10).toFixed(1);
}

export function toLegacyPublicStore(
  row: PublicStoreRow,
  mode: "pickup" | "nearby",
  signedImage = safePublicAsset(row.image),
  signedOblongImage = safePublicAsset(row.oblongImage),
) {
  const distance = roundedDistance(row.distance);
  return {
    id: row.id,
    name: boundedText(row.name, 100),
    introduction: boundedText(row.introduction, 1_000),
    phone: boundedText(row.phone, 25),
    address: boundedText(row.address, 255),
    province: row.province,
    city: row.city,
    area: row.area,
    street: row.street,
    detailed_address: boundedText(row.detailedAddress, 255),
    image: signedImage,
    oblong_image: signedOblongImage,
    latitude: boundedText(row.latitude, 25),
    longitude: boundedText(row.longitude, 25),
    latlng: `${boundedText(row.latitude, 25)},${boundedText(row.longitude, 25)}`,
    valid_time: boundedText(row.validTime, 100),
    valid_range: row.validRange,
    day_time: boundedText(row.dayTime, 100),
    day_start: boundedText(row.dayStart, 20),
    day_end: boundedText(row.dayEnd, 20),
    is_show: row.isShow,
    is_store: row.isStore,
    ...(distance === null ? {} : { distance }),
    range: mode === "pickup" ? formatPickupRange(distance) : formatNearbyRange(distance),
    status_name: row.isShow === 1 ? "营业中" : "已停业",
  };
}

export interface SystemCityTreeRow {
  id: number;
  cityId: number;
  parentId: number;
  name: string;
}

export function buildLegacySystemCityTree(rows: SystemCityTreeRow[]) {
  const byParent = new Map<number, SystemCityTreeRow[]>();
  for (const row of rows) {
    byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
  }
  const visit = (parentId: number, ancestors: Set<number>, depth: number): unknown[] => {
    if (depth > 8) throw new ValidateException("城市层级超过安全上限");
    return (byParent.get(parentId) ?? []).map((row) => {
      if (ancestors.has(row.cityId)) throw new ValidateException("城市层级存在循环");
      const next = new Set(ancestors);
      next.add(row.cityId);
      return {
        v: row.cityId,
        n: boundedText(row.name, 100),
        parent_id: row.parentId,
        children: visit(row.cityId, next, depth + 1),
      };
    });
  };
  return visit(0, new Set<number>(), 0);
}

function distanceExpression(coordinates: LegacyCoordinates | null): SQL<number | null> {
  if (!coordinates) return sql<number | null>`NULL`;
  const storedCoordinateShape = sql`
    btrim(${systemStore.latitude}) ~ ${STORED_COORDINATE_PATTERN}
    AND btrim(${systemStore.longitude}) ~ ${STORED_COORDINATE_PATTERN}
  `;
  // Keep casts behind an outer CASE. PostgreSQL may reorder predicates inside
  // one AND expression, so `regex AND value::float` is not an error-safe guard.
  return sql<number | null>`CASE WHEN ${storedCoordinateShape} THEN CASE WHEN
    btrim(${systemStore.latitude})::double precision BETWEEN -90 AND 90
    AND btrim(${systemStore.longitude})::double precision BETWEEN -180 AND 180
  THEN ROUND(
      6367000 * 2 * ASIN(SQRT(LEAST(1, GREATEST(0,
        POWER(SIN((RADIANS(btrim(${systemStore.latitude})::double precision) - RADIANS(${coordinates.latitude})) / 2), 2)
        + COS(RADIANS(${coordinates.latitude}))
          * COS(RADIANS(btrim(${systemStore.latitude})::double precision))
          * POWER(SIN((RADIANS(btrim(${systemStore.longitude})::double precision) - RADIANS(${coordinates.longitude})) / 2), 2)
      ))))
    ) ELSE NULL END
  ELSE NULL END`;
}

function storeSelection(distance: SQL<number | null>) {
  return {
    id: systemStore.id,
    name: systemStore.name,
    introduction: systemStore.introduction,
    phone: systemStore.phone,
    address: systemStore.address,
    province: systemStore.province,
    city: systemStore.city,
    area: systemStore.area,
    street: systemStore.street,
    detailedAddress: systemStore.detailedAddress,
    image: systemStore.image,
    oblongImage: systemStore.oblongImage,
    latitude: systemStore.latitude,
    longitude: systemStore.longitude,
    validTime: systemStore.validTime,
    validRange: systemStore.validRange,
    dayTime: systemStore.dayTime,
    dayStart: systemStore.dayStart,
    dayEnd: systemStore.dayEnd,
    isShow: systemStore.isShow,
    isStore: systemStore.isStore,
    distance,
  };
}

function keywordCondition(keyword: string): SQL | undefined {
  if (!keyword) return undefined;
  const pattern = `%${keyword}%`;
  return or(
    sql`${systemStore.id}::text ILIKE ${pattern}`,
    ilike(systemStore.name, pattern),
    ilike(systemStore.introduction, pattern),
    ilike(systemStore.phone, pattern),
    ilike(systemStore.detailedAddress, pattern),
    ilike(systemStore.address, pattern),
  );
}

export class PublicLocationStoreService {
  private readonly config: SystemConfigService;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {
    this.config = new SystemConfigService(container, env);
  }

  async city(pidValue: unknown) {
    const pid = nonNegativeId(pidValue, "城市ID");
    const parentRows = pid
      ? await this.container.db
          .select({ name: cityArea.name })
          .from(cityArea)
          .where(eq(cityArea.id, pid))
          .limit(1)
      : [];
    const parentName = pid ? boundedText(parentRows[0]?.name, 100) : "中国";
    const rows = await this.container.db
      .select({
        value: cityArea.id,
        id: cityArea.id,
        label: cityArea.name,
        pid: cityArea.parentId,
        level: cityArea.level,
      })
      .from(cityArea)
      .where(eq(cityArea.parentId, pid))
      .orderBy(asc(cityArea.id))
      .limit(MAX_CITY_AREA_CHILDREN + 1);
    if (rows.length > MAX_CITY_AREA_CHILDREN) throw new ValidateException("城市数据超过安全上限");

    const ids = rows.map((row) => row.id);
    const childParents = ids.length
      ? await this.container.db
          .select({ parentId: cityArea.parentId })
          .from(cityArea)
          .where(inArray(cityArea.parentId, ids))
          .groupBy(cityArea.parentId)
          .limit(MAX_CITY_AREA_CHILDREN + 1)
      : [];
    if (childParents.length > MAX_CITY_AREA_CHILDREN) throw new ValidateException("城市数据超过安全上限");
    const expandable = new Set(childParents.map((row) => row.parentId));
    return rows.map((row) => ({
      value: row.value,
      id: row.id,
      label: boundedText(row.label, 100),
      pid: row.pid,
      level: row.level,
      parent_name: parentName,
      ...(expandable.has(row.id) ? { children: [], loading: false, _loading: false } : {}),
    }));
  }

  async cityList() {
    const rows = await this.container.db
      .select({
        id: systemCity.id,
        cityId: systemCity.cityId,
        parentId: systemCity.parentId,
        name: systemCity.name,
      })
      .from(systemCity)
      .orderBy(asc(systemCity.id))
      .limit(MAX_SYSTEM_CITIES + 1);
    if (rows.length > MAX_SYSTEM_CITIES) throw new ValidateException("城市数据超过安全上限");
    return buildLegacySystemCityTree(rows);
  }

  private async publicStoreRows(
    query: Record<string, string | undefined>,
    mode: "pickup" | "nearby",
    uid: number,
  ): Promise<{ list: ReturnType<typeof toLegacyPublicStore>[]; count: number }> {
    const coordinates = parseLegacyCoordinates(query.latitude, query.longitude);
    const { limit, offset } = parseLegacyStorePage(query);
    const distance = distanceExpression(coordinates);
    const conditions: Array<SQL | undefined> = [
      eq(systemStore.isDel, 0),
      eq(systemStore.isShow, 1),
    ];

    if (mode === "pickup") {
      if (nonNegativeInteger(query.is_store, 1) === 2) conditions.push(eq(systemStore.isStore, 1));
    } else {
      const storeType = nonNegativeInteger(query.store_type, 1);
      if (storeType !== 1) {
        if (!uid) return { list: [], count: 0 };
        const commonStores = this.container.db
          .select({ storeId: storeUser.storeId })
          .from(storeUser)
          .where(eq(storeUser.uid, uid));
        conditions.push(inArray(systemStore.id, commonStores));
      }
      conditions.push(keywordCondition(boundedText(query.keyword, 100)));
    }

    const where = and(...conditions);
    const ordering = coordinates
      ? [sql`${distance} ASC NULLS LAST`, desc(systemStore.id)]
      : [desc(systemStore.id)];
    const [rows, counts] = await Promise.all([
      this.container.db
        .select(storeSelection(distance))
        .from(systemStore)
        .where(where)
        .orderBy(...ordering)
        .limit(limit)
        .offset(offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(systemStore)
        .where(where),
    ]);

    const rawAssets = rows.flatMap((row) => [safePublicAsset(row.image), safePublicAsset(row.oblongImage)]);
    const signedAssets = rawAssets.length
      ? await signAttachmentReferences(this.env.APP_KEY, rawAssets)
      : [];
    return {
      list: rows.map((row, index) => toLegacyPublicStore(
        row,
        mode,
        signedAssets[index * 2] ?? "",
        signedAssets[index * 2 + 1] ?? "",
      )),
      count: Number(counts[0]?.count ?? 0),
    };
  }

  async storeList(query: Record<string, string | undefined>, requestOrigin: string) {
    const [list, values, branding] = await Promise.all([
      this.publicStoreRows(query, "pickup", 0),
      this.config.getMany(["tengxun_map_key"]),
      new PublicBrandingService(this.container, this.env).siteConfig(requestOrigin),
    ]);
    return {
      list,
      tengxun_map_key: boundedText(values.tengxun_map_key, 256),
      site_logo: branding.site_logo,
    };
  }

  async nearbyStore(query: Record<string, string | undefined>, uid: number) {
    const enabled = parseConfigInteger(await this.config.get("store_func_status"), 1) !== 0;
    if (!enabled) return [];
    // The PHP fallback calls a remote IP geocoder. Workers do not send client IPs
    // to an undeclared provider; requests without coordinates use deterministic ID order.
    return (await this.publicStoreRows(query, "nearby", uid)).list;
  }
}
