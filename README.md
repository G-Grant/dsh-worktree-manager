# dsh-worktree-manager

[![Release](https://github.com/G-Grant/dsh-worktree-manager/actions/workflows/release.yml/badge.svg)](https://github.com/G-Grant/dsh-worktree-manager/actions/workflows/release.yml)

DeepSeek Harness 插件：在空白会话里选择本机或 Worktree。Worktree 会在仓库里建一个隔离目录，并在会话头部合并、删除和自动清理。

## 使用

只在**仓库主目录的空白会话**里出现。工作区右侧有两个 chip：环境、分支。

![空白会话中的本机与当前分支](docs/images/blank-session.png)

- **本机**：分支 chip 是当前检出。改选会执行 `git switch`。有未提交改动，或该分支已被其他 worktree 占用时，拒绝切换。
- **Worktree**：不改本机检出。环境 chip 只显示 Worktree，分支 chip 表示即将使用的基线。

![选择 Worktree 后，分支 chip 表示基线](docs/images/worktree-chips.png)

打开分支面板，选定基线，填写名称，点「创建并进入」。

![选择基线并填写名称](docs/images/create-worktree.png)

- 名称可用中文。同一段文字同时作为分支名、目录名和工作区标题。
- 不能包含空格或特殊符号。名称里的 `/` 仍是分支层级，目录名会收成 `-`，例如 `功能/超时` 的目录是 `功能-超时`。
- 目录固定为 `<仓库根>/.agents/worktrees/<名称>`。
- 创建后打开这个工作区的空白会话，并带上当前草稿。
- 命名方式为自动短码时，面板里没有输入框，创建时生成 `wt-xxxxxx`。

进入 worktree 会话后，头部显示 `分支 → 基础分支`，以及「合并」「删除」。

## 配置

在「插件」页打开 Worktree 管理。下面是配置和 worktree 列表；列表里可以合并、改标题、删除。

![插件配置与 worktree 列表](docs/images/plugin-config.png)

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `namingMode` | `manual` | `manual` 手动输入名称；`auto` 自动短码 `wt-xxxxxx` |
| `autoCleanup` | `true` | 合并成功后自动清理。合并对话框里仍可取消 |
| `deleteBranchOnCleanup` | `true` | 清理时同时删除分支，也是删除对话框的默认值 |
| `fetchBaseBeforeCreate` | `true` | 创建前 `git fetch` 基线分支的远程最新提交。无远程时跳过，失败则中止创建 |
| `copyFiles` | `[]` | 创建后额外复制的文件。另外会读取仓库根目录的 `.worktreeinclude` |

复制规则：每行一个仓库内相对路径，可以是文件或目录，最后一段可用 `*` / `?`。不覆盖已存在文件，不跟随符号链接，禁止 `..` 与 `.git`。建议只列被 `.gitignore` 忽略的文件，否则复制过去的未跟踪文件会被算作未提交改动。

## 合并

预检不通过时直接拒绝，不做自动处理：

- worktree 有未提交改动；
- 主仓库不在目标分支，或主仓库有未提交改动；
- 没有可合并的提交。

合并方式有两种，会记住上次的选择：

- **合并提交**：`git merge --no-ff`，保留分支上的提交。
- **压缩为一个提交**：squash。提交信息优先用 LLM 生成，不可用时预填各提交标题。

冲突时自动回滚，列出冲突文件，可一键「交给 Agent 解决」。squash 之后 git 不认为分支已合并，所以自动清理对分支使用 `-D`。手动删除未合并分支时需要二次确认。

## 安装

```sh
pnpm install
pnpm run build:all

# 链接到某个 profile（桌面版 profile 名为 desktop）
dsh plugin --profile desktop add "link:$(pwd)"
```

安装后重启 profile，在「插件」页启用「Worktree 管理」。本插件与 `dsh-git-branch-manage` 可并存：包名、配置项 id、locale 命名空间、路由前缀、slot id 均独立。

## 开发

```sh
pnpm run typecheck   # 宿主侧与客户端
pnpm test            # vitest，git 逻辑用真实临时仓库验证
pnpm run build:all   # tsc（host）+ tsdown（client bundle）
```

- `src/index.ts`、`src/routes.ts`、`src/git.ts`：宿主侧配置、HTTP 路由与 git 逻辑
- `src/client/`：浏览器侧（chips、对话框、配置页、管理列表）
- `src/wire.ts`：两侧共享的路由与类型
- `docs/decisions/`：设计决策（0001 挂载与创建时机，0002 chip 语义，0003 官方池路径与标题，0004 创建前 fetch 与配置页，0005 中文名称与创建面板）
- `docs/images/`：README 用的界面截图

## 限制

- 只在 macOS 上开发与验证。
- 只管理本插件创建的 worktree（以分支上的 git config `branch.<name>.dsh-worktree-base` 识别）。
- worktree 目录固定为 `<仓库根>/.agents/worktrees`，不支持自定义。
- 不提供 commit、push、diff 等通用 git 操作。
