import unittest
from unittest.mock import AsyncMock, patch
from .model_config import resolve_model, request_settings, bind_agent_request_extensions


class ModelConfigTests(unittest.TestCase):
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
