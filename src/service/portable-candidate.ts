import { strToU8 } from 'fflate';
import type { SkillAssetRecord } from './skill-store.js';
import type { ProjectInspection,ToolDecision } from './migration-model.js';
import type { GeneratedToolImplementation } from './migration-code-generator.js';
import { normalizeSkillPackage } from './skill-normalizer.js';

export type PortableGeneration={toolId:string;toolName:string;form:ToolDecision['form'];files:string[];entrypoint?:string;readyForValidation:boolean;todo:string[];generatedBy?:string;explanation?:string;attempts?:number;checks?:GeneratedToolImplementation['checks']};
export type PortableDiff={path:string;operation:'ADD'|'MODIFY';before:string;after:string};

const javaClass=(name:string)=>name.split(/[^a-zA-Z0-9]+/u).filter(Boolean).map(p=>p[0]!.toUpperCase()+p.slice(1)).join('')+'Tool';
const pythonName=(name:string)=>name.toLowerCase().replace(/[^a-z0-9_]+/gu,'_').replace(/^_+|_+$/gu,'')||'tool';
const javaString=(value:string)=>JSON.stringify(value).replaceAll('\\/','/');
const mavenArtifact=(value:string)=>value.toLowerCase().replace(/[^a-z0-9._-]+/gu,'-').replace(/^-+|-+$/gu,'')||'migrated-skill';

const MCP_JAVA_SDK_VERSION='1.1.4';
const JETTY_VERSION='12.0.28';

function mcpPom(skillId:string){return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.finance.migration</groupId>
  <artifactId>${mavenArtifact(skillId)}-mcp-service</artifactId>
  <version>0.1.0</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <mcp.java.sdk.version>${MCP_JAVA_SDK_VERSION}</mcp.java.sdk.version>
    <jetty.version>${JETTY_VERSION}</jetty.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>io.modelcontextprotocol.sdk</groupId>
      <artifactId>mcp</artifactId>
      <version>\${mcp.java.sdk.version}</version>
    </dependency>
    <dependency>
      <groupId>org.eclipse.jetty.ee10</groupId>
      <artifactId>jetty-ee10-servlet</artifactId>
      <version>\${jetty.version}</version>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>2.19.2</version>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-simple</artifactId>
      <version>2.0.17</version>
      <scope>runtime</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-shade-plugin</artifactId>
        <version>3.6.1</version>
        <executions>
          <execution>
            <phase>package</phase>
            <goals><goal>shade</goal></goals>
            <configuration>
              <createDependencyReducedPom>false</createDependencyReducedPom>
              <transformers>
                <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                  <mainClass>com.finance.migration.MigrationMcpServer</mainClass>
                </transformer>
              </transformers>
            </configuration>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
`;}

function mcpServer(classNames:string[]){return `package com.finance.migration;

import com.fasterxml.jackson.databind.ObjectMapper;
${classNames.map(name=>`import com.finance.migration.tools.${name};`).join('\n')}
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.HttpServletStreamableServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.ServerCapabilities;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;

/** Executable MCP 2025-06-18 Streamable HTTP service generated from the Skill. */
public final class MigrationMcpServer {
  private MigrationMcpServer() {}

  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    var transport = HttpServletStreamableServerTransportProvider.builder()
        .mcpEndpoint("/mcp")
        .build();
    ObjectMapper mapper = new ObjectMapper();
    McpSyncServer mcpServer = McpServer.sync(transport)
        .serverInfo("finance-skill-migration", "0.1.0")
        .capabilities(ServerCapabilities.builder().tools(false).build())
        .tools(${classNames.map(name=>`${name}.specification(mapper)`).join(', ')})
        .build();

    Server httpServer = new Server(port);
    ServletContextHandler context = new ServletContextHandler();
    context.setContextPath("/");
    context.addServlet(new ServletHolder(transport), "/mcp");
    httpServer.setHandler(context);
    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      mcpServer.close();
      try { httpServer.stop(); } catch (Exception ignored) { }
    }));
    httpServer.start();
    System.out.println("MCP Streamable HTTP endpoint listening on http://0.0.0.0:" + port + "/mcp");
    httpServer.join();
  }
}
`;}

function mcpTool(className:string,businessClass:string,name:string,inputSchema:unknown){
  const schema=JSON.stringify(inputSchema&&typeof inputSchema==='object'?inputSchema:{type:'object',additionalProperties:true});
  return `package com.finance.migration.tools;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.JsonSchema;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import com.finance.migration.business.${businessClass};
import java.util.List;
import java.util.Map;

/** MCP adapter executing the migrated ${name} business implementation. */
public final class ${className} {
  public static final String TOOL_NAME = ${javaString(name)};
  private static final String INPUT_SCHEMA = ${javaString(schema)};
  private ${className}() {}

  public static SyncToolSpecification specification(ObjectMapper mapper) {
    try {
      Map<String, Object> schema = mapper.readValue(INPUT_SCHEMA, new TypeReference<>() {});
      return SyncToolSpecification.builder()
          .tool(Tool.builder().name(TOOL_NAME).description("Migrated Skill tool: " + TOOL_NAME)
              .inputSchema(new JsonSchema(
                  String.valueOf(schema.getOrDefault("type", "object")),
                  objectMap(schema.get("properties")),
                  stringList(schema.get("required")),
                  schema.get("additionalProperties") instanceof Boolean allowed ? allowed : null,
                  objectMap(schema.get("$defs")),
                  objectMap(schema.get("definitions"))))
              .build())
          .callHandler((exchange, request) -> execute(mapper, request.arguments()))
          .build();
    } catch (Exception error) {
      throw new IllegalStateException("Invalid generated input schema for " + TOOL_NAME, error);
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> objectMap(Object value) {
    return value instanceof Map<?, ?> ? (Map<String, Object>) value : Map.of();
  }

  private static List<String> stringList(Object value) {
    return value instanceof List<?> values ? values.stream().map(String::valueOf).toList() : List.of();
  }

  static CallToolResult execute(ObjectMapper mapper, Map<String, Object> arguments) {
    try {
      Object output = ${businessClass}.execute(arguments);
      return CallToolResult.builder().content(List.of(new TextContent(mapper.writeValueAsString(output)))).build();
    } catch (Exception error) {
      return error("TOOL_EXECUTION_FAILED: " + error.getMessage());
    }
  }

  private static CallToolResult error(String message) {
    return CallToolResult.builder().isError(true).content(List.of(new TextContent(message))).build();
  }
}
`;}

const skillRelative=(name:string,skillFile:string)=>{
  const root=skillFile.includes('/')?skillFile.slice(0,skillFile.lastIndexOf('/')):'';
  if(!root)return name;
  return name.startsWith(`${root}/`)?name.slice(root.length+1):null;
};
const withPep723=(source:string,dependencies:string[]=[])=>/^#\s*\/\/\/\s*script\s*$/mu.test(source)?source:`# /// script\n# requires-python = ">=3.11"\n# dependencies = [${dependencies.map(value=>JSON.stringify(value)).join(', ')}]\n# ///\n\n${source}`;
function executablePython(tool:ProjectInspection['tools'][number],archive:Record<string,Uint8Array>,implementations:Record<string,GeneratedToolImplementation>){
  if(implementations[tool.toolId]?.language==='python')return implementations[tool.toolId];
  if(tool.portability==='PORTABLE_SCRIPT'&&tool.entrypoint?.kind==='PYTHON'&&tool.entrypoint.path){
    return {sourcePath:tool.entrypoint.path,source:Buffer.from(archive[tool.entrypoint.path]!).toString('utf8')};
  }
  return null;
}
function executableJava(tool:ProjectInspection['tools'][number],implementations:Record<string,GeneratedToolImplementation>){
  const implementation=implementations[tool.toolId];
  return implementation?.language==='java'&&implementation.entryClass?implementation:null;
}

export function generatePortableCandidate(input:{archive:Record<string,Uint8Array>;base:SkillAssetRecord;inspection:ProjectInspection;decisions:ToolDecision[];version:string;implementations?:Record<string,GeneratedToolImplementation>}){
  const implementations=input.implementations??{};
  const files:Record<string,Uint8Array>={},generations:PortableGeneration[]=[];
  const mcpDecisions=input.decisions.filter(decision=>decision.form==='MCP');
  const hasMcp=mcpDecisions.length>0,mcpRoot='mcp',packagePath='com/finance/migration';
  // A Tool being migrated is replaced, not carried alongside. Shipping the
  // runtime-coupled original next to its replacement would defeat the migration.
  const migratedSources=new Set(input.decisions.flatMap(decision=>
    input.inspection.tools.find(tool=>tool.toolId===decision.toolId)?.sourcePaths??[]));
  const sourceArchive=Object.fromEntries(Object.entries(input.archive).filter(([name])=>!migratedSources.has(name)));
  const normalizedSkill=normalizeSkillPackage(sourceArchive,input.base.skillFile,input.base.skillId,input.version);
  for(const [name,bytes] of Object.entries(normalizedSkill.files))files[hasMcp?`skill/${name}`:name]=bytes;
  const skillTarget=hasMcp?'skill/SKILL.md':'SKILL.md';
  if(!files[skillTarget])throw Object.assign(new Error('标准迁移输入缺少 skill/SKILL.md'),{statusCode:409});
  const sharedMcpFiles:string[]=[];
  if(mcpDecisions.length){
    const selectedTools=mcpDecisions.map(decision=>input.inspection.tools.find(tool=>tool.toolId===decision.toolId)).filter((tool):tool is ProjectInspection['tools'][number]=>!!tool);
    const unsupported=selectedTools.find(tool=>!executableJava(tool,implementations));
    if(unsupported)throw Object.assign(new Error(`无法自动迁移 ${unsupported.name}：MCP 必须由迁移模型生成通过编译的完整 Java 业务实现；不会生成 Python 桥接或占位代码`),{statusCode:409});
    const names=selectedTools.map(tool=>tool.name),classNames=selectedTools.map(tool=>javaClass(tool.name));
    const generated=[
      {name:`${mcpRoot}/pom.xml`,content:mcpPom(input.base.skillId)},
      {name:`${mcpRoot}/src/main/java/${packagePath}/MigrationMcpServer.java`,content:mcpServer(classNames)},
      {name:`${mcpRoot}/Dockerfile`,content:'FROM eclipse-temurin:17-jre\nWORKDIR /app\nCOPY target/*-mcp-service-0.1.0.jar app.jar\nENV PORT=8080\nEXPOSE 8080\nENTRYPOINT ["java","-jar","/app/app.jar"]\n'},
      {name:`${mcpRoot}/README.md`,content:`# ${input.base.skillId} MCP service\n\nPure Java 17 MCP service using the official Java SDK ${MCP_JAVA_SDK_VERSION} and MCP protocol 2025-06-18. Tool business implementations are Java source code compiled into the service; no Python or subprocess bridge is used.\n\nBuild: \`mvn clean package\`\n\nRun: \`PORT=8080 java -jar target/*-mcp-service-0.1.0.jar\`\n\nEndpoint: \`http://localhost:8080/mcp\`\n\nGenerated tools: ${names.join(', ')}.\n`},
    ];
    for(const item of generated){files[item.name]=strToU8(item.content);sharedMcpFiles.push(item.name);}
  }
  for(const decision of input.decisions){
    const tool=input.inspection.tools.find(t=>t.toolId===decision.toolId);if(!tool)throw new Error(`Unknown Tool decision: ${decision.toolId}`);
    if(decision.form==='MCP'){
      const implementation=executableJava(tool,implementations)!,className=javaClass(tool.name);
      const implementationFiles=[{path:implementation.sourcePath,content:implementation.source},...implementation.additionalFiles];
      const generated=[
        {name:`${mcpRoot}/src/main/java/${packagePath}/tools/${className}.java`,content:mcpTool(className,implementation.entryClass!,tool.name,tool.inputSchema)},
        ...implementationFiles.map(file=>({name:`${mcpRoot}/src/main/java/${packagePath}/business/${file.path}`,content:file.content})),
      ];
      for(const item of generated)files[item.name]=strToU8(item.content);
      generations.push({toolId:tool.toolId,toolName:tool.name,form:decision.form,files:[...sharedMcpFiles,...generated.map(f=>f.name)],entrypoint:`${mcpRoot}/src/main/java/${packagePath}/business/${implementation.sourcePath}`,readyForValidation:true,todo:[],generatedBy:implementation.generatedBy,explanation:implementation.explanation,attempts:implementation.attempts,checks:implementation.checks});
    }else{
      const implementation=executablePython(tool,input.archive,implementations);
      if(!implementation)
        throw Object.assign(new Error(`无法自动迁移 ${tool.name}：没有可独立执行的 Python 业务实现；不会生成占位代码`),{statusCode:409});
      const module=pythonName(tool.name),extra='additionalFiles' in implementation?implementation.additionalFiles:[],dependencies='dependencies' in implementation?implementation.dependencies:[];
      const implementationFiles=[{path:implementation.sourcePath,content:implementation.source},...extra],multi=implementationFiles.length>1;
      const base=`${hasMcp?'skill/':''}scripts/`,target=multi?`${base}${module}/${implementation.sourcePath}`:`${base}${module}.py`;
      const generated:{name:string;content:string}[]=implementationFiles.map((file,index)=>({name:multi?`${base}${module}/${file.path}`:target,content:index===0?withPep723(file.content,dependencies):file.content}));
      const lock=input.archive[`${implementation.sourcePath}.lock`];if(lock)files[`${target}.lock`]=lock;
      for(const item of generated)files[item.name]=strToU8(item.content);
      generations.push({toolId:tool.toolId,toolName:tool.name,form:decision.form,files:[...generated.map(f=>f.name),...(lock?[`${target}.lock`]:[])],entrypoint:target,readyForValidation:true,todo:[],...('generatedBy' in implementation?{generatedBy:implementation.generatedBy,explanation:implementation.explanation,attempts:implementation.attempts,checks:implementation.checks}:{})});
    }
  }
  const diff:PortableDiff[]=Object.entries(files).flatMap(([name,bytes])=>{
    const before=input.archive[name]??input.archive[`skill/${name}`];
    if(before&&Buffer.compare(Buffer.from(before),Buffer.from(bytes))===0)return [];
    return [{path:name,operation:before?'MODIFY':'ADD',before:before?Buffer.from(before).toString('utf8'):'',after:Buffer.from(bytes).toString('utf8')} as PortableDiff];
  });
  return {files,generations,diff};
}
