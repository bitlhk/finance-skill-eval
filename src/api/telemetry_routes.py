"""Optional existing OTLP endpoint, without a second trace protocol."""
import io
import gzip
import json
import os
from fastapi import Request, HTTPException
from fastapi.responses import Response
from evaluation.external_traces import collector_for, decode_protobuf
from .identity import AccessError


def install_telemetry_routes(app):
    if os.getenv('FINANCE_EVAL_EXTERNAL_OTLP') != '1':
        return
    @app.post('/api/telemetry/v1/traces')
    async def ingest(request: Request):
        context = request.state.workspace
        if context.get('publicDemo') or not context.get('accessToken'):
            raise AccessError('PRIVATE_WORKSPACE_REQUIRED')
        data = await request.body()
        limit = 2 * 1024 * 1024
        if len(data) > limit:
            raise HTTPException(413, 'Trace payload exceeds 2 MB')
        protobuf = request.headers.get('content-type', '').split(';')[0] == 'application/x-protobuf'
        encoding = request.headers.get('content-encoding', 'identity')
        if encoding not in ('identity', 'gzip') or encoding == 'gzip' and not protobuf:
            raise HTTPException(415, 'Unsupported trace encoding')
        try:
            if encoding == 'gzip':
                with gzip.GzipFile(fileobj=io.BytesIO(data)) as source:
                    data = source.read(limit + 1)
                if len(data) > limit:
                    raise ValueError('Trace payload exceeds limit')
            collector_for(context['dataDirectory']).ingest(decode_protobuf(data) if protobuf else json.loads(data))
            return Response(b'', media_type='application/x-protobuf') if protobuf else {}
        except Exception:
            raise HTTPException(400, 'Invalid OTLP trace payload') from None
