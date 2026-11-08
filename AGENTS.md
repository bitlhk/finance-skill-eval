# Project environment and checks

- Preserve existing workspace changes, backend entry points, and task/asset data.
- OpenJiuwen uses the project `.venv-openjiuwen` environment. The exact SDK version is declared in `integrations/openjiuwen/pyproject.toml` and resolved in its `uv.lock`.
- Do not run SDK tests with bare `python`, `python3`, a system Conda environment, or `integrations/openjiuwen/.venv`. Use `pnpm test:python` or `pnpm python:openjiuwen -m unittest <modules>`.
- Check the interpreter with `pnpm check:openjiuwen`; repair it with `pnpm setup:openjiuwen`. Do not uninstall or upgrade another project's/global Python packages to repair this project.
- Run `pnpm check` and relevant Vitest tests for TypeScript changes. Python runtime changes also require the relevant modules through the checked project interpreter.
- Keep generated Python caches, virtual environments, logs, credentials and business data out of Git. Do not remove business data while cleaning generated caches.
