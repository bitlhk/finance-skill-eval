// Local, tool-free contract check. Reuse the service schemas instead of maintaining
// a second Python interpretation of the proposal and delivery format.
import {analysisSchema,migrationPlanSchema,deliverySchema} from '../../dist/migration/tasks/domain/task-model.js';
import {taskDiagnosisSchema} from '../../dist/migration/tasks/domain/task-diagnosis.js';
import {standardizationSchema,standardizationIssues,conformanceSchema} from '../../dist/migration/tasks/domain/task-standardization.js';
let input='';
process.stdin.setEncoding('utf8');
for await(const chunk of process.stdin)input+=chunk;
try {
  const {mode,result,files}=JSON.parse(input);
  const field=mode==='ANALYZE'?'analysis':mode==='REVIEW'?'review':'delivery';
  const schema=mode==='ANALYZE'?analysisSchema.extend({plan:migrationPlanSchema,diagnosis:taskDiagnosisSchema,standardization:standardizationSchema}):mode==='REVIEW'?conformanceSchema:deliverySchema;
  const parsed=schema.safeParse(result[field]);
  const errors=parsed.success?(mode==='ANALYZE'?standardizationIssues(parsed.data,files):[]):parsed.error.issues.map(issue=>issue.path.join('.')+': '+issue.message);
  process.stdout.write(JSON.stringify({accepted:errors.length===0,errors:errors.slice(0,16),issueCount:errors.length}));
} catch {
  process.stdout.write(JSON.stringify({accepted:false,errors:['Local result contract validation failed']}));
  process.exitCode=1;
}
