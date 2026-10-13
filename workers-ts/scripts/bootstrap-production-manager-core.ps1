# Only the already-reviewed ledger/scope protocols. No LOGIN/password, business
# rows, App/Admin grants, application binding changes, or capabilities stage.
[CmdletBinding()]
param([ValidateSet('Plan','Inspect','Apply')][string]$Mode='Plan',[string]$EvidenceRoot)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskOperation='manager-ledger-scope-bootstrap-v1'
$taskOwner='cinashop_manager_scope_v1'
$taskAccount='7ea8e46d8210bad342fa7595f7935fea'
$taskSource='9748c294e21c49a99579c9cef70102e0'
if($Mode -eq 'Plan') {
    [ordered]@{mode='Plan';operation=$taskOperation;database='postgres';maintenanceRole='postgres';scopeOwner=$taskOwner;
        freshRequires='Both core protocols absent, scope owner absent, existing pricing/refund ready';
        canonicalReplay='Read-only exact canonical state; no reinstall';
        newObjects='Empty canonical ledger + two canonical scope functions + restricted NOLOGIN owner';
        exactAclAdditions=@('scope owner:public USAGE','scope owner:staff/carrier SELECT+UPDATE');
        credentialsCreated=$false;appAdminGrantsChanged=$false;businessRowsChanged=$false;productionActionsPerformed=$false} | ConvertTo-Json -Depth 4
    exit 0
}
if(-not $env:CLOUDFLARE_API_TOKEN -or -not $EvidenceRoot -or -not [IO.Path]::IsPathFullyQualified($EvidenceRoot)) {throw 'Explicit local absolute EvidenceRoot and Cloudflare credentials required.'}
$taskEvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
if($taskEvidenceRoot.StartsWith('\\')) {throw 'Use the authorized stable local evidence directory.'}
$taskName='cinashop-manager-bootstrap-'+[Guid]::NewGuid().ToString('N').Substring(0,12)
$taskDirectory=Join-Path $taskEvidenceRoot $taskName
$null=New-Item -ItemType Directory -Path $taskDirectory
$taskTemplate=Join-Path $taskRoot 'test/integration/manager-bootstrap.wrangler.jsonc'
$taskCli=Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$taskName"
$taskHeaders=@{Authorization='Bearer '+$env:CLOUDFLARE_API_TOKEN}
$taskToken=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskStage='target-absence';$taskBefore=$null;$taskAfter=$null;$taskMutation=$null;$taskFailure=$null;$taskFailureReason=$null;$taskAttempted=$false;$taskMissing=$false;$taskInstallAttempted=$false
$taskBoundaries=[ordered]@{anonymous=@();authenticated=$null;query=$null;method=$null;readOnlyRoute='/inspect';readOnlyMethod='POST'}
$taskReceiptPath=Join-Path $taskDirectory 'receipt.json'
$env:CLOUDFLARE_ACCOUNT_ID=$taskAccount;$env:WRANGLER_SEND_METRICS='false';$env:WRANGLER_LOG_PATH=Join-Path $taskDirectory 'wrangler.log'
function Save-Receipt {
    $taskReceipt=[ordered]@{generatedAt=[DateTimeOffset]::UtcNow.ToString('o');workerName=$taskName;mode=$Mode;stage=$taskStage;
        before=$taskBefore;mutation=$taskMutation;after=$taskAfter;installAttempted=$taskInstallAttempted;
        credentialsCreated=$false;appAdminGrantsChanged=$false;businessRowsChanged=$false;mainBindingsChanged=$false;
        accessBoundaries=$taskBoundaries;cleanup=@{deployAttempted=$taskAttempted;controlPlaneMissing=$taskMissing};failure=$taskFailure;failureReason=$taskFailureReason}
    $taskTemporary=Join-Path $taskDirectory ('receipt-'+[Guid]::NewGuid().ToString('N')+'.tmp')
    $taskFile=[IO.File]::Open($taskTemporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$taskFile.Write([Text.Encoding]::UTF8.GetBytes(($taskReceipt | ConvertTo-Json -Depth 16)));$taskFile.Flush($true)} finally {$taskFile.Dispose()}
    [IO.File]::Move($taskTemporary,$taskReceiptPath,$true)
}
function Safe-Probe($taskReply) {
    $taskKnownError=$null
    try {
        $taskMessage=($taskReply.Content | ConvertFrom-Json -Depth 4).error
        if($taskMessage -in @('forbidden','not found','method not allowed','mutation disabled','explicit fixed operation required','empty body required','invalid body','outcome not confirmed; inspect the fixed Manager catalogs before further action')) {$taskKnownError=$taskMessage}
    }catch{}
    return [ordered]@{status=[int]$taskReply.StatusCode;knownError=$taskKnownError;
        jsonContentType=([string]$taskReply.Headers['Content-Type'] -match '^application/json(?:\s*;|$)');bodyBytes=[Text.Encoding]::UTF8.GetByteCount([string]$taskReply.Content)}
}
function Read-State {
    $taskReadUri=$taskUrl.TrimEnd('/')+'/inspect'
    $taskReadAuth=@{'X-Audit-Token'=$taskToken;'X-Migration-Operation'='manager-ledger-scope-inspect-v1'}
    $taskReply=Invoke-WebRequest -Uri $taskReadUri -Method Post -Headers $taskReadAuth -SkipHttpErrorCheck -TimeoutSec 30
    $taskBoundaries.authenticated=Safe-Probe $taskReply
    Save-Receipt
    if([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Core bootstrap read-only state unavailable.'}
    return ($taskReply.Content | ConvertFrom-Json -Depth 16)
}
try {
    $taskOriginal=(Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$taskAccount/hyperdrive/configs/$taskSource" -Headers $taskHeaders -TimeoutSec 20).result
    if($taskOriginal.id -ne $taskSource -or $taskOriginal.origin.database -ne 'postgres' -or $taskOriginal.origin.user -ne 'postgres' -or $taskOriginal.origin.service_id -ne '019fe223-e5a1-7ed1-945a-8993a6f32508') {throw 'Fixed maintenance origin changed.'}
    if([int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -ne 404) {throw 'Fresh temporary Worker absence not proved.'}
    $taskConfig=Get-Content -Raw -LiteralPath $taskTemplate | ConvertFrom-Json -Depth 12
    $taskConfig.name=$taskName;$taskConfig.main=Join-Path $taskRoot 'test/integration/ManagerBootstrapWorker.ts'
    $taskConfig.'$schema'=Join-Path $taskRoot 'node_modules/wrangler/config-schema.json'
    $taskConfig | Add-Member -NotePropertyName account_id -NotePropertyValue $taskAccount
    $taskConfig.vars.AUDIT_TOKEN_SHA256=$taskHash;$taskConfig.vars.AUDIT_EXPIRES_AT=[DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
    $taskConfig.vars.BOOTSTRAP_ENABLED=$(if($Mode -eq 'Apply'){'true'}else{'false'})
    $taskConfigPath=Join-Path $taskDirectory 'wrangler.jsonc';[IO.File]::WriteAllText($taskConfigPath,($taskConfig | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    $taskStage='deploy';$taskAttempted=$true;Save-Receipt
    $taskDeploy=& node $taskCli deploy --config $taskConfigPath 2>&1
    if($LASTEXITCODE -ne 0) {throw 'Temporary bootstrap deployment unconfirmed.'}
    $taskMatch=[regex]::Match(($taskDeploy -join "`n"),'https://'+[regex]::Escape($taskName)+'\.[a-z0-9-]+\.workers\.dev')
    if(-not $taskMatch.Success) {throw 'Owned temporary bootstrap URL unavailable.'};$taskUrl=$taskMatch.Value
    $taskAuth=@{'X-Audit-Token'=$taskToken};$taskStage='access-boundaries'
    for($taskTry=0;$taskTry -lt 8;$taskTry++) {
        $taskAnonymousReply=Invoke-WebRequest -Uri "$taskUrl/status" -SkipHttpErrorCheck -TimeoutSec 20
        $taskAnonymous=[int]$taskAnonymousReply.StatusCode;$taskBoundaries.anonymous+=@(Safe-Probe $taskAnonymousReply);Save-Receipt
        if($taskAnonymous -eq 403){break};if($taskAnonymous -notin @(404,429,503)){throw 'Anonymous boundary differs.'};if($taskTry -lt 7){Start-Sleep -Milliseconds 1000}
    }
    if($taskAnonymous -ne 403){throw 'Anonymous propagation did not reach the fixed forbidden boundary.'}
    $taskBefore=Read-State
    $taskBoundaries.query=Safe-Probe (Invoke-WebRequest -Uri ($taskUrl.TrimEnd('/')+'/inspect?role=postgres') -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20)
    $taskBoundaries.method=Safe-Probe (Invoke-WebRequest -Uri ($taskUrl.TrimEnd('/')+'/status') -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20);Save-Receipt
    if($taskBoundaries.query.status -ne 404 -or $taskBoundaries.method.status -ne 405) {throw 'Bootstrap access boundaries not confirmed.'}
    $taskStage='readonly-preflight';Save-Receipt
    if($taskBefore.identity.supported -ne $true) {throw 'Fixed maintenance identity not confirmed.'}
    if($Mode -eq 'Apply') {
        if($taskBefore.state -notin @('fresh','canonical') -or $taskBefore.dependencies.pricing -ne $true -or $taskBefore.dependencies.refund -ne $true) {throw 'Core bootstrap fresh/canonical prerequisites not confirmed.'}
        $taskStage='single-fixed-install';$taskInstallAttempted=$true;Save-Receipt
        $taskWrite=@{'X-Audit-Token'=$taskToken;'X-Migration-Operation'=$taskOperation}
        $taskReply=Invoke-WebRequest -Uri "$taskUrl/install" -Method Post -Headers $taskWrite -SkipHttpErrorCheck -TimeoutSec 30
        if([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Install outcome unknown; inspect the fixed catalogs, never retry blindly.'}
        $taskMutation=$taskReply.Content | ConvertFrom-Json -Depth 16
        if($taskMutation.operation -ne $taskOperation -or $taskMutation.state.ready -ne $true) {throw 'Core bootstrap result mismatch.'}
        $taskStage='independent-readonly-postflight';$taskAfter=Read-State
        if($taskAfter.state -ne 'canonical' -or $taskAfter.ready -ne $true -or $taskAfter.scope.ownerOid -ne $taskMutation.state.scope.ownerOid -or $taskAfter.ledger.fingerprint -ne $taskMutation.state.ledger.fingerprint) {throw 'Canonical core bootstrap postflight mismatch.'}
    }
    $taskStage='completed';Save-Receipt
} catch {
    $taskSafeReasons=@('Fixed maintenance origin changed.','Fresh temporary Worker absence not proved.','Temporary bootstrap deployment unconfirmed.','Owned temporary bootstrap URL unavailable.',
        'Anonymous boundary differs.','Anonymous propagation did not reach the fixed forbidden boundary.','Core bootstrap read-only state unavailable.','Bootstrap access boundaries not confirmed.',
        'Fixed maintenance identity not confirmed.','Core bootstrap fresh/canonical prerequisites not confirmed.','Install outcome unknown; inspect the fixed catalogs, never retry blindly.',
        'Core bootstrap result mismatch.','Canonical core bootstrap postflight mismatch.')
    $taskFailureReason=$(if($_.Exception.Message -in $taskSafeReasons){$_.Exception.Message}else{'Transport or local execution failed at '+$taskStage+'. Inspect safe boundary status metadata.'})
    $taskFailure='Manager core bootstrap not fully confirmed. Preserve the receipt and perform read-only fixed-catalog inspection before any further action.'
}
finally {
    if($taskAttempted) {try {
        $taskCleanupStatus=[int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
        if($taskCleanupStatus -eq 200){$taskDelete=& node $taskCli delete $taskName --config $taskConfigPath --force 2>&1}
        elseif($taskCleanupStatus -ne 404){throw 'Owned temporary bootstrap existence unavailable.'}
        $taskMissing=[int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -eq 404
        if(-not $taskMissing){throw 'Owned temporary bootstrap absence unconfirmed.'}
    }catch{$taskFailure='Temporary bootstrap Worker cleanup needs control-plane verification.';$taskFailureReason='Cleanup API absence was not proved.'}}
    $taskToken=$null;$taskAuth=$null;$taskWrite=$null;Save-Receipt
}
[ordered]@{receiptPath=$taskReceiptPath;stage=$taskStage;installAttempted=$taskInstallAttempted;canonicalReady=($taskAfter.ready -eq $true);
    cleanupConfirmed=$taskMissing;failure=$taskFailure;failureReason=$taskFailureReason;accessBoundaries=$taskBoundaries} | ConvertTo-Json -Depth 6
if($taskFailure -or -not $taskMissing -or $taskStage -ne 'completed') {exit 2}
