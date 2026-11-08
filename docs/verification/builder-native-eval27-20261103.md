# Builder 原生交付与平台准入验证

日期：2026 年 11 月 3 日。验证使用隔离的临时运行目录和无副作用的合成 Skill；未修改企业示例工程或现有 49778 服务。

Builder 仓库现有的 `engineering/build_runtime.py` 根据 v3 Runtime 能力需求构建并启动独立 OpenJiuwen Launcher。Builder 自带的模型和生命周期验证完成，交付结果为 `SUCCEEDED`。目标使用本项目 `.venv-openjiuwen`，SDK 版本为 `0.1.17.post1`。

平台使用独立的 `EnvironmentStore` 验证构建结果、信任引用和 Launcher 完整生命周期，准入结果为 `PASSED`。随后使用平台现有 `createBundleRuntime` 在该 Launcher 中加载合成 Skill，真实模型运行完成，Runtime 身份和流完成标记有效，输出包含预期标记 `READY`。实例已释放，隔离 Launcher 已停止。

本次验证覆盖 Builder 原生构建命令、平台交付准入和一个真实 Runtime 基础运行；没有经过 Builder 异步 HTTP 构建接口、平台页面或 Agent 的 `build_runtime` 工具，不能将其视为完整端到端联调。异步接口的跨仓 HTTP 协议另用受控后端验证，不能证明真实 Runtime 构建。Runtime 重建仍为已记录的遗留项。

## Agent 首次新建链路补充验证

同日运行隔离任务测试 `runs the real coordinator and Builder CLI delivery against a live Runtime`，结果通过：真实模型驱动 OpenJiuwen 协调 Agent 调用 `build_runtime`；平台为修改后的 Skill 候选生成首次构建需求；Builder 原生命令构建 Launcher；平台独立准入并启动检查；真实 Runtime 对只读合成任务返回 `READY`，随后进入 Review。验证结束后，隔离 Launcher 和临时 HTTP 适配器均已停止。

该测试使用临时适配器将异步构建调用转发到 Builder 原生命令；迁移调整、诊断和 Review 使用受控替身，原始基线 Runtime 也为测试替身。它证明上述边界之间的真实连接，不证明 Builder 生产异步接口、真实迁移 Agent 或真实业务数据上的完整端到端效果。

同日再次运行该链路并设置 `FINANCE_TEST_REAL_ROLES=1`，真实 OpenJiuwen 协调 Agent、真实诊断 Agent 与独立 Review Agent 均参与，测试通过；Builder 原生命令构建的真实 Runtime 完成合成就绪案例复测。测试中的原基线 Runtime、代码调整 Agent 与案例判据仍为受控替身，异步 HTTP 仍由隔离测试适配器转发到 Builder 命令，不能视为生产异步接口或真实业务验收。隔离 Runtime 和适配器已停止。

另一轮设置 `FINANCE_TEST_REAL_ADJUST=1`，真实迁移调整 Agent 在冻结候选上修改 Skill，随后由真实协调 Agent 调用 Builder 原生命令，平台准入并在真实 Runtime 完成合成任务复测。该轮诊断、效果 Review、原基线 Runtime 和案例判据使用受控替身；Builder 异步 HTTP 仍是测试适配器。两轮分别验证真实角色，不能合并声称它们在同一次运行中全部真实执行。隔离 Runtime 和适配器已停止。

## 实际接口与基础验证的边界

当前 Builder 的 `eval_launcher_http.py` 异步交付接口依托已配置的受控 Launcher；通用的 `engineering/build_runtime.py` 是独立命令，并未由该接口直接提供。因此，临时适配器的结果不能证明生产异步接口具备按需构建通用 Runtime 的能力。要完成真实跨服务验收，需要具备实际支持该构建模式的 Builder 服务，或由 Builder 后续提供对应入口；本轮按约定不修改 Builder。

Agent 发起的新建交付会记录针对实际候选和交付的启动检查，包括环境核对、启动与释放。这个记录只证明相应实例可启动和释放，不代表原有业务能力或工具契约全部通过。原能力覆盖仍以真实案例的运行和判据为依据；缺少案例的要求保持未验证，效果 Review 也不能替代基础验证。
