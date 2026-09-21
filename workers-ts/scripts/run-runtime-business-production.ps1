# Explicit fixed maintenance modes. No credentials, arbitrary SQL or main cutover.
[CmdletBinding()]
param([switch]$InspectOnly,[switch]$ApplyShippingSchema,[switch]$ApplyGrants,[switch]$ExerciseOnly)
$ErrorActionPreference='Stop'
if ((@($InspectOnly,$ApplyShippingSchema,$ApplyGrants,$ExerciseOnly) | Where-Object {$_}).Count -ne 1) {throw 'Select exactly one explicit maintenance mode.'}
if (-not $env:CLOUDFLARE_API_TOKEN) {throw 'Cloudflare credentials required.'}
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskConfig=Join-Path $taskRoot 'test/integration/runtime-business-commission.wrangler.jsonc'
$taskCli=Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskName='cinashop-runtime-maint-'+[Guid]::NewGuid().ToString('N').Substring(0,12)
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
$taskState=$null;$taskAfterState=$null;$taskMutation=$null;$taskVerification=$null;$taskExercise=$null;$taskAccess=@{};$taskUrl=$null
$taskApplyPath=if($ApplyShippingSchema){'/shipping-schema'}else{'/apply'}
$taskOperation=if($ApplyShippingSchema){'shipping-replay-schema-0154-v1'}else{'isolated-business-runtime-v1'}
function Get-RuntimeStatus {
    $taskReply=Invoke-WebRequest -Uri "$taskUrl/status" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 45
    if ([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Preflight unavailable.'}
    $taskValue=$taskReply.Content | ConvertFrom-Json -Depth 12
    if ($taskValue.operation -ne 'isolated-business-runtime-v1' -or $taskValue.applyEnabled -isnot [bool]) {throw 'Unexpected runtime status.'}
    return $taskValue
}
$taskSettingsApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/cinashop-api/settings"
$taskBefore=Invoke-RestMethod -Uri $taskSettingsApi -Headers $taskHeaders -TimeoutSec 20
$taskBindings=@($taskBefore.result.bindings | Where-Object type -eq 'hyperdrive' | Select-Object name,id)
if ($taskBindings.Count -ne 1 -or $taskBindings[0].id -ne '9748c294e21c49a99579c9cef70102e0') {throw 'Unexpected main binding.'}
try {
    if ([int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -ne 404) {throw 'Target absence not established.'}
    $taskAttempted=$true;$taskStage='deploy'
    $taskDeploy=& node $taskCli deploy --config $taskConfig --name $taskName --var "AUDIT_TOKEN_SHA256:$taskHash" --var "AUDIT_EXPIRES_AT:$taskExpiry" 2>&1
    if ($LASTEXITCODE -ne 0) {throw 'Deployment unconfirmed.'}
    $taskMatch=[regex]::Match(($taskDeploy -join "`n"),'https://'+[regex]::Escape($taskName)+'\.[a-z0-9-]+\.workers\.dev')
    if (-not $taskMatch.Success) {throw 'Owned URL unavailable.'};$taskUrl=$taskMatch.Value
    $taskAuth=@{'X-Audit-Token'=$taskToken};$taskStage='access-boundaries'
    for ($taskTry=0;$taskTry -lt 8;$taskTry++) {
        $taskAccess.anonymous=[int](Invoke-WebRequest -Uri "$taskUrl/status" -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
        if ($taskAccess.anonymous -ne 404) {break};if ($taskTry -lt 7) {Start-Sleep -Milliseconds 1000}
    }
    $taskAccess.method=[int](Invoke-WebRequest -Uri "$taskUrl$taskApplyPath" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskAccess.query=[int](Invoke-WebRequest -Uri "$taskUrl/status?sql=none" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskAccess.operation=[int](Invoke-WebRequest -Uri "$taskUrl$taskApplyPath" -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    if ($taskAccess.anonymous -ne 403 -or $taskAccess.method -ne 405 -or $taskAccess.query -ne 404 -or $taskAccess.operation -ne 400) {throw 'Boundary failed.'}
    $taskStage='readonly-preflight'
    $taskState=Get-RuntimeStatus
    if ($ApplyShippingSchema -or $ApplyGrants) {
        if (@($taskState.roles).Count -ne 2 -or @($taskState.roles | Where-Object {$_.restricted -ne $true -or $_.empty -ne $true -or $_.no_definer -ne $true -or $_.no_default_grants -ne $true}).Count -ne 0) {throw 'New roles are not empty and restricted.'}
        if ($ApplyShippingSchema) {
            if ($taskState.shippingReplay.present -ne $false -or @($taskState.missingTables).Count -ne 1 -or $taskState.missingTables[0] -ne 'shipping_template_create_replay') {throw 'Only the one confirmed missing prerequisite is authorized in this mode.'}
        } else {
            if ($taskState.applyEnabled -ne $true -or $taskState.tablesReady -ne $true -or $taskState.sequencesReady -ne $true -or $taskState.pricingReady -ne $true -or $taskState.offlineReady -ne $true -or $taskState.refundProtocolsReady -ne $true -or $taskState.shippingReplay.complete -ne $true) {throw 'Runtime commissioning prerequisites incomplete.'}
        }
        $taskStage='single-fixed-apply'
        $taskWrite=@{'X-Audit-Token'=$taskToken;'X-Migration-Operation'=$taskOperation}
        $taskReply=Invoke-WebRequest -Uri "$taskUrl$taskApplyPath" -Method Post -Headers $taskWrite -SkipHttpErrorCheck -TimeoutSec 45
        if ([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Apply outcome unconfirmed; inspect only before further action.'}
        $taskMutation=$taskReply.Content | ConvertFrom-Json -Depth 12
        if ($taskMutation.operation -ne $taskOperation) {throw 'Operation response mismatch.'}
        $taskStage='independent-postflight';$taskAfterState=Get-RuntimeStatus
        if ($ApplyShippingSchema -and ($taskMutation.after.complete -ne $true -or $taskMutation.businessGrantsApplied -ne $false -or $taskAfterState.shippingReplay.complete -ne $true -or $taskAfterState.shippingReplay.oid -ne $taskMutation.after.oid)) {throw 'Schema postflight mismatch.'}
        if ($ApplyGrants -and $taskMutation.grantsApplied -ne $true) {throw 'Grant response mismatch.'}
    }
    $taskStage='independent-login-verification'
    $taskReply=Invoke-WebRequest -Uri "$taskUrl/verify" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 45
    if ([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {
        if ([int]$taskReply.StatusCode -eq 503) {
            $taskSafeError=$taskReply.Content | ConvertFrom-Json
            $taskVerification=@{httpStatus=503;sqlState=$null}
            if ($taskSafeError.sqlState -match '^[0-9A-Z]{5}$') {$taskVerification.sqlState=$taskSafeError.sqlState}
            if ($taskSafeError.stage -match '^(app|admin):(connection|root|setup|identity|tables|columns|sequences|pricing|routines|defaults|staff|locks|close)$') {$taskVerification.stage=$taskSafeError.stage}
        }
        throw 'Verification unavailable.'
    }
    $taskVerification=$taskReply.Content | ConvertFrom-Json -Depth 12
    if ($taskVerification.operation -ne 'isolated-business-runtime-v1') {throw 'Unexpected verification.'}
    if (($ApplyGrants -or $ExerciseOnly) -and $taskVerification.ready -ne $true) {throw 'Independent runtime authority verification incomplete.'}
    if ($ApplyGrants -or $ExerciseOnly) {
        $taskStage='rollback-business-exercise'
        $taskWrite=@{'X-Audit-Token'=$taskToken;'X-Migration-Operation'='isolated-runtime-rollback-exercise-v1'}
        $taskReply=Invoke-WebRequest -Uri "$taskUrl/exercise" -Method Post -Headers $taskWrite -SkipHttpErrorCheck -TimeoutSec 60
        if ([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Business exercise outcome unconfirmed; inspect before another attempt.'}
        $taskExercise=$taskReply.Content | ConvertFrom-Json -Depth 12
        if ($taskExercise.operation -ne 'isolated-runtime-rollback-exercise-v1' -or $taskExercise.passed -ne $true -or @($taskExercise.profiles).Count -ne 2 -or @($taskExercise.profiles | Where-Object {$_.rolledBack -ne $true -or $_.remainingSyntheticRows -ne 0 -or $_.externalIo -ne $false}).Count -ne 0) {throw 'Rollback exercise verification mismatch.'}
    }
    $taskStage='completed'
} catch {$taskFailure='Runtime maintenance not fully confirmed; use read-only inspection before further mutation.'}
finally {
    if ($taskAttempted) {try {
        $taskDelete=& node $taskCli delete $taskName --config $taskConfig --force 2>&1;$taskDeleted=$LASTEXITCODE -eq 0
        $taskMissing=[int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -eq 404
    } catch {$taskFailure='Temporary Worker cleanup requires verification.'}}
    $taskToken=$null;$taskAuth=$null;$taskWrite=$null
}
$taskAfter=Invoke-RestMethod -Uri $taskSettingsApi -Headers $taskHeaders -TimeoutSec 20
$taskFinal=@($taskAfter.result.bindings | Where-Object type -eq 'hyperdrive' | Select-Object name,id)
$taskUnchanged=($taskFinal | ConvertTo-Json -Compress) -eq ($taskBindings | ConvertTo-Json -Compress)
$taskReceipt=[ordered]@{generatedAt=[DateTimeOffset]::UtcNow.ToString('o');workerName=$taskName;stage=$taskStage;state=$taskState;mutation=$taskMutation;afterState=$taskAfterState;
    verification=$taskVerification;exercise=$taskExercise;access=$taskAccess;mainBindingsUnchanged=$taskUnchanged;
    cleanup=@{deleted=$taskDeleted;controlPlaneMissing=$taskMissing};failure=$taskFailure}
[IO.File]::WriteAllText((Join-Path $taskDirectory 'receipt.json'),($taskReceipt | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
$taskReceipt | ConvertTo-Json -Depth 12
if ($taskFailure -or -not $taskMissing -or -not $taskUnchanged -or $taskStage -ne 'completed') {exit 2}
