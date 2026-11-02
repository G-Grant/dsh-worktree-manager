# 0003 — worktree 目录固定为官方池，工作区标题只用名称

日期: 2026-11-02
状态: 已接受

## 背景

最初存储根可配：`rootDir` 默认 `$DSH_HOME/worktrees`，实际路径 `<根>/<仓库名>/<名称>`。这把 worktree 放到主项目外面，侧栏里与主仓库平级，标题还拼成 `gis-mfg-client.123`。用户希望目录跟项目走、标题就是输入的名字，并与 DSH 侧栏「子层级」对齐。

核对 dsh 官方行为后：

1. 侧栏分组 **Workspace Tree** 按已注册工作区的规范路径嵌套：子路径以 `祖先路径/` 开头则挂到最近祖先下。默认分组 WorkSpace 是平铺。官方不扫盘、不解析 symlink，也不识别 git worktree。
2. 实验包 `dsh-experimental-worktree` 的池目录是 `<当前检出根>/.agents/worktrees/<name>`；新建该池时写入内容为 `*` 的 `.gitignore`，已有池不改。

因此「出现在主项目下面」靠的是路径落在主仓库工作区之内，不是本插件画树。

## 决策

**目录固定为官方池 `<仓库根>/.agents/worktrees/<名称>`。** 仓库根取主检出的 git toplevel（从已有 worktree 里创建也落到主项目池，避免套娃）。名称非法字符压成单段目录名，占用时加 `-2` 这类后缀。新建池时写入 `*` 的 `.gitignore`，与官方实验包一致。

**不再提供 `rootDir`。** 配置 schema 与配置页去掉该字段；旧 profile 里残留的 `rootDir` 仍算已知键，忽略其值，避免插件加载失败。

**工作区标题等于 worktree 名称。** 输入 `123` 则标题、分支名、目录名都是 `123`，不再拼 `gis-mfg-client.123`。管理列表在工作区未注册时回退显示分支名。

- 被否决：继续用 `$DSH_HOME/worktrees/<仓库名>/…`（侧栏无法挂到主项目下）；自造 `<仓库根>/.dsh/worktrees`（能嵌套，但与官方池不一致）；允许用户改根目录。
- 代价：改路径后必须重启已加载宿主的 DSH（桌面端不会热加载 `lib/git.js`）；已有 worktree 不会搬家，旧标题也不会自动改。

## 影响

- 正面：与官方 worktree 池、Workspace Tree 嵌套规则一致；多仓库、多机不再共享一个 `$DSH_HOME` 根。
- 负面：主仓库若未忽略 `.agents`，新建池可能在 `git status` 里露出 `?? .agents/`（官方同样只在池内写 `*`）；与实验包共用同一池目录时，名称冲突靠后缀规避。
- 验证：编译后的 `createWorktree` 对名称 `123` 得到 `<repo>/.agents/worktrees/123`、标题 `123`。侧栏子层级需将分组设为 Workspace Tree。
