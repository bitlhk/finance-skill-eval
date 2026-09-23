import {it,expect} from 'vitest';
import {analyzeDependencies} from '../src/migration/infrastructure/migration-dependencies.js';
import {verifyDependencyLibrary} from '../src/service/dependency-library.js';
import {inspectionFixture,toolFixture} from './analysis-fixture.js';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DiagnosisStep} from '../web/src/DiagnosisStep.js';

const inventory={python:{version:'3.12.11',standardModules:['json','decimal','pathlib','sys']}};
it('shows standard libraries without SDK upload and retains the missing enterprise SDK editor',()=>{
 const tool=toolFixture({name:'lookup',sourcePaths:['tool.py']});
 const dep={id:'stdlib',key:'decimal',name:'decimal',kind:'SDK',owner:'TOOL',action:'KEEP',contractStatus:'KNOWN',toolIds:[tool.toolId],purpose:'金额计算',availability:'AVAILABLE',provided:'NONE',blocking:true,evidence:[],resolvedPaths:[],schema:null,schemaCompleteness:'UNKNOWN',library:{type:'STANDARD_LIBRARY',language:'python',module:'decimal',verified:true,environmentVersion:'3.12.11'}};
 const props={api:async()=>({}),projectId:'migration-1234',analysis:{status:'COMPLETE',revision:0,materialsDigest:'digest',rejectedClaims:0,chains:[],dependencies:[dep]},tools:[tool],choices:{},choose:()=>{},busy:false,refresh:async()=>{},inspect:()=>{},next:()=>{}} as any;
 const html=renderToStaticMarkup(createElement(DiagnosisStep,props));
 expect(html).toContain('语言环境提供，无需补充');expect(html).not.toContain('上传 SDK 源码');
 props.analysis.dependencies=[{...dep,id:'sdk',key:'auth_sdk',name:'鉴权 SDK',availability:'MISSING',library:{type:'CUSTOM_SDK',language:'python',module:'auth_sdk'}}];
 expect(renderToStaticMarkup(createElement(DiagnosisStep,props))).toContain('上传 SDK 源码或 ZIP 包');
 props.analysis.dependencies=[{...dep,id:'config',key:'department_config',name:'部门配置',kind:'CONFIG',availability:'MISSING',library:undefined}];
 const configHtml=renderToStaticMarkup(createElement(DiagnosisStep,props));
 expect(configHtml).toContain('补充配置模块源码');expect(configHtml).toContain('保存数据');
});
it('confirms a cited standard import without a package-owned implementation',()=>{
 const inspection=inspectionFixture([toolFixture({name:'lookup',sourcePaths:['tool.py']})]);
 const ref={toolName:'lookup',path:'tool.py',snippet:'from decimal import Decimal'};
 const payload={dependencyAnalysis:{dependencies:[{key:'decimal',name:'decimal',kind:'SDK',owner:'TOOL',action:'KEEP',contractStatus:'KNOWN',purpose:'精确计算',blocking:true,availability:'AVAILABLE',library:{type:'STANDARD_LIBRARY',language:'python',module:'decimal'},references:[ref],resolvedPaths:[]}],chains:[{toolName:'lookup',nodes:[{id:'decimal',title:'金额',detail:'金额计算',dependencyKeys:['decimal'],evidence:[ref]}]}]}};
 const result=analyzeDependencies(payload,inspection,{'tool.py':'from decimal import Decimal\n'},[],0,'digest',undefined,inventory);
 expect(result.status).toBe('COMPLETE');expect(result.dependencies[0]!.availability).toBe('AVAILABLE');expect(result.dependencies[0]!.library?.verified).toBe(true);
 const shadow=analyzeDependencies(payload,inspection,{'tool.py':'from decimal import Decimal\n','decimal.py':'class Decimal: pass'},[],0,'digest',undefined,inventory);
 expect(shadow.status).toBe('PARTIAL');expect(shadow.dependencies[0]!.library?.type).toBe('UNKNOWN');
 const absent=analyzeDependencies(payload,inspection,{'tool.py':'from decimal import Decimal\n'},[],0,'digest');expect(absent.status).toBe('PARTIAL');
 const nullable=structuredClone(payload) as any;
 Object.assign(nullable.dependencyAnalysis.dependencies[0].library,{packageName:null,version:null,declarationPaths:null});
 expect(analyzeDependencies(nullable,inspection,{'tool.py':'from decimal import Decimal\n'},[],0,'digest',undefined,inventory).status).toBe('COMPLETE');
 nullable.dependencyAnalysis.dependencies[0].library=null;
 expect(analyzeDependencies(nullable,inspection,{'tool.py':'from decimal import Decimal\n'},[],0,'digest',undefined,inventory).status).toBe('PARTIAL');
 nullable.dependencyAnalysis.dependencies[0].library={type:'UNKNOWN',language:null,module:null};
 expect(analyzeDependencies(nullable,inspection,{'tool.py':'from decimal import Decimal\n'},[],0,'digest',undefined,inventory).status).toBe('PARTIAL');
});

it('verifies Node builtins and refuses fake standard modules or unrelated import citations',()=>{
 const claim={type:'STANDARD_LIBRARY' as const,language:'node' as const,module:'node:fs'};
 expect(verifyDependencyLibrary(claim,[{path:'tool.mjs',snippet:"import fs from 'node:fs';"}],{})?.verified).toBe(true);
 expect(verifyDependencyLibrary({...claim,module:'enterprise-sdk'},[{path:'tool.mjs',snippet:"import sdk from 'enterprise-sdk';"}],{})?.type).toBe('UNKNOWN');
 expect(verifyDependencyLibrary(claim,[{path:'tool.mjs',snippet:'query(account_id);'}],{})?.verified).toBe(false);
});

it('uses actual package metadata constraints and requires cited declarations',()=>{
 const py={'tool.py':'import requests\n','pyproject.toml':'[project]\ndependencies = ["requests>=2.32,<3"]'};
 const refs=Object.entries(py).map(([path,snippet])=>({path,snippet}));
 const claim={type:'PACKAGE' as const,language:'python' as const,module:'requests',packageName:'requests',version:'invented',declarationPaths:['pyproject.toml']};
 expect(verifyDependencyLibrary(claim,refs,py,inventory)).toMatchObject({verified:true,version:'>=2.32,<3'});
 expect(verifyDependencyLibrary(claim,[refs[0]!],py,inventory)?.verified).toBe(false);
 expect(verifyDependencyLibrary(claim,refs,{'tool.py':py['tool.py'],'pyproject.toml':'[project]\nname = "requests"'},inventory)?.verified).toBe(false);
 expect(verifyDependencyLibrary({...claim,packageName:'numpy'},refs,py,inventory)?.verified).toBe(false);
 const files={'tool.mjs':"import sdk from 'example-sdk';",'package.json':'{"dependencies":{"example-sdk":"^1.2.0"}}'};
 expect(verifyDependencyLibrary({type:'PACKAGE',language:'node',module:'example-sdk',packageName:'example-sdk',declarationPaths:['package.json']},Object.entries(files).map(([path,snippet])=>({path,snippet})),files)).toMatchObject({verified:true,version:'^1.2.0'});
});
