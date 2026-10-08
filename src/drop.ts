/**
 * @file drop.ts
 * @description 拖动主题的落点判定：找最近的主题，决定成为它的子主题还是插到它前后成为同级，并给出示意图形的位置
 *
 * 设计考量 (Why):
 * 1. 参考旧项目的手感：不要求指针压在主题上，被拖主题的外框靠近哪个主题就吸附到哪个；距离按外框间隙计算，
 *    兄弟排列方向上的间隙加权 (兄弟之间排得更密)，超出吸附距离即没有落点 (由插件决定脱离导图或放弃)。
 * 2. 以被拖主题朝向父主题的那条边的中点为探测点：越过目标的外侧边、或落在目标中段 → 子主题 (虚线占位框画在
 *    将要出现的位置)；落在目标两侧边缘 → 同级 (插入线画在目标之前或之后)。中心主题只能接收子主题。
 * 3. 按展开方向统一判定：沿展开方向 (main) 与兄弟排列方向 (cross) 读外框，任何结构 (含开发者注册的) 共用同一套规则；
 *    展开方向与间距取自导图所用的结构。
 * 4. 纯函数：只读成员树与世界外框，结果交给插件写入与绘制；跨导图拖动同样适用。
 */

import {
  generateKeyBetween,
  type LayoutMember,
  type LayoutTree,
  type NodeEntity,
  type Point,
  type RectBounds
} from '@skynote/core';
import { isVerticalGrowth, type Growth, type MindmapOptions, type TopicSide } from './layout';
import type { MindmapStructureRegistry } from './structures';

/** 落点：新的父主题、插入位置与示意图形 */
export interface TopicDrop {
  readonly tree: LayoutTree;
  readonly parent: LayoutMember;
  /** 插入到父主题子主题中的层级索引 */
  readonly zIndex: string;
  /** 横向双向时成为第一层主题所在的侧 */
  readonly side?: TopicSide;
  /** 子主题：将要出现的位置画虚线占位框；同级：在目标之前或之后画插入线 */
  readonly indicator:
    | { readonly kind: 'placeholder'; readonly bounds: RectBounds }
    | { readonly kind: 'line'; readonly from: Point; readonly to: Point };
}

/** 一个可吸附的候选主题 (不含被拖主题的子树) */
export interface DropCandidate {
  readonly tree: LayoutTree;
  readonly member: LayoutMember;
}

/** 兄弟排列方向上间隙的权重：兄弟之间排得比父子之间密，这个方向上稍远就不该吸附 */
const CROSS_GAP_WEIGHT = 1.3;
/** 探测点落在目标兄弟排列方向的中段 (此比例之内) 时视为成为子主题 */
const CHILD_BAND = 0.25;

type Axis = 'x' | 'y';
/** 展开方向对应的坐标轴：main 沿展开方向 (sign 为朝向)，cross 为兄弟排列方向 */
const AXES: Record<Growth, { readonly main: Axis; readonly cross: Axis; readonly sign: 1 | -1 }> = {
  right: { main: 'x', cross: 'y', sign: 1 },
  left: { main: 'x', cross: 'y', sign: -1 },
  down: { main: 'y', cross: 'x', sign: 1 },
  up: { main: 'y', cross: 'x', sign: -1 }
};

const lo = (b: RectBounds, axis: Axis): number => (axis === 'x' ? b.left : b.top);
const hi = (b: RectBounds, axis: Axis): number => (axis === 'x' ? b.right : b.bottom);
const mid = (b: RectBounds, axis: Axis): number => (lo(b, axis) + hi(b, axis)) / 2;
const size = (b: RectBounds, axis: Axis): number => hi(b, axis) - lo(b, axis);
/** 由两个轴上的坐标拼出点 */
const pointOf = (main: Axis, mainValue: number, crossValue: number): Point =>
  main === 'x' ? { x: mainValue, y: crossValue } : { x: crossValue, y: mainValue };

/**
 * 判定落点
 * @param ghost 被拖主题当前的世界外框 (随指针平移后)
 * @param snapDistance 吸附距离 (世界单位)
 * @param boundsOf 主题的世界外框
 * @param structures 结构注册表 (取各导图的展开方向与间距)
 * @returns 没有足够近的主题时为 null
 */
export function resolveTopicDrop(
  dragged: LayoutMember,
  ghost: RectBounds,
  candidates: readonly DropCandidate[],
  snapDistance: number,
  boundsOf: (member: LayoutMember) => RectBounds,
  structures: MindmapStructureRegistry
): TopicDrop | null {
  let closest: { candidate: DropCandidate; bounds: RectBounds; distance: number } | null = null;
  for (const candidate of candidates) {
    const bounds = boundsOf(candidate.member);
    const vertical = isVerticalGrowth(structures.of(candidate.tree).rootGrowths[0]);
    const gapX = Math.max(0, bounds.left - ghost.right, ghost.left - bounds.right);
    const gapY = Math.max(0, bounds.top - ghost.bottom, ghost.top - bounds.bottom);
    const distance = vertical ? Math.hypot(gapX * CROSS_GAP_WEIGHT, gapY) : Math.hypot(gapX, gapY * CROSS_GAP_WEIGHT);
    if (distance <= snapDistance && (!closest || distance < closest.distance)) {
      closest = { candidate, bounds, distance };
    }
  }
  if (!closest) return null;

  const { tree, member: target } = closest.candidate;
  const targetBounds = closest.bounds;
  const structure = structures.of(tree);
  const gaps = structure.gaps((tree.options as MindmapOptions).spacing);
  const growthOf = structure.growth(tree);
  // 中心主题：在它的子主题可展开的方向里，取最朝向被拖主题的一个
  const offset = { x: mid(ghost, 'x') - mid(targetBounds, 'x'), y: mid(ghost, 'y') - mid(targetBounds, 'y') };
  const facing = (g: Growth): number => {
    const { main, sign } = AXES[g];
    return sign * (main === 'x' ? offset.x : offset.y);
  };
  const growth: Growth =
    target !== tree.root
      ? growthOf.get(target.node.id)!
      : structure.rootGrowths.reduce((best, g) => (facing(g) > facing(best) ? g : best));
  const { main, cross, sign } = AXES[growth];
  // 探测点：被拖主题朝向父主题的那条边的中点
  const probe = { main: sign > 0 ? lo(ghost, main) : hi(ghost, main), cross: mid(ghost, cross) };
  // 需要记住所在侧的结构 (如双向)：成为第一层主题时写入侧
  const sideOf = (parent: LayoutMember): TopicSide | undefined =>
    parent === tree.root && structure.newChildSide && (growth === 'left' || growth === 'right') ? growth : undefined;

  const beyondOuterEdge = sign > 0 ? probe.main >= hi(targetBounds, main) : probe.main <= lo(targetBounds, main);
  const inMiddleBand = Math.abs(probe.cross - mid(targetBounds, cross)) <= size(targetBounds, cross) * CHILD_BAND;
  if (target === tree.root || beyondOuterEdge || inMiddleBand) {
    // 子主题：排在同方向已有子主题之后，占位框画在它将要出现的位置
    const siblings = target.children.filter(
      (child) => child !== dragged && (target !== tree.root || growthOf.get(child.node.id) === growth)
    );
    const last = siblings.at(-1);
    const lastBounds = last && boundsOf(last);
    const mainSize = size(ghost, main);
    const crossSize = size(ghost, cross);
    const mainStart =
      sign > 0
        ? lastBounds
          ? lo(lastBounds, main)
          : hi(targetBounds, main) + gaps.main
        : (lastBounds ? hi(lastBounds, main) : lo(targetBounds, main) - gaps.main) - mainSize;
    const crossStart = lastBounds ? hi(lastBounds, cross) + gaps.cross : mid(targetBounds, cross) - crossSize / 2;
    const from = pointOf(main, mainStart, crossStart);
    const to = pointOf(main, mainStart + mainSize, crossStart + crossSize);
    const allChildren = target.children.filter((child) => child !== dragged);
    const side = sideOf(target);
    return {
      tree,
      parent: target,
      zIndex: generateKeyBetween(allChildren.at(-1)?.node.zIndex ?? null, null),
      ...(side && { side }),
      indicator: { kind: 'placeholder', bounds: { left: from.x, top: from.y, right: to.x, bottom: to.y } }
    };
  }

  // 同级：插到目标之前 (探测点在兄弟排列方向上靠前) 或之后
  const parent = target.parent!;
  const siblings = parent.children.filter((child) => child !== dragged);
  const index = siblings.indexOf(target);
  const before = probe.cross < mid(targetBounds, cross);
  const zIndex = before
    ? generateKeyBetween(siblings[index - 1]?.node.zIndex ?? null, target.node.zIndex)
    : generateKeyBetween(target.node.zIndex, siblings[index + 1]?.node.zIndex ?? null);
  const at = before ? lo(targetBounds, cross) - gaps.cross / 2 : hi(targetBounds, cross) + gaps.cross / 2;
  const side = sideOf(parent);
  return {
    tree,
    parent,
    zIndex,
    ...(side && { side }),
    indicator: {
      kind: 'line',
      from: pointOf(main, lo(targetBounds, main), at),
      to: pointOf(main, hi(targetBounds, main), at)
    }
  };
}

/** 落点就是被拖主题现在的位置 (同一父主题、同侧、前后邻居不变)：不必写入 */
export function isSamePlace(dragged: LayoutMember, drop: TopicDrop): boolean {
  const parent = dragged.parent;
  if (!parent || parent.node.id !== drop.parent.node.id) return false;
  if (drop.side !== undefined && drop.side !== dragged.item.side) return false;
  const index = parent.children.indexOf(dragged);
  const prev = parent.children[index - 1]?.node.zIndex;
  const next = parent.children[index + 1]?.node.zIndex;
  return (prev === undefined || drop.zIndex > prev) && (next === undefined || drop.zIndex < next);
}

/** 落到 drop 时被拖主题要写入的字段：改挂父主题、层级与成员标记 (横向双向的第一层记录所在侧，其余不记) */
export function topicDropFields(dragged: LayoutMember, drop: TopicDrop): Partial<NodeEntity> {
  const { side: _side, ...item } = dragged.item;
  return {
    parentId: drop.parent.node.id,
    zIndex: drop.zIndex,
    layoutItem: drop.side ? { ...item, side: drop.side } : item
  };
}
