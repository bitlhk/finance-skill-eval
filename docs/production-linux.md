# Linux 后台服务：直接运行 Git 项目

systemd 和手动启动使用同一个 Git 项目目录、项目根目录的 `.env.local`。不复制代码到 releases，不创建 current 链接或 `/etc/finance-skill-eval/production.env`。Git commit/tag 管理版本。

## 安装与启动

安装系统级 Node >=22、pnpm（版本见 package.json）、Python 3.11–3.13 和 uv。选择固定项目目录，例如 `/opt/finance-skill-eval`；当前安装器要求项目和 Node 路径不含空格或特殊字符。

```sh
git clone YOUR_REPOSITORY /opt/finance-skill-eval
cd /opt/finance-skill-eval
git checkout YOUR_REVIEWED_COMMIT
# 已有配置不要覆盖
cp .env.local.example .env.local
cp .runtime.local.example.json .runtime.local.json
# 填写令牌、模型和数据目录
FINANCE_OPENJIUWEN_PYTHON=/usr/bin/python3.12 bash deploy/prepare.sh
sudo bash deploy/linux/manage.sh install
sudo bash deploy/linux/manage.sh start
sudo bash deploy/linux/manage.sh health
```

安装创建 `finance-eval` 系统账户，systemd 单元直接指向脚本所属项目，不受终端当前目录影响。安装器不会递归更改项目所有权；服务账户须能遍历父目录、读取代码和依赖、执行 Node/Python。私有 checkout 可以通过 ACL 向 `finance-eval` 授予必要的读取/遍历权限；不要通过全员可读来公开密钥。安装器将 `.env.local` 和 Runtime 配置设为服务组可读（0640），并在写入单元前以服务账户执行预检。权限检查失败时，修复指出路径的权限后重试。

`FINANCE_EVAL_DATA_DIR` 指定业务数据目录，建议使用绝对路径。已有部署必须保留原值，例如 `/var/lib/finance-skill-eval/data`。安装只初始化缺失的数据目录；已有目录的权限由操作者确认，不会迁移或覆盖数据。`FINANCE_RUNTIME_CONFIG` 默认读取项目 `.runtime.local.json`，也可指向现有配置。systemd 保留开机自启、失败重启、日志和优雅停止。

## 更新、回滚和备份

```sh
sudo bash deploy/linux/manage.sh stop
sudo bash deploy/linux/manage.sh backup /absolute/backups/before-update.zip
# 保存本地改动，再 git checkout <commit/tag> 或 git pull --ff-only
FINANCE_OPENJIUWEN_PYTHON=/usr/bin/python3.12 bash deploy/prepare.sh
sudo bash deploy/linux/manage.sh preflight
sudo bash deploy/linux/manage.sh start
```

回滚同样使用 Git 切换提交、重新安装匹配依赖并构建。取消发布目录 `upgrade/rollback` 命令。不要在运行时切换 Git 版本或重建依赖。仅改配置用 `restart`；`status`、`logs`、`health` 查看状态。systemd 模板改变后，停机并重新执行 `install` 更新单元。

离线备份解析项目 `.env.local` 中的实际数据路径，只保存数据和实际配置文件。`restore /absolute/backup.zip /absolute/new-empty-directory` 验证后恢复到新空目录；停机后把 `data/` 和 `config/` 中的文件分别恢复到实际数据目录和配置路径。Git 回滚不会自动回滚数据。

从旧部署迁移时先用旧入口停机并备份，把旧数据路径、访问令牌及其他必要设置写入项目 `.env.local`，把 Runtime 配置保存到项目 `.runtime.local.json`，随后构建、安装、启动并检查健康。旧目录仅保留作迁移前留档，服务不再引用。

反向代理、TLS 和日志保留按实际主机配置，示例见 `deploy/examples/nginx.conf.example` 和 `deploy/linux/journald.conf.example`。仅开放所需入口，56361/56362 默认绑定本机。WSL 测试应保持该发行版运行；无需修改或关闭其他 WSL 服务。
