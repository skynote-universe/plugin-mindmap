import {
  applyMatrix,
  worldToScreen,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type DocumentChangeSet,
  type Point,
  type PointerHooks
} from '@skynote/core';
import type { Growth } from './layout';

export const MINDMAP_FOLD_OVERLAY = 'mindmap:fold-controls';

export interface MindmapControlTooltip {
  readonly text: string;
  readonly anchor: Point;
}

interface FoldCommands {
  rootOf(id: string): string | undefined;
  stateOf(id: string): { collapsed: boolean; descendants: number } | undefined;
  directionOf(id: string, rootId: string): Growth;
  setCollapsed(id: string, collapsed: boolean): void;
}

interface FoldTopic {
  readonly id: string;
  readonly collapsed: boolean;
  readonly descendants: number;
  readonly label: string;
  readonly anchor: Point;
  readonly direction: Point;
  readonly width: number;
  readonly disabled: boolean;
}

interface FoldControl extends FoldTopic {
  readonly center: Point;
}

/** 平台中立的画布控件：图元、命中与指针会话均由插件持有，不进入文档或图片导出。 */
export class MindmapFoldControls implements PointerHooks {
  private readonly collapsed = new Set<string>();
  private topics: readonly FoldTopic[] | undefined;
  private controls: readonly FoldControl[] = [];
  private hovered: string | undefined;
  private lastPoint: Point | undefined;
  private cursorOwned = false;
  private available = true;
  private pressed: { id: string; pointerId: number; start: Point; collapsed: boolean; moved: boolean } | null = null;
  private tooltip: MindmapControlTooltip | null = null;
  private readonly listeners = new Set<(tooltip: MindmapControlTooltip | null) => void>();

  constructor(
    private readonly ctx: CanvasPluginContext,
    private readonly commands: FoldCommands
  ) {
    this.trackAll();
    // 高于文字命中与变换手柄，点击控件时不会启动编辑、缩放或框选。
    ctx.registerPointerHooks(this, 80);
    ctx.registerInputScope({
      id: 'mindmap:fold-controls',
      priority: 1100,
      onBlur: () => {
        this.cancelPress();
        this.clearHover();
        this.draw();
      },
      onKeyDown: (event) => {
        if (event.key !== 'Escape' || !this.pressed) return false;
        event.preventDefault();
        this.cancelPress();
        this.clearHover();
        this.draw();
        return true;
      }
    });
    ctx.onHostChange((available) => {
      this.cancelPress();
      this.clearHover();
      this.available = available;
      if (available) this.draw();
      else {
        this.controls = [];
        ctx.host.overlay.clear(MINDMAP_FOLD_OVERLAY);
      }
    });
    ctx.onSessionChange((change) => {
      if (change.selectionScopeChanged || change.toggledNodeIds.size || change.toggledConnectorIds.size) {
        this.cancelPress();
        this.topics = undefined;
      }
      if (change.toolChanged || change.readOnlyChanged || change.maintenanceChanged) {
        this.cancelPress();
        this.clearHover();
      }
      if (change.viewportChanged) {
        this.cancelPress();
        this.clearHover();
      }
      if (
        change.viewportChanged ||
        change.themeChanged ||
        change.toolChanged ||
        change.readOnlyChanged ||
        change.maintenanceChanged ||
        change.selectionScopeChanged ||
        change.toggledNodeIds.size ||
        change.toggledConnectorIds.size
      )
        this.draw();
    });
    ctx.onDocumentChange((change) => this.documentChanged(change));
    ctx.layouts.onChange(() => {
      this.topics = undefined;
      this.draw();
    });
    this.draw();
  }

  onTooltipChange(listener: (tooltip: MindmapControlTooltip | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.tooltip);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setTooltip(value: MindmapControlTooltip | null): void {
    if (
      this.tooltip?.text === value?.text &&
      this.tooltip?.anchor.x === value?.anchor.x &&
      this.tooltip?.anchor.y === value?.anchor.y
    )
      return;
    this.tooltip = value;
    for (const listener of this.listeners) listener(value);
  }

  private track(id: string): void {
    if (this.ctx.document.getNode(id)?.layoutState?.collapsed) this.collapsed.add(id);
    else this.collapsed.delete(id);
  }

  private trackAll(): void {
    this.collapsed.clear();
    for (const { entity } of this.ctx.entities.getAllNodes()) this.track(entity.id);
  }

  private documentChanged(change: DocumentChangeSet): void {
    if (change.contentReplaced) this.trackAll();
    else
      for (const ids of [change.nodes.added, change.nodes.removed, change.nodes.data])
        for (const id of ids) this.track(id);
    this.cancelPress();
    this.topics = undefined;
    this.draw();
  }

  private get enabled(): boolean {
    const session = this.ctx.session;
    return this.available && !session.isReadOnly && !session.inMaintenance && session.tool === 'select';
  }

  private collectTopics(): readonly FoldTopic[] {
    const candidates = new Set(this.collapsed);
    if (this.ctx.session.selectedNodeIds.size === 1)
      for (const id of this.ctx.session.selectedNodeIds) candidates.add(id);
    const topics: FoldTopic[] = [];
    for (const id of candidates) {
      if (!this.ctx.document.visibility.isNodeVisible(id)) continue;
      const node = this.ctx.document.getNode(id);
      const state = this.commands.stateOf(id);
      const rootId = this.commands.rootOf(id);
      const matrix = this.ctx.entities.getWorldTransform(id);
      if (!node || !state?.descendants || rootId === undefined || !matrix) continue;
      const growth = this.commands.directionOf(id, rootId);
      const vertical = growth === 'up' || growth === 'down';
      const dx = growth === 'left' ? -1 : growth === 'right' ? 1 : 0;
      const dy = growth === 'up' ? -1 : growth === 'down' ? 1 : 0;
      const direction = { x: matrix.a * dx + matrix.c * dy, y: matrix.b * dx + matrix.d * dy };
      const length = Math.hypot(direction.x, direction.y);
      if (!length) continue;
      const label = state.collapsed ? (state.descendants > 99 ? '99+' : String(state.descendants)) : '';
      topics.push({
        id,
        collapsed: state.collapsed,
        descendants: state.descendants,
        label,
        width: Math.max(20, label.length * 6 + 8),
        anchor: applyMatrix(
          matrix,
          vertical ? node.width / 2 : growth === 'left' ? 0 : node.width,
          vertical ? (growth === 'up' ? 0 : node.height) : node.height / 2
        ),
        direction: { x: direction.x / length, y: direction.y / length },
        disabled: !!node.locked || !!this.ctx.document.getNode(rootId)?.locked
      });
    }
    return topics;
  }

  private controlAt(point: Point): FoldControl | undefined {
    const zoom = this.ctx.session.viewport.zoom;
    return this.controls.find(
      (control) =>
        !control.disabled &&
        Math.abs(point.x - control.center.x) <= control.width / (2 * zoom) &&
        Math.abs(point.y - control.center.y) <= 10 / zoom
    );
  }

  private draw(): void {
    if (!this.enabled) {
      this.controls = [];
      this.clearHover();
      this.ctx.host.overlay.clear(MINDMAP_FOLD_OVERLAY);
      return;
    }
    const { viewport, viewportSize, theme } = this.ctx.session;
    const unit = 1 / viewport.zoom;
    this.topics ??= this.collectTopics();
    this.controls = this.topics.flatMap((topic) => {
      const offset = ((Math.abs(topic.direction.x) * topic.width) / 2 + Math.abs(topic.direction.y) * 10 + 2) * unit;
      const center = { x: topic.anchor.x + topic.direction.x * offset, y: topic.anchor.y + topic.direction.y * offset };
      const screen = worldToScreen(center, viewport);
      if (
        viewportSize.width > 0 &&
        viewportSize.height > 0 &&
        (screen.x < -24 || screen.y < -24 || screen.x > viewportSize.width + 24 || screen.y > viewportSize.height + 24)
      )
        return [];
      return [{ ...topic, center }];
    });
    const hover = this.lastPoint ? this.controlAt(this.lastPoint) : undefined;
    this.hovered = hover?.id;
    this.setTooltip(
      hover
        ? {
            text: hover.collapsed ? `展开 ${hover.descendants} 个主题` : '折叠分支',
            anchor: hover.center
          }
        : null
    );
    const primitives: CanvasPrimitive[] = [];
    for (const control of this.controls) {
      const active = this.hovered === control.id || this.pressed?.id === control.id;
      const x = control.center.x - (control.width * unit) / 2;
      const y = control.center.y - 10 * unit;
      const ink = active ? theme.accent : theme.textColor;
      const opacity = control.disabled ? 0.4 : 1;
      primitives.push({
        kind: 'rect',
        id: `mindmap-fold:${control.id}:body`,
        x,
        y,
        width: control.width * unit,
        height: 20 * unit,
        radius: 10 * unit,
        fill: theme.nodeFill,
        stroke: active ? theme.accent : theme.nodeStroke,
        strokeWidth: unit,
        opacity
      });
      if (control.collapsed)
        primitives.push({
          kind: 'text',
          id: `mindmap-fold:${control.id}:label`,
          x,
          y,
          width: control.width * unit,
          height: 20 * unit,
          runs: [{ text: control.label }],
          style: {
            fontSize: 10 * unit,
            color: ink,
            lineHeight: 1,
            textAlign: 'center',
            verticalAlign: 'middle',
            textWrap: 'none'
          },
          opacity
        });
      else
        primitives.push({
          kind: 'line',
          id: `mindmap-fold:${control.id}:minus`,
          points: [control.center.x - 3 * unit, control.center.y, control.center.x + 3 * unit, control.center.y],
          stroke: ink,
          strokeWidth: 1.5 * unit,
          strokeCap: 'round',
          opacity
        });
    }
    if (primitives.length) this.ctx.host.overlay.setPrimitives(MINDMAP_FOLD_OVERLAY, primitives);
    else this.ctx.host.overlay.clear(MINDMAP_FOLD_OVERLAY);
  }

  private clearHover(restoreCursor = true): void {
    this.lastPoint = undefined;
    this.hovered = undefined;
    this.setTooltip(null);
    if (restoreCursor && this.cursorOwned && this.ctx.session.tool === 'select') this.ctx.host.setCursor('default');
    this.cursorOwned = false;
  }

  private cancelPress(): void {
    if (!this.pressed) return;
    this.ctx.host.releasePointer(this.pressed.pointerId);
    this.pressed = null;
  }

  onPointerDown(event: CanvasPointerEvent): void {
    if (!this.enabled || event.isClaimed || event.button !== 0 || this.pressed) return;
    const control = this.controlAt(event.point);
    if (!control) return;
    event.claimPointer('mindmap:fold');
    event.stopPropagation();
    this.pressed = {
      id: control.id,
      pointerId: event.pointerId,
      start: event.clientPoint,
      collapsed: control.collapsed,
      moved: false
    };
    this.ctx.host.capturePointer(event.pointerId);
    this.lastPoint = event.point;
    this.draw();
  }

  onPointerMove(event: CanvasPointerEvent): void {
    if (this.pressed) {
      if (event.pointerId !== this.pressed.pointerId) return;
      this.pressed.moved ||=
        Math.hypot(event.clientPoint.x - this.pressed.start.x, event.clientPoint.y - this.pressed.start.y) > 4;
      event.claimPointer('mindmap:fold');
      event.stopPropagation();
    }
    if (!this.enabled || (event.isClaimed && !this.pressed)) {
      const hovered = this.hovered;
      this.clearHover(!event.isClaimed);
      if (hovered) this.draw();
      return;
    }
    const previous = this.hovered;
    this.lastPoint = event.point;
    const hover = this.controlAt(event.point);
    if (hover) {
      // 认领悬停而不截断分发，让下层清理旧高亮，并允许其结束已经开始的手势。
      event.claimPointer('mindmap:fold');
      this.ctx.host.setCursor('pointer');
      this.cursorOwned = true;
    } else if (this.cursorOwned) {
      this.ctx.host.setCursor('default');
      this.cursorOwned = false;
    }
    if (previous !== hover?.id) this.draw();
  }

  onPointerUp(event: CanvasPointerEvent): void {
    const pressed = this.pressed;
    if (!pressed || pressed.pointerId !== event.pointerId) return;
    event.claimPointer('mindmap:fold');
    event.stopPropagation();
    const control = this.controlAt(event.point);
    this.cancelPress();
    if (!pressed.moved && this.enabled && control?.id === pressed.id && control.collapsed === pressed.collapsed)
      this.commands.setCollapsed(pressed.id, !pressed.collapsed);
    this.draw();
  }

  onPointerCancel(event: CanvasPointerEvent): void {
    if (this.pressed?.pointerId === event.pointerId) this.cancelPress();
    this.clearHover();
    this.draw();
  }

  onContextMenu(event: CanvasPointerEvent): void {
    if (!this.pressed) return;
    this.cancelPress();
    this.clearHover();
    this.draw();
    event.stopPropagation();
  }

  onPointerLeave(): void {
    this.cancelPress();
    this.clearHover();
    this.draw();
  }

  unmount(): void {
    this.cancelPress();
    this.clearHover();
    this.ctx.host.overlay.clear(MINDMAP_FOLD_OVERLAY);
    this.controls = [];
    this.topics = undefined;
    this.collapsed.clear();
    this.listeners.clear();
  }
}
