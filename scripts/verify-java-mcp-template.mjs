import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { validateMcpTool } from '../dist/mcp-preflight.js';

/**
 * Run the Java skeleton from the skill package.
 *
 * The platform no longer generates a Java service -- the agent writes it, and what the platform
 * hands the agent is `references/service-templates.md`. That makes the skeleton a promise, and a
 * promise nobody executes is exactly how a skeleton rots into something that no longer compiles.
 * So this reads the block out of the skill package, fills in the placeholders, builds it and
 * speaks MCP to it. Nothing here is written by hand: if the doc is wrong, this fails.
 */
const TEMPLATES = path.resolve('skills/enterprise-migration/references/service-templates.md');
const SECTION = '## Java MCP 骨架';
const TOOL_NAME = 'lookup';
const INPUT_SCHEMA = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };
const ARGUMENTS = { id: 'A10001' };

/** Key order is not part of a Schema's meaning, so compare the values, not the text. */
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;

/** Pull the `=== path ===`-delimited files out of the Java section of the templates doc. */
function javaSkeleton(markdown) {
  const section = markdown.slice(markdown.indexOf(SECTION));
  const fenced = section.slice(section.indexOf('```') + 3);
  const body = fenced.slice(0, fenced.indexOf('```'));
  const files = {};
  let current = null;
  for (const line of body.split('\n')) {
    const marker = /^===\s*(.+?)\s*===$/u.exec(line);
    if (marker) { current = marker[1]; files[current] = []; continue; }
    if (current) files[current].push(line);
  }
  if (!Object.keys(files).length) throw new Error(`No skeleton files found under ${SECTION}`);
  return Object.fromEntries(Object.entries(files).map(([name, lines]) => [name, lines.join('\n').replace(/^\n+|\n+$/gu, '') + '\n']));
}

const root = await mkdtemp(path.join(os.tmpdir(), 'java-mcp-template-'));
const project = path.join(root, 'mcp-java');
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(error => error ? reject(error) : resolve(address.port)); });
});
let server;
try {
  const skeleton = javaSkeleton(await readFile(TEMPLATES, 'utf8'));
  for (const [name, content] of Object.entries(skeleton)) {
    const relative = name.replace(/^mcp-java\//u, '');
    const target = path.join(project, relative);
    await mkdir(path.dirname(target), { recursive: true });
    // The schema goes in as a Java string literal, which is what the placeholder sits inside.
    await writeFile(target, content
      .replaceAll('<skill>', 'acceptance')
      .replaceAll('<tool>', TOOL_NAME)
      .replaceAll('<源工具输入 Schema 的 JSON 字面量>', JSON.stringify(INPUT_SCHEMA).replaceAll('"', '\\"')));
  }

  const maven = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : maven,
    process.platform === 'win32' ? ['/d', '/s', '/c', `${maven} --batch-mode --quiet clean package -DskipTests`] : ['--batch-mode', '--quiet', 'clean', 'package', '-DskipTests'],
    { cwd: project, stdio: 'inherit' });

  const jar = (await readdir(path.join(project, 'target'))).find(name => name.endsWith('.jar') && !name.includes('original'));
  if (!jar) throw new Error('The skeleton built but produced no executable JAR');
  server = spawn('java', ['-jar', path.join(project, 'target', jar)], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });

  let result;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (server.exitCode !== null) throw new Error(`The skeleton's server exited early with code ${server.exitCode}`);
    result = await validateMcpTool({ endpoint: `http://127.0.0.1:${port}/mcp`, toolName: TOOL_NAME, arguments: ARGUMENTS });
    if (result.status === 'ready') break;
  }
  if (result?.status !== 'ready') throw new Error(result?.error ?? 'The skeleton never became reachable');

  const advertised = result.tools.find(tool => tool.name === TOOL_NAME);
  if (!advertised) throw new Error(`The skeleton advertised ${result.tools.map(tool => tool.name).join(',')} instead of ${TOOL_NAME}`);
  // The whole point of building the Schema by hand is that what comes back is the source Schema,
  // not something inferred from a Java signature.
  if (JSON.stringify(canonical(advertised.inputSchema)) !== JSON.stringify(canonical(INPUT_SCHEMA)))
    throw new Error(`Advertised Schema is not the source Schema: ${JSON.stringify(advertised.inputSchema)}`);
  const callText = JSON.stringify(result.callResult ?? null);
  if (!callText.includes('received') || !callText.includes(ARGUMENTS.id))
    throw new Error(`The Tool call did not reach the business method: ${callText}`);
  process.stdout.write(`${JSON.stringify({ mode: 'SKILL_PACKAGE_JAVA_SKELETON', protocol: result.protocolVersion, tool: advertised.name, schema: advertised.inputSchema }, null, 2)}\n`);
} finally {
  if (server && server.exitCode === null) {
    if (process.platform === 'win32' && server.pid) execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill();
    await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
