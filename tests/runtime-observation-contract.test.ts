import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  runtimeObservationCapabilitiesSchema,
  runtimeObservationEventSchema,
} from "../src/shared/contracts/runtime-observation.js";
import { runtimeLauncherCapabilitiesSchema } from "../src/runtime-launcher.js";

it("keeps normalized semantics separate from framework-native event names", async () => {
  for (const name of ["finance.runtime-observation.v1.schema.json", "finance.runtime-observation-capabilities.v1.schema.json"]) {
    const schema = JSON.parse(await readFile(new URL(`../contracts/runtime-launcher/${name}`, import.meta.url), "utf8"));
    expect(schema).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: name.replace(".schema.json", "") });
  }
  const event = JSON.parse(await readFile(new URL("../contracts/runtime-launcher/examples/tool-call.completed.json", import.meta.url), "utf8"));
  expect(runtimeObservationEventSchema.parse(event)).toMatchObject({
    kind: "tool.call.completed",
    source: { framework: "openjiuwen", nativeEventType: "after_tool_call", synthesized: false },
    native: { data: { round: 2 } },
  });
});

it("requires execution correlation and identifies synthesized events", () => {
  const base = {
    schemaVersion: "finance.runtime-observation.v1",
    eventId: "event-1", sequence: 1, occurredAt: "2026-09-30T12:00:00.000Z",
    traceId: "trace-1", instanceId: "instance-1", kind: "execution.started",
    source: { adapter: "generic", synthesized: true }, payload: {},
  };
  expect(() => runtimeObservationEventSchema.parse(base)).toThrow(/runId, caseId and side/u);
  expect(runtimeObservationEventSchema.parse({ ...base, runId: "run-1", caseId: "case-1", side: "right" })).toMatchObject({ source: { synthesized: true } });
});

it("rejects oversized and sensitive observation payloads at the receiver boundary", () => {
  const base = {
    schemaVersion: "finance.runtime-observation.v1" as const,
    eventId: "event-1", sequence: 1, occurredAt: "2026-09-30T12:00:00.000Z",
    traceId: "trace-1", instanceId: "instance-1", runId: "run-1", caseId: "case-1", side: "right" as const,
    kind: "output.delta" as const, source: { adapter: "generic", synthesized: true }, payload: { text: "ok" },
  };
  expect(() => runtimeObservationEventSchema.parse({ ...base, eventId: "x".repeat(201) })).toThrow();
  expect(() => runtimeObservationEventSchema.parse({ ...base, payload: { text: "x".repeat(16_385) } })).toThrow();
  expect(() => runtimeObservationEventSchema.parse({ ...base, source: { adapter: "generic", nativeEventType: "event", synthesized: false }, native: { data: { api_key: "do-not-export" } } })).toThrow(/forbidden sensitive field/u);
  expect(() => runtimeObservationEventSchema.parse({ ...base, source: { adapter: "generic", nativeEventType: "event", synthesized: false }, native: { data: { responseBody: { account: "A1", balance: 100 } } } })).toThrow(/forbidden sensitive field/u);
  for(const key of ['API_KEY','Api-Key','api_key','apiKey','AUTHORIZATION','Reasoning','responseBody']){
    expect(() => runtimeObservationEventSchema.parse({ ...base, source: { adapter: "generic", nativeEventType: "event", synthesized: false }, native: { data: { [key]: 'must-not-pass' } } }),key).toThrow(/forbidden sensitive field/u);
  }
  expect(() => runtimeObservationEventSchema.parse({ ...base, source: { adapter: "generic", nativeEventType: "event", synthesized: false }, native: { data: { value: "x".repeat(32_769) } } })).toThrow(/32768 serialized bytes/u);
  let nested:unknown="leaf";
  for(let index=0;index<9;index+=1)nested={child:nested};
  expect(() => runtimeObservationEventSchema.parse({ ...base, source: { adapter: "generic", nativeEventType: "event", synthesized: false }, native: { data: nested } })).toThrow(/maximum depth 8/u);
});

it("enforces observation profile minimums without requiring optional events for acceptance", () => {
  const core = {
    schemaVersion: "finance.runtime-observation-capabilities.v1",
    profile: "core", nativeEvents: false, replayable: false,
    supportedKinds: ["execution.started", "execution.completed", "execution.failed"],
  };
  expect(runtimeObservationCapabilitiesSchema.parse(core).profile).toBe("core");
  expect(() => runtimeObservationCapabilitiesSchema.parse({ ...core, profile: "tool" })).toThrow(/tool profile requires/u);
  expect(() => runtimeObservationCapabilitiesSchema.parse({ ...core, profile: "detailed" })).toThrow();
});

it("advertises observation support without breaking legacy Launcher capabilities", () => {
  const legacy = {
    schemaVersion: "finance.skill-eval.runtime-capabilities.v1",
    runtime: { type: "openjiuwen", version: "1" },
    models: [{ modelId: "execution", upstreamModelId: "glm" }], defaultModelId: "execution",
    features: { streaming: true, asyncLaunch: false, packagedMcp: true, externalMcp: true, inlineSecrets: true },
    limits: { maxArchiveBytes: 1, maxFiles: 1, maxTimeoutMs: 1, maxConcurrentInstances: 1 },
  };
  expect(runtimeLauncherCapabilitiesSchema.parse(legacy).observability).toBeUndefined();
  expect(runtimeLauncherCapabilitiesSchema.parse(legacy).supportedSkillModes).toBeUndefined();
  expect(runtimeLauncherCapabilitiesSchema.parse({ ...legacy, supportedSkillModes: ["skill_version"] }).supportedSkillModes).toEqual(["skill_version"]);
  expect(runtimeLauncherCapabilitiesSchema.parse({ ...legacy, observability: {
    schemaVersion: "finance.runtime-observation-capabilities.v1", profile: "core", nativeEvents: false, replayable: false,
    supportedKinds: ["execution.started", "execution.completed", "execution.failed"],
  } }).observability?.profile).toBe("core");
});
