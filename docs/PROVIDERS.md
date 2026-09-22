# 平台适配说明

AutoGit 用同一套接口驱动 GitHub、Gitea / Forgejo 与 Gitee，下面是实际使用的端点与差异处理。

## 通用约定

- 所有请求走 `ApiClient`：统一超时（30s）、429/5xx 重试（最多 3 次，遵循 `Retry-After`）、错误体解析（`message` / `error_description` / `error` / `errors`）。
- 分页：GitHub/Gitee 使用 `per_page`，Gitea 使用 `limit`；翻页统一由 `page` 驱动，最多 20 页。
- 标签写入：一律使用「替换全部标签」的语义（`PUT .../labels`），传入 AutoGit 计算出的完整标签数组，避免并发增删导致的漂移。
- 强推保护：只有 `<branchPrefix>`（默认 `ai/`）开头的分支会被推送或强推。

## GitHub

| 操作 | 端点 |
| --- | --- |
| 当前用户 | `GET /user` |
| 仓库列表 | `GET /user/repos?affiliation=owner,collaborator,organization_member`（搜索走 `/search/repositories`） |
| 标签 | `GET/POST /repos/{o}/{r}/labels`、`PATCH /repos/{o}/{r}/labels/{name}` |
| Issue | `GET /repos/{o}/{r}/issues`（自动过滤掉 `pull_request` 字段存在的条目） |
| 评论 | `GET/POST /repos/{o}/{r}/issues/{n}/comments` |
| PR | `GET/POST /repos/{o}/{r}/pulls`，按分支查询用 `head=owner:branch` |

细节：

- 认证头 `Authorization: Bearer <token>`，附带 `X-GitHub-Api-Version: 2022-11-28`。
- 企业版地址若只填到主机名，会自动补 `/api/v3`；填 `https://api.github.com` 则原样使用。
- Git 推送使用 `Authorization: Basic base64("x-access-token:<token>")`。
- PR 与 Issue 共用编号空间，标签接口完全一致。

## Gitea / Forgejo

| 操作 | 端点 |
| --- | --- |
| 当前用户 | `GET /user` |
| 仓库列表 | `GET /user/repos`（搜索走 `/repos/search`） |
| 标签 | `GET/POST /repos/{o}/{r}/labels`、`PATCH /repos/{o}/{r}/labels/{id}` |
| Issue | `GET /repos/{o}/{r}/issues`（过滤 PR） |
| 评论 | `GET/POST /repos/{o}/{r}/issues/{n}/comments` |
| PR | `GET/POST /repos/{o}/{r}/pulls` |

细节：

- 实例地址只写到主机名即可（`https://git.example.com`），程序自动追加 `/api/v1`。
- 认证头使用 `Authorization: token <token>`；部分版本也接受 `Bearer`，如需可自行调整 `providers/gitea.ts`。
- 标签颜色需要 `#RRGGBB` 格式，与 GitHub 不同。
- 标签更新使用数字 `id`，因此 `updateLabel` 会先列出现有标签再 `PATCH`。
- 创建标签时会带上 `exclusive`，把「单选」语义交给 Gitea 自身约束。
- 分页参数是 `limit`（而非 `per_page`），已在 `paginate()` 中单独指定。
- Git 推送使用 Basic 认证：`用户名:Token`（用户名取自 `/user`，缺失时用 `oauth2`）。

## Gitee

| 操作 | 端点 |
| --- | --- |
| 当前用户 | `GET /user` |
| 仓库列表 | `GET /user/repos`（`affiliation` 不被支持时自动回退为无该参数） |
| 标签 | `GET/POST /repos/{o}/{r}/labels`，更新尝试 `PATCH` 后回退 `PUT` |
| Issue | `GET /repos/{o}/{r}/issues` |
| 评论 | `GET/POST /repos/{o}/{r}/issues/{n}/comments` |
| PR | `GET/POST /repos/{o}/{r}/pulls` |
| PR 标签 | 依次尝试 `PUT /pulls/{n}/labels`、`PUT /issues/{n}/labels`（不同版本支持不同） |

细节：

- 基础地址 `https://gitee.com/api/v5`，Token 同时通过 `access_token` 查询参数与 `Authorization` 头传递，兼容不同版本。
- 标签颜色先尝试不带 `#` 的十六进制，被拒后自动补 `#` 重试。
- 仓库克隆地址由 `html_url + .git` 推导。
- Git 推送使用 Basic 认证（`oauth2:<token>` 或 `用户名:<token>`）。
- Gitee 的 PR 与 Issue 编号空间独立，因此识别关联 Issue 时会优先解析分支名（`ai/issue-<n>-*`），其次解析 PR 正文中的 `Closes #n`。

## 权限清单

| 平台 | 需要的权限 |
| --- | --- |
| GitHub | `repo`（读写代码/PR）、`issues`（读写 Issue 与标签） |
| Gitea | `repository` 读写、`issue` 读写 |
| Gitee | `projects`、`pull_requests`、`issues` |

## 常见错误

| HTTP | 含义与处理 |
| --- | --- |
| 401 | Token 无效或过期，到「Git 账号」页重新保存 Token 并测试连接 |
| 403 | 权限不足或触发限流；检查 Token scope，必要时降低轮询频率 |
| 404 | 私有仓库未被 Token 授权，或企业版 API 地址填错 |
| 422 | 请求体被拒（多见于标签颜色格式或 PR 分支不存在），任务日志会保留原始响应 |
