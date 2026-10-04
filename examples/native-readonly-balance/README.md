# 账户余额核验样例

这是方法源码，不是银行接口实现。只支持已准入 `account_balance_query` 和 `read_case_file` 的受管环境。

修改 `SKILL.md` 的步骤或输出要求后，以新版本上传；不要更改工具合同来绕过准入。
方法 1.0.4 补充用户指定 JSON 格式时的输出约定，不改变账户工具、金额、案例或评分门槛。
1.0.3 的真实模型复验曾返回代码围栏和额外解释；旧失败记录保留，新版本必须重新执行验证。
在项目根目录执行：

```sh
pnpm build:core
node scripts/install-native-sample.mjs /path/to/private-eval-state
```

安装命令校验固定摘要并通过已有 SkillStore 导入，不覆盖其他资产或运行记录。
这是管理员部署命令，不会启动 Agent，也不会调用模型或银行。

打开评测页选择“账户余额核验”，执行方式选择“双 Runtime”，分别绑定 OpenJiuwen Java 和 AgentScope Java。
选择服务端已配置的同一模型与参数，运行案例并核对答案、工具、安装 Lock 和逐题回收记录。

也可将 `SKILL.md` 单独打入 ZIP，从“Skill 迁移”上传，诊断后选择“复用已准入工具”。
逐项核对两端合同后生成候选，再进入 Skill 资产准备案例并评测。未准入工具不能靠上传方法接通。
