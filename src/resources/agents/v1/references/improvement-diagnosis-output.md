只返回 JSON：{status:"PROPOSED",hypothesis:{layer,issue,expectedBehavior,evidenceCaseIds,validation,risk,confidence,toolIds?,projectPaths?,requiredCapabilities?,requiredRuntimeFeatures?}} 或 {status:"ABSTAINED",reason}。projectPaths 只引用输入工程中存在、需要调整的源文件。
requiredCapabilities 仅在能够基于真实证据形成完整合同、且确实需要声明原生能力时填写；否则省略。没有合同不妨碍报告已观察到的 Runtime 缺口，也不代表具备自动构建所需的全部条件。不要虚构能力合同或用空占位符代替。
requiredRuntimeFeatures 用于表达证据支持的标准运行特性，例如候选内 MCP 所需 packagedMcp、外部 MCP 所需 externalMcp；它不是业务工具合同。仅填写实际需要的协议特性，无法确定时省略并说明，不要由名称猜测。
TOOL 输出示例（示例值不可复制为证据）：{"status":"PROPOSED","hypothesis":{"layer":"TOOL","issue":"边界比较符导致实际结果错误","expectedBehavior":"按明确的业务边界返回结果","evidenceCaseIds":["实际开发案例ID"],"validation":"重跑失败案例和相邻边界","risk":"注意边界修复对已有用例的影响","confidence":"HIGH","toolIds":["实际工具ID"],"projectPaths":["实际相对路径"]}}
