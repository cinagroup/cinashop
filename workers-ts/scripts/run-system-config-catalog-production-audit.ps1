# DB-003: one catalog-only snapshot through the currently deployed app role.
# This does not verify a physical primary, capture a preimage, or permit DML.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedSourceSha
)
$ErrorActionPreference = 'Stop'

$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRepository = Split-Path -Parent $taskRoot
$taskConfig = Join-Path $taskRoot 'test/integration/system-config-catalog-audit.wrangler.jsonc'
$taskCli = Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskAccount = '7ea8e46d8210bad342fa7595f7935fea'
$taskMainVersion = 'd44ef519-90ab-4864-b42f-3f0ca76890b2'
$taskMainDeployment = 'c87cfa23-27df-4a13-b338-5e820c217425'
$taskMainBindingSha = '85dcd3bd1cc2f2a6a836ed9913c2fb5f7f46dd03540894585b75be399cfe36be'
$taskAppHyperdrive = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7'
$taskAdminHyperdrive = '446e94a4de0143f58c8e5178ec55db8b'
$taskApiBase = "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts"
$taskMainApi = "$taskApiBase/cinashop-api"
$taskAppHyperdriveApi = "https://api.cloudflare.com/client/v4/accounts/$taskAccount/hyperdrive/configs/$taskAppHyperdrive"

# All failures that can be checked locally fail before any Cloudflare request.
if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'Cloudflare API authentication is required.' }
$taskHead = (& git -C $taskRepository rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $taskHead -cne $ExpectedSourceSha) {
    throw 'Reviewed source commit mismatch.'
}
$taskDirty = @(& git -C $taskRepository status --porcelain=v1)
if ($LASTEXITCODE -ne 0 -or $taskDirty.Count -ne 0) {
    throw 'The audit worktree must be clean.'
}
if (-not (Test-Path -LiteralPath $taskCli)) { throw 'Reviewed Wrangler dependency is not installed.' }
$taskOutputRoot = Join-Path $taskRoot '.cache'
$null = New-Item -ItemType Directory -Force -Path $taskOutputRoot
function Assert-ReviewedConfig {
    param($Config)
    $taskTopKeys = @($Config.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $taskExpectedTopKeys = @('$schema','compatibility_date','compatibility_flags',
        'hyperdrive','limits','main','name','observability','vars','workers_dev' |
        Sort-Object -CaseSensitive)
    $taskFlags = @($Config.compatibility_flags | Sort-Object -CaseSensitive)
    $taskExpectedFlags = @('enable_request_signal','global_fetch_strictly_public',
        'nodejs_compat' | Sort-Object -CaseSensitive)
    if (($taskTopKeys -join '|') -cne ($taskExpectedTopKeys -join '|') -or
        $Config.'$schema' -cne '../../node_modules/wrangler/config-schema.json' -or
        $Config.name -cne 'cinashop-system-config-catalog-audit-template' -or
        $Config.main -cne 'SystemConfigCatalogAuditWorker.ts' -or
        $Config.compatibility_date -cne '2026-09-01' -or
        ($taskFlags -join '|') -cne ($taskExpectedFlags -join '|') -or
        $Config.workers_dev -isnot [bool] -or $Config.workers_dev -ne $true -or
        (@($Config.limits.PSObject.Properties.Name) -join '|') -cne 'cpu_ms' -or
        $Config.limits.cpu_ms -isnot [long] -or $Config.limits.cpu_ms -ne 10000 -or
        ((@($Config.observability.PSObject.Properties.Name | Sort-Object -CaseSensitive) -join '|') -cne
            'enabled|logs') -or
        $Config.observability.enabled -isnot [bool] -or
        $Config.observability.enabled -ne $true -or
        (@($Config.observability.logs.PSObject.Properties.Name) -join '|') -cne
            'invocation_logs' -or
        $Config.observability.logs.invocation_logs -isnot [bool] -or
        $Config.observability.logs.invocation_logs -ne $false -or
        @($Config.hyperdrive).Count -ne 1 -or
        ((@($Config.hyperdrive[0].PSObject.Properties.Name | Sort-Object -CaseSensitive) -join '|') -cne
            'binding|id') -or
        $Config.hyperdrive[0].binding -cne 'HYPERDRIVE' -or
        $Config.hyperdrive[0].id -cne $taskAppHyperdrive -or
        ((@($Config.vars.PSObject.Properties.Name | Sort-Object -CaseSensitive) -join '|') -cne
            'AUDIT_EXPIRES_AT|AUDIT_TOKEN_SHA256|RUN_MARKER') -or
        $Config.vars.AUDIT_TOKEN_SHA256 -isnot [string] -or
        $Config.vars.AUDIT_TOKEN_SHA256 -cne '' -or
        $Config.vars.AUDIT_EXPIRES_AT -isnot [string] -or
        $Config.vars.AUDIT_EXPIRES_AT -cne '' -or
        $Config.vars.RUN_MARKER -isnot [string] -or
        $Config.vars.RUN_MARKER -cne '') {
        throw 'Temporary Worker configuration differs from reviewed read-only target.'
    }
}
$taskConfigValue = Get-Content -LiteralPath $taskConfig -Raw | ConvertFrom-Json -Depth 20
Assert-ReviewedConfig $taskConfigValue
$taskName = 'cinashop-system-config-catalog-audit-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$taskTargetApi = "$taskApiBase/$taskName"
$taskToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskTokenHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskMarker = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskMarkerSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($taskMarker))).ToLowerInvariant()
$taskExpiry = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$taskHeaders = @{ Authorization = 'Bearer ' + $env:CLOUDFLARE_API_TOKEN }
$taskAuth = @{ 'X-Audit-Token' = $taskToken }
$taskExpectedMainBindings = @(
    "HYPERDRIVE:$taskAppHyperdrive", "HYPERDRIVE_ADMIN:$taskAdminHyperdrive"
) | Sort-Object
$taskExpectedAuditBindings = @(
    "HYPERDRIVE:hyperdrive:$taskAppHyperdrive",
    'AUDIT_TOKEN_SHA256:plain_text:',
    'AUDIT_EXPIRES_AT:plain_text:',
    'RUN_MARKER:plain_text:'
) | Sort-Object
$taskExpectedVarValues = @{
    AUDIT_TOKEN_SHA256 = $taskTokenHash
    AUDIT_EXPIRES_AT = $taskExpiry
    RUN_MARKER = $taskMarker
}
$taskUrl = "https://$taskName.cinagroup.workers.dev"
$taskStage = 'control-plane-preflight'
$taskAttempted = $false
$taskOwnedVersion = $null
$taskObservedVersionId = $null
$taskDeleted = $false
$taskControlPlane404 = $false
$taskPublic404 = $false
$taskMainUnchanged = $false
$taskFormalBefore = $null
$taskHyperdriveModifiedOn = $null
$taskReport = $null
$taskRawReport = $null
$taskFailure = $null
$taskCleanupFailure = $null
$taskLogDeleted = $false
$taskProcessTreeUncertain = $false
$taskCliOutputCleanupFailed = $false
$taskDeployDiagnostic = [ordered]@{ outcome = 'not-started'; exitCode = 'unobserved' }
$env:CLOUDFLARE_ACCOUNT_ID = $taskAccount
$env:WRANGLER_SEND_METRICS = 'false'
$taskLogPath = Join-Path $taskOutputRoot "$taskName-wrangler.log"
if (Test-Path -LiteralPath $taskLogPath) { throw 'Owned Wrangler log path already exists.' }
$env:WRANGLER_LOG_PATH = $taskLogPath

function Invoke-ControlPlane {
    param([string]$Uri, [int[]]$ExpectedStatus = @(200))
    $taskResponse = Invoke-WebRequest -Uri $Uri -Headers $taskHeaders `
        -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 20
    $taskStatus = [int]$taskResponse.StatusCode
    if ($ExpectedStatus -notcontains $taskStatus) { throw 'Control-plane status differs from reviewed state.' }
    if ($taskStatus -eq 404) { return $null }
    if ([Text.Encoding]::UTF8.GetByteCount([string]$taskResponse.Content) -gt 262144) {
        throw 'Control-plane response exceeded reviewed bounds.'
    }
    $taskBody = $taskResponse.Content | ConvertFrom-Json -Depth 25
    if ($taskBody.success -ne $true) { throw 'Control-plane response did not confirm success.' }
    return $taskBody
}

function Get-HyperdriveBindings {
    param($Bindings)
    return @($Bindings | Where-Object { $_.type -eq 'hyperdrive' } |
        ForEach-Object { "{0}:{1}" -f $_.name,$_.id } | Sort-Object)
}

function Get-FullTrafficVersion {
    param([string]$ScriptApi)
    $taskDeployments = Invoke-ControlPlane "$ScriptApi/deployments"
    $taskRows = if ($taskDeployments.result -is [array]) {
        @($taskDeployments.result)
    } else { @($taskDeployments.result.deployments) }
    $taskSorted = @($taskRows | Sort-Object created_on -Descending)
    if ($taskSorted.Count -eq 0 -or -not $taskSorted[0].created_on -or
        ($taskSorted.Count -gt 1 -and
            [string]$taskSorted[0].created_on -ceq [string]$taskSorted[1].created_on)) {
        throw 'Worker deployment recency is ambiguous.'
    }
    $taskLatest = $taskSorted[0]
    $taskFull = @($taskLatest.versions | Where-Object { $_.percentage -eq 100 })
    if ($taskFull.Count -ne 1 -or @($taskLatest.versions).Count -ne 1 -or
        $taskFull[0].version_id -notmatch '^[0-9a-f-]{36}$') {
        throw 'Worker traffic is not pinned to one reviewed version.'
    }
    return [string]$taskFull[0].version_id
}

function Get-MainBindingSha {
    param($Bindings)
    if (@($Bindings).Count -ne 31) { throw 'Formal Worker binding count changed.' }
    $taskHyperdrive = @(Get-HyperdriveBindings $Bindings)
    if ($taskHyperdrive.Count -ne 2 -or
        ($taskHyperdrive -join '|') -cne ($taskExpectedMainBindings -join '|')) {
        throw 'Formal Worker Hyperdrive bindings changed.'
    }
    # Metadata only: omit plain text and secret binding values.
    $taskProjection = @($Bindings | ForEach-Object {
        "{0}:{1}:{2}:{3}:{4}" -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name
    } | Sort-Object -CaseSensitive)
    $taskBytes = [Text.Encoding]::UTF8.GetBytes(($taskProjection -join "`n"))
    $taskDigest = [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($taskBytes)).ToLowerInvariant()
    if ($taskDigest -cne $taskMainBindingSha) {
        throw 'Formal Worker binding projection changed.'
    }
    return $taskDigest
}

function Assert-MainWorker {
    $taskDeployments = Invoke-ControlPlane "$taskMainApi/deployments"
    $taskRows = if ($taskDeployments.result -is [array]) {
        @($taskDeployments.result)
    } else { @($taskDeployments.result.deployments) }
    $taskSorted = @($taskRows | Sort-Object created_on -Descending)
    if ($taskSorted.Count -eq 0 -or -not $taskSorted[0].created_on -or
        ($taskSorted.Count -gt 1 -and
            [string]$taskSorted[0].created_on -ceq [string]$taskSorted[1].created_on)) {
        throw 'Formal Worker deployment recency is ambiguous.'
    }
    $taskLatest = $taskSorted[0]
    if ($taskLatest.id -cne $taskMainDeployment -or
        @($taskLatest.versions).Count -ne 1 -or
        $taskLatest.versions[0].percentage -ne 100 -or
        $taskLatest.versions[0].version_id -cne $taskMainVersion) {
        throw 'Formal Worker deployment or version changed.'
    }
    $taskSettings = Invoke-ControlPlane "$taskMainApi/settings"
    $taskSettingsDigest = Get-MainBindingSha $taskSettings.result.bindings
    $taskVersion = Invoke-ControlPlane "$taskMainApi/versions/$taskMainVersion"
    $taskVersionDigest = Get-MainBindingSha $taskVersion.result.resources.bindings
    if ($taskSettingsDigest -cne $taskVersionDigest) {
        throw 'Formal Worker mutable and immutable bindings disagree.'
    }
    return [ordered]@{
        deploymentId = $taskMainDeployment
        versionId = $taskMainVersion
        bindingSha256 = $taskSettingsDigest
        versionBindingSha256 = $taskVersionDigest
    }
}

function Assert-AppHyperdriveCacheDisabled {
    $taskHyperdrive = Invoke-ControlPlane $taskAppHyperdriveApi
    $taskModifiedOn = [string]$taskHyperdrive.result.modified_on
    if ($taskHyperdrive.result.id -cne $taskAppHyperdrive -or
        $taskHyperdrive.result.caching.disabled -isnot [bool] -or
        $taskHyperdrive.result.caching.disabled -ne $true -or
        -not $taskModifiedOn -or
        ($script:taskHyperdriveModifiedOn -and
            $taskModifiedOn -cne $script:taskHyperdriveModifiedOn)) {
        throw 'Current app Hyperdrive caching or modification state differs.'
    }
    if (-not $script:taskHyperdriveModifiedOn) { $script:taskHyperdriveModifiedOn = $taskModifiedOn }
}

function Get-OwnedAuditVersion {
    $taskVersionId = Get-FullTrafficVersion $taskTargetApi
    $script:taskObservedVersionId = $taskVersionId
    $taskVersion = Invoke-ControlPlane "$taskTargetApi/versions/$taskVersionId"
    if ($taskVersion.result.annotations.'workers/message' -cne $taskMarker) {
        throw 'Temporary Worker ownership marker changed.'
    }
    $taskBindings = @($taskVersion.result.resources.bindings | ForEach-Object {
        if ($_.type -eq 'hyperdrive') { "{0}:hyperdrive:{1}" -f $_.name,$_.id }
        else { "{0}:{1}:" -f $_.name,$_.type }
    } | Sort-Object)
    if (($taskBindings -join '|') -cne ($taskExpectedAuditBindings -join '|')) {
        throw 'Temporary Worker version bindings changed.'
    }
    # The version API exposes deployed plain_text values. Compare in memory;
    # only the SHA-256 of the non-secret ownership marker enters the receipt.
    foreach ($taskVarName in $taskExpectedVarValues.Keys) {
        $taskMatches = @($taskVersion.result.resources.bindings | Where-Object {
            $_.name -ceq $taskVarName -and $_.type -ceq 'plain_text'
        })
        if ($taskMatches.Count -ne 1 -or
            [string]$taskMatches[0].text -cne [string]$taskExpectedVarValues[$taskVarName]) {
            throw 'Temporary Worker deployed variable differs from reviewed value.'
        }
    }
    return $taskVersionId
}

function Get-PublicResponse {
    param([string]$Uri, [hashtable]$Headers = @{}, [string]$Method = 'Get')
    return Invoke-WebRequest -Uri $Uri -Headers $Headers -Method $Method `
        -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 30
}

function Confirm-Dual404 {
    param([ValidateRange(1,6)][int]$MaxAttempts = 6,
        [ValidateRange(0,2)][int]$PauseSeconds = 2)
    for ($taskAttempt = 0; $taskAttempt -lt $MaxAttempts; $taskAttempt++) {
        $script:taskControlPlane404 = [int](Invoke-WebRequest -Uri $taskTargetApi `
            -Headers $taskHeaders -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 20).StatusCode -eq 404
        $script:taskPublic404 = [int](Get-PublicResponse "$taskUrl/audit").StatusCode -eq 404
        if ($script:taskControlPlane404 -and $script:taskPublic404) { return }
        if ($taskAttempt -lt $MaxAttempts - 1) { Start-Sleep -Seconds $PauseSeconds }
    }
    throw 'Temporary Worker dual-404 cleanup was not confirmed.'
}

function Test-WorkerMayRemain {
    # A timed-out deploy can still finish in a child process after a transient
    # dual-404. Only confirmed deletion plus a certain process tree closes it.
    return [bool](-not ($script:taskDeleted -and $script:taskControlPlane404 -and
        $script:taskPublic404 -and -not $script:taskProcessTreeUncertain))
}

function Assert-CatalogReport {
    param($Value)
    if ($Value.runMarker -cne $taskMarker -or
        $Value.databaseOid -isnot [string] -or
        $Value.databaseOid -cnotmatch '^[1-9][0-9]{0,9}$' -or
        $Value.catalogSha256 -isnot [string] -or
        $Value.catalogSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $Value.columnCount -ne 16 -or
        $Value.catalogSafe -isnot [bool] -or
        $Value.catalogSafe -ne $true -or
        $Value.controlSystemAclExecutable -isnot [bool] -or
        $Value.originIdentityVerified -isnot [bool] -or
        $Value.originIdentityVerified -ne $false -or
        $Value.readyForDml -isnot [bool] -or
        $Value.readyForDml -ne $false) {
        throw 'Read-only catalog response differs from reviewed shape.'
    }
    $taskIdentityNames = @('backendLogin','currentRole','database','databaseOidPresent',
        'postgres16','primary','readOnly','repeatableRead','sessionRole') | Sort-Object
    $taskCheckNames = @('appSelectOnly','exactSixteenColumns','idSequenceOwned',
        'maintenanceCatalogDelete','noInboundForeignKeys','noInheritance',
        'noRowSecurity','noRules','noTriggers','ordinaryPersistentTable',
        'ownerIsNotApp') | Sort-Object
    if ((@($Value.identityChecks.PSObject.Properties.Name | Sort-Object) -join '|') -cne
            ($taskIdentityNames -join '|') -or
        (@($Value.checks.PSObject.Properties.Name | Sort-Object) -join '|') -cne
            ($taskCheckNames -join '|')) {
        throw 'Read-only catalog check set changed.'
    }
    foreach ($taskFlag in @($Value.identityChecks.PSObject.Properties.Value) +
            @($Value.checks.PSObject.Properties.Value)) {
        if ($taskFlag -isnot [bool] -or $taskFlag -ne $true) {
            throw 'Read-only catalog gate failed.'
        }
    }
}

function ConvertTo-SafeCatalogReport {
    param($Value)
    # Project fixed fields only. Raw catalog rows, defaults, response extras,
    # origin settings, control-system identifier and credentials never leave.
    return [ordered]@{
        runMarker = $taskMarker
        databaseOid = [string]$Value.databaseOid
        catalogSha256 = [string]$Value.catalogSha256
        columnCount = 16
        identityChecks = [ordered]@{
            database = $true; currentRole = $true; sessionRole = $true
            backendLogin = $true; postgres16 = $true; readOnly = $true
            repeatableRead = $true; primary = $true; databaseOidPresent = $true
        }
        checks = [ordered]@{
            ordinaryPersistentTable = $true; exactSixteenColumns = $true
            ownerIsNotApp = $true; noRowSecurity = $true; noTriggers = $true
            noRules = $true; noInheritance = $true; noInboundForeignKeys = $true
            idSequenceOwned = $true; appSelectOnly = $true
            maintenanceCatalogDelete = $true
        }
        catalogSafe = $true
        controlSystemAclExecutable = [bool]$Value.controlSystemAclExecutable
        originIdentityVerified = $false
        readyForDml = $false
    }
}

function Invoke-BoundedWrangler {
    param([ValidateSet('deploy','delete')][string]$Operation,
        [string[]]$Arguments, [int]$TimeoutMs = 0)
    $taskDeadline = if ($TimeoutMs -gt 0) { $TimeoutMs } elseif ($Operation -ceq 'deploy') {
        90000
    } else { 45000 }
    if ($taskDeadline -lt 100 -or $taskDeadline -gt 90000) {
        throw 'Invalid Wrangler deadline.'
    }
    $taskNode = (Get-Command node -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source
    if (-not $taskNode -or -not (Test-Path -LiteralPath $taskNode -PathType Leaf)) {
        throw 'Trusted Node executable unavailable.'
    }
    $taskOutputId = [Guid]::NewGuid().ToString('N')
    $taskStdout = Join-Path $taskOutputRoot "$taskName-$Operation-$taskOutputId.stdout"
    $taskStderr = Join-Path $taskOutputRoot "$taskName-$Operation-$taskOutputId.stderr"
    if ((Test-Path -LiteralPath $taskStdout) -or
        (Test-Path -LiteralPath $taskStderr)) {
        throw 'Owned Wrangler output path already exists.'
    }
    $taskProcess = $null
    try {
        if ($Operation -ceq 'deploy') { $script:taskDeployDiagnostic.outcome = 'start-attempted' }
        $taskProcessArguments = @(('"' + $taskCli + '"'),$Operation) + $Arguments
        $taskProcess = Start-Process -FilePath $taskNode -ArgumentList $taskProcessArguments `
            -WorkingDirectory $taskRoot -RedirectStandardOutput $taskStdout `
            -RedirectStandardError $taskStderr -WindowStyle Hidden -PassThru
        if (-not $taskProcess.WaitForExit($taskDeadline)) {
            $script:taskProcessTreeUncertain = $true
            if ($Operation -ceq 'deploy') { $script:taskDeployDiagnostic.outcome = 'deadline-exceeded' }
            $taskStopped = $false
            try {
                $taskProcess.Kill($true)
                $taskStopped = $taskProcess.WaitForExit(5000)
            } catch { }
            if (-not $taskStopped) { throw 'Wrangler process tree termination was not confirmed.' }
            throw [TimeoutException]::new('Wrangler exceeded its wall-clock deadline.')
        }
        if ($Operation -ceq 'deploy') {
            $script:taskDeployDiagnostic.exitCode = if ($taskProcess.ExitCode -ge 0 -and
                $taskProcess.ExitCode -le 255) { [string]$taskProcess.ExitCode } else { 'other' }
            $script:taskDeployDiagnostic.outcome = if ($taskProcess.ExitCode -eq 0) {
                'cli-zero'
            } else { 'cli-nonzero' }
        }
        foreach ($taskFile in @($taskStdout,$taskStderr)) {
            $taskItem = Get-Item -LiteralPath $taskFile -Force
            if ($taskItem.PSIsContainer -or
                ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                $taskItem.Length -gt 65536) {
                if ($Operation -ceq 'deploy') { $script:taskDeployDiagnostic.outcome = 'output-oversize' }
                throw 'Wrangler output exceeded reviewed bounds.'
            }
        }
        if ($taskProcess.ExitCode -ne 0) { throw 'Wrangler operation failed.' }
        if ($Operation -ceq 'delete') { return $true }
        # Match only this fixed URL in memory, across two independently bounded streams.
        $taskOutput = (Get-Content -Raw -LiteralPath $taskStdout) + "`n" +
            (Get-Content -Raw -LiteralPath $taskStderr)
        $taskUrlFound = $taskOutput -cmatch [regex]::Escape($taskUrl)
        $taskOutput = $null
        $script:taskDeployDiagnostic.outcome = if ($taskUrlFound) {
            'url-confirmed'
        } else { 'url-missing' }
        return [bool]$taskUrlFound
    } finally {
        if ($taskProcess) {
            try { $taskProcess.Dispose() }
            catch { $script:taskCliOutputCleanupFailed = $true }
        }
        foreach ($taskFile in @($taskStdout,$taskStderr)) {
            if (Test-Path -LiteralPath $taskFile) {
                try {
                    $taskItem = Get-Item -LiteralPath $taskFile -Force
                    if ($taskItem.PSIsContainer -or
                        ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                        throw 'Owned Wrangler output is not a regular file.'
                    }
                    Remove-Item -LiteralPath $taskFile -Force
                    if (Test-Path -LiteralPath $taskFile) { throw 'Owned Wrangler output remains.' }
                } catch { $script:taskCliOutputCleanupFailed = $true }
            }
        }
    }
}

function Get-TemporaryTargetState {
    for ($taskAttempt = 0; $taskAttempt -lt 6; $taskAttempt++) {
        try {
            $taskResponse = Invoke-WebRequest -Uri $taskTargetApi -Headers $taskHeaders `
                -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 20
            $taskStatus = [int]$taskResponse.StatusCode
            if ($taskStatus -eq 200 -or ($taskStatus -eq 404 -and $taskAttempt -eq 5)) {
                return $taskStatus
            }
            if ($taskStatus -notin @(404,408,429,500,502,503,504)) {
                throw 'Temporary Worker state was unexpected.'
            }
        } catch {
            if ($taskAttempt -eq 5) { throw 'Temporary Worker state remained unavailable.' }
        }
        if ($taskAttempt -lt 5) { Start-Sleep -Seconds 1 }
    }
    throw 'Temporary Worker state remained unavailable.'
}
try {
    Assert-AppHyperdriveCacheDisabled
    $taskFormalBefore = Assert-MainWorker
    $taskStage = 'target-absence'
    $null = Invoke-ControlPlane $taskTargetApi @(404)
    $taskStage = 'deploy-readonly-worker'
    $taskAttempted = $true
    $taskDeployConfirmed = Invoke-BoundedWrangler -Operation deploy -Arguments @(
        '--config',('"' + $taskConfig + '"'),'--name',$taskName,
        '--var',"AUDIT_TOKEN_SHA256:$taskTokenHash",
        '--var',"AUDIT_EXPIRES_AT:$taskExpiry",'--var',"RUN_MARKER:$taskMarker",
        '--message',$taskMarker)
    if ($taskDeployConfirmed -ne $true) {
        throw 'Temporary Worker deployment outcome was not confirmed.'
    }
    $taskStage = 'verify-worker-ownership'
    for ($taskAttempt = 0; $taskAttempt -lt 5; $taskAttempt++) {
        try { $taskOwnedVersion = Get-OwnedAuditVersion; break }
        catch {
            if ($taskAttempt -eq 4) { throw }
            Start-Sleep -Seconds 1
        }
    }
    $taskStage = 'access-boundaries'
    for ($taskAttempt = 0; $taskAttempt -lt 5; $taskAttempt++) {
        $taskAnonymousStatus = [int](Get-PublicResponse "$taskUrl/audit").StatusCode
        if ($taskAnonymousStatus -eq 403) { break }
        if ($taskAnonymousStatus -ne 404 -or $taskAttempt -eq 4) {
            throw 'Temporary Worker anonymous boundary failed.'
        }
        Start-Sleep -Seconds 1
    }
    if ((Get-PublicResponse "$taskUrl/audit" $taskAuth 'Post').StatusCode -ne 404 -or
        (Get-PublicResponse "$taskUrl/audit?probe=1" $taskAuth).StatusCode -ne 404) {
        throw 'Temporary Worker access boundary failed.'
    }
    Assert-AppHyperdriveCacheDisabled
    $taskStage = 'single-readonly-snapshot'
    $taskReply = Get-PublicResponse "$taskUrl/audit" $taskAuth
    if ([int]$taskReply.StatusCode -ne 200 -or
        (($taskReply.Headers['Cache-Control'] -join ',') -notmatch 'no-store')) {
        throw 'Read-only snapshot response was not confirmed.'
    }
    if ([Text.Encoding]::UTF8.GetByteCount([string]$taskReply.Content) -gt 16384) {
        throw 'Read-only catalog response exceeded reviewed bounds.'
    }
    $taskRawReport = $taskReply.Content | ConvertFrom-Json -Depth 30
    Assert-CatalogReport $taskRawReport
    $taskReport = ConvertTo-SafeCatalogReport $taskRawReport
    $taskStage = 'catalog-captured-physical-origin-unverified'
} catch {
    $taskFailure = "DB-003 catalog audit did not complete at $taskStage."
} finally {
    if ($taskAttempted) {
        try {
            $taskPresentStatus = Get-TemporaryTargetState
            $taskDeleteFailed = $false
            if ($taskPresentStatus -eq 200) {
                $taskBeforeDeleteVersion = Get-OwnedAuditVersion
                if ($taskOwnedVersion -and $taskBeforeDeleteVersion -cne $taskOwnedVersion) {
                    throw 'Temporary Worker version changed before cleanup.'
                }
                try {
                    $taskDeleted = Invoke-BoundedWrangler -Operation delete -Arguments @(
                        $taskName,'--config',('"' + $taskConfig + '"'),'--force')
                } catch { $taskDeleteFailed = $true }
            } elseif ($taskPresentStatus -ne 404 -or $taskOwnedVersion) {
                throw 'Temporary Worker state changed before cleanup.'
            }
            Confirm-Dual404
            if ($taskDeleteFailed) { throw 'Temporary Worker deletion was not confirmed.' }
        } catch {
            $taskCleanupFailure = 'Temporary Worker cleanup requires independent verification.'
        }
    }
    try {
        Assert-AppHyperdriveCacheDisabled
        $taskFormalAfter = Assert-MainWorker
        $taskMainUnchanged = $taskFormalAfter.deploymentId -ceq $taskFormalBefore.deploymentId -and
            $taskFormalAfter.versionId -ceq $taskFormalBefore.versionId -and
            $taskFormalAfter.bindingSha256 -ceq $taskFormalBefore.bindingSha256 -and
            $taskFormalAfter.versionBindingSha256 -ceq $taskFormalBefore.versionBindingSha256
        if (-not $taskMainUnchanged) { throw 'Formal Worker changed during catalog audit.' }
    } catch {
        $taskFailure = 'Main Worker or app Hyperdrive state changed during DB-003 catalog audit.'
    }
    try {
        if (Test-Path -LiteralPath $taskLogPath) {
            $taskLogItem = Get-Item -LiteralPath $taskLogPath -Force
            if ($taskLogItem.PSIsContainer -or
                ($taskLogItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Owned Wrangler log is not a regular file.'
            }
            Remove-Item -LiteralPath $taskLogPath -Force
        }
        $taskLogDeleted = -not (Test-Path -LiteralPath $taskLogPath)
        if (-not $taskLogDeleted) { throw 'Owned log cleanup failed.' }
    } catch {
        $taskCleanupFailure = 'Owned Wrangler log cleanup requires independent verification.'
    }
    $taskToken = $null
    $taskAuth = $null
    $taskRawReport = $null
    if ($taskProcessTreeUncertain) {
        $taskFailure = 'Wrangler process tree needs independent verification.'
    }
    if ($taskCliOutputCleanupFailed) {
        $taskCleanupFailure = 'Wrangler output cleanup requires independent verification.'
    }
}

# Never print a response whose validation or cleanup failed, even if it parsed.
if ($taskFailure -or $taskCleanupFailure -or -not $taskMainUnchanged -or
    -not $taskControlPlane404 -or -not $taskPublic404) { $taskReport = $null }

[ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    sourceSha = $ExpectedSourceSha
    expectedMainVersion = $taskMainVersion
    expectedMainDeployment = $taskMainDeployment
    expectedMainBindingSha256 = $taskMainBindingSha
    appHyperdrive = $taskAppHyperdrive
    stage = $taskStage
    expectedOwnerMarkerSha256 = $taskMarkerSha
    observedVersionId = $taskObservedVersionId
    ownedVersionId = $taskOwnedVersion
    deployDiagnostic = $taskDeployDiagnostic
    report = $taskReport
    ownerDecision = 'not_assessed'
    validation = [ordered]@{
        catalogGatePassed = $null -eq $taskFailure
        fullPreimageCaptured = $false
        originIdentityVerified = $false
        readyForDml = $false
        reasonCode = 'business_preimage_and_physical_origin_unverified'
    }
    cleanup = [ordered]@{
        workerName = $taskName
        workerMayRemain = Test-WorkerMayRemain
        deleted = $taskDeleted
        controlPlane404 = $taskControlPlane404
        public404 = $taskPublic404
        mainUnchanged = $taskMainUnchanged
        wranglerLogDeleted = $taskLogDeleted
        processTreeCertain = -not $taskProcessTreeUncertain
        cliOutputDeleted = -not $taskCliOutputCleanupFailed
    }
    failure = $taskFailure
    cleanupFailure = $taskCleanupFailure
} | ConvertTo-Json -Depth 30
if ($taskFailure -or $taskCleanupFailure -or -not $taskMainUnchanged -or
    -not $taskControlPlane404 -or -not $taskPublic404) { exit 2 }
