/** Preserve the historical credential gate for both task formats. */
export function assertMigrationExportSafe(files: Record<string, Uint8Array>) {
  for (const [name, bytes] of Object.entries(files)) {
    const text=Buffer.from(bytes).toString();
    const testFixture=/(^|\/)tests?\//i.test(name);
    const assignments=[...text.matchAll(/(?:api[_-]?key|password|secret|token)["']?\s*[:=]\s*["']([^"'\n]{8,})["']/ig)];
    // Recognize only conspicuously synthetic test literals, never an entire test directory.
    const containsCredential=assignments.some(match=>!(testFixture&&
      /^(?:test(?:-[a-z]{1,16}){0,3}-key|local-test-only)$/.test(match[1]!)));
    if (/(^|\/)(\.env(?:\..*)?|access-token|id_rsa|id_ed25519)$|\.(pem|key)$/i.test(name)
      || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text)||containsCredential) {
      throw Object.assign(new Error('候选可能包含凭据，请先检查并移除敏感配置；未导出任何文件'), {
        statusCode: 409, code: 'MIGRATION_EXPORT_CREDENTIALS',
      });
    }
  }
}
