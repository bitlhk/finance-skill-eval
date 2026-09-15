import { strToU8 } from 'fflate';
import type { SkillAssetRecord } from './skill-store.js';
import { recommendLanguage,type ProjectInspection,type ToolDecision } from './migration-model.js';
import type { GeneratedToolImplementation } from './migration-code-generator.js';
import { normalizeSkillPackage } from './skill-normalizer.js';

export type PortableGeneration={toolId:string;toolName:string;form:ToolDecision['form'];files:string[];entrypoint?:string;readyForValidation:boolean;todo:string[];generatedBy?:string;explanation?:string;attempts?:number;checks?:GeneratedToolImplementation['checks']};
export type PortableDiff={path:string;operation:'ADD'|'MODIFY';before:string;after:string};

const javaBase=(name:string)=>name.split(/[^a-zA-Z0-9]+/u).filter(Boolean).map(p=>p[0]!.toUpperCase()+p.slice(1)).join('');
const javaClass=(name:string)=>javaBase(name)+'Tool';
// These three become identifiers in generated code, so each is forced to start with a
// letter: a Tool named "2fa_check" must not produce a module Python cannot import.
const identifier=(value:string,fallback:string)=>`${/^[a-zA-Z]/u.test(value)?'':fallback}${value}`;
const pythonName=(name:string)=>identifier(name.toLowerCase().replace(/[^a-z0-9_]+/gu,'_').replace(/^_+|_+$/gu,'')||'tool','tool_');
const nodeName=(name:string)=>identifier(name.toLowerCase().replace(/[^a-z0-9]+/gu,'-').replace(/^-+|-+$/gu,'')||'tool','tool-');
const nodeIdentifier=(name:string)=>identifier(name.replace(/[^a-zA-Z0-9]+(.)/gu,(_,next:string)=>next.toUpperCase()).replace(/[^a-zA-Z0-9]/gu,'')||'tool','tool');
const javaString=(value:string)=>JSON.stringify(value).replaceAll('\\/','/');
const mavenArtifact=(value:string)=>value.toLowerCase().replace(/[^a-z0-9._-]+/gu,'-').replace(/^-+|-+$/gu,'')||'migrated-skill';

const MCP_JAVA_SDK_VERSION='1.1.4';
const JETTY_VERSION='12.0.28';
// The generated service declares its own environment (PEP 723 / package.json), so these are
// the service's choice -- deliberately NOT whatever the platform's own agent venv happens to
// resolve. `uv run --no-project` builds the isolated environment from the declaration.
const MCP_PYTHON_SDK_VERSION='2.2.0';
const UVICORN_VERSION='0.53.0';
const MCP_NODE_SDK_VERSION='1.30.0';

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

const MCP_SERVICE_DEPENDENCIES=['mcp=='+MCP_PYTHON_SDK_VERSION,'uvicorn=='+UVICORN_VERSION];

/** `name@range` -> {name: range}, honouring the scoped-package rule (`@scope/pkg@1`). */
function npmDependencies(specifiers:string[]):Record<string,string>{
  return Object.fromEntries(specifiers.map(specifier=>{
    const at=specifier.startsWith('@')?specifier.indexOf('@',1):specifier.indexOf('@');
    return at<0?[specifier,'*']:[specifier.slice(0,at),specifier.slice(at+1)];
  }));
}

/** Python: the official SDK's low-level server, because only it can advertise a given Schema. */
function pyProject(skillId:string,dependencies:string[]){return `[project]
name = "${mavenArtifact(skillId)}-mcp-service"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [${dependencies.map(value=>JSON.stringify(value)).join(', ')}]
`;}

function pyServer(tools:Array<{module:string;name:string}>,dependencies:string[]){
  const prefix=(module:string)=>module.toUpperCase();
  const imports=tools.map(tool=>`from tools.${tool.module} import DESCRIPTION as ${prefix(tool.module)}_DESCRIPTION, INPUT_SCHEMA as ${prefix(tool.module)}_SCHEMA, NAME as ${prefix(tool.module)}_NAME, execute as ${prefix(tool.module)}_EXECUTE`).join('\n');
  const handlers=tools.map(tool=>`    ${prefix(tool.module)}_NAME: (${prefix(tool.module)}_DESCRIPTION, ${prefix(tool.module)}_SCHEMA, ${prefix(tool.module)}_EXECUTE),`).join('\n');
  // The PEP 723 block and pyproject.toml are emitted from the same list, so the local run
  // (`uv run --no-project server.py`) and the container install cannot disagree.
  return `# /// script
# requires-python = ">=3.11"
# dependencies = [${dependencies.map(value=>JSON.stringify(value)).join(', ')}]
# ///
"""Executable MCP 2025-06-18 Streamable HTTP service generated from the Skill."""
import json
import os

from mcp.server.lowlevel import Server
from mcp.types import CallToolRequestParams, CallToolResult, ListToolsResult, TextContent, Tool

${imports}

_HANDLERS = {
${handlers}
}


async def _list_tools(_context, _params) -> ListToolsResult:
    return ListToolsResult(tools=[
        Tool(name=name, description=description, inputSchema=schema)
        for name, (description, schema, _) in sorted(_HANDLERS.items())
    ])


async def _call_tool(_context, params: CallToolRequestParams) -> CallToolResult:
    entry = _HANDLERS.get(params.name)
    if entry is None:
        return CallToolResult(isError=True, content=[TextContent(type="text", text="TOOL_NOT_FOUND: " + str(params.name))])
    try:
        output = entry[2](dict(params.arguments or {}))
    except Exception as error:
        return CallToolResult(isError=True, content=[TextContent(type="text", text="TOOL_EXECUTION_FAILED: " + str(error))])
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(output, ensure_ascii=False))])


server = Server(name="finance-skill-migration", version="0.1.0", on_list_tools=_list_tools, on_call_tool=_call_tool)


def main() -> None:
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    print("MCP Streamable HTTP endpoint listening on http://0.0.0.0:%d/mcp" % port, flush=True)
    uvicorn.run(server.streamable_http_app(streamable_http_path="/mcp", host="0.0.0.0"), host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
`;}

function pyAdapter(tool:{name:string;inputSchema:unknown},module:string){
  const schema=JSON.stringify(tool.inputSchema&&typeof tool.inputSchema==='object'?tool.inputSchema:{type:'object',additionalProperties:true});
  return `"""MCP adapter executing the migrated ${tool.name} business implementation."""
import json

from business.${module} import execute as _execute

NAME = ${javaString(tool.name)}
DESCRIPTION = "Migrated Skill tool: " + NAME
INPUT_SCHEMA = json.loads(${javaString(schema)})


def execute(arguments: dict) -> object:
    return _execute(arguments)
`;
}

function nodeServer(tools:Array<{module:string;name:string}>){
  // The file is kebab-case; the binding it is imported under has to be a JS identifier.
  const imports=tools.map(tool=>`import * as ${nodeIdentifier(tool.module)} from "./tools/${tool.module}.js";`).join('\n');
  const entries=tools.map(tool=>`  [${nodeIdentifier(tool.module)}.NAME]: ${nodeIdentifier(tool.module)},`).join('\n');
  return `// Executable MCP 2025-06-18 Streamable HTTP service generated from the Skill.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

${imports}

const TOOLS = {
${entries}
};

const server = new Server(
  { name: "finance-skill-migration", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.values(TOOLS).map(tool => ({ name: tool.NAME, description: tool.DESCRIPTION, inputSchema: tool.INPUT_SCHEMA })),
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = TOOLS[request.params.name];
  if (!tool) return { isError: true, content: [{ type: "text", text: \`TOOL_NOT_FOUND: \${request.params.name}\` }] };
  try {
    const output = await tool.execute(request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: \`TOOL_EXECUTION_FAILED: \${error?.message ?? error}\` }] };
  }
});

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await server.connect(transport);

const httpServer = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path !== "/mcp") { response.writeHead(404).end(); return; }
  let raw = "";
  request.on("data", chunk => { raw += chunk; });
  request.on("end", () => {
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { response.writeHead(400).end(); return; }
    transport.handleRequest(request, response, body).catch(() => { try { response.writeHead(500).end(); } catch { /* already sent */ } });
  });
});

const port = Number(process.env.PORT ?? 8080);
httpServer.listen(port, "0.0.0.0", () => console.log(\`MCP Streamable HTTP endpoint listening on http://0.0.0.0:\${port}/mcp\`));
`;}

function nodeAdapter(tool:{name:string;inputSchema:unknown},specifier:string){
  const schema=JSON.stringify(tool.inputSchema&&typeof tool.inputSchema==='object'?tool.inputSchema:{type:'object',additionalProperties:true});
  return `// MCP adapter executing the migrated ${tool.name} business implementation.
import { execute as run } from "../business/${specifier}";

export const NAME = ${javaString(tool.name)};
export const DESCRIPTION = "Migrated Skill tool: " + NAME;
export const INPUT_SCHEMA = ${schema};

export async function execute(arguments_) {
  return run(arguments_);
}
`;}

type McpTool={name:string;inputSchema:unknown};
/** Where the migrated business implementation must live, and what the generated adapter imports.
 * Both are dictated by the platform: the adapter is generated before the code exists, and the
 * contract test starts the assembled service. A Tool that puts its code elsewhere is not
 * wired up, so this is a requirement rather than a suggestion. */
type BusinessSite={path:string;symbol:string};
type Scaffold={
  /** Shared service files, written once per language group. `dependencies` is that group's
   * union of business dependencies; the service declares them alongside its own SDK. */
  service(skillId:string,root:string,tools:McpTool[],dependencies:string[]):Array<{name:string;content:string}>;
  business(root:string,tool:McpTool):BusinessSite;
  adapter(root:string,tool:McpTool,business:BusinessSite):{name:string;content:string};
  /** The file the contract test starts. */
  serviceEntry(root:string):string;
};

const SERVICE_ROOT=/^mcp-(?:java|python|node)\//u;
const JAVA_MODULE='com/finance/migration';
const javaModuleDir=(root:string)=>`${root}/src/main/java/${JAVA_MODULE}`;
/** Everything a Tool brings in lives under the service's `business/`, never anywhere else. */
const businessDir=(root:string)=>`${root}/business`;

const SCAFFOLDS:Record<'java'|'python'|'node',Scaffold>={
  java:{
    service:(skillId,root,tools)=>[
      {name:`${root}/pom.xml`,content:mcpPom(skillId)},
      {name:`${javaModuleDir(root)}/MigrationMcpServer.java`,content:mcpServer(tools.map(tool=>javaClass(tool.name)))},
      {name:`${root}/Dockerfile`,content:'FROM eclipse-temurin:17-jre\nWORKDIR /app\nCOPY target/*-mcp-service-0.1.0.jar app.jar\nENV PORT=8080\nEXPOSE 8080\nENTRYPOINT ["java","-jar","/app/app.jar"]\n'},
      {name:`${root}/README.md`,content:`# ${skillId} MCP service\n\nPure Java 17 MCP service using the official Java SDK ${MCP_JAVA_SDK_VERSION} and MCP protocol 2025-06-18. Tool business implementations are Java source code compiled into the service; no Python or subprocess bridge is used.\n\nBuild: \`mvn clean package\`\n\nRun: \`PORT=8080 java -jar target/*-mcp-service-0.1.0.jar\`\n\nEndpoint: \`http://localhost:8080/mcp\`\n\nGenerated tools: ${tools.map(tool=>tool.name).join(', ')}.\n`},
    ],
    serviceEntry:(root)=>`${javaModuleDir(root)}/MigrationMcpServer.java`,
    business:(root,tool)=>({path:`${javaModuleDir(root)}/business/${javaBase(tool.name)}Business.java`,symbol:`${javaBase(tool.name)}Business`}),
    adapter:(root,tool,business)=>({
      name:`${javaModuleDir(root)}/tools/${javaClass(tool.name)}.java`,
      content:mcpTool(javaClass(tool.name),business.symbol,tool.name,tool.inputSchema),
    }),
  },
  python:{
    service:(skillId,root,tools,dependencies)=>{
      const declared=[...MCP_SERVICE_DEPENDENCIES,...dependencies];
      return [
      {name:`${root}/pyproject.toml`,content:pyProject(skillId,declared)},
      {name:`${root}/server.py`,content:pyServer(tools.map(tool=>({module:pythonName(tool.name),name:tool.name})),declared)},
      {name:`${root}/Dockerfile`,content:'FROM python:3.12-slim\nWORKDIR /app\nCOPY . /app\nRUN pip install --no-cache-dir .\nENV PORT=8080\nEXPOSE 8080\nCMD ["python", "server.py"]\n'},
      {name:`${root}/README.md`,content:`# ${skillId} MCP service\n\nPython MCP service using the official \`mcp\` SDK ${MCP_PYTHON_SDK_VERSION} over Streamable HTTP (MCP protocol 2025-06-18). Business implementations live in \`business/\`; the adapters in \`tools/\` keep the source Tool's input Schema, so the advertised interface is the original one.\n\nThe service declares its own environment (PEP 723 and \`pyproject.toml\`, emitted from one list), so it does not depend on any machine-wide install.\n\nRun: \`uv run --no-project server.py\`\n\nEndpoint: \`http://localhost:8080/mcp\`\n\nGenerated tools: ${tools.map(tool=>tool.name).join(', ')}.\n`},
    ];},
    serviceEntry:(root)=>`${root}/server.py`,
    business:(root,tool)=>({path:`${businessDir(root)}/${pythonName(tool.name)}.py`,symbol:pythonName(tool.name)}),
    adapter:(root,tool,business)=>({
      name:`${root}/tools/${pythonName(tool.name)}.py`,
      content:pyAdapter(tool,business.symbol),
    }),
  },
  node:{
    service:(skillId,root,tools,dependencies)=>{
      const declared={'@modelcontextprotocol/sdk':MCP_NODE_SDK_VERSION,...npmDependencies(dependencies)};
      return [
      {name:`${root}/package.json`,content:`${JSON.stringify({name:`${mavenArtifact(skillId)}-mcp-service`,version:'0.1.0',private:true,type:'module',dependencies:declared,scripts:{start:'node server.js'}},null,2)}\n`},
      {name:`${root}/server.js`,content:nodeServer(tools.map(tool=>({module:nodeName(tool.name),name:tool.name})))},
      {name:`${root}/Dockerfile`,content:'FROM node:22-alpine\nWORKDIR /app\nCOPY . /app\nRUN npm install --omit=dev\nENV PORT=8080\nEXPOSE 8080\nCMD ["node", "server.js"]\n'},
      {name:`${root}/README.md`,content:`# ${skillId} MCP service\n\nNode MCP service using the official \`@modelcontextprotocol/sdk\` ${MCP_NODE_SDK_VERSION} over Streamable HTTP (MCP protocol 2025-06-18). Business implementations live in \`business/\`; the adapters in \`tools/\` keep the source Tool's input Schema, so the advertised interface is the original one.\n\nThe service declares its own environment in \`package.json\`, so it does not depend on any machine-wide install.\n\nRun: \`npm install && PORT=8080 node server.js\`\n\nEndpoint: \`http://localhost:8080/mcp\`\n\nGenerated tools: ${tools.map(tool=>tool.name).join(', ')}.\n`},
    ];},
    serviceEntry:(root)=>`${root}/server.js`,
    business:(root,tool)=>({path:`${businessDir(root)}/${nodeName(tool.name)}.js`,symbol:`${nodeName(tool.name)}.js`}),
    adapter:(root,tool,business)=>({
      name:`${root}/tools/${nodeName(tool.name)}.js`,
      content:nodeAdapter(tool,business.symbol),
    }),
  },
};

const skillRelative=(name:string,skillFile:string)=>{
  const root=skillFile.includes('/')?skillFile.slice(0,skillFile.lastIndexOf('/')):'';
  if(!root)return name;
  return name.startsWith(`${root}/`)?name.slice(root.length+1):null;
};
const withPep723=(source:string,dependencies:string[]=[])=>/^#\s*\/\/\/\s*script\s*$/mu.test(source)?source:`# /// script\n# requires-python = ">=3.11"\n# dependencies = [${dependencies.map(value=>JSON.stringify(value)).join(', ')}]\n# ///\n\n${source}`;

/** An existing implementation that already satisfies the target form can be reused as-is. */
function reusable(tool:ProjectInspection['tools'][number],archive:Record<string,Uint8Array>,language:'python'|'node'){
  const kind=language==='node'?'NODE':'PYTHON';
  if(tool.portability!=='PORTABLE_SCRIPT'||tool.entrypoint?.kind!==kind||!tool.entrypoint.path)return null;
  const bytes=archive[tool.entrypoint.path];
  return bytes?{language,sourcePath:tool.entrypoint.path,source:Buffer.from(bytes).toString('utf8'),additionalFiles:[],dependencies:[]}:null;
}

export type McpServiceSite={businessPath:string;language:'java'|'python'|'node';serviceEntry:string};
export type McpWorkspace={files:Record<string,string>;sites:Record<string,McpServiceSite>};

/**
 * The MCP services the A4 agent has to write against.
 *
 * The service and its adapter are the platform's, generated here and handed to the agent, so
 * that the thing the contract test starts is the thing that ships -- and so the Schema the
 * service advertises is the source Schema rather than one derived from a function signature.
 * Only `business/` comes back from the agent; packaging regenerates the rest.
 */
export function mcpWorkspace(input:{skillId:string;inspection:ProjectInspection;decisions:ToolDecision[]}):McpWorkspace{
  const files:Record<string,string>={},sites:Record<string,McpServiceSite>={};
  const groups=new Map<'java'|'python'|'node',ProjectInspection['tools']>();
  for(const decision of input.decisions){
    if(decision.form!=='MCP')continue;
    const tool=input.inspection.tools.find(item=>item.toolId===decision.toolId);
    if(!tool)continue;
    const language=(decision.language??recommendLanguage(decision.form,tool.language)) as 'java'|'python'|'node';
    const group=groups.get(language)??[];
    group.push(tool);
    groups.set(language,group);
  }
  for(const [language,tools] of groups){
    const root=`mcp-${language}`,scaffold=SCAFFOLDS[language];
    const specs=tools.map(tool=>({name:tool.name,inputSchema:tool.inputSchema}));
    // Business dependencies are only known once the agent has written the code, so the seed
    // declares the SDK alone. Nothing on the agent path declares more today.
    for(const file of scaffold.service(input.skillId,root,specs,[]))files[file.name]=file.content;
    for(const tool of tools){
      const spec={name:tool.name,inputSchema:tool.inputSchema},site=scaffold.business(root,spec);
      const adapter=scaffold.adapter(root,spec,site);
      files[adapter.name]=adapter.content;
      sites[tool.toolId]={businessPath:site.path,language,serviceEntry:scaffold.serviceEntry(root)};
    }
  }
  return {files,sites};
}

export function generatePortableCandidate(input:{archive:Record<string,Uint8Array>;base:SkillAssetRecord;inspection:ProjectInspection;decisions:ToolDecision[];version:string;implementations?:Record<string,GeneratedToolImplementation>}){
  const implementations=input.implementations??{};
  const files:Record<string,Uint8Array>={},generations:PortableGeneration[]=[];
  const mcpDecisions=input.decisions.filter(decision=>decision.form==='MCP');
  const hasMcp=mcpDecisions.length>0;
  // A Tool being migrated is replaced, not carried alongside. Shipping the
  // runtime-coupled original next to its replacement would defeat the migration.
  const migratedSources=new Set(input.decisions.flatMap(decision=>
    input.inspection.tools.find(tool=>tool.toolId===decision.toolId)?.sourcePaths??[]));
  const sourceArchive=Object.fromEntries(Object.entries(input.archive).filter(([name])=>!migratedSources.has(name)));
  const normalizedSkill=normalizeSkillPackage(sourceArchive,input.base.skillFile,input.base.skillId,input.version);
  for(const [name,bytes] of Object.entries(normalizedSkill.files))files[hasMcp?`skill/${name}`:name]=bytes;
  const skillTarget=hasMcp?'skill/SKILL.md':'SKILL.md';
  if(!files[skillTarget])throw Object.assign(new Error('标准迁移输入缺少 skill/SKILL.md'),{statusCode:409});

  // One MCP service per language: a Tool keeps the language it was written in, and two
  // languages cannot share a process.
  const mcpGroups=new Map<'java'|'python'|'node',Array<{decision:ToolDecision;tool:ProjectInspection['tools'][number]}>>();
  for(const decision of mcpDecisions){
    const tool=input.inspection.tools.find(t=>t.toolId===decision.toolId);
    if(!tool)throw new Error(`Unknown Tool decision: ${decision.toolId}`);
    const language=(decision.language??recommendLanguage(decision.form,tool.language)) as 'java'|'python'|'node';
    const group=mcpGroups.get(language)??[];
    group.push({decision,tool});
    mcpGroups.set(language,group);
  }
  for(const [language,group] of mcpGroups){
    const root=`mcp-${language}`,scaffold=SCAFFOLDS[language];
    const tools=group.map(item=>({name:item.tool.name,inputSchema:item.tool.inputSchema}));
    // The service declares its own environment: its SDK plus every business dependency its
    // Tools brought in. Nothing here consults the platform's own environment.
    const dependencies=[...new Set(group.flatMap(item=>implementations[item.tool.toolId]?.dependencies??[]))];
    const shared=scaffold.service(input.base.skillId,root,tools,dependencies);
    for(const item of shared)files[item.name]=strToU8(item.content);
    const sharedPaths=shared.map(item=>item.name);
    const taken=new Set<string>();
    for(const {decision,tool} of group){
      const spec={name:tool.name,inputSchema:tool.inputSchema};
      const implementation=implementations[tool.toolId];
      if(implementation?.language!==language)
        throw Object.assign(new Error(`无法自动迁移 ${tool.name}：MCP 需要迁移模型生成可编译的 ${language} 完整业务实现；不会生成占位代码`),{statusCode:409});
      const site=scaffold.business(root,spec);
      const wrote=implementation.sourcePath.replace(/^\.\//u,'');
      // The adapter was generated before this code existed, so it imports one fixed path.
      // Accepting a Tool that wrote elsewhere would ship a service that cannot start.
      if(wrote!==site.path)
        throw Object.assign(new Error(`${tool.name} 的业务实现必须放在 ${site.path}，实际是 ${implementation.sourcePath}；生成的适配器按固定路径导入它`),{statusCode:409});
      const adapter=scaffold.adapter(root,spec,site);
      // Two Tool names can normalise to the same module. Overwriting silently would deliver a
      // service whose second Tool has the first Tool's body.
      const paths=[adapter.name,site.path,...implementation.additionalFiles.map(file=>`${businessDir(root)}/${file.path}`)];
      const clash=paths.find(path=>taken.has(path));
      if(clash)throw new Error(`生成的 ${clash} 与另一个 Tool 冲突；Tool 名称规范化后重复`);
      for(const path of paths)taken.add(path);
      files[adapter.name]=strToU8(adapter.content);
      files[site.path]=strToU8(implementation.source);
      // Service files are the platform's; an agent that lists them back would otherwise land
      // copies of them inside `business/`.
      for(const file of implementation.additionalFiles)
        if(!SERVICE_ROOT.test(file.path))files[`${businessDir(root)}/${file.path}`]=strToU8(file.content);
      generations.push({toolId:tool.toolId,toolName:tool.name,form:decision.form,files:[...sharedPaths,...paths],
        entrypoint:site.path,readyForValidation:true,todo:[],generatedBy:implementation.generatedBy,explanation:implementation.explanation,
        attempts:implementation.attempts,checks:implementation.checks});
    }
  }

  for(const decision of input.decisions){
    if(decision.form==='MCP')continue;
    const tool=input.inspection.tools.find(t=>t.toolId===decision.toolId);if(!tool)throw new Error(`Unknown Tool decision: ${decision.toolId}`);
    const language=(decision.language??recommendLanguage(decision.form,tool.language)) as 'python'|'node';
    const generated=implementations[tool.toolId];
    const implementation=generated?.language===language?generated:reusable(tool,input.archive,language);
    if(!implementation)
      throw Object.assign(new Error(`无法自动迁移 ${tool.name}：没有可独立执行的 ${language} 业务实现；不会生成占位代码`),{statusCode:409});
    const module=language==='python'?pythonName(tool.name):nodeName(tool.name);
    const extra=implementation.additionalFiles,dependencies=implementation.dependencies;
    const entries=[{path:implementation.sourcePath,content:implementation.source},...extra],multi=entries.length>1;
    const base=`${hasMcp?'skill/':''}scripts/`;
    // Node only treats a bare .js as ESM when a package.json says so, and the platform runs
    // the entrypoint as `node <path>`. A single file therefore ships as .mjs.
    const target=language==='python'
      ?(multi?`${base}${module}/${implementation.sourcePath}`:`${base}${module}.py`)
      :(multi?`${base}${module}/${implementation.sourcePath}`:`${base}${module}.mjs`);
    const written:{name:string;content:string}[]=entries.map((file,index)=>({
      name:multi?`${base}${module}/${file.path}`:target,
      content:index===0&&language==='python'?withPep723(file.content,dependencies):file.content,
    }));
    const manifest=multi&&language==='node'&&!entries.some(file=>file.path.endsWith('package.json'))
      ?[...written,{name:`${base}${module}/package.json`,content:'{\n  "type": "module"\n}\n'}] :written;
    const lock=input.archive[`${implementation.sourcePath}.lock`];if(lock)files[`${target}.lock`]=lock;
    for(const item of manifest)files[item.name]=strToU8(item.content);
    generations.push({toolId:tool.toolId,toolName:tool.name,form:decision.form,files:[...manifest.map(file=>file.name),...(lock?[`${target}.lock`]:[])],
      entrypoint:target,readyForValidation:true,todo:[],
      ...('generatedBy' in implementation?{generatedBy:implementation.generatedBy,explanation:implementation.explanation,attempts:implementation.attempts,checks:implementation.checks}:{})});
  }

  const diff:PortableDiff[]=Object.entries(files).flatMap(([name,bytes])=>{
    const before=input.archive[name]??input.archive[`skill/${name}`];
    if(before&&Buffer.compare(Buffer.from(before),Buffer.from(bytes))===0)return [];
    return [{path:name,operation:before?'MODIFY':'ADD',before:before?Buffer.from(before).toString('utf8'):'',after:Buffer.from(bytes).toString('utf8')} as PortableDiff];
  });
  return {files,generations,diff};
}
