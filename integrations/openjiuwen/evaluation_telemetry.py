"""Execution-scoped OTel SDK tracing, with bounded OTLP evidence and optional export."""
import asyncio
import base64
import os
from google.protobuf.json_format import MessageToDict
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import set_span_in_context, Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans


class EvidenceExporter(SpanExporter):
    def __init__(self):
        self.spans = []
        self.truncated = False

    def export(self, spans):
        for span in spans:
            if len(self.spans) < 128:
                self.spans.append(span)
            else:
                self.truncated = True
        return SpanExportResult.SUCCESS


class EvaluationTelemetry:
    def __init__(self, body):
        self.exporter = EvidenceExporter()
        self.provider = TracerProvider(resource=Resource.create({'service.name': 'finance-openjiuwen'}))
        self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self.tracer = self.provider.get_tracer('finance.evaluation', '1')
        context = TraceContextTextMapPropagator().extract({'traceparent': body.get('traceparent', '')})
        self.root = self.tracer.start_span('invoke_agent', context=context, attributes={
            'gen_ai.operation.name': 'invoke_agent', 'finance.run.id': body.get('runId', ''),
            'finance.case.id': body.get('case', {}).get('caseId', ''), 'finance.side': body.get('side', '')})
        self.active = {}

    def start(self, kind, name):
        key = (kind, id(asyncio.current_task()), name)
        span = self.tracer.start_span(kind, context=set_span_in_context(self.root), attributes={
            'gen_ai.operation.name': kind, **({'gen_ai.tool.name': str(name)[:200]} if kind == 'execute_tool' else {})})
        self.active.setdefault(key, []).append(span)

    def end(self, kind, name, failed=False):
        key = (kind, id(asyncio.current_task()), name)
        entries = self.active.get(key, [])
        if entries:
            span = entries.pop()
            if failed:
                span.set_status(Status(StatusCode.ERROR))
            span.end()

    def finish(self, failed=False):
        incomplete = any(self.active.values())
        for entries in self.active.values():
            for span in entries:
                span.set_status(Status(StatusCode.ERROR, 'Unfinished invocation'))
                span.end()
        if failed:
            self.root.set_status(Status(StatusCode.ERROR))
        self.root.end()
        self.provider.force_flush(timeout_millis=2000)
        payload = MessageToDict(encode_spans(self.exporter.spans), use_integers_for_enums=True)
        # OTLP JSON represents identifiers as hex, unlike protobuf's generic JSON codec.
        def identifiers(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in ('traceId', 'spanId', 'parentSpanId'):
                        value[key] = base64.b64decode(item).hex()
                    else:
                        identifiers(item)
            elif isinstance(value, list):
                for item in value:
                    identifiers(item)
        identifiers(payload)
        export_status = 'NOT_CONFIGURED'
        if os.environ.get('OTEL_TRACES_EXPORTER') != 'none' and (os.environ.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') or os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT')):
            try:
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
                exporter = OTLPSpanExporter(timeout=2)
                export_status = 'EXPORTED' if exporter.export(self.exporter.spans) == SpanExportResult.SUCCESS else 'FAILED'
                exporter.shutdown()
            except Exception:
                export_status = 'FAILED'
        self.provider.shutdown()
        return {'status': 'PARTIAL' if incomplete or self.exporter.truncated else 'COMPLETE',
                'scope': 'instrumented-agent-calls', 'source': 'runtime-sdk', 'exportStatus': export_status,
                'otlp': payload}

    def rail(self):
        from openjiuwen.harness.rails.base import AgentRail
        telemetry = self
        class TelemetryRail(AgentRail):
            async def before_model_call(self, ctx): telemetry.start('chat', '')
            async def after_model_call(self, ctx): telemetry.end('chat', '')
            async def on_model_exception(self, ctx): telemetry.end('chat', '', True)
            async def before_tool_call(self, ctx): telemetry.start('execute_tool', getattr(ctx.inputs, 'tool_name', ''))
            async def after_tool_call(self, ctx):
                result = getattr(ctx.inputs, 'tool_result', None)
                telemetry.end('execute_tool', getattr(ctx.inputs, 'tool_name', ''), getattr(result, 'success', True) is False)
            async def on_tool_exception(self, ctx): telemetry.end('execute_tool', getattr(ctx.inputs, 'tool_name', ''), True)
        return TelemetryRail()
