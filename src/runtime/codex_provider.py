"""Keep the optional host CLI provider inside Jiuwen's model-client SPI."""

import os


from openjiuwen.core.foundation.llm.model_clients.openai_model_client import OpenAIModelClient
from openjiuwen.core.foundation.llm.schema.message import AssistantMessage, UsageMetadata
from openjiuwen.core.foundation.llm.schema.message_chunk import AssistantMessageChunk

from .models import CodexCLIModel


class CodexModelClient(OpenAIModelClient):
    __client_name__ = 'FinanceCodex'

    async def invoke(self, messages, *, tools=None, model=None, timeout=None, **kwargs):
        from integrations.openjiuwen.model_tool_protocol import text_tool_input, text_tool_output
        values, definitions = text_tool_input(messages, tools)
        adapter = CodexCLIModel({'executable': os.environ.get('FINANCE_EVAL_CODEX_BIN') or 'codex',
                                'timeoutMs': (timeout or self.model_client_config.timeout) * 1000})
        result = await adapter.complete({'model': {'modelId': model or self.model_config.model}, 'messages': values})
        data = result.get('usage') or {}
        usage = UsageMetadata(model_name=result['modelId'], input_tokens=data.get('inputTokens', 0),
                              output_tokens=data.get('outputTokens', 0), total_tokens=data.get('totalTokens', 0))
        return text_tool_output(AssistantMessage(content=result['content'], finish_reason='stop', usage_metadata=usage), definitions)

    async def stream(self, messages, **kwargs):
        response = await self.invoke(messages, **kwargs)
        yield AssistantMessageChunk(**response.model_dump())


def register_codex_provider():
    # Importing the subclass registers it through BaseModelClient.__init_subclass__.
    return CodexModelClient
