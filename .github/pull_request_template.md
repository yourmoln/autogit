<!--
PR 标题必须使用 `<英文类型>: <描述>`：类型取 feat / fix / chore / refactor / docs / build /
perf / test / ci / style / revert 之一，冒号是半角且后面只有一个空格，例如 `feat: 新增登录密码`。
AutoGit 自动创建的 PR 由 renderTitle() 归一化，这个模板给人写的 PR 用。

下面两节（实现假设清单 / 代码逻辑图）是仓库约定：必须原样保留这两级标题、各出现一次，
并且都要有实际内容，不要留空或只写占位文字。
-->

## 关联 Issue

Closes #

## 改动说明

<!-- 一两句说明改了什么、为什么 -->

## 实现假设清单

- 无额外假设：按 Issue 描述与仓库既有约定实现。

## 代码逻辑图

```mermaid
flowchart LR
    A[触发] --> B[改动] --> C[验证]
```
