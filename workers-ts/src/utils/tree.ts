/**
 * 树构建工具
 *
 * 对应 PHP 全局函数 get_tree_children()
 * 把扁平的 pid 列表递归嵌套成 children 树。
 */
export interface TreeNode {
  id: number;
  pid: number;
  children?: TreeNode[];
  [key: string]: unknown;
}

/**
 * 扁平列表 → 嵌套树
 *
 * @param list 扁平节点 (每个必须有 id, pid)
 * @returns 顶级节点数组 (pid=0 的), 每个节点 children 必为数组 (空数组表示叶子)
 */
export function buildTree<T extends TreeNode>(list: T[]): (T & { children: ReturnType<typeof buildTree<T>> })[] {
  type Node = T & { children: Node[] };
  const map = new Map<number, Node>();
  const roots: Node[] = [];

  // 第一遍: 全部放进 map, 初始化 children
  for (const item of list) {
    map.set(item.id, { ...item, children: [] } as Node);
  }

  // 第二遍: 按 pid 挂载
  for (const item of list) {
    const node = map.get(item.id)!;
    if (item.pid && map.has(item.pid)) {
      map.get(item.pid)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
