param([Parameter(Mandatory)][string]$Python)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$Temp = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('finance-deploy-test-' + [guid]::NewGuid().ToString())))
$Base = Join-Path $Temp 'space & unicode'
$Release = Join-Path $Base 'releases/v1'
try {
    New-Item -ItemType Directory -Path (Join-Path $Release 'dist/service'),(Join-Path $Release '.venv-openjiuwen/Scripts') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Root 'dist/service/server.js') -Destination (Join-Path $Release 'dist/service/server.js')
    Copy-Item -LiteralPath $Python -Destination (Join-Path $Release '.venv-openjiuwen/Scripts/python.exe')
    & (Join-Path $Root 'deploy/windows/manage.ps1') -Action configure -Base $Base -Release $Release
    foreach ($Name in @('api','runtime')) {
        $Xml = [xml](Get-Content -LiteralPath (Join-Path $Base "services/finance-eval-$Name.xml") -Raw)
        if ($Xml.service.workingdirectory -ne $Release) { throw 'XML escaped path mismatch.' }
        if ($Xml.service.startarguments -notlike "*$Name --env*") { throw 'Start arguments missing.' }
        if ($Xml.service.stoparguments -notlike "*stop $Name --env*") { throw 'Stop arguments missing.' }
        if ($Xml.service.log.sizeThreshold -ne '20480') { throw 'Rotation missing.' }
        if ($Xml.service.serviceaccount.domain -ne 'NT AUTHORITY' -or $Xml.service.serviceaccount.user -ne 'LocalService') { throw 'Unexpected WinSW 2.x service identity fields.' }
    }
    $EnvText = Get-Content -LiteralPath (Join-Path $Base 'config/production.env') -Raw
    if ($EnvText.Contains('/var/lib/') -or $EnvText.Contains('/etc/')) { throw 'Linux paths leaked into Windows template.' }
    $Rejected = $false
    try { & (Join-Path $Root 'deploy/windows/manage.ps1') -Action configure -Base $Base -Release $Root } catch { $Rejected = $true }
    if (-not $Rejected) { throw 'Outside release path was accepted.' }
    Write-Output 'PASS Windows XML generation, escaped paths, stop protocol, log rotation, identity and release boundary. SCM installation NOT_TESTED.'
} finally {
    $Allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $Temp.StartsWith($Allowed, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($Temp)).StartsWith('finance-deploy-test-')) { throw 'Unsafe temporary cleanup path.' }
    if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
}
