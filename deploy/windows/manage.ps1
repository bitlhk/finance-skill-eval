param(
    [Parameter(Mandatory)][ValidateSet('configure','install','preflight','start','stop','status','logs','health','backup','restore','restart')][string]$Action,
    [string]$Base = 'C:\ProgramData\FinanceSkillEval',
    [string]$ProjectDirectory,
    [string]$WinSW,
    [string]$Node = (Get-Command node -ErrorAction Stop).Source,
    [string]$Archive,
    [string]$Destination
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Base = [IO.Path]::GetFullPath($Base)
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $ProjectDirectory) { $ProjectDirectory = $Root }
$Target = (Resolve-Path -LiteralPath $ProjectDirectory).Path
$EnvFile = Join-Path $Target '.env.local'
$Services = Join-Path $Base 'services'
if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'Create and fill project .env.local before configuring services.' }
function Invoke-Checked([string]$Exe, [string[]]$Parameters) {
    & $Exe @Parameters
    if ($LASTEXITCODE -ne 0) { throw 'Command failed. Inspect protected service logs.' }
}
function Require-Admin {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$Identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as Administrator.' }
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
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
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
}
function Stop-All {
    foreach ($Name in @('api','runtime')) {
        $Service = Get-Service -Name "finance-eval-$Name" -ErrorAction SilentlyContinue
        if ($Service -and $Service.Status -ne 'Stopped') {
            Invoke-Checked (Service-Path $Name) @('stop')
            # WinSW's console command may return while SCM is still StopPending.
            # Backups and reconfiguration must wait for actual completion.
            (Get-Service -Name "finance-eval-$Name").WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(80))
        }
    }
}
function Health([string]$Target) { Invoke-Checked $Node @((Join-Path $Target 'deploy/health.mjs'), '--env', $EnvFile) }
function Start-All([string]$Target) {
    foreach ($Name in @('runtime','api')) {
        $InstalledConfig = [xml](Get-Content -LiteralPath (Join-Path $Services "finance-eval-$Name.xml") -Raw -Encoding UTF8)
        if ($InstalledConfig.service.workingdirectory -ne $Target -or -not $InstalledConfig.service.startarguments.Contains(('"' + $EnvFile + '"'))) {
            throw 'Installed service targets another project/config. Stop it and run install from this project first.'
        }
    }
    foreach ($Name in @('runtime','api')) {
        if ((Get-CimInstance Win32_Service -Filter "Name='finance-eval-$Name'").StartName -ne 'NT AUTHORITY\LocalService') { throw 'SCM service identity must be LocalService; repair the stopped installation before starting.' }
        if ((Get-Service "finance-eval-$Name").Status -ne 'Running') { Invoke-Checked (Service-Path $Name) @('start') }
    }
    for ($Attempt=0; $Attempt -lt 30; $Attempt++) {
        # PowerShell 5 converts native stderr into errors even when redirected.
        $PreviousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $Node (Join-Path $Target 'deploy/health.mjs') --env $EnvFile *> $null
        } finally { $ErrorActionPreference = $PreviousPreference }
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
    Invoke-Checked $Node @((Join-Path $Target 'deploy/project.mjs'), 'backup', '--archive', $Output)
}
function Grant-Access([string]$Directory, [string]$Rights) {
    # Add service access without resetting Git ownership or explicit child ACLs.
    Invoke-Checked 'icacls.exe' @($Directory, '/grant', "*S-1-5-19:(OI)(CI)$Rights")
}
function Grant-ParentAccess([string]$Directory) {
    & (Join-Path $Root 'deploy/windows/grant-parent-access.ps1') -Directory $Directory
}
switch ($Action) {
    { $_ -in 'configure','install' } {
        if ($Action -eq 'install') { Require-Admin }
        if ($Action -eq 'install' -and (-not $WinSW -or -not (Test-Path -LiteralPath $WinSW))) { throw 'Provide the verified WinSW 2.12.0 x64 executable.' }
        if ($Action -eq 'configure') {
            foreach ($Name in @('runtime','api')) {
                $Existing = Get-CimInstance Win32_Service -Filter "Name='finance-eval-$Name'"
                if ($Existing -and $Existing.PathName.Trim('"') -eq (Service-Path $Name) -and $Existing.State -ne 'Stopped') { throw 'Stop services before rewriting their configuration.' }
            }
        }
        if ($Action -eq 'install') {
            foreach ($Name in @('runtime','api')) {
                $Existing = Get-CimInstance Win32_Service -Filter "Name='finance-eval-$Name'"
                if ($Existing -and ($Existing.PathName.Trim('"') -ne (Service-Path $Name))) { throw 'Service name belongs to another installation.' }
                if ($Existing -and $Existing.State -ne 'Stopped') { throw 'Stop services before repeating installation.' }
            }
        }
        foreach ($Directory in @($Services,(Join-Path $Base 'logs'),(Join-Path $Base 'cache'),(Join-Path $Base 'backups'))) { New-Item -ItemType Directory -Path $Directory -Force | Out-Null }
        Configure $Target
        if ($Action -eq 'install') {
            foreach ($Name in @('api','runtime')) {
                if ([IO.Path]::GetFullPath($WinSW) -ne [IO.Path]::GetFullPath((Service-Path $Name))) { Copy-Item -LiteralPath $WinSW -Destination (Service-Path $Name) -Force }
            }
            $InfoText = & $Node (Join-Path $Target 'deploy/project.mjs') paths
            if ($LASTEXITCODE) { throw 'Cannot resolve project paths.' }
            $Info = $InfoText | ConvertFrom-Json
            New-Item -ItemType Directory -Path $Info.data -Force | Out-Null
            foreach ($DependencyDirectory in @('node_modules','.venv-openjiuwen')) {
                $DependencyPath = Join-Path $Target $DependencyDirectory
                if (Test-Path -LiteralPath $DependencyPath) {
                    Invoke-Checked $Node @((Join-Path $Root 'deploy/lib/private-tree.mjs'), $DependencyPath, $Target)
                }
            }
            Grant-ParentAccess $Target
            Grant-Access $Target 'RX'
            Grant-Access $Services 'RX'
            foreach ($Directory in @($Info.data,(Join-Path $Base 'logs'),(Join-Path $Base 'cache'))) { Grant-Access $Directory 'M' }
            foreach ($File in @($EnvFile,$Info.runtime)) {
                $FileOwner = (Get-Acl -LiteralPath $File).Owner
                Invoke-Checked 'icacls.exe' @($File, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', '*S-1-5-19:R', "${FileOwner}:F")
            }
            foreach ($Name in @('runtime','api')) {
                if (-not (Get-Service "finance-eval-$Name" -ErrorAction SilentlyContinue)) { Invoke-Checked (Service-Path $Name) @('install') }
                $Installed = Get-CimInstance Win32_Service -Filter "Name='finance-eval-$Name'"
                if ($Installed.StartName -ne 'NT AUTHORITY\LocalService') {
                    $Changed = Invoke-CimMethod -InputObject $Installed -MethodName Change -Arguments @{ StartName='NT AUTHORITY\LocalService'; StartPassword='' }
                    if ($Changed.ReturnValue -ne 0) { throw 'Cannot set the required LocalService account.' }
                }
                if ((Get-CimInstance Win32_Service -Filter "Name='finance-eval-$Name'").StartName -ne 'NT AUTHORITY\LocalService') { throw 'Installed SCM service identity verification failed.' }
            }
        }
        Write-Output 'Configured project directory, not started. Verify service-account access to Node/Python and project dependencies, then preflight and start.'
    }
    default {
        switch ($Action) {
            'preflight' { Invoke-Checked $Node @((Join-Path $Target 'deploy/preflight.mjs'),'--env',$EnvFile) }
            'health' { Health $Target }
            'status' { Get-Service finance-eval-api,finance-eval-runtime }
            'logs' { Get-ChildItem (Join-Path $Base 'logs') -Filter '*.log' | ForEach-Object { Get-Content -LiteralPath $_.FullName -Tail 100 } }
            'start' { Require-Admin; Start-All $Target }
            'stop' { Require-Admin; Stop-All }
            'restart' { Require-Admin; Stop-All; Start-All $Target }
            'backup' { Require-Admin; Backup $Target $Archive }
            'restore' {
                Require-Admin
                if (-not $Archive -or -not $Destination -or -not [IO.Path]::IsPathRooted($Destination)) { throw 'Provide archive and absolute new empty destination.' }
                Invoke-Checked $Node @((Join-Path $Target 'deploy/project.mjs'),'restore','--archive',$Archive,'--destination',$Destination)
                Write-Output 'Restored separately. Review ACLs and replace live data/config only while stopped.'
            }

        }
    }
}
