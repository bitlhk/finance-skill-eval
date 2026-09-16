import { describe, expect, it } from "vitest";
import { candidateFiles, optimizationRerunBindings } from "../src/service/optimization-manager.js";
import { runConfigurationSchema } from '../src/service/contracts.js';
import type { SkillAssetRecord } from '../src/service/skill-store.js';
import { loadEvalPack } from "../src/eval-pack.js";

const files = { "SKILL.md": "---\nname: test-skill\nversion: 1.0.0\n---\n\nOriginal", "references/sop.md": "Original SOP" };
describe("bounded candidate generation", () => {
  it('rebinds both optimization sides to the target Runtime and exact current/candidate assets',()=>{
    const configuration=runConfigurationSchema.parse({packId:'p',runtime:{type:'runtime_http',environmentId:'a'},
      runtimeBindings:{left:{environmentId:'a',skillAssetId:'source'},right:{environmentId:'b',skillAssetId:'normalized'}},
      executionModel:{providerId:'p',modelId:'m'},leftVariant:{mode:'skill_version',skillId:'s',version:'1'},rightVariant:{mode:'skill_version',skillId:'s',version:'2'}});
    const result=optimizationRerunBindings(configuration,{assetId:'normalized'} as SkillAssetRecord,{assetId:'optimized'} as SkillAssetRecord);
    expect(result.runtimeBindings).toEqual({left:{environmentId:'b',skillAssetId:'normalized'},right:{environmentId:'b',skillAssetId:'optimized'}});
    expect(configuration.runtimeBindings!.right.skillAssetId).toBe('normalized');
  });
  it("preserves original files and locks a distinct candidate version", () => {
    const next = candidateFiles(files, [{ path: "references/sop.md", content: "Improved SOP" }], "1.0.0-candidate.abc");
    expect(next["SKILL.md"]).toContain("version: 1.0.0-candidate.abc");
    expect(files["references/sop.md"]).toBe("Original SOP");
    expect(next["references/sop.md"]).toBe("Improved SOP");
  });
  it.each(["../SKILL.md", "references/../../.env", "script.py", "references/sop.md/../../host.md"])("rejects unsafe or executable edit %s", path => {
    expect(() => candidateFiles(files, [{ path, content: "x" }], "candidate")).toThrow();
  });
  it("does not let optimizer change Skill identity", () => {
    expect(() => candidateFiles(files, [{ path: "SKILL.md", content: files["SKILL.md"].replace("test-skill", "other-skill") }], "candidate")).toThrow(/身份/);
  });
  it("loads holdout independently of development cases", async () => {
    const pack = await loadEvalPack("packs/finance/wealth-online/eval.yaml");
    expect(pack.cases).toHaveLength(2);
    expect(pack.cases.every(c => !c.caseId.startsWith("HOLDOUT-"))).toBe(true);
    expect(pack.holdoutCases).toHaveLength(1);
    expect(pack.holdoutCases![0]!.replay).toBeUndefined();
  });
});
