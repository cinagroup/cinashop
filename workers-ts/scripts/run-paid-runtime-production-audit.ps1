# Deploy only a new, random, expiring diagnostic Worker, then remove that exact
# Worker even if deployment or the HTTP check fails. Never changes cinashop-api.
[CmdletBinding()]
param([switch]$CatalogOnly)
$ErrorActionPreference = 'Stop'
if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'CLOUDFLARE_API_TOKEN is required' }
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskConfig = Join-Path $taskRoot 'test/integration/paid-runtime-audit.wrangler.jsonc'
$taskCli = Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskName = 'cinashop-paid-runtime-audit-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$taskAccount = '7ea8e46d8210bad342fa7595f7935fea'
$taskApi = "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$taskName"
$taskApiHeaders = @{ Authorization = ('Bearer ' + $env:CLOUDFLARE_API_TOKEN) }
$taskToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskTokenHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskExpiry = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$taskAttempted = $false
$taskDeleted = $false
$taskMissing = $false
$taskReport = $null
$taskFailure = $null
$taskNoTokenStatus = 0
$taskWrongMethodStatus = 0
$taskWrongPathStatus = 0
$taskUrl = $null
$taskStage = 'target-absence'
$taskRoute = if ($CatalogOnly) { 'catalog' } else { 'audit' }
$taskScope = if ($CatalogOnly) { 'release-prerequisite-catalog' } else { 'paid-order-runtime-permissions' }
$env:CLOUDFLARE_ACCOUNT_ID = $taskAccount
$env:WRANGLER_SEND_METRICS = 'false'
$env:WRANGLER_LOG_PATH = Join-Path $env:TEMP "$taskName.log"

try {
    # Authoritatively prove this target was absent before claiming cleanup rights.
    $taskBefore = Invoke-WebRequest -Uri $taskApi -Headers $taskApiHeaders -SkipHttpErrorCheck -TimeoutSec 20
    if ([int]$taskBefore.StatusCode -ne 404) { throw 'Temporary target absence was not established' }
    $taskAttempted = $true
    $taskStage = 'deploy'
    $taskDeploy = & node $taskCli deploy --config $taskConfig --name $taskName `
        --var "AUDIT_TOKEN_SHA256:$taskTokenHash" --var "AUDIT_EXPIRES_AT:$taskExpiry" 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Temporary Worker deployment failed' }
    $taskMatch = [regex]::Match(($taskDeploy -join "`n"), 'https://' + [regex]::Escape($taskName) + '\.[a-z0-9-]+\.workers\.dev')
    if (-not $taskMatch.Success) { throw 'Expected owned Worker URL not found' }
    $taskUrl = $taskMatch.Value
    $taskEndpoint = "$taskUrl/$taskRoute"
    $taskStage = 'access-boundaries'
    $taskNoTokenStatus = [int](Invoke-WebRequest -Uri $taskEndpoint -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskAuth = @{ 'X-Audit-Token' = $taskToken }
    $taskWrongMethodStatus = [int](Invoke-WebRequest -Uri $taskEndpoint -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskWrongPathStatus = [int](Invoke-WebRequest -Uri ($taskEndpoint + '?schema=other') -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    if ($taskNoTokenStatus -ne 403 -or $taskWrongMethodStatus -ne 405 -or $taskWrongPathStatus -ne 404) {
        throw 'Online access boundary check failed'
    }
    $taskStage = 'database-audit'
    $taskResponse = Invoke-WebRequest -Uri $taskEndpoint -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 30
    if ([int]$taskResponse.StatusCode -ne 200) { throw 'Online permission audit could not complete' }
    if ($taskResponse.Headers['Cache-Control'] -notcontains 'no-store') { throw 'Audit response cache policy mismatch' }
    $taskReport = $taskResponse.Content | ConvertFrom-Json
    if ($taskReport.scope -ne $taskScope -or (-not $CatalogOnly -and $taskReport.ready -isnot [bool]) -or
        ($CatalogOnly -and $taskReport.catalog.schemaPresent -isnot [bool])) {
        $taskReport = $null
        throw 'Unexpected audit response shape'
    }
    $taskStage = 'audit-completed'
} catch {
    # Never print raw network/CLI exceptions which may contain credential context.
    $taskFailure = 'Deployment or audit did not complete; inspect sanitized stage evidence before retrying.'
} finally {
    if ($taskAttempted) {
        try {
            $taskDelete = & node $taskCli delete $taskName --config $taskConfig --force 2>&1
            $taskDeleted = $LASTEXITCODE -eq 0
            $taskAfter = Invoke-WebRequest -Uri $taskApi -Headers $taskApiHeaders -SkipHttpErrorCheck -TimeoutSec 20
            $taskMissing = [int]$taskAfter.StatusCode -eq 404
        } catch { $taskFailure = 'Temporary Worker cleanup needs verification.' }
    }
    $taskToken = $null
    $taskAuth = $null
}
[ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    workerName = $taskName
    url = $taskUrl
    scope = "$taskScope; evidence only, not full migration or application readiness"
    report = $taskReport
    access = @{ noToken = $taskNoTokenStatus; wrongMethod = $taskWrongMethodStatus; queryInput = $taskWrongPathStatus }
    cleanup = @{ attempted = $taskAttempted; deleteSucceeded = $taskDeleted; controlPlaneMissing = $taskMissing }
    failure = $taskFailure
    lastAuditStage = $taskStage
} | ConvertTo-Json -Depth 8
if ($taskFailure -or -not $taskMissing -or $null -eq $taskReport) { exit 2 }
if (-not $CatalogOnly -and -not $taskReport.ready) { exit 1 }
