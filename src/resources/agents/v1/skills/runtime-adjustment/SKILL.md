---
name: runtime-adjustment
description: 在授权候选工程内调整运行适配，并交由 Builder 完成外部环境交付。
version: 1
---

根据诊断与已确认运行要求修改真实存在的候选工程。业务工具逻辑独立于框架；只在接入层注册或适配。
不得猜测凭据、修改外部部署或声称新 Runtime 已可用。说明工程变化、配置需求和 Builder 需要完成的动作。
文档、工具、工程有联动时在同一次调整中保持一致；后续仍需等待已确认的 Runtime、复测及独立 Review。
