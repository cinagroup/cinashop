import { is } from "drizzle-orm";
import { CheckBuilder, ForeignKeyBuilder, type Check, type ForeignKey, type PgTable } from "drizzle-orm/pg-core";

/**
 * PostgreSQL CHECK/FK extension for the pinned, patched Drizzle generator.
 * NOT VALID preserves pre-existing rows but enforces subsequent writes. It is
 * not a request to validate historical rows. Only use with reviewed migrations.
 */
export function notValid<T extends CheckBuilder | ForeignKeyBuilder>(builder: T): T {
  if (!is(builder, CheckBuilder) && !is(builder, ForeignKeyBuilder)) {
    throw new TypeError("notValid only supports PostgreSQL CHECK and foreign-key builders");
  }
  // Drizzle 0.45.2 omits this @internal method from its declarations. Keep this
  // bridge narrow and runtime-checked; do not mutate the package or prototypes.
  const runtime = builder as T & { build(table: PgTable): Check | ForeignKey };
  if (typeof runtime.build !== "function") throw new TypeError("PostgreSQL constraint builder API drift");
  const build = runtime.build;
  const decorated = Object.create(Object.getPrototypeOf(builder), Object.getOwnPropertyDescriptors(builder)) as typeof runtime;
  Object.defineProperty(decorated, "build", {
    configurable: true,
    value(this: typeof runtime, table: PgTable) {
      const constraint = build.call(this, table);
      Object.defineProperty(constraint, "notValid", { value: true, enumerable: true });
      return constraint;
    },
  });
  return decorated;
}
