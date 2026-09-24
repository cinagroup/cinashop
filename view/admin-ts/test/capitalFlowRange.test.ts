import assert from "node:assert/strict";
import { test } from "node:test";
import { capitalFlowRange } from "../src/pages/finance/capitalFlowRange.ts";

test("unfiltered request sends no time bounds", () => {
  assert.deepEqual(capitalFlowRange(null), {});
  assert.deepEqual(capitalFlowRange([]), {});
});

test("Shanghai minute range includes the full selected end minute", () => {
  assert.deepEqual(capitalFlowRange(["2026-09-24 09:30", "2026-09-24 10:45"]), {
    start: Date.UTC(2026, 8, 24, 1, 30) / 1000,
    stop: Date.UTC(2026, 8, 24, 2, 45, 59) / 1000,
  });
});

test("rejects incomplete, invalid, or reversed picker values", () => {
  assert.throws(() => capitalFlowRange(["2026-09-24 09:30"]), /完整/);
  assert.throws(() => capitalFlowRange(["2026-02-30 09:30", "2026-03-01 10:00"]), /有效/);
  assert.throws(() => capitalFlowRange(["1970-01-01 00:00", "1970-01-01 00:01"]), /有效/);
  assert.throws(() => capitalFlowRange(["2038-01-01 00:00", "2038-01-20 00:00"]), /范围/);
  assert.throws(() => capitalFlowRange(["2026-09-24 10:45", "2026-09-24 09:30"]), /早于/);
});
