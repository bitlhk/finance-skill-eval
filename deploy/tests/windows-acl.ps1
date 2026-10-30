$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('finance-acl-' + [guid]::NewGuid().ToString())
$Base = Join-Path $Temp 'release'
try {
    New-Item -ItemType Directory -Path (Join-Path $Base 'package') -Force | Out-Null
    $Original = Join-Path $Temp 'store.txt'
    $Private = Join-Path $Base 'package/file.txt'
    Set-Content -LiteralPath $Original -Value 'shared package'
    $Before = (Get-Acl -LiteralPath $Original).Sddl
    New-Item -ItemType HardLink -Path $Private -Target $Original | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $Base 'alias') -Target (Join-Path $Base 'package') | Out-Null
    & node (Join-Path $Root 'deploy/lib/private-tree.mjs') $Base
    if ($LASTEXITCODE) { throw 'Private tree preparation failed.' }
    & icacls.exe $Private /inheritance:r /grant:r '*S-1-1-0:RX'
    if ($LASTEXITCODE) { throw 'Explicit ACL fixture failed.' }
    & icacls.exe $Base /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX'
    if ($LASTEXITCODE) { throw 'Root ACL failed.' }
    & (Join-Path $Root 'deploy/windows/reset-inheritance.ps1') -Directory $Base
    if ((Get-Acl -LiteralPath $Original).Sddl -ne $Before) { throw 'Shared package ACL changed.' }
    $Rules = (Get-Acl -LiteralPath $Private).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if (@($Rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-19' -and $_.IsInherited }).Count -ne 1) { throw 'LocalService inheritance missing.' }
    if (@($Rules | Where-Object { $_.IdentityReference.Value -notin @('S-1-5-19','S-1-5-18','S-1-5-32-544') }).Count) { throw 'Unexpected ACL principal.' }
    if ((Get-Item -LiteralPath (Join-Path $Base 'alias')).LinkType -ne 'Junction') { throw 'Junction changed.' }
    Write-Output 'PASS actual Windows ACL inheritance, internal junction and shared-cache isolation.'
} finally {
    $Allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $Resolved = [IO.Path]::GetFullPath($Temp)
    if (-not $Resolved.StartsWith($Allowed, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($Resolved).StartsWith('finance-acl-')) { throw 'Unsafe cleanup path.' }
    if (Test-Path -LiteralPath (Join-Path $Base 'alias')) { [IO.Directory]::Delete((Join-Path $Base 'alias')) }
    if (Test-Path -LiteralPath $Resolved) { Remove-Item -LiteralPath $Resolved -Recurse -Force }
}
