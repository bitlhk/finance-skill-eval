import { describe, expect, it, vi } from "vitest";
import { EnvironmentStore } from "../src/service/environment-store.js";
import { environmentRecordSchema } from "../src/service/contracts.js";
import { findMissingRequiredTools } from "../src/service/run-manager.js";

describe("runtime environment tool selection", () => {
  it('counts a directly inspected MCP as one service, not zero bindings',async()=>{
    const store=new EnvironmentStore('/unused');
    vi.spyOn(store,'preflight').mockResolvedValue({status:'ready',elapsedMs:1,error:null,tools:[{name:'read',description:'read'}]} as never);
    const record=environmentRecordSchema.parse({environmentId:'env-one',name:'MCP',type:'mcp_streamable_http',endpoint:'http://localhost/mcp',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    const result=await store.inspect(record);
    expect(result.toolCount).toBe(1); expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0]?.toolNames).toEqual(['read']);
  });
  it("reports only tools that are not exposed by the linked MCP servers", () => {
    expect(findMissingRequiredTools(
      ["customer_profile", "portfolio_snapshot", "eligible_products"],
      [
        {
          serverId: "wealth-mcp",
          endpoint: "https://mcp.example/mcp",
          transport: "streamable_http",
          toolNames: ["customer_profile", "portfolio_snapshot"],
        },
      ],
    )).toEqual(["eligible_products"]);
  });
});
