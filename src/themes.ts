/**
 * @file themes.ts
 * @description 导图主题与主题注册表：一套主题统一规定中心主题、第一层与更深层主题的外观，以及分支线颜色
 *
 * 设计考量 (Why):
 * 1. 颜色用调色板引用 ($name) 或合法色值；内置主题全部用调色板引用，亮色与暗色画布下都清晰，
 *    浅色底的主题文字固定用深色 ($ink)，不随画布反色。
 * 2. 主题外观写在主题节点的样式上 (切换主题、插入主题时)：节点照常用填充、描边面板单独修改，
 *    渲染与导出无需知道导图；再次切换主题会覆盖单独的修改 (与 XMind 一致)。
 * 3. 开放注册：内置主题与开发者注册的主题走同一个注册表；同 id 按注册顺序叠层，注销只撤掉自己那一层
 *    (覆盖内置主题后注销即恢复内置)。定义在注册时校验，非法定义直接报错，不会进入文档。
 * 4. 文档里用了未注册的主题时保留其 id 不改写：节点外观本就写在节点上，画面不变；
 *    分支线颜色与新插入的主题暂按默认主题处理，主题注册后即恢复。
 */

import { parseCssColor, type NodeStyle, type NodeTextStyle } from '@skynote/core';

/** 一层主题的外观；未给出的项回到节点类型与画布主题的默认值 */
export interface MindmapTopicLook {
  readonly fill?: string;
  /** 底色不透明度 (0~1) */
  readonly fillOpacity?: number;
  readonly stroke?: string;
  /** 文字颜色 */
  readonly text?: string;
}

/** 分支的配色：线色 (强调色) 与同色系的浅底色 */
export interface MindmapBranchColor {
  readonly line: string;
  readonly fill: string;
}

/** 导图主题定义 */
export interface MindmapThemeDefinition {
  /** 全局唯一标识；自定义主题建议带前缀 (如 'acme:brand')，与内置主题同 id 即覆盖 */
  readonly id: string;
  /** 界面显示的名称 */
  readonly label: string;
  readonly root: MindmapTopicLook;
  /** 第一层主题；'branch' 表示用所在分支的浅底色与线色 */
  readonly level1: MindmapTopicLook | 'branch';
  /** 更深层主题；'branch' 表示边框用所在分支的线色 */
  readonly deeper: MindmapTopicLook | 'branch';
  /** 分支线：'branch' 按分支取色，或统一颜色；undefined 为画布主题的连线色 */
  readonly line?: 'branch' | string;
  /** 各分支依次使用的颜色 (第一层主题按顺序循环取用)；缺省为内置的五色 */
  readonly branchColors?: readonly MindmapBranchColor[];
}

/** 一套主题的说明：名称与预览色 (中心主题、前几个第一层主题与分支线)，供界面画预览卡片 */
export interface MindmapThemeInfo {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  readonly level1: readonly string[];
  readonly lines: readonly string[];
}

export const DEFAULT_MINDMAP_THEME = 'rainbow';

const DEFAULT_BRANCH_COLORS: readonly MindmapBranchColor[] = [
  { line: '$red', fill: '$pink' },
  { line: '$amber', fill: '$orange' },
  { line: '$emerald', fill: '$green' },
  { line: '$sky', fill: '$blue' },
  { line: '$violet', fill: '$purple' }
];

export const BUILT_IN_MINDMAP_THEMES: readonly MindmapThemeDefinition[] = [
  {
    id: 'rainbow',
    label: '彩虹',
    root: { fill: '$purple', stroke: '$violet', text: '$ink' },
    level1: 'branch',
    deeper: 'branch',
    line: 'branch'
  },
  {
    id: 'fresh',
    label: '清新',
    root: { fill: '$blue', stroke: '$sky', text: '$ink' },
    level1: { fill: '$yellow', fillOpacity: 0.5, stroke: '$amber', text: '$ink' },
    deeper: {},
    line: 'branch'
  },
  {
    id: 'ocean',
    label: '海洋',
    root: { fill: '$blue', stroke: '$sky', text: '$ink' },
    level1: { fill: '$teal', stroke: '$emerald', text: '$ink' },
    deeper: { stroke: '$sky' },
    line: '$sky'
  },
  {
    id: 'warm',
    label: '暖阳',
    root: { fill: '$orange', stroke: '$amber', text: '$ink' },
    level1: { fill: '$yellow', stroke: '$amber', text: '$ink' },
    deeper: { stroke: '$amber' },
    line: '$amber'
  },
  {
    id: 'minimal',
    label: '简约',
    root: { fill: '$gray', stroke: '$gray', text: '$ink' },
    level1: {},
    deeper: { fill: 'transparent' },
    line: undefined
  }
];

const PALETTE_REFERENCE = /^\$[A-Za-z][\w-]*$/;

function assertColor(value: unknown, path: string): void {
  const valid =
    typeof value === 'string' &&
    (PALETTE_REFERENCE.test(value) || value === 'transparent' || parseCssColor(value) !== null);
  if (!valid) throw new Error(`[MindmapThemes] ${path} 不是合法的颜色 (调色板引用如 $blue，或 #RRGGBB / rgb())`);
}

function assertLook(look: unknown, path: string, allowBranch: boolean): void {
  if (allowBranch && look === 'branch') return;
  if (typeof look !== 'object' || look === null) throw new Error(`[MindmapThemes] ${path} 应为外观对象`);
  const { fill, fillOpacity, stroke, text } = look as MindmapTopicLook;
  if (fill !== undefined) assertColor(fill, `${path}.fill`);
  if (stroke !== undefined) assertColor(stroke, `${path}.stroke`);
  if (text !== undefined) assertColor(text, `${path}.text`);
  if (fillOpacity !== undefined && !(typeof fillOpacity === 'number' && fillOpacity >= 0 && fillOpacity <= 1)) {
    throw new Error(`[MindmapThemes] ${path}.fillOpacity 应为 0~1 之间的数字`);
  }
}

/** 注册时校验主题定义：开发者传入的数据，非法时直接报错 */
function assertDefinition(definition: MindmapThemeDefinition): void {
  const id = definition?.id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('[MindmapThemes] 主题定义缺少有效 id');
  if (typeof definition.label !== 'string' || definition.label.length === 0) {
    throw new Error(`[MindmapThemes] 主题 ${id} 缺少名称`);
  }
  assertLook(definition.root, `${id}.root`, false);
  assertLook(definition.level1, `${id}.level1`, true);
  assertLook(definition.deeper, `${id}.deeper`, true);
  if (definition.line !== undefined && definition.line !== 'branch') assertColor(definition.line, `${id}.line`);
  if (definition.branchColors !== undefined) {
    if (!Array.isArray(definition.branchColors) || definition.branchColors.length === 0) {
      throw new Error(`[MindmapThemes] 主题 ${id} 的 branchColors 应为非空数组`);
    }
    definition.branchColors.forEach((color, i) => {
      assertColor(color?.line, `${id}.branchColors[${i}].line`);
      assertColor(color?.fill, `${id}.branchColors[${i}].fill`);
    });
  }
}

export class MindmapThemeRegistry {
  /** id → 按注册顺序叠放的定义 (最后一层生效) */
  private readonly layers = new Map<string, MindmapThemeDefinition[]>();
  private readonly listeners = new Set<() => void>();

  constructor(themes: readonly MindmapThemeDefinition[] = []) {
    for (const theme of [...BUILT_IN_MINDMAP_THEMES, ...themes]) this.add(theme);
  }

  /**
   * 注册主题 (同 id 即覆盖)
   * @returns 注销函数：只撤掉本次注册的这一层
   * @throws 定义不合法
   */
  register(definition: MindmapThemeDefinition): () => void {
    this.add(definition);
    this.notify();
    return () => {
      const stack = this.layers.get(definition.id);
      const index = stack?.lastIndexOf(definition) ?? -1;
      if (index < 0) return;
      stack!.splice(index, 1);
      if (stack!.length === 0) this.layers.delete(definition.id);
      this.notify();
    };
  }

  /** 主题定义；未注册时为默认主题 */
  get(id: string): MindmapThemeDefinition {
    return this.layers.get(id)?.at(-1) ?? this.layers.get(DEFAULT_MINDMAP_THEME)!.at(-1)!;
  }

  /** 主题集合变化 (注册或注销) */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 全部主题的名称与预览色 (内置在前，按注册顺序) */
  list(): MindmapThemeInfo[] {
    return [...this.layers.values()].map((stack) => {
      const theme = stack.at(-1)!;
      const indexes = [0, 1, 2];
      return {
        id: theme.id,
        label: theme.label,
        root: theme.root.fill ?? '$gray',
        level1: indexes.map((i) =>
          theme.level1 === 'branch' ? branchColor(theme, i).fill : (theme.level1.fill ?? '$gray')
        ),
        lines: indexes.map((i) => this.lineColor(theme.id, i) ?? '$gray')
      };
    });
  }

  /** 分支线颜色 (index 为所在第一层分支的序号) */
  lineColor(id: string, index: number): string | undefined {
    const theme = this.get(id);
    return theme.line === 'branch' ? branchColor(theme, index).line : theme.line;
  }

  /**
   * 某一层主题在该主题下应写入的样式 (显式写 undefined 的项表示清除，回到默认)
   * @param depth 根为 0
   * @param branchIndex 所在第一层分支的序号 (根为 -1)
   */
  topicStyle(
    id: string,
    depth: number,
    branchIndex: number
  ): { style: Partial<NodeStyle>; textStyle: Partial<NodeTextStyle> } {
    const theme = this.get(id);
    const branch = branchColor(theme, Math.max(0, branchIndex));
    let look: MindmapTopicLook;
    if (depth === 0) look = theme.root;
    else if (depth === 1)
      look = theme.level1 === 'branch' ? { fill: branch.fill, stroke: branch.line, text: '$ink' } : theme.level1;
    else look = theme.deeper === 'branch' ? { stroke: branch.line } : theme.deeper;
    return {
      style: { fill: look.fill, fillOpacity: look.fillOpacity, stroke: look.stroke },
      textStyle: { color: look.text }
    };
  }

  private add(definition: MindmapThemeDefinition): void {
    assertDefinition(definition);
    const stack = this.layers.get(definition.id);
    if (stack) stack.push(definition);
    else this.layers.set(definition.id, [definition]);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 主题第 index 个分支的颜色 (循环取用) */
function branchColor(theme: MindmapThemeDefinition, index: number): MindmapBranchColor {
  const colors = theme.branchColors ?? DEFAULT_BRANCH_COLORS;
  return colors[((index % colors.length) + colors.length) % colors.length];
}
