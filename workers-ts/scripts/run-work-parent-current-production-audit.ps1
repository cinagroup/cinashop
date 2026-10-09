# DB-009G2: one fixed, read-only current-app permission audit. This script
# deploys only a random temporary workers.dev Worker; it never changes the
# formal Worker, credentials, PostgreSQL grants, schema, or business rows.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'Cloudflare credentials are required.' }

$taskRoot = Split-Path -Parent $PSScriptRoot
$taskConfig = Join-Path $taskRoot 'test/integration/work-parent-current-audit.wrangler.jsonc'
$taskCli = Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskAccount = '7ea8e46d8210bad342fa7595f7935fea'
$taskExpectedVersion = 'cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2'
$taskExpectedApp = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7'
$taskExpectedAdmin = '446e94a4de0143f58c8e5178ec55db8b'
$taskBase = "https://api.cloudflare.com/client/v4/accounts/$taskAccount"
$taskMainApi = "$taskBase/workers/scripts/cinashop-api"
$taskName = 'cinashop-work-parent-current-audit-' + [Guid]::NewGuid().ToString('N').Substring(0, 16)
$taskApi = "$taskBase/workers/scripts/$taskName"
$taskUrl = "https://$taskName.cinagroup.workers.dev"
$taskToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskTokenHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskExpiry = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$taskMarker = 'db009g2-readonly-' + [Guid]::NewGuid().ToString('N')
$taskApiHeaders = @{ Authorization = 'Bearer ' + $env:CLOUDFLARE_API_TOKEN }
$taskAuth = @{ 'X-Audit-Token' = $taskToken }
$taskOriginalAccount = $env:CLOUDFLARE_ACCOUNT_ID
$taskOriginalMetrics = $env:WRANGLER_SEND_METRICS
$taskOriginalLog = $env:WRANGLER_LOG_PATH
$taskStage = 'local-preflight'
$taskFailure = $null
$taskAttempted = $false
$taskOwnedVersion = $null
$taskOwnershipVerified = $false
$taskDeleted = $false
$taskControlMissing = $false
$taskPublicMissing = $false
$taskMainUnchanged = $false
$taskFormalBefore = $null
$taskFormalAfter = $null
$taskResult = $null
$taskAccess = [ordered]@{ anonymous = 0; wrongMethod = 0; query = 0; wrongPath = 0 }

function Get-Http {
    param([string]$Uri,[hashtable]$Headers=@{},[string]$Method='GET',[int]$TimeoutSec=20)
    return Invoke-WebRequest -Uri $Uri -Method $Method -Headers $Headers -SkipHttpErrorCheck -TimeoutSec $TimeoutSec
}
function Get-Json200 {
    param([string]$Uri,[hashtable]$Headers,[int]$TimeoutSec=20)
    $taskResponse = Get-Http -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec
    if ([int]$taskResponse.StatusCode -ne 200) { throw 'Fixed control-plane read failed.' }
    $taskValue = $taskResponse.Content | ConvertFrom-Json -Depth 20
    if ($taskValue.success -ne $true) { throw 'Fixed control-plane response was not successful.' }
    return $taskValue
}
function Get-TemporaryControl {
    param([string]$Uri,[bool]$AllowAbsent=$false)
    # Only fixed GETs are retried. A transient 404 can follow a successful
    # upload, and 429/5xx/transport errors must not bypass owned cleanup.
    for ($taskTry = 0; $taskTry -lt 6; $taskTry++) {
        try {
            $taskResponse = Get-Http -Uri $Uri -Headers $taskApiHeaders
        } catch {
            if ($taskTry -eq 5) { throw 'Temporary Worker control-plane read remained unavailable.' }
            Start-Sleep -Seconds 1
            continue
        }
        $taskStatus = [int]$taskResponse.StatusCode
        if ($taskStatus -eq 200 -or ($AllowAbsent -and $taskStatus -eq 404 -and $taskTry -eq 5)) {
            return $taskResponse
        }
        if ($taskStatus -notin @(404,408,429,500,502,503,504)) {
            throw 'Temporary Worker control-plane status was unexpected.'
        }
        if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
    }
    throw 'Temporary Worker control-plane read remained unavailable.'
}
function Get-OwnedJson200 {
    param([string]$Uri)
    $taskResponse = Get-TemporaryControl -Uri $Uri
    $taskValue = $taskResponse.Content | ConvertFrom-Json -Depth 20
    if ($taskValue.success -ne $true) { throw 'Temporary Worker control-plane response failed.' }
    return $taskValue
}
function Get-FormalSnapshot {
    $taskDeployments = Get-Json200 -Uri "$taskMainApi/deployments" -Headers $taskApiHeaders
    $taskRows = if ($taskDeployments.result -is [array]) {
        @($taskDeployments.result)
    } else { @($taskDeployments.result.deployments) }
    $taskLatest = $taskRows | Sort-Object created_on -Descending | Select-Object -First 1
    if (-not $taskLatest -or @($taskLatest.versions).Count -ne 1 -or $taskLatest.versions[0].percentage -ne 100) {
        throw 'Formal Worker has no single 100-percent version.'
    }
    $taskSettings = Get-Json200 -Uri "$taskMainApi/settings" -Headers $taskApiHeaders
    $taskBindings = @($taskSettings.result.bindings)
    $taskHyperdrive = @($taskBindings | Where-Object type -eq 'hyperdrive' | ForEach-Object { "{0}:{1}" -f $_.name,$_.id } | Sort-Object -CaseSensitive)
    $taskExpected = @( @("HYPERDRIVE:$taskExpectedApp","HYPERDRIVE_ADMIN:$taskExpectedAdmin") | Sort-Object -CaseSensitive )
    if ($taskBindings.Count -ne 31 -or $taskHyperdrive.Count -ne 2 -or
        ($taskHyperdrive -join '|') -cne ($taskExpected -join '|')) {
        throw 'Formal Worker binding inventory changed.'
    }
    # Project metadata only. Plain-text and secret binding values are omitted.
    $taskProjection = @($taskBindings | ForEach-Object {
        "{0}:{1}:{2}:{3}:{4}" -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name
    } | Sort-Object -CaseSensitive)
    $taskBytes = [Text.Encoding]::UTF8.GetBytes(($taskProjection -join "`n"))
    $taskFingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskBytes)).ToLowerInvariant()
    return [ordered]@{
        deploymentId = [string]$taskLatest.id
        versionId = [string]$taskLatest.versions[0].version_id
        traffic = 100
        bindingCount = $taskBindings.Count
        bindingSha256 = $taskFingerprint
    }
}
function Get-OwnedVersion {
    $taskDeployments = Get-OwnedJson200 -Uri "$taskApi/deployments"
    $taskRows = if ($taskDeployments.result -is [array]) {
        @($taskDeployments.result)
    } else { @($taskDeployments.result.deployments) }
    $taskLatest = $taskRows | Sort-Object created_on -Descending | Select-Object -First 1
    if (-not $taskLatest -or @($taskLatest.versions).Count -ne 1 -or $taskLatest.versions[0].percentage -ne 100) {
        throw 'Temporary Worker version is not singular.'
    }
    $taskVersionId = [string]$taskLatest.versions[0].version_id
    if ($taskVersionId -notmatch '^[0-9a-f-]{36}$') { throw 'Temporary Worker version ID invalid.' }
    $taskVersion = Get-OwnedJson200 -Uri "$taskApi/versions/$taskVersionId"
    if ($taskVersion.result.annotations.'workers/message' -cne $taskMarker) {
        throw 'Temporary Worker ownership marker differs.'
    }
    $taskActual = @($taskVersion.result.resources.bindings | ForEach-Object {
        if ($_.type -eq 'hyperdrive') { "{0}:{1}:{2}" -f $_.name,$_.type,$_.id }
        else { "{0}:{1}" -f $_.name,$_.type }
    } | Sort-Object -CaseSensitive)
    $taskExpected = @( @("HYPERDRIVE:hyperdrive:$taskExpectedApp",'AUDIT_TOKEN_SHA256:plain_text',
        'AUDIT_EXPIRES_AT:plain_text') | Sort-Object -CaseSensitive )
    if ($taskActual.Count -ne $taskExpected.Count -or ($taskActual -join '|') -cne ($taskExpected -join '|')) {
        throw 'Temporary Worker binding projection differs.'
    }
    return $taskVersionId
}
function Test-PublicMissing {
    for ($taskTry = 0; $taskTry -lt 6; $taskTry++) {
        try {
            $taskResponse = Get-Http -Uri "$taskUrl/work-parents" -Headers @{} -TimeoutSec 20
            if ([int]$taskResponse.StatusCode -eq 404) { return $true }
        } catch { }
        if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
    }
    return $false
}

try {
    $taskParsed = Get-Content -Raw -LiteralPath $taskConfig | ConvertFrom-Json
    $taskConfigKeys = @($taskParsed.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $taskAllowedKeys = @( @('$schema','compatibility_date','compatibility_flags','hyperdrive',
        'limits','main','name','observability','vars','workers_dev') | Sort-Object -CaseSensitive )
    $taskVarKeys = @($taskParsed.vars.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if ($taskParsed.main -cne 'WorkParentCurrentAuditWorker.ts' -or
        ($taskConfigKeys -join '|') -cne ($taskAllowedKeys -join '|') -or
        ($taskVarKeys -join '|') -cne 'AUDIT_EXPIRES_AT|AUDIT_TOKEN_SHA256' -or
        $taskParsed.name -cne 'cinashop-work-parent-current-audit-template' -or
        $taskParsed.workers_dev -ne $true -or @($taskParsed.hyperdrive).Count -ne 1 -or
        $taskParsed.hyperdrive[0].binding -cne 'HYPERDRIVE' -or
        $taskParsed.hyperdrive[0].id -cne $taskExpectedApp) {
        throw 'Temporary Worker local configuration differs from reviewed scope.'
    }
    if (-not (Test-Path -LiteralPath $taskCli -PathType Leaf)) { throw 'Wrangler executable unavailable.' }
    $env:CLOUDFLARE_ACCOUNT_ID = $taskAccount
    $env:WRANGLER_SEND_METRICS = 'false'
    $env:WRANGLER_LOG_PATH = Join-Path $taskRoot ".cache/$taskName-wrangler.log"
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot '.cache')

    $taskStage = 'formal-preflight'
    $taskFormalBefore = Get-FormalSnapshot
    if ($taskFormalBefore.versionId -cne $taskExpectedVersion) { throw 'Formal Worker version differs from reviewed release.' }
    $taskStage = 'target-absence'
    if ([int](Get-Http -Uri $taskApi -Headers $taskApiHeaders).StatusCode -ne 404) {
        throw 'Random temporary target was not absent.'
    }
    $taskStage = 'deploy'
    $taskAttempted = $true
    $taskDeploy = & node $taskCli deploy --config $taskConfig --name $taskName `
        --var "AUDIT_TOKEN_SHA256:$taskTokenHash" --var "AUDIT_EXPIRES_AT:$taskExpiry" `
        --message $taskMarker 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Temporary Worker deployment not confirmed.' }
    if (($taskDeploy -join "`n") -cnotmatch [regex]::Escape($taskUrl)) { throw 'Expected temporary URL not returned.' }
    $taskStage = 'owned-version'
    $taskOwnedVersion = Get-OwnedVersion
    $taskOwnershipVerified = $true

    $taskStage = 'access-boundaries'
    # Newly deployed workers.dev endpoints can briefly return 404. Retry only
    # these SQL-free checks; the authenticated database audit is never retried.
    for ($taskTry = 0; $taskTry -lt 6; $taskTry++) {
        $taskAccess.anonymous = [int](Get-Http -Uri "$taskUrl/work-parents" -Headers @{}).StatusCode
        $taskAccess.wrongMethod = [int](Get-Http -Uri "$taskUrl/work-parents" -Headers $taskAuth -Method 'POST').StatusCode
        if ($taskAccess.anonymous -eq 403 -and $taskAccess.wrongMethod -eq 405) { break }
        if ($taskAccess.anonymous -notin @(403,404) -or $taskAccess.wrongMethod -notin @(404,405)) { break }
        if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
    }
    $taskAccess.query = [int](Get-Http -Uri "$taskUrl/work-parents?schema=other" -Headers $taskAuth).StatusCode
    $taskAccess.wrongPath = [int](Get-Http -Uri "$taskUrl/other" -Headers $taskAuth).StatusCode
    if ($taskAccess.anonymous -ne 403 -or $taskAccess.wrongMethod -ne 405 -or
        $taskAccess.query -ne 404 -or $taskAccess.wrongPath -ne 404) {
        throw 'Temporary Worker access boundaries failed.'
    }
    $taskStage = 'single-readonly-audit'
    $taskReply = Get-Http -Uri "$taskUrl/work-parents" -Headers $taskAuth -TimeoutSec 30
    if ([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {
        throw 'Single database audit did not complete.'
    }
    $taskRaw = $taskReply.Content | ConvertFrom-Json -Depth 12
    if ($taskRaw.scope -cne 'work-parent-current-app' -or
        $taskRaw.identityMatch -isnot [bool] -or $taskRaw.ready -isnot [bool]) {
        throw 'Unexpected audit result shape.'
    }
    $taskCheckNames = @( @('connectionIdentityVisible','objectsAndKeysPresent',
        'unprivilegedReachableRoles','noOwnerControl','noSchemaCreation',
        'noParentRemovalOrTriggerCreation','noReferencedKeyUpdate','noReplicationBypass',
        'noUnreviewedDefinerRoutine','parentReadAccess') | Sort-Object -CaseSensitive )
    $taskFailures = @($taskRaw.failures)
    if ($taskRaw.identityMatch) {
        if ($null -eq $taskRaw.checks) { throw 'Expected permission checks missing.' }
        $taskActualChecks = @($taskRaw.checks.PSObject.Properties.Name | Sort-Object -CaseSensitive)
        if (($taskActualChecks -join '|') -cne ($taskCheckNames -join '|')) {
            throw 'Permission check keys differ.'
        }
        $taskSafeChecks = [ordered]@{}
        foreach ($taskNameOfCheck in $taskCheckNames) {
            $taskValue = $taskRaw.checks.$taskNameOfCheck
            if ($taskValue -isnot [bool]) { throw 'Permission check value is not boolean.' }
            $taskSafeChecks[$taskNameOfCheck] = [bool]$taskValue
        }
        $taskExpectedFailures = @( $taskSafeChecks.GetEnumerator() |
            Where-Object Value -eq $false | ForEach-Object Key | Sort-Object -CaseSensitive )
        if ((@($taskFailures | Sort-Object -CaseSensitive) -join '|') -cne
            ($taskExpectedFailures -join '|') -or $taskRaw.ready -ne ($taskExpectedFailures.Count -eq 0)) {
            throw 'Permission failures do not match boolean checks.'
        }
    } else {
        if ($null -ne $taskRaw.checks -or $taskRaw.ready -ne $false -or
            $taskFailures.Count -ne 1 -or $taskFailures[0] -cne 'connectionIdentityMismatch') {
            throw 'Backend identity mismatch shape differs.'
        }
        $taskSafeChecks = $null
    }
    # Only fixed labels and booleans leave this process, even if the HTTP body
    # unexpectedly contains extra fields or text.
    $taskResult = [ordered]@{ scope = 'work-parent-current-app';
        identityMatch = [bool]$taskRaw.identityMatch; ready = [bool]$taskRaw.ready;
        checks = $taskSafeChecks; failures = $taskFailures }
    $taskStage = 'audit-completed'
} catch {
    # Do not print raw HTTP, Wrangler or database exceptions: they can contain
    # tokens, connection context or internal SQL. The stage is sufficient.
    $taskFailure = 'Current work-parent audit could not be fully confirmed.'
} finally {
    if ($taskAttempted) {
        try {
            $taskStageBeforeCleanup = $taskStage
            $taskStage = 'cleanup-ownership'
            $taskPresent = Get-TemporaryControl -Uri $taskApi -AllowAbsent $true
            if ([int]$taskPresent.StatusCode -eq 200) {
                $taskBeforeDeleteVersion = Get-OwnedVersion
                if ($taskOwnedVersion -and $taskBeforeDeleteVersion -cne $taskOwnedVersion) {
                    throw 'Temporary Worker version changed before deletion.'
                }
                $taskOwnershipVerified = $true
                $taskStage = 'cleanup-delete'
                $taskDelete = & node $taskCli delete $taskName --config $taskConfig --force 2>&1
                $taskDeleted = $LASTEXITCODE -eq 0
                if (-not $taskDeleted) { throw 'Temporary Worker deletion not confirmed.' }
            } elseif ([int]$taskPresent.StatusCode -ne 404 -or $taskOwnedVersion) {
                throw 'Temporary Worker control-plane state changed.'
            }
            $taskStage = 'cleanup-control-404'
            for ($taskTry = 0; $taskTry -lt 6; $taskTry++) {
                try {
                    $taskStatus = [int](Get-Http -Uri $taskApi -Headers $taskApiHeaders).StatusCode
                } catch {
                    $taskControlMissing = $false
                    if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
                    continue
                }
                $taskControlMissing = $taskStatus -eq 404
                if (-not $taskControlMissing -and $taskStatus -notin @(200,408,429,500,502,503,504)) {
                    throw 'Temporary Worker cleanup status was unexpected.'
                }
                if ($taskControlMissing) { break }
                if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
            }
            if (-not $taskControlMissing) { throw 'Temporary Worker control-plane absence not confirmed.' }
            $taskStage = 'cleanup-public-404'
            $taskPublicMissing = Test-PublicMissing
            if (-not $taskPublicMissing) { throw 'Temporary Worker public absence not confirmed.' }
            $taskStage = $taskStageBeforeCleanup
        } catch {
            $taskFailure = 'Temporary Worker cleanup needs independent verification.'
        }
    }
    if ($taskFormalBefore) {
        try {
            $taskFormalAfter = Get-FormalSnapshot
            $taskMainUnchanged = $taskFormalAfter.deploymentId -ceq $taskFormalBefore.deploymentId -and
                $taskFormalAfter.versionId -ceq $taskFormalBefore.versionId -and
                $taskFormalAfter.bindingSha256 -ceq $taskFormalBefore.bindingSha256
            if (-not $taskMainUnchanged) { throw 'Formal Worker changed during audit.' }
        } catch {
            $taskFailure = 'Formal Worker postflight needs independent verification.'
        }
    }
    $taskToken = $null
    $taskAuth = $null
    $env:CLOUDFLARE_ACCOUNT_ID = $taskOriginalAccount
    $env:WRANGLER_SEND_METRICS = $taskOriginalMetrics
    $env:WRANGLER_LOG_PATH = $taskOriginalLog
}

$taskSuccess = $taskStage -eq 'audit-completed' -and -not $taskFailure -and
    $taskOwnershipVerified -and $taskDeleted -and $taskControlMissing -and $taskPublicMissing -and
    $taskMainUnchanged -and $taskResult.identityMatch -eq $true -and $taskResult.ready -eq $true
$taskReceipt = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    scope = 'db009g2-current-app-readonly'
    workerName = $taskName
    stage = $taskStage
    formalBefore = $taskFormalBefore
    formalAfter = $taskFormalAfter
    formalUnchanged = [bool]$taskMainUnchanged
    ownedVersionId = $taskOwnedVersion
    access = $taskAccess
    audit = $taskResult
    cleanup = [ordered]@{ attempted = $taskAttempted; ownershipVerified = $taskOwnershipVerified;
        deleted = $taskDeleted; controlPlane404 = $taskControlMissing; public404 = $taskPublicMissing }
    ready = [bool]$taskSuccess
    failure = $taskFailure
}
$taskReceipt | ConvertTo-Json -Depth 12
if ($taskSuccess) { exit 0 }
if ($taskResult -and $taskResult.ready -eq $false -and -not $taskFailure -and
    $taskDeleted -and $taskControlMissing -and $taskPublicMissing -and $taskMainUnchanged) { exit 1 }
exit 2
