# Linux 直接部署（systemd）

安装系统级 Node >=22、pnpm 10.34.4、Python 3.11–3.13、uv 0.12.13 和 Git。Node/Python 必须位于服务账户可读的系统路径，不依赖 root 的 nvm、profile 或个人目录 Python；prepare 禁止自动下载用户目录 Python。

固定目录：/opt/finance-skill-eval/releases/VERSION、/opt/finance-skill-eval/current、/etc/finance-skill-eval、/var/lib/finance-skill-eval/data。每个版本在最终目录构建，不能搬移 venv。

## 安装与启动

```sh
sudo mkdir -p /opt/finance-skill-eval/releases
sudo git clone YOUR_REPOSITORY /opt/finance-skill-eval/releases/VERSION
cd /opt/finance-skill-eval/releases/VERSION
sudo git checkout YOUR_REVIEWED_COMMIT
sudo env FINANCE_OPENJIUWEN_PYTHON=/usr/bin/python3.12 bash deploy/prepare.sh
sudo bash deploy/linux/manage.sh install "$PWD"
sudoedit /etc/finance-skill-eval/production.env
sudoedit /etc/finance-skill-eval/runtime.json
sudo bash deploy/linux/manage.sh preflight
sudo bash deploy/linux/manage.sh start
sudo bash deploy/linux/manage.sh health
sudo bash deploy/linux/manage.sh status
sudo bash deploy/linux/manage.sh logs
```

安装创建 finance-eval 系统账户，release 为 root 所有、服务组可读，配置 root:finance-eval 0640，安装并 enable 两个服务，但不自动启动。填写配置再预检；预检以服务身份运行。确认服务所用解释器的所有父目录可遍历。

WSL 本机测试可使用相同 systemd 服务，但必须保持 WSL 实例运行；systemd 服务本身不会阻止 WSL 空闲退出。测试期间可以保留 `wsl -d Ubuntu -- sleep infinity` 会话，结束时终止该会话。`systemctl enable` 表示发行版启动时拉起服务，不等同于 Windows 开机时自动启动该发行版。不要为了本项目测试随意 `wsl --shutdown`，它会影响同一 WSL 环境中的其他服务。参见 [Microsoft WSL systemd 说明](https://learn.microsoft.com/en-us/windows/wsl/systemd)。

按 deploy/examples/nginx.conf.example 配置真实域名和证书，nginx -t 后 reload；关闭代理缓冲，设置长请求超时，只开放 443，56361/56362 保留本机访问。上传大小与产品策略一同确认。

## 日志和停机

```sh
sudo journalctl -u finance-eval-api -u finance-eval-runtime -f
sudo bash deploy/linux/manage.sh stop
```

deploy/linux/journald.conf.example 为主机级策略示例（2 GiB 总量、1 GiB 保留空闲、14 天），会影响其他服务，不自动覆盖。审查后放到 journald.conf.d 并重启 journald，验证持久化；另设 Nginx 轮转和磁盘告警。参考 [systemd 执行环境](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)、[journal 保留配置](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)。

停止依次关闭 API、Runtime。应用 45 秒、supervisor 50 秒、systemd 75 秒为分层停机期限，最终 systemd 清理整个 cgroup。force_stop/shutdown_timeout 需排查未结束任务；重启会标记中断任务，不承诺从模型中间状态自动续跑。

## 备份、恢复、升级、回滚

```sh
sudo bash deploy/linux/manage.sh stop
sudo install -d -m 0700 /opt/finance-skill-eval/backups
sudo bash deploy/linux/manage.sh backup /opt/finance-skill-eval/backups/BEFORE.zip
sudo bash deploy/linux/manage.sh restore /opt/finance-skill-eval/backups/BEFORE.zip /var/lib/finance-skill-eval/restore-NEW
# 新版本在新的最终目录完成 prepare 后再切换
sudo bash deploy/linux/manage.sh upgrade /opt/finance-skill-eval/releases/NEW
sudo bash deploy/linux/manage.sh rollback /opt/finance-skill-eval/releases/OLD
```

切换顺序为目标预检、停机、自动备份、原子切换 current、健康检查。失败恢复旧链接并保持停机，等运维判断数据兼容性。恢复目录包含 data/、config/；停机检查后替换对应目录，恢复 data 的 finance-eval 所有权和 config 的 root:finance-eval 0640，再启动验收。

现场需验证开机自启、异常退出恢复、服务账户权限、HTTPS、真实业务任务及恢复演练。语法/systemd 单元校验不等于在目标发行版部署成功。
