# Fixed Admin addon phases only. Never retry an unknown POST result.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('AuthorityV2','LegacyRoleV3', IgnoreCase = $false)][string]$Phase,
    [switch]$InspectOnly,
    [switch]$Apply,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedSourceSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedInstallSqlSha256,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')][string]$ExpectedApiVersionId,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedApiBindingsSha256,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ApprovedPreflightFingerprint
)
$ErrorActionPreference = 'Stop'
if ([int][bool]$InspectOnly + [int][bool]$Apply -ne 1) { throw 'Select exactly one maintenance mode.' }
if ($Apply -and -not $ApprovedPreflightFingerprint) { throw 'Apply requires the approved read-only preflight fingerprint.' }
if ($Apply -and $ApprovedPreflightFingerprint -ceq ('0' * 64)) { throw 'Apply requires a nonzero reviewed fingerprint.' }
if ($InspectOnly -and $ApprovedPreflightFingerprint) { throw 'InspectOnly does not accept apply approval.' }
if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'Cloudflare credentials required.' }

$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRepository = Split-Path -Parent $taskRoot
$taskOperation = if ($Phase -ceq 'AuthorityV2') { 'admin-authority-install-v1-and-legacy-v2' } else { 'admin-legacy-role-install-v3' }
$taskConfigFile = if ($Phase -ceq 'AuthorityV2') { 'admin-authority-maintenance.wrangler.jsonc' } else { 'admin-legacy-role-maintenance.wrangler.jsonc' }
$taskTemplateName = if ($Phase -ceq 'AuthorityV2') { 'cinashop-admin-authority-maintenance-template' } else { 'cinashop-admin-legacy-role-maintenance-template' }
$taskWorkerMain = if ($Phase -ceq 'AuthorityV2') { 'AdminAuthorityMaintenanceWorker.ts' } else { 'AdminLegacyRoleMaintenanceWorker.ts' }
$taskRequiredAddon = if ($Phase -ceq 'AuthorityV2') { 'legacy-admin-v2' } else { 'legacy-role-v3' }
$taskConfig = Join-Path $taskRoot ('test/integration/' + $taskConfigFile)
$taskCli = Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
if (-not (Test-Path -LiteralPath $taskCli)) { throw 'Reviewed Wrangler dependency is not installed.' }
$taskWranglerVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'node_modules/wrangler/package.json') -Raw | ConvertFrom-Json).version
if ($taskWranglerVersion -cne '4.131.0') { throw 'Only reviewed Wrangler 4.131.0 is supported.' }
$taskGitSha = (& git -C $taskRepository rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $taskGitSha -cne $ExpectedSourceSha) { throw 'Reviewed source commit mismatch.' }
$taskDirty = @(& git -C $taskRepository status --porcelain=v1)
if ($LASTEXITCODE -ne 0 -or $taskDirty.Count -ne 0) { throw 'Maintenance source worktree must be clean.' }

$taskConfigObject = Get-Content -LiteralPath $taskConfig -Raw | ConvertFrom-Json
if ($taskConfigObject.name -cne $taskTemplateName -or $taskConfigObject.main -cne $taskWorkerMain -or
    $taskConfigObject.vars.APPLY_ARMED -cne 'false' -or $taskConfigObject.workers_dev -ne $true -or
    $taskConfigObject.routes -or $taskConfigObject.services -or $taskConfigObject.triggers) {
    throw 'Only the reviewed inert temporary Worker template is supported.'
}
function ConvertTo-OrdinalBindingStrings {
    param([string[]]$Values)
    [string[]]$taskStrings = @($Values)
    [Array]::Sort($taskStrings, [StringComparer]::Ordinal)
    return $taskStrings
}

$taskAllowedConfigKeys = @(ConvertTo-OrdinalBindingStrings -Values @('$schema','name','main','compatibility_date',
    'compatibility_flags','workers_dev','limits','observability','vars','hyperdrive'))
$taskActualConfigKeys = @(ConvertTo-OrdinalBindingStrings -Values @($taskConfigObject.PSObject.Properties.Name))
$taskAllowedVars = @(ConvertTo-OrdinalBindingStrings -Values @('AUDIT_TOKEN_SHA256','AUDIT_EXPIRES_AT','SOURCE_SHA',
    'EXPECTED_INSTALL_SQL_SHA256','RUN_MARKER','APPLY_ARMED','APPROVED_PREFLIGHT_SHA256'))
$taskActualVars = @(ConvertTo-OrdinalBindingStrings -Values @($taskConfigObject.vars.PSObject.Properties.Name))
$taskExpectedFlags = @(ConvertTo-OrdinalBindingStrings -Values @('nodejs_compat','global_fetch_strictly_public','enable_request_signal'))
$taskActualFlags = @(ConvertTo-OrdinalBindingStrings -Values @($taskConfigObject.compatibility_flags))
if (($taskActualConfigKeys -join '|') -cne ($taskAllowedConfigKeys -join '|') -or
    ($taskActualVars -join '|') -cne ($taskAllowedVars -join '|') -or
    ($taskActualFlags -join '|') -cne ($taskExpectedFlags -join '|') -or
    $taskConfigObject.compatibility_date -cne '2026-09-10' -or
    $taskConfigObject.limits.cpu_ms -ne 10000 -or
    $taskConfigObject.observability.enabled -ne $true -or
    $taskConfigObject.observability.logs.invocation_logs -ne $false) {
    throw 'Temporary Worker template keys, flags, limits or logging changed.'
}
foreach ($taskVarName in $taskAllowedVars | Where-Object { $_ -cne 'APPLY_ARMED' }) {
    if ([string]$taskConfigObject.vars.$taskVarName -cne '') { throw 'The reviewed template must contain no usable pins or token.' }
}

$taskExpectedBindings = @(
    @{ name = 'HYPERDRIVE_MAINTENANCE'; id = '9748c294e21c49a99579c9cef70102e0' },
    @{ name = 'HYPERDRIVE'; id = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' },
    @{ name = 'HYPERDRIVE_ADMIN'; id = '446e94a4de0143f58c8e5178ec55db8b' }
)
$taskConfigured = @(ConvertTo-OrdinalBindingStrings -Values @($taskConfigObject.hyperdrive | ForEach-Object { "{0}:{1}" -f $_.binding,$_.id }))
$taskReviewed = @(ConvertTo-OrdinalBindingStrings -Values @($taskExpectedBindings | ForEach-Object { "{0}:{1}" -f $_.name,$_.id }))
if ($taskConfigured.Count -ne 3 -or ($taskConfigured -join '|') -cne ($taskReviewed -join '|')) {
    throw 'Maintenance Hyperdrive binding config differs from reviewed IDs.'
}

$taskPrefix = if ($Phase -ceq 'AuthorityV2') { 'cinashop-aao-v2-maint-' } else { 'cinashop-aao-v3-maint-' }
$taskName = $taskPrefix + [Guid]::NewGuid().ToString('N').Substring(0, 16)
$taskAccount = '7ea8e46d8210bad342fa7595f7935fea'
$taskApi = "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$taskName"
$taskExpectedPublicUrl = "https://$taskName.cinagroup.workers.dev"
$taskApiHeaders = @{ Authorization = 'Bearer ' + $env:CLOUDFLARE_API_TOKEN }
$taskMainApi = "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/cinashop-api"
$taskSettingsApi = "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/cinashop-api/settings"
$taskToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskTokenHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskMarker = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskExpiry = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$taskApplyArmed = if ($Apply) { 'true' } else { 'false' }
$taskApprovedVariable = if ($Apply) { $ApprovedPreflightFingerprint } else { '0' * 64 }
$taskAuth = @{ 'X-Audit-Token' = $taskToken }
$taskWrite = @{ 'X-Audit-Token' = $taskToken;
    'X-Migration-Operation' = $taskOperation;
    'X-Preflight-SHA256' = $ApprovedPreflightFingerprint }
$taskReceiptDir = Join-Path $taskRepository ('.cache/' + $taskName)
$null = New-Item -ItemType Directory -Path $taskReceiptDir
$taskOriginalEnvironment = @{}
foreach ($taskEnvName in @('CLOUDFLARE_ACCOUNT_ID','WRANGLER_SEND_METRICS','WRANGLER_LOG_PATH')) {
    $taskOriginalEnvironment[$taskEnvName] = [Environment]::GetEnvironmentVariable($taskEnvName,'Process')
}
$env:CLOUDFLARE_ACCOUNT_ID = $taskAccount
$env:WRANGLER_SEND_METRICS = 'false'
$taskLogPath = Join-Path $taskReceiptDir 'wrangler-owned.log'
$env:WRANGLER_LOG_PATH = $taskLogPath
$taskStage = 'control-plane-baseline'
$taskFailure = $null
$taskHttpFailures = [Collections.Generic.List[object]]::new()
$taskFailureDetail = $null
$taskCleanupFailureDetail = $null
$taskMainFailureDetail = $null
$taskAttempted = $false
$taskApplyAttempted = $false
$taskDeleted = $false
$taskMissing = $false
$taskPublicMissing = $false
$taskPrefixesMissing = $false
$taskLogRemoved = $false
$taskOwned = $false
$taskOwnedVersionId = $null
$taskMainUnchanged = $false
$taskUrl = $null
$taskBefore = $null
$taskApplyResult = $null
$taskAfter = $null
$taskFormalBefore = $null
$taskFormalAfter = $null
$taskHyperdriveBefore = $null
$taskHyperdriveAfter = $null
$taskProcessTreeUncertain = $false
$taskCliOutputCleanupFailed = $false
$taskCliDiagnostics = @{
    deploy = [ordered]@{ outcome = 'not-started'; exitCode = $null }
    delete = [ordered]@{ outcome = 'not-started'; exitCode = $null }
}
$taskAccess = @{}
$taskExpectedVersionBindings = @(ConvertTo-OrdinalBindingStrings -Values @(
    'HYPERDRIVE_MAINTENANCE:hyperdrive:9748c294e21c49a99579c9cef70102e0',
    'HYPERDRIVE:hyperdrive:ba7faa6680cd48d4b3a1d36a7a5fc8f7',
    'HYPERDRIVE_ADMIN:hyperdrive:446e94a4de0143f58c8e5178ec55db8b',
    'AUDIT_TOKEN_SHA256:plain_text', 'AUDIT_EXPIRES_AT:plain_text',
    'SOURCE_SHA:plain_text', 'EXPECTED_INSTALL_SQL_SHA256:plain_text',
    'RUN_MARKER:plain_text', 'APPLY_ARMED:plain_text',
    'APPROVED_PREFLIGHT_SHA256:plain_text'
))
$taskExpectedPlainVariables = @{
    AUDIT_TOKEN_SHA256 = $taskTokenHash; AUDIT_EXPIRES_AT = $taskExpiry;
    SOURCE_SHA = $ExpectedSourceSha; EXPECTED_INSTALL_SQL_SHA256 = $ExpectedInstallSqlSha256;
    RUN_MARKER = $taskMarker; APPLY_ARMED = $taskApplyArmed;
    APPROVED_PREFLIGHT_SHA256 = $taskApprovedVariable
}

function New-SafeRequestFailure {
    param([string]$Type,[Nullable[int]]$Status)
    $taskError = [InvalidOperationException]::new('Reviewed HTTP result was not confirmed.')
    $taskError.Data['safeType'] = $Type
    if ($null -ne $Status) { $taskError.Data['safeStatus'] = [int]$Status }
    return $taskError
}

function Invoke-BoundedWrangler {
    param([ValidateSet('deploy','delete')][string]$Operation,[string[]]$Arguments)
    $taskNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    if (-not $taskNode -or -not (Test-Path -LiteralPath $taskNode)) { throw 'Trusted Node executable unavailable.' }
    $taskDeadlineMs = if ($Operation -ceq 'deploy') { 60000 } else { 30000 }
    $taskOutputId = [Guid]::NewGuid().ToString('N')
    $taskStdout = Join-Path $taskReceiptDir ($Operation + '-' + $taskOutputId + '.stdout')
    $taskStderr = Join-Path $taskReceiptDir ($Operation + '-' + $taskOutputId + '.stderr')
    $taskProcess = $null
    $taskClock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $script:taskCliDiagnostics[$Operation].outcome = 'start-attempted'
        # Only fixed flags, reviewed paths and validated hex pins enter these arguments.
        $taskProcessArguments = @(('"' + $taskCli + '"'),$Operation) + $Arguments
        $taskProcess = Start-Process -FilePath $taskNode -ArgumentList $taskProcessArguments `
            -WorkingDirectory $taskRoot -RedirectStandardOutput $taskStdout `
            -RedirectStandardError $taskStderr -WindowStyle Hidden -PassThru
        while (-not $taskProcess.WaitForExit(250)) {
            $taskOversize = @($taskStdout,$taskStderr | Where-Object {
                (Test-Path -LiteralPath $_) -and (Get-Item -LiteralPath $_).Length -gt 65536
            }).Count -gt 0
            if ($taskOversize -or $taskClock.ElapsedMilliseconds -ge $taskDeadlineMs) {
                $script:taskCliDiagnostics[$Operation].outcome = if ($taskOversize) { 'output-oversize' } else { 'deadline-exceeded' }
                # Root termination does not prove all descendants stopped. Never claim cleanup success.
                $script:taskProcessTreeUncertain = $true
                try { $taskProcess.Kill($true); $null = $taskProcess.WaitForExit(5000) } catch { }
                throw 'Wrangler operation exceeded its reviewed process bounds.'
            }
        }
        $script:taskCliDiagnostics[$Operation].exitCode = if ($taskProcess.ExitCode -ge 0 -and $taskProcess.ExitCode -le 255) {
            [string]$taskProcess.ExitCode
        } else { 'other' }
        $script:taskCliDiagnostics[$Operation].outcome = if ($taskProcess.ExitCode -eq 0) { 'cli-zero' } else { 'cli-nonzero' }
        if ($taskProcess.ExitCode -ne 0) { throw 'Wrangler operation did not complete successfully.' }
        $taskParts = @()
        foreach ($taskFile in @($taskStdout,$taskStderr)) {
            $taskStream = [IO.FileStream]::new($taskFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
            try {
                $taskBuffer = [byte[]]::new(65537)
                $taskRead = 0
                while ($taskRead -lt $taskBuffer.Length) {
                    $taskCount = $taskStream.Read($taskBuffer,$taskRead,$taskBuffer.Length - $taskRead)
                    if ($taskCount -eq 0) { break }
                    $taskRead += $taskCount
                }
                if ($taskRead -gt 65536) {
                    $script:taskCliDiagnostics[$Operation].outcome = 'output-oversize'
                    throw 'Wrangler output exceeded reviewed bounds.'
                }
                $taskParts += [Text.Encoding]::UTF8.GetString($taskBuffer,0,$taskRead)
            } finally { $taskStream.Dispose() }
        }
        if ($Operation -ceq 'deploy') {
            $taskUrlFound = ($taskParts -join "`n") -cmatch [regex]::Escape($taskExpectedPublicUrl)
            $script:taskCliDiagnostics[$Operation].outcome = if ($taskUrlFound) { 'url-confirmed' } else { 'url-missing' }
            return [bool]$taskUrlFound
        }
        return $true
    } finally {
        $taskParts = $null
        $taskClock.Stop()
        if ($taskProcess) { $taskProcess.Dispose() }
        foreach ($taskFile in @($taskStdout,$taskStderr)) {
            if (Test-Path -LiteralPath $taskFile) {
                try { Remove-Item -LiteralPath $taskFile -Force }
                catch { $script:taskCliOutputCleanupFailed = $true }
            }
        }
    }
}

function Get-SafeFailureDetail {
    param([string]$Stage,$ErrorRecord)
    $taskType = if ($Stage -eq 'single-apply') { 'write-response-unconfirmed' } else { 'validation' }
    $taskStatus = $null
    $taskException = $ErrorRecord.Exception
    while ($taskException) {
        if ($taskException.Data['safeType']) {
            $taskType = [string]$taskException.Data['safeType']
            if ($null -ne $taskException.Data['safeStatus']) {
                $taskStatus = [int]$taskException.Data['safeStatus']
            }
            break
        }
        $taskException = $taskException.InnerException
    }
    return [ordered]@{ stage = $Stage; type = $taskType; status = $taskStatus }
}

# GET only. A missing response or short propagation delay is safe to retry; writes never call this helper.
function Invoke-ReadOnlyGet {
    param([string]$Uri,[hashtable]$Headers,[int]$TimeoutSec,
        [int[]]$ExpectedStatus = @(200),[int[]]$RetryStatus = @(408,429,502,503,504))
    $taskDelays = @(2,4,8)
    for ($taskAttempt = 0; $taskAttempt -le $taskDelays.Count; $taskAttempt++) {
        $taskResponse = $null
        $taskStatus = $null
        try {
            $taskResponse = Invoke-WebRequest -Uri $Uri -Method Get -Headers $Headers `
                -SkipHttpErrorCheck -TimeoutSec $TimeoutSec
            if ($null -ne $taskResponse -and $null -ne $taskResponse.StatusCode) {
                $taskStatus = [int]$taskResponse.StatusCode
            }
        } catch {
            # Keep only the numeric status, if supplied. Never persist URI, body, headers or exception text.
            if ($null -ne $_.Exception.Response -and
                $null -ne $_.Exception.Response.StatusCode) {
                try { $taskStatus = [int]$_.Exception.Response.StatusCode }
                catch { $taskStatus = $null }
            }
        }
        if ($null -ne $taskResponse -and $null -ne $taskStatus -and
            $ExpectedStatus -contains $taskStatus) {
            return $taskResponse
        }
        $taskRetryable = if ($null -eq $taskStatus) { $true } else {
            $RetryStatus -contains $taskStatus }
        if ($taskRetryable -and $taskAttempt -lt $taskDelays.Count) {
            Start-Sleep -Seconds $taskDelays[$taskAttempt]
            continue
        }
        if ($null -eq $taskStatus) {
            throw (New-SafeRequestFailure -Type 'transport-no-status')
        }
        throw (New-SafeRequestFailure -Type 'http-status' -Status $taskStatus)
    }
}

function Get-ReadOnlyJson {
    param([string]$Uri,[hashtable]$Headers,[int]$TimeoutSec,
        [int[]]$RetryStatus = @(408,429,502,503,504))
    $taskResponse = Invoke-ReadOnlyGet -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec `
        -ExpectedStatus @(200) -RetryStatus $RetryStatus
    return ($taskResponse.Content | ConvertFrom-Json -Depth 20 -DateKind String)
}

function Get-BindingFingerprint {
    param($Bindings)
    $taskMetadata = @(ConvertTo-OrdinalBindingStrings -Values @($Bindings | ForEach-Object {
        "{0}:{1}:{2}:{3}:{4}" -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name
    }))
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes(($taskMetadata -join [char]10)))).ToLowerInvariant()
}

function Get-FormalSnapshot {
    $taskDeployments = Get-ReadOnlyJson -Uri "$taskMainApi/deployments" -Headers $taskApiHeaders -TimeoutSec 20
    $taskRows = if ($taskDeployments.result -is [array]) { @($taskDeployments.result) } else { @($taskDeployments.result.deployments) }
    $taskLatest = $taskRows | Sort-Object created_on -Descending | Select-Object -First 1
    if (-not $taskLatest -or @($taskLatest.versions).Count -ne 1 -or
        $taskLatest.versions[0].percentage -ne 100 -or
        $taskLatest.versions[0].version_id -cne $ExpectedApiVersionId) {
        throw 'Formal API version or traffic differs from the reviewed baseline.'
    }
    $taskSettings = Get-ReadOnlyJson -Uri "$taskMainApi/settings" -Headers $taskApiHeaders -TimeoutSec 20
    $taskBindings = @($taskSettings.result.bindings)
    $taskHyperdrive = @(ConvertTo-OrdinalBindingStrings -Values @($taskBindings | Where-Object type -eq 'hyperdrive' | ForEach-Object { "{0}:{1}" -f $_.name,$_.id }))
    $taskExpectedMain = @(ConvertTo-OrdinalBindingStrings -Values @('HYPERDRIVE:ba7faa6680cd48d4b3a1d36a7a5fc8f7','HYPERDRIVE_ADMIN:446e94a4de0143f58c8e5178ec55db8b'))
    $taskSettingsSha = Get-BindingFingerprint $taskBindings
    $taskVersion = Get-ReadOnlyJson -Uri "$taskMainApi/versions/$ExpectedApiVersionId" -Headers $taskApiHeaders -TimeoutSec 20
    $taskVersionBindings = @($taskVersion.result.resources.bindings)
    $taskVersionSha = Get-BindingFingerprint $taskVersionBindings
    if ($taskBindings.Count -ne 31 -or $taskVersionBindings.Count -ne 31 -or
        ($taskHyperdrive -join '|') -cne ($taskExpectedMain -join '|') -or
        $taskSettingsSha -cne $ExpectedApiBindingsSha256 -or
        $taskVersionSha -cne $ExpectedApiBindingsSha256) {
        throw 'Formal API binding metadata differs from the reviewed baseline.'
    }
    return [ordered]@{ deploymentId = [string]$taskLatest.id; versionId = $ExpectedApiVersionId;
        traffic = 100; bindingCount = 31; bindingSha256 = $taskSettingsSha; versionBindingSha256 = $taskVersionSha }
}

function Get-HyperdriveSnapshot {
    $taskRows = @()
    $taskRoute = $null
    foreach ($taskBinding in $taskExpectedBindings) {
        $taskConfigResult = Get-ReadOnlyJson -Uri "https://api.cloudflare.com/client/v4/accounts/$taskAccount/hyperdrive/configs/$($taskBinding.id)" -Headers $taskApiHeaders -TimeoutSec 20
        $taskOrigin = $taskConfigResult.result.origin
        $taskExpectedLogin = switch ($taskBinding.name) {
            'HYPERDRIVE_MAINTENANCE' { 'postgres' }
            'HYPERDRIVE' { 'cinashop_app_v1' }
            'HYPERDRIVE_ADMIN' { 'cinashop_admin_v1' }
        }
        if ($taskConfigResult.success -ne $true -or $taskConfigResult.result.id -cne $taskBinding.id -or
            [string]::IsNullOrWhiteSpace([string]$taskConfigResult.result.modified_on) -or
            -not $taskOrigin -or $taskOrigin.database -cne 'postgres' -or
            $taskOrigin.user -cne $taskExpectedLogin -or
            -not $taskOrigin.scheme -or (-not $taskOrigin.host -and -not $taskOrigin.service_id) -or
            $taskConfigResult.result.caching.disabled -ne $true) {
            throw 'All three fixed Hyperdrive routes must use the expected LOGINs with caching disabled.'
        }
        $taskRouteMetadata = @([string]$taskOrigin.scheme,[string]$taskOrigin.host,
            [string]$taskOrigin.port,[string]$taskOrigin.service_id,[string]$taskOrigin.database) -join '|'
        $taskRouteSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
            [Text.Encoding]::UTF8.GetBytes($taskRouteMetadata))).ToLowerInvariant()
        if ($taskRoute -and $taskRoute -cne $taskRouteSha) { throw 'Fixed Hyperdrive connections target different routes.' }
        $taskRoute = $taskRouteSha
        $taskRows += [ordered]@{ binding = $taskBinding.name; id = $taskBinding.id; cachingDisabled = $true;
            modifiedOn = [string]$taskConfigResult.result.modified_on; routeSha256 = $taskRouteSha }
    }
    return $taskRows
}

function Assert-TemporaryPrefixesAbsent {
    $taskList = Get-ReadOnlyJson -Uri "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts" -Headers $taskApiHeaders -TimeoutSec 20
    if ($taskList.success -ne $true -or $taskList.result -isnot [array] -or
        ($null -ne $taskList.result_info.total_count -and $taskList.result_info.total_count -ne @($taskList.result).Count)) {
        throw 'Complete temporary Worker inventory was not confirmed.'
    }
    $taskLeft = @($taskList.result | Where-Object {
        $_.id -clike 'cinashop-aao-v2-maint-*' -or $_.id -clike 'cinashop-aao-v3-maint-*'
    })
    if ($taskLeft.Count -ne 0) { throw 'An Admin maintenance Worker already exists or remains after cleanup.' }
}

function Get-OwnedVersionId {
    $taskDeployments = Get-ReadOnlyJson -Uri "$taskApi/deployments" -Headers $taskApiHeaders `
        -TimeoutSec 20 -RetryStatus @(404,408,429,502,503,504)
    $taskRows = if ($taskDeployments.result -is [array]) {
        @($taskDeployments.result)
    } else { @($taskDeployments.result.deployments) }
    $taskLatest = $taskRows | Sort-Object created_on -Descending | Select-Object -First 1
    $taskFull = @($taskLatest.versions | Where-Object { $_.percentage -eq 100 })
    if (-not $taskLatest -or $taskFull.Count -ne 1) {
        throw 'Temporary Worker deployment traffic identity changed.'
    }
    $taskVersionId = $taskFull[0].version_id
    $taskVersion = Get-ReadOnlyJson -Uri "$taskApi/versions/$taskVersionId" `
        -Headers $taskApiHeaders -TimeoutSec 20 -RetryStatus @(404,408,429,502,503,504)
    if ($taskVersion.result.annotations.'workers/message' -cne $taskMarker) {
        throw 'Temporary Worker version marker changed.'
    }
    $taskProjection = @(ConvertTo-OrdinalBindingStrings -Values @($taskVersion.result.resources.bindings | ForEach-Object {
        if ($_.type -eq 'hyperdrive') { "{0}:{1}:{2}" -f $_.name,$_.type,$_.id }
        else { "{0}:{1}" -f $_.name,$_.type }
    }))
    if ($taskProjection.Count -ne $taskExpectedVersionBindings.Count -or
        ($taskProjection -join '|') -cne ($taskExpectedVersionBindings -join '|')) {
        throw 'Temporary Worker version binding projection changed.'
    }
    foreach ($taskVariable in @($taskVersion.result.resources.bindings | Where-Object type -eq 'plain_text')) {
        if (-not $taskExpectedPlainVariables.ContainsKey([string]$taskVariable.name) -or
            [string]$taskVariable.text -cne [string]$taskExpectedPlainVariables[$taskVariable.name]) {
            throw 'Temporary Worker version fixed variables changed.'
        }
    }
    return $taskVersionId
}

function Get-SafeMaintenanceHttpFailure {
    param([string]$Path,[string]$Method,$Response)
    $taskSafeFailure = [ordered]@{
        path = if (@('/preflight', '/apply', '/postflight') -ccontains $Path) { $Path } else { $null }
        method = if (@('Get', 'Post') -ccontains $Method) { $Method } else { $null }
        httpStatus = [int]$Response.StatusCode
        noStore = $Response.Headers['Cache-Control'] -contains 'no-store'
        error = $null
        stage = $null
        sqlState = $null
    }
    # Only exact Worker constants and a five-character SQLSTATE may leave this function.
    # Never save raw response content, arbitrary error text, headers, tokens or SQL.
    try {
        $taskSafeJson = $Response.Content | ConvertFrom-Json -Depth 20
        $taskAllowedErrors = @('forbidden', 'not found', 'method not allowed',
            'apply is not armed in this deployment', 'explicit operation and empty body required',
            'fixed source or SQL digest missing', 'reviewed installation SQL digest mismatch',
            'approved preflight fingerprint required',
            'current preflight differs from the reviewed evidence',
            'current locked preflight differs from the reviewed evidence',
            'outcome unconfirmed; inspect read-only before any further action')
        if ($taskSafeJson.error -is [string] -and $taskAllowedErrors -ccontains $taskSafeJson.error) {
            $taskSafeFailure.error = $taskSafeJson.error
        }
        if ($taskSafeJson.stage -is [string] -and
            @('preflight', 'single_apply', 'postflight') -ccontains $taskSafeJson.stage) {
            $taskSafeFailure.stage = $taskSafeJson.stage
        }
        if ($taskSafeJson.sqlState -is [string] -and $taskSafeJson.sqlState -cmatch '^[0-9A-Z]{5}$') {
            $taskSafeFailure.sqlState = $taskSafeJson.sqlState
        }
    } catch { }
    return [pscustomobject]$taskSafeFailure
}

function Get-MaintenanceJson {
    param([string]$Path,[string]$Method,[hashtable]$Headers)
    if ($Method -ceq 'Get') {
        $taskResponse = Invoke-ReadOnlyGet -Uri "$taskUrl$Path" -Headers $Headers `
            -TimeoutSec 30 -ExpectedStatus @(200) -RetryStatus @(404,408,429,502,503,504)
    } elseif ($Method -ceq 'Post') {
        # The apply POST can have committed even if its response is lost. Never retry it.
        $taskResponse = Invoke-WebRequest -Uri "$taskUrl$Path" -Method Post -Headers $Headers `
            -SkipHttpErrorCheck -TimeoutSec 30
    } else { throw 'Unsupported maintenance method.' }
    if ($null -eq $taskResponse -or $null -eq $taskResponse.StatusCode) {
        $taskType = if ($Method -ceq 'Post') { 'write-response-unconfirmed' } else { 'transport-no-status' }
        throw (New-SafeRequestFailure -Type $taskType)
    }
    if ([int]$taskResponse.StatusCode -ne 200) {
        $taskHttpFailures.Add((Get-SafeMaintenanceHttpFailure $Path $Method $taskResponse))
        throw (New-SafeRequestFailure -Type 'http-status' -Status ([int]$taskResponse.StatusCode))
    }
    if ($taskResponse.Headers['Cache-Control'] -notcontains 'no-store') {
        $taskHttpFailures.Add((Get-SafeMaintenanceHttpFailure $Path $Method $taskResponse))
        throw (New-SafeRequestFailure -Type 'response-validation' -Status 200)
    }
    try { return ($taskResponse.Content | ConvertFrom-Json -Depth 20) }
    catch {
        $taskHttpFailures.Add((Get-SafeMaintenanceHttpFailure $Path $Method $taskResponse))
        throw (New-SafeRequestFailure -Type 'response-validation' -Status 200)
    }
}

function Assert-ReadOnlyPreflight {
    param($Value)
    if ($Value.operation -cne $taskOperation -or
        $Value.ready -ne $true -or
        $Value.sourceSha -cne $ExpectedSourceSha -or
        $Value.installSqlSha256 -cne $ExpectedInstallSqlSha256 -or
        $Value.runMarker -cne $taskMarker -or
        $Value.applyArmed -ne [bool]$Apply -or
        $Value.fingerprint -cnotmatch '^[0-9a-f]{64}$' -or
        $Value.target.database -cne 'postgres' -or
        $Value.target.maintenance -cne 'postgres' -or
        $Value.target.app -cne 'cinashop_app_v1' -or
        $Value.target.admin -cne 'cinashop_admin_v1' -or
        $Value.maintenance.ready -ne $true -or $Value.app.ready -ne $true -or
        $Value.admin.ready -ne $true -or
        $Value.maintenance.identity.primary -ne $true -or
        $Value.app.identity.primary -ne $true -or $Value.admin.identity.primary -ne $true -or
        $Value.maintenance.identity.originSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $Value.maintenance.identity.originSha256 -cne $Value.app.identity.originSha256 -or
        $Value.maintenance.identity.originSha256 -cne $Value.admin.identity.originSha256) {
        throw 'Read-only preflight did not match reviewed target, physical primary and authority.'
    }
}

try {
    $taskFormalBefore = Get-FormalSnapshot
    $taskHyperdriveBefore = @(Get-HyperdriveSnapshot)
    Assert-TemporaryPrefixesAbsent
    $taskStage = 'target-absence'
    $null = Invoke-ReadOnlyGet -Uri $taskApi -Headers $taskApiHeaders -TimeoutSec 20 `
        -ExpectedStatus @(404)
    $taskStage = 'deploy'
    $taskAttempted = $true
    $taskDeploy = Invoke-BoundedWrangler -Operation deploy -Arguments @(
        '--config',('"' + $taskConfig + '"'),'--name',$taskName,
        '--var',"AUDIT_TOKEN_SHA256:$taskTokenHash",'--var',"AUDIT_EXPIRES_AT:$taskExpiry",
        '--var',"SOURCE_SHA:$ExpectedSourceSha",'--var',"EXPECTED_INSTALL_SQL_SHA256:$ExpectedInstallSqlSha256",
        '--var',"RUN_MARKER:$taskMarker",'--var',"APPLY_ARMED:$taskApplyArmed",
        '--var',"APPROVED_PREFLIGHT_SHA256:$taskApprovedVariable",'--message',$taskMarker)
    if (-not $taskDeploy) { throw 'Temporary maintenance URL unavailable.' }
    $taskUrl = $taskExpectedPublicUrl
    $taskStage = 'verify-deployment'
    $taskOwnedVersionId = Get-OwnedVersionId
    $taskOwned = $true

    $taskStage = 'access-boundaries'
    $taskAccess.anonymous = [int](Invoke-ReadOnlyGet -Uri "$taskUrl/preflight" `
        -Headers @{} -TimeoutSec 20 -ExpectedStatus @(403) `
        -RetryStatus @(404,408,429,502,503,504)).StatusCode
    $taskAccess.wrongMethod = [int](Invoke-ReadOnlyGet -Uri "$taskUrl/apply" `
        -Headers $taskAuth -TimeoutSec 20 -ExpectedStatus @(405) `
        -RetryStatus @(404,408,429,502,503,504)).StatusCode
    $taskAccess.missingOperation = [int](Invoke-WebRequest -Uri "$taskUrl/apply" -Method Post `
        -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskAccess.query = [int](Invoke-ReadOnlyGet -Uri "$taskUrl/preflight?sql=none" `
        -Headers $taskAuth -TimeoutSec 20 -ExpectedStatus @(404)).StatusCode
    $taskExpectedMissingOperation = if ($Apply) { 400 } else { 403 }
    if ($taskAccess.anonymous -ne 403 -or $taskAccess.wrongMethod -ne 405 -or
        $taskAccess.missingOperation -ne $taskExpectedMissingOperation -or $taskAccess.query -ne 404) {
        throw 'Temporary maintenance access boundary failed.'
    }

    $taskStage = 'readonly-preflight'
    $taskBefore = Get-MaintenanceJson '/preflight' 'Get' $taskAuth
    Assert-ReadOnlyPreflight $taskBefore
    if ($Apply) {
        if ($taskBefore.fingerprint -cne $ApprovedPreflightFingerprint) {
            throw 'Current preflight fingerprint differs from reviewed evidence.'
        }
        $taskStage = 'single-apply'
        $taskApplyAttempted = $true
        $taskApplyResult = Get-MaintenanceJson '/apply' 'Post' $taskWrite
        if ($taskApplyResult.operation -cne $taskOperation -or
            $taskApplyResult.committed -ne $true -or
            $taskApplyResult.sourceSha -cne $ExpectedSourceSha -or
            $taskApplyResult.installSqlSha256 -cne $ExpectedInstallSqlSha256 -or
            $taskApplyResult.runMarker -cne $taskMarker -or
            $taskApplyResult.approvedPreflightFingerprint -cne $ApprovedPreflightFingerprint -or
            $taskApplyResult.protectedDataObservationUnchanged -ne $true) {
            throw 'Single apply response did not confirm reviewed transaction.'
        }
        $taskStage = 'independent-readonly-postflight'
        $taskAfter = Get-MaintenanceJson '/postflight' 'Get' $taskAuth
        Assert-ReadOnlyPreflight $taskAfter
        if ($taskAfter.maintenance.addon -cne $taskRequiredAddon) {
            throw 'Independent read-only postflight did not confirm the exact addon version.'
        }
    }
    $taskStage = 'completed'
} catch {
    $taskFailureDetail = Get-SafeFailureDetail -Stage $taskStage -ErrorRecord $_
    $taskFailure = 'Maintenance outcome not fully confirmed; inspect the database read-only before any new mutation.'
    if ($taskApplyAttempted -and $taskUrl -and -not $taskAfter) {
        try { $taskAfter = Get-MaintenanceJson '/postflight' 'Get' $taskAuth }
        catch { $taskAfter = $null }
    }
} finally {
    if ($taskAttempted) {
        $taskCleanupStage = 'cleanup-presence'
        try {
            $taskPresent = Invoke-ReadOnlyGet -Uri $taskApi -Headers $taskApiHeaders `
                -TimeoutSec 20 -ExpectedStatus @(200,404)
            if ([int]$taskPresent.StatusCode -eq 404) {
                $taskMissing = $true
                if ($taskOwnedVersionId) { throw 'Previously verified temporary Worker disappeared before cleanup.' }
            } elseif ([int]$taskPresent.StatusCode -eq 200) {
                $taskCleanupStage = 'cleanup-ownership'
                if ($taskProcessTreeUncertain) { throw 'Process tree uncertainty prevents automatic Worker deletion.' }
                $taskBeforeDeleteVersionId = Get-OwnedVersionId
                $taskOwned = $taskBeforeDeleteVersionId -and
                    (-not $taskOwnedVersionId -or $taskBeforeDeleteVersionId -ceq $taskOwnedVersionId)
                if (-not $taskOwned) { throw 'Temporary target version changed before deletion.' }
                $taskCleanupStage = 'cleanup-delete'
                $taskDelete = Invoke-BoundedWrangler -Operation delete -Arguments @($taskName,'--config',('"' + $taskConfig + '"'),'--force')
                $taskDeleted = [bool]$taskDelete
                if (-not $taskDeleted) { throw 'Temporary Worker deletion unconfirmed.' }
                $taskCleanupStage = 'cleanup-absence'
                $null = Invoke-ReadOnlyGet -Uri $taskApi -Headers $taskApiHeaders `
                    -TimeoutSec 20 -ExpectedStatus @(404) `
                    -RetryStatus @(200,408,429,502,503,504)
                $taskMissing = $true
            } else { throw 'Temporary target control-plane state is unknown.' }
        } catch {
            $taskCleanupFailureDetail = Get-SafeFailureDetail -Stage $taskCleanupStage -ErrorRecord $_
            $taskFailure = 'Temporary Worker cleanup needs independent verification.'
        }
    }
    if ($taskAttempted -and $taskMissing) {
        try {
            $null = Invoke-ReadOnlyGet -Uri "$taskExpectedPublicUrl/preflight" -Headers @{} -TimeoutSec 20 -ExpectedStatus @(404) -RetryStatus @(200,403,408,429,502,503,504)
            $taskPublicMissing = $true
            Assert-TemporaryPrefixesAbsent
            $taskPrefixesMissing = $true
        } catch {
            $taskCleanupFailureDetail = Get-SafeFailureDetail -Stage 'cleanup-public-and-inventory-absence' -ErrorRecord $_
            $taskFailure = 'Temporary Worker public or inventory absence needs independent verification.'
        }
    }
    try {
        $taskFormalAfter = Get-FormalSnapshot
        $taskHyperdriveAfter = @(Get-HyperdriveSnapshot)
        $taskMainUnchanged = $null -ne $taskFormalBefore -and $null -ne $taskHyperdriveBefore -and
            ($taskFormalAfter | ConvertTo-Json -Compress) -ceq ($taskFormalBefore | ConvertTo-Json -Compress) -and
            ($taskHyperdriveAfter | ConvertTo-Json -Compress) -ceq ($taskHyperdriveBefore | ConvertTo-Json -Compress)
        if (-not $taskMainUnchanged) { throw 'Formal API or fixed Hyperdrive postflight changed.' }
    } catch {
        $taskMainFailureDetail = Get-SafeFailureDetail -Stage 'formal-control-plane-postflight' -ErrorRecord $_
        $taskFailure = 'Formal API or fixed Hyperdrive postflight needs independent verification.'
    }
    try {
        if (Test-Path -LiteralPath $taskLogPath) { Remove-Item -LiteralPath $taskLogPath -Force }
        $taskLogRemoved = -not (Test-Path -LiteralPath $taskLogPath)
    } catch {
        $taskFailure = 'Owned Wrangler log cleanup needs independent verification.'
    }
    if ($taskProcessTreeUncertain -or $taskCliOutputCleanupFailed) {
        $taskFailure = 'Wrangler process or owned output cleanup needs independent verification.'
    }
    foreach ($taskEnvName in $taskOriginalEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($taskEnvName,$taskOriginalEnvironment[$taskEnvName],'Process')
    }
    $taskToken = $null; $taskAuth = $null; $taskWrite = $null
    $taskDeploy = $null; $taskDelete = $null; $taskApiHeaders = $null
}

$taskReceipt = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    operation = $taskOperation
    phase = $Phase
    mode = if ($Apply) { 'apply' } else { 'inspect-only' }
    sourceSha = $ExpectedSourceSha
    installSqlSha256 = $ExpectedInstallSqlSha256
    workerName = $taskName
    stage = $taskStage
    preflight = $taskBefore
    apply = $taskApplyResult
    postflight = $taskAfter
    access = $taskAccess
    formalBefore = $taskFormalBefore
    formalAfter = $taskFormalAfter
    hyperdriveBefore = $taskHyperdriveBefore
    hyperdriveAfter = $taskHyperdriveAfter
    cli = $taskCliDiagnostics
    formalControlPlaneUnchanged = $taskMainUnchanged
    cleanup = @{ attempted = $taskAttempted; ownershipVerified = $taskOwned;
        deleted = $taskDeleted;
        controlPlaneMissing = $taskMissing;
        publicMissing = $taskPublicMissing;
        temporaryPrefixesMissing = $taskPrefixesMissing;
        ownedLogRemoved = $taskLogRemoved;
        processTreeUncertain = $taskProcessTreeUncertain;
        ownedOutputRemoved = -not $taskCliOutputCleanupFailed;
        failureDetail = $taskCleanupFailureDetail }
    failure = $taskFailure
    httpFailures = @($taskHttpFailures.ToArray())
    failureDetail = $taskFailureDetail
    mainBindingFailureDetail = $taskMainFailureDetail
}
[IO.File]::WriteAllText((Join-Path $taskReceiptDir 'receipt.json'),
    ($taskReceipt | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
[ordered]@{ operation = $taskOperation; phase = $Phase; mode = $taskReceipt.mode; stage = $taskStage;
    sourceSha = $ExpectedSourceSha; preflightFingerprint = $taskBefore.fingerprint;
    committed = $taskApplyResult.committed; formalControlPlaneUnchanged = $taskMainUnchanged;
    cleanupConfirmed = $taskOwned -and $taskDeleted -and $taskMissing -and $taskPublicMissing -and $taskPrefixesMissing -and $taskLogRemoved -and -not $taskProcessTreeUncertain -and -not $taskCliOutputCleanupFailed;
    receiptPath = Join-Path $taskReceiptDir 'receipt.json'; failure = $taskFailure } | ConvertTo-Json -Depth 4
if ($taskFailure -or -not $taskOwned -or -not $taskDeleted -or
    -not $taskMissing -or -not $taskPublicMissing -or -not $taskPrefixesMissing -or
    -not $taskLogRemoved -or -not $taskMainUnchanged -or
    $taskProcessTreeUncertain -or $taskCliOutputCleanupFailed -or
    $taskStage -ne 'completed') { exit 2 }
