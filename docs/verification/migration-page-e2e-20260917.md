# Skill 迁移页面端到端验证（2026-09-17）

结论：本次自定义 Runtime Harness 案例通过页面端到端验证，共 9 项检查通过。没有修改产品业务源码；新增可重复执行的浏览器测试脚本。

## 执行范围

使用本机安装的 Edge 无头浏览器和真实平台 HTTP 服务。上传、诊断确认、候选生成、测试集导入、原服务映射与请求头配置、执行两种评估、刷新恢复、下载均由 Playwright 操作真实页面。测试 Runtime 的注册及受控测试工作区、原服务启动属于验收基础设施准备。

第一轮调用真实 deepseek-v4-flash 完成 A2 和 A4；记录在 `reports/migration-page-e2e-2026-09-17T15-09-56-345Z/`。该轮因测试脚本的下拉框精确定位错误中止，测试集实际导入成功。修正脚本定位后，复测复用该轮真实 A2/A4 结果，校验源 ZIP 文件内容完全相同，不使用人工模拟分析或迁移结果。Runtime 执行及评估模型每次实际重跑。

最终成功记录：`reports/migration-page-e2e-2026-09-17T15-15-39-318Z/`。

## 通过的检查

1. 从页面上传原工程，诊断将 read_document 识别为 Runtime Harness 能力，不阻塞迁移。
2. 页面生成候选；真实 A4 交付保留原名工具的插件。
3. 两种评估方式先选后展示配置；无效请求 JSON 在页面提示，未发起运行。
4. 页面导入测试集，配置嵌套请求模板、响应字段 /data/result 和请求头环境变量。
5. 原服务真实 HTTP 执行原 Python 实现，候选由锁定 OpenJiuwen 0.1.17.post1 的 DeepAgent 实际运行；正例 PASS，错误目标 FAIL。
6. 原服务凭证正确传递；验收要求没有发送给原服务。候选实际调用 read_document 并加载当前候选 SHA256；原服务不冒充已验证的 Runtime 身份。
7. 刷新页面并继续项目后，原服务地址、请求模板和结果恢复。
8. 从页面切换为目标评估并实际执行；正例 PASS，错误目标 FAIL。
9. 导出文件名标记 unverified，下载 ZIP 包含 runtime-plugins 下的真实 manifest；没有浏览器脚本错误。

脚本结果按 9 个检查分组输出，上述列表按业务核验内容展开。正反例验收结论分别保存在 job.json 与 goal-job.json；baseline-audit.json 保存原服务受控鉴权调用检查。截图 01–06 和 browser-trace.zip 保存页面证据。

## 复现

先编译当前核心和前端，再运行：

```powershell
node scripts/verify-migration-page-e2e.mjs
```

可提供旧的真实 Agent 记录用于重跑页面及 Runtime，避免重复生成；必须保持源码 ZIP 一致：

```powershell
node scripts/verify-migration-page-e2e.mjs reports/harness-migration-live-2026-09-17T13-21-02-986Z reports/migration-page-e2e-2026-09-17T15-09-56-345Z
```

## 本次未覆盖

生产企业鉴权 SDK、令牌刷新、多租户隔离；缺失依赖补充及 AI 测试集生成；业务 MCP/Script 的页面逐个试运行；优化复测与候选变化失效场景。本次案例专门验证自定义 Harness 插件，不代表上述其他场景已验收。
