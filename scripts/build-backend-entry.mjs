// Preserve historical executable paths; neither wrapper implements a backend.
import {mkdir,writeFile} from 'node:fs/promises';
await mkdir(new URL('../dist/service/',import.meta.url),{recursive:true});
await writeFile(new URL('../dist/service/server.js',import.meta.url),"import '../../scripts/serve-api.mjs';\n");
await writeFile(new URL('../dist/cli.js',import.meta.url),"#!/usr/bin/env node\nimport '../scripts/run-cli.mjs';\n");
