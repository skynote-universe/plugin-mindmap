/**
 * @file layout.ts
 * @description 思维导图布局：向内核注册的唯一布局，排版与展开方向交给所选结构 (见 structures.ts)
 *
 * 设计考量 (Why):
 * 1. 内核只认一个 'mindmap' 布局；结构 (双向、向右、组织结构图……) 是它的参数 layout.options.structure，
 *    主题、线型、间距等导图能力对所有结构通用。
 * 2. 纯函数：只读成员树与尺寸，返回各成员在根局部坐标中的位姿；写入由内核在同一事务内完成。
 * 3. 树边默认规格：从父主题朝展开方向的边中点出线，连到子主题朝向父主题的边中点；导图曲线沿出线方向切出
 *    (见 branch-router)；线型未单独设置时跟随结构的默认线型；颜色由导图主题决定 (见 themes.ts)。
 * 4. 参数都是有限的档位或注册表里的 id (结构、线型、间距、主题)：界面直接列出可选项，文档里也不会出现无法解释的数值。
 */

import type { LayoutEdgeSpec, LayoutDefinition, LayoutMember, LayoutTree, Point } from '@skynote/core';
import { MINDMAP_BRANCH_ROUTER } from './branch-router';
import { DEFAULT_MINDMAP_THEME, type MindmapThemeRegistry } from './themes';
import type { MindmapStructureRegistry } from './structures';

export const MINDMAP_LAYOUT_ID = 'mindmap';
export const DEFAULT_MINDMAP_STRUCTURE = 'both';

export type TopicSide = 'left' | 'right';
/** 子主题相对父主题展开的方向 */
export type Growth = 'right' | 'left' | 'down' | 'up';

/** 分支线型：导图曲线 / 直角折线 / 直线 */
export type MindmapLine = 'curve' | 'elbow' | 'straight';
/** 间距档位：父子与兄弟之间的距离 */
export type MindmapSpacing = 'compact' | 'standard' | 'loose';

/** 导图参数 (中心主题的 layout.options，经解析补齐默认值) */
export interface MindmapOptions extends Record<string, unknown> {
  /** 结构 id (见结构注册表)；可能是尚未注册的自定义结构 */
  structure: string;
  /** 单独设置的线型；未设置时跟随结构的默认线型 */
  line?: MindmapLine;
  spacing: MindmapSpacing;
  /** 导图主题：主题节点外观与分支线颜色 (见 themes.ts) */
  theme: string;
}

export const DEFAULT_MINDMAP_OPTIONS: Readonly<MindmapOptions> = Object.freeze({
  structure: DEFAULT_MINDMAP_STRUCTURE,
  spacing: 'standard',
  theme: DEFAULT_MINDMAP_THEME
});

/** 各档位的父子间距 (x，沿展开方向) 与兄弟间距 (y)；具体用法由结构决定 */
export const MINDMAP_SPACING: Record<MindmapSpacing, { readonly x: number; readonly y: number }> = {
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
const LINES: readonly MindmapLine[] = ['curve', 'elbow', 'straight'];

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** 展开方向是否纵向 */
export const isVerticalGrowth = (growth: Growth): boolean => growth === 'down' || growth === 'up';

/** 解析根节点的 layout.options (不可信输入)：非法项回落默认 */
export function parseMindmapOptions(raw: unknown): MindmapOptions {
  const options =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fallback = DEFAULT_MINDMAP_OPTIONS;
  const nonEmpty = (value: unknown, defaultValue: string) =>
    typeof value === 'string' && value.length > 0 ? value : defaultValue;
  return {
    // 结构与主题 id 原样保留 (可能是尚未注册的自定义项)：使用处查不到时按默认处理
    structure: nonEmpty(options.structure, fallback.structure),
    ...(LINES.includes(options.line as MindmapLine) && { line: options.line as MindmapLine }),
    spacing: pick(options.spacing, ['compact', 'standard', 'loose'], fallback.spacing),
    theme: nonEmpty(options.theme, fallback.theme)
  };
}

/** 成员所属的第一层分支 (根本身为 undefined) */
export function firstLevelOf(member: LayoutMember): LayoutMember | undefined {
  let current: LayoutMember | undefined = member;
  while (current?.parent?.parent) current = current.parent;
  return current?.parent ? current : undefined;
}

/** 父主题一端与子主题一端的连接点 (按宽高归一化)：父主题朝展开方向的边中点 → 子主题朝向父主题的边中点 */
export const EDGE_ANCHORS: Record<Growth, { from: Point; to: Point }> = {
  right: { from: { x: 1, y: 0.5 }, to: { x: 0, y: 0.5 } },
  left: { from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } },
  down: { from: { x: 0.5, y: 1 }, to: { x: 0.5, y: 0 } },
  up: { from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 } }
};

/**
 * 导图布局：排版与展开方向取自结构注册表，分支线颜色取自主题注册表
 * (每个插件实例各有一份，均可注册自定义项)
 */
export function createMindmapLayout(
  themes: MindmapThemeRegistry,
  structures: MindmapStructureRegistry
): LayoutDefinition {
  /** 同一棵树的各条分支共用一次展开方向计算 (分支线来源按树批量推导) */
  const growthCache = new WeakMap<LayoutTree, ReadonlyMap<string, Growth>>();
  return {
    id: MINDMAP_LAYOUT_ID,
    collapsible: true,
    selectableSubtree: true,
    footprint: 'subtree',
    supportsContentScale: false,
    label: '思维导图',
    parseOptions: parseMindmapOptions,
    arrange(tree) {
      const structure = structures.of(tree);
      return structure.arrange(tree, structure.gaps((tree.options as MindmapOptions).spacing));
    },
    edge(member: LayoutMember, tree: LayoutTree): LayoutEdgeSpec {
      const options = tree.options as MindmapOptions;
      const structure = structures.of(tree);
      let growth = growthCache.get(tree);
      if (!growth) {
        growth = structure.growth(tree);
        growthCache.set(tree, growth);
      }
      const anchors = EDGE_ANCHORS[growth.get(member.node.id)!];
      const color = themes.lineColor(options.theme, tree.root.children.indexOf(firstLevelOf(member)!));
      return {
        router: LINE_ROUTERS[options.line ?? structure.defaultLine],
        fromAnchor: anchors.from,
        toAnchor: anchors.to,
        style: { ...(color && { stroke: color }), strokeWidth: member.depth === 1 ? 3 : 2 }
      };
    }
  };
}
