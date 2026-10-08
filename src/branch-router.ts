/**
 * @file branch-router.ts
 * @description 导图分支线型：沿出线方向切出的 S 形三次曲线，控制柄长度取两端在该方向上距离的一半
 *
 * 设计考量 (Why):
 * 内置曲线按两端直线距离取控制柄长度：导图里父子间距小、兄弟方向的落差大 (子主题多时尤其明显)，
 * 控制柄会远长于父子间距，两端控制点交错，曲线冲过子主题再折返，多条分支缠在一起。
 * 这里只按出线方向上的距离取控制柄，两个控制点始终落在起点与终点之间，任何落差下都是平滑的 S 形，与 XMind 等工具一致。
 * 出线方向取起点的外法线：横向结构水平切出，组织结构图竖直切出。
 */

import {
  ConnectorRouter,
  cubicBezierRoute,
  type ConnectorRouterInput,
  type ConnectorRouterResult
} from '@skynote/core';

export const MINDMAP_BRANCH_ROUTER = 'mindmap:branch';

export class MindmapBranchRouter extends ConnectorRouter {
  readonly id = MINDMAP_BRANCH_ROUTER;
  readonly label = '导图曲线';

  route({ start, end }: ConnectorRouterInput): ConnectorRouterResult {
    const a = start.point;
    const b = end.point;
    const vertical = start.direction !== undefined && Math.abs(start.direction.y) > Math.abs(start.direction.x);
    if (vertical) {
      const half = (b.y - a.y) / 2;
      return cubicBezierRoute([[a, { x: a.x, y: a.y + half }, { x: b.x, y: b.y - half }, b]]);
    }
    const half = (b.x - a.x) / 2;
    return cubicBezierRoute([[a, { x: a.x + half, y: a.y }, { x: b.x - half, y: b.y }, b]]);
  }
}
