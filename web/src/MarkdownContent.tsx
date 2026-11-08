import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isValidElement, lazy, memo, Suspense, useDeferredValue, type ReactNode } from "react";
import remend from "remend";

const MermaidDiagram=lazy(()=>import('./MermaidDiagram'));

function jsonAsMarkdown(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return source;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    }
    const value = parsed as Record<string, unknown>;
    const hasExtra=Object.keys(value).some(key=>!['title','summary','sections'].includes(key));
    const sectionsAreSimple=value.sections===undefined||Array.isArray(value.sections)&&value.sections.every(section=>{
      if(!section||typeof section!=='object'||Array.isArray(section))return false;
      const item=section as Record<string,unknown>;
      return Object.keys(item).every(key=>['heading','items'].includes(key))&&
        (item.heading===undefined||typeof item.heading==='string')&&
        (item.items===undefined||Array.isArray(item.items)&&item.items.every(element=>typeof element==='string'));
    });
    if(hasExtra||!sectionsAreSimple||(value.title!==undefined&&typeof value.title!=='string')||(value.summary!==undefined&&typeof value.summary!=='string'))
      return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
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

export const MarkdownContent = memo(function MarkdownContent({ content, compact = false, streaming = false,formatJson=true }: { content: string; compact?: boolean; streaming?: boolean;formatJson?:boolean }) {
  const deferred = useDeferredValue(content);
  const value=streaming ? deferred : content;
  let source = formatJson?jsonAsMarkdown(value):value;
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
        pre: ({children}) => {
          if(!streaming&&isValidElement<{className?:string;children?:ReactNode}>(children)
            &&children.props.className?.split(/\s+/).includes('language-mermaid')&&typeof children.props.children==='string'){
            const diagram=children.props.children.replace(/\n$/, '');
            return <Suspense fallback={<pre><code>{diagram}</code></pre>}><MermaidDiagram source={diagram}/></Suspense>;
          }
          return <pre>{children}</pre>;
        },
      }}
    >
      {source}
    </ReactMarkdown>
  </div>;
});
