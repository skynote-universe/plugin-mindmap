/**
 * @file mindmap.test.ts
 * @description 思维导图：主题随文字伸缩、双向平衡排版、Tab / Enter 插入并请求编辑、分支线配色、
 *              拖动改挂与拖出、大纲解析与粘贴、任何节点都能当主题
 */

import { describe, it, expect, vi } from 'vitest';
import {
  NODE_CLIPBOARD_MIME,
  SkyNoteEngine,
  applyMatrix,
  invertMatrix,
  buildLayoutTree,
  sortSiblingsByLayer,
  type RectBounds,
  SyntheticPointerEvent,
  type CanvasKeyboardEvent,
  type FontMeasurer,
  type NodeEntity,
  type Point
} from '@skynote/core';
import {
  BasicNodesPlugin,
  BranchConnectorsPlugin,
  ClipboardPlugin,
  SelectionPlugin,
  TextEditPlugin
} from '@skynote/plugins-basic';
import { MINDMAP_PLUGIN_ID, MindmapPlugin } from '../src/plugin';
import { parseOutline } from '../src/outline';
import { MindmapBranchRouter } from '../src/branch-router';
import { resolveTopicDrop } from '../src/drop';
import { createMindmapLayout } from '../src/layout';
import { MindmapThemeRegistry } from '../src/themes';
import { MindmapStructureRegistry, arrangeByGrowth, type MindmapStructureDefinition } from '../src/structures';

const fonts: FontMeasurer = { measureWidth: (text, font) => [...text].length * font.size * 0.5 };

function setup() {
  const engine = new SkyNoteEngine({ fonts })
    .use(new BasicNodesPlugin())
    .use(new SelectionPlugin())
    .use(new TextEditPlugin())
    .use(new ClipboardPlugin())
    .use(new BranchConnectorsPlugin())
    .use(new MindmapPlugin());
  const store = engine.documentStore;
  const plugin = engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin;
  // 中心主题 160 × 56，左上角落在原点
  const rootId = plugin.createMindmap({ x: 80, y: 28 })!;
  store.clearHistory();
  engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
  return { engine, store, rootId };
}

function key(engine: SkyNoteEngine, code: string) {
  return engine.inputScopes.dispatchKeyDown({
    key: code,
    code,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {}
  } as CanvasKeyboardEvent);
}

function pointer(engine: SkyNoteEngine, phase: 'down' | 'move' | 'up', point: Point) {
  const event = new SyntheticPointerEvent({ point, target: engine.hitTestNode(point) as NodeEntity | undefined });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else engine.pointer.dispatchPointerUp(event);
}

/** 节点外框中心的世界坐标 */
function center(engine: SkyNoteEngine, id: string): Point {
  const b = engine.getNodeWorldBounds(id)!;
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

const selected = (engine: SkyNoteEngine) => [...engine.session.selectedNodeIds][0];

describe('思维导图', () => {
  it('主题是基础形状的圆角矩形 (不另注册节点类型)；Tab 插入子主题、选中并请求编辑，排在右侧且与父主题垂直居中', () => {
    const { engine, store, rootId } = setup();
    const root = store.getNode(rootId)!;
    expect(root).toMatchObject({ nodeType: 'shape', x: 0, y: 0, width: 160, height: 56, layout: { type: 'mindmap' } });

    const requests = vi.fn();
    engine.session.onTextEditRequest(requests);
    expect(key(engine, 'Tab')).toBe(true);
    const childId = selected(engine);
    expect(requests).toHaveBeenCalledWith(childId);
    expect(engine.session.textEditing?.id).toBe(childId);
    const child = store.getNode(childId)!;
    expect(child).toMatchObject({ parentId: rootId, layoutItem: { side: 'right' } });
    expect(child.x).toBe(root.width + 56);
    expect(child.y + child.height / 2).toBeCloseTo(root.height / 2);

    // 一步撤销
    store.undo();
    expect(store.getNode(childId)).toBeUndefined();
  });

  it('双向平衡：第一层主题轮流放到较轻的一侧；Enter 插入同级主题紧随其后、同侧；分支线按第一层分支配色', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    key(engine, 'Tab');
    const b = selected(engine);
    expect(store.getNode(b)!.layoutItem).toEqual({ side: 'left' });
    expect(center(engine, b).x).toBeLessThan(center(engine, rootId).x);

    engine.session.setSelection({ nodeIds: [a], connectorIds: [] });
    key(engine, 'Escape');
    key(engine, 'Enter');
    const a2 = selected(engine);
    expect(store.getNode(a2)!.layoutItem).toEqual({ side: 'right' });
    expect(center(engine, a2).y).toBeGreaterThan(center(engine, a).y);

    const branch = (id: string) => engine.entityStore.getConnector(`@branch:${id}`)!.entity;
    expect(branch(a)).toMatchObject({
      connectorType: 'mindmap:branch',
      from: { nodeId: rootId, anchor: { x: 1, y: 0.5 } },
      style: { stroke: '$red', strokeWidth: 3 }
    });
    expect(branch(b)).toMatchObject({ from: { anchor: { x: 0, y: 0.5 } }, style: { stroke: '$amber' } });

    engine.session.setSelection({ nodeIds: [a], connectorIds: [] });
    key(engine, 'Tab');
    expect(branch(selected(engine)).style).toMatchObject({ stroke: '$red', strokeWidth: 2 });
  });

  it('主题拉宽时子主题在同一事务内让开，一步撤销', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    key(engine, 'Tab');
    const a1 = selected(engine);
    const before = engine.getNodeWorldBounds(a1)!.left;
    store.updateNode(a, { width: 300 });
    expect(engine.getNodeWorldBounds(a1)!.left).toBeGreaterThan(before);
    store.undo();
    expect(engine.getNodeWorldBounds(a1)!.left).toBe(before);
    expect(store.getNode(rootId)).toBeDefined();
  });

  it('复制分支再粘贴：带子主题的分支成为沿用原导图参数的新导图 (有分支线)；叶子成为普通主题', () => {
    const { engine, store, rootId } = setup();
    store.updateNode(rootId, { layout: { type: 'mindmap', options: { theme: 'ocean' } } });
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    key(engine, 'Tab');
    const a1 = selected(engine);

    const branch = store.pasteEntities(store.copyEntities({ nodeIds: [a] })!, { x: 0, y: 500 }).nodeIds[0];
    expect(store.getNode(branch)).toMatchObject({ layout: { type: 'mindmap', options: { theme: 'ocean' } } });
    expect(store.getNode(branch)!.layoutItem).toBeUndefined();
    const [child] = engine.entityStore.getChildIds(branch);
    expect(engine.entityStore.getConnector(`@branch:${child}`)).toBeDefined();

    const leaf = store.pasteEntities(store.copyEntities({ nodeIds: [a1] })!, { x: 0, y: 800 }).nodeIds[0];
    expect(store.getNode(leaf)!.layout).toBeUndefined();
    expect(store.getNode(leaf)!.layoutItem).toBeUndefined();
  });

  it('拖动主题到另一主题上改挂为其子主题 (一步撤销)；拖到导图之外脱离，有子主题的成为新导图', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    key(engine, 'Tab');
    const a1 = selected(engine);
    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    key(engine, 'Tab');
    const b = selected(engine);
    key(engine, 'Escape');

    // 把 a (含子主题 a1) 拖到 b 上
    pointer(engine, 'down', center(engine, a));
    pointer(engine, 'move', { x: center(engine, a).x + 20, y: center(engine, a).y });
    pointer(engine, 'move', center(engine, b));
    pointer(engine, 'up', center(engine, b));
    expect(store.getNode(a)!.parentId).toBe(b);
    expect(store.getNode(a)!.layoutItem!.side).toBeUndefined();
    store.undo();
    expect(store.getNode(a)!.parentId).toBe(rootId);

    // 拖到远处空白：脱离成为新导图，子主题仍在其中
    const far = { x: 2000, y: 2000 };
    pointer(engine, 'down', center(engine, a));
    pointer(engine, 'move', { x: 1000, y: 1000 });
    pointer(engine, 'up', far);
    const detached = store.getNode(a)!;
    expect(detached.parentId).toBeUndefined();
    expect(detached.layoutItem).toBeUndefined();
    expect(detached.layout).toEqual({ type: 'mindmap' });
    expect(store.getNode(a1)!.parentId).toBe(a);
    expect(engine.entityStore.getConnector(`@branch:${a1}`)!.entity.from.nodeId).toBe(a);
    expect(engine.entityStore.getConnector(`@branch:${a}`)).toBeUndefined();
  });

  it('拖动改挂后按新位置套用主题，但保留用户改过的样式项 (当前值与旧位置的主题值不同)', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    key(engine, 'Tab');
    const b = selected(engine);
    key(engine, 'Escape');
    // 彩虹主题 (默认) 第一层：分支的浅底色与线色；用户把 a 的底色改成绿色
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$pink', stroke: '$red' });
    store.updateNode(a, { style: { fill: '$green' } });

    pointer(engine, 'down', center(engine, a));
    pointer(engine, 'move', { x: center(engine, a).x + 20, y: center(engine, a).y });
    pointer(engine, 'move', center(engine, b));
    pointer(engine, 'up', center(engine, b));
    const moved = store.getNode(a)!;
    expect(moved.parentId).toBe(b);
    // 更深层的边框取所在分支的线色 (a 移走后 b 成为第一个分支，线色为红)；用户改的底色保留
    expect(moved.style?.fill).toBe('$green');
    expect(moved.style?.stroke).toBe('$red');
    expect(moved.style?.fillOpacity).toBeUndefined();
  });

  it('恢复主题样式：该主题及子树 (或只这个主题) 按主题重新写入外观，单独的修改被覆盖，一步撤销', () => {
    const { engine, store } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    store.updateNode(a, { style: { fill: '$green', stroke: '$violet' } });
    (engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin).resetTopicStyle(a);
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$pink', stroke: '$red' });
    store.undo();
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$green', stroke: '$violet' });

    // 只恢复这个主题：下级主题的修改保留
    key(engine, 'Tab');
    const a1 = selected(engine);
    key(engine, 'Escape');
    store.updateNode(a1, { style: { fill: '$blue' } });
    (engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin).resetTopicStyle(a, 'topic');
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$pink' });
    expect(store.getNode(a1)!.style?.fill).toBe('$blue');
  });

  it('拖到同级主题的上下边缘：插到它前后调整顺序 (同侧不变)；落回原处不产生修改', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    key(engine, 'Tab');
    key(engine, 'Escape');
    engine.session.setSelection({ nodeIds: [a], connectorIds: [] });
    key(engine, 'Enter');
    const a2 = selected(engine);
    key(engine, 'Escape');
    expect(center(engine, a2).y).toBeGreaterThan(center(engine, a).y);

    // a2 的左边中点对准 a 的左上角附近 (不在中段、也没越过外侧边)
    const from = center(engine, a2);
    const aBounds = engine.getNodeWorldBounds(a)!;
    const a2Bounds = engine.getNodeWorldBounds(a2)!;
    const to = { x: from.x + aBounds.left + 10 - a2Bounds.left, y: from.y + aBounds.top + 3 - from.y };
    pointer(engine, 'down', from);
    pointer(engine, 'move', { x: from.x + 10, y: from.y });
    pointer(engine, 'move', to);
    pointer(engine, 'up', to);
    expect(center(engine, a2).y).toBeLessThan(center(engine, a).y);
    expect(store.getNode(a2)).toMatchObject({ parentId: rootId, layoutItem: { side: 'right' } });

    // 原地拖一下再松手不产生记录：撤销一次即撤回上面的排序
    const here = center(engine, a2);
    pointer(engine, 'down', here);
    pointer(engine, 'move', { x: here.x + 8, y: here.y });
    pointer(engine, 'up', { x: here.x + 8, y: here.y });
    store.undo();
    expect(center(engine, a2).y).toBeGreaterThan(center(engine, a).y);
  });

  it('落点示意：外侧为子主题占位框 (将要出现的位置)，上下边缘为同级插入线；超出吸附距离没有落点', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    key(engine, 'Enter');
    const a2 = selected(engine);
    key(engine, 'Escape');

    const structures = new MindmapStructureRegistry();
    const layout = createMindmapLayout(new MindmapThemeRegistry(), structures);
    const childrenOf = (id: string) =>
      sortSiblingsByLayer([...engine.entityStore.getChildIds(id)].map((child) => store.getNode(child)!));
    const tree = buildLayoutTree(store.getNode(rootId)!, childrenOf, layout);
    const bounds = (id: string) => engine.getNodeWorldBounds(id)!;
    const dragged = tree.get(a2)!;
    const candidates = [tree.root, tree.get(a)!].map((member) => ({ tree, member }));
    const resolve = (ghost: RectBounds) =>
      resolveTopicDrop(dragged, ghost, candidates, 40, (member) => bounds(member.node.id), structures);
    const at = (left: number, top: number): RectBounds => ({ left, top, right: left + 120, bottom: top + 48 });
    const aBox = bounds(a);

    // 越过 a 的右边：成为 a 的子主题，占位框在 a 右侧 56 处、与 a 垂直居中
    const child = resolve(at(aBox.right + 10, aBox.top))!;
    expect(child.parent.node.id).toBe(a);
    expect(child.indicator).toEqual({ kind: 'placeholder', bounds: at(aBox.right + 56, aBox.top) });

    // 左边中点落在 a 的上缘：插到 a 之前，插入线在 a 上方半个兄弟间距处
    const sibling = resolve(at(aBox.left + 10, aBox.top - 20))!;
    expect(sibling.parent.node.id).toBe(rootId);
    expect(sibling.side).toBe('right');
    expect(sibling.zIndex < store.getNode(a)!.zIndex).toBe(true);
    expect(sibling.indicator).toEqual({
      kind: 'line',
      from: { x: aBox.left, y: aBox.top - 8 },
      to: { x: aBox.right, y: aBox.top - 8 }
    });

    expect(resolve(at(aBox.right + 500, aBox.top))).toBeNull();
  });

  it('方向键在主题之间移动选中：朝外进入最近的子主题、朝内回到父主题，上下切换同侧同级；无处可去时停在原处', () => {
    const { engine, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    key(engine, 'Enter');
    const a2 = selected(engine);
    key(engine, 'Escape');
    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    key(engine, 'Tab');
    const b = selected(engine);
    key(engine, 'Escape');

    const go = (from: string, arrow: string) => {
      engine.session.setSelection({ nodeIds: [from], connectorIds: [] });
      expect(key(engine, arrow)).toBe(true);
      return selected(engine);
    };
    expect([a, a2]).toContain(go(rootId, 'ArrowRight'));
    expect(go(rootId, 'ArrowLeft')).toBe(b);
    expect(go(a, 'ArrowDown')).toBe(a2);
    expect(go(a2, 'ArrowUp')).toBe(a);
    expect(go(a, 'ArrowUp')).toBe(a);
    expect(go(a, 'ArrowLeft')).toBe(rootId);
    expect(go(b, 'ArrowRight')).toBe(rootId);
    expect(go(a, 'ArrowRight')).toBe(a);
  });

  it('删除主题：连同下级一并删除，同级让位、分支线消失，选中同侧下一个同级 (没有则上一个、再没有则父主题)；一步撤销', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    key(engine, 'Tab');
    const a1 = selected(engine);
    key(engine, 'Escape');
    engine.session.setSelection({ nodeIds: [a], connectorIds: [] });
    key(engine, 'Enter');
    const a2 = selected(engine);
    key(engine, 'Escape');
    key(engine, 'Enter');
    const a3 = selected(engine);
    key(engine, 'Escape');
    const a3Before = center(engine, a3).y;

    engine.session.setSelection({ nodeIds: [a2], connectorIds: [] });
    expect(key(engine, 'Delete')).toBe(true);
    expect(store.getNode(a2)).toBeUndefined();
    expect(selected(engine)).toBe(a3);
    expect(center(engine, a3).y).toBeLessThan(a3Before);
    expect(engine.entityStore.getConnector(`@branch:${a2}`)).toBeUndefined();

    // 同侧最后一个：选中上一个；删除带下级的主题：下级一并删除
    key(engine, 'Backspace');
    expect(selected(engine)).toBe(a);
    key(engine, 'Delete');
    expect(store.getNode(a1)).toBeUndefined();
    expect(selected(engine)).toBe(rootId);

    store.undo();
    expect(store.getNode(a)).toBeDefined();
    expect(store.getNode(a1)).toBeDefined();
  });

  it('导图成员不能旋转：直接写入的旋转被排回 (旋转热区见变换插件的测试)；中心主题可以旋转', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    store.updateNode(a, { rotation: 45 });
    expect(store.getNode(a)!.rotation).toBe(0);
    store.updateNode(rootId, { rotation: 45 });
    expect(store.getNode(rootId)!.rotation).toBe(45);
  });

  it('中心主题旋转后分支线在它的坐标系中布线：从右侧中点水平出线，随整张图旋转', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    store.updateNode(rootId, { rotation: 30 });
    const line = engine.entityStore.getConnector(`@branch:${a}`)!;
    expect(line.entity.routeFrame).toBe(rootId);
    const toLocal = invertMatrix(engine.entityStore.getWorldTransform(rootId)!);
    const [first, second] = engine.getConnectorRoute(`@branch:${a}`)!.points.map((p) => applyMatrix(toLocal, p.x, p.y));
    const root = store.getNode(rootId)!;
    expect(first.y).toBeCloseTo(root.height / 2);
    expect(first.x).toBeGreaterThanOrEqual(root.width);
    // 曲线水平切出：第二个采样点与起点几乎同高
    expect(Math.abs(second.y - first.y)).toBeLessThan(Math.abs(second.x - first.x));
  });

  it('任何节点都能当主题：带 layoutItem 挂到主题下的便签参与排版并有分支线', () => {
    const { engine, store, rootId } = setup();
    const sticky = store.createNode({
      nodeType: 'sticky',
      parentId: rootId,
      x: 999,
      y: 999,
      options: { text: '便签主题' }
    })!;
    store.updateNode(sticky, { layoutItem: { side: 'right' } });
    expect(store.getNode(sticky)!.x).toBe(store.getNode(rootId)!.width + 56);
    expect(engine.entityStore.getConnector(`@branch:${sticky}`)).toBeDefined();
  });

  it('把画布上的普通节点拖到主题上即加入导图 (补上成员标记、由布局排定位置)，一步撤销', () => {
    const { engine, store, rootId } = setup();
    const sticky = store.createNode({ nodeType: 'sticky', x: 600, y: 600, options: { text: '外来' } })!;
    store.clearHistory();
    const from = center(engine, sticky);
    pointer(engine, 'down', from);
    pointer(engine, 'move', { x: from.x - 50, y: from.y - 50 });
    pointer(engine, 'move', center(engine, rootId));
    pointer(engine, 'up', center(engine, rootId));
    const node = store.getNode(sticky)!;
    expect(node).toMatchObject({ parentId: rootId, layoutItem: {} });
    expect(node.x).toBe(store.getNode(rootId)!.width + 56);
    expect(engine.entityStore.getConnector(`@branch:${sticky}`)).toBeDefined();
    store.undo();
    expect(store.getNode(sticky)).toMatchObject({ x: 600, y: 600 });
    expect(store.getNode(sticky)!.parentId).toBeUndefined();
  });

  it('没有选中主题时：粘贴带层级的文本生成导图 (一步撤销)；画布数据与普通多行文字交回其他处理者', () => {
    const { engine, store } = setup();
    engine.session.setSelection({ nodeIds: [], connectorIds: [] });
    const count = () => Object.keys(store.getView().content.nodes).length;
    const before = count();
    expect(engine.clipboard.paste({ 'text/plain': '发布计划\n  文档\n    README\n  插件\n' })).toBe(true);
    expect(count()).toBe(before + 4);
    const root = store.getNode(selected(engine))!;
    expect(root.layout).toEqual({ type: 'mindmap' });
    expect(engine.entityStore.getChildIds(root.id).size).toBe(2);
    store.undo();
    expect(count()).toBe(before);

    expect(engine.clipboard.paste({ 'text/plain': '第一行\n第二行' })).toBe(true);
    expect(store.getNode(selected(engine))!.nodeType).toBe('free-text');
  });
});

describe('粘贴到选中的主题下', () => {
  it('复制的分支粘贴为选中主题的子主题 (整棵子树并入、套用主题外观、一步撤销)；复制整张导图同样并入', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    key(engine, 'Tab');
    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    key(engine, 'Tab');
    const b = selected(engine);

    const payload = store.copyEntities({ nodeIds: [a] })!;
    engine.session.setSelection({ nodeIds: [b], connectorIds: [] });
    expect(engine.clipboard.paste({ [NODE_CLIPBOARD_MIME]: JSON.stringify(payload) })).toBe(true);
    const pasted = selected(engine);
    const node = store.getNode(pasted)!;
    expect(node).toMatchObject({ parentId: b, layoutItem: {} });
    expect(node.layout).toBeUndefined();
    expect(store.getNode(pasted)!.style?.fill).toBeUndefined();
    const [grandchild] = engine.entityStore.getChildIds(pasted);
    expect(engine.entityStore.getConnector(`@branch:${pasted}`)).toBeDefined();
    expect(engine.entityStore.getConnector(`@branch:${grandchild}`)).toBeDefined();
    store.undo();
    expect(store.getNode(pasted)).toBeUndefined();

    const whole = store.copyEntities({ nodeIds: [rootId] })!;
    engine.session.setSelection({ nodeIds: [b], connectorIds: [] });
    engine.clipboard.paste({ [NODE_CLIPBOARD_MIME]: JSON.stringify(whole) });
    expect(store.getNode(selected(engine))).toMatchObject({ parentId: b, layoutItem: {} });
    expect(store.getNode(selected(engine))!.layout).toBeUndefined();
  });

  it('复制再粘贴到主题下：保留用户改过的样式项与分支线设置，主题写的项按新位置更新 (剪切同样)', () => {
    const { engine, store, rootId } = setup();
    key(engine, 'Tab');
    const a = selected(engine);
    key(engine, 'Escape');
    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    key(engine, 'Tab');
    const b = selected(engine);
    key(engine, 'Escape');
    store.updateNode(a, { style: { fill: '$green' } });
    const a1 = (engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin).insertChild(a)!;
    key(engine, 'Escape');
    store.updateNode(a1, { style: { stroke: '$violet' } });
    // a 的分支线 (入边) 改过颜色并加了线上文字
    const branch = { style: { stroke: '$teal' }, textBlocks: [{ id: 'l1', runs: [{ text: '原因' }] }] };
    store.updateNode(a, { layoutItem: { ...store.getNode(a)!.layoutItem, branch } });

    engine.session.setSelection({ nodeIds: [a], connectorIds: [] });
    const data = engine.clipboard.copy()!;
    engine.session.setSelection({ nodeIds: [b], connectorIds: [] });
    engine.clipboard.paste(data);
    const pasted = store.getNode(selected(engine))!;
    expect(pasted.parentId).toBe(b);
    expect(pasted.style?.fill).toBe('$green');
    // 主题写的边框按新位置更新为 b 分支的线色
    expect(pasted.style?.stroke).toBe('$amber');
    // 分支线设置 (样式与线上文字) 一并带着
    expect(pasted.layoutItem).toEqual({ branch });
    expect(engine.entityStore.getConnector(`@branch:${pasted.id}`)!.entity.style).toMatchObject({ stroke: '$teal' });
    // 子树按层级对应：子主题上用户改的边框同样保留
    const [pastedChild] = engine.entityStore.getChildIds(pasted.id);
    expect(store.getNode(pastedChild)!.style?.stroke).toBe('$violet');

    engine.session.setSelection({ nodeIds: [a], connectorIds: [] });
    const cut = engine.clipboard.cut()!;
    expect(store.getNode(a)).toBeUndefined();
    engine.session.setSelection({ nodeIds: [b], connectorIds: [] });
    engine.clipboard.paste(cut);
    expect(store.getNode(selected(engine))!.style?.fill).toBe('$green');
  });

  it('文字粘贴为子主题：每行一个，有层级标记时嵌套；普通卡片选中时照常粘贴', () => {
    const { engine, store, rootId } = setup();
    expect(engine.clipboard.paste({ 'text/plain': '甲\n乙' })).toBe(true);
    const ids = [...engine.session.selectedNodeIds];
    expect(ids.map((id) => store.getNode(id)!.parentId)).toEqual([rootId, rootId]);
    store.undo();

    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    engine.clipboard.paste({ 'text/plain': '- 计划\n  - 文档' });
    const plan = selected(engine);
    expect(store.getNode(plan)!.parentId).toBe(rootId);
    expect(engine.entityStore.getChildIds(plan).size).toBe(1);

    const card = store.createNode({ nodeType: 'sticky', x: 900, y: 900 })!;
    engine.session.setSelection({ nodeIds: [card], connectorIds: [] });
    engine.clipboard.paste({ 'text/plain': '甲\n乙' });
    expect(store.getNode(selected(engine))!.nodeType).toBe('free-text');
  });
});

describe('组织结构图', () => {
  /** 中心主题下 a (含 a1、a2)、b，结构设为 structure */
  function setupOrg(structure: 'down' | 'up') {
    const ctx = setup();
    const { engine, store, rootId } = ctx;
    store.updateNode(rootId, { layout: { type: 'mindmap', options: { structure } } });
    const plugin = engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin;
    const a = plugin.insertChild(rootId)!;
    const b = plugin.insertChild(rootId)!;
    const a1 = plugin.insertChild(a)!;
    const a2 = plugin.insertChild(a)!;
    key(engine, 'Escape');
    return { ...ctx, a, b, a1, a2 };
  }

  it('向下：子主题排在父主题下方、横向排开并以父主题为中心；分支线从父主题底边中点连到子主题顶边中点', () => {
    const { engine, store, rootId, a, b, a1, a2 } = setupOrg('down');
    const root = engine.getNodeWorldBounds(rootId)!;
    const boxA = engine.getNodeWorldBounds(a)!;
    const boxB = engine.getNodeWorldBounds(b)!;
    // 父子间距 56 (标准)
    expect(boxA.top).toBeCloseTo(root.bottom + 56);
    expect(boxB.top).toBeCloseTo(boxA.top);
    expect(boxB.left).toBeGreaterThan(boxA.right);
    // 两个第一层子树整体以中心主题为中心
    const rootCenter = (root.left + root.right) / 2;
    const span = (engine.getNodeWorldBounds(a1)!.left + boxB.right) / 2;
    expect(span).toBeCloseTo(rootCenter, 0);
    expect(engine.getNodeWorldBounds(a1)!.top).toBeCloseTo(boxA.bottom + 56);
    expect(center(engine, a2).x).toBeGreaterThan(center(engine, a1).x);
    expect(store.getNode(a)!.layoutItem!.side).toBeUndefined();

    const line = engine.entityStore.getConnector(`@branch:${a}`)!.entity;
    expect(line).toMatchObject({ from: { anchor: { x: 0.5, y: 1 } }, to: { anchor: { x: 0.5, y: 0 } } });
    // 导图曲线竖直切出：第二个采样点与起点几乎同一竖线
    const [first, second] = engine.getConnectorRoute(`@branch:${a}`)!.points;
    expect(Math.abs(second.x - first.x)).toBeLessThan(Math.abs(second.y - first.y));
  });

  it('向上：子主题排在父主题上方，分支线从父主题顶边连到子主题底边', () => {
    const { engine, rootId, a } = setupOrg('up');
    expect(engine.getNodeWorldBounds(a)!.bottom).toBeCloseTo(engine.getNodeWorldBounds(rootId)!.top - 56);
    expect(engine.entityStore.getConnector(`@branch:${a}`)!.entity).toMatchObject({
      from: { anchor: { x: 0.5, y: 0 } },
      to: { anchor: { x: 0.5, y: 1 } }
    });
  });

  it('方向键：向下进入子主题、向上回到父主题，左右切换同级；删除后选中右侧的同级', () => {
    const { engine, store, rootId, a, b, a1, a2 } = setupOrg('down');
    const go = (from: string, arrow: string) => {
      engine.session.setSelection({ nodeIds: [from], connectorIds: [] });
      key(engine, arrow);
      return selected(engine);
    };
    expect([a, b]).toContain(go(rootId, 'ArrowDown'));
    expect(go(a, 'ArrowUp')).toBe(rootId);
    expect(go(a, 'ArrowRight')).toBe(b);
    expect(go(b, 'ArrowLeft')).toBe(a);
    expect([a1, a2]).toContain(go(a, 'ArrowDown'));
    expect(go(a1, 'ArrowRight')).toBe(a2);
    expect(go(rootId, 'ArrowRight')).toBe(rootId);

    engine.session.setSelection({ nodeIds: [a1], connectorIds: [] });
    key(engine, 'Delete');
    expect(store.getNode(a1)).toBeUndefined();
    expect(selected(engine)).toBe(a2);
  });

  it('拖动落点按纵向结构判定：落在同级左右边缘为插到前后 (竖直插入线)，越过底边为子主题 (占位框在其下方)', () => {
    const { engine, store, rootId, a, b } = setupOrg('down');
    const structures = new MindmapStructureRegistry();
    const layout = createMindmapLayout(new MindmapThemeRegistry(), structures);
    const childrenOf = (id: string) =>
      sortSiblingsByLayer([...engine.entityStore.getChildIds(id)].map((child) => store.getNode(child)!));
    const tree = buildLayoutTree(store.getNode(rootId)!, childrenOf, layout);
    const bounds = (id: string) => engine.getNodeWorldBounds(id)!;
    const dragged = tree.get(b)!;
    const resolve = (ghost: RectBounds) =>
      resolveTopicDrop(
        dragged,
        ghost,
        [{ tree, member: tree.get(a)! }],
        40,
        (member) => bounds(member.node.id),
        structures
      );
    const box = bounds(a);
    const at = (left: number, top: number): RectBounds => ({ left, top, right: left + 120, bottom: top + 48 });

    // 顶边中点落在 a 的左缘：插到 a 之前
    const before = resolve(at(box.left - 60 - 10, box.top + 4))!;
    expect(before.parent.node.id).toBe(rootId);
    expect(before.zIndex < store.getNode(a)!.zIndex).toBe(true);
    expect(before.indicator.kind).toBe('line');
    if (before.indicator.kind === 'line') expect(before.indicator.from.x).toBe(before.indicator.to.x);

    // 顶边越过 a 的底边：成为 a 的子主题
    const child = resolve(at(box.left, box.bottom + 10))!;
    expect(child.parent.node.id).toBe(a);
    expect(child.indicator.kind).toBe('placeholder');
  });
});

describe('结构与默认线型', () => {
  it('每种结构有默认线型：双向为曲线，组织结构图为折线；单独设置的线型在换结构时恢复为新结构的默认', () => {
    const { engine, rootId } = setup();
    const mindmap = engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin;
    const a = mindmap.insertChild(rootId)!;
    const lineType = () => engine.entityStore.getConnector(`@branch:${a}`)!.entity.connectorType;
    expect(lineType()).toBe('mindmap:branch');

    mindmap.setOptions(rootId, { structure: 'down' });
    expect(mindmap.getOptions(rootId).line).toBe('elbow');
    expect(lineType()).toBe('orthogonal');

    mindmap.setOptions(rootId, { line: 'curve' });
    expect(lineType()).toBe('mindmap:branch');
    mindmap.setOptions(rootId, { structure: 'up' });
    expect(lineType()).toBe('orthogonal');
    // 同时指定线型时以指定的为准
    mindmap.setOptions(rootId, { structure: 'both', line: 'straight' });
    expect(lineType()).toBe('straight');

    expect(mindmap.listStructures().map((structure) => [structure.id, structure.defaultLine])).toEqual([
      ['both', 'curve'],
      ['right', 'curve'],
      ['left', 'curve'],
      ['down', 'elbow'],
      ['up', 'elbow']
    ]);
  });

  it('结构示意图由结构自己的排版生成：双向的子主题分在两侧，向下的子主题都在中心主题下方，折线结构的路径是直线段', () => {
    const { engine } = setup();
    const mindmap = engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin;
    const previews = new Map(mindmap.listStructures().map((s) => [s.id, s.preview]));
    const rootOf = (id: string) => previews.get(id)!.boxes.find((box) => box.root)!;
    const children = (id: string) => previews.get(id)!.boxes.filter((box) => !box.root);

    const bothRoot = rootOf('both');
    expect(children('both').some((box) => box.x > bothRoot.x + bothRoot.width)).toBe(true);
    expect(children('both').some((box) => box.x + box.width < bothRoot.x)).toBe(true);

    const downRoot = rootOf('down');
    expect(children('down').every((box) => box.y > downRoot.y + downRoot.height)).toBe(true);
    expect(previews.get('down')!.lines.every((d) => !d.includes('C'))).toBe(true);
    expect(previews.get('both')!.lines.every((d) => d.includes('C'))).toBe(true);
    // 两级就足以示意：中心主题下四个主题
    expect(previews.get('down')!.lines).toHaveLength(4);
  });

  it('开发者注册结构：给出展开方向与排版即可，拖动、方向键等交互通用；注销后回落默认结构；非法定义报错', () => {
    const { engine, store, rootId } = setup();
    const mindmap = engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin;
    const a = mindmap.insertChild(rootId)!;
    const a1 = mindmap.insertChild(a)!;
    key(engine, 'Escape');
    // 阶梯：每个子主题都向右下方展开 (向右展开的排版再整体下移半个主题高度)
    const stairs: MindmapStructureDefinition = {
      id: 'acme:stairs',
      label: '阶梯',
      defaultLine: 'elbow',
      rootGrowths: ['right'],
      growth(tree) {
        const growth = new Map<string, 'right'>();
        const visit = (member: (typeof tree)['root']) =>
          member.children.forEach((child) => {
            growth.set(child.node.id, 'right');
            visit(child);
          });
        visit(tree.root);
        return growth;
      },
      gaps: () => ({ main: 30, cross: 10 }),
      arrange(tree, gaps) {
        const placements = arrangeByGrowth(tree, this.growth(tree), gaps);
        for (const [id, point] of placements) placements.set(id, { x: point.x, y: point.y + 24 });
        return placements;
      }
    };
    const unregister = mindmap.registerStructure(stairs);
    expect(mindmap.listStructures().at(-1)).toMatchObject({ id: 'acme:stairs', label: '阶梯' });
    mindmap.setOptions(rootId, { structure: 'acme:stairs' });
    expect(store.getNode(a)!.x).toBe(store.getNode(rootId)!.width + 30);
    expect(engine.entityStore.getConnector(`@branch:${a}`)!.entity.connectorType).toBe('orthogonal');
    engine.session.setSelection({ nodeIds: [a], connectorIds: [] });
    key(engine, 'ArrowRight');
    expect(selected(engine)).toBe(a1);

    unregister();
    expect(mindmap.getOptions(rootId).structure).toBe('acme:stairs');
    expect(store.getNode(a)!.x).toBe(store.getNode(rootId)!.width + 56);

    expect(() => mindmap.registerStructure({ ...stairs, defaultLine: 'wavy' as 'curve' })).toThrow();
    expect(() => mindmap.registerStructure({ ...stairs, rootGrowths: [] })).toThrow();
  });
});

describe('导图命令 (宿主界面调用)', () => {
  const commands = (engine: SkyNoteEngine) => engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin;

  it('导图参数：结构、线型、间距、主题各自生效，一步撤销；非法值回落默认，未注册的结构保留 id、暂按默认结构排版', () => {
    const { engine, store, rootId } = setup();
    const mindmap = commands(engine);
    key(engine, 'Tab');
    const a = selected(engine);
    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    key(engine, 'Tab');
    const b = selected(engine);
    expect(mindmap.mindmapRootOf(b)).toBe(rootId);
    expect(mindmap.getOptions(rootId)).toEqual({
      structure: 'both',
      line: 'curve',
      spacing: 'standard',
      theme: 'rainbow'
    });

    mindmap.setOptions(rootId, { structure: 'right' });
    expect(center(engine, b).x).toBeGreaterThan(center(engine, rootId).x);
    mindmap.setOptions(rootId, { line: 'elbow', spacing: 'loose', theme: 'minimal' });
    const branch = engine.entityStore.getConnector(`@branch:${a}`)!.entity;
    expect(branch.connectorType).toBe('orthogonal');
    expect(branch.style!.stroke).toBeUndefined();
    expect(store.getNode(a)!.x).toBe(store.getNode(rootId)!.width + 80);
    store.undo();
    expect(engine.entityStore.getConnector(`@branch:${a}`)!.entity.connectorType).toBe('mindmap:branch');

    store.updateNode(rootId, { layout: { type: 'mindmap', options: { structure: 'acme:diagonal', spacing: 3 } } });
    expect(mindmap.getOptions(rootId)).toMatchObject({
      structure: 'acme:diagonal',
      line: 'curve',
      spacing: 'standard'
    });
    expect(center(engine, b).x).toBeLessThan(center(engine, rootId).x);
  });

  it('切换主题：整张导图的主题外观与分支线一并更新 (一步撤销)；之后插入的主题按层级套用当前主题', () => {
    const { engine, store, rootId } = setup();
    const mindmap = commands(engine);
    const a = mindmap.insertChild(rootId)!;
    const b = mindmap.insertChild(rootId)!;
    const a1 = mindmap.insertChild(a)!;
    // 默认主题 (彩虹，排在第一个)：各分支取各自的浅底色与线色
    expect(mindmap.listThemes().map((theme) => theme.label)).toEqual(['彩虹', '清新', '海洋', '暖阳', '简约']);
    expect(store.getNode(rootId)!.style).toMatchObject({ fill: '$purple', stroke: '$violet' });
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$pink', stroke: '$red' });
    expect(store.getNode(b)!.style).toMatchObject({ fill: '$orange', stroke: '$amber' });
    expect(store.getNode(a1)!.style!.stroke).toBe('$red');
    expect(store.getNode(a)!.textStyle).toMatchObject({ color: '$ink' });
    expect(engine.entityStore.getConnector(`@branch:${b}`)!.entity.style!.stroke).toBe('$amber');

    mindmap.setOptions(rootId, { theme: 'fresh' });
    expect(store.getNode(rootId)!.style).toMatchObject({ fill: '$blue', stroke: '$sky' });
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$yellow', stroke: '$amber' });
    expect(store.getNode(a1)!.style!.stroke).toBeUndefined();

    const b1 = mindmap.insertChild(b)!;
    expect(store.getNode(b1)!.style!.stroke).toBeUndefined();

    // 撤销插入，再撤销换主题：回到彩虹
    store.undo();
    store.undo();
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$pink', stroke: '$red' });
    expect(mindmap.getOptions(rootId).theme).toBe('rainbow');
  });

  it('插入命令与键盘一致并请求编辑；展开为独立导图放在原导图下方、沿用样式；取消导图后不再排版', () => {
    const { engine, store, rootId } = setup();
    const mindmap = commands(engine);
    const a = mindmap.insertChild(rootId)!;
    expect(engine.session.textEditing?.id).toBe(a);
    const a1 = mindmap.insertChild(a)!;
    const a2 = mindmap.insertSibling(a1)!;
    expect(store.getNode(a2)!.parentId).toBe(a);
    mindmap.setOptions(rootId, { line: 'straight' });

    const before = engine.getNodeWorldBounds(rootId)!;
    expect(mindmap.detachBranch(a)).toBe(true);
    const detached = store.getNode(a)!;
    expect(detached.parentId).toBeUndefined();
    expect(detached.layout).toEqual({ type: 'mindmap', options: { line: 'straight' } });
    expect(engine.getNodeWorldBounds(a)!.top).toBeGreaterThan(before.bottom);
    expect(mindmap.detachBranch(rootId)).toBe(false);

    mindmap.removeMindmap(a);
    expect(store.getNode(a)!.layout).toBeUndefined();
    const x = store.getNode(a1)!.x;
    store.updateNode(a1, { x: x + 30 });
    expect(store.getNode(a1)!.x).toBe(x + 30);
  });
});

describe('自定义主题', () => {
  const brand = {
    id: 'acme:brand',
    label: '品牌色',
    root: { fill: '#1E3A8A', text: '$ink' },
    level1: 'branch' as const,
    deeper: { stroke: '$sky' },
    line: 'branch' as const,
    branchColors: [{ line: '#DC2626', fill: '#FEE2E2' }]
  };

  function setupWith(plugin: MindmapPlugin) {
    const engine = new SkyNoteEngine({ fonts })
      .use(new BasicNodesPlugin())
      .use(new SelectionPlugin())
      .use(new TextEditPlugin())
      .use(new BranchConnectorsPlugin())
      .use(plugin);
    const store = engine.documentStore;
    const rootId = plugin.createMindmap({ x: 0, y: 0 })!;
    const a = plugin.insertChild(rootId)!;
    const b = plugin.insertChild(rootId)!;
    return { engine, store, rootId, a, b };
  }

  it('构造参数传入的主题排在内置之后，切换后按定义写入外观与分支线 (支持自定义色值与分支色序列)', () => {
    const plugin = new MindmapPlugin({ themes: [brand] });
    const { engine, store, rootId, a, b } = setupWith(plugin);
    expect(plugin.listThemes().map((theme) => theme.id)).toEqual([
      'rainbow',
      'fresh',
      'ocean',
      'warm',
      'minimal',
      'acme:brand'
    ]);
    plugin.setOptions(rootId, { theme: 'acme:brand' });
    expect(store.getNode(rootId)!.style!.fill).toBe('#1E3A8A');
    // 只有一种分支色：各分支循环取用
    expect(store.getNode(a)!.style).toMatchObject({ fill: '#FEE2E2', stroke: '#DC2626' });
    expect(store.getNode(b)!.style).toMatchObject({ fill: '#FEE2E2', stroke: '#DC2626' });
    expect(engine.entityStore.getConnector(`@branch:${b}`)!.entity.style!.stroke).toBe('#DC2626');
  });

  it('运行时注册：文档里先用了未注册的主题时保留 id、分支线按默认主题；注册后分支线即刷新，注销后回落', () => {
    const plugin = new MindmapPlugin();
    const { engine, store, rootId, a } = setupWith(plugin);
    store.updateNode(rootId, { layout: { type: 'mindmap', options: { theme: 'acme:brand' } } });
    expect(plugin.getOptions(rootId).theme).toBe('acme:brand');
    const line = () => engine.entityStore.getConnector(`@branch:${a}`)!.entity.style!.stroke;
    expect(line()).toBe('$red');

    const unregister = plugin.registerTheme(brand);
    expect(line()).toBe('#DC2626');
    expect(plugin.listThemes().at(-1)).toMatchObject({ id: 'acme:brand', label: '品牌色', root: '#1E3A8A' });
    unregister();
    expect(line()).toBe('$red');
    expect(plugin.listThemes().some((theme) => theme.id === 'acme:brand')).toBe(false);
  });

  it('同 id 覆盖内置主题，注销后恢复内置；非法定义在注册时报错', () => {
    const plugin = new MindmapPlugin();
    const restore = plugin.registerTheme({ ...brand, id: 'rainbow', label: '彩虹 (品牌)' });
    expect(plugin.listThemes()[0].label).toBe('彩虹 (品牌)');
    restore();
    expect(plugin.listThemes()[0].label).toBe('彩虹');

    expect(() => plugin.registerTheme({ ...brand, root: { fill: 'not-a-color' } })).toThrow(/root\.fill/);
    expect(() => plugin.registerTheme({ ...brand, label: '' })).toThrow(/名称/);
    expect(() => plugin.registerTheme({ ...brand, level1: { fillOpacity: 2 } })).toThrow(/fillOpacity/);
    expect(() => plugin.registerTheme({ ...brand, branchColors: [] })).toThrow(/branchColors/);
    expect(() => new MindmapPlugin({ themes: [{ ...brand, line: '???' }] })).toThrow(/line/);
  });
});

describe('导图曲线', () => {
  it('两端水平切出，垂直落差再大也不冲过两端 (曲线上的点都在起点与终点的水平范围内)', () => {
    const router = new MindmapBranchRouter();
    for (const end of [
      { x: 56, y: 600 },
      { x: -56, y: -400 },
      { x: 56, y: 0 }
    ]) {
      const { points } = router.route({ start: { point: { x: 0, y: 0 } }, end: { point: end }, style: {} });
      const [min, max] = [Math.min(0, end.x), Math.max(0, end.x)];
      expect(points.every((p) => p.x >= min - 1e-9 && p.x <= max + 1e-9)).toBe(true);
      expect(points.at(-1)).toEqual(end);
    }
  });
});

describe('大纲解析', () => {
  it('识别缩进、Markdown 列表与标题；单个顶层条目即中心主题，多个时补一个中心主题', () => {
    expect(parseOutline('# 计划\n## 文档\n- README\n- 指南\n## 插件')).toEqual({
      text: '计划',
      children: [
        {
          text: '文档',
          children: [
            { text: 'README', children: [] },
            { text: '指南', children: [] }
          ]
        },
        { text: '插件', children: [] }
      ]
    });
    expect(parseOutline('- 甲\n\t- 甲1\n- 乙')).toEqual({
      text: '中心主题',
      children: [
        { text: '甲', children: [{ text: '甲1', children: [] }] },
        { text: '乙', children: [] }
      ]
    });
  });

  it('没有层级标记的多行文字、单行文字不当作大纲', () => {
    expect(parseOutline('第一行\n第二行')).toBeNull();
    expect(parseOutline('- 只有一行')).toBeNull();
  });
});
