param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location $Root
try {
    foreach ($Tool in @('node', 'pnpm', 'uv', $Python)) { Get-Command $Tool -ErrorAction Stop | Out-Null }
    $Expected = (Get-Content package.json -Raw | ConvertFrom-Json).packageManager.Split('@')[1]
    if ((& pnpm --version).Trim() -ne $Expected) { throw "Install pnpm $Expected first." }
    & pnpm install --frozen-lockfile --ignore-scripts --package-import-method copy
    if ($LASTEXITCODE) { throw 'Dependency installation failed.' }
    & pnpm check
    if ($LASTEXITCODE) { throw 'Type check failed.' }
    & pnpm build
    if ($LASTEXITCODE) { throw 'Build failed.' }
    $Previous = $env:UV_PROJECT_ENVIRONMENT
    try {
        $env:UV_PROJECT_ENVIRONMENT = Join-Path $Root '.venv-openjiuwen'
        & uv sync --locked --project integrations/openjiuwen --python $Python --no-dev --link-mode copy
        if ($LASTEXITCODE) { throw 'Runtime dependency installation failed.' }
    } finally { $env:UV_PROJECT_ENVIRONMENT = $Previous }
} finally { Pop-Location }
