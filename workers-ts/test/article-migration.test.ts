import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";

describe("article migration compatibility", () => {
  it("migrates article metadata, taxonomy, and one-to-one body content explicitly", () => {
    const byTable = new Map(MIGRATION_TABLES.map((entry) => [entry.table, entry]));
    expect(byTable.get("system_article")).toMatchObject({
      sourceTable: "article",
      columnConversions: {
        cid: "numeric_string_to_integer",
        visit: "numeric_string_to_integer",
        add_time: "numeric_string_to_integer",
      },
    });
    expect(byTable.get("article_category")?.columnConversions).toEqual({
      add_time: "numeric_string_to_integer",
    });
    expect(byTable.get("article_content")?.key).toEqual(["nid"]);
  });

  it("falls back to imported bodies and mirrors new-system edits atomically", () => {
    const service = readFileSync("src/services/content/AdminArticleService.ts", "utf8");
    expect(service).toContain("leftJoin(articleContent, eq(articleContent.nid, systemArticle.id))");
    expect(service).toContain("COALESCE(NULLIF(${systemArticle.content}, ''), ${articleContent.content}, '')");
    expect(service).toContain("tx.insert(articleContent).values({ nid: id, content: input.content })");
    expect(service).toContain(".onConflictDoUpdate({ target: articleContent.nid, set: { content: input.content } })");
    expect(service).toContain("verified.mirrored_content !== input.content");
  });
});
