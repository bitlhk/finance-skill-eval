import {useEffect, useId, useState} from 'react';

let renderer:Promise<typeof import('mermaid')['default']>|undefined;
function loadRenderer() {
  return renderer??=import('mermaid').then(({default:mermaid})=>{
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral',maxTextSize:20000,maxEdges:100,
      suppressErrorRendering:true});
    return mermaid;
  });
}

export default function MermaidDiagram({source}:{source:string}) {
  const id=useId().replace(/[^a-zA-Z0-9]/g,'');
  const [svg,setSvg]=useState<string|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    let active=true;setSvg(null);setFailed(false);
    if(source.length>20000){setFailed(true);return;}
    void loadRenderer().then(mermaid=>mermaid.render('diagram'+id,source)).then(result=>{
      if(active)setSvg(result.svg);
    }).catch(()=>{if(active)setFailed(true);});
    return ()=>{active=false;};
  },[id,source]);
  if(failed)return <div><p>流程图暂时无法显示，以下是原始内容：</p><pre><code>{source}</code></pre></div>;
  if(!svg)return <p role="status">正在生成流程图…</p>;
  const viewBox=svg.match(/\bviewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/i);
  const width=Number(viewBox?.[1]),height=Number(viewBox?.[2]);
  const ratio=width>0&&height>0?Math.max(0.2,Math.min(10,width/height)):1.5;
  const document=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>html,body{margin:0;background:transparent}svg{max-width:100%;height:auto}</style></head><body>${svg}</body></html>`;
  return <iframe className="work-product-diagram" title="方案流程图" sandbox="" srcDoc={document} style={{aspectRatio:String(ratio)}}/>;
}
