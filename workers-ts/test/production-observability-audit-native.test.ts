import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { financePostgres } from "./helpers/financePostgres";
import { orderPrintJob } from "@/models/schema/printing_job";
import { orderWaybillJob } from "@/models/schema/waybill_job";
import { storeOrderRefundPayment } from "@/models/schema/order_refund_payment";
import { systemQueueDeadLetter } from "@/models/schema/queue_dead_letter";
import { auditProductionObservability } from "@/migrations/auditProductionObservability";

const tables = [orderPrintJob, orderWaybillJob, storeOrderRefundPayment, systemQueueDeadLetter];
const marker = "fixtureSecret";

function valueForType(type: string): string {
  if (/^(?:smallint|integer|bigint|numeric|real|double precision)/.test(type)) return "1";
  if (/^(?:json|jsonb)/.test(type)) return "'{}'::jsonb";
  if (/^boolean/.test(type)) return "false";
  if (/^(?:varchar|text|char)/.test(type)) {
    const maximum = /^varchar\((\d+)\)/.exec(type)?.[1];
    return maximum && Number(maximum) < marker.length ? "'z'" : `'${marker}'`;
  }
  throw Error(`Unhandled observability fixture type: ${type}`);
}

function insertStatus(table: PgTable, statusColumn: "status" | "provider_status", status: string): string {
  const config = getTableConfig(table);
  const columns = config.columns.filter((column) => column.name !== "id");
  const names = columns.map((column) => `"${column.name}"`).join(", ");
  const values = columns.map((column) => column.name === statusColumn
    ? `'${status}'` : valueForType(column.getSQLType())).join(", ");
  return `INSERT INTO public."${config.name}" (${names}) VALUES (${values})`;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))(
  "TEST-003B current schema read-only aggregate on disposable PostgreSQL 16", () => {
    let fixture: Awaited<ReturnType<typeof financePostgres>>;
    let database: string;
    beforeAll(async () => {
      fixture = await financePostgres(tables, { namespace: "public" });
      const [identity] = await fixture.db.$client<{ database: string }[]>`
        SELECT current_database() AS database`;
      database = identity.database;
      for (const [table, column, statuses] of [
        [orderPrintJob, "status", ["UNKNOWN", "SENT"]],
        [orderWaybillJob, "status", ["DEAD", "SENT"]],
        [storeOrderRefundPayment, "provider_status", ["UNKNOWN", "SUCCESS"]],
        [systemQueueDeadLetter, "status", ["OPEN", "RESOLVED"]],
      ] as const) {
        for (const status of statuses) await fixture.exec(insertStatus(table, column, status));
      }
    });
    afterAll(async () => { await fixture?.close(); });

    it("counts all four nonempty workflows and keeps the fixture unchanged", async () => {
      const before = await fixture.db.$client<{ rows: number }[]>`
        SELECT (SELECT count(*) FROM public.order_print_job)
          + (SELECT count(*) FROM public.order_waybill_job)
          + (SELECT count(*) FROM public.store_order_refund_payment)
          + (SELECT count(*) FROM public.system_queue_dead_letter) AS rows`;
      const result = await auditProductionObservability(fixture.db.$client,
        { role: "finance_test", database });
      const after = await fixture.db.$client<{ rows: number }[]>`
        SELECT (SELECT count(*) FROM public.order_print_job)
          + (SELECT count(*) FROM public.order_waybill_job)
          + (SELECT count(*) FROM public.store_order_refund_payment)
          + (SELECT count(*) FROM public.system_queue_dead_letter) AS rows`;
      expect(after).toEqual(before);
      expect(Number(after[0].rows)).toBe(8);
      expect(result.workflowStatus).toEqual(expect.arrayContaining([
        { workflow: "print", status: "UNKNOWN", rows: 1 },
        { workflow: "waybill", status: "DEAD", rows: 1 },
        { workflow: "refund_payment", status: "UNKNOWN", rows: 1 },
        { workflow: "queue_dead_letter", status: "OPEN", rows: 1 },
      ]));
      expect(result.workflowAttention).toMatchObject({ print_attention: 1,
        waybill_attention: 1, refund_attention: 1, dead_letter_attention: 1 });
      expect(Number(result.workflowAttention.oldest_unknown_refund_seconds)).toBeGreaterThan(0);
      expect(result.safety).toMatchObject({ identityVerified: true,
        transactionReadOnly: true, repeatableRead: true, queryTextReturned: false,
        businessValuesReturned: false });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(result.statementStatistics.queryTextReturned).toBe(false);
      // This fixture LOGIN is intentionally non-superuser and lacks monitoring
      // grants. Limited pg_stat_activity visibility must not look complete.
      expect(result.statementStatistics.authorized).toBe(false);
      expect(result.activity).toBeNull();
      expect(result.ready).toBe(false);
    });

    it("rejects the wrong backend identity before returning any task counts", async () => {
      await expect(auditProductionObservability(fixture.db.$client,
        { role: "not_the_fixture", database })).rejects.toThrow(/identity/);
    });

    it("fails closed when a required status table is absent", async () => {
      await fixture.exec("DROP TABLE public.order_waybill_job");
      await expect(auditProductionObservability(fixture.db.$client,
        { role: "finance_test", database })).rejects.toMatchObject({ code: "42P01" });
    });
  },
);
