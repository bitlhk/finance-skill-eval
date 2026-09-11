/** Parse the first complete JSON object from a model response. */
export function parseFirstJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Model responses may wrap JSON in Markdown or append a short explanation.
  }

  const sources = [
    ...Array.from(raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu), match => match[1] ?? ""),
    raw,
  ];
  for (const source of sources) {
    for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
      const candidate = completeObjectAt(source, start);
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // A nested object may begin here; continue scanning for the next one.
      }
    }
  }
  throw new SyntaxError("Model response does not contain a complete JSON object");
}

function completeObjectAt(source: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const expected = character === "}" ? "{" : "[";
    if (stack.pop() !== expected) return null;
    if (stack.length === 0) return source.slice(start, index + 1);
  }
  return null;
}
