# 迁移后 Skill 的自然语言目标评估

第一版使用用户提供的任务输入和自然语言验收要求，执行迁移后完整 Skill，再由平台 JUDGE 角色模型逐项判断。不提供人工打分，不接入原服务，不生成复杂维度分数。

测试集格式为 `{name, cases:[{id,input,criteria}]}`，1–8 条用例，id 不重复，每条至少一条非空要求。前端提供样例下载、JSON 文件选择及编辑、导入预览。样例文件为 reports/migration-test-suite.sample.json，其中数值属于受控测试数据，需根据实际环境修改。

API：GET /api/migration-suite-example 下载样例；POST /api/migrations/:id/suites/import 导入。导入转换为现有冻结题集，assessmentMode=natural_language；评估继续使用现有 validate/openjiuwen、异步运行队列和报告轮询，candidate_assessment 每条用例实际执行一次，不做原版对照。

凭证和上下文复用项目测试 Runtime 配置，业务输入不携带验收要求。用户无需指定工具；平台通过 availableToolNames 加载候选工具，requiredTools 保持为空，不强制每条用例调用所有工具。Python Runtime 区分可用工具和用例必调工具。

ModelGoalJudge 输入任务、要求和实际回答，返回逐项 verdict、reason、evidence。平台校验要求索引完整且不重复，证据必须是实际回答的逐字片段；异常重试一次，仍失败作为评估错误保留。任一要求 FAIL 则整体 FAIL，否则任一 INDETERMINATE 则整体 INDETERMINATE，全部满足才 PASS。原执行失败单独展示，不混为业务目标不满足。

自然语言判定不证明后台没有进行操作，缺少外部事实依据时允许无法判定。无法判定不能导致候选自动验收通过；完整候选身份和 Runtime 执行证据仍是验收前提。旧四维评分评估保持兼容，自然语言目标评估不用其维度分数或正则规则推断。

验证覆盖导入 API、输入格式、模型判定、伪造引用和漏判防护、无法判定与执行失败区分、工具加载与单次候选执行、前端静态渲染，以及既有 Judge/Runner/迁移回归。自动回归使用受控替身；真实模型验收记录见下文。

结果：28 项 TypeScript 回归测试通过（reports/migration-goal-assessment-tests.json），4 项 Python Session 边界检查通过，前后端 TypeScript 检查和 Vite 生产构建通过。

## 真实模型验收

记录目录：reports/migration-goals-live-2026-09-17T11-47-35.401Z。通过真实导入 API 和 validate/openjiuwen 启动四条用例，OpenJiuwen 0.1.17.post1 使用配置中的 deepseek-v4-flash 执行模型，独立评估模型同样调用真实 deepseek-v4-flash。候选为已保存的真实 A4 FastMCP 交付包；本轮没有重新生成候选。业务后端是受控本地接口，余额固定 1000 CNY，校验 Authorization 与租户 Header；不代表生产企业 Provider 已验证。

四条实际执行均完成且候选摘要一致。余额用例实际调用 balance MCP；组合用例实际调用 balance 和 command，返回余额 1000 CNY、服务费 2.50 CNY。单独服务费用例只读取资料并要求提供账户 ID，没有执行脚本，暴露迁移后 SKILL.md 将余额查询设为前置步骤与独立计算目标的冲突。负例实际输出服务费 2.50 元，被“必须为99元”的错误目标判失败。

首次完整任务的余额与组合评估引用未逐字匹配，严格校验拒收，job.json 保留原始错误。修复重试提示后，在相同真实回答上再次调用真实评估模型（未改回答、目标或候选），real-model-reassessment.json 四条均获得有效判断：余额 PASS、单独服务费 FAIL、组合 PASS、负例 FAIL。本轮不能宣称全部业务验收通过，也未将复核结果覆盖原运行记录。

本轮修复：标准文本交付包不再被错误要求包含旧 neutral-contract.json；Windows 执行子进程明确使用 UTF-8；未产生身份验证证据的进程失败保留原始 Runtime 错误；评估重试告知无效引用及原样复制要求，保持逐字证据校验。修复后的核心 TypeScript 编译和 Runtime 四项边界检查通过，针对评估与 HTTP 的回归记录见控制台。
