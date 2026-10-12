export const PROCUREMENT_TEST_SERVICE = "managed://procurement-review-v1";

export type ManagedMigrationTestService = {
  name: string;
  networkAlias: string;
  port: number;
  environment: Record<string, string>;
  files: Record<string, string>;
  command: string[];
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

/** Resolves only operator-owned fixtures. Arbitrary uploaded URLs remain blocked. */
export function managedMigrationTestService(environment: Record<string, string>): ManagedMigrationTestService | null {
  const configured = Object.entries(environment);
  if (!configured.length) return null;
  if (configured.length !== 1 || configured[0]?.[0] !== "BUSINESS_SERVICE_URL" || configured[0]?.[1] !== PROCUREMENT_TEST_SERVICE) {
    throw new Error("候选需要外部服务配置；请绑定平台提供的受管测试连接，隔离容器不会访问用户填写的任意地址。");
  }
  return {
    name: "合成采购业务服务 v1",
    networkAlias: "managed-procurement",
    port: 8081,
    environment: { BUSINESS_SERVICE_URL: "http://managed-procurement:8081" },
    files: { "server.py": PROCUREMENT_SERVER },
    command: ["python3", "/fixture/server.py"],
  };
}
