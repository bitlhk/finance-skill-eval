import {z} from 'zod';
import type {EvaluationPlan} from '../domain/evaluation-plan.js';
import {citedCheckSchema,evidenceResources,readEvidencePointer,validateCitations} from '../domain/evidence-resources.js';
import {canonicalSha256} from '../../shared/json-canonicalization.js';
import {runVerificationScript} from '../infrastructure/script-verifier.js';
import type {EvaluationMethod} from './evaluation-method.js';

export function plannedMethods(plan:EvaluationPlan|undefined,execute=runVerificationScript):EvaluationMethod[]{
  return (plan?.checks??[]).map(check=>({id:'plan:'+check.id,version:check.version,kind:check.kind,timeoutMs:check.timeoutMs,
    async evaluate({evidence,signal}){
      const resources=evidenceResources(evidence);
      const required=[...check.evidenceRefs,...(check.rule?[check.rule.reference]:[])];
      if(required.some(ref=>readEvidencePointer(resources,ref)===undefined||readEvidencePointer(resources,ref)===null))
        return [{id:check.id,status:'UNVERIFIED',reason:'Required evidence is unavailable',evidenceRefs:[]}];
      if(check.rule){
        const actual=readEvidencePointer(resources,check.rule.reference),rule=check.rule;
        let passed=false;
        switch(rule.operation){
          case 'exists':passed=true;break;
          case 'equals':passed=canonicalSha256(actual)===canonicalSha256(rule.expected);break;
          case 'contains':passed=typeof actual==='string'&&actual.includes(rule.expected);break;
          case 'numeric_tolerance':passed=typeof actual==='number'&&Number.isFinite(actual)&&Math.abs(actual-rule.expected)<=Math.max(rule.absoluteTolerance,rule.relativeTolerance*Math.abs(rule.expected));break;
          case 'set_equals':{
            const expected=new Set(rule.expected.map(value=>canonicalSha256(value)));
            passed=Array.isArray(actual)&&actual.every(value=>['string','number','boolean'].includes(typeof value))
              &&new Set(actual.map(value=>canonicalSha256(value))).size===expected.size&&actual.every(value=>expected.has(canonicalSha256(value)));
            break;
          }
        }
        return [{id:check.id,status:passed?'PASS':'FAIL',reason:`${rule.operation}: ${rule.reference}`,evidenceRefs:[rule.reference]}];
      }
      const result=z.strictObject({checks:z.array(citedCheckSchema).min(1).max(64)}).parse(await execute(check.script!,resources,signal,check.timeoutMs));
      return validateCitations(result.checks,resources);
    },
  }));
}
