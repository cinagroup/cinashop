import { describe, expect, it } from "vitest";
import { assertModelDeclaration } from "./helpers/modelDeclarationBinding";

describe("immutable model provenance binding", () => {
  const declaration = '  value: integer("value").default(0).notNull(),';
  const model = 'export const t = pgTable("target", {\n' + declaration + '\n});';
  it("permits line shifts but retains the exact AST declaration and named table", () => {
    expect(() => assertModelDeclaration("\n// shifted\n" + model, "target", declaration)).not.toThrow();
    expect(() => assertModelDeclaration('const t = pgTable("target", {}, t => [index("idx").on(t.id)]);',
      "target", 'index("idx").on(t.id),')).not.toThrow();
    expect(() => assertModelDeclaration('const t = pgTable("target", { id: integer("id")\n .unique("named") });',
      "target", '.unique("named")')).not.toThrow();
  });
  it("rejects wrong tables, comments, duplicates, changed defaults and changed index columns", () => {
    for (const source of [model.replace('"target"', '"wrong"'), "// " + model.replaceAll("\n", " "),
      model + model, model.replace(declaration, declaration + "\n" + declaration),
      model.replace(".default(0)", ".default(1)"), model.replace(declaration, "// " + declaration)]) {
      expect(() => assertModelDeclaration(source, "target", declaration)).toThrow();
    }
    expect(() => assertModelDeclaration('const t = pgTable("target", {}, t => [index("idx").on(t.other)]);',
      "target", 'index("idx").on(t.id),')).toThrow();
    for (const source of ['const t = pgTable("wrong", { id: integer("id").unique("named") });',
      'const t = pgTable("target", { a: integer("a").unique("named"), b: integer("b").unique("named") });',
      'const t = pgTable("target", { id: integer("id").unique("changed") });']) {
      expect(() => assertModelDeclaration(source, "target", '.unique("named")')).toThrow();
    }
  });
});
