import { expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { pythonCommand } from '../src/migration/infrastructure/migration-technical-validator.js';

const pep723=(body:string)=>`# /// script\n# requires-python = ">=3.11"\n# dependencies = ["pandas==2.3.3"]\n# ///\n${body}`;

it('runs a Skill package in the environment the package itself declares',()=>{
  const archive={'mcp/server.py':strToU8('print(1)'),'mcp/pyproject.toml':strToU8('[project]\nname="x"\n'),'mcp/uv.lock':strToU8('version = 1\n')};
  expect(pythonCommand(archive,'mcp/server.py')).toEqual({program:'uv',args:['run','--project','mcp','--locked','python','-I','mcp/server.py']});
});

it('finds the package root above a nested entrypoint rather than the archive root',()=>{
  const archive={'tool/scripts/run.py':strToU8('print(1)'),'tool/pyproject.toml':strToU8('[project]\nname="x"\n')};
  expect(pythonCommand(archive,'tool/scripts/run.py')).toEqual({program:'uv',args:['run','--project','tool','python','-I','tool/scripts/run.py']});
});

it('honours a PEP 723 block, which the python subcommand form silently ignores',()=>{
  // `uv run --no-project python -I file.py` builds an empty environment: uv only reads the
  // script metadata when the file is uv's own argument. Verified against uv directly.
  const archive={'scripts/run.py':strToU8(pep723('print(1)'))};
  expect(pythonCommand(archive,'scripts/run.py')).toEqual({program:'uv',args:['run','--no-project','scripts/run.py']});
});

it('falls back to an empty project only when nothing declares dependencies',()=>{
  const archive={'scripts/run.py':strToU8('print(1)')};
  expect(pythonCommand(archive,'scripts/run.py')).toEqual({program:'uv',args:['run','--no-project','python','-I','scripts/run.py']});
});

it('never falls back to the platform interpreter unless the operator pinned one',()=>{
  const archive={'scripts/run.py':strToU8(pep723('print(1)'))};
  for(const entry of ['scripts/run.py','deep/nested/run.py'])
    expect(pythonCommand(archive,entry).program).toBe('uv');
});
