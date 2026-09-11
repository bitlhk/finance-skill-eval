# 本地在线评测与 Skill 候选改进

## 已采用的形态

```text
浏览器 56361
  -> Finance Skill Eval（Node / Promptfoo / Codex Judge & Optimizer）
  -> OpenJiuwen Python Worker 56362
       -> 每侧独立 ReAct 子进程
       -> 按 case.requiredTools 连接 MCP
       -> 只读财富模拟快照 56363 或显式配置的外部 MCP
  -> 流式答案、工具证据、四维评分图
  -> 文档候选、同条件复测、留出题、人工选择
```

独立于 EA 和手机银行部署。Python Worker 属于 Integration，不把 OpenJiuwen 依赖放进评测 Core。Codex 只负责 Judge/Optimizer，不取代做题 Runtime。

## 首次安装

要求 Node 22、pnpm、Python 3.11–3.13、已登录且可用的 Codex CLI；模型网关需支持 OpenAI-compatible 工具调用。

```bash
pnpm install --frozen-lockfile
pnpm build
python3 -m venv .venv-openjiuwen
.venv-openjiuwen/bin/pip install -r integrations/openjiuwen/requirements.txt
node scripts/bootstrap-local.mjs /path/to/model.env /path/to/wealth-skill
```

`model.env` 提供 `API_BASE / API_KEY / MODEL_NAME`。脚本只读导入模型配置和 Skill Markdown 文档，不改动源项目。它生成被 Git 忽略的 `.env.local / .runtime.local.json`（0600），把包内文档导入 `data/skills`，登记运行环境，并生成财富在线 Eval Pack。原作者信息保留，导入不等于重新发布。

已有本机导入来源为财富 Skill `2.1.5`。固定模拟快照只用于可重复的金融业务测试，不代表真实客户或银行制度。任何人拿到本仓库，不应把模拟参数直接用于生产推荐。

## 启动

分别在独立终端运行：

```bash
.venv-openjiuwen/bin/python integrations/openjiuwen/reference_mcp.py
.venv-openjiuwen/bin/uvicorn integrations.openjiuwen.worker:app --host 127.0.0.1 --port 56362
node --env-file=.env.local dist/service/server.js
```

默认控制台 `http://127.0.0.1:56361`。服务只绑定回环地址；外部访问使用现有 SSH 隧道。不要将使用个人 Codex 登录及本机模型凭据的 Demo 未经鉴权直接暴露到公网。

本机已由用户 systemd 服务托管：

```bash
systemctl --user status finance-skill-eval-demo finance-eval-openjiuwen finance-eval-reference-mcp
systemctl --user restart finance-skill-eval-demo
journalctl --user -u finance-skill-eval-demo -n 50 --no-pager
curl http://127.0.0.1:56362/health
```

`activeSessions` 是当前执行子进程数量；任务结束或取消后应回到 0。这些用户 transient units 适合当前 Demo，会话外继续运行，但机器重启后需按启动命令或安装持久 service unit 恢复。

## 现场演示

1. 精选技能 -> 财富经理助手 -> 进入评测。默认在线 OpenJiuwen、左侧无 Skill、右侧 2.1.5、GLM-5.2。
2. 开始测试。访前及配置两道题分别调用当前允许的只读 MCP，查看两侧实际文本和工具状态。
3. GPT-6 盲评结束，查看四维图、逐题理由、真实耗时和 Token。不同版本不保证胜出。
4. 点击“生成候选并复测”。查看实际阶段、文档变更和候选版本摘要；原版与候选重新执行，同批加入未提供给 Optimizer 的冻结留出题。
5. 查看复测报告，再人工决定是否保留候选。选择不会修改原 Skill，也不会发布到 EA。

候选及评测记录保存在服务端，换浏览器仍可从原始运行记录进入；可以重新复测同一个候选，旧复测不删除。阶段动画来自实际后台状态，不使用计时器模拟完成。参考资料按需由模型读取，证据记录 `referenceFilesRead` 及文件摘要；未被读取的修改会在界面提示，不能据此声称修改有效。

历史“回放”包仍保留，明确区别于在线包；历史失败记录也保留，不通过清除失败记录美化结果。

## 外部 MCP

控制台“测试环境”登记 MCP 地址和凭据环境变量名，再在 Runtime 中关联。Worker 的 `.runtime.local.json` 登记相同端点及明确允许的 `toolNames`，认证值通过该本机私有配置提供。初版故意不支持任意上传脚本、任意 Shell 或未经确认的写操作；这些需求需要接入具备对应隔离和确认能力的外部 Runtime。

```json
{
  "models": { "your-model": { "baseUrl": "https://gateway.example/v1", "apiKey": "<server-side-secret>" } },
  "mcp": {
    "https://mcp.example/mcp": {
      "headers": { "Authorization": "Bearer <server-side-secret>" },
      "toolNames": ["get_customer_profile"],
      "dataMode": "authorized-bank-test-data"
    }
  }
}
```

这是可替换的 Provider 环境，不要求银行改用 Twenty，也不要求部署 EA。网络、身份、客户授权与具体银行事实需由实际接入方提供，不能由 Skill 文本补造。

## 验证

```bash
pnpm check
pnpm test
pnpm build
.venv-openjiuwen/bin/python -m unittest integrations.openjiuwen.test_reference_mcp
```

覆盖 SSE 分块、答案泄漏隔离、基线装配校验、MCP 生命周期、候选路径与身份约束、冻结留出集、取消和旧回放兼容。真实模型可用性、浏览器渲染及子进程回收仍需在线验证，不能用单元测试替代。
