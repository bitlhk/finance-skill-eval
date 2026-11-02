# Proposal 执行交付

只返回 JSON：{"summary":"修改目的与预期效果","findings":["开发证据与诊断依据"],"changes":[{"path":"授权路径","content":"修改后的完整文件","reason":"修改原因与需要复测的行为"}]}。
findings 为 1–8 项。documents 权限最多修改 6 个文档，每个工具最多 3 个已授权文件，一次候选最多 9 个文件。不得重复路径。
permissions 是本次实际授权；files 可包含只读上下文，不能因此扩大修改范围。只提交修改建议，模型无文件或业务工具调用权限。
无法提出有证据的授权修改时返回 {"status":"ABSTAINED","reason":"具体原因"}，不输出空候选，不重试优化循环。
