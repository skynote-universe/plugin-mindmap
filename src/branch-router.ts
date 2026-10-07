/**
 * @file branch-router.ts
 * @description 导图分支线型：两端水平切出的 S 形三次曲线，控制柄长度取两端水平距离的一半
 *
 * 设计考量 (Why):
 * 内置曲线按两端直线距离取控制柄长度：导图里父子水平间距小、垂直落差大 (子主题多时尤其明显)，
 * 控制柄会远长于水平间距，两端控制点交错，曲线冲过子主题再折返，多条分支缠在一起。
 * 这里只按水平距离取控制柄，两个控制点始终落在起点与终点之间，任何落差下都是平滑的 S 形，与 XMind 等工具一致。
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
    const half = (end.point.x - start.point.x) / 2;
    return cubicBezierRoute([
      [start.point, { x: start.point.x + half, y: start.point.y }, { x: end.point.x - half, y: end.point.y }, end.point]
    ]);
  }
}
