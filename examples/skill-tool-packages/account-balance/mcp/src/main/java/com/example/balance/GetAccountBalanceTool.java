package com.example.balance;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.JsonSchema;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.util.List;
import java.util.Map;

public final class GetAccountBalanceTool {
    private static final String INPUT_SCHEMA = """
        {
          "type": "object",
          "properties": {"account_id": {"type": "string"}},
          "required": ["account_id"],
          "additionalProperties": false
        }
        """;

    private static final Map<String, Map<String, String>> ACCOUNTS = Map.of(
        "A10001",
        Map.of(
            "currency", "CNY",
            "ledger_balance", "1000.00",
            "available_balance", "800.00"
        )
    );

    private GetAccountBalanceTool() {}

    public static SyncToolSpecification specification(ObjectMapper mapper) {
        try {
            Map<String, Object> schema = mapper.readValue(INPUT_SCHEMA, new TypeReference<>() {});
            return SyncToolSpecification.builder()
                .tool(Tool.builder()
                    .name("get_account_balance")
                    .description("查询指定账户的账面余额和可用余额")
                    .inputSchema(new JsonSchema(
                        "object",
                        objectMap(schema.get("properties")),
                        List.of("account_id"),
                        false,
                        Map.of(),
                        Map.of()
                    ))
                    .build())
                .callHandler((exchange, request) -> execute(mapper, request.arguments()))
                .build();
        } catch (Exception error) {
            throw new IllegalStateException("Invalid Tool schema", error);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> objectMap(Object value) {
        return value instanceof Map<?, ?> ? (Map<String, Object>) value : Map.of();
    }

    private static CallToolResult execute(ObjectMapper mapper, Map<String, Object> arguments) {
        try {
            String accountId = String.valueOf(arguments.get("account_id"));
            Map<String, String> account = ACCOUNTS.get(accountId);
            if (account == null) {
                return error("ACCOUNT_NOT_FOUND");
            }
            String result = mapper.writeValueAsString(Map.of(
                "account_id", accountId,
                "currency", account.get("currency"),
                "ledger_balance", account.get("ledger_balance"),
                "available_balance", account.get("available_balance")
            ));
            return CallToolResult.builder()
                .content(List.of(new TextContent(result)))
                .build();
        } catch (Exception error) {
            return error("INTERNAL_ERROR");
        }
    }

    private static CallToolResult error(String code) {
        return CallToolResult.builder()
            .isError(true)
            .content(List.of(new TextContent(code)))
            .build();
    }
}
