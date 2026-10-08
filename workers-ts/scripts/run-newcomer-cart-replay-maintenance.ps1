# Fixed FE-003D receipt installation only. Never retry an unknown POST result.
[CmdletBinding()]
param(
    [switch]$InspectOnly,
    [switch]$Apply,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedSourceSha,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedInstallSqlSha256,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$ApprovedPreflightFingerprint
)
$ErrorActionPreference = 'Stop'
if ([int][bool]$InspectOnly + [int][bool]$Apply -ne 1) { throw 'Select exactly one maintenance mode.' }
if ($Apply -and -not $ApprovedPreflightFingerprint) { throw 'Apply requires the approved read-only preflight fingerprint.' }
if ($InspectOnly -and $ApprovedPreflightFingerprint) { throw 'InspectOnly does not accept apply approval.' }
if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'Cloudflare credentials required.' }

$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRepository = Split-Path -Parent $taskRoot
$taskConfig = Join-Path $taskRoot 'test/integration/newcomer-cart-replay-maintenance.wrangler.jsonc'
$taskCli = Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
if (-not (Test-Path -LiteralPath $taskCli)) { throw 'Reviewed Wrangler dependency is not installed.' }
$taskGitSha = (& git -C $taskRepository rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $taskGitSha -cne $ExpectedSourceSha) { throw 'Reviewed source commit mismatch.' }
$taskDirty = @(& git -C $taskRepository status --porcelain=v1)
if ($LASTEXITCODE -ne 0 -or $taskDirty.Count -ne 0) { throw 'Maintenance source worktree must be clean.' }

$taskConfigObject = Get-Content -LiteralPath $taskConfig -Raw | ConvertFrom-Json
$taskExpectedBindings = @(
    @{ name = 'HYPERDRIVE_MAINTENANCE'; id = '9748c294e21c49a99579c9cef70102e0' },
    @{ name = 'HYPERDRIVE'; id = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' },
    @{ name = 'HYPERDRIVE_ADMIN'; id = '446e94a4de0143f58c8e5178ec55db8b' }
)
$taskConfigured = @($taskConfigObject.hyperdrive | Sort-Object binding | ForEach-Object { "{0}:{1}" -f $_.binding,$_.id })
$taskReviewed = @($taskExpectedBindings | Sort-Object name | ForEach-Object { "{0}:{1}" -f $_.name,$_.id })
if ($taskConfigured.Count -ne 3 -or ($taskConfigured -join '|') -cne ($taskReviewed -join '|')) {
    throw 'Maintenance Hyperdrive binding config differs from reviewed IDs.'
}

$taskName = 'cinashop-ncar-maint-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$taskAccount = '7ea8e46d8210bad342fa7595f7935fea'
$taskApi = "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$taskName"
$taskApiHeaders = @{ Authorization = 'Bearer ' + $env:CLOUDFLARE_API_TOKEN }
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
    'X-Migration-Operation' = 'newcomer-cart-replay-install-v1';
    'X-Preflight-SHA256' = $ApprovedPreflightFingerprint }
$taskReceiptDir = Join-Path $taskRepository ('.cache/' + $taskName)
$null = New-Item -ItemType Directory -Path $taskReceiptDir
$env:CLOUDFLARE_ACCOUNT_ID = $taskAccount
$env:WRANGLER_SEND_METRICS = 'false'
$env:WRANGLER_LOG_PATH = Join-Path $env:TEMP "$taskName.log"
$taskStage = 'control-plane-baseline'
$taskFailure = $null
$taskFailureDetail = $null
$taskCleanupFailureDetail = $null
$taskMainFailureDetail = $null
$taskAttempted = $false
$taskApplyAttempted = $false
$taskDeleted = $false
$taskMissing = $false
$taskOwned = $false
$taskOwnedVersionId = $null
$taskMainUnchanged = $false
$taskUrl = $null
$taskBefore = $null
$taskApplyResult = $null
$taskAfter = $null
$taskAccess = @{}
$taskExpectedVersionBindings = @(
    'HYPERDRIVE_MAINTENANCE:hyperdrive:9748c294e21c49a99579c9cef70102e0',
    'HYPERDRIVE:hyperdrive:ba7faa6680cd48d4b3a1d36a7a5fc8f7',
    'HYPERDRIVE_ADMIN:hyperdrive:446e94a4de0143f58c8e5178ec55db8b',
    'AUDIT_TOKEN_SHA256:plain_text', 'AUDIT_EXPIRES_AT:plain_text',
    'SOURCE_SHA:plain_text', 'EXPECTED_INSTALL_SQL_SHA256:plain_text',
    'RUN_MARKER:plain_text', 'APPLY_ARMED:plain_text',
    'APPROVED_PREFLIGHT_SHA256:plain_text'
) | Sort-Object

function New-SafeRequestFailure {
    param([string]$Type,[Nullable[int]]$Status)
    $taskError = [InvalidOperationException]::new('Reviewed HTTP result was not confirmed.')
    $taskError.Data['safeType'] = $Type
    if ($null -ne $Status) { $taskError.Data['safeStatus'] = [int]$Status }
    return $taskError
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
    return ($taskResponse.Content | ConvertFrom-Json -Depth 20)
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
    $taskProjection = @($taskVersion.result.resources.bindings | ForEach-Object {
        if ($_.type -eq 'hyperdrive') { "{0}:{1}:{2}" -f $_.name,$_.type,$_.id }
        else { "{0}:{1}" -f $_.name,$_.type }
    } | Sort-Object)
    if ($taskProjection.Count -ne $taskExpectedVersionBindings.Count -or
        ($taskProjection -join '|') -cne ($taskExpectedVersionBindings -join '|')) {
        throw 'Temporary Worker version binding projection changed.'
    }
    return $taskVersionId
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
        throw (New-SafeRequestFailure -Type 'http-status' -Status ([int]$taskResponse.StatusCode))
    }
    if ($taskResponse.Headers['Cache-Control'] -notcontains 'no-store') {
        throw (New-SafeRequestFailure -Type 'response-validation' -Status 200)
    }
    return ($taskResponse.Content | ConvertFrom-Json -Depth 20)
}

function Assert-ReadOnlyPreflight {
    param($Value)
    if ($Value.operation -cne 'newcomer-cart-replay-install-v1' -or
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
        $Value.admin.ready -ne $true) { throw 'Read-only preflight did not match reviewed target and authority.' }
}

try {
    $taskCurrent = Get-ReadOnlyJson -Uri $taskSettingsApi -Headers $taskApiHeaders -TimeoutSec 20
    $taskMainBindings = @($taskCurrent.result.bindings | Where-Object type -eq 'hyperdrive' |
        Sort-Object name | ForEach-Object { "{0}:{1}" -f $_.name,$_.id })
    $taskExpectedMain = @('HYPERDRIVE:ba7faa6680cd48d4b3a1d36a7a5fc8f7',
        'HYPERDRIVE_ADMIN:446e94a4de0143f58c8e5178ec55db8b')
    if ($taskMainBindings.Count -ne 2 -or
        ($taskMainBindings -join '|') -cne ($taskExpectedMain -join '|')) {
        throw 'Current API Hyperdrive bindings differ from reviewed target.'
    }
    $taskStage = 'target-absence'
    $null = Invoke-ReadOnlyGet -Uri $taskApi -Headers $taskApiHeaders -TimeoutSec 20 `
        -ExpectedStatus @(404)
    $taskStage = 'deploy'
    $taskAttempted = $true
    $taskDeploy = & node $taskCli deploy --config $taskConfig --name $taskName `
        --var "AUDIT_TOKEN_SHA256:$taskTokenHash" --var "AUDIT_EXPIRES_AT:$taskExpiry" `
        --var "SOURCE_SHA:$ExpectedSourceSha" `
        --var "EXPECTED_INSTALL_SQL_SHA256:$ExpectedInstallSqlSha256" `
        --var "RUN_MARKER:$taskMarker" --var "APPLY_ARMED:$taskApplyArmed" `
        --var "APPROVED_PREFLIGHT_SHA256:$taskApprovedVariable" `
        --message $taskMarker 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Temporary maintenance Worker deployment unconfirmed.' }
    $taskMatch = [regex]::Match(($taskDeploy -join "`n"),
        'https://' + [regex]::Escape($taskName) + '\.cinagroup\.workers\.dev')
    if (-not $taskMatch.Success) { throw 'Temporary maintenance URL unavailable.' }
    $taskUrl = $taskMatch.Value
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
        if ($taskApplyResult.operation -cne 'newcomer-cart-replay-install-v1' -or
            $taskApplyResult.committed -ne $true -or
            $taskApplyResult.sourceSha -cne $ExpectedSourceSha -or
            $taskApplyResult.installSqlSha256 -cne $ExpectedInstallSqlSha256 -or
            $taskApplyResult.runMarker -cne $taskMarker -or
            $taskApplyResult.approvedPreflightFingerprint -cne $ApprovedPreflightFingerprint) {
            throw 'Single apply response did not confirm reviewed transaction.'
        }
        $taskStage = 'independent-readonly-postflight'
        $taskAfter = Get-MaintenanceJson '/postflight' 'Get' $taskAuth
        if ($taskAfter.operation -cne 'newcomer-cart-replay-install-v1' -or
            $taskAfter.ready -ne $true -or
            $taskAfter.sourceSha -cne $ExpectedSourceSha -or
            $taskAfter.installSqlSha256 -cne $ExpectedInstallSqlSha256 -or
            $taskAfter.runMarker -cne $taskMarker -or
            $taskAfter.applyArmed -ne $true -or
            $taskAfter.maintenance.rows -ne 0 -or
            $taskAfter.app.ready -ne $true -or $taskAfter.admin.ready -ne $true) {
            throw 'Independent read-only postflight did not confirm exact empty receipt and real LOGINs.'
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
                $taskBeforeDeleteVersionId = Get-OwnedVersionId
                $taskOwned = $taskBeforeDeleteVersionId -and
                    (-not $taskOwnedVersionId -or $taskBeforeDeleteVersionId -ceq $taskOwnedVersionId)
                if (-not $taskOwned) { throw 'Temporary target version changed before deletion.' }
                $taskCleanupStage = 'cleanup-delete'
                $taskDelete = & node $taskCli delete $taskName --config $taskConfig --force 2>&1
                $taskDeleted = $LASTEXITCODE -eq 0
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
    try {
        $taskFinal = Get-ReadOnlyJson -Uri $taskSettingsApi -Headers $taskApiHeaders -TimeoutSec 20
        $taskFinalBindings = @($taskFinal.result.bindings | Where-Object type -eq 'hyperdrive' |
            Sort-Object name | ForEach-Object { "{0}:{1}" -f $_.name,$_.id })
        $taskMainUnchanged = ($taskFinalBindings -join '|') -ceq ($taskMainBindings -join '|')
        if (-not $taskMainUnchanged) { throw 'Current API binding postflight changed.' }
    } catch {
        $taskMainFailureDetail = Get-SafeFailureDetail -Stage 'main-binding-postflight' -ErrorRecord $_
        $taskFailure = 'Current API binding postflight needs independent verification.'
    }
    $taskToken = $null; $taskAuth = $null; $taskWrite = $null
}

$taskReceipt = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    operation = 'newcomer-cart-replay-install-v1'
    mode = if ($Apply) { 'apply' } else { 'inspect-only' }
    sourceSha = $ExpectedSourceSha
    installSqlSha256 = $ExpectedInstallSqlSha256
    workerName = $taskName
    stage = $taskStage
    preflight = $taskBefore
    apply = $taskApplyResult
    postflight = $taskAfter
    access = $taskAccess
    mainBindingsUnchanged = $taskMainUnchanged
    cleanup = @{ attempted = $taskAttempted; ownershipVerified = $taskOwned;
        deleted = $taskDeleted;
        controlPlaneMissing = $taskMissing;
        failureDetail = $taskCleanupFailureDetail }
    failure = $taskFailure
    failureDetail = $taskFailureDetail
    mainBindingFailureDetail = $taskMainFailureDetail
}
[IO.File]::WriteAllText((Join-Path $taskReceiptDir 'receipt.json'),
    ($taskReceipt | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
$taskReceipt | ConvertTo-Json -Depth 20
if ($taskFailure -or -not $taskOwned -or -not $taskDeleted -or
    -not $taskMissing -or -not $taskMainUnchanged -or
    $taskStage -ne 'completed') { exit 2 }
