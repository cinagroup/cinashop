# Explicit stage 1 only. Creates three uncommissioned roles, not table grants,
# Hyperdrive updates, application deployment or automatic retry/password reset.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop'
if (-not $Apply) { throw 'Explicit -Apply required.' }
if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'Cloudflare credentials required.' }
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskConfig=Join-Path $taskRoot 'test/integration/runtime-role-provision.wrangler.jsonc'
$taskCli=Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskName='cinashop-role-provision-'+[Guid]::NewGuid().ToString('N').Substring(0,12)
$taskAccount='7ea8e46d8210bad342fa7595f7935fea'
$taskApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$taskName"
$taskHeaders=@{Authorization='Bearer '+$env:CLOUDFLARE_API_TOKEN}
function New-PrivateHex { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
function Get-TextDigest([string]$Value) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant() }
$taskToken=New-PrivateHex
$taskBody=[ordered]@{appPassword=(New-PrivateHex);adminPassword=(New-PrivateHex)} | ConvertTo-Json -Compress
$taskBodyHash=Get-TextDigest $taskBody
$taskExpiry=[DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$taskAttempted=$false; $taskDeleted=$false; $taskMissing=$false; $taskFailure=$null
$taskStage='private-credential-retention'; $taskUrl=$null; $taskBefore=$null; $taskResult=$null; $taskAfter=$null
$taskAccess=@{}; $taskDirectory=$null; $taskCredentialPath=$null
$env:CLOUDFLARE_ACCOUNT_ID=$taskAccount; $env:WRANGLER_SEND_METRICS='false'
$env:WRANGLER_LOG_PATH=Join-Path $env:TEMP "$taskName.log"
function Get-ProvisionStatus([string]$Uri,[hashtable]$Headers) {
    $taskReply=Invoke-WebRequest -Uri $Uri -Headers $Headers -SkipHttpErrorCheck -TimeoutSec 30
    if ([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') { throw 'Unconfirmed status.' }
    return ($taskReply.Content | ConvertFrom-Json)
}
try {
    # Secrets are DPAPI-encrypted for the current Windows user, under a private
    # ignored ACL-protected directory. Never write cleartext credentials to disk.
    $taskDirectory=Join-Path (Split-Path -Parent $taskRoot) ('.cache/runtime-role-credentials-'+[Guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $taskDirectory
    $taskAcl=Get-Acl -LiteralPath $taskDirectory; $taskAcl.SetAccessRuleProtection($true,$false)
    $taskUserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($taskSid in @($taskUserSid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    Set-Acl -LiteralPath $taskDirectory -AclObject $taskAcl
    $taskSavedAcl=Get-Acl -LiteralPath $taskDirectory
    if (-not $taskSavedAcl.AreAccessRulesProtected -or @($taskSavedAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) |
        Where-Object {$_.IdentityReference.Value -notin @($taskUserSid.Value,'S-1-5-18')}).Count) { throw 'Private ACL verification failed.' }
    $taskCredentialPath=Join-Path $taskDirectory 'credentials.dpapi'
    $taskEncrypted=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($taskBody),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $taskFile=[IO.File]::Open($taskCredentialPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$taskFile.Write($taskEncrypted);$taskFile.Flush($true)} finally {$taskFile.Dispose()}
    $taskReadback=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($taskCredentialPath),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ((Get-TextDigest ([Text.Encoding]::UTF8.GetString($taskReadback))) -ne $taskBodyHash) { throw 'Private credential readback failed.' }
    $taskReadback=$null
    $taskStage='target-absence'
    if ([int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -ne 404) { throw 'Target absence not proved.' }
    $taskAttempted=$true; $taskStage='deploy'
    $taskDeploy=& node $taskCli deploy --config $taskConfig --name $taskName `
      --var "AUDIT_TOKEN_SHA256:$(Get-TextDigest $taskToken)" --var "AUDIT_EXPIRES_AT:$taskExpiry" --var "CREDENTIALS_BODY_SHA256:$taskBodyHash" 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Maintenance deployment not confirmed.' }
    $taskMatch=[regex]::Match(($taskDeploy -join "`n"),'https://'+[regex]::Escape($taskName)+'\.[a-z0-9-]+\.workers\.dev')
    if (-not $taskMatch.Success) { throw 'Owned URL missing.' }; $taskUrl=$taskMatch.Value
    $taskAuth=@{'X-Audit-Token'=$taskToken}
    $taskWriteAuth=@{'X-Audit-Token'=$taskToken;'X-Maintenance-Operation'='provision-uncommissioned-runtime-roles-v1'}
    $taskStage='access-boundaries'
    for ($taskAttempt=0;$taskAttempt -lt 8;$taskAttempt++) {
        $taskAccess.anonymous=[int](Invoke-WebRequest -Uri "$taskUrl/status" -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
        $taskAccess.wrongMethod=[int](Invoke-WebRequest -Uri "$taskUrl/provision" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
        if ($taskAccess.anonymous -eq 403 -and $taskAccess.wrongMethod -eq 405) {break}
        if ($taskAccess.anonymous -notin @(403,404) -or $taskAccess.wrongMethod -notin @(405,404)) {break}
        if ($taskAttempt -lt 7) {Start-Sleep -Milliseconds 1000}
    }
    $taskAccess.query=[int](Invoke-WebRequest -Uri "$taskUrl/status?role=other" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskAccess.noOperation=[int](Invoke-WebRequest -Uri "$taskUrl/provision" -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    if ($taskAccess.anonymous -ne 403 -or $taskAccess.wrongMethod -ne 405 -or $taskAccess.query -ne 404 -or $taskAccess.noOperation -ne 400) {throw 'Access boundary failed.'}
    $taskStage='readonly-preflight'; $taskBefore=Get-ProvisionStatus "$taskUrl/status" $taskAuth
    if (@($taskBefore.roles).Count -ne 0 -or $taskBefore.identity.database -ne 'postgres' -or
        $taskBefore.identity.role -ne 'postgres' -or $taskBefore.identity.session -ne 'postgres' -or $taskBefore.identity.backend_role -ne 'postgres') {throw 'Role collision or wrong maintenance target.'}
    $taskStage='single-provision-post'
    $taskReply=Invoke-WebRequest -Uri "$taskUrl/provision" -Method Post -Headers $taskWriteAuth -ContentType 'application/json' -Body $taskBody -SkipHttpErrorCheck -TimeoutSec 30
    if ([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Provision outcome unknown; do not retry.'}
    $taskResult=$taskReply.Content | ConvertFrom-Json
    if ($taskResult.created -ne $true -or $taskResult.commissioned -ne $false -or @($taskResult.roles).Count -ne 3) {throw 'Unexpected provision result.'}
    $taskStage='independent-readonly-postflight'; $taskAfter=Get-ProvisionStatus "$taskUrl/status" $taskAuth
    if (@($taskAfter.roles).Count -ne 3 -or ($taskAfter.roles | ConvertTo-Json -Compress) -ne ($taskResult.roles | ConvertTo-Json -Compress)) {throw 'Role postflight mismatch.'}
    $taskStage='completed'
} catch { $taskFailure='Provisioning not fully confirmed; inspect saved stage and fixed roles, never retry blindly.' }
finally {
    if ($taskAttempted) {
        try {
            $taskDelete=& node $taskCli delete $taskName --config $taskConfig --force 2>&1; $taskDeleted=$LASTEXITCODE -eq 0
            $taskMissing=[int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -eq 404
        } catch {$taskFailure='Temporary role-provision Worker cleanup requires verification.'}
    }
    $taskToken=$null; $taskBody=$null; $taskAuth=$null; $taskWriteAuth=$null
}
$taskReceipt=[ordered]@{generatedAt=[DateTimeOffset]::UtcNow.ToString('o');workerName=$taskName;url=$taskUrl;credentialPath=$taskCredentialPath;
    before=$taskBefore;result=$taskResult;after=$taskAfter;access=$taskAccess;
    cleanup=@{attempted=$taskAttempted;deleted=$taskDeleted;controlPlaneMissing=$taskMissing};lastStage=$taskStage;failure=$taskFailure}
if ($taskDirectory) {
    $taskReceiptBytes=[Text.Encoding]::UTF8.GetBytes(($taskReceipt | ConvertTo-Json -Depth 9))
    $taskReceiptFile=[IO.File]::Open((Join-Path $taskDirectory 'receipt.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$taskReceiptFile.Write($taskReceiptBytes);$taskReceiptFile.Flush($true)} finally {$taskReceiptFile.Dispose()}
}
$taskReceipt | ConvertTo-Json -Depth 9
if ($taskFailure -or -not $taskMissing -or $taskStage -ne 'completed') {exit 2}
