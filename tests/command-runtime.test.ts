import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRuntimeAdapter, type RuntimeExecutionRequest } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("CommandRuntimeAdapter", () => {
  it("maps a command execution result into canonical runtime evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "finance-command-runtime-test-"));
    directories.push(directory);
    const adapter = new CommandRuntimeAdapter({
      adapterId: "test-command-runtime",
      command: process.execPath,
      cwd: directory,
      argumentsFor: ({ promptFile, outputFile }) => [
        "-e",
        [
          "const fs=require('node:fs');",
          "const prompt=fs.readFileSync(process.argv[1],'utf8').trim();",
          "fs.writeFileSync(process.argv[2], JSON.stringify({",
          "schemaVersion:'test.execution.v1',caseId:'RR-TEST-001',variant:'with-domain',",
          "modelId:'test-model',output:prompt,elapsedMs:12,",
          "toolCalls:[{name:'fraud_transfer_risk_assess',status:'completed'}],",
          "loadedSkills:[{skillId:'transfer-risk-review',version:'0.1.0'}],",
          "runtimeIdentityVerified:true,streamCompleted:true,solutionId:'test-solution'",
          "}));",
        ].join(""),
        promptFile,
        outputFile,
      ],
    });

    const evidence = await adapter.execute(request());

    expect(evidence.status).toBe("completed");
    expect(evidence.output).toBe("审核测试提示");
    expect(evidence.skillVersion).toBe("0.1.0");
    expect(evidence.toolCalls).toEqual([
      { name: "fraud_transfer_risk_assess", status: "completed" },
    ]);
    expect(evidence.traceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.metadata.solutionId).toBe("test-solution");
  });
});

function request(): RuntimeExecutionRequest {
  return {
    runId: "run-001",
    side: "right",
    evalCase: {
      caseId: "RR-TEST-001",
      name: "测试",
      taskMode: "single_turn",
      prompt: "审核测试提示",
      evaluationGoal: "验证 command adapter",
      requiredTools: ["fraud_transfer_risk_assess"],
      rubric: [{
        criterionId: "risk",
        label: "风险",
        description: "风险",
        dimension: "professional_fit",
        weight: 1,
        required: true,
        allOf: [],
        anyOf: ["审核"],
        noneOf: [],
      }],
    },
    model: {
      providerId: "test",
      modelId: "test-model",
      parameters: {},
    },
    variant: {
      mode: "skill_version",
      skillId: "transfer-risk-review",
      version: "0.1.0",
    },
  };
}
