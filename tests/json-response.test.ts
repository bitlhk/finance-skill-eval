import { describe, expect, it } from "vitest";
import { parseFirstJsonObject } from "../src/json-response.js";

describe("model JSON response parsing", () => {
  it("accepts JSON followed by model commentary", () => {
    expect(parseFirstJsonObject('{"status":"ready","items":[{"value":"}"}]}\n说明完毕')).toEqual({
      status: "ready",
      items: [{ value: "}" }],
    });
  });

  it("accepts a fenced object after reasoning text", () => {
    expect(parseFirstJsonObject('分析如下：\n```json\n{"status":"ready"}\n```')).toEqual({
      status: "ready",
    });
  });
});
