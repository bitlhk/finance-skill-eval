import unittest
from unittest.mock import AsyncMock, patch
from .model_config import resolve_model, request_settings, bind_agent_request_extensions


class ModelConfigTests(unittest.TestCase):
    def test_role_tool_compatibility_does_not_change_other_roles_or_explicit_binding(self):
        from types import SimpleNamespace
        from .model_config import create_model
        binding={'apiKey':'fixture','baseUrl':'https://fixture.invalid/v1'}
        model=SimpleNamespace(invoke=AsyncMock(),stream=AsyncMock())
        with patch.dict('os.environ',{'FINANCE_EVAL_MIGRATION_NATIVE_TOOLS':'false',
                                      'FINANCE_EVAL_EXECUTION_NATIVE_TOOLS':'true'}), \
             patch('openjiuwen.core.foundation.llm.init_model',return_value=model), \
             patch('integrations.openjiuwen.model_tool_protocol.bind_text_tools',side_effect=lambda value:value) as compatibility:
            create_model(binding,{'model_name':'fixture'},role='MIGRATION',timeout_ms=1000)
            self.assertEqual(compatibility.call_count,1)
            create_model(binding,{'model_name':'fixture'},role='EXECUTION',timeout_ms=1000)
            create_model({**binding,'supportsTools':True},{'model_name':'fixture'},role='MIGRATION',timeout_ms=1000)
            self.assertEqual(compatibility.call_count,1)

    def test_buffered_stream_preserves_native_tool_call_and_usage(self):
        import asyncio
        from openjiuwen.core.foundation.llm.schema.message import AssistantMessage, UsageMetadata
        from .model_config import bind_model_stream
        response = AssistantMessage(content='', tool_calls=[{'id': 'lookup-1', 'type': 'function',
            'name': 'lookup', 'arguments': '{"id":1}'}], finish_reason='tool_calls',
            usage_metadata=UsageMetadata(input_tokens=10, output_tokens=2, total_tokens=12))
        class Model:
            invoke = AsyncMock(return_value=response)
            stream = AsyncMock(side_effect=AssertionError('upstream SSE must not be used'))
        model = bind_model_stream(Model(), {'supportsStreaming': False})
        async def collect():
            return [chunk async for chunk in model.stream([{'role': 'user', 'content': 'lookup'}], tools=['native-schema'])]
        chunks = asyncio.run(collect())
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].tool_calls[0].name, 'lookup')
        self.assertEqual(chunks[0].tool_calls[0].arguments, '{"id":1}')
        self.assertEqual(chunks[0].usage_metadata.total_tokens, 12)
        self.assertEqual(model.invoke.call_args.kwargs['tools'], ['native-schema'])
    def test_agent_extensions_reach_public_sdk_methods_without_replacing_model(self):
        import asyncio
        class Model:
            invoke = AsyncMock(return_value="answer")
            def stream(self, *args, **kwargs):
                return kwargs
        model = Model()
        settings = {"extra_body": {"thinking": {"type": "enabled"}}}
        with patch.dict("os.environ", {"FINANCE_EVAL_ANALYZER_REQUEST_DEFAULTS": '{"reasoning_effort":"low","max_tokens":32768,"model":"untrusted-alias"}'}):
            self.assertIs(bind_agent_request_extensions(model, settings, "ANALYZER"), model)
        asyncio.run(model.invoke("query", max_tokens=32000))
        self.assertEqual(model.invoke.func.call_args.kwargs, {"max_tokens":32000,
            "extra_body":{"thinking":{"type":"enabled"},"reasoning_effort":"low"}})
        self.assertEqual(model.stream("query")["extra_body"]["reasoning_effort"], "low")
        self.assertEqual(settings, {"extra_body":{"thinking":{"type":"enabled"}}})

    def test_agent_extension_roles_are_independent_and_invalid_defaults_fail(self):
        class Model:
            invoke = AsyncMock()
            stream = AsyncMock()
        with patch.dict("os.environ", {"FINANCE_EVAL_ANALYZER_REQUEST_DEFAULTS": '[]'}):
            with self.assertRaises(ValueError):
                bind_agent_request_extensions(Model(), {}, "ANALYZER")
            model = Model()
            self.assertIs(bind_agent_request_extensions(model, {}, "MIGRATION"), model)
            self.assertNotIn("extra_body", model.invoke.__dict__)
    def test_alias_resolves_to_provider_model(self):
        model = {"providerId": "service-execution", "upstreamModelId": "deepseek-v4-pro", "extraBody": {"thinking": {"type": "disabled"}}}
        result = resolve_model({"models": {"DeepSeek V4": model}}, {"providerId": "service-execution", "modelId": "DeepSeek V4"})
        self.assertEqual(request_settings(result, "DeepSeek V4")["model_name"], "deepseek-v4-pro")

    def test_openrouter_does_not_receive_volcano_parameters(self):
        result = request_settings({"extraBody": {"reasoning": {"enabled": False}}}, "alias")
        self.assertNotIn("thinking", result["extra_body"])
        self.assertFalse(result["extra_body"]["reasoning"]["enabled"])

    def test_rejects_wrong_provider_and_disabled_model(self):
        for model, ref in [({}, {"providerId": "spoof", "modelId": "m"}), ({"enabled": False}, {"providerId": "service-execution", "modelId": "m"})]:
            with self.assertRaises(ValueError):
                resolve_model({"models": {"m": model}}, ref)


if __name__ == '__main__':
    unittest.main()
