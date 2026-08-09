import { describe, it, expect } from "vitest";
import { buildTree, type TreeNode } from "../src/utils/tree";

describe("buildTree (分类树构建, 对应 PHP get_tree_children)", () => {
  it("把扁平 pid 列表嵌套成 children 树", () => {
    const flat: TreeNode[] = [
      { id: 1, pid: 0, cate_name: "一级A" },
      { id: 2, pid: 0, cate_name: "一级B" },
      { id: 3, pid: 1, cate_name: "二级A-1" },
      { id: 4, pid: 1, cate_name: "二级A-2" },
      { id: 5, pid: 3, cate_name: "三级A-1-1" },
      { id: 6, pid: 2, cate_name: "二级B-1" },
    ];

    const tree = buildTree(flat);

    expect(tree).toHaveLength(2);
    expect(tree[0].id).toBe(1);
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].id).toBe(3);
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].id).toBe(5);
    expect(tree[1].id).toBe(2);
    expect(tree[1].children).toHaveLength(1);
    expect(tree[1].children[0].id).toBe(6);
    expect(tree[1].children[0].children).toHaveLength(0);
  });

  it("空数组返回空树", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("孤儿节点 (pid 指向不存在的父) 当作顶级", () => {
    const flat: TreeNode[] = [{ id: 10, pid: 999, cate_name: "孤儿" }];
    const tree = buildTree(flat);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(10);
  });

  it("叶子节点 children 是空数组", () => {
    const flat: TreeNode[] = [{ id: 1, pid: 0, cate_name: "独苗" }];
    const tree = buildTree(flat);
    expect(tree[0].children).toEqual([]);
  });
});
