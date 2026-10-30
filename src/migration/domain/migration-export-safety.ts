/** Preserve the historical credential gate for both task formats. */
export function assertMigrationExportSafe(files: Record<string, Uint8Array>) {
  for (const [name, bytes] of Object.entries(files)) {
    if (/(^|\/)(\.env(?:\..*)?|access-token|id_rsa|id_ed25519)$|\.(pem|key)$/i.test(name)
      || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)["']?\s*[:=]\s*["'][^"'\n]{8,}["']/i.test(Buffer.from(bytes).toString())) {
      throw Object.assign(new Error('候选可能包含凭据，请先检查并移除敏感配置；未导出任何文件'), {
        statusCode: 409, code: 'MIGRATION_EXPORT_CREDENTIALS',
      });
    }
  }
}
