# 服务与脚本的骨架

迁移出来的工具必须**能被平台起起来并调用**。下面说清楚"能被调用"意味着什么，以及各语言的骨架。

**这些是骨架，不是必须逐字照抄的模板。** 结构、命名、依赖管理由你决定；**唯一不能改的是下面那几条硬要求**——它们是平台能不能起它、能不能验它的前提。

## 硬要求

### MCP 服务

1. **传输是 Streamable HTTP，端点 `/mcp`。** 平台按 `http://127.0.0.1:<port>/mcp` 连它。stdio 起不来。
2. **端口从 `PORT` 环境变量读**，默认 8080，**监听 `0.0.0.0`**。
3. **`tools/list` 公布业务输入 Schema。** 用类型、默认值和约束表达源业务契约，实际发现工具后与基线核对 required、类型、枚举、额外字段及输出形状。平台会拿它和**基线**对照，差异**记进报告**：不是门禁，但必须说明原因。不能为了完全复制源 Schema 而保留隐式身份和凭证参数。
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

新生成 Python 服务使用独立包 **FastMCP 2.14.7**（`from fastmcp import FastMCP`），不要使用官方 SDK 内嵌的 `mcp.server.fastmcp` 或自行拼装低层 Server。用具名函数、类型注解和必要的 Pydantic 约束定义业务 Schema；复杂 Schema 应明确表达约束并实际发现核对，不能仅改展示 Schema 而让真实参数校验不一致。

依赖写在 PEP 723 头里，`uv run --no-project mcp-python/server.py` 直接跑。下面是可独立启动的协议骨架；`id` 和回显实现仅用于验收，实际工具的参数类型和业务实现必须替换为源契约。

```
=== mcp-python/server.py ===
# /// script
# requires-python = ">=3.11"
# dependencies = ["fastmcp==2.14.7"]
# ///
import json
import os
from fastmcp import FastMCP
from fastmcp.tools.tool import ToolResult
from mcp.types import TextContent

server = FastMCP("<skill>-mcp")

@server.tool(name="<tool>")
async def lookup(id: str) -> ToolResult:
    result = {"received": {"id": id}}
    return ToolResult(
        content=[TextContent(type="text", text=json.dumps(result))],
        structured_content=result,
    )

if __name__ == "__main__":
    server.run(transport="http", host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), path="/mcp", stateless_http=True)
```

### Python 按请求消费凭据的业务示例

下例展示余额类工具的请求边界；实际工具名、输入、Header、下游地址和错误语义必须来自源代码及诊断声明，不复制样例假设。它需要真实或测试业务服务及请求 Header，不能当作无需配置的协议骨架运行。

```
=== mcp-python/server.py ===
# /// script
# requires-python = ">=3.11"
# dependencies = ["fastmcp==2.14.7", "httpx"]
# ///
import json
import os

import httpx
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
from fastmcp.tools.tool import ToolResult
from mcp.types import TextContent

server = FastMCP("enterprise-balance")


@server.tool(name="balance")
async def balance(account_id: str) -> ToolResult:
    """查询余额。凭证与租户由 Runtime 的当前请求 Header 提供。"""
    headers = get_http_headers(include_all=True)
    credential = headers.get("authorization")
    tenant_id = headers.get("x-tenant-id")
    if not credential or not tenant_id:
        raise ValueError("缺少声明的 Authorization 或 X-Tenant-Id")
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(
            os.environ["BALANCE_SERVICE_URL"].rstrip("/") + "/balance",
            params={"account": account_id},
            headers={"Authorization": credential, "X-Tenant-Id": tenant_id},
        )
        response.raise_for_status()
        output = response.json()
    return ToolResult(content=[TextContent(type="text", text=json.dumps(output, ensure_ascii=False))])


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server.run(transport="http", host="0.0.0.0", port=port, path="/mcp", stateless_http=True)


if __name__ == "__main__":
    main()
```

要按项目结构管理依赖时同时给 `pyproject.toml`，**两处依赖列表必须一致**。

### 结构化返回的 Python API 与协议字段

原工具有结构化业务结果，或已确认方案要求文本与结构化结果并存时，应由同一个业务结果同时生成两个通道，不改业务字段。FastMCP 2.14.7 的 Python `ToolResult` 构造参数为 `structured_content`，不是 MCP JSON 协议字段 `structuredContent`。框架在传输时转换命名；用 camelCase 调用 Python 构造函数会在真实业务返回时抛出 TypeError，编译与 tools/list 成功不能证明这条路径可运行。

```python
result = business_result
return ToolResult(
    content=[TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
    structured_content=result,
)
```

在实际声明的依赖环境验证构造 API，再对真实 `tools/call` 返回的文本 JSON 与 `structuredContent` 作比较。业务依赖不可用时，应如实标记尚未验证，不用空返回或伪造业务响应宣称业务通过。

Header 按当前调用读取，不能保存在共享实例或全局可变身份中；只选择声明需要的 Header，不无差别转发。`include_all=True` 不代表全部透传。使用 FastMCP 不要求启用它的 auth 功能：企业凭证获取和刷新属于 Runtime Provider，Tool 可以按下游契约解析、消费凭证。stateless HTTP 是本平台普通请求型工具的默认方式，确需会话能力时按业务语义实现并验证调用隔离。

## Node MCP 骨架

`package.json` 里 `"type": "module"`，依赖 `@modelcontextprotocol/sdk`。HTTP 那层是最容易写错的地方：
**一个会话一个 transport**，`/mcp` 以外的路径给 404，body 读完了再交给 `handleRequest`。

```
=== mcp-node/server.mjs ===
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "<tool>";
const INPUT_SCHEMA = <源工具输入 Schema 的 JSON 字面量>;

function execute(name, args) {
  return { received: args };
}

const server = new Server({ name: "<skill>-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: TOOL_NAME, description: "", inputSchema: INPUT_SCHEMA }],
}));
server.setRequestHandler(CallToolRequestSchema, async request => ({
  content: [{ type: "text", text: JSON.stringify(execute(request.params.name, request.params.arguments ?? {})) }],
}));

const transports = new Map();
const port = Number(process.env.PORT ?? 8080);

createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => { transports.set(id, transport); },
    });
    transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
    await server.connect(transport);
  }
  let body;
  if (req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = raw ? JSON.parse(raw) : undefined;
  }
  await transport.handleRequest(req, res, body);
}).listen(port, "0.0.0.0");

=== mcp-node/package.json ===
{
  "name": "<skill>-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node server.mjs" },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.30.0" }
}
```

## Java MCP 骨架

> 当前平台的 Java 编译与契约验证只允许 JDK 17 标准库。下面的 Maven/官方 SDK
> 模板是后续构建器接入 Maven 后的设计参考，**当前生成不得使用**。当前交付不要创建
> `pom.xml`，不要导入 MCP SDK、Jetty 或 Jackson；使用 `com.sun.net.httpserver.HttpServer`
> 实现 `/mcp` 的 initialize、notifications/initialized、tools/list、tools/call，并用
> `compile_source(language="java")`（省略 paths）编译所有 `.java` 文件。业务参数 Schema
> 必须显式公布，Header 按当前请求读取，`PORT` 从环境变量读取。

以下模板暂不执行：

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
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
      </plugin>
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

## 服务配置与按调用注入

业务服务地址、固定超时等部署配置，按诊断的 `SERVICE_ENV` 声明在 MCP 服务中读取环境变量。平台启动对应子进程时提供实际值；迁移模型只接收变量名、用途、类型和必需性。用 `serviceEnvironment:[{key,name}]` 报告绑定。必需变量缺失应在业务调用前明确失败；公布工具契约时不访问业务接口，也不索要真实值。不写死地址，不把地址放入 Header 或 arguments。

用户上下文通过声明的 HTTP Header 传递，鉴权凭证由受信任 Runtime Provider 提供。服务配置不进入 `runtimeBindings` 或 `runtimeToolConfig.context`。包根目录配置模板 `runtime-tool-config.template.json` 的 `serviceEnvironment` 仅包含声明，实际值由部署方提供。
