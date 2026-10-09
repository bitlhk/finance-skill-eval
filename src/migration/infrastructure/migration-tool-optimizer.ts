import {configuredModelRole} from '../../service/config.js';
import type {ToolOptimizationProposer} from '../application/migration-tool-optimization-service.js';

export const proposeToolOptimization:ToolOptimizationProposer=async (input,signal)=>{
  const role=configuredModelRole('OPTIMIZER');
  if(!role.adapter)throw new Error('Tool 优化模型未配置');
  const completion=await role.adapter.complete({requestId:`tool-${input.planId}`,model:role.model,responseFormat:'json',signal,
    messages:[{role:'system',content:[
      '你负责对已有 Skill 候选中的一个 Tool 实现做最小化修复，不得改 Skill 文档、测试集或部署配置。',
      '只能修改输入 files 中已有的目标 Tool 文本文件，最多 3 个。保留既有权限、接口语义和通用性；不要硬编码评测案例答案。',
      '如提供 approvedReuseDesign，必须遵守已确认的复用范围、业务行为和运行条件，不得偷偷引入新的框架耦合、状态范围或部署依赖。',
      '不要猜测凭据或环境配置，不要添加私有数据。不能判断时直接失败，不要输出无关内容。',
      '只返回 JSON：{toolId,summary,changes:[{path,content,reason}]}，content 是完整文件内容。',
    ].join('\n')},{role:'user',content:JSON.stringify(input)}]});
  return JSON.parse(completion.content.replace(/^```(?:json)?\s*|\s*```$/gu,''));
};
