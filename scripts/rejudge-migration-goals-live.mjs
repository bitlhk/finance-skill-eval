import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ModelGoalJudge} from '../dist/goal-judge.js';
import {OpenAiCompatibleModelAdapter} from '../dist/openai-compatible-model.js';
import {simpleMigrationCases} from '../dist/service/simple-migration-suite.js';
const directory=path.resolve(process.argv[2]);
const job=JSON.parse(await readFile(path.join(directory,'job.json'),'utf8'));
const evalCases=simpleMigrationCases(JSON.parse(await readFile(path.join(directory,'test-suite.json'),'utf8')));
const config=JSON.parse(await readFile('.runtime.local.json','utf8'));
const [,binding]=Object.entries(config.models).find(([,m])=>m.enabled!==false);
const adapter=new OpenAiCompatibleModelAdapter({apiKey:binding.apiKey,baseUrl:binding.baseUrl,requestDefaults:binding.extraBody??{}});
const judge=new ModelGoalJudge(adapter,{providerId:'service-judge',modelId:binding.upstreamModelId,parameters:{}});
const cases=[];
for(const result of job.report.cases){
 const evalCase=evalCases.find(c=>c.caseId===result.caseId);
 try{const assessment=await judge.compare({evalCase,left:result.left,right:result.right});cases.push({caseId:result.caseId,assessment:assessment.goalAssessment});}
 catch(error){cases.push({caseId:result.caseId,error:String(error).replaceAll(binding.apiKey,'[redacted]')});}
 console.log(JSON.stringify(cases.at(-1)));
}
await writeFile(path.join(directory,'real-model-reassessment.json'),JSON.stringify({judgeId:judge.judgeId,source:'原真实 Runtime 输出，未改动',cases},null,2));
