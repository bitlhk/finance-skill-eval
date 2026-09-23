import { parse as parseYaml, stringify } from 'yaml';

export function versionedMethod(source: string, skillId: string, version: string): string {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/)
    ?? source.match(/^(name:[^\n]*\n[\s\S]{0,8000}?)\n---[^\S\n]*(?:\n|$)/);
  const metadata = match ? parseYaml(match[1]!) : {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('元数据不合法');
  if (metadata.name && metadata.name !== skillId) {
    throw Object.assign(new Error('不能在方法编辑中变更业务标识'), { statusCode: 409 });
  }
  return `---\n${stringify({ ...metadata, name: skillId, version })}---\n${match ? source.slice(match[0].length) : source}`;
}
