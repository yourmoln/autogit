# 平台适配说明

AutoGit 用同一套接口驱动 GitHub、Gitea / Forgejo 与 Gitee，下面是实际使用的端点与差异处理。

## 通用约定

- 所有请求走 `ApiClient`：统一超时（30s）、429/5xx 重试（最多 3 次，遵循 `Retry-After`）、错误体解析（`message` / `error_description` / `error` / `errors`）。
- 分页：GitHub/Gitee 使用 `per_page`，Gitea 使用 `limit`；翻页统一由 `page` 驱动，最多 20 页。
- 标签写入：一律使用「替换全部标签」的语义（`PUT .../labels`），传入 AutoGit 计算出的完整标签数组，避免并发增删导致的漂移。
- 行内评审评论：AutoGit 只锚定「新文件」行号，并且只锚定本次 diff 里出现过的行（判定见 `util/diff-anchors.ts`）。写入成功后还会读回核对锚点的真实行号（Gitea / Gitee 对行号的解释随版本变化）：锚定失败、请求被拒或读回对不上时，该条结论退回 PR 汇总评论并在任务日志里标注，不会丢失。
- diff 一律以 `-c core.quotePath=false` 读取，非 ASCII 路径保持原始 UTF-8（默认设置下 git 会写成 `"b/docs/\350\257\264\346\230\216.md"`，中文文件名就无法锚定）；锚点解析器另外兼容这种带引号的八进制转义，作为双保险。
- 强推保护：只有 `<branchPrefix>`（默认 `ai/`）开头的分支会被推送或强推。

## GitHub

| 操作 | 端点 |
| --- | --- |
| 当前用户 | `GET /user` |
| 仓库列表 | `GET /user/repos?affiliation=owner,collaborator,organization_member`（搜索走 `/search/repositories`） |
| 标签 | `GET/POST /repos/{o}/{r}/labels`、`PATCH /repos/{o}/{r}/labels/{name}` |
| Issue | `GET /repos/{o}/{r}/issues`（自动过滤掉 `pull_request` 字段存在的条目） |
| 评论 | `GET/POST /repos/{o}/{r}/issues/{n}/comments` |
| 行内评审评论 | `GET/POST /repos/{o}/{r}/pulls/{n}/comments`（创建时带 `commit_id`、`path`、`line`、`side=RIGHT`） |
| PR | `GET/POST /repos/{o}/{r}/pulls`，按分支查询用 `head=owner:branch` |

细节：

- 认证头 `Authorization: Bearer <token>`，附带 `X-GitHub-Api-Version: 2022-11-28`。
- 企业版地址若只填到主机名，会自动补 `/api/v3`；填 `https://api.github.com` 则原样使用。
- Git 推送使用 `Authorization: Basic base64("x-access-token:<token>")`。
- PR 与 Issue 共用编号空间，标签接口完全一致。
- 行内评论的行必须落在 diff 内，否则返回 422；`issues/{n}/comments` 不会返回行内评论，两者需要分别读取。

## Gitea / Forgejo

| 操作 | 端点 |
| --- | --- |
| 当前用户 | `GET /user` |
| 仓库列表 | `GET /user/repos`（搜索走 `/repos/search`） |
| 标签 | `GET/POST /repos/{o}/{r}/labels`、`PATCH /repos/{o}/{r}/labels/{id}` |
| Issue | `GET /repos/{o}/{r}/issues`（过滤 PR） |
| 评论 | `GET/POST /repos/{o}/{r}/issues/{n}/comments` |
| 行内评审评论 | 写：`POST /repos/{o}/{r}/pulls/{n}/reviews`（`event=COMMENT`，`comments[].new_position` 取新文件行号）；读：`GET .../reviews` 后逐个 `GET .../reviews/{id}/comments` |
| PR | `GET/POST /repos/{o}/{r}/pulls` |

细节：

- 实例地址只写到主机名即可（`https://git.example.com`），程序自动追加 `/api/v1`。
- 认证头使用 `Authorization: token <token>`；部分版本也接受 `Bearer`，如需可自行调整 `providers/gitea.ts`。
- 标签颜色需要 `#RRGGBB` 格式，与 GitHub 不同。
- 标签更新使用数字 `id`，因此 `updateLabel` 会先列出现有标签再 `PATCH`。
- 创建标签时会带上 `exclusive`，把「单选」语义交给 Gitea 自身约束。
- 分页参数是 `limit`（而非 `per_page`），已在 `paginate()` 中单独指定。
- `new_position` 名字叫 position，实际是**新文件的行号**（服务端用它做 `LineBlame`）；评论删除行时才是 `old_position`。没有「一次列出全部行内评论」的接口，所以要按 review 逐个查询（只查 `comments_count > 0` 的 review）。
- 行内评论写完会立刻读回 `GET /pulls/{n}/reviews/{id}/comments` 核对 `position`：不同版本对 `new_position` 的解释不一致，对不上就删除这条 review（`DELETE /pulls/{n}/reviews/{id}`，Gitea 会连带删除它下面的代码评论；老版本没有该端点时按尽力而为忽略）并退回汇总评论。
- Git 推送使用 Basic 认证：`用户名:Token`（用户名取自 `/user`，缺失时用 `oauth2`）。

## Gitee

| 操作 | 端点 |
| --- | --- |
| 当前用户 | `GET /user` |
| 仓库列表 | `GET /user/repos`（`affiliation` 不被支持时自动回退为无该参数） |
| 标签 | `GET/POST /repos/{o}/{r}/labels`，更新尝试 `PATCH` 后回退 `PUT` |
| Issue | `GET /repos/{o}/{r}/issues` |
| 评论 | `GET/POST /repos/{o}/{r}/issues/{n}/comments` |
| 行内评审评论 | `GET/POST /repos/{o}/{r}/pulls/{n}/comments`（创建时带 `path`、`position`、`commit_id`；`position` 语义见下） |
| PR | `GET/POST /repos/{o}/{r}/pulls` |
| PR 标签 | 依次尝试 `PUT /pulls/{n}/labels`、`PUT /issues/{n}/labels`（不同版本支持不同） |

细节：

- 基础地址 `https://gitee.com/api/v5`，Token 同时通过 `access_token` 查询参数与 `Authorization` 头传递，兼容不同版本。
- 标签颜色先尝试不带 `#` 的十六进制，被拒后自动补 `#` 重试。
- 仓库克隆地址由 `html_url + .git` 推导。
- Git 推送使用 Basic 认证（`oauth2:<token>` 或 `用户名:<token>`）。
- Gitee 的 PR 与 Issue 编号空间独立，因此识别关联 Issue 时会优先解析分支名（`ai/issue-<n>-*`），其次解析 PR 正文中的 `Closes #n`。
- Gitee 把「PR 评论」和「代码行评论」放在同一个端点，用 `comment_type=diff_comment` 区分；老版本不认这个参数，代码会在 400/404/422 时退回不带参数再按 `path` 过滤。
- `position` 的语义在不同部署上不一致（官方文档写「diff 中的行数」，实际也有实例把它当新文件行号）。AutoGit 两种口径各试一次：**请求被拒（4xx）也会继续试下一种口径**，只有创建成功且读回 `new_line` 等于目标行号才算锚定成功；读回缺 `new_line`（或与目标行号不符）会删除刚创建的评论并退回汇总评论，避免留下错位的锚点。

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
