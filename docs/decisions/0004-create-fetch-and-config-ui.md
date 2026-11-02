# 0004 — 创建前拉取基线，以及配置页的展示

日期: 2026-11-02
状态: 已接受

## 背景

从过期的本地基线切新分支，worktree 会缺远程已有的提交。配置页原先用 SegmentedControl 做命名方式，观感差；根目录、环境说明等文案用户能从 chip 本身看懂，属于噪音。

## 决策

**增加 `fetchBaseBeforeCreate`，默认开启。** 创建前对基线分支 `git fetch` 其远程；仓库没有对应远程时跳过；fetch 失败则中止创建（`fetchFailed`），不退回用过期本地引用凑合。本机 HEAD 仍不被这次 fetch 快进。

**命名方式用原生 RadioGroup。** `manual` / `auto` 仍是写穿配置，不用 SegmentedControl。

**配置页只留会改行为的项。** 去掉可配 `rootDir`（见 0003）；去掉「直接在当前目录工作」以及环境/分支上用户已能看懂的 hint。`copyFiles` 仍是暂存后保存；命名与清理、fetch 开关仍是写穿。

- 被否决：fetch 失败时静默用本地基线（会让「拉最新」开关名不副实）；用 SegmentedControl 撑命名项。

## 影响

- 正面：默认拿到远程最新基线；配置页只剩命名、清理、fetch、复制列表。
- 负面：无网或 remote URL 失效时，开启该开关就创建不了，需要先关掉或修好远程。
- 验证：有 origin 且远程超前后，`fetchBase: true` 的 worktree 含新提交、主仓库仍停在原分支；remote 指向不存在的地址时返回 `fetchFailed`。
