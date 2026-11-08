"""Opt-in bounded availability probe through the configured SDK model adapter."""
import asyncio
import json
import os
import time


async def main():
    if os.getenv('FINANCE_TEST_REAL_AGENT') != '1':
        raise SystemExit('FINANCE_TEST_REAL_AGENT=1 is required')
    from integrations.openjiuwen.worker import config
    from integrations.openjiuwen.model_config import create_model, request_settings
    from openjiuwen.core.foundation.llm.schema.message import UserMessage
    binding = config()['models']['enterprise-model']
    settings = request_settings(binding, 'enterprise-model')
    model = create_model(binding, settings, role='EXECUTION', timeout_ms=30000, max_tokens=32,
                         defaults=json.loads(os.getenv('FINANCE_EVAL_EXECUTION_REQUEST_DEFAULTS', '{}')))
    start = time.monotonic()
    try:
        async with asyncio.timeout(40):
            result = await model.invoke([UserMessage(content='只回答 OK')])
        print(json.dumps({'status': 'responded', 'model': settings['model_name'],
            'characters': len(result.content or ''), 'elapsedSeconds': round(time.monotonic()-start, 1)}))
    except Exception as error:
        print(json.dumps({'status': 'unavailable', 'errorType': type(error).__name__,
            'httpStatus': getattr(error, 'status_code', None), 'elapsedSeconds': round(time.monotonic()-start, 1)}))


if __name__ == '__main__':
    asyncio.run(main())
