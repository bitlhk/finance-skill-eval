# 本机 Windows / WSL 历史部署验收（2026-10-19）

本页保留旧发布 `1d50d37` 的验收记录。当前发布以 Windows 的 `C:/ProgramData/FinanceSkillEval/current.txt`、
WSL 的 `/opt/finance-skill-eval/current` 及发布目录内 `DEPLOYED_REVISION` 为准。
新版操作见[生产部署](production-deployment.md)与[Builder 接入](runtime-builder-integration.md)，本机最新测试证据保存在忽略提交的 `reports/`。

结果：两套系统均已实际安装 API 与 Runtime 服务，使用低权限服务账户运行，真实三 Skill 整体迁移与联合验收均通过。服务保留运行，数据、配置、日志及备份独立。

## 安装位置

| 项目 | Windows | WSL Ubuntu |
| --- | --- | --- |
| 系统 | Windows 11 Pro 10.0.26100 | Ubuntu 26.04.1 LTS / systemd |
| API 页面 | http://127.0.0.1:56361 | http://127.0.0.1:57361 |
| Runtime | 127.0.0.1:56362 | 127.0.0.1:57362 |
| 服务 | finance-eval-api / finance-eval-runtime | finance-eval-api / finance-eval-runtime |
| 实际账户 | NT AUTHORITY\LocalService | finance-eval |
| Node / Python | 26.8.2 / 3.12.14 | 22.23.3 / 3.11.16 |
| 发布目录 | C:/ProgramData/FinanceSkillEval/releases/1d50d37 | /opt/finance-skill-eval/releases/1d50d37 |
| 私有配置 | C:/ProgramData/FinanceSkillEval/config | /etc/finance-skill-eval |
| 业务数据 | C:/ProgramData/FinanceSkillEval/data | /var/lib/finance-skill-eval/data |
| 日志 | C:/ProgramData/FinanceSkillEval/logs | journalctl -u finance-eval-api -u finance-eval-runtime |
| 备份 | C:/ProgramData/FinanceSkillEval/backups | /opt/finance-skill-eval/backups |

发布目录名称沿用基础提交 1d50d37，本轮已补入服务测试发现的修复；DEPLOYED_REVISION 文件记录最终源码提交。Windows 从归档源码按冻结锁构建，当前宿主 pnpm 为 11.25.0（标准 prepare 入口仍要求 10.34.4）；WSL 复用已验证 Docker 制品的 Linux 构建和依赖文件，补齐源码，在最终路径重建 venv 元信息并执行 uv locked sync。不能把这次制品复用声明为原生 Linux prepare 脚本的从零构建测试。

OpenJiuwen 为锁定的 0.1.17.post1。Windows 使用官方 WinSW 2.12.0 x64 下载制品，记录 SHA256 为 05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA；这是本机制品指纹，不代表另行完成了签名或供应链审计。

访问令牌在各自 config/production.env 的 FINANCE_EVAL_ACCESS_TOKEN 中，不写入报告或 URL。仅绑定 loopback，未发布公网、未部署 TLS 网关。

## 实际验证

- Windows SCM：实际账户与 Automatic 配置、API/Runtime 子进程异常退出后的自动恢复、两服务停止完成、端口释放、状态文件清理、离线备份恢复、重启后的数据持久化，共 11 个检查点通过。
- WSL systemd：实际账户与 enabled、分别 SIGKILL 两个主 supervisor 后自动恢复、配置可读/代码不可写/数据可写、停机清理、备份恢复通过。
- 两平台均在业务验收后备份真实任务和候选，恢复到独立目录，逐文件 SHA256 比较一致。重启后再次读取已验收候选并下载交付包成功。备份不包含空目录，比较文件内容时忽略空目录差异。
- 日志：7 份实际服务日志未出现配置中的访问令牌/模型密钥及 query/header canary；没有默认 SDK 文件日志目录。轮转配置存在，但未通过写满阈值验证实际轮转。
- 类型检查、生产构建通过；最终全量回归 139 文件、1082 passed、2 skipped。代理/模型适配器 16 项通过；部署配置/硬链接 6 项通过；Windows XML、实际 ACL 和 WSL 硬链接测试通过。

## 真实业务验收

两轮均直接连接已安装服务，报告标识 deployment=EXISTING_SERVICE，未启动替代 API/Worker。使用真实迁移 Agent 和 Runtime 的 deepseek-v4-flash、真实 Judge glm-5.3。共同工作区包含 budget-query、purchase-review、audit-report 三个 Skill，联合检查实际脚本调用、全部成员激活、Runtime 身份、冻结候选摘要及下载结果。

| 环境 | UTC 时间 | 结果 | 本地报告 |
| --- | --- | --- | --- |
| WSL | 08:41:19–08:48:25 | 9 检查通过；开发 2/2、留出 1/1 | reports/bundle-live-f3376269-4680-4cb5-b9ea-0edf796d9fed/result.json |
| Windows | 08:54:03–09:05:14 | 9 检查通过；开发 2/2、留出 1/1 | reports/bundle-live-c2454e67-b342-4222-9eb8-a6adab290ee5/result.json |

两轮首次候选均通过，因此本轮未实际触发整体修复。其他证据：reports/windows-scm-deployment.json、reports/windows-scm-smoke.log、reports/wsl-systemd-deployment.log、reports/native-final-state.json、reports/native-log-audit.json。完整报告和模型证据受 Git 忽略，不提交到仓库。

## 发现并修复的问题

1. WinSW 2.x 不识别原来的 username 账户字段，实际会使用 LocalSystem。现改为 domain/user，安装后读取 SCM 验证或校正账户，启动前再次拒绝错误身份；两套 Windows 服务已重新注册并用 LocalService 完成真实业务。
2. pnpm 硬链接让文件 ACL 与开发缓存共享，依赖目录链接也会使递归权限操作重复遍历。现使用复制安装依赖、应用 ACL 前解除已有硬链接、拒绝越界链接，并逐个遍历实体目录、单独重置链接权限。真实共享缓存隔离测试通过。
3. WinSW stop 命令可在 StopPending 阶段返回，后续备份存在竞争。现明确等待 SCM Stopped，实际停机与备份流程通过。
4. WSL 交互终端自动带代理，systemd 环境没有，初次分析连接模型卡住。该尝试已取消并保留失败证据；服务 env 显式配置代理并排除 loopback。Node Judge 的独立连接池原先绕过代理，现支持 HTTP_PROXY/HTTPS_PROXY/NO_PROXY，真实服务联合验收重跑通过。

## 运行与停止

Windows 管理员 PowerShell：

```powershell
$release = 'C:/ProgramData/FinanceSkillEval/releases/1d50d37'
& "$release/deploy/windows/manage.ps1" -Action health
& "$release/deploy/windows/manage.ps1" -Action stop
& "$release/deploy/windows/manage.ps1" -Action start
```

WSL：

```powershell
wsl -d Ubuntu -u root -- systemctl status finance-eval-api finance-eval-runtime --no-pager
wsl -d Ubuntu -u root -- systemctl stop finance-eval-api finance-eval-runtime
wsl -d Ubuntu -u root -- systemctl start finance-eval-runtime finance-eval-api
```

本次测试使用一个最长 4 小时的 WSL 保活会话；未修改全局 WSL 配置或创建开机计划任务。后续需要持续访问 WSL 页面时，保持一个 `wsl -d Ubuntu -- sleep infinity` 会话；systemd enabled 不代表 Windows 开机自动拉起 WSL。未主动重启 Windows 或关闭其他 WSL 服务。此限制来自 [Microsoft WSL systemd 说明](https://learn.microsoft.com/en-us/windows/wsl/systemd)。

目标生产机器仍需验收 OS 重启、自启、TLS、正式凭据与出口、告警、容量、备份保留和加密。恢复目录尚未启动为独立业务实例。操作方法见 [生产部署](production-deployment.md)。
