# SkyNote 思维导图

在同一张 SkyNote 画布上展开主题、整理分支，并把导图与其他画布内容放在一起。

[免费在线体验](https://playground.skynote.top/?example=mindmap) · [功能文档](https://docs.skynote.top/plugins/mindmap)

## 主要能力

- 从中心主题展开双侧、单侧或纵向布局。
- 新增主题、拖动调整分支归属和顺序。
- 折叠分支或按层级展开，调整主题和连线样式。

## 源码开发

包名为 `@skynote-pro/plugin-mindmap`。当前通过 pnpm 工作区解析 SkyNote 基础 SDK 依赖，公共 npm 暂无安装入口。宿主可以用 `createPlugins()` 装配插件。

在新工作区中装配基础 SDK，再将本插件检出到 `pro/plugin-mindmap`。

```sh
git clone https://github.com/skynote-universe/skynote.git
cd skynote
node scripts/bootstrap.mjs
git clone --branch main https://github.com/skynote-universe/plugin-mindmap.git pro/plugin-mindmap
pnpm install --no-frozen-lockfile
pnpm --filter @skynote-pro/plugin-mindmap typecheck
pnpm --filter @skynote-pro/plugin-mindmap test
```

工作区使用 Node.js 22.12 或更高版本和 pnpm 10.12.4。加入插件后，安装会更新本地锁文件，以记录额外的工作区包。

## 参与贡献

欢迎提交 PR。请阅读[许可证第 7 条](./LICENSE)，并在 PR 模板中勾选确认。直接提交者在开通写权限前书面确认。

## 许可证

[SkyNote 高级插件源码可见许可证 1.0](./LICENSE)
