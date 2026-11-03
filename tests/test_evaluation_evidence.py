import os
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch
from integrations.openjiuwen.evaluation_telemetry import EvaluationTelemetry
from integrations.openjiuwen.evaluation_artifacts import collect_artifacts, workspace_digests


class EvaluationEvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_exports_standard_otlp_protobuf_and_propagates_w3c_context(self):
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
        payloads = []
        class Receiver(BaseHTTPRequestHandler):
            def do_POST(self):
                payloads.append(ExportTraceServiceRequest.FromString(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-protobuf')
                self.end_headers()
            def log_message(self, *args): pass
        server = HTTPServer(('127.0.0.1', 0), Receiver)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT': f'http://127.0.0.1:{server.server_port}/v1/traces'}, clear=True):
                telemetry = EvaluationTelemetry({'runId':'r','case':{'caseId':'c'},'side':'right',
                    'traceparent':'00-'+'a'*32+'-'+'b'*16+'-01'})
                receipt = telemetry.finish()
            self.assertEqual(receipt['exportStatus'], 'EXPORTED')
            self.assertEqual(len(payloads), 1)
            span = payloads[0].resource_spans[0].scope_spans[0].spans[0]
            self.assertEqual(span.trace_id.hex(), 'a'*32)
            self.assertEqual(span.parent_span_id.hex(), 'b'*16)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    async def test_sdk_exports_real_nested_spans_without_prompt_content(self):
        with patch.dict(os.environ, {}, clear=True):
            telemetry = EvaluationTelemetry({'runId': 'run', 'case': {'caseId': 'case'}, 'side': 'right'})
            telemetry.start('chat', '')
            telemetry.end('chat', '')
            telemetry.start('execute_tool', 'lookup')
            telemetry.end('execute_tool', 'lookup', True)
            receipt = telemetry.finish()
        self.assertEqual(receipt['status'], 'COMPLETE')
        spans = [s for r in receipt['otlp']['resourceSpans'] for scope in r['scopeSpans'] for s in scope['spans']]
        self.assertEqual(len(spans), 3)
        self.assertEqual(len({s['traceId'] for s in spans}), 1)
        self.assertEqual(len(spans[0]['traceId']), 32)
        self.assertEqual(spans[1]['status']['code'], 2)
        self.assertNotIn('gen_ai.input.messages', str(spans))

    async def test_unfinished_call_cannot_be_reported_as_complete(self):
        with patch.dict(os.environ, {}, clear=True):
            telemetry = EvaluationTelemetry({'runId': 'r', 'case': {'caseId': 'c'}, 'side': 'right'})
            telemetry.start('execute_tool', 'pending')
            self.assertEqual(telemetry.finish()['status'], 'PARTIAL')

    def test_collects_real_changed_outputs_and_reports_omitted_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'fixture.txt').write_text('input', encoding='utf-8')
            (root / 'previous-run.txt').write_text('old output', encoding='utf-8')
            initial = workspace_digests(root)
            (root / 'result.json').write_text('{"amount":42}', encoding='utf-8')
            (root / 'large.bin').write_bytes(b'x' * 65000)
            artifacts, omitted = collect_artifacts(root, [{'path': 'fixture.txt', 'content': 'input'}], initial)
            self.assertEqual([file['path'] for file in artifacts], ['result.json'])
            self.assertEqual(omitted, 1)
            self.assertEqual(len(artifacts[0]['sha256']), 64)
