import { describe, expect, it } from 'vitest';
import { SkyNoteEngine, buildLayoutTree, type CanvasKeyboardEvent } from '@skynote/core';
import { BasicNodesPlugin, BranchConnectorsPlugin, ClipboardPlugin, setFrameAutoLayout } from '@skynote/plugins-basic';
import { MindmapPlugin } from '../src/plugin';

function setup() {
  const plugin = new MindmapPlugin();
  const engine = new SkyNoteEngine()
    .use(new BasicNodesPlugin())
    .use(new BranchConnectorsPlugin())
    .use(new ClipboardPlugin())
    .use(plugin);
  const store = engine.documentStore;
  const root = plugin.createMindmap({ x: 0, y: 0 })!;
  plugin.setOptions(root, { structure: 'right' });
  const branch = plugin.insertChild(root)!;
  const leaf = plugin.insertChild(branch)!;
  const sibling = plugin.insertChild(root)!;
  store.clearHistory();
  return { engine, store, plugin, root, branch, leaf, sibling };
}

describe('导图折叠', () => {
  it('折叠后的可见占位同步到外层自动布局；适应内容不重新包裹隐藏分支', () => {
    const { engine, store, plugin, root, branch } = setup();
    const frame = store.createNode({ nodeType: 'frame', x: 0, y: 0, width: 2000, height: 1000 })!;
    store.reparentNodes([root], frame);
    setFrameAutoLayout(store, engine.entityStore, [frame], { direction: 'horizontal', padding: 24, gap: 20 });
    const before = store.getNode(frame)!.width;
    plugin.setCollapsed(branch, true);
    const after = store.getNode(frame)!.width;
    expect(after).toBeLessThan(before);
    setFrameAutoLayout(store, engine.entityStore, [frame], null);
    store.fitContent([frame]);
    expect(store.getNode(frame)!.width).toBe(after);
  });

  it('粘贴到折叠主题时同一步展开，撤销后恢复原状态', () => {
    const { engine, store, plugin, branch, leaf } = setup();
    plugin.setCollapsed(branch, true);
    engine.session.setSelection({ nodeIds: [branch], connectorIds: [] });
    store.clearHistory();
    expect(engine.clipboard.paste({ 'text/plain': '甲\n乙' })).toBe(true);
    expect(plugin.getFoldState(branch)).toEqual({ collapsed: false, descendants: 3 });
    expect(engine.visibility.isNodeVisible(leaf)).toBe(true);
    expect(store.undoEntries).toHaveLength(1);
    store.undo();
    expect(plugin.getFoldState(branch)).toEqual({ collapsed: true, descendants: 1 });
    expect(engine.visibility.isNodeVisible(leaf)).toBe(false);
  });

  it('数量缓存在事务中重算，失败事务不污染事务外计数', () => {
    const { store, plugin, root } = setup();
    expect(plugin.getFoldState(root)?.descendants).toBe(3);
    expect(() =>
      store.batch(() => {
        plugin.insertChild(root);
        expect(plugin.getFoldState(root)?.descendants).toBe(4);
        throw new Error('取消');
      }, '取消插入')
    ).toThrow('取消');
    expect(plugin.getFoldState(root)?.descendants).toBe(3);
  });

  it('隐藏后代及其分支线，保留逻辑树；可见范围、命中和整图选区随之收缩', () => {
    const { engine, store, plugin, root, branch, leaf } = setup();
    const before = engine.spatialIndex.getContentBounds()!;
    const leafBounds = engine.getNodeWorldBounds(leaf)!;
    plugin.setCollapsed(branch, true);
    expect(store.getNode(leaf)).toBeDefined();
    expect(engine.visibility.isNodeVisible(branch)).toBe(true);
    expect(engine.visibility.isNodeVisible(leaf)).toBe(false);
    expect(engine.spatialIndex.getBounds(leaf)).toBeUndefined();
    expect(engine.spatialIndex.search(leafBounds)).not.toContain(leaf);
    expect(engine.connectorSpatialIndex.search(before)).toHaveLength(2);
    expect(engine.spatialIndex.getContentBounds()!.right).toBeLessThan(before.right);
    expect(store.selectionGeometry.getSubtreeBounds(root)!.right).toBeLessThan(before.right);
    expect(plugin.getFoldState(branch)).toEqual({ collapsed: true, descendants: 1 });
    const fullTree = buildLayoutTree(
      store.getNode(root)!,
      (id) => [...engine.entityStore.getChildIds(id)].map((child) => store.getNode(child)!),
      engine.layouts.get('mindmap')
    );
    expect(fullTree.get(leaf)).toBeDefined();
    plugin.setCollapsed(branch, false);
    expect(engine.visibility.isNodeVisible(leaf)).toBe(true);
    expect(engine.connectorSpatialIndex.search(engine.spatialIndex.getContentBounds()!)).toHaveLength(3);
  });

  it('普通内容不随当前主题折叠；隐藏主题的普通内容随其一起隐藏', () => {
    const { engine, store, plugin, branch, leaf } = setup();
    const ownContent = store.createNode({ nodeType: 'shape', parentId: branch, x: 0, y: 0 })!;
    const hiddenContent = store.createNode({ nodeType: 'shape', parentId: leaf, x: 0, y: 0 })!;
    plugin.setCollapsed(branch, true);
    expect(engine.visibility.isNodeVisible(ownContent)).toBe(true);
    expect(engine.visibility.isNodeVisible(hiddenContent)).toBe(false);
  });

  it('隐藏主题与外部节点之间的普通连线也隐藏，展开后恢复', () => {
    const { engine, store, plugin, branch, leaf, sibling } = setup();
    const connector = store.createConnector({
      connectorType: 'straight',
      from: { nodeId: leaf },
      to: { nodeId: sibling }
    })!;
    const bounds = engine.spatialIndex.getContentBounds()!;
    expect(engine.connectorSpatialIndex.search(bounds)).toContain(connector);
    plugin.setCollapsed(branch, true);
    expect(engine.connectorSpatialIndex.search(bounds)).not.toContain(connector);
    expect(store.getConnector(connector)).toBeDefined();
    plugin.setCollapsed(branch, false);
    expect(engine.connectorSpatialIndex.search(bounds)).toContain(connector);
  });

  it('选中的后代收拢到最近可见祖先，并结束隐藏主题的编辑', () => {
    const { engine, plugin, branch, leaf } = setup();
    engine.session.setSelection({ nodeIds: [leaf], connectorIds: [] });
    engine.session.setTextEditing({ kind: 'node', id: leaf, blockId: 'text', scrollY: 0, composition: null });
    plugin.setCollapsed(branch, true);
    expect([...engine.session.selectedNodeIds]).toEqual([branch]);
    expect(engine.session.textEditing).toBeNull();
  });

  it('按层级显示与展开全部各只产生一步历史；撤销和重做恢复可见性', () => {
    const { engine, store, plugin, root, branch, leaf } = setup();
    plugin.expandToDepth(root, 2);
    expect(engine.visibility.isNodeVisible(branch)).toBe(true);
    expect(engine.visibility.isNodeVisible(leaf)).toBe(false);
    expect(store.undoEntries).toHaveLength(1);
    plugin.expandAll(root);
    expect(engine.visibility.isNodeVisible(leaf)).toBe(true);
    expect(store.undoEntries).toHaveLength(2);
    store.undo();
    expect(engine.visibility.isNodeVisible(leaf)).toBe(false);
    store.undo();
    expect(engine.visibility.isNodeVisible(leaf)).toBe(true);
    store.redo();
    expect(engine.visibility.isNodeVisible(leaf)).toBe(false);
    plugin.expandToDepth(root, 1);
    expect(engine.visibility.isNodeVisible(branch)).toBe(false);
    expect(engine.spatialIndex.search(engine.spatialIndex.getContentBounds()!)).toEqual([root]);
  });

  it('在折叠主题下插入会在同一事务展开父主题；撤销保留原折叠和内容', () => {
    const { engine, store, plugin, branch, leaf } = setup();
    plugin.setCollapsed(branch, true);
    store.clearHistory();
    const added = plugin.insertChild(branch)!;
    expect(engine.visibility.isNodeVisible(added)).toBe(true);
    expect(engine.visibility.isNodeVisible(leaf)).toBe(true);
    expect(store.undoEntries).toHaveLength(1);
    store.undo();
    expect(store.getNode(added)).toBeUndefined();
    expect(engine.visibility.isNodeVisible(leaf)).toBe(false);
  });

  it('搜索展开祖先路径，保留其他分支和目标自身的折叠；一步撤销', () => {
    const { engine, store, plugin, root, branch, leaf, sibling } = setup();
    const otherLeaf = plugin.insertChild(sibling)!;
    plugin.setCollapsed(sibling, true);
    plugin.setCollapsed(branch, true);
    plugin.setCollapsed(root, true);
    store.clearHistory();
    plugin.revealTopic(leaf);
    expect(engine.visibility.isNodeVisible(leaf)).toBe(true);
    expect(engine.visibility.isNodeVisible(otherLeaf)).toBe(false);
    expect(store.undoEntries).toHaveLength(1);
    store.undo();
    expect(engine.visibility.isNodeVisible(branch)).toBe(false);
  });

  it('复制和保存仍保留全部隐藏主题及折叠状态；重开和撤销删除不会丢失', () => {
    const { engine, store, plugin, root, branch, leaf } = setup();
    plugin.setCollapsed(branch, true);
    const copied = store.copyEntities({ nodeIds: [root] })!;
    expect(copied.nodes.map((node) => node.id)).toContain(leaf);
    expect(copied.nodes.find((node) => node.id === branch)?.layoutState?.collapsed).toBe(true);
    const reopened = new SkyNoteEngine({ initialDoc: JSON.parse(JSON.stringify(store.getView())) })
      .use(new BasicNodesPlugin())
      .use(new MindmapPlugin());
    expect(reopened.documentStore.getNode(leaf)).toBeDefined();
    expect(reopened.visibility.isNodeVisible(leaf)).toBe(false);
    store.removeEntities({ nodeIds: [root] });
    store.undo();
    expect(engine.visibility.isNodeVisible(leaf)).toBe(false);
    reopened.destroy();
  });

  it('改挂隐藏主题到可见分支会使它重新可见，撤销后再次隐藏', () => {
    const { engine, store, plugin, branch, leaf, sibling } = setup();
    plugin.setCollapsed(branch, true);
    store.reparentNodes([leaf], sibling);
    expect(engine.visibility.isNodeVisible(leaf)).toBe(true);
    store.undo();
    expect(engine.visibility.isNodeVisible(leaf)).toBe(false);
  });

  it('方向键跳过折叠后代', () => {
    const { engine, plugin, branch, leaf } = setup();
    plugin.setCollapsed(branch, true);
    engine.session.setSelection({ nodeIds: [branch], connectorIds: [] });
    engine.inputScopes.dispatchKeyDown({
      key: 'ArrowRight',
      preventDefault() {},
      stopPropagation() {}
    } as CanvasKeyboardEvent);
    expect(engine.session.selectedNodeIds.has(leaf)).toBe(false);
    expect(engine.session.selectedNodeIds.has(branch)).toBe(true);
  });

  it('只读、维护和锁定主题不会被折叠命令改写，非法层级不产生历史', () => {
    const { engine, store, plugin, root, branch } = setup();
    for (const level of [0, -1, NaN, 1.5]) plugin.expandToDepth(root, level);
    expect(store.undoEntries).toHaveLength(0);
    engine.session.setReadOnly(true);
    plugin.setCollapsed(branch, true);
    plugin.expandToDepth(root, 1);
    expect(store.undoEntries).toHaveLength(0);
    engine.session.setReadOnly(false);
    const maintenance = engine.beginMaintenance();
    plugin.setCollapsed(branch, true);
    plugin.expandAll(root);
    expect(store.undoEntries).toHaveLength(0);
    maintenance.resume();
    store.updateNode(branch, { locked: true });
    store.clearHistory();
    plugin.setCollapsed(branch, true);
    expect(store.undoEntries).toHaveLength(0);
  });

  it('取消导图后折叠不再影响可见性；重新转换后恢复折叠展示', () => {
    const { engine, store, plugin, root, branch, leaf } = setup();
    plugin.setCollapsed(branch, true);
    plugin.removeMindmap(root);
    expect(engine.visibility.isNodeVisible(leaf)).toBe(true);
    store.undo();
    expect(engine.visibility.isNodeVisible(leaf)).toBe(false);
  });
});
