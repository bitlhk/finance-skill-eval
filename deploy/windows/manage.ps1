param(
    [Parameter(Mandatory)][ValidateSet('configure','install','preflight','start','stop','status','logs','health','backup','restore','upgrade','rollback')][string]$Action,
    [string]$Base = 'C:\ProgramData\FinanceSkillEval',
    [string]$Release,
    [string]$WinSW,
    [string]$Node = (Get-Command node -ErrorAction Stop).Source,
    [string]$Archive,
    [string]$Destination
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Base = [IO.Path]::GetFullPath($Base)
$Config = Join-Path $Base 'config'
$Data = Join-Path $Base 'data'
$Services = Join-Path $Base 'services'
$CurrentFile = Join-Path $Base 'current.txt'
$EnvFile = Join-Path $Config 'production.env'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
function Invoke-Checked([string]$Exe, [string[]]$Parameters) {
    & $Exe @Parameters
    if ($LASTEXITCODE -ne 0) { throw 'Command failed. Inspect protected service logs.' }
}
function Require-Admin {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$Identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as Administrator.' }
}
function Get-Release([string]$Value) {
    if (-not $Value) { throw 'An explicit release directory is required.' }
    $Resolved = (Resolve-Path -LiteralPath $Value).Path
    $Parent = Join-Path $Base 'releases'
    if ([IO.Path]::GetDirectoryName($Resolved).TrimEnd('\') -ne $Parent.TrimEnd('\')) { throw 'Release must be a direct child of Base\releases.' }
    if ((Get-Item -LiteralPath $Resolved).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release cannot be a junction or symlink.' }
    foreach ($Item in @('dist/service/server.js', '.venv-openjiuwen/Scripts/python.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Resolved $Item))) { throw 'Prepare the release first.' }
    }
    return $Resolved
}
function Write-Utf8([string]$File, [string]$Content) { [IO.File]::WriteAllText($File, $Content, (New-Object Text.UTF8Encoding $false)) }
function Service-Path([string]$Name) { return (Join-Path $Services "finance-eval-$Name.exe") }
function Configure([string]$Target) {
    foreach ($Name in @('api', 'runtime')) {
        $Escape = [Security.SecurityElement]
        $Start = '&quot;' + $Escape::Escape((Join-Path $Target 'deploy/run.mjs')) + '&quot; ' + $Name + ' --env &quot;' + $Escape::Escape($EnvFile) + '&quot;'
        $Stop = '&quot;' + $Escape::Escape((Join-Path $Target 'deploy/run.mjs')) + '&quot; stop ' + $Name + ' --env &quot;' + $Escape::Escape($EnvFile) + '&quot;'
        $Xml = @"
<service>
  <id>finance-eval-$Name</id>
  <name>Finance Skill Eval $Name</name>
  <description>Private Skill migration and joint acceptance</description>
  <executable>$($Escape::Escape($Node))</executable>
  <startarguments>$Start</startarguments>
  <stopexecutable>$($Escape::Escape($Node))</stopexecutable>
  <stoparguments>$Stop</stoparguments>
  <workingdirectory>$($Escape::Escape($Target))</workingdirectory>
  <env name="UV_CACHE_DIR" value="$($Escape::Escape((Join-Path $Base 'cache')))" />
  <serviceaccount><username>NT AUTHORITY\LocalService</username></serviceaccount>
  <startmode>Automatic</startmode>
  <stoptimeout>75 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="none" />
  <resetfailure>1 hour</resetfailure>
  <logpath>$($Escape::Escape((Join-Path $Base 'logs')))</logpath>
  <log mode="roll-by-size"><sizeThreshold>20480</sizeThreshold><keepFiles>10</keepFiles></log>
</service>
"@
        Write-Utf8 (Join-Path $Services "finance-eval-$Name.xml") $Xml
    }
    Write-Utf8 $CurrentFile $Target
}
function Stop-All {
    foreach ($Name in @('api','runtime')) {
        $Service = Get-Service -Name "finance-eval-$Name" -ErrorAction SilentlyContinue
        if ($Service -and $Service.Status -ne 'Stopped') { Invoke-Checked (Service-Path $Name) @('stop') }
    }
}
function Health([string]$Target) { Invoke-Checked $Node @((Join-Path $Target 'deploy/health.mjs'), '--env', $EnvFile) }
function Start-All([string]$Target) {
    foreach ($Name in @('runtime','api')) {
        if ((Get-Service "finance-eval-$Name").Status -ne 'Running') { Invoke-Checked (Service-Path $Name) @('start') }
    }
    for ($Attempt=0; $Attempt -lt 30; $Attempt++) {
        & $Node (Join-Path $Target 'deploy/health.mjs') --env $EnvFile *> $null
        if ($LASTEXITCODE -eq 0) { Health $Target; return }
        Start-Sleep -Seconds 2
    }
    throw 'Service health failed. Inspect logs before exposing traffic.'
}
function Backup([string]$Target, [string]$Output) {
    if (-not $Output -or -not [IO.Path]::IsPathRooted($Output)) { throw 'An absolute new archive path is required.' }
    foreach ($Name in @('api','runtime')) {
        $Service = Get-Service "finance-eval-$Name" -ErrorAction SilentlyContinue
        if ($Service -and $Service.Status -ne 'Stopped') { throw 'Stop services before offline backup.' }
    }
    Invoke-Checked (Join-Path $Target '.venv-openjiuwen/Scripts/python.exe') @((Join-Path $Target 'deploy/backup.py'), 'create', '--data', $Data, '--config', $Config, '--archive', $Output)
}
function Protect-Tree([string]$Directory, [string]$ServiceAccess) {
    Invoke-Checked 'icacls.exe' @($Directory, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "*S-1-5-19:(OI)(CI)$ServiceAccess")
    # Existing children may have explicit permissive ACLs; reset them to the protected parent.
    if (Get-ChildItem -LiteralPath $Directory -Force | Select-Object -First 1) {
        Invoke-Checked 'icacls.exe' @((Join-Path $Directory '*'), '/reset', '/T', '/Q')
    }
}
switch ($Action) {
    { $_ -in 'configure','install' } {
        if ($Action -eq 'install') { Require-Admin }
        $Target = Get-Release $Release
        if ($Action -eq 'install' -and (-not $WinSW -or -not (Test-Path -LiteralPath $WinSW))) { throw 'Provide the verified WinSW 2.12.0 x64 executable.' }
        $Configured = Test-Path -LiteralPath $CurrentFile
        if ($Configured -and ($Action -eq 'configure' -or (Get-Content -LiteralPath $CurrentFile -Raw).Trim() -ne $Target)) { throw 'Already configured; use upgrade for another release.' }
        if ($Action -eq 'install') {
            foreach ($Name in @('runtime','api')) {
                $Existing = Get-CimInstance Win32_Service -Filter "Name='finance-eval-$Name'"
                if ($Existing -and (-not $Configured -or $Existing.PathName.Trim('"') -ne (Service-Path $Name))) { throw 'Service name belongs to another installation.' }
                if ($Existing -and $Existing.State -ne 'Stopped') { throw 'Stop services before repeating installation.' }
            }
        }
        foreach ($Directory in @($Config,$Data,$Services,(Join-Path $Base 'logs'),(Join-Path $Base 'cache'),(Join-Path $Base 'backups'))) { New-Item -ItemType Directory -Path $Directory -Force | Out-Null }
        if (-not (Test-Path $EnvFile)) {
            $Content = Get-Content (Join-Path $Root 'deploy/examples/production.env') -Raw
            $Content = $Content.Replace('/var/lib/finance-skill-eval/data', $Data.Replace('\','/')).Replace('/etc/finance-skill-eval/runtime.json', (Join-Path $Config 'runtime.json').Replace('\','/'))
            Write-Utf8 $EnvFile $Content
        }
        if (-not (Test-Path (Join-Path $Config 'runtime.json'))) { Copy-Item -LiteralPath (Join-Path $Root '.runtime.local.example.json') -Destination (Join-Path $Config 'runtime.json') }
        Configure $Target
        if ($Action -eq 'install') {
            foreach ($Name in @('api','runtime')) { Copy-Item -LiteralPath $WinSW -Destination (Service-Path $Name) }
            Protect-Tree $Base 'RX'
            foreach ($Directory in @($Data,(Join-Path $Base 'logs'),(Join-Path $Base 'cache'))) { Protect-Tree $Directory 'M' }
            foreach ($Name in @('runtime','api')) {
                if (-not (Get-Service "finance-eval-$Name" -ErrorAction SilentlyContinue)) { Invoke-Checked (Service-Path $Name) @('install') }
            }
        }
        Write-Output 'Configured, not started. Fill config, verify ACLs and service-account access, then preflight and start.'
    }
    default {
        $Target = Get-Release ((Get-Content -LiteralPath $CurrentFile -Raw).Trim())
        switch ($Action) {
            'preflight' { Invoke-Checked $Node @((Join-Path $Target 'deploy/preflight.mjs'),'--env',$EnvFile) }
            'health' { Health $Target }
            'status' { Get-Service finance-eval-api,finance-eval-runtime }
            'logs' { Get-ChildItem (Join-Path $Base 'logs') -Filter '*.log' | ForEach-Object { Get-Content -LiteralPath $_.FullName -Tail 100 } }
            'start' { Require-Admin; Start-All $Target }
            'stop' { Require-Admin; Stop-All }
            'backup' { Require-Admin; Backup $Target $Archive }
            'restore' {
                Require-Admin
                if (-not $Archive -or -not $Destination -or -not [IO.Path]::IsPathRooted($Destination)) { throw 'Provide archive and absolute new empty destination.' }
                Invoke-Checked (Join-Path $Target '.venv-openjiuwen/Scripts/python.exe') @((Join-Path $Target 'deploy/backup.py'),'restore','--archive',$Archive,'--destination',$Destination)
                Write-Output 'Restored separately. Review ACLs and replace live data/config only while stopped.'
            }
            { $_ -in 'upgrade','rollback' } {
                Require-Admin
                $Next = Get-Release $Release
                if ($Next -eq $Target) { throw 'Target is already selected.' }
                Protect-Tree $Next 'RX'
                Invoke-Checked $Node @((Join-Path $Next 'deploy/preflight.mjs'),'--env',$EnvFile)
                Stop-All
                Backup $Target (Join-Path $Base ("backups/" + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.zip'))
                Configure $Next
                try { Start-All $Next } catch {
                    Stop-All
                    Configure $Target
                    throw 'Activation failed. Previous code selected, services stopped. Review data compatibility and backup before restart.'
                }
                Write-Output 'Release activated. Run real-model acceptance before reopening traffic.'
            }
        }
    }
}
