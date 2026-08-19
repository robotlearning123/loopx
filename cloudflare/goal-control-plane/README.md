# LoopX Cloudflare Goal Control Plane

该模块是 LoopX 的 **目标驱动云端协调面 v1**。它不是另一个 LoopX Kernel，也不会运行 Coding Agent、创建 GitHub Issue/PR、合并代码、改变 Sentry 状态或执行任何生产操作。它仅提供每个 `goal_id` 的强一致协调原语：**租约、epoch 围栏、state version、幂等命令回执与无副作用唤醒消息**。

> **权威关系：** LoopX Kernel 决定并提交业务状态；Durable Object 仅协调并发；Queue 仅唤醒已授权执行器；任何真实 effect 需在后续 provider/extension 中以显式 gate、scope 与独立 validator 接入。

## 当前能力

| 能力 | 实现 | 边界 |
|---|---|---|
| 每目标协调 | 一个 Durable Object 对应一个 `goal_id` | Object 只保存 compact coordinator state，不保存原始 Sentry、Agent transcript 或工作区 |
| 排他执行 | `claim` 生成递增 epoch 与短期 lease | 同时只允许一个未过期 lease；旧 epoch 无法提交命令 |
| 安全续租/释放 | `renew`、`release` 必须匹配 agent、lease ID 与 epoch | 不允许通过过期或别的 Agent 的 lease 操作 |
| 幂等命令 | `command_id` 作为命令回执键 | 相同命令重试返回原回执，不增加 command count |
| 状态围栏 | 每个命令需提供 `expected_state_version` | 任何陈旧状态请求失败关闭 |
| 异步唤醒 | Queue 仅发送 compact command wakeup | Consumer 不执行 GitHub、Sentry、部署、merge 或 closeout effect |
| 认证 | 除 `/healthz` 外均要求 Bearer token | 部署时必须设置 Worker secret；默认拒绝未配置 token 的控制请求 |

## 路由

所有控制路由均要求 `Authorization: Bearer <CONTROL_PLANE_TOKEN>`。`/healthz` 是无状态部署健康检查，不能返回 goal 数据。

| 路由 | 方法 | 目的 |
|---|---|---|
| `/healthz` | `GET` | 检查 Worker 是否存活 |
| `/v1/goals/:goal_id/snapshot` | `GET` | 读取 public-safe 协调投影 |
| `/v1/goals/:goal_id/claim` | `POST` | 请求一个排他的、带 epoch 的 lease |
| `/v1/goals/:goal_id/renew` | `POST` | 在当前 lease 未过期时续租 |
| `/v1/goals/:goal_id/release` | `POST` | 释放当前 lease |
| `/v1/goals/:goal_id/commands` | `POST` | 接纳被 lease/state version 围栏的非外部 effect 命令，并写 Queue wakeup |

`commands` 接口仅接受 `triage`、`reproduce`、`implement`、`review`、`observe`、`merge_request`、`closeout_request` 等**请求意图**，以及 `read_only`、`propose`、`isolated_write` 范围。即使意图命名为 `merge_request` 或 `closeout_request`，v1 也只创建 wakeup receipt；实际 merge/closeout 必须由后续受 LoopX policy 和独立证据保护的 provider 执行。

## 部署前置条件

部署需要一个 Cloudflare 账户，并在账户中创建 Workers、Durable Objects 和 Queues 所需资源。当前任务检测到 Cloudflare 连接配置存在但未启用；代码已可本地验证，尚未向任何 Cloudflare 账户部署。

```bash
cd cloudflare/goal-control-plane
pnpm install
pnpm check
pnpm test

# 首次部署前：用 Cloudflare 认证方式登录或提供最小权限 API token。
# 不要把 token 写进 wrangler.jsonc、Git、Issue、PR 或 Agent prompt。
pnpm exec wrangler secret put CONTROL_PLANE_TOKEN
pnpm deploy
```

首次 `wrangler deploy` 会根据 `wrangler.jsonc` 创建/绑定 Durable Object 与 Queue 资源。生产应将 `CONTROL_PLANE_TOKEN` 替换为更细粒度的 Cloudflare Access service token 或受专用 API gateway 验证的工作负载身份；静态 bearer token 仅是 v1 的最小安全门槛。

## LoopX Bridge

仓库根目录中的 `loopx cloudflare-goal` 命令只渲染**不执行**的合同和 HTTP 请求预览，不读取 token 值。

```bash
# 输出控制面契约和边界。
python -m loopx.cli cloudflare-goal contract \
  --base-url https://control.example \
  --format json

# 输出 lease 申请的 HTTP 预览，不发起请求。
python -m loopx.cli cloudflare-goal claim-request \
  --base-url https://control.example \
  --goal-id sentry-repair-orders-42 \
  --agent-id triage-agent \
  --idempotency-key claim-repair-orders-42-a \
  --format json
```

实际 HTTP 调用应由后续的 `cloudflare-goal` provider 完成。该 provider 在发送请求前必须将 `goal_id`、`agent_id`、lease、epoch、command ID、scope digest、当前 LoopX state version 和 policy revision 与 Kernel 决策进行绑定；不得从自然语言、PR 标题、Sentry 文本或 Agent memory 推测写入权限。

## 本地验证

```bash
cd cloudflare/goal-control-plane
pnpm check
pnpm test
pnpm acceptance
```

`pnpm acceptance` 会在隔离的本地 Worker 运行时中检查 public health、认证拒绝、lease 排他、幂等 claim/command 重放、state-version 围栏、release/reclaim epoch 递增、旧 lease 拒绝、effect-free Queue wakeup 以及静态边界。每次运行生成被 Git 忽略的 `artifacts/acceptance.json`，其中只含 status、稳定 ID、epoch 和版本，不包含凭据或原始 payload。所有验收项均通过才允许部署。详细标准见 [`docs/integrations/cloudflare-goal-control-plane-acceptance.md`](../../docs/integrations/cloudflare-goal-control-plane-acceptance.md)。

仓库级 CLI smoke 可运行：

```bash
python -m loopx.cli cloudflare-goal contract --base-url https://control.example --format json
```

## 下一阶段

| 扩展 | 进入条件 | 不变量 |
|---|---|---|
| Sentry ingress provider | 已定义脱敏 `signal_observation` 和 webhook 验签 | 不持久化原始 event/PII；重复告警不创建重复 repair |
| GitHub provider | 已定义 Issue/PR/review/merge scope 与 GitHub App 最小权限 | Agent author 不能审批或合并自身 PR；head 改变废弃旧 review receipt |
| Claude Managed Agent worker | 每角色有独立 Environment、worktree、network egress 和 tool allowlist | CMA session state 不是 LoopX canonical state；effect 经过 Bridge custom tool |
| Post-deploy confirmation | 已定义 release/deployment/Sentry observation threshold | GitHub Issue closed 与 Sentry resolved 不等于 `confirmed_fixed` |

## Security Notes

**绝不**将 `.loopx/`、`~/.codex/loopx/`、本地路径、原始 Agent transcript、原始 Sentry payload、凭据、Cookie、access token 或完整生产日志放入 Durable Object、Queue、D1、KV、R2、MCP tool result 或公共文档。控制面只记录稳定 ID、摘要、哈希、版本、事件时间与允许公开的 evidence reference。
