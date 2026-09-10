# Explicit DB-006 only. No automatic retry after any uncertain mutation result.
[CmdletBinding()]
param([switch]$Apply, [switch]$VerifyIdempotence)
$ErrorActionPreference = 'Stop'
if (-not $Apply) { throw 'Explicit -Apply required for the fixed DB-006 maintenance operation.' }
if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'CLOUDFLARE_API_TOKEN is required.' }
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskConfig = Join-Path $taskRoot 'test/integration/withdrawal-replay-migrate.wrangler.jsonc'
$taskCli = Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskName = 'cinashop-withdrawal-replay-migrate-' + [Guid]::NewGuid().ToString('N').Substring(0,12)
$taskAccount = '7ea8e46d8210bad342fa7595f7935fea'
$taskApi = "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$taskName"
$taskApiHeaders = @{ Authorization = ('Bearer ' + $env:CLOUDFLARE_API_TOKEN) }
$taskToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskExpiry = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$env:CLOUDFLARE_ACCOUNT_ID = $taskAccount
$env:WRANGLER_SEND_METRICS = 'false'
$env:WRANGLER_LOG_PATH = Join-Path $env:TEMP "$taskName.log"
$taskAttempted = $false
$taskDeleted = $false
$taskMissing = $false
$taskStage = 'target-absence'
$taskFailure = $null
$taskBefore = $null
$taskFirst = $null
$taskAfter = $null
$taskRepeat = $null
$taskAccess = @{}
$taskUrl = $null
function Get-MaintenanceJson {
    param([string]$Uri,[string]$Method,[hashtable]$Headers)
    $taskResponse = Invoke-WebRequest -Uri $Uri -Method $Method -Headers $Headers -SkipHttpErrorCheck -TimeoutSec 30
    if ([int]$taskResponse.StatusCode -ne 200) { throw 'Maintenance request did not confirm success.' }
    if ($taskResponse.Headers['Cache-Control'] -notcontains 'no-store') { throw 'Unexpected cache policy.' }
    return ($taskResponse.Content | ConvertFrom-Json)
}
try {
    $taskAbsent = Invoke-WebRequest -Uri $taskApi -Headers $taskApiHeaders -SkipHttpErrorCheck -TimeoutSec 20
    if ([int]$taskAbsent.StatusCode -ne 404) { throw 'Temporary target absence was not established.' }
    $taskAttempted = $true
    $taskStage = 'deploy'
    $taskDeploy = & node $taskCli deploy --config $taskConfig --name $taskName `
        --var "AUDIT_TOKEN_SHA256:$taskHash" --var "AUDIT_EXPIRES_AT:$taskExpiry" 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Temporary maintenance Worker deployment failed.' }
    $taskMatch = [regex]::Match(($taskDeploy -join "`n"),'https://' + [regex]::Escape($taskName) + '\.[a-z0-9-]+\.workers\.dev')
    if (-not $taskMatch.Success) { throw 'Owned maintenance URL was not returned.' }
    $taskUrl = $taskMatch.Value
    $taskAuth = @{ 'X-Audit-Token' = $taskToken }
    $taskWriteAuth = @{ 'X-Audit-Token' = $taskToken; 'X-Migration-Operation' = '0130-user-withdrawal-replay' }
    $taskStage = 'access-boundaries'
    $taskAccess.noToken = [int](Invoke-WebRequest -Uri "$taskUrl/migrate/0130" -Method Post -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskAccess.wrongMethod = [int](Invoke-WebRequest -Uri "$taskUrl/migrate/0130" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskAccess.noExplicitOperation = [int](Invoke-WebRequest -Uri "$taskUrl/migrate/0130" -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    if ($taskAccess.noToken -ne 403 -or $taskAccess.wrongMethod -ne 405 -or $taskAccess.noExplicitOperation -ne 400) {
        throw 'Maintenance access boundary failed.'
    }
    $taskStage = 'readonly-preflight'
    $taskBefore = Get-MaintenanceJson "$taskUrl/preflight/0130" Get $taskAuth
    if ($taskBefore.supported -ne $true -or $taskBefore.withinBudget -ne $true) { throw 'Unsupported target or maintenance size.' }
    $taskStage = 'apply-0130'
    $taskFirst = Get-MaintenanceJson "$taskUrl/migrate/0130" Post $taskWriteAuth
    if ($taskFirst.migration -ne '0130-user-withdrawal-replay' -or $taskFirst.ready -ne $true -or
        $taskFirst.before.rows -ne $taskFirst.after.rows -or $taskFirst.before.sha256 -ne $taskFirst.after.sha256) {
        throw 'Mutation did not confirm exact scope and unchanged business fingerprint.'
    }
    $taskStage = 'independent-readonly-postflight'
    $taskAfter = Get-MaintenanceJson "$taskUrl/preflight/0130" Get $taskAuth
    if ($taskAfter.supported -ne $true -or $taskAfter.ready -ne $true) { throw 'Independent catalog postflight failed.' }
    if ($VerifyIdempotence) {
        # Explicit second execution only AFTER first commit and independent
        # postflight both confirmed. Never a retry of an unknown first outcome.
        $taskStage = 'verify-idempotent-noop'
        $taskRepeat = Get-MaintenanceJson "$taskUrl/migrate/0130" Post $taskWriteAuth
        if ($taskRepeat.ready -ne $true -or $taskRepeat.applied -ne $false -or
            $taskRepeat.before.sha256 -ne $taskRepeat.after.sha256 -or $taskRepeat.before.rows -ne $taskRepeat.after.rows) {
            throw 'Second operation was not the expected verified no-op.'
        }
    }
    $taskStage = 'completed'
} catch {
    $taskFailure = 'Maintenance did not fully confirm completion; use lastStage and independent read-only inspection, never blindly retry.'
} finally {
    if ($taskAttempted) {
        try {
            $taskDelete = & node $taskCli delete $taskName --config $taskConfig --force 2>&1
            $taskDeleted = $LASTEXITCODE -eq 0
            $taskRemoved = Invoke-WebRequest -Uri $taskApi -Headers $taskApiHeaders -SkipHttpErrorCheck -TimeoutSec 20
            $taskMissing = [int]$taskRemoved.StatusCode -eq 404
        } catch { $taskFailure = 'Temporary maintenance Worker cleanup needs verification.' }
    }
    $taskToken = $null
    $taskAuth = $null
    $taskWriteAuth = $null
}
[ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    workerName = $taskName
    url = $taskUrl
    before = $taskBefore
    first = $taskFirst
    after = $taskAfter
    idempotence = $taskRepeat
    access = $taskAccess
    cleanup = @{ attempted=$taskAttempted;deleteSucceeded=$taskDeleted;controlPlaneMissing=$taskMissing }
    lastStage = $taskStage
    failure = $taskFailure
} | ConvertTo-Json -Depth 8
if ($taskFailure -or -not $taskMissing -or $taskStage -ne 'completed') { exit 2 }
