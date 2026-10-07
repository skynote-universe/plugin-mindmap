/**
 * @file plugin.ts
 * @description 思维导图插件：注册主题节点与导图布局，提供 Tab / Enter 插入主题、拖动改挂与粘贴 (到选中主题下或生成新导图)
 *
 * 设计考量 (Why):
 * 1. 只依赖内核公开协议，不引用其他插件 (新建主题按类型名使用基础形状，不引用其代码)：分支线由分支线来源按布局的 branch() 绘制，新主题的文字编辑经会话的
 *    编辑请求交给文字编辑插件；不含任何授权判断 (由宿主的 FeatureGate 决定是否装配)。
 * 2. 写入一律经文档命令：插入、改挂、拖出都是普通的节点修改，排版在同一事务内派生，一步撤销、协同一致。
 * 3. 拖动成员不移动它本身 (位置归布局)：插件以高于选择的优先级认领指针，拖动时只画预览，松手才改挂；
 *    拖到导图之外即脱离，有子主题的成为一张新导图，没有的成为独立卡片。
 * 4. 公开命令 (查询、导图参数与主题、插入、展开、取消) 供宿主界面调用；键盘与拖动也走同一组命令，行为一致。
 * 5. 主题外观写在主题节点上：切换主题时整张导图一并写入；插入、粘贴大纲、改挂后按新位置套用，与操作同一步撤销。
 * 6. 选中导图中的单个主题时，粘贴的内容都挂到它下面 (与 XMind 一致)；没有选中主题时，复制的分支按内核规则
 *    成为独立的导图，带层级的文字生成一张新导图。
 * 7. 主题开放注册 (构造参数或 registerTheme)：主题集合变化时重新登记布局，经内核的布局变化通知刷新已打开导图的分支线。
 */

import {
  NODE_CLIPBOARD_MIME,
  buildLayoutTree,
  computeNodeWorldBounds,
  findLayoutRootId,
  generateKeyBetween,
  isPointInBounds,
  parseNodeClipboard,
  sortSiblingsByLayer,
  type CanvasKeyboardEvent,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type ClipboardData,
  type LayoutMember,
  type LayoutDefinition,
  type LayoutTree,
  type NodeClipboardPayload,
  type NodeEntity,
  type Point,
  type PointerHooks,
  type RectBounds,
  type SkyNotePlugin
} from '@skynote/core';
import {
  MINDMAP_LAYOUT_ID,
  chooseSideForNewTopic,
  firstLevelOf,
  createMindmapLayout,
  parseMindmapOptions,
  reattachTopic,
  resolveSides,
  type MindmapOptions,
  type TopicSide
} from './layout';
import { parseOutline, parseTopicList, type OutlineTopic } from './outline';
import { MindmapBranchRouter } from './branch-router';
import { MindmapThemeRegistry, type MindmapThemeDefinition, type MindmapThemeInfo } from './themes';

export const MINDMAP_PLUGIN_ID = '@skynote-pro/plugin-mindmap';

/** 高于选择 (0)、低于变换控制柄 (50) 与文字编辑 (60)：控制柄与双击编辑照常优先 */
const DRAG_PRIORITY = 40;
/** 高于编辑快捷键 (0) 与连线工具 (10)，低于文字编辑 (1000)：编辑文字时 Enter / Tab 归编辑器 */
const KEY_PRIORITY = 20;
/** 高于基础剪贴板 (0)：粘贴到选中主题下与大纲文本先由导图处理，其余交回 */
const CLIPBOARD_PRIORITY = 10;
const DRAG_THRESHOLD_PX = 4;
const PREVIEW_SESSION = 'mindmap:drag';
/** 大纲粘贴生成的主题之间的错位：真正的位置由布局排定，这里只为了新建时不重叠 */
const OUTLINE_STEP = 10;
/** 展开为独立导图时，新导图与原导图之间的距离 */
const DETACH_GAP = 80;
/**
 * 新建的主题用基础形状的圆角矩形：导图不自带节点类型，没装导图插件时文字照常显示；
 * 尺寸固定 (长文字可手动拉宽)，其他已注册的节点同样可以当主题
 */
const TOPIC_NODE_TYPE = 'shape';
const TOPIC_SIZE = { width: 120, height: 48 };
const ROOT_SIZE = { width: 160, height: 56 };

interface TopicRequest {
  text: string;
  parentId?: string;
  x: number;
  y: number;
  origin?: 'center';
  /** 作为一张新导图的中心主题 (带布局声明)；否则为成员 */
  root?: boolean;
  /** 第一层成员所在侧 */
  side?: TopicSide;
}

interface DragGesture {
  readonly pointerId: number;
  readonly member: LayoutMember;
  readonly startClient: Point;
  readonly startWorld: Point;
  /** 被拖主题的世界外框 (预览随指针平移) */
  readonly bounds: RectBounds;
  dragging: boolean;
  /** 松手后成为其子主题的目标；null 表示拖出导图 */
  target: Readonly<NodeEntity> | null;
  last: Point;
}

export interface MindmapPluginOptions {
  /** 额外的主题 (与内置主题同 id 即覆盖) */
  themes?: readonly MindmapThemeDefinition[];
}

export class MindmapPlugin implements SkyNotePlugin, PointerHooks {
  readonly id = MINDMAP_PLUGIN_ID;
  readonly name = '思维导图';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  private drag: DragGesture | null = null;
  private readonly themes: MindmapThemeRegistry;
  private readonly layout: LayoutDefinition;
  private releaseThemes: (() => void) | null = null;

  /** @throws 传入的主题定义不合法 */
  constructor(options?: MindmapPluginOptions) {
    this.themes = new MindmapThemeRegistry(options?.themes);
    this.layout = createMindmapLayout(this.themes);
  }

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerConnectorRouter(new MindmapBranchRouter());
    ctx.registerLayout(this.layout);
    // 主题变了，分支线颜色随之变：重新登记布局即触发内核刷新分支线 (不需要知道分支线来源是谁)
    this.releaseThemes = this.themes.onChange(() => ctx.registerLayout(this.layout));
    ctx.registerInputScope({ id: 'mindmap:keys', priority: KEY_PRIORITY, onKeyDown: (e) => this.onKeyDown(e) });
    ctx.registerPointerHooks(this, DRAG_PRIORITY);
    ctx.registerClipboardHandler({ paste: (data) => this.paste(data) }, CLIPBOARD_PRIORITY);
  }

  unmount(): void {
    this.drag = null;
    this.releaseThemes?.();
    this.releaseThemes = null;
  }

  // ================= 导图上下文 =================

  private readonly getNode = (id: string): Readonly<NodeEntity> | undefined => this.ctx.document.getNode(id);

  private readonly childrenOf = (parentId: string): Readonly<NodeEntity>[] =>
    sortSiblingsByLayer([...this.ctx.entities.getChildIds(parentId)].map((id) => this.getNode(id)!));

  /** 节点所在的导图 (自身是导图的根或成员)；不在导图中时为 undefined */
  private mindmapOf(nodeId: string): { tree: LayoutTree; member: LayoutMember } | undefined {
    const rootId = findLayoutRootId(nodeId, this.getNode);
    const root = rootId === undefined ? undefined : this.getNode(rootId);
    if (!root || root.layout?.type !== MINDMAP_LAYOUT_ID) return undefined;
    const tree = buildLayoutTree(root, this.childrenOf, this.layout);
    const member = tree.get(nodeId);
    return member && { tree, member };
  }

  // ================= 公开命令 (宿主界面调用) =================

  /** 节点所在导图的中心主题 id；不在导图中时为 undefined */
  mindmapRootOf(nodeId: string): string | undefined {
    return this.mindmapOf(nodeId)?.tree.root.node.id;
  }

  /** 导图参数 (已补齐默认值) */
  getOptions(rootId: string): MindmapOptions {
    return parseMindmapOptions(this.getNode(rootId)?.layout?.options);
  }

  /** 全部主题 (内置与注册的) 的名称与预览色 */
  listThemes(): MindmapThemeInfo[] {
    return this.themes.list();
  }

  /**
   * 注册主题 (同 id 即覆盖)；已打开导图的分支线随之刷新，主题节点的外观在下次切换到该主题时写入
   * @returns 注销函数 (覆盖内置主题时，注销即恢复内置)
   * @throws 定义不合法
   */
  registerTheme(definition: MindmapThemeDefinition): () => void {
    return this.themes.register(definition);
  }

  /** 修改导图参数 (只改给出的项)，一步撤销；排版与分支线随之更新，换主题时整张导图的主题外观一并更新 */
  setOptions(rootId: string, patch: Partial<MindmapOptions>, label = '修改导图样式'): void {
    const root = this.getNode(rootId);
    if (root?.layout?.type !== MINDMAP_LAYOUT_ID) return;
    const options = { ...root.layout.options, ...patch };
    const { document } = this.ctx;
    document.batch(() => {
      document.updateNode(rootId, { layout: { type: MINDMAP_LAYOUT_ID, options } });
      if (patch.theme !== undefined) this.applyThemeToSubtree(rootId);
    }, label);
  }

  /** 以 point (世界坐标) 为中心新建一张导图并选中中心主题，一步撤销；返回中心主题 id */
  createMindmap(point: Point): string | null {
    const { document, session } = this.ctx;
    const id = document.batch(() => {
      const rootId = this.createTopic({ text: '中心主题', x: point.x, y: point.y, origin: 'center', root: true });
      if (rootId) this.applyThemeToSubtree(rootId);
      return rootId;
    }, '添加思维导图');
    if (id) session.setSelection({ nodeIds: [id], connectorIds: [] });
    return id;
  }

  /** 插入子主题并进入编辑；返回新主题 id */
  insertChild(nodeId: string): string | null {
    const found = this.mindmapOf(nodeId);
    const id = found ? this.createChild(found.tree, found.member) : null;
    if (id) this.ctx.session.requestTextEditing(id);
    return id;
  }

  /** 插入同级主题并进入编辑 (中心主题没有同级，插入子主题)；返回新主题 id */
  insertSibling(nodeId: string): string | null {
    const found = this.mindmapOf(nodeId);
    if (!found) return null;
    const { tree, member } = found;
    const id = member === tree.root ? this.createChild(tree, member) : this.createSibling(tree, member);
    if (id) this.ctx.session.requestTextEditing(id);
    return id;
  }

  /** 把分支展开为一张独立导图 (沿用原导图的样式)，放在原导图下方；没有子主题的分支成为独立卡片 */
  detachBranch(nodeId: string): boolean {
    const found = this.mindmapOf(nodeId);
    if (!found || found.member === found.tree.root) return false;
    const bounds = this.treeBounds(found.tree);
    const own = computeNodeWorldBounds(found.member.node, this.ctx.entities.getWorldTransform(nodeId)!);
    this.detach(
      found.tree,
      found.member,
      { x: bounds.left - own.left, y: bounds.bottom + DETACH_GAP - own.top },
      '展开为独立导图'
    );
    return true;
  }

  /** 取消导图：中心主题不再排版，子主题停在原位 */
  removeMindmap(rootId: string): void {
    if (this.getNode(rootId)?.layout?.type !== MINDMAP_LAYOUT_ID) return;
    this.ctx.document.updateNode(rootId, { layout: undefined }, { label: '取消思维导图' });
  }

  // ================= 键盘：Tab 子主题、Enter 同级主题 =================

  private onKeyDown(e: CanvasKeyboardEvent): boolean {
    if ((e.key !== 'Tab' && e.key !== 'Enter') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    const { session } = this.ctx;
    if (session.selectedNodeIds.size !== 1 || session.selectedConnectorIds.size > 0) return false;
    const nodeId = [...session.selectedNodeIds][0];
    if (this.mindmapRootOf(nodeId) === undefined) return false;
    e.preventDefault();
    if (e.key === 'Tab') this.insertChild(nodeId);
    else this.insertSibling(nodeId);
    return true;
  }

  /** 新建一个主题 (圆角矩形)：中心主题带布局声明与更醒目的文字，成员带成员标记 */
  private createTopic({ text, root, side, ...placement }: TopicRequest): string | null {
    const { document } = this.ctx;
    const id = document.createNode({
      nodeType: TOPIC_NODE_TYPE,
      ...placement,
      ...(root ? ROOT_SIZE : TOPIC_SIZE),
      options: { geometry: 'rectangle', label: text }
    });
    if (!id) return null;
    document.updateNode(
      id,
      root
        ? { layout: { type: MINDMAP_LAYOUT_ID }, style: { radius: 12 }, textStyle: { fontSize: 20, fontWeight: 700 } }
        : { layoutItem: side ? { side } : {}, style: { radius: 8 } }
    );
    return id;
  }

  /** 新主题排在父主题的子主题最后；第一层主题放到当前较轻的一侧 */
  private createChild(tree: LayoutTree, parent: LayoutMember): string | null {
    const side = parent === tree.root ? chooseSideForNewTopic(tree) : undefined;
    const { document } = this.ctx;
    return document.batch(() => {
      const id = this.createTopic({ text: '分支主题', parentId: parent.node.id, x: 0, y: 0, side });
      if (id) this.applyThemeToSubtree(id);
      return id;
    }, '插入子主题');
  }

  /** 新主题紧跟在当前主题之后，与它同侧 */
  private createSibling(tree: LayoutTree, member: LayoutMember): string | null {
    const parent = member.parent!;
    const index = parent.children.indexOf(member);
    const next = parent.children[index + 1]?.node.zIndex ?? null;
    const side = parent === tree.root ? resolveSides(tree).get(member.node.id) : undefined;
    const { document } = this.ctx;
    return document.batch(() => {
      const id = this.createTopic({ text: '分支主题', parentId: parent.node.id, x: 0, y: 0, side });
      if (id) {
        document.updateNode(id, { zIndex: generateKeyBetween(member.node.zIndex, next) });
        this.applyThemeToSubtree(id);
      }
      return id;
    }, '插入同级主题');
  }

  // ================= 拖动改挂 =================

  onPointerDown(e: CanvasPointerEvent): void {
    if (e.isClaimed || e.button !== 0 || e.modifiers.shift || !e.target || this.drag) return;
    const found = this.mindmapOf(e.target.id);
    // 根的位置归用户：拖动根交给选择插件，整张导图随之移动
    if (!found || found.member === found.tree.root || found.member.node.locked) return;
    const { node } = found.member;
    this.ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });
    this.drag = {
      pointerId: e.pointerId,
      member: found.member,
      startClient: e.clientPoint,
      startWorld: e.point,
      bounds: computeNodeWorldBounds(node, this.ctx.entities.getWorldTransform(node.id)!),
      dragging: false,
      target: null,
      last: e.point
    };
    e.claimPointer(MINDMAP_PLUGIN_ID);
    this.ctx.host.capturePointer(e.pointerId);
  }

  onPointerMove(e: CanvasPointerEvent): void {
    const { drag, ctx } = this;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.dragging) {
      if (Math.hypot(e.clientPoint.x - drag.startClient.x, e.clientPoint.y - drag.startClient.y) < DRAG_THRESHOLD_PX)
        return;
      drag.dragging = true;
      ctx.host.setCursor('grabbing');
    }
    drag.last = e.point;
    const dragged = new Set([drag.member.node.id, ...ctx.entities.collectDescendantIds(drag.member.node.id)]);
    // 落点：指针下的导图主题 (同一张或另一张导图)，不能是被拖主题及其子树
    drag.target =
      ctx.hitTestNode(e.point, (node) => !dragged.has(node.id) && this.mindmapOf(node.id) !== undefined) ?? null;
    this.drawPreview(drag);
  }

  onPointerUp(e: CanvasPointerEvent): void {
    const { drag } = this;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.dragging) this.drop(drag);
    this.finish(e.pointerId);
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    if (this.drag?.pointerId === e.pointerId) this.finish(e.pointerId);
  }

  private finish(pointerId: number): void {
    this.drag = null;
    this.ctx.host.overlay.clear(PREVIEW_SESSION);
    this.ctx.host.releasePointer(pointerId);
    this.ctx.host.setCursor('default');
  }

  /** 预览：被拖主题的虚线框随指针移动；落点主题加粗描边 */
  private drawPreview(drag: DragGesture): void {
    const { theme, viewport } = this.ctx.session;
    const strokeWidth = 2 / viewport.zoom;
    const dx = drag.last.x - drag.startWorld.x;
    const dy = drag.last.y - drag.startWorld.y;
    const { bounds } = drag;
    const primitives: CanvasPrimitive[] = [
      {
        kind: 'rect',
        x: bounds.left + dx,
        y: bounds.top + dy,
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top,
        radius: 8,
        fill: theme.selectionStroke,
        fillOpacity: 0.12,
        stroke: theme.selectionStroke,
        strokeWidth,
        strokeDashArray: [6 / viewport.zoom, 4 / viewport.zoom]
      }
    ];
    if (drag.target) {
      const target = computeNodeWorldBounds(drag.target, this.ctx.entities.getWorldTransform(drag.target.id)!);
      primitives.push({
        kind: 'rect',
        x: target.left,
        y: target.top,
        width: target.right - target.left,
        height: target.bottom - target.top,
        radius: 8,
        stroke: theme.selectionStroke,
        strokeWidth: strokeWidth * 1.5
      });
    }
    this.ctx.host.overlay.setPrimitives(PREVIEW_SESSION, primitives, { transient: true });
  }

  /**
   * 落在主题上：改挂为它的最后一个子主题 (可以跨导图)；落回原父主题等于移到最后
   * 拖到导图之外：脱离导图停在松手处，有子主题的成为一张新导图，没有的成为独立卡片
   */
  private drop(drag: DragGesture): void {
    const { document } = this.ctx;
    const { member } = drag;
    const id = member.node.id;
    if (drag.target) {
      const found = this.mindmapOf(drag.target.id)!;
      const fields = reattachTopic(member, drag.target, found.tree);
      if (!fields) return;
      document.batch(() => {
        document.updateNode(id, fields);
        // 层级与所在分支可能变了：按新位置套用主题外观
        this.applyThemeToSubtree(id);
      }, '移动主题');
      return;
    }
    // 松手处没有落点，但仍在原导图的外框内 (如主题之间的空隙)：视为放弃，不脱离
    const { tree } = this.mindmapOf(id)!;
    if (isPointInBounds(drag.last, this.treeBounds(tree))) return;
    this.detach(tree, member, { x: drag.last.x - drag.startWorld.x, y: drag.last.y - drag.startWorld.y }, '拖出主题');
  }

  /** 分支脱离导图并按世界位移 offset 移动：有子主题的成为沿用原样式的新导图，没有的成为独立卡片 */
  private detach(tree: LayoutTree, member: LayoutMember, offset: Point, label: string): void {
    const { document } = this.ctx;
    const id = member.node.id;
    const options = tree.root.node.layout?.options;
    document.batch(() => {
      document.reparentNodes([id], undefined);
      document.updateNode(id, {
        layoutItem: undefined,
        ...(member.children.length > 0 && { layout: { type: MINDMAP_LAYOUT_ID, ...(options && { options }) } })
      });
      document.moveEntities({ nodeIds: [id] }, offset);
    }, label);
  }

  /**
   * 按所在导图的主题，给该节点及其子树中的主题写入外观 (显式写 undefined 的项回到默认)
   * 只写主题规定的项 (底色、不透明度、边框、文字色)，其余样式保留
   */
  private applyThemeToSubtree(nodeId: string): void {
    const found = this.mindmapOf(nodeId);
    if (!found) return;
    const { tree, member } = found;
    const theme = (tree.options as MindmapOptions).theme;
    const looks = new Map<string, ReturnType<MindmapThemeRegistry['topicStyle']>>();
    const visit = (current: LayoutMember): void => {
      const top = firstLevelOf(current);
      looks.set(
        current.node.id,
        this.themes.topicStyle(theme, current.depth, top ? tree.root.children.indexOf(top) : -1)
      );
      current.children.forEach(visit);
    };
    visit(member);
    this.ctx.document.updateNodes([...looks.keys()], (node) => {
      const look = looks.get(node.id)!;
      const textStyle = Object.fromEntries(
        Object.entries({ ...node.textStyle, ...look.textStyle }).filter(([, value]) => value !== undefined)
      );
      return { style: look.style, textStyle };
    });
  }

  /** 整张导图 (根与全部成员) 的世界外框 */
  private treeBounds(tree: LayoutTree): RectBounds {
    const bounds: RectBounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    const visit = (member: LayoutMember): void => {
      const b = computeNodeWorldBounds(member.node, this.ctx.entities.getWorldTransform(member.node.id)!);
      bounds.left = Math.min(bounds.left, b.left);
      bounds.top = Math.min(bounds.top, b.top);
      bounds.right = Math.max(bounds.right, b.right);
      bounds.bottom = Math.max(bounds.bottom, b.bottom);
      member.children.forEach(visit);
    };
    visit(tree.root);
    return bounds;
  }

  // ================= 粘贴 =================

  /**
   * 选中导图中的单个主题时：画布内容成为它的子主题，文字每行一个子主题 (有层级标记时按层级嵌套)；
   * 否则带层级的文字生成一张新导图，其余交回其他处理者 (复制的分支由内核处理为独立导图)
   */
  private paste(data: ClipboardData): boolean {
    const [selectedId, ...others] = this.ctx.session.selectedNodeIds;
    const target = selectedId === undefined || others.length > 0 ? undefined : this.mindmapOf(selectedId);
    const json = data[NODE_CLIPBOARD_MIME];
    if (json !== undefined) {
      if (!target) return false;
      const parsed = parseNodeClipboard(json);
      return parsed.ok && this.pasteNodesInto(target.member, parsed.value);
    }
    const text = data['text/plain'];
    if (!text) return false;
    return target ? this.pasteTextInto(target.member, text) : this.pasteOutline(text);
  }

  /** 最顶层节点成为子主题，整棵子树并入导图 (复制来的独立导图去掉布局声明，不再自成一棵树) */
  private pasteNodesInto(parent: LayoutMember, payload: NodeClipboardPayload): boolean {
    const ids = new Set(payload.nodes.map((node) => node.id));
    const nodes = payload.nodes.map((node): NodeEntity => {
      if (node.parentId !== undefined && ids.has(node.parentId)) return node;
      const { layout: _layout, ...rest } = node;
      return { ...rest, layoutItem: {} };
    });
    const { document, session } = this.ctx;
    const pasted = document.batch(() => {
      const result = document.pasteEntities({ ...payload, nodes }, { x: 0, y: 0 }, { parentId: parent.node.id });
      for (const id of result.nodeIds) this.applyThemeToSubtree(id);
      return result;
    }, '粘贴为子主题');
    if (pasted.nodeIds.length === 0) return false;
    session.setSelection(pasted);
    return true;
  }

  private pasteTextInto(parent: LayoutMember, text: string): boolean {
    const topics = parseTopicList(text);
    if (topics.length === 0) return false;
    const { document, session } = this.ctx;
    const ids = document.batch(() => {
      const created = this.createOutlineChildren(parent.node.id, topics, parent.depth + 1);
      for (const id of created) this.applyThemeToSubtree(id);
      return created;
    }, '粘贴为子主题');
    session.setSelection({ nodeIds: ids, connectorIds: [] });
    return ids.length > 0;
  }

  /** 粘贴带层级的纯文本 (缩进、列表、标题)：在视口中央生成一张导图；普通文字交回其他处理者 */
  private pasteOutline(text: string): boolean {
    const outline = parseOutline(text);
    if (!outline) return false;
    const { document, session } = this.ctx;
    const center = session.viewportCenter;
    const rootId = document.batch(() => {
      const id = this.createTopic({ text: outline.text, x: center.x, y: center.y, origin: 'center', root: true });
      if (id) {
        this.createOutlineChildren(id, outline.children, 1);
        this.applyThemeToSubtree(id);
      }
      return id;
    }, '粘贴大纲');
    if (rootId) session.setSelection({ nodeIds: [rootId], connectorIds: [] });
    return rootId !== null;
  }

  /** @returns 新建的这一层主题 id */
  private createOutlineChildren(parentId: string, topics: readonly OutlineTopic[], depth: number): string[] {
    const ids: string[] = [];
    topics.forEach((topic, index) => {
      const id = this.createTopic({ text: topic.text, parentId, x: index * OUTLINE_STEP, y: depth * OUTLINE_STEP });
      if (!id) return;
      ids.push(id);
      this.createOutlineChildren(id, topic.children, depth + 1);
    });
    return ids;
  }
}
