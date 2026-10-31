import { expect, it } from 'vitest';
import { SkyNoteEngine, SyntheticPointerEvent, type CanvasPrimitive, type Point } from '@skynote/core';
import {
  BasicNodesPlugin,
  EditingShortcutsPlugin,
  BranchConnectorsPlugin,
  SelectionPlugin,
  SelectionOutlinePlugin,
  TransformPlugin
} from '@skynote/plugins-basic';
import { MindmapPlugin } from '../src/plugin';

function setup() {
  const mindmap = new MindmapPlugin();
  const engine = new SkyNoteEngine({ fonts: { measureWidth: (text, font) => (text.length * font.size) / 2 } })
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new EditingShortcutsPlugin())
    .use(new SelectionOutlinePlugin())
    .use(new TransformPlugin())
    .use(new BranchConnectorsPlugin())
    .use(mindmap);
  const overlays = new Map<string, readonly CanvasPrimitive[]>();
  engine.attachHost({
    overlay: {
      setPrimitives: (id, primitives) => {
        overlays.set(id, primitives);
      },
      clear: (id) => {
        overlays.delete(id);
      }
    },
    setCursor() {},
    capturePointer() {},
    releasePointer() {},
    openTextInput: () => ({ setCaretRect() {}, focus() {}, close() {} })
  });
  const rootId = mindmap.createMindmap({ x: 80, y: 28 })!;
  const childId = mindmap.insertChild(rootId)!;
  engine.session.setTextEditing(null);
  const rootBounds = engine.getNodeWorldBounds(rootId)!;
  const blank = { x: rootBounds.right + 35, y: rootBounds.top + 5 };
  return { engine, mindmap, rootId, childId, overlays, blank };
}
it('整图混选框的空白可拖动整体，保持脑图范围与成员局部坐标并一步撤销', () => {
  const { engine, rootId, childId } = setup();
  try {
    const store = engine.documentStore;
    const card = store.createNode({ nodeType: 'shape', x: 900, y: 500, width: 80, height: 60 })!;
    engine.session.setSelection({ nodeIds: [rootId, card], subtreeNodeIds: [rootId] });
    const root = { ...store.getNode(rootId)! };
    const child = { ...store.getNode(childId)! };
    const from = { x: 700, y: 300 };
    expect(engine.hitTest(from)).toBeNull();
    click(engine, from);
    expect(engine.session.selectedNodeIds.size).toBe(0);
    expect(engine.session.selectedSubtreeNodeIds.size).toBe(0);
    engine.session.setSelection({ nodeIds: [rootId, card], subtreeNodeIds: [rootId] });
    pointer(engine, 'down', from);
    pointer(engine, 'move', { x: 730, y: 340 });
    pointer(engine, 'up', { x: 730, y: 340 });
    expect(store.getNode(rootId)).toMatchObject({ x: root.x + 30, y: root.y + 40 });
    expect(store.getNode(card)).toMatchObject({ x: 930, y: 540 });
    expect(store.getNode(childId)).toEqual(child);
    expect([...engine.session.selectedSubtreeNodeIds]).toEqual([rootId]);
    store.undo();
    expect(store.getNode(rootId)).toEqual(root);
    expect(store.getNode(card)).toMatchObject({ x: 900, y: 500 });
  } finally {
    engine.destroy();
  }
});

it('多选整图和普通节点始终显示总外框，不能整体缩放时仅隐藏控制柄', () => {
  const { engine, rootId, childId, overlays } = setup();
  try {
    const store = engine.documentStore;
    const card = store.createNode({ nodeType: 'shape', x: 900, y: 500, width: 80, height: 60 })!;
    engine.session.setSelection({ nodeIds: [rootId, card], subtreeNodeIds: [rootId] });
    const checkBounds = () => {
      const map = store.selectionGeometry.getSubtreeBounds(rootId)!;
      const node = engine.getNodeWorldBounds(card)!;
      expect(overlays.get('selection:outline')!.at(-1)).toMatchObject({
        kind: 'rect',
        x: Math.min(map.left, node.left),
        y: Math.min(map.top, node.top),
        width: Math.max(map.right, node.right) - Math.min(map.left, node.left),
        height: Math.max(map.bottom, node.bottom) - Math.min(map.top, node.top)
      });
      expect(overlays.get('transform:handles')?.length ?? 0).toBe(0);
    };
    checkBounds();
    store.updateNode(childId, { width: 1200 });
    checkBounds();
    store.undo();
    checkBounds();
    engine.session.setViewport({ ...engine.session.viewport, zoom: 2 });
    expect(overlays.get('selection:outline')!.at(-1)).toMatchObject({ strokeWidth: 0.5 });
    engine.session.setSelection({ nodeIds: [rootId, card] });
    expect(overlays.get('selection:outline')!.at(-1)!.kind).toBe('rect');
    expect(overlays.get('transform:handles')!.length).toBeGreaterThan(0);
    store.updateNodes([rootId, card], { locked: true });
    expect(engine.session.selectedNodeIds.size).toBe(0);
    expect(overlays.get('transform:handles')?.length ?? 0).toBe(0);
    engine.session.setSelection({ nodeIds: [card] });
    expect(overlays.get('selection:outline')).toHaveLength(1);
  } finally {
    engine.destroy();
  }
});

it('快捷键取消编组后脑图恢复整体范围，完整外框和不可缩放约束同时恢复', () => {
  const { engine, rootId, overlays } = setup();
  try {
    const store = engine.documentStore;
    const card = store.createNode({ nodeType: 'shape', x: 900, y: 500 })!;
    const group = store.groupNodes([rootId, card])!;
    engine.session.setSelection({ nodeIds: [group] });
    engine.inputScopes.dispatchKeyDown({
      key: 'G',
      code: 'KeyG',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault() {},
      stopPropagation() {}
    });
    expect(engine.session.selectedSubtreeNodeIds.has(rootId)).toBe(true);
    expect(overlays.get('selection:outline')![0]).toMatchObject({ kind: 'rect' });
    expect(overlays.get('transform:handles')?.length ?? 0).toBe(0);
    expect(store.getNode(rootId)!.parentId).toBeUndefined();
  } finally {
    engine.destroy();
  }
});

function pointer(engine: SkyNoteEngine, phase: 'down' | 'move' | 'up', point: Point) {
  const event = new SyntheticPointerEvent({ point, target: engine.hitTestNode(point) });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}
function click(engine: SkyNoteEngine, point: Point) {
  pointer(engine, 'down', point);
  pointer(engine, 'up', point);
}

function center(engine: SkyNoteEngine, id: string): Point {
  const b = engine.getNodeWorldBounds(id)!;
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

it('空白、根主题、子主题及内部连线之间悬停时范围框保留，并独立显示主题高亮', () => {
  const { engine, rootId, childId, overlays, blank } = setup();
  try {
    engine.session.setSelection({ nodeIds: [], connectorIds: [] });
    pointer(engine, 'move', blank);
    const outer = overlays.get('selection:subtree-hover')!;
    expect(outer[0]).toMatchObject({ kind: 'rect', strokeOpacity: 0.45, strokeDashArray: [4, 3] });
    pointer(engine, 'move', center(engine, rootId));
    expect(overlays.get('selection:subtree-hover')).toBe(outer);
    expect(overlays.get('selection:hover')![0].kind).toBe('polygon');
    pointer(engine, 'move', center(engine, childId));
    expect(overlays.get('selection:subtree-hover')).toBe(outer);
    expect(overlays.get('selection:hover')![0].kind).toBe('polygon');
    const root = engine.getNodeWorldBounds(rootId)!;
    const line = { x: root.right + 20, y: (root.top + root.bottom) / 2 };
    expect(engine.hitTest(line)?.kind).toBe('connector');
    pointer(engine, 'move', line);
    expect(overlays.get('selection:subtree-hover')).toBe(outer);
    expect(overlays.has('selection:hover')).toBe(false);
    const b = engine.documentStore.selectionGeometry.getSubtreeBounds(rootId)!;
    pointer(engine, 'move', { x: b.right + 100, y: b.bottom + 100 });
    expect(overlays.has('selection:subtree-hover')).toBe(false);
  } finally {
    engine.destroy();
  }
});

it('选中根或子主题立即隐藏整图提示，移入同图空白及其他主题也不重现，取消选择后恢复', () => {
  const { engine, rootId, childId, overlays, blank } = setup();
  try {
    engine.session.setSelection({ nodeIds: [], connectorIds: [] });
    pointer(engine, 'move', center(engine, childId));
    expect(overlays.has('selection:subtree-hover')).toBe(true);
    for (const id of [rootId, childId]) {
      engine.session.setSelection({ nodeIds: [id] });
      expect(overlays.has('selection:subtree-hover')).toBe(false);
      pointer(engine, 'move', blank);
      expect(overlays.has('selection:subtree-hover')).toBe(false);
      pointer(engine, 'move', center(engine, id === rootId ? childId : rootId));
      expect(overlays.has('selection:subtree-hover')).toBe(false);
      expect(overlays.get('selection:outline')![0].kind).toBe('polygon');
      engine.session.setSelection({ nodeIds: [] });
      expect(overlays.has('selection:subtree-hover')).toBe(true);
    }
  } finally {
    engine.destroy();
  }
});

it('整图选中保持实线，离开画布、只读和按下拖动会清理悬停层', () => {
  const { engine, rootId, childId, overlays, blank } = setup();
  try {
    engine.session.setSelection({ nodeIds: [rootId], subtreeNodeIds: [rootId] });
    pointer(engine, 'move', center(engine, childId));
    expect(overlays.has('selection:subtree-hover')).toBe(false);
    expect(overlays.get('selection:outline')![0]).toMatchObject({ kind: 'rect' });
    expect(overlays.get('selection:outline')![0]).not.toHaveProperty('strokeDashArray');
    engine.pointer.dispatchPointerLeave(new SyntheticPointerEvent({ point: blank }));
    expect(overlays.has('selection:hover')).toBe(false);
    expect(overlays.get('selection:outline')![0].kind).toBe('rect');
    engine.session.setSelection({ nodeIds: [] });
    pointer(engine, 'move', blank);
    expect(overlays.has('selection:subtree-hover')).toBe(true);
    pointer(engine, 'down', blank);
    expect(overlays.has('selection:subtree-hover')).toBe(false);
    pointer(engine, 'up', blank);
    engine.session.setSelection({ nodeIds: [] });
    pointer(engine, 'move', blank);
    engine.session.setReadOnly(true);
    expect(overlays.has('selection:subtree-hover')).toBe(false);
    expect(overlays.has('selection:hover')).toBe(false);
  } finally {
    engine.destroy();
  }
});

it('外部重叠节点不显示脑图提示；后代尺寸和缩放变化更新范围及屏幕线型', () => {
  const { engine, childId, overlays, blank } = setup();
  try {
    engine.session.setSelection({ nodeIds: [], connectorIds: [] });
    pointer(engine, 'move', center(engine, childId));
    const before = overlays.get('selection:subtree-hover')![0];
    engine.documentStore.updateNode(childId, { width: 500 });
    expect(overlays.get('selection:subtree-hover')![0]).not.toEqual(before);
    engine.session.setViewport({ zoom: 2 });
    pointer(engine, 'move', center(engine, childId));
    expect(overlays.get('selection:subtree-hover')![0]).toMatchObject({ strokeWidth: 0.5, strokeDashArray: [2, 1.5] });
    engine.documentStore.createNode({ nodeType: 'shape', x: blank.x - 4, y: blank.y - 4, width: 30, height: 30 });
    pointer(engine, 'move', blank);
    expect(overlays.has('selection:subtree-hover')).toBe(false);
    expect(overlays.get('selection:hover')![0].kind).toBe('polygon');
  } finally {
    engine.destroy();
  }
});

it('点击脑图空隙选整图并显示完整矩形，点击根主题恢复主题外框，拖动整体不改变成员局部坐标', () => {
  const { engine, rootId, childId, overlays, blank } = setup();
  try {
    expect(engine.hitTest(blank)).toBeNull();
    click(engine, blank);
    expect([...engine.session.selectedNodeIds]).toEqual([rootId]);
    expect([...engine.session.selectedSubtreeNodeIds]).toEqual([rootId]);
    const b = engine.documentStore.selectionGeometry.getSubtreeBounds(rootId)!;
    expect(overlays.get('selection:outline')).toEqual([
      expect.objectContaining({ kind: 'rect', x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top })
    ]);
    expect(overlays.get('transform:handles')?.length ?? 0).toBe(0);
    const child = { ...engine.documentStore.getNode(childId)! };
    pointer(engine, 'down', blank);
    pointer(engine, 'move', { x: blank.x + 100, y: blank.y + 80 });
    pointer(engine, 'up', { x: blank.x + 100, y: blank.y + 80 });
    expect(engine.documentStore.getNode(childId)).toEqual(child);
    expect(engine.session.selectedSubtreeNodeIds.has(rootId)).toBe(true);
    const root = engine.getNodeWorldBounds(rootId)!;
    click(engine, { x: (root.left + root.right) / 2, y: (root.top + root.bottom) / 2 });
    expect(engine.session.selectedSubtreeNodeIds.size).toBe(0);
    expect(overlays.get('selection:outline')![0].kind).toBe('polygon');
  } finally {
    engine.destroy();
  }
});

it('空隙中的其他节点优先被选中，子主题变化刷新整图外框，普通主题点选不升级整图', () => {
  const { engine, rootId, childId, overlays, blank } = setup();
  try {
    click(engine, blank);
    const before = overlays.get('selection:outline')![0];
    engine.documentStore.updateNode(childId, { width: 500 });
    const after = overlays.get('selection:outline')![0];
    expect(after).not.toEqual(before);
    const foreign = engine.documentStore.createNode({
      nodeType: 'shape',
      x: blank.x - 4,
      y: blank.y - 4,
      width: 30,
      height: 30
    })!;
    click(engine, blank);
    expect([...engine.session.selectedNodeIds]).toEqual([foreign]);
    expect(engine.session.selectedSubtreeNodeIds.size).toBe(0);
    engine.documentStore.removeEntities({ nodeIds: [foreign] });
    const child = engine.getNodeWorldBounds(childId)!;
    click(engine, { x: (child.left + child.right) / 2, y: (child.top + child.bottom) / 2 });
    expect([...engine.session.selectedNodeIds]).toEqual([childId]);
    expect(engine.session.selectedSubtreeNodeIds.has(rootId)).toBe(false);
  } finally {
    engine.destroy();
  }
});
