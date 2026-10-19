# Windows 服务部署

需要 Windows Server、管理员 PowerShell 5.1+、系统级 Node >=22、pnpm 10.34.4、Python 3.11–3.13、uv 0.12.13。Node/Python 位于 LocalService 可读取的系统目录，不能依赖管理员个人目录、映射盘或交互 profile。

从 [WinSW 2.12.0 官方发布](https://github.com/winsw/winsw/releases/tag/v2.12.0) 获取 x64 可执行文件，按企业制品流程校验并记录 SHA256；安装器不静默下载第三方程序。

## 安装与启动

在最终 release 目录 checkout 审核过的版本，用管理员 PowerShell 执行：

```powershell
Set-Location C:/ProgramData/FinanceSkillEval/releases/VERSION
./deploy/windows/prepare.ps1 -Python 'C:/Program Files/Python312/python.exe'
./deploy/windows/manage.ps1 -Action install -Release $PWD.Path -Node 'C:/Program Files/nodejs/node.exe' -WinSW 'C:/Installers/WinSW-x64.exe'
# 填写 C:/ProgramData/FinanceSkillEval/config/production.env 和 runtime.json
./deploy/windows/manage.ps1 -Action preflight
./deploy/windows/manage.ps1 -Action start
./deploy/windows/manage.ps1 -Action health
./deploy/windows/manage.ps1 -Action status
./deploy/windows/manage.ps1 -Action logs
icacls C:/ProgramData/FinanceSkillEval/config
```

安装生成两个 WinSW XML 并注册服务，创建 config/data/cache/logs/backups。默认 LocalService，ACL 限制为 Administrators、SYSTEM、LocalService：服务对 data/cache/logs 可写，对代码和配置只读。**Base 必须是应用专用目录**，安装会重置其子目录 ACL，不可指向共享目录。

模板替换为 Windows 数据/配置路径，Python 默认从当前 release 的 venv 解析；配置路径用正斜杠。preflight 在操作者身份运行，不能替代 LocalService 权限验收，须实际服务启动并执行任务。LocalService 与其他同账户服务共享身份，需要更强隔离时由运维改专用账户并重新验收 ACL。

-Action configure 只生成审查模板，不安装服务、不改 ACL，供构建测试；可在相同 Base/release 上继续 install。重复 install 要求已有服务停止且路径属于本次安装，不覆盖其他安装。自定义 Base 后每次操作均传相同 -Base。venv 在最终目录构建，不移动到其他版本目录。

## HTTPS、日志与恢复

默认两个端口都绑定 loopback。使用企业 IIS/ARR 等网关终止 TLS，只代理 API 56361，配置流式响应和长请求超时；防火墙不放行 Runtime。网关不记录 Authorization、查询密钥和请求体，独立设置权限与保留期。

WinSW stdout/stderr 按 20 MiB、10 文件滚动，目录 Base/logs；异常退出两次重启后停止重试。详见 [WinSW 日志配置](https://github.com/winsw/winsw/blob/v2.12.0/doc/loggingAndErrorReporting.md)。目标 Windows Server 仍需验收自启、重启恢复、服务身份、TLS 和真实业务任务。

```powershell
./deploy/windows/manage.ps1 -Action stop
./deploy/windows/manage.ps1 -Action backup -Archive C:/ProgramData/FinanceSkillEval/backups/BEFORE.zip
./deploy/windows/manage.ps1 -Action restore -Archive C:/ProgramData/FinanceSkillEval/backups/BEFORE.zip -Destination C:/ProgramData/FinanceSkillEval/restore-NEW
# 新版本最终目录先执行 prepare.ps1
./deploy/windows/manage.ps1 -Action upgrade -Release C:/ProgramData/FinanceSkillEval/releases/NEW
./deploy/windows/manage.ps1 -Action rollback -Release C:/ProgramData/FinanceSkillEval/releases/OLD
```

切换先预检、停机、备份，再更新 WinSW 启动路径；失败恢复旧配置并保持停机，判断数据兼容性。恢复只写新目录，真正替换 data/config 后重新检查 ACL，再启动。

WinSW 调用共享 stop：API 用 Node IPC，Runtime 用 stdin 通知 uvicorn，50 秒后强制回收进程树，WinSW 75 秒为外层期限。配置使用 startarguments/stoparguments，遵循 [WinSW XML 约束](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md)。
