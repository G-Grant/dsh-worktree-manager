# 0001 — chip 的挂载位置与 worktree 的创建时机

日期: 2026-11-01
状态: 已接受

## 背景

需求是在空白会话 hero 的工作区选择器右侧放「分支」「环境」两个 chip，并参考 Cursor 的交互。需求讨论时的假设是：替换 `conversation.hero.workspace` 插槽即可在选择器后追加 chip，且 worktree 在发送首条消息时创建。核对 dsh 0.2.0-rc.1 的源码后发现两点与假设不符：

1. `conversation.hero.workspace` 是 `single` 插槽，其占用者只是**选择器的弹出菜单**；触发它的 `gis-mfg ▾` chip 与整行（`heroWorkspaceRow`）由 ui-conversation 自己渲染。替换该插槽既加不进 chip，还要重写工作区选择器及其目录选择子插槽。
2. 输入框没有给插件使用的「发送前拦截」扩展点；唯一的提交仲裁是斜杠命令认领，不适合承载创建流程。

## 决策

**挂载位置**：注册为 `conversation.input.dock`（官方 `list` 插槽，会话作用域，hero 状态下渲染在工作区行下方）。组件只在空白会话且目录是仓库主目录时有内容，并把两个 chip 通过 portal 放入 hero 的工作区行（插到「标准模式」chip 之前）。找不到该行时降级为 dock 内自带的一行，功能不依赖具体标记。

- 被否决：替换 `hero.workspace`（见背景 1）；放到底部 `conversation.input.left`（官方支持但不在用户要的位置）；向上游提 PR 增加插槽（不在本次范围，作为后续改进）。
- 代价：portal 依赖 `data-conversation-content` 与 `data-slot` 两个属性，上游改名会降级为单独一行，不会失效。

**创建时机**：不在发送时创建，而是在 Worktree 面板点「创建并进入」（或在名称框回车）时创建，然后注册 Workspace、打开其空白会话，并通过 `openWorkspace` 的 `beforeOpen` 回调把草稿交给新会话。

- 这正是需求讨论里提出的「选择 Worktree 时输入名字，再开始对话」。
- 手动命名下「名称必填」由面板内校验保证，不再需要「空名称发送被拦截」的逻辑。
- 被否决：发送时创建（缺少拦截点）。

## 影响

- 正面：不依赖未公开的输入框内部行为；创建失败时停留在原页面，草稿不丢；worktree 会话与主仓库会话的 chip 逻辑互不干扰。
- 负面：用户要多点一次「创建并进入」；草稿交接用模块内存表 + `inputActions.setDraft`，刷新页面后丢失（创建之后才刷新，草稿本就在新会话里）。
- 验证：在隔离的 `$DSH_HOME` 里用 `dsh web` 加载本插件，经浏览器完成了创建（手动 / 自动命名）、草稿带入、会话头部合并（merge / squash / 冲突交给 Agent）、自动清理与手动删除的完整流程。
