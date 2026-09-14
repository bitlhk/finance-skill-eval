package com.example.balance;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.HttpServletStreamableServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.ServerCapabilities;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;

public final class BalanceMcpServer {
    private BalanceMcpServer() {}

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        var transport = HttpServletStreamableServerTransportProvider.builder()
            .mcpEndpoint("/mcp")
            .build();

        ObjectMapper mapper = new ObjectMapper();
        McpSyncServer mcpServer = McpServer.sync(transport)
            .serverInfo("account-balance", "0.1.0")
            .capabilities(ServerCapabilities.builder().tools(false).build())
            .tools(GetAccountBalanceTool.specification(mapper))
            .build();

        Server httpServer = new Server(port);
        ServletContextHandler context = new ServletContextHandler();
        context.setContextPath("/");
        context.addServlet(new ServletHolder(transport), "/mcp");
        httpServer.setHandler(context);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            mcpServer.close();
            try {
                httpServer.stop();
            } catch (Exception ignored) {
                // Server is already stopping.
            }
        }));

        httpServer.start();
        System.out.println("MCP endpoint: http://0.0.0.0:" + port + "/mcp");
        httpServer.join();
    }
}
