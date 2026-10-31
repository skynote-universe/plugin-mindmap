import { describe, expect, it } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  applyMatrix,
  computeNodeWorldBounds,
  invertMatrix,
  multiplyMatrix,
  unionBounds,
  type RectBounds,
  type Point
} from '@skynote/core';
import { BasicNodesPlugin, SelectionPlugin, setFrameAutoLayout, computeStackInsertIndex } from '@skynote/plugins-basic';
import { MindmapPlugin } from '../src/plugin';

function setup() {
  const mindmap = new MindmapPlugin();
  const engine = new SkyNoteEngine({ fonts: { measureWidth: (text, font) => (text.length * font.size) / 2 } })
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(mindmap);
  return { engine, store: engine.documentStore, mindmap };
}
function createMap(context: ReturnType<typeof setup>, point: Point, structure: string) {
  const { mindmap, engine } = context;
  const root = mindmap.createMindmap(point)!;
  const first = mindmap.insertChild(root)!;
  const second = mindmap.insertChild(root)!;
  mindmap.insertChild(first);
  mindmap.setOptions(root, { structure });
  engine.session.setTextEditing(null);
  return { root, first, second };
}
/** 从实际世界矩阵独立合并几何，避免用待验证的占位查询生成预期值。 */
function bounds(context: ReturnType<typeof setup>, root: string, parent?: string): RectBounds {
  const { engine, store } = context;
  const inverse = parent ? invertMatrix(engine.entityStore.getWorldTransform(parent)!) : undefined;
  const ids = [root, ...engine.entityStore.collectDescendantIds(root)];
  return ids
    .map((id) => {
      const world = engine.entityStore.getWorldTransform(id)!;
      return computeNodeWorldBounds(store.getNode(id)!, inverse ? multiplyMatrix(inverse, world) : world);
    })
    .reduce(unionBounds);
}
function frameCase(direction: 'horizontal' | 'vertical', structure = 'both', rotation = 0) {
  const context = setup();
  const { engine, store } = context;
  const frame = store.createNode({
    nodeType: 'frame',
    x: 100,
    y: 100,
    width: 2000,
    height: 2000,
    rotation,
    autoWrap: false
  })!;
  const map = createMap(context, { x: 400, y: 400 }, structure);
  store.reparentNodes([map.root], frame);
  const card = store.createNode({ nodeType: 'shape', parentId: frame, x: 1000, y: 1000, width: 120, height: 80 })!;
  return { ...context, frame, card, map, direction, engine };
}
function checkHug(context: ReturnType<typeof frameCase>) {
  const { store, frame, card, map, direction } = context;
  const boxes = [bounds(context, map.root, frame), bounds(context, card, frame)];
  const horizontal = direction === 'horizontal';
  boxes.sort((a, b) => (horizontal ? a.left - b.left : a.top - b.top));
  const [first, last] = boxes;
  expect(horizontal ? first.left : first.top).toBeCloseTo(24, 5);
  expect(horizontal ? last.left - first.right : last.top - first.bottom).toBeCloseTo(20, 5);
  for (const box of boxes) expect(horizontal ? box.top : box.left).toBeCloseTo(24, 5);
  const expectedWidth =
    (horizontal
      ? boxes.reduce((sum, b) => sum + b.right - b.left, 20)
      : Math.max(...boxes.map((b) => b.right - b.left))) + 48;
  const expectedHeight =
    (horizontal
      ? Math.max(...boxes.map((b) => b.bottom - b.top))
      : boxes.reduce((sum, b) => sum + b.bottom - b.top, 20)) + 48;
  expect(store.getNode(frame)!.width).toBeCloseTo(expectedWidth, 5);
  expect(store.getNode(frame)!.height).toBeCloseTo(expectedHeight, 5);
}

describe('脑图自动排列与容器占位', () => {
  it.each(['both', 'left', 'up'])('编组完整包裹%s脑图，分支变化同步边界，嵌套编组及尺寸命令均不能缩放', (structure) => {
    const context = setup();
    const { engine, store } = context;
    try {
      const map = createMap(context, { x: 400, y: 400 }, structure);
      const card = store.createNode({ nodeType: 'shape', x: 1000, y: 1000, width: 100, height: 80 })!;
      const group = store.groupNodes([map.root, card])!;
      const check = () => {
        const content = unionBounds(bounds(context, map.root, group), bounds(context, card, group));
        const g = store.getNode(group)!;
        expect(content.left).toBeGreaterThanOrEqual(-1e-6);
        expect(content.top).toBeGreaterThanOrEqual(-1e-6);
        expect(content.right).toBeLessThanOrEqual(g.width + 1e-6);
        expect(content.bottom).toBeLessThanOrEqual(g.height + 1e-6);
        expect(store.getNodeResizePolicy(group).axes).toBe('none');
      };
      check();
      store.updateNode(map.first, { width: 1000 });
      check();
      store.undo();
      check();
      const before = { ...store.getNode(group)! };
      store.resizeNodes([group], { width: before.width * 2, height: before.height * 2 });
      expect(store.getNode(group)).toEqual(before);
      const extra = store.createNode({ nodeType: 'shape', x: 1400, y: 1200 })!;
      const outer = store.groupNodes([group, extra])!;
      expect(store.getNodeResizePolicy(outer).axes).toBe('none');
    } finally {
      engine.destroy();
    }
  });

  it.each(['both', 'left', 'up'].flatMap((structure) => [0, 37].map((rotation) => ({ structure, rotation }))))(
    '自由容器适应整张脑图：$structure，容器旋转$rotation，保留世界位置及根尺寸',
    ({ structure, rotation }) => {
      const context = frameCase('horizontal', structure, rotation);
      const { engine, store, frame, map, card } = context;
      try {
        const initial = unionBounds(bounds(context, map.root, frame), bounds(context, card, frame));
        const root = { ...store.getNode(map.root)! };
        const before = bounds(context, map.root);
        const frameBefore = { ...store.getNode(frame)! };
        expect(store.canFitContent(frame)).toBe(true);
        expect(store.fitContent([frame])).not.toBeNull();
        expect(store.getNode(frame)).toMatchObject({
          width: Math.ceil(initial.right) - Math.floor(initial.left) + 48,
          height: Math.ceil(initial.bottom) - Math.floor(initial.top) + 48
        });
        const inside = bounds(context, map.root, frame);
        const f = store.getNode(frame)!;
        expect(inside.left).toBeGreaterThanOrEqual(24 - 1e-6);
        expect(inside.top).toBeGreaterThanOrEqual(24 - 1e-6);
        expect(inside.right).toBeLessThanOrEqual(f.width - 24 + 1e-6);
        expect(inside.bottom).toBeLessThanOrEqual(f.height - 24 + 1e-6);
        const after = bounds(context, map.root);
        for (const key of ['left', 'top', 'right', 'bottom'] as const)
          expect(Math.abs(after[key] - before[key])).toBeLessThan(1);
        expect(store.getNode(map.root)).toMatchObject({ width: root.width, height: root.height });
        expect(store.fitContent([frame])).toBeNull();
        store.undo();
        expect(store.getNode(frame)).toEqual(frameBefore);
        expect(store.getNode(map.root)).toEqual(root);
        store.redo();
        expect(bounds(context, map.root)).toEqual(after);
      } finally {
        engine.destroy();
      }
    }
  );

  it('不参与脑图排版的普通后代变化也会更新外层容器占位', () => {
    const context = frameCase('horizontal', 'both');
    const { engine, store, frame, map } = context;
    try {
      setFrameAutoLayout(store, engine.entityStore, [frame], { direction: 'horizontal', gap: 20, padding: 24 });
      const rootWidth = store.getNode(map.root)!.width;
      const extra = store.createNode({
        nodeType: 'shape',
        parentId: map.first,
        x: -800,
        y: -700,
        width: 120,
        height: 80
      })!;
      expect(store.getNode(extra)!.layoutItem).toBeUndefined();
      checkHug(context);
      store.updateNode(extra, { x: -950, width: 500, height: 300 });
      checkHug(context);
      store.removeEntities({ nodeIds: [extra] });
      checkHug(context);
      expect(store.getNode(map.root)!.width).toBe(rootWidth);
    } finally {
      engine.destroy();
    }
  });
  it.each([0, 37])('自动排列始终使用整图包围框，与主题级选区无关，保留根尺寸及旋转 %s', (rotation) => {
    const context = setup();
    const { engine, store } = context;
    try {
      const first = createMap(context, { x: 200, y: 300 }, 'both');
      const second = createMap(context, { x: 400, y: 600 }, 'up');
      store.updateNode(first.root, { rotation });
      const roots = [first.root, second.root];
      engine.session.setSelection({ nodeIds: roots });
      expect(engine.session.selectedSubtreeNodeIds.size).toBe(0);
      const before = structuredClone(store.getView().content);
      store.clearHistory();
      expect(store.autoArrangeNodes(roots)).not.toBeNull();
      const boxes = roots.map((root) => bounds(context, root)).sort((a, b) => a.left - b.left);
      expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes[1].left - boxes[0].right - 20)).toBeLessThanOrEqual(1);
      for (const root of roots)
        expect(store.getNode(root)).toMatchObject({
          width: before.nodes[root].width,
          height: before.nodes[root].height,
          rotation: before.nodes[root].rotation
        });
      const after = structuredClone(store.getView().content);
      store.undo();
      expect(store.getView().content).toEqual(before);
      store.redo();
      expect(store.getView().content).toEqual(after);
      if (rotation === 0) expect(store.autoArrangeNodes(roots)).toBeNull();
    } finally {
      engine.destroy();
    }
  });

  it.each([
    ['horizontal', 'both', 0],
    ['vertical', 'both', 0],
    ['horizontal', 'left', 0],
    ['vertical', 'up', 0],
    ['horizontal', 'both', 37],
    ['vertical', 'up', 37]
  ] as const)('%s 容器容纳 %s 脑图（容器旋转%s），补偿负偏移并随成员尺寸更新', (direction, structure, rotation) => {
    const context = frameCase(direction, structure, rotation);
    const { engine, store, frame, map } = context;
    try {
      const before = structuredClone(store.getView().content);
      const root = { ...store.getNode(map.root)! };
      store.clearHistory();
      setFrameAutoLayout(store, engine.entityStore, [frame], { direction, gap: 20, padding: 24 });
      checkHug(context);
      expect(store.getNode(map.root)).toMatchObject({ width: root.width, height: root.height, rotation: 0 });
      expect(JSON.stringify(store.getView())).not.toContain('footprint');
      const after = structuredClone(store.getView().content);
      store.undo();
      expect(store.getView().content).toEqual(before);
      store.redo();
      expect(store.getView().content).toEqual(after);
      store.updateNode(map.first, { width: 600 });
      checkHug(context);
      store.removeEntities({ nodeIds: [map.first] });
      checkHug(context);
    } finally {
      engine.destroy();
    }
  });

  it.each(['horizontal', 'vertical'] as const)('%s 固定容器按整图居中与两端对齐', (direction) => {
    const context = frameCase(direction, direction === 'horizontal' ? 'up' : 'left');
    const { engine, store, frame, card, map } = context;
    try {
      setFrameAutoLayout(store, engine.entityStore, [frame], {
        direction,
        gap: 20,
        padding: 24,
        widthSizing: 'fixed',
        heightSizing: 'fixed',
        align: 'center',
        justify: 'space-between'
      });
      const boxes = [bounds(context, map.root, frame), bounds(context, card, frame)];
      const f = store.getNode(frame)!;
      if (direction === 'horizontal') {
        boxes.sort((a, b) => a.left - b.left);
        expect(boxes[0].left).toBeCloseTo(24, 5);
        expect(boxes[1].right).toBeCloseTo(f.width - 24, 5);
        for (const b of boxes) expect((b.top + b.bottom) / 2).toBeCloseTo(f.height / 2, 5);
      } else {
        boxes.sort((a, b) => a.top - b.top);
        expect(boxes[0].top).toBeCloseTo(24, 5);
        expect(boxes[1].bottom).toBeCloseTo(f.height - 24, 5);
        for (const b of boxes) expect((b.left + b.right) / 2).toBeCloseTo(f.width / 2, 5);
      }
    } finally {
      engine.destroy();
    }
  });

  it('拖拽插入阈值使用整图中心，容器中的实际拖拽保持正确顺序', () => {
    const context = frameCase('horizontal', 'left');
    const { engine, store, frame, card, map } = context;
    try {
      store.updateNode(card, { x: 0, y: 0 });
      setFrameAutoLayout(store, engine.entityStore, [frame], { direction: 'horizontal', gap: 20, padding: 24 });
      const root = store.getNode(map.root)!;
      const footprint = store.selectionGeometry.getSubtreeLocalBounds(map.root)!;
      const fullCenter = root.x + (footprint.left + footprint.right) / 2;
      const nodeCenter = root.x + root.width / 2;
      const point = { x: (fullCenter + nodeCenter) / 2, y: root.y + footprint.bottom + 10 };
      expect(computeStackInsertIndex(store.getNode(frame)!, [root], point)).toBe(0);
      expect(computeStackInsertIndex(store.getNode(frame)!, [root], point, () => footprint)).toBe(1);
      const c = store.getNode(card)!;
      const matrix = engine.entityStore.getWorldTransform(frame)!;
      const from = applyMatrix(matrix, c.x + c.width / 2, c.y + c.height / 2);
      const to = applyMatrix(matrix, point.x, point.y);
      for (const [phase, position] of [
        ['down', from],
        ['move', to],
        ['up', to]
      ] as const) {
        const event = new SyntheticPointerEvent({ point: position, target: engine.hitTestNode(position) });
        if (phase === 'down') engine.pointer.dispatchPointerDown(event);
        else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
        else engine.pointer.dispatchPointerUp(event);
      }
      expect(store.getNode(card)!.parentId).toBe(frame);
      const b = bounds(context, map.root, frame),
        other = bounds(context, card, frame);
      expect(other.left - b.right).toBeCloseTo(20, 5);
    } finally {
      engine.destroy();
    }
  });
});
