import { describe, expect, it } from "vitest";
import { candidateFiles } from "../src/service/optimization-manager.js";
import { loadEvalPack } from "../src/eval-pack.js";

const files = { "SKILL.md": "---\nname: test-skill\nversion: 1.0.0\n---\n\nOriginal", "references/sop.md": "Original SOP" };
describe("bounded candidate generation", () => {
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
    expect(() => candidateFiles(files, [{ path: "SKILL.md", content: files["SKILL.md"].replace("test-skill", "other-skill") }], "candidate")).toThrow(/identity/);
  });
  it("loads holdout independently of development cases", async () => {
    const pack = await loadEvalPack("packs/finance/wealth-online/eval.yaml");
    expect(pack.cases).toHaveLength(2);
    expect(pack.cases.every(c => !c.caseId.startsWith("HOLDOUT-"))).toBe(true);
    expect(pack.holdoutCases).toHaveLength(1);
    expect(pack.holdoutCases![0]!.replay).toBeUndefined();
  });
});
