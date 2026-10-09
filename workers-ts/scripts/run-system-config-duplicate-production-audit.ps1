# DB-003: one read-only snapshot through the currently deployed app role.
# A separate owner decision and reviewed maintenance operation are required
# before deleting any configuration row.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedSourceSha
)
$ErrorActionPreference = 'Stop'

$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRepository = Split-Path -Parent $taskRoot
$taskConfig = Join-Path $taskRoot 'test/integration/system-config-duplicate-audit.wrangler.jsonc'
$taskBaselinePath = Join-Path $taskRoot 'audit/system-config-duplicate-baseline.json'
$taskCli = Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskAccount = '7ea8e46d8210bad342fa7595f7935fea'
$taskMainVersion = 'cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2'
$taskAppHyperdrive = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7'
$taskAdminHyperdrive = '446e94a4de0143f58c8e5178ec55db8b'
$taskApiBase = "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts"
$taskMainApi = "$taskApiBase/cinashop-api"

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
$taskConfigValue = Get-Content -LiteralPath $taskConfig -Raw | ConvertFrom-Json -Depth 20
if ($taskConfigValue.name -cne 'cinashop-system-config-duplicate-audit-template' -or
    $taskConfigValue.main -cne 'SystemConfigDuplicateAuditWorker.ts' -or
    $taskConfigValue.workers_dev -ne $true -or
    @($taskConfigValue.hyperdrive).Count -ne 1 -or
    $taskConfigValue.hyperdrive[0].binding -cne 'HYPERDRIVE' -or
    $taskConfigValue.hyperdrive[0].id -cne $taskAppHyperdrive -or
    ((@($taskConfigValue.vars.PSObject.Properties.Name | Sort-Object) -join '|') -cne
        'AUDIT_EXPIRES_AT|AUDIT_TOKEN_SHA256|RUN_MARKER')) {
    throw 'Temporary Worker configuration differs from reviewed read-only target.'
}
$taskBaseline = Get-Content -LiteralPath $taskBaselinePath -Raw | ConvertFrom-Json -Depth 20
if ($taskBaseline.decision.status -cne 'pending_owner_confirmation' -or
    $taskBaseline.duplicateKeys -ne 6 -or $taskBaseline.duplicateRows -ne 26 -or
    $taskBaseline.extraRows -ne 20) {
    throw 'DB-003 owner decision or reviewed baseline changed.'
}
$taskOneHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes('1'))).ToLowerInvariant()

$taskName = 'cinashop-system-config-duplicate-audit-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$taskTargetApi = "$taskApiBase/$taskName"
$taskToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskTokenHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskMarker = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
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
$taskUrl = "https://$taskName.cinagroup.workers.dev"
$taskStage = 'control-plane-preflight'
$taskAttempted = $false
$taskOwnedVersion = $null
$taskDeleted = $false
$taskControlPlane404 = $false
$taskPublic404 = $false
$taskMainUnchanged = $false
$taskReport = $null
$taskFailure = $null
$taskCleanupFailure = $null
$env:CLOUDFLARE_ACCOUNT_ID = $taskAccount
$env:WRANGLER_SEND_METRICS = 'false'
$env:WRANGLER_LOG_PATH = Join-Path ([IO.Path]::GetTempPath()) "$taskName.log"

function Invoke-ControlPlane {
    param([string]$Uri, [int[]]$ExpectedStatus = @(200))
    $taskResponse = Invoke-WebRequest -Uri $Uri -Headers $taskHeaders `
        -SkipHttpErrorCheck -TimeoutSec 20
    $taskStatus = [int]$taskResponse.StatusCode
    if ($ExpectedStatus -notcontains $taskStatus) { throw 'Control-plane status differs from reviewed state.' }
    if ($taskStatus -eq 404) { return $null }
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
    $taskLatest = @($taskDeployments.result.deployments)[0]
    $taskFull = @($taskLatest.versions | Where-Object { $_.percentage -eq 100 })
    if ($taskFull.Count -ne 1 -or @($taskLatest.versions).Count -ne 1 -or
        $taskFull[0].version_id -notmatch '^[0-9a-f-]{36}$') {
        throw 'Worker traffic is not pinned to one reviewed version.'
    }
    return [string]$taskFull[0].version_id
}

function Assert-MainWorker {
    $taskSettings = Invoke-ControlPlane "$taskMainApi/settings"
    $taskSettingsBindings = @(Get-HyperdriveBindings $taskSettings.result.bindings)
    if (($taskSettingsBindings -join '|') -cne ($taskExpectedMainBindings -join '|')) {
        throw 'Current main Worker Hyperdrive bindings differ from reviewed IDs.'
    }
    $taskVersionId = Get-FullTrafficVersion $taskMainApi
    if ($taskVersionId -cne $taskMainVersion) { throw 'Current main Worker version changed.' }
    $taskVersion = Invoke-ControlPlane "$taskMainApi/versions/$taskVersionId"
    $taskVersionBindings = @(Get-HyperdriveBindings $taskVersion.result.resources.bindings)
    if (($taskVersionBindings -join '|') -cne ($taskExpectedMainBindings -join '|')) {
        throw 'Current main Worker version bindings differ from reviewed IDs.'
    }
}

function Get-OwnedAuditVersion {
    $taskVersionId = Get-FullTrafficVersion $taskTargetApi
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
    return $taskVersionId
}

function Get-PublicResponse {
    param([string]$Uri, [hashtable]$Headers = @{}, [string]$Method = 'Get')
    return Invoke-WebRequest -Uri $Uri -Headers $Headers -Method $Method `
        -SkipHttpErrorCheck -TimeoutSec 30
}

function Assert-AuditReport {
    param($Value)
    if ($Value.run_marker -cne $taskMarker -or $Value.database_name -cne 'postgres' -or
        $Value.database_role -cne 'cinashop_app_v1' -or
        $Value.table_rows -lt 26 -or $Value.table_rows -gt 1024 -or
        $Value.table_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $Value.duplicate_keys -ne 6 -or $Value.duplicate_rows -ne 26 -or
        $Value.extra_rows -ne 20 -or $Value.referencing_foreign_keys -ne 0) {
        throw 'Current read-only audit differs from the reviewed DB-003 shape.'
    }
    $taskActualKeys = @($Value.duplicate_groups | ForEach-Object { $_.key })
    $taskExpectedKeys = @($taskBaseline.groups | ForEach-Object { $_.key })
    if (($taskActualKeys -join '|') -cne ($taskExpectedKeys -join '|')) {
        throw 'Current duplicate key set differs from the reviewed baseline.'
    }
    foreach ($taskExpected in $taskBaseline.groups) {
        $taskActual = @($Value.duplicate_groups | Where-Object { $_.key -ceq $taskExpected.key })[0]
        $taskActualIds = @($taskActual.rows | ForEach-Object { [int]$_.id })
        $taskExpectedIds = @([int]$taskExpected.keepId) + @($taskExpected.removeIds | ForEach-Object { [int]$_ })
        $taskSelected = @($taskActual.rows | Where-Object { $_.selected_by_runtime -eq $true })
        if ($taskActual.runtime_selected_id -ne $taskExpected.keepId -or
            $taskSelected.Count -ne 1 -or $taskSelected[0].id -ne $taskExpected.keepId -or
            (($taskActualIds | Sort-Object) -join ',') -cne (($taskExpectedIds | Sort-Object) -join ',') -or
            $taskActual.values_identical -ne $taskExpected.valuesIdentical -or
            $taskActual.payloads_identical_except_id -ne $taskExpected.payloadsIdenticalExceptId) {
            throw 'Current duplicate IDs, winner or values differ from the reviewed baseline.'
        }
        $taskExpectedValueHash = if ($taskExpected.valueSha256) {
            [string]$taskExpected.valueSha256
        } elseif ($taskExpected.displayValue -ceq '1') {
            $taskOneHash
        } else { $null }
        if ($taskExpectedValueHash -and
            @($taskActual.rows | Where-Object { $_.value_sha256 -cne $taskExpectedValueHash }).Count -ne 0) {
            throw 'Current duplicate value digest differs from the reviewed baseline.'
        }
        if ($taskExpected.key -ceq 'site_url') {
            $taskWinner = @($taskActual.rows | Where-Object { $_.id -eq 389 })[0]
            $taskLosers = @($taskActual.rows | Where-Object { $_.id -ne 389 })
            if ($taskWinner.sort -ne 98 -or $taskWinner.status -ne 1 -or
                $taskWinner.matches_expected_site_url -ne $true -or
                @($taskLosers | Where-Object {
                    $_.status -ne 0 -or $_.matches_placeholder_site_url -ne $true
                }).Count -ne 0) {
                throw 'Current site URL winner or inactive placeholders changed.'
            }
        }
    }
}

try {
    Assert-MainWorker
    $taskStage = 'target-absence'
    $null = Invoke-ControlPlane $taskTargetApi @(404)
    $taskStage = 'deploy-readonly-worker'
    $taskAttempted = $true
    $taskDeployOutput = & node $taskCli deploy --config $taskConfig --name $taskName `
        --var "AUDIT_TOKEN_SHA256:$taskTokenHash" `
        --var "AUDIT_EXPIRES_AT:$taskExpiry" --var "RUN_MARKER:$taskMarker" `
        --message $taskMarker 2>&1
    if ($LASTEXITCODE -ne 0 -or
        ($taskDeployOutput -join "`n") -cnotmatch [regex]::Escape($taskUrl)) {
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
    $taskStage = 'single-readonly-snapshot'
    $taskReply = Get-PublicResponse "$taskUrl/audit" $taskAuth
    if ([int]$taskReply.StatusCode -ne 200 -or
        (($taskReply.Headers['Cache-Control'] -join ',') -notmatch 'no-store')) {
        throw 'Read-only snapshot response was not confirmed.'
    }
    $taskReport = $taskReply.Content | ConvertFrom-Json -Depth 30
    Assert-AuditReport $taskReport
    $taskStage = 'snapshot-complete-owner-decision-pending'
} catch {
    $taskFailure = "DB-003 read-only audit did not complete at $taskStage."
} finally {
    if ($taskAttempted) {
        try {
            $taskPresent = Invoke-WebRequest -Uri $taskTargetApi -Headers $taskHeaders `
                -SkipHttpErrorCheck -TimeoutSec 20
            if ([int]$taskPresent.StatusCode -eq 200) {
                $taskBeforeDeleteVersion = Get-OwnedAuditVersion
                if ($taskOwnedVersion -and $taskBeforeDeleteVersion -cne $taskOwnedVersion) {
                    throw 'Temporary Worker version changed before cleanup.'
                }
                $null = & node $taskCli delete $taskName --config $taskConfig --force 2>&1
                if ($LASTEXITCODE -ne 0) { throw 'Temporary Worker deletion was not confirmed.' }
                $taskDeleted = $true
            } elseif ([int]$taskPresent.StatusCode -ne 404 -or $taskOwnedVersion) {
                throw 'Temporary Worker state changed before cleanup.'
            }
            for ($taskAttempt = 0; $taskAttempt -lt 6; $taskAttempt++) {
                $taskControlPlane404 = [int](Invoke-WebRequest -Uri $taskTargetApi `
                    -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -eq 404
                $taskPublic404 = [int](Get-PublicResponse "$taskUrl/audit").StatusCode -eq 404
                if ($taskControlPlane404 -and $taskPublic404) { break }
                if ($taskAttempt -lt 5) { Start-Sleep -Seconds 2 }
            }
            if (-not $taskControlPlane404 -or -not $taskPublic404) {
                throw 'Temporary Worker dual-404 cleanup was not confirmed.'
            }
        } catch {
            $taskCleanupFailure = 'Temporary Worker cleanup requires independent verification.'
        }
    }
    try {
        Assert-MainWorker
        $taskMainUnchanged = $true
    } catch {
        $taskFailure = 'Main Worker version or bindings changed during DB-003 audit.'
    }
    $taskToken = $null
    $taskAuth = $null
}

[ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    sourceSha = $ExpectedSourceSha
    expectedMainVersion = $taskMainVersion
    appHyperdrive = $taskAppHyperdrive
    stage = $taskStage
    report = $taskReport
    ownerDecision = 'pending'
    cleanup = [ordered]@{
        workerName = $taskName
        deleted = $taskDeleted
        controlPlane404 = $taskControlPlane404
        public404 = $taskPublic404
        mainUnchanged = $taskMainUnchanged
    }
    failure = $taskFailure
    cleanupFailure = $taskCleanupFailure
} | ConvertTo-Json -Depth 30
if ($taskFailure -or $taskCleanupFailure -or -not $taskMainUnchanged -or
    -not $taskControlPlane404 -or -not $taskPublic404) { exit 2 }
