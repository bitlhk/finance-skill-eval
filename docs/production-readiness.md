# 生产就绪检查（2026-10-19）

结论：三种部署方式的实现、公共运维工具、日志和文档已补齐；代码与真实多 Skill 功能验证通过。**尚未在用户目标生产服务器部署，不能把本机验证等同于生产上线验收通过。**

适用范围为可信人员使用的单 API 私有工作区；需要公网开放执行 Runtime、不可信代码强隔离、共享目录多 API 副本的场景，不在当前上线能力范围内。

## 已完成的改造

- Linux/systemd、Docker 双服务、Windows/WinSW 的准备、预检、启动/停止、状态/日志、健康、备份/恢复、升级/回滚入口。
- 受保护配置、强令牌要求、loopback/私有网络、锁定 Python 依赖及构建产物检查。
- HTTP/评测/整组迁移/逐题验收/子进程日志关联，query/header/body/上游异常内容不进入普通日志。
- SDK 文件日志关闭，Runtime stderr 有界收集；uvicorn 异常也使用安全摘要。
- API/SSE 有界停机、Runtime 子进程树回收、进程退出码传递、中断任务恢复标记。
- 离线备份、SHA256 校验、拒绝覆盖/路径穿越、独立目录恢复；代码回滚与数据恢复明确分开。
- 三种日志保留方案、HTTPS 代理样例、排障与现场告警清单。

## 验证结果与边界

| 检查 | 结果 | 实际范围 |
| --- | --- | --- |
| TypeScript / Web 类型检查、生产构建 | 通过 | pnpm check / build；前端仍有 >500 KiB chunk 提示，非构建失败 |
| 最终全量回归 | 通过 | 138 文件，1081 passed、2 skipped；包含本次日志/SSE 改动，跳过项未计入通过 |
| 后续 SSE/服务关闭回归 | 通过 | 5 文件、20 项，含真实 HTTP SSE 关闭、账户模式、迁移服务 |
| 追加异常摘要检查 | 通过 | 日志/SSE 两个文件 4 项，验证 stderr 只提取异常类别 |
| 部署配置和端口检查 | 通过 | 4 项，真实占用端口、无效令牌/占位符/路径/模型别名 |
| Python 日志/SDK 配置/进程回收/实例/脚本 | 通过 | Windows 16 项中 15 passed、1 POSIX-only skipped；WSL 单独补验 POSIX 回收 |
| 备份/恢复 | 通过 | Windows/WSL 各 3 项：完整往返、禁止覆盖、活动状态拒绝、路径穿越、摘要损坏 |
| Windows 配置 | 通过 | PowerShell 解析、真实模板生成、带空格和 & 的路径、XML、LocalService、轮转、目录边界 |
| Linux 部署文件 | 通过 | Bash、systemd-analyze、Compose schema；systemd 校验临时使用已有可执行文件占位，未安装正式服务 |
| 真实原生进程冒烟 | 通过 | API + OpenJiuwen：预检、鉴权、重复启动、日志 canary、IPC/stdin 停机、崩溃后新进程恢复、重复停止 |
| 真实多 Skill UI 端到端 | 通过 | 9 个检查点；真实 Agent、Runtime、Judge，无模型/Runtime 测试替身 |
| Docker 完整构建和运维演练 | 通过 | 真镜像、Linux Agent SDK 导入、双服务、鉴权、自动重启/PID 复用、持久化、备份恢复、升级回滚 |

原生冒烟：Node v26.8.2、OpenJiuwen 0.1.17.post1，报告位于本地 reports/production-smoke-1792394868814/result.json。冒烟不调用模型，不作为业务验收证据。

真实 UI 验收：2026-10-19 07:03:51–07:11:51 UTC，迁移/执行模型 deepseek-v4-flash，Judge glm-5.3。两个 Skill 完整导入、整体分析、冻结候选、联合验收通过；开发集 2/2、留出集 1/1，验证实际脚本调用、成员和 Runtime 身份、UI 下载、会话释放。候选首次即通过，因此本轮未触发整体修复；跨成员修复及冻结历史由回归测试覆盖。测试使用隔离数据和测试专用诊断目录，未改变默认生产禁用详细 dump 的配置。

本地证据：reports/bundle-live-f1ec690f-f7e4-4a64-a43c-722eed2888d9/result.json。reports 被 Git 忽略，完整模型证据不提交仓库。

容器测试环境：WSL Ubuntu、Docker 29.1.3、Compose 2.40.3；镜像 finance-skill-eval:production-audit-20261019，image ID 为 sha256:45dd6009a858d941e38ddde24a356c3fe7622056de0e269c96fc1f32d4950e8c（本机测试制品，未推送仓库）。使用隔离 Compose 项目真实启动 API/Runtime，主动 SIGKILL supervisor 后确认自动重启与健康恢复，校验跨重启的数据标记、离线备份和恢复后的字节一致性。升级/回滚使用同制品的不同 tag，验证命令流程与持久卷，不证明跨版本数据格式兼容。测试结束已删除该测试项目的容器和卷；未更改已有其他服务。

Docker 演练不调用模型；真实模型验证来自上述 Windows 原生 UI 流程。Linux/systemd 和 Windows/WinSW 的服务注册、开机自启仍属于现场验收，不能由 Compose 成功代替。

## 复测入口

```sh
pnpm check
pnpm test
node --test deploy/tests/settings.test.mjs
python -m unittest discover -s deploy/tests -v
# 使用锁定 OpenJiuwen 环境中的 Python
python -m unittest integrations.openjiuwen.test_operational_logging integrations.openjiuwen.test_session_process -v
node scripts/verify-production.mjs --env /absolute/private/production.env
bash deploy/tests/linux-static.sh
# 设置 FINANCE_EVAL_IMAGE、FINANCE_EVAL_CONFIG_DIR 后：
bash deploy/tests/docker-smoke.sh
```

Windows 配置测试：`./deploy/tests/windows-config.ps1 -Python C:/absolute/runtime/python.exe`。Docker 冒烟复制私有配置到临时目录，生成独立项目和卷，结束只清理该测试项目；会读取真实配置但不调用模型。真实业务 UI 验收使用 `scripts/verify-bundle-migration-live-ui.mjs`，按其文件头设置私有环境文件、Runtime 配置和真实 Python。

## 生产现场仍需完成

- [ ] 在目标 Linux/systemd 或 Windows Server/SCM 上以正式服务账户安装，验证开机自启、机器重启、异常恢复和目录 ACL；本机模板检查不能替代。
- [ ] 填写生产模型/Judge/MCP 凭据和出口代理，在目标网络重新跑多 Skill 联合验收；开发凭据和本机成功不代表生产权限。
- [ ] 配置真实域名、TLS、网关超时、上传限制和防火墙；确认 Runtime 无外部入口。
- [ ] 演练恢复到独立实例，加载历史任务/候选并检查；确定 RPO/RTO、备份加密、保留期和数据版本回退条件。
- [ ] 接入告警，实际触发健康失败、磁盘低容量、进程重启和备份失败告警；确认接收人。
- [ ] 按实际任务并发、源码大小、模型耗时进行容量和长时间运行测试；当前回归不是负载测试。
- [ ] 按企业发布策略完成依赖/镜像漏洞扫描并固定制品 digest；本次未作“无漏洞”声明。

完成对应部署方式的现场项后，才能签署生产上线验收。操作入口见 [生产部署](production-deployment.md)，日志策略见 [生产日志](production-logging.md)。
