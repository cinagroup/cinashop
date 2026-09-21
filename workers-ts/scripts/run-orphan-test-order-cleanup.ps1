[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BackupPath,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$BackupSha256,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$SnapshotSha256,
  [Parameter(Mandatory)][switch]$Apply
)
$ErrorActionPreference='Stop'
if (-not $Apply -or -not $env:CLOUDFLARE_API_TOKEN) { throw 'Explicit Apply and configured Cloudflare token required' }
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskResolved=[IO.Path]::GetFullPath($BackupPath)
$taskCache=Join-Path (Split-Path -Parent $taskRoot) '.cache'
if ($taskResolved -notmatch ('^'+[regex]::Escape($taskCache)+'\\orphan-test-orders-[a-f0-9]{32}\\backup\.json$')) { throw 'Unapproved backup path' }
$taskDirectory=Split-Path -Parent $taskResolved
$taskAllowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18')
foreach ($taskPath in @($taskDirectory,$taskResolved)) {
  $taskAcl=Get-Acl -LiteralPath $taskPath
  if (($taskPath -eq $taskDirectory -and -not $taskAcl.AreAccessRulesProtected) -or
    @($taskAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -notin $taskAllowed}).Count) { throw 'Backup ACL drift' }
}
if ((Get-FileHash -LiteralPath $taskResolved -Algorithm SHA256).Hash.ToLowerInvariant() -ne $BackupSha256) { throw 'Backup file hash drift' }
$taskLocalDigest=& node -e 'const fs=require("node:fs"),crypto=require("node:crypto"),r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const {version,identity,...s}=r.backup; if(version!==1||r.targetCount!==12||s.orders.length!==12)throw Error("Invalid backup"); const h=crypto.createHash("sha256").update(JSON.stringify(s)).digest("hex");if(h!==r.snapshotSha256)throw Error("Snapshot digest mismatch");process.stdout.write(h);' $taskResolved
if ($LASTEXITCODE -ne 0 -or $taskLocalDigest -ne $SnapshotSha256) { throw 'Backup snapshot verification failed' }
$taskName='cinashop-orphan-cleanup-'+[Guid]::NewGuid().ToString('N').Substring(0,12)
$taskConfig=Join-Path $taskRoot 'test/integration/orphan-cleanup.wrangler.jsonc'
$taskCli=Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskApi="https://api.cloudflare.com/client/v4/accounts/7ea8e46d8210bad342fa7595f7935fea/workers/scripts/$taskName"
$taskApiHeaders=@{Authorization='Bearer '+$env:CLOUDFLARE_API_TOKEN}
$taskToken=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskTokenHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskExpiry=[DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$env:CLOUDFLARE_ACCOUNT_ID='7ea8e46d8210bad342fa7595f7935fea'
$env:WRANGLER_SEND_METRICS='false'
$env:WRANGLER_LOG_PATH=Join-Path $env:TEMP "$taskName.log"
$taskAttempted=$false; $taskWriteSent=$false; $taskMissing=$false; $taskDeleted=$false
$taskBefore=$null; $taskResult=$null; $taskAfter=$null; $taskFailure=$null; $taskStage='backup-verified'
$taskUrl=$null; $taskAccess=@{}
$taskWriteStatus=$null; $taskWriteDiagnostic=$null
function Read-CleanupStatus {
  $taskResponse=Invoke-WebRequest -Uri "$taskUrl/status" -Headers $taskAuth -TimeoutSec 30 -SkipHttpErrorCheck
  if ([int]$taskResponse.StatusCode -ne 200 -or $taskResponse.Headers['Cache-Control'] -notcontains 'no-store') { throw 'Status unconfirmed' }
  $taskStatus=$taskResponse.Content | ConvertFrom-Json
  if ($taskStatus.scope -ne 'orphan-test-cleanup-result') { throw 'Unexpected status shape' }
  return $taskStatus
}
try {
  if ([int](Invoke-WebRequest -Uri $taskApi -Headers $taskApiHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -ne 404) { throw 'Temporary target was not absent' }
  $taskAttempted=$true; $taskStage='deploy'
  $taskDeploy=& node $taskCli deploy --config $taskConfig --name $taskName --var "AUDIT_TOKEN_SHA256:$taskTokenHash" --var "AUDIT_EXPIRES_AT:$taskExpiry" --var "ORPHAN_BACKUP_SHA256:$SnapshotSha256" 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Maintenance deployment failed' }
  $taskMatch=[regex]::Match(($taskDeploy -join "`n"),'https://'+[regex]::Escape($taskName)+'\.[a-z0-9-]+\.workers\.dev')
  if (-not $taskMatch.Success) { throw 'Temporary URL missing' }
  $taskUrl=$taskMatch.Value; $taskAuth=@{'X-Audit-Token'=$taskToken}; $taskStage='boundary-checks'
  for ($taskAttempt=0;$taskAttempt -lt 8;$taskAttempt++) {
    $taskAccess.anonymous=[int](Invoke-WebRequest -Uri "$taskUrl/status" -SkipHttpErrorCheck -TimeoutSec 10).StatusCode
    if ($taskAccess.anonymous -eq 403) { break }; if ($taskAccess.anonymous -ne 404) { throw 'Unexpected readiness' }; Start-Sleep -Seconds 2
  }
  Start-Sleep -Seconds 5
  $taskAccess.wrongMethod=[int](Invoke-WebRequest -Uri "$taskUrl/cleanup" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
  $taskAccess.noOperation=[int](Invoke-WebRequest -Uri "$taskUrl/cleanup" -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
  $taskAccess.queryInput=[int](Invoke-WebRequest -Uri "$taskUrl/cleanup?scope=all" -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
  if ($taskAccess.anonymous -ne 403 -or $taskAccess.wrongMethod -ne 405 -or $taskAccess.noOperation -ne 400 -or $taskAccess.queryInput -ne 404) { throw 'Boundary checks failed' }
  $taskStage='readonly-before'; $taskBefore=Read-CleanupStatus
  if ($taskBefore.remainingOrphans -ne 12) { throw 'Twelve-order target changed' }
  $taskStage='single-delete-request'; $taskWriteSent=$true
  $taskWriteAuth=@{'X-Audit-Token'=$taskToken;'X-Maintenance-Operation'='delete-backed-up-12-orphan-test-orders'}
  # Exactly one POST. A timeout, non-200 or close failure is never retried.
  $taskResponse=Invoke-WebRequest -Uri "$taskUrl/cleanup" -Method Post -Headers $taskWriteAuth -SkipHttpErrorCheck -TimeoutSec 30
  $taskWriteStatus=[int]$taskResponse.StatusCode
  if ($taskWriteStatus -ne 200) {
    try { $taskErrorBody=$taskResponse.Content | ConvertFrom-Json
      $taskWriteDiagnostic=@{sqlState=$taskErrorBody.sqlState;reason=$taskErrorBody.reason}
    } catch {}
  }
  if ([int]$taskResponse.StatusCode -ne 200 -or $taskResponse.Headers['Cache-Control'] -notcontains 'no-store') { throw 'Deletion result unconfirmed' }
  $taskResult=$taskResponse.Content | ConvertFrom-Json
  if ($taskResult.scope -ne 'orphan-test-order-cleanup' -or $taskResult.ready -ne $true -or $taskResult.applied -ne $true -or
    $taskResult.snapshotSha256 -ne $SnapshotSha256 -or $taskResult.remainingOrphans -ne 0 -or $taskResult.preservedCandidateRows -ne 1 -or
    ($taskResult.deleted | Measure-Object -Property rows -Sum).Sum -ne 58) { throw 'Unexpected deletion result' }
  $taskStage='independent-postflight'; $taskAfter=Read-CleanupStatus
  if ($taskAfter.remainingOrphans -ne 0 -or ($taskAfter.retained | ConvertTo-Json -Depth 6 -Compress) -ne
    ($taskResult.retained | ConvertTo-Json -Depth 6 -Compress)) { throw 'Independent postflight mismatch' }
  $taskStage='verified-complete'
} catch {
  $taskFailure='Maintenance completion not confirmed. Inspect receipt and read-only status; never blindly retry.'
  if ($taskWriteSent -and $taskUrl) { try {$taskAfter=Read-CleanupStatus} catch {} }
} finally {
  if ($taskAttempted) { try {
    $taskDelete=& node $taskCli delete $taskName --config $taskConfig --force 2>&1
    $taskDeleted=$LASTEXITCODE -eq 0
    $taskMissing=[int](Invoke-WebRequest -Uri $taskApi -Headers $taskApiHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -eq 404
  } catch {$taskFailure='Temporary Worker cleanup needs verification'} }
  $taskToken=$null; $taskAuth=$null; $taskWriteAuth=$null
}
$taskReceipt=[ordered]@{generatedAt=[DateTimeOffset]::UtcNow.ToString('o');workerName=$taskName;backupSha256=$BackupSha256;
  snapshotSha256=$SnapshotSha256;writeRequestSent=$taskWriteSent;writeStatus=$taskWriteStatus;writeDiagnostic=$taskWriteDiagnostic;stage=$taskStage;access=$taskAccess;
  before=$taskBefore;result=$taskResult;after=$taskAfter;cleanup=@{deleteSucceeded=$taskDeleted;controlPlaneMissing=$taskMissing};failure=$taskFailure}
$taskReceiptJson=$taskReceipt | ConvertTo-Json -Depth 10
$taskReceiptPath=Join-Path $taskDirectory ('cleanup-receipt-'+[Guid]::NewGuid().ToString('N')+'.json')
[IO.File]::WriteAllText($taskReceiptPath,$taskReceiptJson,[Text.UTF8Encoding]::new($false))
$taskReceiptJson
if ($taskFailure -or -not $taskMissing -or $taskStage -ne 'verified-complete') { exit 2 }
