/**
 * @file plugin.ts
 * @description 思维导图插件：注册导图布局，提供 Tab / Enter 插入主题、Delete 删除后选中相邻主题、方向键切换主题、拖动改挂与排序、
 *              粘贴 (到选中主题下或生成新导图)
 *
 * 设计考量 (Why):
 * 1. 只依赖内核公开协议，不引用其他插件 (新建主题按类型名使用基础形状，不引用其代码)：分支线由分支线来源按布局的 edge() 绘制，新主题的文字编辑经会话的
 *    编辑请求交给文字编辑插件；不含任何授权判断 (由宿主的 FeatureGate 决定是否装配)。
 * 2. 写入一律经文档命令：插入、改挂、拖出都是普通的节点修改，排版在同一事务内派生，一步撤销、协同一致。
 * 3. 拖动成员不移动它本身 (位置归布局)：插件以高于选择的优先级认领指针，拖动时只画预览，松手才改挂或调整顺序；
 *    靠近哪个主题就吸附到哪个 (见 drop.ts)，示意将成为子主题 (占位框) 还是插到同级之间 (插入线)；
 *    附近没有主题且拖到导图之外即脱离，有子主题的成为一张新导图，没有的成为独立卡片。
 * 4. 公开命令 (查询、导图参数与主题、插入、展开、取消) 供宿主界面调用；键盘与拖动也走同一组命令，行为一致。
 * 5. 主题外观写在主题节点上：切换主题时整张导图一并写入；插入、粘贴大纲、改挂后按新位置套用，与操作同一步撤销。
 * 6. 选中导图中的单个主题时，粘贴的内容都挂到它下面 (与 XMind 一致)；没有选中主题时，复制的分支按内核规则
 *    成为独立的导图，带层级的文字生成一张新导图。
 * 7. 主题与结构开放注册 (构造参数或 registerTheme / registerStructure)：集合变化时重新登记布局，经内核的布局变化通知
 *    重新排版并刷新已打开导图的分支线。
 */

import {
  NODE_CLIPBOARD_MIME,
  applyMatrix,
  invertMatrix,
  multiplyMatrix,
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
  firstLevelOf,
  createMindmapLayout,
  parseMindmapOptions,
  isVerticalGrowth,
  type Growth,
  type MindmapLine,
  type MindmapOptions,
  type TopicSide
} from './layout';
import { parseOutline, parseTopicList, type OutlineTopic } from './outline';
import { isSamePlace, resolveTopicDrop, topicDropFields, type DropCandidate, type TopicDrop } from './drop';
import { previewStructure, type MindmapStructurePreview } from './structure-preview';
import { MindmapStructureRegistry, type MindmapStructureDefinition, type MindmapStructureInfo } from './structures';
import { MindmapBranchRouter } from './branch-router';
import { MindmapThemeRegistry, type MindmapThemeDefinition, type MindmapThemeInfo } from './themes';

export const MINDMAP_PLUGIN_ID = '@skynote-pro/plugin-mindmap';

/** 高于选择 (0)、低于变换控制柄 (50) 与文字编辑 (60)：控制柄与双击编辑照常优先 */
const DRAG_PRIORITY = 40;
/** 高于编辑快捷键 (0) 与连线工具 (10)，低于文字编辑 (1000)：编辑文字时 Enter / Tab / 方向键归编辑器 */
const KEY_PRIORITY = 20;
/** 高于基础剪贴板 (0)：粘贴到选中主题下与大纲文本先由导图处理，其余交回 */
const CLIPBOARD_PRIORITY = 10;
const DRAG_THRESHOLD_PX = 4;
const KEY_GROWTH: Readonly<Record<string, Growth>> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowDown: 'down',
  ArrowUp: 'up'
};
const OPPOSITE_GROWTH: Readonly<Record<Growth, Growth>> = { right: 'left', left: 'right', down: 'up', up: 'down' };
/** 被拖主题的外框离某个主题在此屏幕距离之内即吸附 */
const SNAP_DISTANCE_PX = 40;
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

/** 恢复主题样式的范围：只这个主题，或连同下级 */
export type TopicResetScope = 'topic' | 'subtree';

/** 一个主题在主题方案中应有的外观 */
type TopicLook = ReturnType<MindmapThemeRegistry['topicStyle']>;

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
  /** 当前落点；null 表示附近没有主题 (松手时拖出导图或放弃) */
  drop: TopicDrop | null;
  last: Point;
}

export interface MindmapPluginOptions {
  /** 额外的主题 (与内置主题同 id 即覆盖) */
  themes?: readonly MindmapThemeDefinition[];
  /** 额外的结构 (与内置结构同 id 即覆盖) */
  structures?: readonly MindmapStructureDefinition[];
}

export class MindmapPlugin implements SkyNotePlugin, PointerHooks {
  readonly id = MINDMAP_PLUGIN_ID;
  readonly name = '思维导图';
  readonly version = '0.1.0';
  private ctx!: CanvasPluginContext;
  private drag: DragGesture | null = null;
  private readonly themes: MindmapThemeRegistry;
  private readonly structures: MindmapStructureRegistry;
  private readonly layout: LayoutDefinition;
  private releaseRegistries: (() => void) | null = null;
  /**
   * 最近一次复制或剪切时，被复制主题 (含子树) 在原位置的主题外观，按原 id 记录。
   * 只为粘贴到主题下时区分主题写的样式与用户改过的样式 (规则同改挂)；跨标签页粘贴没有记录，整体套用目标主题
   */
  private readonly copiedLooks = new Map<string, TopicLook>();
  /**
   * 同一次复制中被选中主题的分支线设置 (layoutItem.branch，按原 id)：复制时内核去掉了最顶层的成员标记，
   * 粘贴到主题下时补回，与拖动改挂一致 (分支线样式会被子树继承，线上文字一并带着)
   */
  private readonly copiedBranches = new Map<string, unknown>();

  /** @throws 传入的主题或结构定义不合法 */
  constructor(options?: MindmapPluginOptions) {
    this.themes = new MindmapThemeRegistry(options?.themes);
    this.structures = new MindmapStructureRegistry(options?.structures);
    this.layout = createMindmapLayout(this.themes, this.structures);
  }

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerConnectorRouter(new MindmapBranchRouter());
    ctx.registerLayout(this.layout);
    // 主题或结构变了：重新登记布局即触发内核重新排版并刷新分支线 (不需要知道分支线来源是谁)
    const relayout = () => ctx.registerLayout(this.layout);
    const releaseThemes = this.themes.onChange(relayout);
    const releaseStructures = this.structures.onChange(relayout);
    this.releaseRegistries = () => {
      releaseThemes();
      releaseStructures();
    };
    ctx.registerInputScope({ id: 'mindmap:keys', priority: KEY_PRIORITY, onKeyDown: (e) => this.onKeyDown(e) });
    ctx.registerPointerHooks(this, DRAG_PRIORITY);
    // 复制与剪切只记下主题外观与分支线设置 (返回 null)，剪贴板内容仍由基础剪贴板生成
    ctx.registerClipboardHandler(
      {
        copy: () => this.rememberCopied(),
        cut: () => this.rememberCopied(),
        paste: (data) => this.paste(data)
      },
      CLIPBOARD_PRIORITY
    );
  }

  unmount(): void {
    this.drag = null;
    this.copiedLooks.clear();
    this.copiedBranches.clear();
    this.releaseRegistries?.();
    this.releaseRegistries = null;
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

  /** 导图参数 (已补齐默认值；线型未单独设置时为结构的默认线型) */
  getOptions(rootId: string): MindmapOptions & { line: MindmapLine } {
    const options = parseMindmapOptions(this.getNode(rootId)?.layout?.options);
    return { ...options, line: options.line ?? this.structures.get(options.structure).defaultLine };
  }

  /** 全部结构 (内置与注册的) 的名称、说明与示意图 */
  listStructures(): (MindmapStructureInfo & { preview: MindmapStructurePreview })[] {
    // 示意图用结构自己的排版排出样例树 (开发者注册的结构同样有准确的示意图)
    return this.structures.list().map((info) => ({ ...info, preview: previewStructure(this.structures.get(info.id)) }));
  }

  /**
   * 注册结构 (同 id 即覆盖)；已打开且使用该结构的导图随之重新排版
   * @returns 注销函数 (覆盖内置结构时，注销即恢复内置)
   * @throws 定义不合法
   */
  registerStructure(definition: MindmapStructureDefinition): () => void {
    return this.structures.register(definition);
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

  /**
   * 修改导图参数 (只改给出的项)，一步撤销；排版与分支线随之更新，换主题时整张导图的主题外观一并更新。
   * 换结构而没有同时指定线型时，去掉单独设置的线型，改用新结构的默认线型 (如组织结构图用折线)
   */
  setOptions(rootId: string, patch: Partial<MindmapOptions>, label = '修改导图样式'): void {
    const root = this.getNode(rootId);
    if (root?.layout?.type !== MINDMAP_LAYOUT_ID) return;
    const options: Record<string, unknown> = { ...root.layout.options, ...patch };
    if (patch.structure !== undefined && !('line' in patch)) delete options.line;
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

  /**
   * 恢复主题样式：按所在导图的主题重新写入外观 (底色、不透明度、边框、文字色)，单独的修改被覆盖。
   * scope 为 topic 时只恢复这个主题，subtree (缺省) 时连同下级。分支线上的自定义由分支线插件清除 (宿主把两者放进同一次撤销)
   */
  resetTopicStyle(nodeId: string, scope: TopicResetScope = 'subtree'): void {
    this.ctx.document.batch(() => this.applyThemeToSubtree(nodeId, undefined, scope), '恢复主题样式');
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
    const insert = e.key === 'Tab' || e.key === 'Enter';
    const remove = e.key === 'Delete' || e.key === 'Backspace';
    if ((!insert && !remove && !(e.key in KEY_GROWTH)) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)
      return false;
    const { session } = this.ctx;
    if (session.selectedNodeIds.size !== 1 || session.selectedConnectorIds.size > 0) return false;
    const nodeId = [...session.selectedNodeIds][0];
    const found = this.mindmapOf(nodeId);
    if (!found) return false;
    // 删除中心主题 (整张导图) 或锁定的主题交给通用的删除处理
    if (remove && (found.member === found.tree.root || found.member.node.locked)) return false;
    e.preventDefault();
    if (e.key === 'Tab') this.insertChild(nodeId);
    else if (e.key === 'Enter') this.insertSibling(nodeId);
    else if (remove) this.deleteTopic(found.tree, found.member);
    else this.navigate(found.tree, found.member, e.key);
    return true;
  }

  /**
   * 删除主题 (连同下级) 后选中相邻的主题：同方向的下一个同级，没有则上一个，再没有则父主题，
   * 用键盘连续整理时不必重新点选
   */
  private deleteTopic(tree: LayoutTree, member: LayoutMember): void {
    const parent = member.parent!;
    const growth = this.structures.of(tree).growth(tree);
    const siblings = parent.children.filter((child) => growth.get(child.node.id) === growth.get(member.node.id));
    const index = siblings.indexOf(member);
    const next = siblings[index + 1] ?? siblings[index - 1] ?? parent;
    const { document, session } = this.ctx;
    document.removeEntities({ nodeIds: [member.node.id], connectorIds: [] }, { label: '删除主题' });
    session.setSelection({ nodeIds: [next.node.id], connectorIds: [] });
  }

  /**
   * 方向键在主题之间移动选中 (位置归布局，导图里方向键不再微移)，按各主题的展开方向通用处理：
   * 与主题展开方向相反的键回到父主题；与之垂直的键切换同方向相邻的同级；其余进入朝该方向展开的最近子主题
   */
  private navigate(tree: LayoutTree, member: LayoutMember, key: string): void {
    const growth = this.structures.of(tree).growth(tree);
    const toward = KEY_GROWTH[key];
    const own = growth.get(member.node.id);
    let next: LayoutMember | undefined;
    if (own !== undefined && own === OPPOSITE_GROWTH[toward]) {
      next = member.parent;
    } else if (own !== undefined && isVerticalGrowth(own) !== isVerticalGrowth(toward)) {
      const siblings = member.parent!.children.filter((child) => growth.get(child.node.id) === own);
      next = siblings[siblings.indexOf(member) + (toward === 'up' || toward === 'left' ? -1 : 1)];
    } else {
      const children = member.children.filter((child) => growth.get(child.node.id) === toward);
      next = this.nearestAcross(tree, member, children, isVerticalGrowth(toward));
    }
    if (next) this.ctx.session.setSelection({ nodeIds: [next.node.id], connectorIds: [] });
  }

  /** 在兄弟排列方向上与 member 中心最接近的主题 (按导图根的局部坐标比较，整张图旋转后同样成立) */
  private nearestAcross(
    tree: LayoutTree,
    member: LayoutMember,
    candidates: readonly LayoutMember[],
    vertical: boolean
  ): LayoutMember | undefined {
    const { entities } = this.ctx;
    const toRoot = invertMatrix(entities.getWorldTransform(tree.root.node.id)!);
    const across = (m: LayoutMember): number => {
      const world = entities.getWorldTransform(m.node.id)!;
      const center = applyMatrix(multiplyMatrix(toRoot, world), m.node.width / 2, m.node.height / 2);
      return vertical ? center.x : center.y;
    };
    const target = across(member);
    let best: LayoutMember | undefined;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const distance = Math.abs(across(candidate) - target);
      if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
    }
    return best;
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

  /** 新主题排在父主题的子主题最后；需要记住侧的结构 (如双向) 由结构决定第一层主题放在哪一侧 */
  private createChild(tree: LayoutTree, parent: LayoutMember): string | null {
    const side = parent === tree.root ? this.structures.of(tree).newChildSide?.(tree) : undefined;
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
    const structure = this.structures.of(tree);
    const own = structure.growth(tree).get(member.node.id);
    const side =
      parent === tree.root && structure.newChildSide && (own === 'left' || own === 'right') ? own : undefined;
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
      drop: null,
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
    const ghost = this.ghostBounds(drag);
    const snap = SNAP_DISTANCE_PX / ctx.session.viewport.zoom;
    drag.drop = resolveTopicDrop(
      drag.member,
      ghost,
      this.dropCandidates(drag, ghost, snap),
      snap,
      (member) => computeNodeWorldBounds(member.node, ctx.entities.getWorldTransform(member.node.id)!),
      this.structures
    );
    this.drawPreview(drag, ghost);
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

  /** 被拖主题随指针平移后的世界外框 */
  private ghostBounds(drag: DragGesture): RectBounds {
    const dx = drag.last.x - drag.startWorld.x;
    const dy = drag.last.y - drag.startWorld.y;
    const { bounds } = drag;
    return { left: bounds.left + dx, top: bounds.top + dy, right: bounds.right + dx, bottom: bounds.bottom + dy };
  }

  /** 被拖主题附近的导图主题 (同一张或另一张导图)，不含被拖主题及其子树 */
  private dropCandidates(drag: DragGesture, ghost: RectBounds, snap: number): DropCandidate[] {
    const { entities, spatial } = this.ctx;
    const dragged = new Set([drag.member.node.id, ...entities.collectDescendantIds(drag.member.node.id)]);
    const area = {
      left: ghost.left - snap,
      top: ghost.top - snap,
      right: ghost.right + snap,
      bottom: ghost.bottom + snap
    };
    const candidates: DropCandidate[] = [];
    for (const id of spatial.search(area)) {
      if (dragged.has(id)) continue;
      const found = this.mindmapOf(id);
      if (found && !found.member.node.locked) candidates.push({ tree: found.tree, member: found.member });
    }
    return candidates;
  }

  /**
   * 预览：被拖主题的虚线框随指针移动；有落点时画示意
   * (成为子主题时在将要出现的位置画虚线占位框，成为同级时在目标上方或下方画插入线)
   */
  private drawPreview(drag: DragGesture, ghost: RectBounds): void {
    const { theme, viewport } = this.ctx.session;
    const strokeWidth = 2 / viewport.zoom;
    const dash = [6 / viewport.zoom, 4 / viewport.zoom];
    const box = (bounds: RectBounds, fillOpacity: number): CanvasPrimitive => ({
      kind: 'rect',
      x: bounds.left,
      y: bounds.top,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top,
      radius: 8,
      fill: theme.selectionStroke,
      fillOpacity,
      stroke: theme.selectionStroke,
      strokeWidth,
      strokeDashArray: dash
    });
    const primitives: CanvasPrimitive[] = [box(ghost, 0.06)];
    const indicator = drag.drop?.indicator;
    if (indicator?.kind === 'placeholder') primitives.push(box(indicator.bounds, 0.16));
    if (indicator?.kind === 'line') {
      primitives.push({
        kind: 'line',
        points: [indicator.from.x, indicator.from.y, indicator.to.x, indicator.to.y],
        stroke: theme.selectionStroke,
        strokeWidth: 3 / viewport.zoom,
        strokeCap: 'round'
      });
    }
    this.ctx.host.overlay.setPrimitives(PREVIEW_SESSION, primitives, { transient: true });
  }

  /**
   * 有落点：改挂为子主题或插到同级之间 (可以跨导图)；落回原处不产生修改
   * 附近没有主题：拖到导图之外即脱离、停在松手处，有子主题的成为一张新导图，没有的成为独立卡片
   */
  private drop(drag: DragGesture): void {
    const { document } = this.ctx;
    const { member } = drag;
    const id = member.node.id;
    if (drag.drop) {
      if (isSamePlace(member, drag.drop)) return;
      const fields = topicDropFields(member, drag.drop);
      // 先记下旧位置的主题外观：移动后只替换主题写的项，用户改过的保留
      const previous = this.subtreeLooks(id);
      document.batch(() => {
        document.updateNode(id, fields);
        // 层级与所在分支可能变了：按新位置套用主题外观
        this.applyThemeToSubtree(id, previous);
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

  /** 该节点及其子树中各主题在当前位置应有的主题外观；不在导图中时为 undefined */
  private subtreeLooks(nodeId: string): Map<string, TopicLook> | undefined {
    const found = this.mindmapOf(nodeId);
    if (!found) return undefined;
    const { tree, member } = found;
    const theme = (tree.options as MindmapOptions).theme;
    const looks = new Map<string, TopicLook>();
    const visit = (current: LayoutMember): void => {
      const top = firstLevelOf(current);
      looks.set(
        current.node.id,
        this.themes.topicStyle(theme, current.depth, top ? tree.root.children.indexOf(top) : -1)
      );
      current.children.forEach(visit);
    };
    visit(member);
    return looks;
  }

  /**
   * 按所在导图的主题，给该节点及其子树中的主题写入外观 (显式写 undefined 的项回到默认)
   * 只写主题规定的项 (底色、不透明度、边框、文字色)，其余样式保留。
   * 给出 previous (旧位置的主题外观) 时只替换主题写的项：当前值与旧主题值相同 (含都未设置) 视为主题写的，
   * 不同视为用户改过的，保留 (改挂、调整顺序、粘贴到主题下时用；切换主题整体套用)。scope 为 topic 时只写这个主题
   */
  private applyThemeToSubtree(
    nodeId: string,
    previous?: ReadonlyMap<string, TopicLook>,
    scope: TopicResetScope = 'subtree'
  ): void {
    const subtree = this.subtreeLooks(nodeId);
    if (!subtree) return;
    const looks = scope === 'subtree' ? subtree : new Map([[nodeId, subtree.get(nodeId)!]]);
    this.ctx.document.updateNodes([...looks.keys()], (node) => {
      const look = looks.get(node.id)!;
      const before = previous?.get(node.id);
      const owned = <T extends object>(next: Partial<T>, current: T | undefined, old: Partial<T> | undefined) =>
        Object.fromEntries(
          Object.entries(next).filter(([key]) => !old || current?.[key as keyof T] === old[key as keyof T])
        ) as Partial<T>;
      const textStyle = Object.fromEntries(
        Object.entries({ ...node.textStyle, ...owned(look.textStyle, node.textStyle, before?.textStyle) }).filter(
          ([, value]) => value !== undefined
        )
      );
      return { style: owned(look.style, node.style, before?.style), textStyle };
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
      const branch = this.copiedBranches.get(node.id);
      return { ...rest, layoutItem: branch === undefined ? {} : { branch } };
    });
    const { document, session } = this.ctx;
    const pasted = document.batch(() => {
      const result = document.pasteEntities({ ...payload, nodes }, { x: 0, y: 0 }, { parentId: parent.node.id });
      const previous = this.pastedLooks(payload, result.nodeIds);
      for (const id of result.nodeIds) this.applyThemeToSubtree(id, previous);
      return result;
    }, '粘贴为子主题');
    if (pasted.nodeIds.length === 0) return false;
    session.setSelection(pasted);
    return true;
  }

  private rememberCopied(): null {
    this.copiedLooks.clear();
    this.copiedBranches.clear();
    for (const id of this.ctx.session.selectedNodeIds) {
      for (const [nodeId, look] of this.subtreeLooks(id) ?? []) this.copiedLooks.set(nodeId, look);
      const branch = this.getNode(id)?.layoutItem?.branch;
      if (branch !== undefined) this.copiedBranches.set(id, branch);
    }
    return null;
  }

  /**
   * 粘贴出的各主题在复制时的主题外观 (按新 id)：最顶层按顺序对应剪贴板中的最顶层，
   * 后代按同一父节点下的层级索引对应 (粘贴保留后代的层级索引)
   */
  private pastedLooks(payload: NodeClipboardPayload, topIds: readonly string[]): Map<string, TopicLook> {
    const looks = new Map<string, TopicLook>();
    const ids = new Set(payload.nodes.map((node) => node.id));
    const visit = (oldId: string, newId: string): void => {
      const look = this.copiedLooks.get(oldId);
      if (look) looks.set(newId, look);
      const pastedChildren = [...this.ctx.entities.getChildIds(newId)].map((id) => this.getNode(id)!);
      for (const child of payload.nodes) {
        if (child.parentId !== oldId) continue;
        const pasted = pastedChildren.find((node) => node.zIndex === child.zIndex);
        if (pasted) visit(child.id, pasted.id);
      }
    };
    payload.nodes
      .filter((node) => node.parentId === undefined || !ids.has(node.parentId))
      .forEach((node, index) => visit(node.id, topIds[index]));
    return looks;
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
