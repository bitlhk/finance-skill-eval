import {posix} from 'node:path';
import {z} from 'zod';
import type {ProjectInspection} from './migration-model.js';

const relativePath=z.string().min(1).refine(value=>!value.includes('\\')&&!value.startsWith('/')&&!/^[a-zA-Z]:/u.test(value)&&value.split('/').every(part=>part!=='.'&&part!=='..'&&part!==''),'插件路径必须是安全的包内相对路径');
const pluginSchema=z.object({
  status:z.literal('PRODUCED'),toolNames:z.array(z.string().min(1)).min(1),
  manifestPath:relativePath,files:z.array(relativePath).min(1),
  implementationFiles:z.array(relativePath).min(1),adapterFiles:z.array(relativePath).min(1),
  dependencies:z.array(z.string().min(1)).default([]),
  compilePassed:z.literal(true),contractPassed:z.literal(true),
  callExecuted:z.boolean().default(false),runtimeDependenciesPending:z.array(z.string()).default([]),
});
export type HarnessPluginDeclaration=z.infer<typeof pluginSchema>;
export type GeneratedHarnessPlugin=HarnessPluginDeclaration & {contents:Record<string,string>};

/** A4 adapts the original contract, never maps names to host-specific builtins. */
export function harnessDeliveryContract(inspection:ProjectInspection){
  return {strategy:'PRESERVE_CONTRACT_ADAPT_PLUGIN',runtime:'openjiuwen',runtimeVersion:'0.1.17.post1',
    implementationRoot:'runtime-plugins',preserve:['toolName','inputSchema','outputSchema','behavior','errors'],
    builtinMapping:false,requirements:inspection.runtimeCapabilities??[],
    pluginApi:{import:'from openjiuwen.core.foundation.tool import Tool, ToolCard',constructor:'def __init__(self): super().__init__(ToolCard(id="<unique-id>", name="<original-tool-name>", description="...", input_params=<original-schema>))',
      invoke:'async def invoke(self, inputs: dict, **kwargs): return original_function(**inputs)',
      stream:'async def stream(self, inputs: dict, **kwargs): yield await self.invoke(inputs, **kwargs)',
      businessInput:'inputs is the original business argument object; do not read kwargs.arguments.',session:'kwargs.session is supplied by Runtime, separate from inputs.'},
    note:'原实现与 Runtime 包装层分开交付；不修改 Skill 的工具名；不将 Harness 生成为业务 MCP 或 Skill 脚本。资产摘要由平台打包后绑定。'};
}

export function toGeneratedHarnessPlugins(payload:Record<string,unknown>,files:Record<string,string>,inspection:ProjectInspection):GeneratedHarnessPlugin[]{
  const plugins=z.array(pluginSchema).parse(payload.harnessPlugins??[]);
  const expected=(inspection.runtimeCapabilities??[]).map(capability=>capability.name);
  const actual=plugins.flatMap(plugin=>plugin.toolNames);
  if(new Set(actual).size!==actual.length||actual.length!==expected.length||actual.some(name=>!expected.includes(name)))
    throw new Error('A4 Harness 工具名称与诊断不一致，不允许改名或替换为内置能力');
  return plugins.map(plugin=>{
    const root=posix.dirname(plugin.manifestPath);
    if(!root.startsWith('runtime-plugins/')||posix.basename(plugin.manifestPath)!=='manifest.json')throw new Error('Harness 插件必须独立交付在 runtime-plugins/<插件>/manifest.json');
    if(new Set(plugin.files).size!==plugin.files.length||!plugin.files.includes(plugin.manifestPath)
      ||plugin.files.some(path=>!path.startsWith(root+'/'))
      ||[...plugin.implementationFiles,...plugin.adapterFiles].some(path=>!plugin.files.includes(path))
      ||plugin.implementationFiles.some(path=>plugin.adapterFiles.includes(path)))throw new Error('Harness 原实现、包装层及声明文件不完整或未分开');
    const contents=Object.fromEntries(plugin.files.map(path=>{
      if(typeof files[path]!=='string')throw new Error(`A4 缺少 Harness 插件文件：${path}`);
      return [path,new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(files[path]!,'base64'))];
    }));
    const manifest=JSON.parse(contents[plugin.manifestPath]!);
    if(manifest.packageType!=='plugin'||!manifest.id||manifest.mcps?.length||manifest.skills?.length||manifest.rails?.length)
      throw new Error('Harness 清单只能声明本次适配的工具，不得附加未授权能力');
    if(!Array.isArray(manifest.tools)||manifest.tools.length!==plugin.toolNames.length)throw new Error('Harness 清单工具数量不符');
    for(const tool of manifest.tools){
      if(typeof tool.file!=='string'||typeof (tool.class??tool.class_name)!=='string')throw new Error('Harness 清单缺少 file/class');
      relativePath.parse(tool.file);
      const entry=posix.join(root,tool.file);
      if(!plugin.adapterFiles.includes(entry))throw new Error('Harness 清单入口必须指向独立 Runtime 包装层');
    }
    if(plugin.dependencies.length&&!plugin.files.some(path=>/(?:requirements\.txt|pyproject\.toml|package\.json)$/u.test(path)))throw new Error('Harness 插件缺少依赖清单');
    return {...plugin,contents};
  });
}
