# Docker Compose 部署

需要 Linux Docker Engine、Compose >=2.30（env_file.format: raw）和依赖下载网络。使用 deploy/docker/compose.yaml，非根目录旧版示例。

## 安装

```sh
sudo install -d -m 0700 /etc/finance-skill-eval-docker
sudo install -m 0600 deploy/examples/production.env /etc/finance-skill-eval-docker/production.env
sudo install -m 0600 .runtime.local.example.json /etc/finance-skill-eval-docker/runtime.json
sudoedit /etc/finance-skill-eval-docker/production.env
sudoedit /etc/finance-skill-eval-docker/runtime.json
sudo chown 1000:1000 /etc/finance-skill-eval-docker/runtime.json
# 后续命令需 Docker 权限及配置目录读取权限
export FINANCE_EVAL_IMAGE=finance-skill-eval:YOUR_RELEASE
export FINANCE_EVAL_CONFIG_DIR=/etc/finance-skill-eval-docker
bash deploy/docker/manage.sh build
bash deploy/docker/manage.sh preflight
bash deploy/docker/manage.sh start
bash deploy/docker/manage.sh health
bash deploy/docker/manage.sh status
```

production.env 按 raw 读取：值不加外层引号，$ 和 # 保留为原值。Compose 覆盖容器内路径和固定端口 56361/56362；FINANCE_EVAL_PUBLISH_PORT 仅改变宿主 API 端口，仍绑定 loopback。Runtime 不发布端口，UI 中填 http://runtime:56362。外部流量走宿主 HTTPS 网关。

API 与 Runtime 共用包含 Node/Python 锁定依赖的完整镜像，各自运行。构建成功后推到私有仓库，用唯一版本 tag/digest 发布并保留旧镜像；不要用浮动 latest 作为回滚记录。默认镜像不包含 Java/Maven 等业务工具链，相关任务需派生镜像再验收。

## 数据、日志、运维

api-data 是业务任务/候选/证据/进程状态，必须备份；runtime-data 是 worker 状态，临时会话不保证重启保留；两个 cache 卷可重建。runtime.json 从宿主只读挂载，生产配置不写入镜像。

`bash deploy/docker/manage.sh logs` 查看日志；每容器 json-file 轮转上限 20 MiB × 10。镜像层、业务卷、代理日志仍须监控。restart 策略处理进程退出，不会自动重启“仍存活但 unhealthy”的容器，健康失败需外部告警。

```sh
bash deploy/docker/manage.sh stop
install -d -m 0700 /srv/finance-backups
bash deploy/docker/manage.sh backup /srv/finance-backups/BEFORE.zip
bash deploy/docker/manage.sh restore /srv/finance-backups/BEFORE.zip /srv/finance-restore-NEW
# 目标镜像提前构建/拉取，保留旧 tag
bash deploy/docker/manage.sh upgrade finance-skill-eval:NEW /srv/finance-backups/PRE-UPGRADE.zip
export FINANCE_EVAL_IMAGE=finance-skill-eval:NEW
bash deploy/docker/manage.sh health
bash deploy/docker/manage.sh rollback finance-skill-eval:OLD /srv/finance-backups/PRE-ROLLBACK.zip
```

备份要求两个服务停止，包含当前项目 API 卷和宿主配置。恢复只写新目录；实际恢复需停机后复制 data/ 到该项目 API 卷，设置 UID/GID 1000 及私有权限，再更新宿主配置。首次上线前在隔离项目演练恢复；禁止 down -v。

升级失败保持停机和数据，运维选择旧镜像并判断是否恢复快照。成功后持久化 FINANCE_EVAL_IMAGE。不要随意改变 Compose 项目名，否则会创建新卷；测试使用独立 COMPOSE_PROJECT_NAME 和宿主端口，不能复用生产卷。
