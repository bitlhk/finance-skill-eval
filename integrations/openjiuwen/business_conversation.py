"""User-turn boundaries on one SDK Agent, session, tools and workspace."""
from tasks.values import fingerprint


async def execute_turns(agent, case, session_id, workspace_id, tool_calls, event, redact, progress):
    turns = case.get('turns') or [{'query': case['prompt']}]
    progress.update(turns=[], output='', usage=None)
    multi = bool(case.get('turns'))
    if multi:
        progress['conversation'] = {'sessionId': session_id, 'workspaceId': workspace_id, 'turns': progress['turns']}
    for index, turn in enumerate(turns):
        offset, output = len(tool_calls), ''
        event('status', text=f'执行第 {index + 1}/{len(turns)} 轮' if multi else '执行业务任务')
        async for chunk in agent.stream({'query': turn['query'], 'conversation_id': session_id}):
            data = chunk.model_dump() if hasattr(chunk, 'model_dump') else chunk
            if not isinstance(data, dict):
                continue
            payload = data.get('payload', {})
            if data.get('type') == 'llm_output':
                text = payload.get('content', '')
                if isinstance(text, str):
                    output += text
                    event('text_delta', text=text)
            elif data.get('type') == 'llm_usage':
                tokens = payload.get('usage_metadata', {})
                usage = progress['usage'] = progress['usage'] or {'inputTokens': 0, 'outputTokens': 0, 'totalTokens': 0}
                usage['inputTokens'] += tokens.get('input_tokens', 0)
                usage['outputTokens'] += tokens.get('output_tokens', 0)
                usage['totalTokens'] = usage['inputTokens'] + usage['outputTokens']
            elif data.get('type') == 'answer' and isinstance(payload, dict):
                final = payload.get('output', payload.get('content'))
                if isinstance(final, str):
                    output = final
            if isinstance(payload, dict) and payload.get('result_type') == 'error':
                raise RuntimeError(str(payload.get('output') or payload.get('content') or 'Runtime error')[:400])
        if not output.strip():
            raise RuntimeError('Model returned no answer')
        output = redact(output)
        progress['turns'].append({'index': index, 'queryDigest': fingerprint(turn['query']), 'status': 'completed',
            'output': output, 'outputDigest': fingerprint(output),
            'toolNames': [call['name'] for call in tool_calls[offset:] if call['status'] == 'completed']})
        progress['output'] = ('\n\n'.join(f'Turn {i+1}:\n' + item['output'] for i, item in enumerate(progress['turns'])) if multi else output)
    return progress
