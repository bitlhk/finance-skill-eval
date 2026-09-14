# Account Balance MCP Tool

Build with `mvn --batch-mode clean package` and run with
`java -jar target/account-balance-mcp-0.1.0.jar`.

The Streamable HTTP endpoint is `http://localhost:8080/mcp`. A Runtime should
verify that `tools/list` contains `get_account_balance` before loading the Skill.

The in-memory account is synthetic demonstration data. Replace it with a
reviewed business service before production use.
