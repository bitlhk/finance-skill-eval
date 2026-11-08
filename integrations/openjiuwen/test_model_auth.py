import json
import unittest

from .model_config import bind_model_auth


class ModelAuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_sdk_invoke_and_stream_keep_auth_modes_isolated(self):
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm import Model, ModelClientConfig, ModelRequestConfig
        from openjiuwen.core.foundation.llm.model import init_model

        observed = []

        def respond(request):
            observed.append(request.headers.get_list("authorization"))
            body = json.loads(request.content)
            if body.get("stream"):
                chunk = {"id": "fixture", "object": "chat.completion.chunk", "created": 0,
                         "model": "fixture", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]}
                return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                      text="data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n")
            return httpx.Response(200, json={"id": "fixture", "object": "chat.completion", "created": 0,
                                            "model": "fixture", "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})

        for factory in ("direct", "agent"):
            for mode in ("raw", "bearer"):
                with self.subTest(factory=factory, mode=mode):
                    if factory == "direct":
                        model = Model(ModelClientConfig(client_provider="OpenAI", api_key="test-key", api_base="https://fixture.invalid/v1"),
                                      ModelRequestConfig(model="fixture"))
                    else:
                        model = init_model("OpenAI", "fixture", "test-key", "https://fixture.invalid/v1")
                    bind_model_auth(model, {"apiKey": "test-key", "authMode": mode})
                    async with AsyncOpenAI(api_key="test-key", base_url="https://fixture.invalid/v1",
                                           http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as sdk:
                        model._client._create_async_openai_client = lambda timeout=None: sdk
                        await model.invoke(messages=[{"role": "user", "content": "hello"}])
                        chunks = [chunk async for chunk in model.stream(messages=[{"role": "user", "content": "hello"}])]
                        self.assertTrue(chunks)
                    expected = "test-key" if mode == "raw" else "Bearer test-key"
                    self.assertEqual(observed[-2:], [[expected], [expected]])

    def test_invalid_mode_fails_without_exposing_key(self):
        with self.assertRaisesRegex(ValueError, "authMode"):
            bind_model_auth(object(), {"apiKey": "private", "authMode": "invalid"})


if __name__ == "__main__":
    unittest.main()
