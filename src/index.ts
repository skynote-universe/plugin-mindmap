/**
 * @file index.ts
 * @description @skynote-pro/plugin-mindmap 统一导出入口
 */

import type { SkyNotePlugin } from '@skynote/core';
import { MindmapPlugin } from './plugin';

export * from './plugin';
export * from './layout';
export * from './outline';
export * from './branch-router';
export * from './themes';
export * from './structures';
export * from './structure-preview';

/** 商业插件包的统一入口约定：宿主按此装配 (是否启用由宿主的 FeatureGate 决定) */
export function createPlugins(): SkyNotePlugin[] {
  return [new MindmapPlugin()];
}
