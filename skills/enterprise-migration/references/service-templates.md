# 服务与脚本的骨架

迁移出来的工具必须**能被平台起起来并调用**。下面说清楚"能被调用"意味着什么，以及各语言的骨架。

**这些是骨架，不是必须逐字照抄的模板。** 结构、命名、依赖管理由你决定；**唯一不能改的是下面那几条硬要求**——它们是平台能不能起它、能不能验它的前提。

## 硬要求

### MCP 服务

1. **传输是 Streamable HTTP，端点 `/mcp`。** 平台按 `http://127.0.0.1:<port>/mcp` 连它。stdio 起不来。
2. **端口从 `PORT` 环境变量读**，默认 8080，**监听 `0.0.0.0`**。
3. **`tools/list` 公布源工具的输入 Schema。** 不要从函数签名反推——推出来的不是源 Schema。平台会拿它和**基线**对照，差异**记进报告**：不是门禁，但没写理由的差异会被当成手滑。
4. **`tools/call` 的返回里放 JSON 文本**，形状与源工具的输出一致。
5. **工具名不能改。**

门禁只有三条：**起得来、工具有、调得通**。接口与基线一致不是第四条——迁移本来就要做适配（去 runtime 耦合、改调用方式），真改了就在 `changes` 里写清楚为什么。

### Script

1. 从 **stdin 读一个 JSON object**，向 **stdout 只写一个 JSON value**。
2. 错误写 stderr 并用非零退出码。
3. Python 用 **PEP 723** 在文件内声明依赖；Node 单文件用 `.mjs`，多文件目录里放 `package.json` 声明 `{"type":"module"}`。

### 两者都要有

- **启动命令**：交付时说明"怎么把它跑起来"（例如 `uv run --no-project server.py` / `npm install && node server.js`）。平台按它起服务。
- **README**：给人看的运行说明。
- **自己的依赖自己声明**（PEP 723 / `package.json` / `pom.xml`）。平台的环境不是它的环境。

## Python MCP 骨架

用官方 `mcp` 的低层 `Server`——只有它能公布**给定**的 Schema（高层 API 从函数签名推，会推错）。

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp", "uvicorn"]
# ///
import json
import os

from mcp.server.lowlevel import Server
from mcp.types import CallToolRequestParams, CallToolResult, ListToolsResult, TextContent, Tool

INPUT_SCHEMA = { ... }  # 源工具的输入 Schema，原样

async def _list_tools(_context, _params) -> ListToolsResult:
    return ListToolsResult(tools=[Tool(name="<tool>", description="", inputSchema=INPUT_SCHEMA)])

async def _call_tool(_context, params: CallToolRequestParams) -> CallToolResult:
    output = execute(params.name, dict(params.arguments or {}))
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(output, ensure_ascii=False))])

server = Server(name="<skill>-mcp", version="0.1.0", on_list_tools=_list_tools, on_call_tool=_call_tool)

def main() -> None:
    import uvicorn
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(server.streamable_http_app(streamable_http_path="/mcp", host="0.0.0.0"), host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()
```

依赖写进 PEP 723 头。要按项目结构管理时同时给 `pyproject.toml`，**两处依赖列表必须一致**。

## Node MCP 骨架

```js
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const INPUT_SCHEMA = { ... };  // 源工具的输入 Schema，原样

const server = new Server({ name: "<skill>-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "<tool>", description: "", inputSchema: INPUT_SCHEMA }],
}));
server.setRequestHandler(CallToolRequestSchema, async request => ({
  content: [{ type: "text", text: JSON.stringify(execute(request.params.name, request.params.arguments ?? {})) }],
}));

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await server.connect(transport);
const port = Number(process.env.PORT ?? 8080);
createServer((req, res) => { /* 只接 /mcp，读 body 后交给 transport.handleRequest */ }).listen(port, "0.0.0.0");
```

`package.json` 里 `"type": "module"`，依赖 `@modelcontextprotocol/sdk`。

## Java MCP 骨架

官方 Java SDK + Jetty servlet，Maven 打成可执行 fat jar。四个文件，`===` 行是文件边界：

```
=== mcp-java/pom.xml ===
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.finance.migration</groupId>
  <artifactId><skill>-mcp-service</artifactId>
  <version>0.1.0</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <mcp.java.sdk.version>1.1.4</mcp.java.sdk.version>
    <jetty.version>12.0.21</jetty.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>io.modelcontextprotocol.sdk</groupId>
      <artifactId>mcp</artifactId>
      <version>${mcp.java.sdk.version}</version>
    </dependency>
    <dependency>
      <groupId>org.eclipse.jetty.ee10</groupId>
      <artifactId>jetty-ee10-servlet</artifactId>
      <version>${jetty.version}</version>
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

=== mcp-java/src/main/java/com/finance/migration/MigrationMcpServer.java ===
package com.finance.migration;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.finance.migration.tools.RootTool;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.HttpServletStreamableServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.ServerCapabilities;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;

public final class MigrationMcpServer {
  private MigrationMcpServer() {}

  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    var transport = HttpServletStreamableServerTransportProvider.builder().mcpEndpoint("/mcp").build();
    ObjectMapper mapper = new ObjectMapper();
    McpSyncServer mcpServer = McpServer.sync(transport)
        .serverInfo("<skill>-mcp", "0.1.0")
        .capabilities(ServerCapabilities.builder().tools(false).build())
        .tools(RootTool.specification(mapper))
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
    httpServer.join();
  }
}

=== mcp-java/src/main/java/com/finance/migration/tools/RootTool.java ===
package com.finance.migration.tools;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.finance.migration.business.RootBusiness;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.JsonSchema;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.util.List;
import java.util.Map;

/** 工具名与输入 Schema 都来自源工具，原样公布。 */
public final class RootTool {
  public static final String TOOL_NAME = "<tool>";
  private static final String INPUT_SCHEMA = "<源工具输入 Schema 的 JSON 字面量>";
  private RootTool() {}

  public static SyncToolSpecification specification(ObjectMapper mapper) {
    try {
      Map<String, Object> schema = mapper.readValue(INPUT_SCHEMA, new TypeReference<>() {});
      return SyncToolSpecification.builder()
          .tool(Tool.builder().name(TOOL_NAME).description("")
              .inputSchema(new JsonSchema(
                  String.valueOf(schema.getOrDefault("type", "object")),
                  nullableMap(schema.get("properties")),
                  stringList(schema.get("required")),
                  schema.get("additionalProperties") instanceof Boolean allowed ? allowed : null,
                  nullableMap(schema.get("$defs")),
                  nullableMap(schema.get("definitions"))))
              .build())
          .callHandler((exchange, request) -> RootBusiness.execute(mapper, request.arguments()))
          .build();
    } catch (Exception error) {
      throw new IllegalStateException("Invalid input schema for " + TOOL_NAME, error);
    }
  }

  /** 源 Schema 没有的键要传 null：传空 Map 会在公布时变成 `"$defs":{}`，那就不是原样了。 */
  @SuppressWarnings("unchecked")
  private static Map<String, Object> nullableMap(Object value) {
    return value instanceof Map<?, ?> ? (Map<String, Object>) value : null;
  }

  private static List<String> stringList(Object value) {
    return value instanceof List<?> values ? values.stream().map(String::valueOf).toList() : List.of();
  }

  /** 成功与失败都要变成 JSON 文本，别让它变成协议错误。 */
  public static CallToolResult result(ObjectMapper mapper, Object output) {
    try {
      return CallToolResult.builder().content(List.of(new TextContent(mapper.writeValueAsString(output)))).build();
    } catch (Exception error) {
      return CallToolResult.builder().isError(true)
          .content(List.of(new TextContent("TOOL_EXECUTION_FAILED: " + error.getMessage()))).build();
    }
  }
}

=== mcp-java/src/main/java/com/finance/migration/business/RootBusiness.java ===
package com.finance.migration.business;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.finance.migration.tools.RootTool;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import java.util.Map;

/** 迁移过来的业务实现。入参是 MCP 传来的 arguments，返回值原样进 CallToolResult。 */
public final class RootBusiness {
  private RootBusiness() {}

  public static CallToolResult execute(ObjectMapper mapper, Map<String, Object> arguments) {
    return RootTool.result(mapper, Map.of("received", arguments));
  }
}
```

首期只用 JDK 17 标准库，不引第三方业务依赖。**三个只有这里会踩的坑**：Schema 必须走
`JsonSchema` 显式构造——`Tool.builder()` 不会从 Java 签名推；入参出参都用 `Map<String,Object>`，
不要为了好看引入 DTO，那会把源 Schema 变成你的签名；业务异常要自己包成 `isError` 的
`CallToolResult`，`callHandler` 里抛出去会变成协议错误而不是工具错误。

## Script 骨架

```python
import json
import sys

def main():
    payload = json.load(sys.stdin)
    json.dump(run(payload), sys.stdout)

if __name__ == "__main__":
    main()
```

## 目录约定

一个 Skill 里，**每种语言一个服务工程**，多个同语言的工具放在同一个服务里：

```
mcp-python/     MCP 服务（Python）
mcp-node/       MCP 服务（Node）
mcp-java/       MCP 服务（Java）
scripts/        Script 工具（Python / Node）
skill/          Skill 文档与资源
```

两种语言不能共用一个进程；强迫其中一种跨语言重写又违背"同语言优先"。
