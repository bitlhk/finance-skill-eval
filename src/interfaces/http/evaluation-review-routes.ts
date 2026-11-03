import type {FastifyInstance} from 'fastify';
import type {HumanReviewStore} from '../../service/human-review-store.js';
import {reviewSourceSchema} from '../../evaluation/domain/human-review.js';

export function registerEvaluationReviewRoutes(app:FastifyInstance,store:HumanReviewStore,enabled:boolean){
  const authorize=async(_request:unknown,reply:{code(n:number):{send(value:unknown):unknown}})=>{
    if(!enabled)return reply.code(403).send({message:'人工复核仅限私有工作区'});
  };
  app.get('/api/evaluation-reviews',{preHandler:authorize},request=>store.get(reviewSourceSchema.parse(request.query)));
  app.post('/api/evaluation-reviews',{preHandler:authorize},request=>store.append(request.body));
}
