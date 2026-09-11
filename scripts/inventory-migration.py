"""Static, non-executing inventory for a privately extracted customer package."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re


def inventory(root):
    entries=[]
    total=0
    for file in sorted(root.rglob('*')):
        if file.is_symlink(): raise ValueError('LINK_NOT_ALLOWED')
        if not file.is_file(): continue
        size=file.stat().st_size; total+=size
        if total>16*1024*1024 or len(entries)>=200: raise ValueError('INVENTORY_LIMIT')
        raw=file.read_bytes()
        entry={'path':file.relative_to(root).as_posix(),'size':size,'sha256':hashlib.sha256(raw).hexdigest()}
        if file.suffix=='.py':
            tree=ast.parse(raw,filename=file.name)
            entry['imports']=[{'module':n.module,'names':[a.name for a in n.names],'level':n.level} for n in ast.walk(tree) if isinstance(n,ast.ImportFrom)]
            entry['definitions']=[n.name for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef))]
            entry['topLevelCallCount']=sum(isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) for n in tree.body)
        if file.name.lower()=='skill.md':
            text=raw.decode('utf-8')
            entry['canonicalFilename']=file.name=='SKILL.md'
            entry['openingFrontmatterMarker']=text.startswith('---\n') or text.startswith('---\r\n')
            refs=set(re.findall(r'`((?:references?|scripts)/[^`]+)`',text))
            entry['missingRelativeReferences']=[r for r in sorted(refs) if not (file.parent/r).is_file()]
        entries.append(entry)
    return {'mode':'STATIC_INVENTORY','files':entries,'bytes':total,'scriptsExecuted':False,
            'nativeRuntimeVerified':False,'businessAcceptance':'NOT_RUN'}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args(); result=inventory(a.input.resolve())
    with a.output.open('x') as out: json.dump(result,out,ensure_ascii=False,indent=2)
