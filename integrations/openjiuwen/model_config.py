"""Translate a trusted model binding without sending UI aliases to the provider."""


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
