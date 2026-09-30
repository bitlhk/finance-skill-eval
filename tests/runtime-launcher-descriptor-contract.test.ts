import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  runtimeLauncherBaseUrlSchema,
  runtimeLauncherCapabilitiesSchema,
  runtimeLauncherDescriptorSchema,
  validateRuntimeLauncherDelivery,
} from "../src/shared/contracts/runtime-launcher.js";
import { runtimeExecutionEvidenceSchema } from '../src/contracts.js';
import { runtimeCaseRequestSchema, runtimeInstanceStateSchema } from '../src/runtime-launcher.js';

async function readExample(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`../contracts/runtime-launcher/examples/${name}`, import.meta.url), "utf8"));
}

it("accepts a matching Builder-delivered Launcher descriptor and capabilities response", async () => {
  const descriptor = await readExample("launcher-descriptor.success.json");
  const capabilities = await readExample("builder-capabilities.json");

  expect(runtimeLauncherDescriptorSchema.parse(descriptor)).toMatchObject({
    deploymentId: "builder-job-01-runtime",
    baseUrl: "https://runtime.example.test/deployments/builder-job-01-runtime/",
    authentication: { type: "bearer" },
  });
  expect(runtimeLauncherCapabilitiesSchema.parse(capabilities).defaultModelId).toBe("execution");
  expect(validateRuntimeLauncherDelivery(descriptor, capabilities)).toEqual([]);
});

it("normalizes local URLs and rejects unsafe remote Launcher URLs", () => {
  expect(runtimeLauncherBaseUrlSchema.parse("http://127.0.0.1:56362/runtime")).toBe("http://127.0.0.1:56362/runtime/");
  expect(() => runtimeLauncherBaseUrlSchema.parse("http://runtime.example.test/")).toThrow(/requires HTTPS/u);
  expect(() => runtimeLauncherBaseUrlSchema.parse("https://user:secret@runtime.example.test/")).toThrow(/invalid/u);
  expect(() => runtimeLauncherBaseUrlSchema.parse("https://runtime.example.test/?token=secret")).toThrow(/invalid/u);
});

it("detects delivery drift and requires observability for new Builder deliveries", async () => {
  const descriptor = await readExample("launcher-descriptor.success.json") as Record<string, unknown>;
  const capabilities = await readExample("builder-capabilities.json") as Record<string, unknown>;
  expect(validateRuntimeLauncherDelivery({ ...descriptor, capabilitiesDigest: "0".repeat(64) }, capabilities)).toContain("CAPABILITIES_DIGEST_MISMATCH");

  const runtime = capabilities.runtime as Record<string, unknown>;
  const { observability: _observability, ...legacyCapabilities } = capabilities;
  expect(validateRuntimeLauncherDelivery(descriptor, { ...legacyCapabilities, runtime: { ...runtime, version: "2.0.0" } })).toEqual(expect.arrayContaining([
    "RUNTIME_VERSION_MISMATCH",
    "CAPABILITIES_DIGEST_MISMATCH",
    "OBSERVABILITY_NOT_DECLARED",
  ]));
});

it("publishes strict JSON Schemas for the Launcher delivery boundary", async () => {
  for (const name of ["finance.runtime-launcher-descriptor.v1.schema.json", "finance.skill-eval.runtime-capabilities.v1.schema.json", "finance.skill-eval.runtime-instance.v1.schema.json", "finance.skill-eval.runtime-instance-state.v1.schema.json", "finance.skill-eval.runtime-case.v1.schema.json", "finance.skill-eval.runtime-evidence.v1.schema.json"]) {
    const schema = JSON.parse(await readFile(new URL(`../contracts/runtime-launcher/${name}`, import.meta.url), "utf8"));
    expect(schema).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: name.replace(".schema.json", "") });
  }
});

it('ships one complete Runtime Launcher lifecycle example',async()=>{
  const instance=await readExample('instance.create.json') as {schemaVersion?:string};
  expect(instance.schemaVersion).toBe('finance.skill-eval.runtime-instance.v1');
  expect(runtimeInstanceStateSchema.parse(await readExample('instance.ready.json')).status).toBe('ready');
  expect(runtimeCaseRequestSchema.parse(await readExample('case.execute.json')).workspaceFiles).toHaveLength(1);
  expect(runtimeExecutionEvidenceSchema.parse(await readExample('execution.evidence.json')).runtimeIdentityVerified).toBe(true);
});
