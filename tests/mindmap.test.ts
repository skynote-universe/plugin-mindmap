/**
 * @file mindmap.test.ts
 * @description 思维导图：主题随文字伸缩、双向平衡排版、Tab / Enter 插入并请求编辑、分支线配色、
 *              拖动改挂与拖出、大纲解析与粘贴、任何节点都能当主题
 */

import { describe, it, expect, vi } from 'vitest';
import {
  NODE_CLIPBOARD_MIME,
  SkyNoteEngine,
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

describe('导图命令 (宿主界面调用)', () => {
  const commands = (engine: SkyNoteEngine) => engine.plugins.get(MINDMAP_PLUGIN_ID) as MindmapPlugin;

  it('导图参数：方向、线型、间距、主题各自生效，一步撤销；非法值回落默认', () => {
    const { engine, store, rootId } = setup();
    const mindmap = commands(engine);
    key(engine, 'Tab');
    const a = selected(engine);
    engine.session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    key(engine, 'Tab');
    const b = selected(engine);
    expect(mindmap.mindmapRootOf(b)).toBe(rootId);
    expect(mindmap.getOptions(rootId)).toEqual({
      direction: 'both',
      line: 'curve',
      spacing: 'standard',
      theme: 'fresh'
    });

    mindmap.setOptions(rootId, { direction: 'right' });
    expect(center(engine, b).x).toBeGreaterThan(center(engine, rootId).x);
    mindmap.setOptions(rootId, { line: 'elbow', spacing: 'loose', theme: 'minimal' });
    const branch = engine.entityStore.getConnector(`@branch:${a}`)!.entity;
    expect(branch.connectorType).toBe('orthogonal');
    expect(branch.style!.stroke).toBeUndefined();
    expect(store.getNode(a)!.x).toBe(store.getNode(rootId)!.width + 80);
    store.undo();
    expect(engine.entityStore.getConnector(`@branch:${a}`)!.entity.connectorType).toBe('mindmap:branch');

    store.updateNode(rootId, { layout: { type: 'mindmap', options: { direction: 'up', spacing: 3 } } });
    expect(mindmap.getOptions(rootId)).toMatchObject({ direction: 'both', spacing: 'standard' });
  });

  it('切换主题：整张导图的主题外观与分支线一并更新 (一步撤销)；之后插入的主题按层级套用当前主题', () => {
    const { engine, store, rootId } = setup();
    const mindmap = commands(engine);
    const a = mindmap.insertChild(rootId)!;
    const b = mindmap.insertChild(rootId)!;
    const a1 = mindmap.insertChild(a)!;
    // 默认主题 (清新)：第一层浅黄底
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$yellow', stroke: '$amber' });
    expect(mindmap.listThemes().map((theme) => theme.label)).toEqual(['清新', '彩虹', '海洋', '暖阳', '简约']);

    mindmap.setOptions(rootId, { theme: 'rainbow' });
    expect(store.getNode(rootId)!.style).toMatchObject({ fill: '$purple', stroke: '$violet' });
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$pink', stroke: '$red' });
    expect(store.getNode(b)!.style).toMatchObject({ fill: '$orange', stroke: '$amber' });
    expect(store.getNode(a1)!.style!.stroke).toBe('$red');
    expect(store.getNode(a)!.textStyle).toMatchObject({ color: '$ink' });
    expect(engine.entityStore.getConnector(`@branch:${b}`)!.entity.style!.stroke).toBe('$amber');

    const b1 = mindmap.insertChild(b)!;
    expect(store.getNode(b1)!.style!.stroke).toBe('$amber');

    // 撤销插入，再撤销换主题：回到清新
    store.undo();
    store.undo();
    expect(store.getNode(a)!.style).toMatchObject({ fill: '$yellow', stroke: '$amber' });
    expect(mindmap.getOptions(rootId).theme).toBe('fresh');
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
      'fresh',
      'rainbow',
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
    const restore = plugin.registerTheme({ ...brand, id: 'fresh', label: '清新 (品牌)' });
    expect(plugin.listThemes()[0].label).toBe('清新 (品牌)');
    restore();
    expect(plugin.listThemes()[0].label).toBe('清新');

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
