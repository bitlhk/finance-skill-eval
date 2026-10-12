export const PROCUREMENT_TEST_SERVICE = "managed://procurement-review-v1";

export type ManagedMigrationTestService = {
  name: string;
  networkAlias: string;
  port: number;
  egress: boolean;
  environment: Record<string, string>;
  files: Record<string, string>;
  command: string[];
  containerEnvironment?: Record<string, string>;
};

const PROCUREMENT_SERVER = String.raw`
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REQUESTS = {
    "PO-001": {"request_id": "PO-001", "department": "IT", "amount": "1200", "supplier": "ACME"},
    "PO-002": {"request_id": "PO-002", "department": "IT", "amount": "4500", "supplier": "ACME"},
    "PO-003": {"request_id": "PO-003", "department": "OPS", "amount": "800", "supplier": "BLOCKED-LTD"},
}
BUDGETS = {"IT": "5000", "OPS": "3000"}
SUPPLIERS = {"ACME": True, "BLOCKED-LTD": False}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        return

    def send_json(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.headers.get("Authorization") != "Bearer synthetic-procurement-e2e":
            self.send_json(401, {"error": "UNAUTHORIZED"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self.send_json(400, {"error": "INVALID_JSON"})
            return
        if self.path == "/business/request":
            value = REQUESTS.get(str(payload.get("request_id", "")))
            self.send_json(200 if value else 404, value or {"error": "REQUEST_NOT_FOUND"})
            return
        if self.path == "/business/budget":
            department = str(payload.get("department", ""))
            available = BUDGETS.get(department)
            self.send_json(200 if available else 404, {"department": department, "available": available} if available else {"error": "DEPARTMENT_NOT_FOUND"})
            return
        if self.path == "/business/supplier":
            supplier = str(payload.get("supplier", ""))
            enabled = SUPPLIERS.get(supplier)
            self.send_json(200 if enabled is not None else 404, {"supplier": supplier, "status": "ACTIVE" if enabled else "INACTIVE", "enabled": enabled} if enabled is not None else {"error": "SUPPLIER_NOT_FOUND"})
            return
        self.send_json(404, {"error": "OPERATION_NOT_FOUND"})

ThreadingHTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
`;

const EXTERNAL_RELAY = String.raw`
import http.client
import ipaddress
import json
import os
import socket
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

TARGET = urlsplit(os.environ["TARGET_BASE_URL"])
ALLOWED_PREFIX = "/business/"
MAX_BODY = 1024 * 1024

def public_addresses(host):
    addresses = {item[4][0] for item in socket.getaddrinfo(host, TARGET.port or 443, type=socket.SOCK_STREAM)}
    if not addresses:
        raise ValueError("target has no address")
    for value in addresses:
        address = ipaddress.ip_address(value)
        if not address.is_global:
            raise ValueError("target resolves to a non-public address")
    return addresses

class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname, address, port):
        super().__init__(hostname, port, timeout=8, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        return

    def reply(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.path.startswith(ALLOWED_PREFIX) or "?" in self.path:
            self.reply(403, b'{"error":"RELAY_PATH_REJECTED"}')
            return
        try:
            address = sorted(public_addresses(TARGET.hostname))[0]
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_BODY:
                raise ValueError("request too large")
            body = self.rfile.read(length)
            base = TARGET.path.rstrip("/")
            path = base + self.path
            connection = PinnedHTTPSConnection(TARGET.hostname, address, TARGET.port or 443)
            connection.request("POST", path, body=body, headers={"Content-Type":"application/json", "Authorization":self.headers.get("Authorization", "")})
            response = connection.getresponse()
            output = response.read(MAX_BODY + 1)
            if len(output) > MAX_BODY:
                raise ValueError("response too large")
            self.reply(response.status, output, response.getheader("Content-Type", "application/json"))
        except Exception:
            self.reply(502, b'{"error":"MANAGED_SERVICE_RELAY_FAILED"}')

ThreadingHTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
`;

/** Resolves only operator-owned fixtures. Arbitrary uploaded URLs remain blocked. */
export function managedMigrationTestService(environment: Record<string, string>): ManagedMigrationTestService | null {
  const configured = Object.entries(environment);
  if (!configured.length) return null;
  if (configured.length !== 1 || configured[0]?.[0] !== "BUSINESS_SERVICE_URL") throw new Error("隔离试运行一次只允许绑定一个受管业务服务地址。");
  const value=configured[0][1];
  if(value!==PROCUREMENT_TEST_SERVICE){
    let target:URL;
    try{target=new URL(value);}catch{throw new Error("业务服务地址格式不正确。");}
    if(target.protocol!=="https:"||!target.hostname||target.username||target.password||target.search||target.hash)throw new Error("外部业务服务必须使用不含凭证、查询参数或片段的 HTTPS 基础地址。");
    const literal=target.hostname.replace(/^\[|\]$/gu,'');
    if(/^(?:localhost|0\.0\.0\.0)$/iu.test(literal))throw new Error("外部业务服务不能指向本机或私网地址。");
    const bytes=literal.includes(':')?literal.split(':'):literal.split('.');if(bytes.length===4&&bytes.every(part=>/^\d+$/u.test(part))){const numbers=bytes.map(Number),a=numbers[0]!,b=numbers[1]!;if(a===10||a===127||a===0||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168)throw new Error("外部业务服务不能指向本机或私网地址。");}
    return {name:`受管外部服务 ${target.host}`,networkAlias:'managed-service-relay',port:8081,egress:true,
      environment:{BUSINESS_SERVICE_URL:'http://managed-service-relay:8081'},files:{'relay.py':EXTERNAL_RELAY},command:['python3','/fixture/relay.py'],containerEnvironment:{TARGET_BASE_URL:value}};
  }
  return {
    name: "合成采购业务服务 v1",
    networkAlias: "managed-procurement",
    port: 8081,
    egress: false,
    environment: { BUSINESS_SERVICE_URL: "http://managed-procurement:8081" },
    files: { "server.py": PROCUREMENT_SERVER },
    command: ["python3", "/fixture/server.py"],
  };
}
