# DSH 0.2.2-rc.4 兼容验证

2026-11-18。本地插件基于 `7436121`（`0.1.21` 工作树），使用 Node `24.22.1`、pnpm `10.33.0` 和 Python `3.12.10`。

## 上游契约与回归

RC.4 的 DeepSeek Messages 适配器在收到流式拒答时先返回已计费用量，再以 `CONTENT_REFUSED` 结束。新增回归为官方适配器提供回环 SSE 响应，真实运行 AgentLoop、具名子代理与 `trellis_wait`。用例检查一条请求、失败结束事件、失败尝试中的部分文本和 token 用量，以及对话历史排除该文本。等待结果包含实际子代理 Session ID，并明确将检查判为失败。[官方 RC.4 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.4) · [拒答迁移说明](https://github.com/deepseek-ai/deepseek-harness/blob/3f321d32bfe382212a8ed8785c1d47a5a300aa23/docs/upgrade-guide/v0.2.2-rc.3/deepseek-refusal-code/guide.zh.md)

旧测试在 RC.4 上复现了 `addition-only` 动态工具声明的预期不匹配。测试现在显式检查 RC.2、RC.3、RC.4 都会在移除工具或从空集恢复时重建声明。RC.4 加入二十一个宿主共用的兼容清单，Windows 和 Linux CI 都从该清单取目标。Cordis 固定为 `4.1.0`、Schemastery 为 `3.19.0`、Include 和 Loader 为 `1.1.0`。现有的 `engines.dsh` 和 npm peer 范围已接纳该版本。

E2E 锁定官方 DSH RC.4、Group `1.1.0` 和 Trellis `0.7.0-beta.4`。RC.3 与 RC.4 锁文件各含 721 个包和 721 条依赖快照。归一化 DSH 版本、对应 tarball 完整性哈希与 pnpm peer 哈希后，两份依赖图一致。

## Windows 本地验证

客户端构建、生成产物一致性、打包检查和 E2E 冻结锁安装均通过。

| 验证 | 通过 | 按宿主能力跳过 | 失败 |
| --- | ---: | ---: | ---: |
| 开发基线 `0.2.0-rc.1` | 217 | 10 | 0 |
| RC.4 完整套件 | 227 | 0 | 0 |
| 21 宿主完整矩阵（含 RC.4） | 4618 | 149 | 0 |

## SDK E2E

| E2E 模式 | 权限 | 结果 |
| --- | --- | --- |
| Native | 默认 `workspace-write` | 失败。检查子代理运行 `node --test` 时出现 `spawn EPERM` |
| PTC | 默认 `workspace-write` | 未执行，默认流程在 Native 失败后退出 |
| Native | 隔离 `danger-full-access` 对照 | 通过，33 次回环模型请求 |
| PTC | 隔离 `danger-full-access` 对照 | 通过，34 次回环模型请求 |

对照通过正常 prepack 安装本地 tarball，使用临时 Git 项目、独立 `DSH_HOME` 和脚本化模型。两种模式验证实际任务绑定和归档、面包屑去重、会话隔离、具名子代理等待、SDK 重启恢复，以及关闭时取消活动子代理的落盘事件。Windows 默认沙箱仍有上述阻塞。Linux E2E、桌面 UI 与真实模型调用均未验证。

## 原始证据

- `%TEMP%/dsh-trellis-rc4-validation` 保存最终兼容矩阵 `matrix-final.log`、拒答、构建、打包和 E2E 日志。
- 默认 SDK E2E 报告位于 `%TEMP%/dsh-trellis-e2e-jNmR0y/report.json`。
- Native/PTC 对照报告位于 `%TEMP%/dsh-trellis-e2e-yJAv3K/report.json`。
