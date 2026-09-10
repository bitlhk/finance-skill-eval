import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useDeferredValue } from "react";
import remend from "remend";

function jsonAsMarkdown(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return source;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    }
    const value = parsed as Record<string, unknown>;
    const title = typeof value.title === "string" ? `### ${value.title}\n\n` : "";
    const summary = typeof value.summary === "string" ? `${value.summary}\n\n` : "";
    const sections = Array.isArray(value.sections)
      ? value.sections.map(section => {
        if (!section || typeof section !== "object") return "";
        const record = section as Record<string, unknown>;
        const heading = typeof record.heading === "string" ? `#### ${record.heading}\n` : "";
        const items = Array.isArray(record.items)
          ? record.items.map(item => `- ${String(item)}`).join("\n")
          : "";
        return `${heading}${items}`.trim();
      }).filter(Boolean).join("\n\n")
      : "";
    if (title || summary || sections) return `${title}${summary}${sections}`.trim();
    return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  } catch {
    return source;
  }
}

export const MarkdownContent = memo(function MarkdownContent({ content, compact = false, streaming = false }: { content: string; compact?: boolean; streaming?: boolean }) {
  const deferred = useDeferredValue(content);
  let source = jsonAsMarkdown(streaming ? deferred : content);
  if (streaming) {
    const lines = source.split("\n");
    const last = lines.at(-1) ?? "";
    if (last.trimStart().startsWith("|") && !last.trimEnd().endsWith("|")) { lines.pop(); source = lines.join("\n"); }
    source = remend(source, { inlineKatex: false });
  }
  return <div className={compact ? "markdown-content compact" : "markdown-content"}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        img: ({ alt }) => <span>{alt ?? "图片"}</span>,
      }}
    >
      {source}
    </ReactMarkdown>
  </div>;
});
