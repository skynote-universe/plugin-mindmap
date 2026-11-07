import { describe, expect, it, vi } from 'vitest';
import {
  DETACHED_CANVAS_HOST,
  SkyNoteEngine,
  SyntheticPointerEvent,
  applyMatrix,
  pointAlongPolyline,
  type CanvasPrimitive,
  type CanvasKeyboardEvent,
  type Point,
  type RectPrimitive,
  type TextPrimitive
} from '@skynote/core';
import {
  BasicNodesPlugin,
  BranchConnectorsPlugin,
  ConnectorEditPlugin,
  ConnectorToolPlugin,
  SelectionOutlinePlugin,
  SelectionPlugin,
  TransformPlugin
} from '@skynote/plugins-basic';
import { MindmapPlugin } from '../src/plugin';
import { MINDMAP_FOLD_OVERLAY } from '../src/fold-controls';
import { MindmapStructureRegistry } from '../src/structures';

function setup(structure = 'left') {
  const layers = new Map<string, readonly CanvasPrimitive[]>();
  const host = {
    ...DETACHED_CANVAS_HOST,
    overlay: {
      setPrimitives: vi.fn((id: string, primitives: readonly CanvasPrimitive[]) => layers.set(id, primitives)),
      clear: vi.fn((id: string) => layers.delete(id))
    },
    capturePointer: vi.fn(),
    releasePointer: vi.fn(),
    setCursor: vi.fn()
  };
  const plugin = new MindmapPlugin();
  const engine = new SkyNoteEngine()
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new TransformPlugin())
    .use(plugin);
  const root = plugin.createMindmap({ x: 300, y: 300 }, { structure, sample: true })!;
  engine.session.setViewportSize({ width: 1200, height: 900 });
  const detach = engine.attachHost(host);
  engine.documentStore.clearHistory();
  const body = (id = root) =>
    layers
      .get(MINDMAP_FOLD_OVERLAY)
      ?.find((p): p is RectPrimitive => p.kind === 'rect' && p.id === `mindmap-fold:${id}:body`);
  const center = (id = root): Point => {
    const box = body(id)!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const pointer = (phase: 'down' | 'move' | 'up' | 'cancel' | 'leave', point = center()) => {
    const event = new SyntheticPointerEvent({ point, target: engine.hitTestNode(point), pointerId: 7 });
    if (phase === 'down') engine.pointer.dispatchPointerDown(event);
    if (phase === 'move') engine.pointer.dispatchPointerMove(event);
    if (phase === 'up') engine.pointer.dispatchPointerUp(event);
    if (phase === 'cancel') engine.pointer.dispatchPointerCancel(event);
    if (phase === 'leave') engine.pointer.dispatchPointerLeave(event);
    return event;
  };
  return { engine, store: engine.documentStore, plugin, root, host, layers, detach, body, center, pointer };
}

describe('导图画布折叠控件', () => {
  it('从分支线移入徽标清除底层悬停，移出恢复；点击仅折叠且保持节点选区', () => {
    const { engine, plugin, root, pointer, center, host, layers, store } = setup();
    engine
      .use(new BranchConnectorsPlugin())
      .use(new ConnectorEditPlugin())
      .use(new SelectionOutlinePlugin())
      .use(new ConnectorToolPlugin());
    try {
      const badge = center();
      const under = engine.hitTestConnector(badge);
      expect(under).toBeDefined();
      const route = engine.getConnectorRoute(under!.id)!;
      const line = pointAlongPolyline(route.points, 0.6);
      pointer('move', line);
      expect(layers.has('connector-edit:hover')).toBe(true);
      expect(pointer('move', badge).claimedBy).toBe('mindmap:fold');
      expect(layers.has('connector-edit:hover')).toBe(false);
      expect(layers.has('selection:subtree-hover')).toBe(false);
      expect(host.setCursor.mock.lastCall?.[0]).toBe('pointer');
      expect([...engine.session.selectedNodeIds]).toEqual([root]);
      expect(engine.session.selectedConnectorIds.size).toBe(0);
      pointer('move', line);
      expect(layers.has('connector-edit:hover')).toBe(true);
      pointer('move', badge);
      pointer('down', badge);
      pointer('up', badge);
      expect(plugin.getFoldState(root)?.collapsed).toBe(true);
      expect([...engine.session.selectedNodeIds]).toEqual([root]);
      expect(engine.session.selectedConnectorIds.size).toBe(0);
      expect(store.undoEntries).toHaveLength(1);
    } finally {
      engine.destroy();
    }
  });

  it.each(['left', 'right', 'both', 'up', 'down'])('%s中心主题跟随出边方向，折叠前后位置不跳动', (structure) => {
    const c = setup(structure);
    const { engine, plugin, root, center, body, pointer } = c;
    try {
      const bounds = engine.getNodeWorldBounds(root)!;
      const vertical = structure === 'up' || structure === 'down';
      const expected = {
        x: vertical ? (bounds.left + bounds.right) / 2 : structure === 'left' ? bounds.left - 12 : bounds.right + 12,
        y: vertical ? (structure === 'up' ? bounds.top - 12 : bounds.bottom + 12) : (bounds.top + bounds.bottom) / 2
      };
      expect(center()).toEqual(expected);
      expect(body()!.width).toBe(20);
      expect(pointer('down').isClaimed).toBe(true);
      pointer('up');
      expect(plugin.getFoldState(root)?.collapsed).toBe(true);
      expect(center()).toEqual(expected);
      expect(c.store.undoEntries).toHaveLength(1);
      const label = c.layers.get(MINDMAP_FOLD_OVERLAY)!.find((p): p is TextPrimitive => p.kind === 'text')!;
      expect(label.runs).toEqual([{ text: '4' }]);
      pointer('down');
      pointer('up');
      expect(plugin.getFoldState(root)?.collapsed).toBe(false);
      expect(center()).toEqual(expected);
      expect([...engine.session.selectedNodeIds]).toEqual([root]);
    } finally {
      engine.destroy();
    }
  });

  it('缩放保持20px大小与命中范围，平移不重新统计主题数量', () => {
    const { engine, plugin, root, body, pointer, center } = setup();
    try {
      const state = vi.spyOn(plugin, 'getFoldState');
      state.mockClear();
      engine.session.setViewport({ x: 50, y: 80, zoom: 0.5 });
      expect(body()!.height * engine.session.viewport.zoom).toBe(20);
      expect(body()!.width * engine.session.viewport.zoom).toBe(20);
      expect(state).not.toHaveBeenCalled();
      pointer('down');
      pointer('up');
      expect(plugin.getFoldState(root)?.collapsed).toBe(true);
      const outside = { x: center().x + 21, y: center().y };
      expect(pointer('down', outside).claimedBy).not.toBe('mindmap:fold');
    } finally {
      engine.destroy();
    }
  });

  it('悬停通知统一Tooltip，离开清空；不生成文档或历史内容', () => {
    const { engine, plugin, pointer, store } = setup();
    const tooltip = vi.fn();
    const release = plugin.onControlTooltipChange(tooltip);
    const before = JSON.stringify(store.getView());
    try {
      pointer('move');
      expect(tooltip.mock.lastCall?.[0]?.text).toBe('折叠分支');
      pointer('leave');
      expect(tooltip.mock.lastCall?.[0]).toBeNull();
      expect(JSON.stringify(store.getView())).toBe(before);
      expect(store.undoEntries).toHaveLength(0);
    } finally {
      release();
      engine.destroy();
    }
  });

  it.each(['cancel', 'leave', 'move'] as const)('%s中断不提交折叠，并释放指针', (phase) => {
    const { engine, plugin, root, pointer, center, host, store } = setup();
    try {
      const point = center();
      pointer('down', point);
      pointer(phase, phase === 'move' ? { x: point.x + 30, y: point.y } : point);
      pointer('up', point);
      expect(plugin.getFoldState(root)?.collapsed).toBe(false);
      expect(host.releasePointer).toHaveBeenCalledWith(7);
      expect(store.undoEntries).toHaveLength(0);
    } finally {
      engine.destroy();
    }
  });

  it('锁定、只读、维护冻结和绘图工具不触发折叠', () => {
    const c = setup();
    const { engine, store, root, pointer, center, plugin, layers } = c;
    try {
      const point = center();
      store.updateNode(root, { locked: true });
      expect(pointer('down', point).claimedBy).not.toBe('mindmap:fold');
      store.updateNode(root, { locked: false });
      engine.session.setReadOnly(true);
      expect(layers.has(MINDMAP_FOLD_OVERLAY)).toBe(false);
      expect(pointer('down', point).claimedBy).not.toBe('mindmap:fold');
      engine.session.setReadOnly(false);
      engine.session.setSelection({ nodeIds: [root] });
      const lease = engine.beginMaintenance();
      expect(layers.has(MINDMAP_FOLD_OVERLAY)).toBe(false);
      lease.resume();
      engine.session.setTool('brush');
      expect(layers.has(MINDMAP_FOLD_OVERLAY)).toBe(false);
      expect(pointer('down', point).claimedBy).not.toBe('mindmap:fold');
      expect(plugin.getFoldState(root)?.collapsed).toBe(false);
    } finally {
      engine.destroy();
    }
  });

  it('宿主卸载清理旧指针与图元，重新挂载立即恢复折叠徽标', () => {
    const c = setup();
    const { engine, plugin, root, detach, host, layers, pointer, center } = c;
    try {
      const point = center();
      pointer('down');
      detach();
      expect(host.releasePointer).toHaveBeenCalledWith(7);
      expect(layers.has(MINDMAP_FOLD_OVERLAY)).toBe(false);
      engine.attachHost(host);
      expect(layers.has(MINDMAP_FOLD_OVERLAY)).toBe(true);
      pointer('up', point);
      expect(plugin.getFoldState(root)?.collapsed).toBe(false);
      plugin.setCollapsed(root, true);
      engine.attachHost(host);
      expect(layers.get(MINDMAP_FOLD_OVERLAY)?.some((p) => p.kind === 'text' && p.runs[0].text === '4')).toBe(true);
      engine.plugins.remove(plugin.id);
      expect(layers.has(MINDMAP_FOLD_OVERLAY)).toBe(false);
      engine.attachHost(host);
      expect(layers.has(MINDMAP_FOLD_OVERLAY)).toBe(false);
    } finally {
      engine.destroy();
    }
  });

  it('旋转主题后控件跟随局部出边，图元不进入内容范围', () => {
    const { engine, store, root, center, body } = setup('left');
    try {
      store.updateNode(root, { rotation: 90 });
      const node = store.getNode(root)!;
      const anchor = applyMatrix(engine.entityStore.getWorldTransform(root)!, 0, node.height / 2);
      expect(center().x).toBeCloseTo(anchor.x);
      expect(center().y).toBeCloseTo(anchor.y - 12);
      expect(body()!.height).toBe(20);
      const bounds = engine.spatialIndex.getContentBounds()!;
      expect(center().y).toBeLessThan(engine.getNodeWorldBounds(root)!.top);
      engine.session.setReadOnly(true);
      expect(engine.spatialIndex.getContentBounds()).toEqual(bounds);
    } finally {
      engine.destroy();
    }
  });

  it('Escape取消按压，后续抬起不提交折叠', () => {
    const { engine, plugin, root, pointer, center, host, store } = setup();
    try {
      const point = center();
      pointer('down');
      expect(engine.inputScopes.dispatchKeyDown({ key: 'Escape', preventDefault() {} } as CanvasKeyboardEvent)).toBe(
        true
      );
      pointer('up', point);
      expect(plugin.getFoldState(root)?.collapsed).toBe(false);
      expect(host.releasePointer).toHaveBeenCalledWith(7);
      expect(store.undoEntries).toHaveLength(0);
    } finally {
      engine.destroy();
    }
  });

  it.each([false, true])('失焦清理悬停与按压，不在后续抬起提交折叠（按压=%s）', (pressed) => {
    const { engine, plugin, root, pointer, center, host, store } = setup();
    const tooltip = vi.fn();
    const release = plugin.onControlTooltipChange(tooltip);
    try {
      const point = center();
      pointer('move', point);
      expect(tooltip.mock.lastCall?.[0]?.text).toBe('折叠分支');
      if (pressed) pointer('down', point);
      host.releasePointer.mockClear();
      engine.inputScopes.dispatchBlur();
      engine.inputScopes.dispatchBlur();
      expect(host.releasePointer).toHaveBeenCalledTimes(pressed ? 1 : 0);
      expect(tooltip.mock.lastCall?.[0]).toBeNull();
      expect(host.setCursor.mock.lastCall?.[0]).toBe('default');
      pointer('up', point);
      expect(plugin.getFoldState(root)?.collapsed).toBe(false);
      expect(store.undoEntries).toHaveLength(0);
      expect([...engine.session.selectedNodeIds]).toEqual([root]);
      // 失焦只取消旧手势，重新移入和按压后仍可正常折叠。
      pointer('move', point);
      pointer('down', point);
      pointer('up', point);
      expect(plugin.getFoldState(root)?.collapsed).toBe(true);
      expect(store.undoEntries).toHaveLength(1);
    } finally {
      release();
      engine.destroy();
    }
  });

  it('自定义结构使用注册的展开方向，成员控件不会回落到错误的右侧', () => {
    const { engine, plugin, root, body, center } = setup();
    try {
      plugin.registerStructure({ ...new MindmapStructureRegistry().get('up'), id: 'custom-up' });
      plugin.setOptions(root, { structure: 'custom-up' });
      const branch = [...engine.entityStore.getChildIds(root)][0];
      plugin.insertChild(branch);
      engine.session.setSelection({ nodeIds: [branch] });
      const bounds = engine.getNodeWorldBounds(branch)!;
      expect(body(branch)).toBeDefined();
      expect(center(branch).x).toBe((bounds.left + bounds.right) / 2);
      expect(center(branch).y).toBe(bounds.top - 12);
    } finally {
      engine.destroy();
    }
  });

  it('大数量徽标适应内容，Tooltip保留完整数量', () => {
    const { engine, store, plugin, root, body, pointer, layers } = setup();
    try {
      store.batch(() => {
        for (let i = 0; i < 100; i++) plugin.insertChild(root);
      }, '批量主题');
      plugin.setCollapsed(root, true);
      engine.session.setSelection({ nodeIds: [root] });
      expect(body()!.width).toBe(26);
      const label = layers.get(MINDMAP_FOLD_OVERLAY)!.find((p): p is TextPrimitive => p.kind === 'text')!;
      expect(label.runs[0].text).toBe('99+');
      const tooltip = vi.fn();
      const release = plugin.onControlTooltipChange(tooltip);
      pointer('move');
      expect(tooltip.mock.lastCall?.[0]?.text).toBe('展开 104 个主题');
      release();
    } finally {
      engine.destroy();
    }
  });
});
