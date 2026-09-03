# 转账风险审核真实 A/B 评测

验证日期：2026-09-03

## 控制变量

左右 Candidate 使用相同的 GLM-5.2、OpenJiuwen Runtime、Capability Pack、账户 Provider 和反诈 Provider Fixture。左侧不安装 Domain Skill，右侧安装 `transfer-risk-review@0.1.0`。

三类固定任务分别覆盖已知涉诈命中、未命中已知风险、风险服务不可用。六次回答均在线生成，随后由匿名模型 Judge 比较。

## 结果

```text
右侧胜：3
左侧胜：0
平局：0
Judge 错误：0
报告指纹：b55c9c78eb6d6896f1c9c50d9d4a9d4e75c46218b9943571526490620966cd80
```

有 Domain Skill 的一侧稳定提升了三项业务能力：

- 区分账户事实、反诈系统结果和模型推断；
- 不把“未命中”或“无返回”误判为绝对安全；
- 清楚表达暂缓、复核、重试和最终决策责任。

完整本地报告位于 `reports/risk-review/live`。该目录是运行产物，不纳入源码版本；本记录只固化可复核的结果摘要和报告指纹。
