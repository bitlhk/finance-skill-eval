"""Exercise the unified platform entry against a local model, never a provider."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
import unittest


class AnalysisModelWireTests(unittest.TestCase):
    def test_text_analysis_does_not_send_background_image_probes(self):
        self.exercise_entry('CHAT', 'migration', 'read_file', {'file_path': 'candidate/tool.py'})

    def test_portable_migration_uses_shared_assembly_and_real_compile_tool(self):
        self.exercise_entry('CHAT', 'migration', 'compile_source', {'language': 'python', 'paths': ['tool.py']})

    def exercise_entry(self, entry, role, tool, arguments):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                image = any(isinstance(m.get("content"), list) and any(
                    part.get("type") == "image_url" for part in m["content"] if isinstance(part, dict))
                    for m in body.get("messages", []))
                scanned = any(m.get("role") == "tool" for m in body.get("messages", []))
                if image:
                    status, response = 400, {"error": {"code": "MODEL_OR_PARAMETERS_MISMATCH"}}
                else:
                    message = {"role": "assistant", "content": json.dumps({
                        "status": "ABSTAINED", "reason": "Synthetic wire check"})}
                    if not scanned:
                        message = {"role": "assistant", "content": None, "tool_calls": [{
                            "id": "synthetic-scan", "type": "function",
                            "function": {"name": tool, "arguments": json.dumps(arguments)}}]}
                    status, response = 200, {"id": "synthetic", "object": "chat.completion", "created": 1,
                        "model": "synthetic-analysis", "choices": [{"index": 0,
                            "finish_reason": "stop" if scanned else "tool_calls", "message": message}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
                # The harness streams model calls. A streaming request must receive SSE,
                # not a non-streaming completion that the SDK reads as an empty stream.
                streaming = status == 200 and body.get('stream') is True
                if streaming:
                    delta = dict(message)
                    if delta.get('tool_calls'):
                        delta['tool_calls'] = [{**call, 'index': index} for index, call in enumerate(delta['tool_calls'])]
                    chunk = {'id': 'synthetic', 'object': 'chat.completion.chunk', 'created': 1,
                             'model': 'synthetic-analysis', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}
                    end = {**chunk, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop' if scanned else 'tool_calls'}]}
                    raw = ('data: ' + json.dumps(chunk) + '\n\ndata: ' + json.dumps(end) + '\n\ndata: [DONE]\n\n').encode()
                else:
                    raw = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "text/event-stream" if streaming else "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="analysis-wire-") as directory:
                root = Path(__file__).resolve().parents[1]
                config = Path(directory) / "runtime.json"
                config.write_text(json.dumps({"models": {"synthetic-analysis": {
                    "enabled": True, "providerId": "service-execution", "apiKey": "synthetic-only", "supportsTools":True,
                    "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "upstreamModelId": "synthetic-analysis"}}}))
                body = {"model": {"modelId": "synthetic-analysis", "providerId": "service-execution"},
                    "runId": "synthetic-wire", "assetDigest": "a" * 64, "maxIterations": 4,
                    "maxTokens": 32000, "modelTimeoutMs": 15000,
                    "files": {"SKILL.md": base64.b64encode(b"---\nname: synthetic-analysis\ndescription: test\n---\nText only.").decode()}}
                body['bundle'] = {'mode': entry, 'source': {'files': dict(body['files'])}}
                body['files']['tool.py'] = base64.b64encode(b'def run():\n    return 1\n').decode()
                result = subprocess.run([sys.executable, "integrations/openjiuwen/platform_agent.py"],
                    cwd=root, input=json.dumps(body), text=True, capture_output=True, timeout=60,
                    env={**os.environ, "FINANCE_RUNTIME_CONFIG": str(config), "TMPDIR": directory})
                self.assertEqual(result.returncode, 0, result.stderr[-500:])
                wire = json.loads(result.stdout.strip().splitlines()[-1])["result"]
                self.assertEqual(wire["status"], "PRODUCED", wire.get("error"))
                self.assertEqual(wire['composition']['role'], role)
                self.assertIn(tool, wire['composition']['tools'])
                names = {item['function']['name'] for item in requests[0].get('tools', [])}
                self.assertIn(tool, names)
                self.assertNotIn('skill_tool', names)
                self.assertNotIn('bash', names)
                self.assertTrue(wire['composition']['resources'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertGreaterEqual(len(requests), 2)
        self.assertTrue(all(row.get("temperature") == 0.2 and row.get("max_tokens") == 32000 for row in requests),
            [{key: row.get(key) for key in ("model", "temperature", "max_tokens", "stream")} for row in requests])
        self.assertFalse(any(isinstance(m.get("content"), list) for row in requests for m in row.get("messages", [])))


if __name__ == "__main__":
    unittest.main()
