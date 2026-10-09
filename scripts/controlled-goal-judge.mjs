/** Loopback transport oracle, deliberately never a professional-quality verdict. */
import assert from 'node:assert/strict';
import http from 'node:http';

export async function controlledGoalJudge() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      const input = JSON.parse(request.messages.find(message => message.role === 'user').content);
      assert(Array.isArray(input.criteria) && input.criteria.length > 0);
      calls.push(input);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({model: 'controlled-judge', choices: [{message: {role: 'assistant', content: JSON.stringify({
        checks: input.criteria.map(row => ({criterionIndex: row.criterionIndex, verdict: 'INDETERMINATE',
          reason: 'Controlled transport fixture; professional quality not evaluated.', evidence: ''}))})}}]}));
    } catch (error) {res.writeHead(500); res.end(JSON.stringify({error: String(error)}));}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {FINANCE_EVAL_JUDGE_PROVIDER: 'openai_compatible',
    FINANCE_EVAL_JUDGE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    FINANCE_EVAL_JUDGE_API_KEY: 'controlled-test-only', FINANCE_EVAL_JUDGE_MODEL: 'controlled-judge', FINANCE_EVAL_JUDGE_REQUEST_DEFAULTS: '{}'};
  const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  return {calls, async close() {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }};
}
