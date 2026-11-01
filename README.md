# dsh-worktree-manager

DeepSeek Harness 桌面版插件：在空白会话里创建隔离的 git worktree，并在会话头部合并、删除与自动清理。

## 功能

- 空白会话（仓库主目录）的工作区选择器右侧出现两个 chip：**分支**与**环境（本机 / Worktree）**。
- 环境选 Worktree：填写名称（或自动短码）后点「创建并进入」，插件创建 worktree、注册为 Workspace（标题 `仓库名.分支名`），并在其中打开空白会话，输入框草稿自动带入。
- worktree 会话头部显示 `分支 → 基础分支`、「合并」「删除」。
- 合并支持「合并提交（--no-ff）」和「压缩为一个提交（squash）」，由用户选择并记住上次选择；squash 的提交信息优先用 LLM 生成，不可用时预填各提交标题。
- 合并冲突时自动回滚，列出冲突文件，可一键「交给 Agent 解决」。
- 合并后可自动清理（删除 worktree、删除分支、归档会话、注销 Workspace），开关在配置页。
- 插件页提供配置与 worktree 管理列表（合并 / 改标题 / 删除）。

## 安装

```sh
pnpm install
pnpm run build:all

# 链接到某个 profile（桌面版 profile 名为 desktop）
dsh plugin --profile desktop add "link:$(pwd)"
```

安装后重启 profile，在「插件」页启用「Worktree 管理」。本插件与 `dsh-git-branch-manage` 可并存：包名、配置项 id、locale 命名空间、路由前缀、slot id 均独立。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `rootDir` | `$DSH_HOME/worktrees` | worktree 根目录，实际路径 `<根目录>/<仓库名>/<分支名>`，必须是绝对路径 |
| `namingMode` | `manual` | `manual` 手动输入名称；`auto` 自动短码 `wt-xxxxxx` |
| `autoCleanup` | `true` | 合并成功后自动清理 |
| `deleteBranchOnCleanup` | `true` | 清理时同时删除分支，也是删除对话框的默认值 |
| `copyFiles` | `[]` | 创建后额外复制的文件，另外会读取仓库根目录的 `.worktreeinclude` |

复制规则：每行一个仓库内相对路径，可以是文件或目录，最后一段可用 `*` / `?`；不覆盖已存在文件，不跟随符号链接，禁止 `..` 与 `.git`。建议只列被 `.gitignore` 忽略的文件，否则复制过去的未跟踪文件会被算作未提交改动。

## 合并规则

预检不通过时直接拒绝并说明原因，不做自动处理：

- worktree 有未提交改动；
- 主仓库不在目标分支，或主仓库有未提交改动；
- 没有可合并的提交。

squash 合并后分支内容已在目标分支，但 git 不认为已合并，所以自动清理对分支使用 `-D`。手动删除时，未合并分支需要二次确认。

## 开发

```sh
pnpm run typecheck   # 宿主侧与客户端
pnpm test            # vitest，git 逻辑用真实临时仓库验证
pnpm run build:all   # tsc（host）+ tsdown（client bundle）
```

结构：

- `src/index.ts`、`src/routes.ts`、`src/git.ts`：宿主侧配置、HTTP 路由与 git 逻辑；
- `src/client/`：浏览器侧（chips、对话框、配置页、管理列表）；
- `src/wire.ts`：两侧共享的路由与类型；
- `docs/decisions/`：设计决策记录。

## 限制

- 只在 macOS 上开发与验证。
- 只管理本插件创建的 worktree（以分支上的 git config `branch.<name>.dsh-worktree-base` 识别）。
- 不提供 commit、push、diff 等通用 git 操作。
