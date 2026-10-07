/**
 * @file outline.ts
 * @description 大纲文本 → 主题树：缩进 (空格或制表符)、Markdown 列表 (- * + 1.) 与标题 (#) 都识别为层级
 *
 * 设计考量 (Why):
 * 1. 只有带层级结构的多行文本才当作大纲：没有缩进、列表或标题标记的普通多行文字仍按普通文字粘贴，不打扰常规用法。
 * 2. 层级按缩进的相对深浅判断 (用栈对齐到最近的较浅一层)，不要求统一的缩进宽度，从各种笔记软件复制来的都能用。
 * 3. 只有一个顶层条目时它就是中心主题；多个顶层条目时补一个中心主题把它们收拢。
 */

export interface OutlineTopic {
  readonly text: string;
  readonly children: OutlineTopic[];
}

const TAB_WIDTH = 4;
const BULLET = /^(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^(#{1,6})\s+/;
/** 防止异常输入生成过多节点 */
const MAX_TOPICS = 2000;

interface OutlineLine {
  readonly depth: number;
  readonly text: string;
  readonly structured: boolean;
}

function parseLine(raw: string): OutlineLine | null {
  const indentMatch = /^[ \t]*/.exec(raw)![0];
  let text = raw.slice(indentMatch.length).trimEnd();
  if (text === '') return null;
  let depth = [...indentMatch].reduce((width, char) => width + (char === '\t' ? TAB_WIDTH : 1), 0);
  let structured = depth > 0;
  const heading = HEADING.exec(text);
  if (heading) {
    // 标题按级别排在列表之前：# 最浅
    depth = heading[1].length - 7;
    text = text.slice(heading[0].length);
    structured = true;
  } else {
    const bullet = BULLET.exec(text);
    if (bullet) {
      text = text.slice(bullet[0].length);
      structured = true;
    }
  }
  return text === '' ? null : { depth, text, structured };
}

/** 解析大纲文本；不像大纲 (少于两行或没有任何层级标记) 时返回 null */
export function parseOutline(source: string): OutlineTopic | null {
  const lines = parseLines(source);
  if (lines.length < 2 || !lines.some((line) => line.structured)) return null;
  const topics = buildTopics(lines);
  return topics.length === 1 ? topics[0] : { text: '中心主题', children: topics };
}

/**
 * 把任意文字解析为一组主题 (粘贴到选中的主题下时用)：每个非空行一个主题，有层级标记时按层级嵌套
 * @returns 没有文字时为空数组
 */
export function parseTopicList(source: string): OutlineTopic[] {
  return buildTopics(parseLines(source));
}

function parseLines(source: string): OutlineLine[] {
  return source
    .split(/\r?\n/)
    .map(parseLine)
    .filter((line): line is OutlineLine => line !== null)
    .slice(0, MAX_TOPICS);
}

function buildTopics(lines: readonly OutlineLine[]): OutlineTopic[] {
  const root: OutlineTopic = { text: '', children: [] };
  const stack: { depth: number; topic: OutlineTopic }[] = [{ depth: -Infinity, topic: root }];
  for (const line of lines) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= line.depth) stack.pop();
    const topic: OutlineTopic = { text: line.text, children: [] };
    stack[stack.length - 1].topic.children.push(topic);
    stack.push({ depth: line.depth, topic });
  }
  return root.children;
}
