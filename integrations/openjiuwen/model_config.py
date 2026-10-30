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


def bind_agent_request_extensions(model, settings, role):
    """Forward operator-owned provider extensions through the SDK's call API.

    init_model has no extra_body argument. Bind the public invoke/stream methods,
    retaining the SDK's original client, callbacks and streaming implementation.
    Uploaded files and agent output never supply these defaults.
    """
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


def resolve_model(config, reference):
    model = config.get("models", {}).get(reference.get("modelId"))
    if not model or reference.get("providerId") != model.get("providerId", "service-execution"):
        raise ValueError("Requested model/provider is not configured in this worker")
    if model.get("enabled") is False:
        raise ValueError("Requested model is currently unavailable")
    return model


def request_settings(model, model_id):
    return {
        "model_name": model.get("upstreamModelId", model_id),
        "temperature": model.get("temperature", 0.2),
        "max_tokens": model.get("maxTokens", 6000),
        "extra_body": model.get("extraBody", {}),
    }
