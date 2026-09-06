import { is } from "drizzle-orm";
import { PgColumn, PgSequence, getTableConfig } from "drizzle-orm/pg-core";

export type SequenceState = {
  dataType: "smallint" | "integer" | "bigint";
  ownedBy: (() => PgColumn) | null;
};

/** Explicit sequence metadata for our checksum-pinned generator. No package or prototype mutation. */
export function withSequenceState<T extends PgSequence>(sequence: T, state: SequenceState): T {
  if (!is(sequence, PgSequence) || !state || !["smallint", "integer", "bigint"].includes(state.dataType)
    || (state.ownedBy !== null && typeof state.ownedBy !== "function")
    || Object.keys(state).sort().join(",") !== "dataType,ownedBy") {
    throw new TypeError("withSequenceState requires a PostgreSQL sequence and explicit type/ownedBy");
  }
  const { dataType, ownedBy } = state;
  const decorated = Object.create(Object.getPrototypeOf(sequence), Object.getOwnPropertyDescriptors(sequence)) as T;
  // Lazy resolution lets a sequence precede the table whose default uses it.
  // Resolution occurs only during schema generation, never as an import-time I/O operation.
  Object.defineProperty(decorated, "cinashopSequence", {
    enumerable: true, configurable: true,
    get() {
      if (ownedBy === null) return { dataType, ownedBy: null };
      const column = ownedBy();
      if (!is(column, PgColumn)) throw new TypeError("Sequence ownedBy must resolve to a PostgreSQL column");
      const table = getTableConfig(column.table);
      const schema = table.schema ?? "public";
      if (schema !== (sequence.schema ?? "public")) throw new TypeError("Sequence and owning column must share a schema");
      return { dataType, ownedBy: { schema, table: table.name, column: column.name } };
    },
  });
  return decorated;
}
