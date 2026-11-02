export class EvaluationCancelledError extends Error {
  constructor(message='Evaluation cancelled'){
    super(message);
    this.name='EvaluationCancelledError';
  }
}
