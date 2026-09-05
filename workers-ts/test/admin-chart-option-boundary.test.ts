import { describe, expect, it, vi } from "vitest";
import { AdminDashboardService, buildAdminDashboardPeriod, type AdminHomeCycle } from "@/services/admin/AdminDashboardService";
import { AdminStatisticService, parseAdminStatisticRange } from "@/services/admin/AdminStatisticService";
import { AdminExtendedStatisticService } from "@/services/admin/AdminExtendedStatisticService";

const now = Math.floor(Date.parse("2026-09-05T04:00:00Z") / 1000);
const injected = {
  name: '<b data-echarts-probe="raw">name</b>', type: "lines", coordinateSystem: "cartesian2d",
  data: [{ name: "untrusted HTML", coords: [[0, 0], [1, 1]] }], tooltip: { trigger: "item", formatter: "raw" },
};
const poisonedValues = [injected.name, "&#x3c;b&#x3e;name&#x3c;/b&#x3e;", JSON.stringify(injected)];

// A query-result boundary fixture, not a PostgreSQL/HTTP/authentication integration test.
function queryFixture(rows: Record<string, unknown>[]) {
  const execute = vi.fn().mockResolvedValue(rows);
  return { execute, container: { db: { execute } } as never };
}

function assertFixedSeries(series: Array<{ name: string; type: string; data: number[] }>) {
  for (const item of series) {
    expect(["line", "bar"]).toContain(item.type);
    expect(item.name).not.toContain("data-echarts-probe");
    expect(item).not.toHaveProperty("tooltip");
    expect(item).not.toHaveProperty("coordinateSystem");
    expect(item.data.every((value) => typeof value === "number" && Number.isFinite(value))).toBe(true);
  }
}

describe("the four Admin API families feeding spread chart options", () => {
  it.each<AdminHomeCycle>(["thirtyday", "week", "month", "year"])("home/order %s constructs fixed series rather than forwarding query rows", async (cycle) => {
    const period = buildAdminDashboardPeriod(cycle, now);
    const row = { period: "current", bucket: period.bucketKeys[0], count: 3, price: "12.50" };
    const clean = queryFixture([row]);
    const expected = await new AdminDashboardService(clean.container).orderChart(cycle, now);
    const tainted = queryFixture([{ ...row, ...injected }]);
    const actual = await new AdminDashboardService(tainted.container).orderChart(cycle, now);
    expect(actual).toEqual(expected);
    expect(actual.cycle.count.data).toBe(3);
    expect(actual.cycle.price.data).toBe(12.5);
    assertFixedSeries(actual.series);
    expect(tainted.execute).toHaveBeenCalledTimes(1);
    for (const value of poisonedValues) {
      const invalid = queryFixture([{ ...row, ...injected, count: value, price: value }]);
      const result = await new AdminDashboardService(invalid.container).orderChart(cycle, now);
      assertFixedSeries(result.series);
      expect(result.series.every((item) => item.data.every((point) => point === 0))).toBe(true);
    }
  });

  for (const family of ["order", "product", "balance"] as const) {
    it(`${family}/get_trend uses fixed metrics and numeric points without forwarding options`, async () => {
      const range = parseAdminStatisticRange("2026/09/05-2026/09/05");
      const metric = { order: "订单金额", product: "支付金额", balance: "余额积累" }[family];
      const row = { metric, bucket: range.bucketKeys[0], value: "12.50" };
      const run = (rows: Record<string, unknown>[]) => {
        const fixture = queryFixture(rows);
        return family === "balance"
          ? new AdminExtendedStatisticService(fixture.container).balanceTrend(range)
          : family === "order"
            ? new AdminStatisticService(fixture.container).orderTrend(range)
            : new AdminStatisticService(fixture.container).productTrend(range);
      };
      const expected = await run([row]);
      const actual = await run([{ ...row, ...injected }]);
      expect(actual).toEqual(expected);
      expect(actual.series.find((item) => item.name === metric)?.data[0]).toBe(12.5);
      assertFixedSeries(actual.series);
      for (const value of poisonedValues) {
        const invalid = await run([{ ...row, ...injected, value }]);
        assertFixedSeries(invalid.series);
        expect(invalid.series.every((item) => item.data.every((point) => point === 0))).toBe(true);
      }
      expect(await run([{ ...row, metric: injected.name }])).toEqual(await run([]));
    });
  }
});
