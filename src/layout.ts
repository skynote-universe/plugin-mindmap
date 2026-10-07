/**
 * @file layout.ts
 * @description 思维导图布局：第一层主题分到中心主题左右两侧，各子树按高度纵向排开、以父主题为中心对齐
 *
 * 设计考量 (Why):
 * 1. 左右侧持久化在第一层主题的 layoutItem.side：插入时选当时较轻的一侧写入，之后打字、增删都不会让分支跳到另一侧。
 *    没有记录的 (如大纲导入、外部文档) 才按子树高度贪心分配，结果确定、各端一致。
 * 2. 纯函数：只读成员树与尺寸，返回各成员在根局部坐标中的位置；写入由内核在同一事务内完成。
 * 3. 分支线默认规格：从父主题朝向子主题的侧边中点出线，用导图曲线 (见 branch-router) 水平切出；
 *    颜色由导图主题决定 (见 themes.ts)：按第一层分支取色时整棵子树同色，便于区分。
 * 4. 参数都是有限的档位 (方向、线型、间距、主题)：界面直接列出可选项，文档里也不会出现无法解释的数值。
 */

import {
  generateKeyBetween,
  type BranchSpec,
  type LayoutDefinition,
  type LayoutMember,
  type LayoutTree,
  type NodeEntity,
  type Point
} from '@skynote/core';
import { MINDMAP_BRANCH_ROUTER } from './branch-router';
import { DEFAULT_MINDMAP_THEME, type MindmapThemeRegistry } from './themes';

export const MINDMAP_LAYOUT_ID = 'mindmap';

export type TopicSide = 'left' | 'right';
export type MindmapDirection = 'both' | TopicSide;

/** 分支线型：导图曲线 / 直角折线 / 直线 */
export type MindmapLine = 'curve' | 'elbow' | 'straight';
/** 间距档位：父子与兄弟之间的距离 */
export type MindmapSpacing = 'compact' | 'standard' | 'loose';

export interface MindmapOptions extends Record<string, unknown> {
  /** 双向 (默认)，或全部向右 / 向左展开 */
  direction: MindmapDirection;
  line: MindmapLine;
  spacing: MindmapSpacing;
  /** 导图主题：主题节点外观与分支线颜色 (见 themes.ts) */
  theme: string;
}

export const DEFAULT_MINDMAP_OPTIONS: Readonly<MindmapOptions> = Object.freeze({
  direction: 'both',
  line: 'curve',
  spacing: 'standard',
  theme: DEFAULT_MINDMAP_THEME
});

/** 各档位的父子水平间距与兄弟垂直间距 */
const SPACING: Record<MindmapSpacing, { readonly x: number; readonly y: number }> = {
  compact: { x: 40, y: 8 },
  standard: { x: 56, y: 16 },
  loose: { x: 80, y: 28 }
};
/** 各线型对应的路由器 */
const LINE_ROUTERS: Record<MindmapLine, string> = {
  curve: MINDMAP_BRANCH_ROUTER,
  elbow: 'orthogonal',
  straight: 'straight'
};

const isSide = (value: unknown): value is TopicSide => value === 'left' || value === 'right';
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** 解析根节点的 layout.options (不可信输入)：非法项回落默认 */
export function parseMindmapOptions(raw: unknown): MindmapOptions {
  const options =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fallback = DEFAULT_MINDMAP_OPTIONS;
  return {
    direction: pick(options.direction, ['both', 'right', 'left'], fallback.direction),
    line: pick(options.line, ['curve', 'elbow', 'straight'], fallback.line),
    spacing: pick(options.spacing, ['compact', 'standard', 'loose'], fallback.spacing),
    // 主题 id 原样保留 (可能是尚未注册的自定义主题)：使用处查不到时按默认主题处理
    theme: typeof options.theme === 'string' && options.theme.length > 0 ? options.theme : fallback.theme
  };
}

/** 子树占用的高度：自身与全部子树纵向排开后的较大者 */
function measureHeights(tree: LayoutTree, gapY: number): Map<string, number> {
  const heights = new Map<string, number>();
  const measure = (member: LayoutMember): number => {
    const children = member.children.reduce((sum, child) => sum + measure(child), 0);
    const height = Math.max(member.node.height, children + gapY * Math.max(0, member.children.length - 1));
    heights.set(member.node.id, height);
    return height;
  };
  measure(tree.root);
  return heights;
}

/**
 * 第一层主题所在侧：方向固定时全部同侧；双向时用记录的一侧，没有记录的按子树高度贪心分到较轻的一侧
 * 子成员沿用其第一层祖先所在侧
 */
export function resolveSides(tree: LayoutTree, heights?: ReadonlyMap<string, number>): Map<string, TopicSide> {
  const options = tree.options as MindmapOptions;
  const measured = heights ?? measureHeights(tree, SPACING[options.spacing].y);
  const sides = new Map<string, TopicSide>();
  const load = { left: 0, right: 0 };
  const firstLevel = tree.root.children;
  for (const member of firstLevel) {
    if (options.direction !== 'both') sides.set(member.node.id, options.direction);
    else if (isSide(member.item.side)) sides.set(member.node.id, member.item.side);
    else continue;
    load[sides.get(member.node.id)!] += measured.get(member.node.id)!;
  }
  for (const member of firstLevel) {
    if (sides.has(member.node.id)) continue;
    const side: TopicSide = load.right <= load.left ? 'right' : 'left';
    sides.set(member.node.id, side);
    load[side] += measured.get(member.node.id)!;
  }
  const inherit = (member: LayoutMember, side: TopicSide): void => {
    for (const child of member.children) {
      sides.set(child.node.id, side);
      inherit(child, side);
    }
  };
  for (const member of firstLevel) inherit(member, sides.get(member.node.id)!);
  return sides;
}

/** 新的第一层主题应放在哪一侧：方向固定时即该方向，双向时取当前较轻的一侧 */
export function chooseSideForNewTopic(tree: LayoutTree): TopicSide {
  const options = tree.options as MindmapOptions;
  if (options.direction !== 'both') return options.direction;
  const heights = measureHeights(tree, SPACING[options.spacing].y);
  const sides = resolveSides(tree, heights);
  const load = { left: 0, right: 0 };
  for (const member of tree.root.children) load[sides.get(member.node.id)!] += heights.get(member.node.id)!;
  return load.right <= load.left ? 'right' : 'left';
}

/** 成员所属的第一层分支 (根本身为 undefined) */
export function firstLevelOf(member: LayoutMember): LayoutMember | undefined {
  let current: LayoutMember | undefined = member;
  while (current?.parent?.parent) current = current.parent;
  return current?.parent ? current : undefined;
}

function arrange(tree: LayoutTree): Map<string, Point> {
  const options = tree.options as MindmapOptions;
  const gap = SPACING[options.spacing];
  const heights = measureHeights(tree, gap.y);
  const sides = resolveSides(tree, heights);
  const positions = new Map<string, Point>();

  /** 把一组子成员在父主题一侧纵向排开，整组以父主题的垂直中心对齐 */
  const place = (
    children: readonly LayoutMember[],
    side: TopicSide,
    parent: { x: number; y: number; node: Readonly<NodeEntity> }
  ): void => {
    const total =
      children.reduce((sum, child) => sum + heights.get(child.node.id)!, 0) + gap.y * Math.max(0, children.length - 1);
    let top = parent.y + parent.node.height / 2 - total / 2;
    for (const child of children) {
      const height = heights.get(child.node.id)!;
      const x = side === 'right' ? parent.x + parent.node.width + gap.x : parent.x - gap.x - child.node.width;
      const y = top + height / 2 - child.node.height / 2;
      positions.set(child.node.id, { x, y });
      place(child.children, side, { x, y, node: child.node });
      top += height + gap.y;
    }
  };

  const root = { x: 0, y: 0, node: tree.root.node };
  for (const side of ['right', 'left'] as const) {
    place(
      tree.root.children.filter((member) => sides.get(member.node.id) === side),
      side,
      root
    );
  }
  return positions;
}

/** 同一棵树的各条分支共用一次左右侧计算 (分支线来源按树批量推导) */
const sideCache = new WeakMap<LayoutTree, Map<string, TopicSide>>();

function branch(member: LayoutMember, tree: LayoutTree, themes: MindmapThemeRegistry): BranchSpec {
  const options = tree.options as MindmapOptions;
  const top = firstLevelOf(member)!;
  let sides = sideCache.get(tree);
  if (!sides) {
    sides = resolveSides(tree);
    sideCache.set(tree, sides);
  }
  const side = sides.get(member.node.id)!;
  const color = themes.lineColor(options.theme, tree.root.children.indexOf(top));
  return {
    router: LINE_ROUTERS[options.line],
    fromAnchor: side === 'right' ? { x: 1, y: 0.5 } : { x: 0, y: 0.5 },
    toAnchor: side === 'right' ? { x: 0, y: 0.5 } : { x: 1, y: 0.5 },
    style: { ...(color && { stroke: color }), strokeWidth: member.depth === 1 ? 3 : 2 }
  };
}

/** 改挂到同一张导图的另一个主题下 (排在其子主题最后) 时要写入的字段；不能挂到自身子树里 (返回 null) */
export function reattachTopic(
  member: LayoutMember,
  target: Readonly<NodeEntity>,
  tree: LayoutTree
): Partial<NodeEntity> | null {
  const targetMember = tree.get(target.id);
  if (!targetMember) return null;
  for (let ancestor: LayoutMember | undefined = targetMember; ancestor; ancestor = ancestor.parent) {
    if (ancestor === member) return null;
  }
  const last = targetMember.children.at(-1)?.node.zIndex ?? null;
  const { side: _side, ...item } = member.item;
  return {
    parentId: target.id,
    zIndex: generateKeyBetween(last, null),
    layoutItem: targetMember === tree.root ? { ...item, side: chooseSideForNewTopic(tree) } : item
  };
}

/** 导图布局：分支线颜色取自给定的主题注册表 (每个插件实例各有一份，可注册自定义主题) */
export function createMindmapLayout(themes: MindmapThemeRegistry): LayoutDefinition {
  return {
    id: MINDMAP_LAYOUT_ID,
    label: '思维导图',
    parseOptions: parseMindmapOptions,
    arrange,
    branch: (member, tree) => branch(member, tree, themes)
  };
}
