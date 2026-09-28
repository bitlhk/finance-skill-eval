import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentStore } from "../src/service/environment-store.js";
import { createEnvironmentSchema } from "../src/shared/contracts/environment.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { createEvaluationService } from "../src/service/server.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "environment-management-"));
  directories.push(directory);
  const store = new EnvironmentStore(directory);
  await store.initialize();
  return { directory, store };
}
const mcpInput = { name: "业务 MCP", type: "mcp_streamable_http", endpoint: "http://localhost:5000/mcp" };
const runtimeInput = { name: "Runtime", type: "runtime_http", runtimeType: "openjiuwen", endpoint: "http://localhost:5001/execute" };

describe("environment registry", () => {
  it("updates in place, protects bound MCPs and preserves compatibility records", async () => {
    const { store } = await fixture();
    const mcp = await store.create(mcpInput);
    const runtime = await store.create({ ...runtimeInput, mcpEnvironmentIds: [mcp.environmentId] });
    await expect(store.remove(mcp.environmentId)).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.update(runtime.environmentId, mcpInput)).rejects.toMatchObject({ statusCode: 409 });
    const edited = await store.update(runtime.environmentId, { ...runtimeInput, name: "Updated" });
    expect(edited.environmentId).toBe(runtime.environmentId);
    expect(edited.createdAt).toBe(runtime.createdAt);
    expect(edited.mcpEnvironmentIds).toEqual([]);
    await store.remove(mcp.environmentId);
    expect(await store.get(mcp.environmentId)).toBeNull();
    expect((await store.list()).map(item => item.name)).toEqual(["Updated"]);
  });

  it("rejects bad bindings, duplicate bindings and credential-bearing URLs", async () => {
    const { store } = await fixture();
    await expect(store.create({ ...runtimeInput, mcpEnvironmentIds: ["missing"] })).rejects.toMatchObject({ statusCode: 400 });
    expect(createEnvironmentSchema.safeParse({ ...runtimeInput, mcpEnvironmentIds: ["a", "a"] }).success).toBe(false);
    for (const endpoint of ["file:///tmp/test", "https://user:secret@example.com/execute", "https://example.com/#fragment"]) {
      expect(createEnvironmentSchema.safeParse({ ...runtimeInput, endpoint }).success).toBe(false);
    }
    expect(createEnvironmentSchema.safeParse({ ...runtimeInput, credentialEnv: "Bearer actual-secret" }).success).toBe(false);
    await expect(store.remove("../escape")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not call a healthy but incompatible OpenJiuwen runtime ready", async () => {
    const { store } = await fixture();
    const mcp = await store.create(mcpInput);
    const runtime = await store.create({ ...runtimeInput, mcpEnvironmentIds: [mcp.environmentId] });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    fetch.mockResolvedValueOnce(Response.json({ status: "ready" }));
    expect(await store.preflight(runtime)).toMatchObject({ status: "failed", error: expect.stringContaining("未声明") });
    fetch.mockResolvedValueOnce(Response.json({ status: "ready", mcpEndpoints: [] }));
    expect(await store.preflight(runtime)).toMatchObject({ status: "failed", error: expect.stringContaining("尚未接受") });
    fetch.mockResolvedValueOnce(Response.json({ status: "ready", mcpEndpoints: [mcp.endpoint] }));
    expect(await store.preflight(runtime)).toMatchObject({ status: "ready" });
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ redirect: "error" });
  });

  it('discovers Runtime Launcher capabilities without pre-registering models or MCPs',async()=>{
    const {store}=await fixture();
    const launcher=await store.create({name:'Launcher',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://127.0.0.1:9000'});
    const capabilities={schemaVersion:'finance.skill-eval.runtime-capabilities.v1',runtime:{type:'openjiuwen',version:'1.0.0'},models:[{modelId:'execution',upstreamModelId:'deepseek-v4'}],defaultModelId:'execution',features:{streaming:true,asyncLaunch:false,packagedMcp:true,externalMcp:false,inlineSecrets:true},limits:{maxArchiveBytes:1024,maxFiles:20,maxTimeoutMs:300000,maxConcurrentInstances:2}};
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(capabilities)));
    expect(await store.inspect(launcher)).toMatchObject({status:'ready',capabilities});
    expect(createEnvironmentSchema.safeParse({name:'remote',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://runtime.example.com'}).success).toBe(false);
  });

  it('combines a launcher, MCP bindings and a default model into an execution environment',async()=>{
    const {store}=await fixture();
    const launcher=await store.create({name:'Launcher',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://127.0.0.1:9000'});
    const mcp=await store.create(mcpInput);
    const profile=await store.create({name:'评测环境',type:'execution_environment',launcherEnvironmentId:launcher.environmentId,mcpEnvironmentIds:[mcp.environmentId],defaultModelId:'execution'});
    await expect(store.resolveLauncher(profile)).resolves.toMatchObject({launcher:{environmentId:launcher.environmentId},mcpEnvironmentIds:[mcp.environmentId],defaultModelId:'execution'});
    await expect(store.remove(launcher.environmentId)).rejects.toMatchObject({statusCode:409});
    await expect(store.remove(mcp.environmentId)).rejects.toMatchObject({statusCode:409});
    const capabilities={schemaVersion:'finance.skill-eval.runtime-capabilities.v1',runtime:{type:'openjiuwen',version:'1.0.0'},models:[{modelId:'other',upstreamModelId:'glm'}],defaultModelId:'other',features:{streaming:true,asyncLaunch:false,packagedMcp:true,externalMcp:true,inlineSecrets:true},limits:{maxArchiveBytes:1024,maxFiles:20,maxTimeoutMs:300000,maxConcurrentInstances:2}};
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(capabilities)));
    expect(await store.preflight(profile)).toMatchObject({status:'failed',error:expect.stringContaining('默认模型')});
  });

  it("serves edit and delete through existing authentication hooks", async () => {
    const { directory } = await fixture();
    const app = await createEvaluationService({ dataDirectory: directory, rootDirectory: path.resolve('.'), accessToken: "test-secret" });
    const headers = { authorization: "Bearer test-secret" };
    try {
      const created = await app.inject({ method: "POST", url: "/api/environments", headers, payload: mcpInput });
      expect(created.statusCode).toBe(200);
      const url = `/api/environments/${created.json().environmentId}`;
      expect((await app.inject({ method: "PUT", url, payload: mcpInput })).statusCode).toBe(401);
      const updated = await app.inject({ method: "PUT", url, headers, payload: { ...mcpInput, name: "Edited" } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().name).toBe("Edited");
      expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(401);
      expect((await app.inject({ method: "DELETE", url, headers })).statusCode).toBe(204);
      expect((await app.inject({ method: "DELETE", url, headers })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe("per-project mutation queue", () => {
  it("serializes one project while allowing another through", async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = queue.run("a", async () => { events.push("a1-start"); await gate; events.push("a1-end"); });
    const second = queue.run("a", async () => { events.push("a2"); });
    await queue.run("b", async () => { events.push("b"); });
    expect(events).toEqual(["a1-start", "b"]);
    release(); await Promise.all([first, second]);
    expect(events).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });
  it("releases a failed operation and does not leak locks", async () => {
    const queue = new KeyedQueue();
    await expect(queue.run("a", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(queue.run("a", async () => 42)).resolves.toBe(42);
    await Promise.resolve();
    expect((queue as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });
});
