import unittest
from .model_config import resolve_model, request_settings


class ModelConfigTests(unittest.TestCase):
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
