"""Translate a trusted model binding without sending UI aliases to the provider."""

from functools import partial
import json
import os


def bind_model_auth(model, binding):
    """Apply trusted per-model auth at the pinned SDK request-header boundary.

    OpenJiuwen filters Authorization from custom_headers. Override only this
    model instance's header builder, shared by invoke and stream, without
    modifying site-packages, global SDK state or transport/retry behavior.
    """
    mode = binding.get("authMode", "bearer")
    if mode not in {"bearer", "raw"}:
        raise ValueError("Model authMode must be bearer or raw")
    if mode == "bearer":
        return model
    key = binding.get("apiKey")
    if not isinstance(key, str) or not key or "\r" in key or "\n" in key:
        raise ValueError("Raw model authentication requires a valid API key")
    client = getattr(model, "_client", None)
    original = getattr(client, "_build_request_headers", None)
    if not callable(original):
        raise RuntimeError("Installed model SDK does not support raw authentication")

    def headers(*args, **kwargs):
        merged = {name: value for name, value in original(*args, **kwargs).items()
                  if name.lower() != "authorization"}
        merged["Authorization"] = key
        return merged

    client._build_request_headers = headers
    return model


def bind_agent_request_extensions(model, settings, role, defaults=None):
    """Forward operator-owned provider extensions through the SDK's call API.

    init_model has no extra_body argument. Bind the public invoke/stream methods,
    retaining the SDK's original client, callbacks and streaming implementation.
    Uploaded files and agent output never supply these defaults.
    """
    if defaults is None:
        defaults = json.loads(os.environ.get(f"FINANCE_EVAL_{role}_REQUEST_DEFAULTS", "{}"))
    if not isinstance(defaults, dict):
        raise ValueError("Model request defaults must be an object")
    extra = dict(settings.get("extra_body") or {})
    nested = defaults.get("extra_body", {})
    if not isinstance(nested, dict):
        raise ValueError("Model extra_body must be an object")
    # Standard request fields are already controlled by the agent's explicit
    # model and budget configuration; never flatten them into provider extras.
    reserved = {"model", "messages", "tools", "stream", "temperature", "top_p",
                "max_tokens", "stop", "extra_body", "api_key", "base_url"}
    extra.update(nested)
    extra.update({key: value for key, value in defaults.items() if key not in reserved})
    if extra:
        model.invoke = partial(model.invoke, extra_body=extra)
        model.stream = partial(model.stream, extra_body=extra)
    return model


def bind_model_stream(model, binding):
    """Use the SDK's complete request for gateways with unreliable SSE.

    Agent events still stream between model/tool calls. Only the upstream
    model request is buffered; native tool schemas, usage and invocation stay
    in the existing SDK rather than a separate model transport.
    """
    streaming = binding.get('supportsStreaming', True)
    if not isinstance(streaming, bool):
        raise ValueError('supportsStreaming must be a boolean')
    if not streaming:
        from openjiuwen.core.foundation.llm.schema.message_chunk import AssistantMessageChunk
        invoke = model.invoke
        async def stream(messages, **kwargs):
            response = await invoke(messages, **kwargs)
            yield AssistantMessageChunk(**response.model_dump())
        model.stream = stream
    return model


def model_retry_count():
    retries = int(os.getenv('FINANCE_EVAL_MODEL_MAX_RETRIES', '3'))
    if not 0 <= retries <= 12:
        raise ValueError('FINANCE_EVAL_MODEL_MAX_RETRIES must be between 0 and 12')
    return retries


def create_model(binding, settings, *, role, timeout_ms, temperature=0.2, max_tokens=32000, defaults=None):
    """Shared SDK construction for Agents and one-shot evaluation calls.

    The framework owns provider transport, pooling and retry behavior. Only
    trusted configuration, provider extensions and the overall deadline belong
    to this application boundary.
    """
    from openjiuwen.core.foundation.llm import init_model
    try:
        from .agent_execution import bind_model_deadline
    except ImportError:
        from agent_execution import bind_model_deadline
    base = binding['baseUrl'].strip().rstrip('/').removesuffix('/chat/completions')
    retries = model_retry_count()
    model = init_model(binding.get('sdkProvider', 'OpenAI'), settings['model_name'],
                       binding['apiKey'], base, temperature=temperature,
                       max_tokens=max_tokens, timeout=timeout_ms / 1000,
                       max_retries=retries,
                       verify_ssl=True, custom_headers=binding.get('headers'))
    model = bind_model_auth(model, binding)
    model = (bind_agent_request_extensions(model, settings, role) if defaults is None
             else bind_agent_request_extensions(model, settings, role, defaults))
    # A Runtime binding may explicitly describe provider capability. Otherwise
    # apply the same trusted per-role switch used by platform role adapters.
    native_tools = binding.get('supportsTools', os.getenv(f'FINANCE_EVAL_{role}_NATIVE_TOOLS', '').strip().lower() != 'false')
    if native_tools is False:
        from integrations.openjiuwen.model_tool_protocol import bind_text_tools
        model = bind_text_tools(model)
    model = bind_model_stream(model, binding)
    return bind_model_deadline(model, max(0.001, timeout_ms / 1000))


def resolve_model(config, reference):
    model = config.get("models", {}).get(reference.get("modelId"))
    if not model or reference.get("providerId") != model.get("providerId", "service-execution"):
        raise ValueError("Requested model/provider is not configured in this worker")
    if model.get("enabled") is False:
        raise ValueError("Requested model is currently unavailable")
    return model


def request_settings(model, model_id, parameters=None):
    settings = {
        "model_name": model.get("upstreamModelId", model_id),
        "temperature": model.get("temperature", 0.2),
        "max_tokens": model.get("maxTokens", 6000),
        "extra_body": model.get("extraBody", {}),
    }
    if parameters:
        settings.update({key: parameters[key] for key in ('temperature', 'top_p', 'max_tokens') if key in parameters})
        if 'thinking' in parameters:
            settings['extra_body'] = {**settings['extra_body'], 'thinking': parameters['thinking']}
    return settings
