import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { validateMcpTool } from '../dist/mcp-preflight.js';

/**
 * Execute the MCP skeletons the skill package hands the agent.
 *
 * The platform no longer generates services -- the agent writes them, guided by
 * `references/service-templates.md`. That makes every skeleton a promise, and a promise nobody
 * runs is how a skeleton rots into something that no longer starts. So this reads the code out of
 * the skill package, fills in the placeholders, builds each language the way the doc says to, and
 * speaks MCP to the result.
 *
 * A skeleton that fails here is a doc bug, not a test bug: the agent will copy it.
 */
const TEMPLATES = path.resolve('skills/enterprise-migration/references/service-templates.md');
const TOOL_NAME = 'lookup';
const INPUT_SCHEMA = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };
const ARGUMENTS = { id: 'A10001' };
const SCHEMA_PLACEHOLDER = '<源工具输入 Schema 的 JSON 字面量>';

/** npm and mvn are `.cmd` shims on Windows: spawning them by name fails with ENOENT. */
const shell = (line, args, cwd) => process.platform === 'win32'
  ? { program: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', line], cwd }
  : { program: args[0], args: args.slice(1), cwd };

const LANGUAGES = [
  { id: 'python', section: '## Python MCP 骨架', folder: 'mcp-python', entry: 'server.py',
    start: project => ({ program: 'uv', args: ['run', '--no-project', project.entry] }),
    prepare: null, escapeSchema: json => json },
  { id: 'node', section: '## Node MCP 骨架', folder: 'mcp-node', entry: 'server.mjs',
    start: project => ({ program: 'node', args: [project.entry] }),
    prepare: project => shell('npm install --omit=dev --no-audit --no-fund', ['install', '--omit=dev', '--no-audit', '--no-fund'], project.directory),
    escapeSchema: json => json },
  { id: 'java', section: '## Java MCP 骨架', folder: 'mcp-java', entry: null,
    start: project => ({ program: 'java', args: ['-jar', project.jar] }),
    prepare: project => shell('mvn --batch-mode --quiet clean package -DskipTests',
      ['mvn', '--batch-mode', '--quiet', 'clean', 'package', '-DskipTests'], project.directory),
    // The Java placeholder sits inside a Java string literal, so the quotes need escaping.
    escapeSchema: json => json.replaceAll('"', '\\"') },
];

/** Pull the `=== path ===`-delimited files out of one language's section of the templates doc. */
function skeletonOf(markdown, section) {
  const from = markdown.slice(markdown.indexOf(section));
  const fenced = from.slice(from.indexOf('```') + 3);
  const body = fenced.slice(0, fenced.indexOf('```'));
  const files = {};
  let current = null;
  for (const line of body.split('\n')) {
    const marker = /^===\s*(.+?)\s*===$/u.exec(line);
    if (marker) { current = marker[1]; files[current] = []; continue; }
    if (current) files[current].push(line);
  }
  if (!Object.keys(files).length) throw new Error(`No skeleton files found under ${section}`);
  return Object.fromEntries(Object.entries(files).map(([name, lines]) => [name, `${lines.join('\n').replace(/^\n+|\n+$/gu, '')}\n`]));
}

/** Key order is not part of a Schema's meaning, so compare the values, not the text. */
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(error => error ? reject(error) : resolve(address.port)); });
});

async function verify(language, markdown) {
  const root = await mkdtemp(path.join(os.tmpdir(), `mcp-${language.id}-`));
  const directory = path.join(root, language.folder);
  const port = await freePort();
  let server;
  try {
    const skeleton = skeletonOf(markdown, language.section);
    for (const [name, content] of Object.entries(skeleton)) {
      // The markers already carry the folder (`mcp-python/server.py`), so they land as written.
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content
        .replaceAll('<skill>', 'acceptance')
        .replaceAll('<tool>', TOOL_NAME)
        .replaceAll(SCHEMA_PLACEHOLDER, language.escapeSchema(JSON.stringify(INPUT_SCHEMA))));
    }
    const project = { directory, entry: path.join(directory, language.entry ?? '') };
    const prepare = language.prepare?.(project);
    if (prepare) execFileSync(prepare.program, prepare.args, { cwd: prepare.cwd, stdio: 'inherit' });
    if (language.id === 'java') {
      const jar = (await readdir(path.join(directory, 'target'))).find(name => name.endsWith('.jar') && !name.includes('original'));
      if (!jar) throw new Error('the skeleton built but produced no executable JAR');
      project.jar = path.join(directory, 'target', jar);
    }

    const start = language.start(project);
    // The whole point: start it the way the doc says the platform will start it. Its stderr is
    // kept because "exited with code 1" on its own sends the reader to the wrong place.
    server = spawn(start.program, start.args, { cwd: directory, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    server.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
    let result;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (server.exitCode !== null) throw new Error(`the server exited early with code ${server.exitCode}: ${stderr.trim()}`);
      result = await validateMcpTool({ endpoint: `http://127.0.0.1:${port}/mcp`, toolName: TOOL_NAME, arguments: ARGUMENTS });
      if (result.status === 'ready') break;
    }
    if (result?.status !== 'ready') throw new Error(result?.error ?? 'the skeleton never became reachable');

    const advertised = result.tools.find(tool => tool.name === TOOL_NAME);
    if (!advertised) throw new Error(`advertised ${result.tools.map(tool => tool.name).join(',')} instead of ${TOOL_NAME}`);
    if (JSON.stringify(canonical(advertised.inputSchema)) !== JSON.stringify(canonical(INPUT_SCHEMA)))
      throw new Error(`advertised Schema is not the source Schema: ${JSON.stringify(advertised.inputSchema)}`);
    const callText = JSON.stringify(result.callResult ?? null);
    if (!callText.includes('received') || !callText.includes(ARGUMENTS.id))
      throw new Error(`the Tool call did not reach the business method: ${callText}`);
    return { language: language.id, protocol: result.protocolVersion, tool: advertised.name, schema: advertised.inputSchema };
  } finally {
    if (server && server.exitCode === null) {
      if (process.platform === 'win32' && server.pid) execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      else server.kill();
      await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

const markdown = await readFile(TEMPLATES, 'utf8');
const verified = [];
for (const language of LANGUAGES) {
  process.stdout.write(`--- ${language.id}\n`);
  verified.push(await verify(language, markdown));
}
process.stdout.write(`${JSON.stringify({ mode: 'SKILL_PACKAGE_MCP_SKELETONS', verified }, null, 2)}\n`);
