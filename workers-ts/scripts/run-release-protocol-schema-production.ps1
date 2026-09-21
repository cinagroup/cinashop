# Fixed schema phase only. No credentials, business grants or application switch.
[CmdletBinding()]
param([switch]$Apply,[switch]$InspectOnly)
$ErrorActionPreference='Stop'
if (($Apply -and $InspectOnly) -or (-not $Apply -and -not $InspectOnly)) {throw 'Select explicit -Apply or -InspectOnly.'}
if (-not $env:CLOUDFLARE_API_TOKEN) {throw 'Cloudflare credentials required.'}
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskConfig=Join-Path $taskRoot 'test/integration/release-protocol-schema.wrangler.jsonc'
$taskCli=Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskName='cinashop-release-schema-'+[Guid]::NewGuid().ToString('N').Substring(0,12)
$taskAccount='7ea8e46d8210bad342fa7595f7935fea'
$taskApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$taskName"
$taskHeaders=@{Authorization='Bearer '+$env:CLOUDFLARE_API_TOKEN}
$taskToken=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskExpiry=[DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$taskDirectory=Join-Path (Split-Path -Parent $taskRoot) ('.cache/'+$taskName)
$null=New-Item -ItemType Directory -Path $taskDirectory
$env:CLOUDFLARE_ACCOUNT_ID=$taskAccount;$env:WRANGLER_SEND_METRICS='false';$env:WRANGLER_LOG_PATH=Join-Path $env:TEMP "$taskName.log"
$taskStage='target-absence';$taskAttempted=$false;$taskDeleted=$false;$taskMissing=$false;$taskFailure=$null
$taskBefore=$null;$taskResult=$null;$taskAfter=$null;$taskAccess=@{};$taskUrl=$null;$taskSqlState=$null
function Get-SchemaStatus {
    $taskReply=Invoke-WebRequest -Uri "$taskUrl/status" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 45
    if ([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Status unavailable.'}
    $taskValue=$taskReply.Content | ConvertFrom-Json -Depth 12
    if ($taskValue.operation -ne 'reviewed-indexes-and-0155-0160-schema-v1' -or $taskValue.schemaReady -isnot [bool] -or $taskValue.runtimeCommissioned -ne $false) {throw 'Unexpected status.'}
    return $taskValue
}
try {
    if ([int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -ne 404) {throw 'Target absence not established.'}
    $taskAttempted=$true;$taskStage='deploy'
    $taskDeploy=& node $taskCli deploy --config $taskConfig --name $taskName --var "AUDIT_TOKEN_SHA256:$taskHash" --var "AUDIT_EXPIRES_AT:$taskExpiry" 2>&1
    if ($LASTEXITCODE -ne 0) {throw 'Deployment unconfirmed.'}
    $taskMatch=[regex]::Match(($taskDeploy -join "`n"),'https://'+[regex]::Escape($taskName)+'\.[a-z0-9-]+\.workers\.dev')
    if (-not $taskMatch.Success) {throw 'Owned URL unavailable.'};$taskUrl=$taskMatch.Value
    $taskAuth=@{'X-Audit-Token'=$taskToken};$taskWrite=@{'X-Audit-Token'=$taskToken;'X-Migration-Operation'='reviewed-indexes-and-0155-0160-schema-v1'}
    $taskStage='access-boundaries'
    for ($taskTry=0;$taskTry -lt 8;$taskTry++) {
        $taskAccess.anonymous=[int](Invoke-WebRequest -Uri "$taskUrl/status" -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
        $taskAccess.method=[int](Invoke-WebRequest -Uri "$taskUrl/apply" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
        if ($taskAccess.anonymous -eq 403 -and $taskAccess.method -eq 405) {break}
        if ($taskAccess.anonymous -notin @(403,404) -or $taskAccess.method -notin @(404,405)) {break}
        if ($taskTry -lt 7) {Start-Sleep -Milliseconds 1000}
    }
    $taskAccess.query=[int](Invoke-WebRequest -Uri "$taskUrl/status?sql=none" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskAccess.operation=[int](Invoke-WebRequest -Uri "$taskUrl/apply" -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    if ($taskAccess.anonymous -ne 403 -or $taskAccess.method -ne 405 -or $taskAccess.query -ne 404 -or $taskAccess.operation -ne 400) {throw 'Boundary failed.'}
    $taskStage='readonly-preflight';$taskBefore=Get-SchemaStatus
    if ($Apply) {
        $taskStage='single-apply-post'
        $taskReply=Invoke-WebRequest -Uri "$taskUrl/apply" -Method Post -Headers $taskWrite -SkipHttpErrorCheck -TimeoutSec 45
        if ([int]$taskReply.StatusCode -ne 200) {
            if ([int]$taskReply.StatusCode -eq 503) {$taskSafeError=$taskReply.Content | ConvertFrom-Json;if ($taskSafeError.sqlState -match '^[0-9A-Z]{5}$') {$taskSqlState=$taskSafeError.sqlState}}
            throw 'Outcome unknown; inspect only before further action.'
        }
        if ($taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Cache policy mismatch.'}
        $taskResult=$taskReply.Content | ConvertFrom-Json -Depth 12
        if ($taskResult.operation -ne 'reviewed-indexes-and-0155-0160-schema-v1' -or $taskResult.schemaReady -ne $true -or
            $taskResult.runtimeCommissioned -ne $false -or ($taskResult.before | ConvertTo-Json -Depth 5 -Compress) -ne ($taskResult.after | ConvertTo-Json -Depth 5 -Compress)) {throw 'Commit verification mismatch.'}
        $taskStage='independent-readonly-postflight';$taskAfter=Get-SchemaStatus
        if ($taskAfter.schemaReady -ne $true -or ($taskAfter.fingerprint | ConvertTo-Json -Depth 5 -Compress) -ne ($taskResult.after | ConvertTo-Json -Depth 5 -Compress)) {throw 'Postflight mismatch; review concurrent writes.'}
    }
    $taskStage='completed'
} catch {$taskFailure='Schema maintenance not fully confirmed; use read-only inspection before any further mutation.'}
finally {
    if ($taskAttempted) {try {
        $taskDelete=& node $taskCli delete $taskName --config $taskConfig --force 2>&1;$taskDeleted=$LASTEXITCODE -eq 0
        $taskMissing=[int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -eq 404
    } catch {$taskFailure='Temporary Worker cleanup requires verification.'}}
    $taskToken=$null;$taskAuth=$null;$taskWrite=$null
}
$taskReceipt=[ordered]@{generatedAt=[DateTimeOffset]::UtcNow.ToString('o');workerName=$taskName;stage=$taskStage;
    before=$taskBefore;result=$taskResult;after=$taskAfter;access=$taskAccess;sqlState=$taskSqlState;
    cleanup=@{deleted=$taskDeleted;controlPlaneMissing=$taskMissing};failure=$taskFailure}
[IO.File]::WriteAllText((Join-Path $taskDirectory 'receipt.json'),($taskReceipt | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
$taskReceipt | ConvertTo-Json -Depth 12
if ($taskFailure -or -not $taskMissing -or $taskStage -ne 'completed') {exit 2}
