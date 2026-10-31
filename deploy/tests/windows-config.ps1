param([Parameter(Mandatory)][string]$Python)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$Temp = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('finance-deploy-test-' + [guid]::NewGuid().ToString())))
$Base = Join-Path $Temp 'space & unicode'
$Project = Join-Path $Temp 'Git workspace & 中文'
try {
    New-Item -ItemType Directory -Path (Join-Path $Project 'dist/service'),(Join-Path $Project '.venv-openjiuwen/Scripts') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Root 'dist/service/server.js') -Destination (Join-Path $Project 'dist/service/server.js')
    Copy-Item -LiteralPath $Python -Destination (Join-Path $Project '.venv-openjiuwen/Scripts/python.exe')
    Set-Content -LiteralPath (Join-Path $Project '.env.local') -Value 'PRESERVE=existing-value'
    & (Join-Path $Root 'deploy/windows/manage.ps1') -Action configure -Base $Base -ProjectDirectory $Project
    foreach ($Name in @('api','runtime')) {
        $Xml = [xml](Get-Content -Encoding UTF8 -LiteralPath (Join-Path $Base "services/finance-eval-$Name.xml") -Raw)
        if ($Xml.service.workingdirectory -ne $Project) { throw 'XML escaped path mismatch.' }
        if ($Xml.service.startarguments -notlike "*$Name --env*") { throw 'Start arguments missing.' }
        if ($Xml.service.stoparguments -notlike "*stop $Name --env*") { throw 'Stop arguments missing.' }
        if ($Xml.service.log.sizeThreshold -ne '20480') { throw 'Rotation missing.' }
        if ($Xml.service.serviceaccount.domain -ne 'NT AUTHORITY' -or $Xml.service.serviceaccount.user -ne 'LocalService') { throw 'Unexpected WinSW 2.x service identity fields.' }
    }
    if ((Get-Content -Encoding UTF8 -LiteralPath (Join-Path $Project '.env.local') -Raw).Trim() -ne 'PRESERVE=existing-value') { throw 'Project config changed.' }
    if (Test-Path -LiteralPath (Join-Path $Base 'config/production.env')) { throw 'Duplicate configuration created.' }
    if (Test-Path -LiteralPath (Join-Path $Base 'current.txt')) { throw 'Release selection created.' }
    foreach ($Name in @('api','runtime')) {
        $Xml = [xml](Get-Content -Encoding UTF8 -LiteralPath (Join-Path $Base "services/finance-eval-$Name.xml") -Raw)
        if (-not $Xml.service.startarguments.Contains((Join-Path $Project '.env.local'))) { throw 'Project config not selected.' }
    }
    Write-Output 'PASS Windows XML generation, escaped paths, stop protocol, log rotation, identity and shared Git checkout/config. SCM installation NOT_TESTED.'
} finally {
    $Allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $Temp.StartsWith($Allowed, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($Temp)).StartsWith('finance-deploy-test-')) { throw 'Unsafe temporary cleanup path.' }
    if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
}
