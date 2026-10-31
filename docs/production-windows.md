# Windows 后台服务：直接运行 Git 项目

手动启动和 Windows 服务使用同一份项目代码、项目根目录的 `.env.local`。不复制发布代码，不创建 `production.env`、`current.txt` 或 `releases` 目录。Git commit/tag 管理版本；`dist` 和 `web-dist` 是在项目内构建的产物。

## 配置与安装

在固定的 Git 项目目录安装 Node >=22、pnpm（版本见 package.json）、Python 3.11–3.13 和 uv。系统服务必须能读取这些工具及项目依赖，不能依赖交互终端的 PATH。

```powershell
# 在项目根目录；已有配置不要覆盖
Copy-Item .env.local.example .env.local
Copy-Item .runtime.local.example.json .runtime.local.json
# 填写 .env.local 的访问令牌、模型配置，以及 .runtime.local.json
powershell -NoProfile -File deploy/windows/prepare.ps1 -Python C:/Path/To/python.exe
# 管理员终端；WinSW 使用已验证的 2.12.0 x64 可执行文件
powershell -NoProfile -File deploy/windows/manage.ps1 -Action install -WinSW C:/Tools/WinSW-x64.exe
powershell -NoProfile -File deploy/windows/manage.ps1 -Action preflight
powershell -NoProfile -File deploy/windows/manage.ps1 -Action start
```

安装生成的 WinSW 配置直接指向当前项目的 `deploy/run.mjs` 和 `.env.local`。默认 Base 为 `C:/ProgramData/FinanceSkillEval`，只存放服务包装程序、日志、缓存和备份，不复制代码或另建运行配置。可用 `-Base` 更改，后续管理命令须使用相同 Base。`-ProjectDirectory` 可显式指定项目；省略时使用脚本所属项目，和当前终端目录无关。`configure` 仅生成配置用于审查/测试，不注册服务或修改权限。

账户为 `NT AUTHORITY/LocalService`，保留开机启动、失败重启和优雅停止。安装先解除项目依赖与包缓存的硬链接，再添加项目读取权限、数据/日志/缓存修改权限，保护两个配置文件；不会重置整个项目的所有权或显式子项权限。安装器只向项目父目录本身添加读取/遍历权限，不向同级项目传播。外部 Python 基础安装及外部依赖也必须允许 LocalService 访问。先预检，再验证实际服务健康；管理员身份预检不等于服务账户验证。

`.env.local` 的 `FINANCE_EVAL_DATA_DIR` 决定数据位置。迁移已有安装时填写原数据目录的绝对路径，保留原 Runtime 配置、访问令牌和其他必要设置；不要因为切换代码目录就切换数据目录。`FINANCE_RUNTIME_CONFIG` 默认是项目 `.runtime.local.json`，可显式指向现有文件。Runtime 模型配置仍是独立用途，不等于平台的模型角色配置。

## 更新、回滚与管理

```powershell
powershell -NoProfile -File deploy/windows/manage.ps1 -Action stop
powershell -NoProfile -File deploy/windows/manage.ps1 -Action backup -Archive C:/Backups/before-update.zip
# 先保存本地改动，再 git checkout <已确认的 commit/tag> 或 git pull --ff-only
powershell -NoProfile -File deploy/windows/prepare.ps1 -Python C:/Path/To/python.exe
powershell -NoProfile -File deploy/windows/manage.ps1 -Action preflight
powershell -NoProfile -File deploy/windows/manage.ps1 -Action start
```

回滚使用相同流程，Git 切回目标提交后重新安装匹配依赖并构建。脚本不再提供切换发布目录的 `upgrade/rollback`。不要在服务运行时切换 Git 版本或重建依赖。仅修改配置时用 `-Action restart`；修改源码后先重新构建。`status`、`health`、`logs` 查看运行情况。

离线备份从 `.env.local` 解析实际数据位置，只归档业务数据、`.env.local` 和 Runtime 配置，不备份整个 Git 项目。`restore -Archive C:/Backups/before-update.zip -Destination C:/Restore/New` 校验后恢复到新空目录；停机后将 `data/` 恢复到配置的数据目录，将 `config/` 中的文件恢复到对应配置路径。切换 Git 版本不自动回滚业务数据。

## 从旧的 releases 安装迁移

先停旧服务并备份原配置和数据，再把原数据绝对路径及所需配置写入项目 `.env.local`。将旧 Runtime 配置保存到项目 `.runtime.local.json`，在项目内完成构建和预检。保持原 Base，重新执行 `install`（服务须已停止），然后 `start`、`health`。已有业务数据不移动。旧发布目录和配置只作为迁移前留档，不再被服务读取或维护；确认无其他依赖后可另行清理。
