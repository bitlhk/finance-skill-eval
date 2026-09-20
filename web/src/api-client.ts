import { apiPath, authHeaders } from "./api-path";

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(url), {
    ...init,
    headers: {
      ...(!init?.body || init.body instanceof Blob ? {} : { "content-type": "application/json" }),
      ...authHeaders(),
      ...init?.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* noop */ }
    throw Object.assign(new Error(message || `HTTP ${response.status}`), { status: response.status });
  }
  return text ? JSON.parse(text) as T : {} as T;
}
