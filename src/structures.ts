/**
 * @file structures.ts
 * @description 导图结构与结构注册表：一种结构规定子主题朝哪个方向展开、如何排列、兄弟与父子间距以及默认线型
 *
 * 设计考量 (Why):
 * 1. 内核只注册一个导图布局 (见 layout.ts)，结构是它的参数：主题、线型、间距、样式保留与分支线等导图能力
 *    对所有结构通用，切换结构只是改参数。
 * 2. 结构只需给出两件事：各主题相对父主题的展开方向 (growth) 与排版 (arrange)。拖动落点、方向键、删除后的顺延选中
 *    与树边连接点都按展开方向通用处理，新增结构不用改这些交互。
 * 3. 每种结构有默认线型 (双向用曲线、组织结构图用折线)：导图没有单独设置线型时跟随结构，切换结构即换成新结构的默认。
 * 4. 开放注册：内置结构与开发者注册的结构走同一个注册表；同 id 按注册顺序叠层，注销只撤掉自己那一层。
 *    定义在注册时校验，非法定义直接报错。文档里用了未注册的结构时保留其 id，暂按默认结构排版，注册后即恢复。
 */

import type { LayoutMember, LayoutPlacement, LayoutTree, NodeEntity, Point } from '@skynote/core';
import {
  DEFAULT_MINDMAP_STRUCTURE,
  MINDMAP_SPACING,
  isVerticalGrowth,
  type Growth,
  type MindmapLine,
  type MindmapOptions,
  type MindmapSpacing,
  type TopicSide
} from './layout';

/** 结构的间距：main 为父子之间 (沿展开方向)，cross 为兄弟之间 */
export interface MindmapGaps {
  readonly main: number;
  readonly cross: number;
}

/** 导图结构定义 */
export interface MindmapStructureDefinition {
  /** 全局唯一标识；自定义结构建议带前缀 (如 'acme:timeline')，与内置结构同 id 即覆盖 */
  readonly id: string;
  /** 界面显示的名称 */
  readonly label: string;
  /** 界面显示的说明 (图类，方向相近的结构带方向备注，如「逻辑图（右）」)；缺省显示名称。应简短 */
  readonly description?: string;
  /** 导图没有单独设置线型时使用的线型 */
  readonly defaultLine: MindmapLine;
  /** 各成员 (不含根) 相对父主题的展开方向 */
  growth(tree: LayoutTree): ReadonlyMap<string, Growth>;
  /** 中心主题的子主题可以朝哪些方向展开 (拖到中心主题附近时按位置选其一) */
  readonly rootGrowths: readonly Growth[];
  /** 各档位间距下的父子与兄弟间距 */
  gaps(spacing: MindmapSpacing): MindmapGaps;
  /** 排版纯函数：返回各成员在根局部坐标中的位姿 (见内核 LayoutDefinition.arrange) */
  arrange(tree: LayoutTree, gaps: MindmapGaps): ReadonlyMap<string, LayoutPlacement>;
  /**
   * 需要记住第一层主题在哪一侧的结构 (如双向) 给出：新的第一层主题应放在哪一侧，写入 layoutItem.side；
   * 不提供时第一层主题不记录侧
   */
  newChildSide?(tree: LayoutTree): TopicSide;
}

/** 一种结构的说明：名称与补充说明，供界面列出 */
export interface MindmapStructureInfo {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly defaultLine: MindmapLine;
}

const isSide = (value: unknown): value is TopicSide => value === 'left' || value === 'right';

// ================= 通用排版 =================

/** 子树在兄弟排列方向上占用的长度：自身与全部子树排开后的较大者 */
export function measureExtents(tree: LayoutTree, vertical: boolean, gap: number): Map<string, number> {
  const extents = new Map<string, number>();
  const size = (node: Readonly<NodeEntity>) => (vertical ? node.width : node.height);
  const measure = (member: LayoutMember): number => {
    const children = member.children.reduce((sum, child) => sum + measure(child), 0);
    const extent = Math.max(size(member.node), children + gap * Math.max(0, member.children.length - 1));
    extents.set(member.node.id, extent);
    return extent;
  };
  measure(tree.root);
  return extents;
}

/** 全部成员朝同一方向展开 */
function uniformGrowth(tree: LayoutTree, growth: Growth): Map<string, Growth> {
  const result = new Map<string, Growth>();
  const visit = (member: LayoutMember): void => {
    for (const child of member.children) {
      result.set(child.node.id, growth);
      visit(child);
    }
  };
  visit(tree.root);
  return result;
}

/**
 * 按展开方向排版：每组子成员在父主题的展开方向上排开，整组以父主题在兄弟排列方向上的中心对齐
 * (横向结构纵向排开，组织结构图横向排开)；同一父主题下不同方向的子主题分组各自排列
 */
export function arrangeByGrowth(
  tree: LayoutTree,
  growth: ReadonlyMap<string, Growth>,
  gaps: MindmapGaps
): Map<string, Point> {
  const verticalExtents = measureExtents(tree, true, gaps.cross);
  const horizontalExtents = measureExtents(tree, false, gaps.cross);
  const positions = new Map<string, Point>();

  const place = (
    children: readonly LayoutMember[],
    toward: Growth,
    parent: { x: number; y: number; node: Readonly<NodeEntity> }
  ): void => {
    const vertical = isVerticalGrowth(toward);
    const extents = vertical ? verticalExtents : horizontalExtents;
    const total =
      children.reduce((sum, child) => sum + extents.get(child.node.id)!, 0) +
      gaps.cross * Math.max(0, children.length - 1);
    const across = vertical ? parent.node.width : parent.node.height;
    let start = (vertical ? parent.x : parent.y) + across / 2 - total / 2;
    for (const child of children) {
      const extent = extents.get(child.node.id)!;
      const { width, height } = child.node;
      const point = vertical
        ? {
            x: start + extent / 2 - width / 2,
            y: toward === 'down' ? parent.y + parent.node.height + gaps.main : parent.y - gaps.main - height
          }
        : {
            x: toward === 'right' ? parent.x + parent.node.width + gaps.main : parent.x - gaps.main - width,
            y: start + extent / 2 - height / 2
          };
      positions.set(child.node.id, point);
      placeGroups(child, { ...point, node: child.node });
      start += extent + gaps.cross;
    }
  };

  const placeGroups = (member: LayoutMember, at: { x: number; y: number; node: Readonly<NodeEntity> }): void => {
    for (const toward of ['right', 'left', 'down', 'up'] as const) {
      const children = member.children.filter((child) => growth.get(child.node.id) === toward);
      if (children.length > 0) place(children, toward, at);
    }
  };
  placeGroups(tree.root, { x: 0, y: 0, node: tree.root.node });
  return positions;
}

// ================= 内置结构 =================

/**
 * 双向结构中第一层主题所在侧：用记录的一侧，没有记录的 (如大纲导入、外部文档) 按子树高度贪心分到较轻的一侧，
 * 结果确定、各端一致；子成员沿用其第一层祖先所在侧
 */
export function resolveSides(tree: LayoutTree, gapY: number): Map<string, TopicSide> {
  const heights = measureExtents(tree, false, gapY);
  const sides = new Map<string, TopicSide>();
  const load = { left: 0, right: 0 };
  const firstLevel = tree.root.children;
  for (const member of firstLevel) {
    if (!isSide(member.item.side)) continue;
    sides.set(member.node.id, member.item.side);
    load[member.item.side] += heights.get(member.node.id)!;
  }
  for (const member of firstLevel) {
    if (sides.has(member.node.id)) continue;
    const side: TopicSide = load.right <= load.left ? 'right' : 'left';
    sides.set(member.node.id, side);
    load[side] += heights.get(member.node.id)!;
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

const horizontalGaps = (spacing: MindmapSpacing): MindmapGaps => {
  const gap = MINDMAP_SPACING[spacing];
  return { main: gap.x, cross: gap.y };
};
/** 组织结构图兄弟沿横向排开：比纵向排列多留一些，主题之间不显得拥挤 */
const verticalGaps = (spacing: MindmapSpacing): MindmapGaps => {
  const gap = MINDMAP_SPACING[spacing];
  return { main: gap.x, cross: gap.y + 16 };
};

/** 双向：第一层主题分到左右两侧 (记住所在侧)，插入时放到较轻的一侧 */
const BOTH: MindmapStructureDefinition = {
  id: 'both',
  label: '双向',
  description: '思维导图',
  defaultLine: 'curve',
  rootGrowths: ['right', 'left'],
  growth: (tree) => resolveSides(tree, horizontalGaps(spacingOf(tree)).cross),
  gaps: horizontalGaps,
  arrange(tree, gaps) {
    return arrangeByGrowth(tree, resolveSides(tree, gaps.cross), gaps);
  },
  newChildSide(tree) {
    const gaps = horizontalGaps(spacingOf(tree));
    const heights = measureExtents(tree, false, gaps.cross);
    const sides = resolveSides(tree, gaps.cross);
    const load = { left: 0, right: 0 };
    for (const member of tree.root.children) load[sides.get(member.node.id)!] += heights.get(member.node.id)!;
    return load.right <= load.left ? 'right' : 'left';
  }
};

/** 全部朝一个方向展开的结构 */
function uniformStructure(
  id: string,
  label: string,
  growth: Growth,
  defaultLine: MindmapLine,
  description?: string
): MindmapStructureDefinition {
  const gaps = isVerticalGrowth(growth) ? verticalGaps : horizontalGaps;
  return {
    id,
    label,
    ...(description && { description }),
    defaultLine,
    rootGrowths: [growth],
    growth: (tree) => uniformGrowth(tree, growth),
    gaps,
    arrange: (tree, structureGaps) => arrangeByGrowth(tree, uniformGrowth(tree, growth), structureGaps)
  };
}

export const BUILT_IN_MINDMAP_STRUCTURES: readonly MindmapStructureDefinition[] = [
  BOTH,
  uniformStructure('right', '向右', 'right', 'curve', '逻辑图（右）'),
  uniformStructure('left', '向左', 'left', 'curve', '逻辑图（左）'),
  uniformStructure('down', '向下', 'down', 'elbow', '组织结构图（下）'),
  uniformStructure('up', '向上', 'up', 'elbow', '组织结构图（上）')
];

function spacingOf(tree: LayoutTree): MindmapSpacing {
  return (tree.options as MindmapOptions).spacing;
}

// ================= 注册表 =================

const LINES: readonly MindmapLine[] = ['curve', 'elbow', 'straight'];
const GROWTHS: readonly Growth[] = ['right', 'left', 'down', 'up'];

/** 注册时校验结构定义：开发者传入的数据，非法时直接报错 */
function assertDefinition(definition: MindmapStructureDefinition): void {
  const id = definition?.id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('[MindmapStructures] 结构定义缺少有效 id');
  if (typeof definition.label !== 'string' || definition.label.length === 0) {
    throw new Error(`[MindmapStructures] 结构 ${id} 缺少名称`);
  }
  if (!LINES.includes(definition.defaultLine)) {
    throw new Error(`[MindmapStructures] 结构 ${id} 的默认线型应为 ${LINES.join(' / ')}`);
  }
  const { rootGrowths } = definition;
  if (!Array.isArray(rootGrowths) || rootGrowths.length === 0 || !rootGrowths.every((g) => GROWTHS.includes(g))) {
    throw new Error(`[MindmapStructures] 结构 ${id} 的 rootGrowths 应为非空的展开方向列表`);
  }
  for (const method of ['growth', 'gaps', 'arrange'] as const) {
    if (typeof definition[method] !== 'function') throw new Error(`[MindmapStructures] 结构 ${id} 缺少 ${method}()`);
  }
}

export class MindmapStructureRegistry {
  /** id → 按注册顺序叠放的定义 (最后一层生效) */
  private readonly layers = new Map<string, MindmapStructureDefinition[]>();
  private readonly listeners = new Set<() => void>();

  constructor(structures: readonly MindmapStructureDefinition[] = []) {
    for (const structure of [...BUILT_IN_MINDMAP_STRUCTURES, ...structures]) this.add(structure);
  }

  /**
   * 注册结构 (同 id 即覆盖)
   * @returns 注销函数：只撤掉本次注册的这一层
   * @throws 定义不合法
   */
  register(definition: MindmapStructureDefinition): () => void {
    this.add(definition);
    this.notify();
    return () => {
      const stack = this.layers.get(definition.id);
      const index = stack?.lastIndexOf(definition) ?? -1;
      if (index < 0) return;
      stack!.splice(index, 1);
      if (stack!.length === 0) this.layers.delete(definition.id);
      this.notify();
    };
  }

  /** 结构定义；未注册时为默认结构 */
  get(id: string): MindmapStructureDefinition {
    return this.layers.get(id)?.at(-1) ?? this.layers.get(DEFAULT_MINDMAP_STRUCTURE)!.at(-1)!;
  }

  /** 导图所用的结构 */
  of(tree: LayoutTree): MindmapStructureDefinition {
    return this.get((tree.options as MindmapOptions).structure);
  }

  /** 结构集合变化 (注册或注销) */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 全部结构的说明 (内置在前，按注册顺序) */
  list(): MindmapStructureInfo[] {
    return [...this.layers.values()].map((stack) => {
      const { id, label, description, defaultLine } = stack.at(-1)!;
      return { id, label, ...(description && { description }), defaultLine };
    });
  }

  private add(definition: MindmapStructureDefinition): void {
    assertDefinition(definition);
    const stack = this.layers.get(definition.id);
    if (stack) stack.push(definition);
    else this.layers.set(definition.id, [definition]);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
