/**
 * @file structure-preview.ts
 * @description 结构示意图：用结构自己的展开方向与排版，把一棵小样例树排出来，给界面画预览卡片
 *
 * 设计考量 (Why):
 * 示意图不是手画的：直接调用结构的 growth / arrange，所以开发者注册的结构也自动有准确的示意图，
 * 结构的排版改了示意图随之变。界面只按给出的方框与路径作画，不需要知道任何结构。
 */

import { buildLayoutTree, type NodeEntity, type Point, type RectBounds } from '@skynote/core';
import { EDGE_ANCHORS, parseMindmapOptions, type Growth, type MindmapLine } from './layout';
import type { MindmapStructureDefinition } from './structures';

/** 示意图：方框 (中心主题标记为 root) 与树边路径，坐标在 bounds 范围内 */
export interface MindmapStructurePreview {
  readonly boxes: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly root: boolean;
  }[];
  /** SVG 路径指令 (绝对坐标) */
  readonly lines: readonly string[];
  readonly bounds: RectBounds;
}

const ROOT_SIZE = { width: 36, height: 14 };
const TOPIC_SIZE = { width: 24, height: 9 };
/** 样例树：中心主题下四个主题，两级就足以看出展开方向与对齐 (双向时左右各两个)，卡片里也更清爽 */
const SAMPLE: readonly { readonly id: string; readonly parentId?: string }[] = [
  { id: 'root' },
  { id: 'a', parentId: 'root' },
  { id: 'b', parentId: 'root' },
  { id: 'c', parentId: 'root' },
  { id: 'd', parentId: 'root' }
];
/** 样例的间距：比真实间距紧凑，卡片里看得清整体形状 */
const SAMPLE_GAPS = { main: 14, cross: 5 };

function sampleNode(id: string, parentId: string | undefined, structure: string, index: number): NodeEntity {
  const size = parentId === undefined ? ROOT_SIZE : TOPIC_SIZE;
  return {
    id,
    type: 'node',
    nodeType: 'shape',
    x: 0,
    y: 0,
    ...size,
    rotation: 0,
    zIndex: `a${index}`,
    locked: false,
    ...(parentId === undefined ? { layout: { type: 'mindmap', options: { structure } } } : { parentId, layoutItem: {} })
  };
}

/** 树边路径：按线型画曲线 (沿出线方向切出)、直角折线或直线 */
function edgePath(a: Point, b: Point, growth: Growth, line: MindmapLine): string {
  const vertical = growth === 'down' || growth === 'up';
  if (line === 'straight') return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  if (line === 'elbow') {
    return vertical
      ? `M ${a.x} ${a.y} L ${a.x} ${(a.y + b.y) / 2} L ${b.x} ${(a.y + b.y) / 2} L ${b.x} ${b.y}`
      : `M ${a.x} ${a.y} L ${(a.x + b.x) / 2} ${a.y} L ${(a.x + b.x) / 2} ${b.y} L ${b.x} ${b.y}`;
  }
  return vertical
    ? `M ${a.x} ${a.y} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${(a.y + b.y) / 2}, ${b.x} ${b.y}`
    : `M ${a.x} ${a.y} C ${(a.x + b.x) / 2} ${a.y}, ${(a.x + b.x) / 2} ${b.y}, ${b.x} ${b.y}`;
}

/** 用结构排出样例树的示意图 */
export function previewStructure(structure: MindmapStructureDefinition): MindmapStructurePreview {
  const nodes = SAMPLE.map(({ id, parentId }, index) => sampleNode(id, parentId, structure.id, index));
  const childrenOf = (parentId: string) => nodes.filter((node) => node.parentId === parentId);
  const tree = buildLayoutTree(nodes[0], childrenOf, {
    id: 'mindmap',
    label: '',
    parseOptions: parseMindmapOptions,
    arrange: () => new Map()
  });
  const placements = structure.arrange(tree, SAMPLE_GAPS);
  const growth = structure.growth(tree);
  const boxOf = (node: NodeEntity) => {
    const at = placements.get(node.id) ?? { x: 0, y: 0 };
    return { x: at.x, y: at.y, width: node.width, height: node.height, root: node.parentId === undefined };
  };
  const boxes = nodes.map(boxOf);
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.parentId === undefined) continue;
    const parent = boxes[nodes.findIndex((n) => n.id === node.parentId)];
    const child = boxes[nodes.indexOf(node)];
    const direction = growth.get(node.id) ?? 'right';
    const { from, to } = EDGE_ANCHORS[direction];
    lines.push(
      edgePath(
        { x: parent.x + from.x * parent.width, y: parent.y + from.y * parent.height },
        { x: child.x + to.x * child.width, y: child.y + to.y * child.height },
        direction,
        structure.defaultLine
      )
    );
  }
  const bounds = boxes.reduce(
    (b, box) => ({
      left: Math.min(b.left, box.x),
      top: Math.min(b.top, box.y),
      right: Math.max(b.right, box.x + box.width),
      bottom: Math.max(b.bottom, box.y + box.height)
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
  );
  return { boxes, lines, bounds };
}
