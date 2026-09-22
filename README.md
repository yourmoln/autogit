# AutoGit

把 `ai/*` 标签变成流水线的开关：给 Issue 打上 `ai/todo`，AutoGit 会自动领取任务、调用本机 **Codex CLI** 实现代码、创建 PR、评审、按评审意见修复，并在合并后把 Issue 交回人工验证。

支持 **GitHub**、**Gitea / Forgejo**、**Gitee** 三类代码托管平台，可同时配置多个账号与仓库。

---

## 目录

- [核心能力](#核心能力)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [使用流程](#使用流程)
- [标签规范](#标签规范)
- [状态机](#状态机)
- [Codex CLI 集成](#codex-cli-集成)
- [HTTP API](#http-api)
- [数据与安全](#数据与安全)
- [常见问题](#常见问题)

---

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 多平台账号 | GitHub / Gitea（含自建实例）/ Gitee，Token 本地加密存储，可随时测试连通性 |
| 仓库托管 | 按账号浏览仓库并导入，单独控制启用/暂停轮询 |
| 一键初始化标签 | 在目标仓库创建/校正全部 15 个 `ai/*` 标签（颜色、描述、单选语义） |
| Issue 自动实现 | `ai/todo` → 领取 → `ai/doing` → Codex 实现 → 分支推送 → 创建 PR → `ai/needs-review` |
| PR 自动评审 | 结构化评审结论（JSON Schema），通过 → `ai/approved`，有问题 → `ai/needs-fix` |
| 自动修复回路 | 按评审意见修复并回推分支，修复完成自动回到 `ai/needs-review` |
| 合并后处理 | 检测到 PR 合并 → Issue 转 `ai/verify`，等待人工验证关闭 |
| 阻塞与暂停 | 失败自动打 `ai/stuck` 并留言原因；`ai/paused` 人工暂停，轮询器跳过 |
| 优先级调度 | `ai/priority-high` 全局插队，`ai/priority-low` 后置，默认普通 |
| 引擎偏好 | `ai/prefer-codex` / `ai/prefer-claude`、`ai/review-codex` / `ai/review-claude` |
| Codex CLI 管理 | 版本识别、能力探测、安装/自更新、config.toml 编辑与自动备份、模型响应探测 |
| 实时可观测 | WebSocket 推送任务状态与逐行日志（AI 输出、命令、Git、错误分流），可筛选与导出 |
| 任务编排 | 全局并发上限、仓库级串行、队列去重、超时与取消、失败重试 |

## 技术栈

选型目标是「一个人就能跑起来的本地工具」：单一语言、零外部服务、零原生编译依赖。

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 包管理 | **pnpm workspaces** | 单仓多包，依赖严格隔离，安装快 |
| 语言 | **TypeScript**（全栈） | 前后端共享标签、状态机与类型定义 |
| 后端 | **Fastify 5** | 低开销、插件生态成熟，原生支持 WebSocket 与静态资源托管 |
| 数据库 | **SQLite（`node:sqlite`）** | Node 22.5+ 内置驱动，无需编译原生模块，单文件数据便于备份 |
| 前端 | **React 19 + Vite 8 + Tailwind CSS 4** | 构建极快，样式体系轻量，动效用 `motion` |
| 数据获取 | **TanStack Query 5** | 缓存/失效语义清晰，和 WebSocket 推送天然配合 |
| 校验 | **Zod 4** | 请求体校验 + 类型推导 |
| 代码质量 | **Biome 2** | 格式化 + Lint 一体化，速度快 |
| AI 引擎 | **Codex CLI（`codex exec`）** | 所有 AI 能力都通过本机 CLI 执行，AutoGit 不代理任何模型请求 |

> 说明：数据库驱动使用 Node 内置的 `node:sqlite`，因此要求 **Node ≥ 22.5**（推荐 24 LTS）。这也是整个项目没有任何原生编译依赖的原因。

## 快速开始

```bash
# 1. 安装依赖（Node ≥ 22.5，pnpm ≥ 10）
pnpm install

# 2. 开发模式：后端 4711，前端 5173（已配置代理 /api 与 WebSocket）
pnpm dev

# 或者生产模式：构建后由后端统一托管前端
pnpm build
pnpm start          # http://127.0.0.1:4711
```

首次使用前，请确认 Codex CLI 可用：

```bash
codex --version        # 期望输出 codex-cli x.y.z
codex login            # 首次使用或凭证失效时执行一次设备授权
```

在网页的 **Codex CLI** 页面可以查看版本、能力探测结果与模型响应探测结果，也可以直接触发安装/更新、测试模型响应和编辑 `config.toml`。AutoGit 不读取也不代管凭证，只用一次最小的 `codex exec` 探针判断模型能否响应。

## 使用流程

1. **添加账号** — 进入「Git 账号」，选择平台并粘贴 Personal Access Token。GitHub 默认使用 `api.github.com`（企业版填 `https://git.example.com`，程序会自动补 `/api/v3`）；Gitea 填实例地址（自动补 `/api/v1`）；Gitee 使用 `https://gitee.com/api/v5`。
2. **导入仓库** — 在账号卡片里「浏览仓库」搜索并导入，或「仓库」页面手动填写 `owner/repo`。
3. **初始化标签** — 在仓库卡片或仓库工作台点击「初始化 / 同步标签」。该操作幂等：只创建缺失标签，颜色/描述不一致时更新，其它情况不动。
4. **启动流水线** — 在 Issue 上打 `ai/todo`，等待一个轮询周期（默认 45 秒），或在总览页点「立即轮询」。
5. **观察执行** — 「任务」页面可看到实现/评审/修复任务与逐行实时日志；仓库工作台显示 Issue/PR 看板。
6. **人工收尾** — PR 变成 `ai/approved` 后由人工合并；合并后 Issue 转 `ai/verify`，验证完成手动关闭。

### 最小权限建议

| 平台 | 权限 |
| --- | --- |
| GitHub | `repo`（代码 + PR）、`issues`（Issue 与标签） |
| Gitea | `repository` 读写、`issue` 读写 |
| Gitee | `projects`、`pull_requests`、`issues`（私有仓库需勾选对应私有项目） |

## 标签规范

所有标签统一使用 `ai/` 前缀，共 15 个，由 AutoGit 在仓库中创建与维护。

| 标签 | 分组 | 语义 |
| --- | --- | --- |
| `ai/todo` | Issue 状态（单选） | 待 AI 实现；轮询领取后转 `ai/doing` |
| `ai/doing` | Issue 状态（单选） | AI 正在实现；开 PR 后转 `ai/in-review`，异常转 `ai/stuck` |
| `ai/in-review` | Issue 状态（单选） | 已关联 PR 并处于评审/修复；合并后转 `ai/verify` |
| `ai/verify` | Issue 状态（单选） | PR 已合并，待提出人/产品验证；通过后人工关闭 Issue |
| `ai/needs-review` | PR 状态（单选） | 待 AI 评审；通过转 `ai/approved`，有问题转 `ai/needs-fix` |
| `ai/needs-fix` | PR 状态（单选） | 待按评审意见修复；完成后转 `ai/needs-review` |
| `ai/approved` | PR 状态（单选） | AI 评审通过，待人工审核并决定是否合并 |
| `ai/stuck` | 异常状态 | 流水线暂停；处理后移除并打回一个适用状态标签 |
| `ai/paused` | 调度开关 | 人工暂停；保留当前状态但轮询器不执行 |
| `ai/prefer-codex` | 执行引擎（可选单选） | Codex 优先；限额时切 Claude；默认即此顺序 |
| `ai/prefer-claude` | 执行引擎（可选单选） | Claude 优先；限额时切 Codex |
| `ai/review-codex` | 评审引擎（可选单选） | Codex 评审优先；未设置时默认即此顺序 |
| `ai/review-claude` | 评审引擎（可选单选） | Claude 评审优先；未设置时 Codex 优先 |
| `ai/priority-high` | 调度优先级（可选单选） | 高；构建队列全局优先，评审队列内优先 |
| `ai/priority-low` | 调度优先级（可选单选） | 低；无标签为普通，构建/评审队列均后置 |

> 引擎说明：默认且唯一的完整实现是 **Codex CLI**。`ai/prefer-claude` / `ai/review-claude` 只有在「设置」中开启 Claude 回退且本机存在 `claude` 命令时才会生效，否则自动回退到 Codex。

## 状态机

```mermaid
stateDiagram-v2
    [*] --> todo: 人工打 ai/todo
    todo --> doing: 轮询器领取
    doing --> in_review: 提交代码 + 创建 PR
    doing --> stuck: 实现失败/超时/无改动
    in_review --> verify: PR 被合并
    in_review --> stuck: PR 未合并被关闭
    needs_review --> approved: 评审通过
    needs_review --> needs_fix: 评审有问题
    needs_fix --> needs_review: 修复并回推分支
    approved --> [*]: 人工合并
    verify --> [*]: 人工验证并关闭 Issue
```

约定：

- Issue 与 PR 各自维护一套「单选」状态标签，切换状态时旧状态标签会被移除。
- `ai/stuck` 与 `ai/paused` 是附加开关，不会覆盖已有状态，便于人工判断停在哪里。
- 只跟踪 **open** 的 Issue/PR：远端关闭 Issue（或 PR 被合并、关闭）后，条目会在下一次轮询时离开看板、计数与调度队列；本地快照保留，用于任务历史与标签回溯。
- 修复与评审共用 PR 分支；分支名固定为 `<branchPrefix><issueNumber>-<slug>`（默认 `ai/issue-`），AutoGit 只会强推自己的分支。

## Codex CLI 集成

| 功能 | 实现 |
| --- | --- |
| 版本识别 | 执行 `codex --version`，从 `codex-cli x.y.z` 中解析版本号 |
| 能力探测 | 解析 `codex exec --help` 与 `codex --help`，只在支持时追加 `--json`、`--sandbox`、`--cd`、`--output-last-message`、`--output-schema`、`-c` 等参数 |
| 安装 / 更新 | 已安装且支持 `codex update` 时执行自更新，否则回退到 `npm install -g @openai/codex@latest`；输出实时推送前端 |
| 模型响应 | 用固定提示词执行一次最小的 `codex exec`（只读沙箱、AutoGit 数据目录内运行），按退出码与输出判断模型能否响应；结果缓存 5 分钟，凭证始终由 Codex CLI 自己管理 |
| 配置管理 | 直接编辑 `$CODEX_HOME/config.toml`，保存前做 TOML 校验，自动备份并保留最近 10 份 |
| 执行方式 | `codex exec --json -` 从 stdin 读取提示词；评审任务额外使用 `--output-schema` 强制结构化结论 |
| 隔离 | 每个仓库一个工作区（`~/.autogit/workspaces/<repoId>`），任务级目录存放提示词、JSON Schema 与最后一条消息 |

任务提示词可在仓库工作台点击「提示词预览」查看，不会触发真实执行。

## HTTP API

所有接口都在 `/api` 下，返回 JSON；实时事件走 WebSocket `/api/realtime`。

| 分类 | 方法与路径 |
| --- | --- |
| 系统 | `GET /api/health`、`GET /api/system/overview`、`GET /api/system/activity`、`GET /api/system/labels` |
| 调度 | `GET /api/orchestrator`、`POST /api/orchestrator/tick`、`POST /api/orchestrator/restart` |
| 账号 | `GET/POST /api/accounts`、`PATCH/DELETE /api/accounts/:id`、`POST /api/accounts/:id/test`、`GET /api/accounts/:id/repositories` |
| 仓库 | `GET/POST /api/repositories`、`PATCH/DELETE /api/repositories/:id`、`GET /api/repositories/:id/overview` |
| 标签 | `GET /api/repositories/:id/labels/preview`、`POST /api/repositories/:id/labels/initialize` |
| 任务 | `POST /api/repositories/:id/sync`、`POST /api/repositories/:id/tasks`、`GET /api/tasks`、`GET /api/tasks/:id`、`POST /api/tasks/:id/cancel`、`POST /api/tasks/:id/retry` |
| Codex | `GET /api/codex/status`、`POST /api/codex/install`、`POST /api/codex/invalidate`、`POST /api/codex/probe`、`GET/PUT /api/codex/config`、`GET /api/codex/prompt-preview` |
| 设置 | `GET/PUT /api/settings` |

## 数据与安全

- **数据目录**：`~/.autogit`（可用 `AUTOGIT_HOME` 覆盖），包含 `data/autogit.sqlite`、`workspaces/`、`secret.key`、`logs/`。
- **Token 加密**：使用 AES-256-GCM 加密后落库，密钥来自 `AUTOGIT_SECRET_KEY` 或自动生成的 `secret.key`；接口返回的只是掩码预览。
- **Git 认证**：推送/拉取通过 `GIT_CONFIG_*` 环境变量注入 `http.extraheader`，Token 不会写进 `.git/config`，也不会出现在命令行参数里。
- **分支保护**：只有以 `branchPrefix`（默认 `ai/`）开头的分支才会被强推，人工分支永远不会被覆盖。
- **执行边界**：所有代码改动都发生在独立克隆的工作区，不会碰你的本地开发目录；沙箱与审批策略由 Codex 配置控制（默认 `workspace-write` + `never`）。
- **不自动合并**：评审通过只打 `ai/approved`，合并动作始终留给人工。
- **可重置**：全部状态都在 `~/.autogit` 一个目录里，清除与迁移步骤见 [docs/RESET.md](docs/RESET.md)。

环境变量见 [.env.example](.env.example)。常用项：

```bash
AUTOGIT_PORT=4711
AUTOGIT_POLL_SECONDS=45
AUTOGIT_MAX_CONCURRENT=2
# AUTOGIT_CODEX_PATH=C:\Users\me\AppData\Roaming\npm\codex.cmd
```

## 验证

```bash
pnpm typecheck    # 三个包全量类型检查
pnpm check        # Biome lint + 格式校验
pnpm build        # shared → server → web
pnpm simulate     # 端到端模拟：真实 git + 假 Codex + 假 Git 平台
```

`pnpm simulate` 会在临时目录中创建裸仓库，跑完整链路（初始化 15 个标签 → 实现 → 建 PR → 评审不通过 → 修复 → 复审通过 → 合并 → `ai/verify`），并断言每一步的标签与产物，最后自动清理。

## 常见问题

**轮询没有反应？**
确认仓库「轮询已启用」、Issue 是 open 状态且带有 `ai/todo`，并且没有 `ai/paused` / `ai/stuck`。可在总览页点「立即轮询」手动触发一次，任务页会显示日志。

**任务失败并打上 `ai/stuck`？**
任务日志（任务页 → 选中任务）会显示 Codex 的输出与错误。常见原因是模型响应探测未通过（凭证失效、模型权限不足）、Issue 描述信息不够。可先在 Codex CLI 页面点「测试模型响应」确认模型能回答，再移除 `ai/stuck`，打回 `ai/todo` 或 `ai/needs-review` 继续。

**自动标签初始化一直失败？**
检查 Token 是否具备仓库的 `issues`/`labels` 管理权限；自建 Gitea 请确认实例地址能被本机访问，并且版本 >= 1.20。

**Gitee 上 PR 标签没有生效？**
不同 Gitee 版本对标签接口的支持略有差异，AutoGit 会依次尝试 `PUT /pulls/{n}/labels`、`PUT /issues/{n}/labels` 等端点；若仍失败，任务日志会保留原始 HTTP 错误，便于定位。

**能改成用 Claude 吗？**
可以，但需要本机安装 `claude` 命令，并在「设置」中开启 Claude 回退；带 `ai/prefer-claude` / `ai/review-claude` 的条目会优先使用它。默认全部走 Codex CLI。

---

架构与实现细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，平台差异见 [docs/PROVIDERS.md](docs/PROVIDERS.md)，清除配置与数据见 [docs/RESET.md](docs/RESET.md)。
