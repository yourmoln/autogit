# 清除配置与数据

AutoGit 的全部状态都在一个目录里，**默认 `~/.autogit`**（可用 `AUTOGIT_HOME` 改到别处）。本文说明每样东西存在哪、删掉会发生什么，以及几种常见的重置组合。

> 动手前先停服务。SQLite 跑在 WAL 模式，进程还在写的时候删文件会留下不干净的伴生文件。

## 数据目录速查

```text
~/.autogit/                     # AUTOGIT_HOME 可覆盖
├── data/
│   ├── autogit.sqlite          # 账号、Token 密文、仓库配置、Issue/PR 缓存、任务与日志、设置、登录账号与会话
│   ├── autogit.sqlite-wal      # WAL 伴生文件，删除时一并处理
│   └── autogit.sqlite-shm
├── workspaces/
│   └── <repoId>/               # 每个仓库一个 git 克隆 + 任务级中间产物
├── secret.key                  # AES-256-GCM 主密钥，首次启动自动生成（64 位 hex）
└── logs/                       # 日志目录；服务日志同时输出到 stdout
```

| 路径 | 存了什么 | 删掉的后果 |
| --- | --- | --- |
| `data/autogit.sqlite` | 账号、Token 密文、仓库配置、Issue/PR 缓存、任务与逐行日志、全局设置、登录账号与会话 | 回到初始状态，需要重新添加账号和仓库；登录凭证恢复为默认 `admin` / `admin` |
| `workspaces/<repoId>/` | 该仓库的克隆、`ai/*` 分支、提示词与 JSON Schema 等任务产物 | 下次任务重新克隆；**未推送的本地改动一并丢失** |
| `secret.key` | 加解密 Token 的主密钥 | 库里已存的 Token 全部解不开（见下文） |
| `logs/` | 服务日志 | 无影响，只丢历史日志 |

AutoGit 目录之外还有一处：Codex 配置编辑产生的备份在 `$CODEX_HOME/autogit-backups`（默认 `~/.codex/autogit-backups`），最多保留 10 份 `config-*.toml`。

## 标准流程

### 1. 停服务

```bash
# Windows
Get-NetTCPConnection -LocalPort 4711 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }

# macOS / Linux
lsof -ti:4711 | xargs kill
```

### 2. 备份（可选，但强烈建议）

整个目录直接复制即可：单文件 SQLite + 工作区，没有外部依赖。

> **备份和恢复必须带上 `secret.key`**，否则恢复后数据库里的 Token 一个都解不开。

### 3. 删除

```bash
# Windows：整体重置
Remove-Item -Recurse -Force "$HOME\.autogit"

# macOS / Linux：整体重置
rm -rf ~/.autogit
```

只想清业务数据、保留主密钥：

```bash
# Windows
Remove-Item -Force "$HOME\.autogit\data\autogit.sqlite*"

# macOS / Linux
rm -f ~/.autogit/data/autogit.sqlite*
```

### 4. 重启

```bash
pnpm dev          # 或 pnpm build && pnpm start
```

启动时会重新建库、跑迁移，`secret.key` 若已删除会重新生成，前端刷新页面即可。

## 常见组合

| 目标 | 操作 |
| --- | --- |
| 清空账号 / 仓库 / 任务，保留加密密钥 | 删 `data/autogit.sqlite*` |
| 彻底重来（连密钥一起换） | 删整个 `~/.autogit` |
| 强制作废旧 Token 密文 | 删 `secret.key`，再重新录入所有账号 Token |
| 重置全局设置（轮询间隔、并发数） | 在「设置」页改回默认，或删库 |
| 忘记登录密码 / 重置登录账号 | 在「设置 → 登录与安全」里改；已经进不去就删 `data/autogit.sqlite*`（会一并清空业务数据），或用 sqlite 客户端执行 `DELETE FROM auth_account; DELETE FROM auth_sessions;` 后重启服务，登录凭证恢复为 `admin` / `admin` |
| 只清某个仓库的本地工作区 | 仓库页「移除仓库」勾选 purge，或单独删 `workspaces/<repoId>` |
| 迁移到另一台机器 | 复制整个 `~/.autogit`（**含 `secret.key`**）；路径不同就用 `AUTOGIT_HOME` 指过去 |
| 改端口 / 绑定地址 / 轮询 | 改 `.env` 或环境变量，**不需要删任何数据** |
| 清掉 Codex 配置备份 | 删 `$CODEX_HOME/autogit-backups` |

## 密钥不匹配的典型症状

`secret.key` 和数据库必须成对存在。典型的翻车方式：删了 `secret.key` 却留着 `autogit.sqlite`，或者把旧库拷到新机器上却没带密钥。症状是：

- 账号列表里 Token 预览显示 `无法解密`
- 服务日志或调度器状态里出现 `Unsupported secret payload format`
- 手动触发轮询持续失败

处理方式二选一：把原来的 `secret.key` 找回来；或者认账重来 —— 删掉库和密钥，重新添加账号。

> 反向情况：如果你设置了 `AUTOGIT_SECRET_KEY` 环境变量，它会**覆盖** `secret.key` 文件，此时删文件没用，要改的是环境变量（或删掉该变量回落到文件）。

## 运行参数不落库

端口、绑定地址、轮询间隔、并发数等全部来自环境变量，`.env` 只是本机载入方式（已被 `.gitignore` 忽略）：`AUTOGIT_HOME`、`AUTOGIT_SECRET_KEY`、`AUTOGIT_PORT`、`AUTOGIT_HOST`、`AUTOGIT_WEB_DIST`、`AUTOGIT_POLL_SECONDS`、`AUTOGIT_MAX_CONCURRENT`、`AUTOGIT_MAX_CONCURRENT_PER_REPO`、`AUTOGIT_LOG_LEVEL`、`AUTOGIT_CODEX_PATH`、`CODEX_HOME`。

要重置它们：删掉 `.env`（回到默认值），或从 [.env.example](../.env.example) 重新复制一份。

## 不会被清掉的东西

- **Codex 凭证与登录态**：`$CODEX_HOME/auth.json` 由 Codex CLI 自己管理，AutoGit 不读取也不代管（只做一次模型响应探测），清掉 AutoGit 不会让你掉登录。
- **远程仓库**：所有删除都只发生在本地，`ai/*` 分支、Issue、PR 都不受影响。
- **Git 凭据**：Token 通过 `GIT_CONFIG_*` 环境变量注入，不写进任何 `.git/config`，没有残留需要清。
- **你的项目源码**：AutoGit 只在 `workspaces/` 里操作克隆，不碰你打开的开发目录。

## 完全卸载

1. 停服务（见上）
2. `Remove-Item -Recurse -Force "$HOME\.autogit"`（或 `rm -rf ~/.autogit`）
3. 删掉项目目录，或用 `git clean -xfd` 清掉 `node_modules/`、`dist/` 等生成物
4. 可选：删 `$CODEX_HOME/autogit-backups`
5. 可选：到代码托管平台撤销用过的 Token
