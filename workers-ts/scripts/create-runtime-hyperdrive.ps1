# Stage 2: new dedicated configurations only. Never PATCH or DELETE the old
# production Hyperdrive, change a Worker binding, or retry an ambiguous POST.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$CredentialPath,[switch]$Apply)
$ErrorActionPreference='Stop'
if (-not $Apply -or -not $env:CLOUDFLARE_API_TOKEN) {throw 'Explicit apply and Cloudflare credentials required.'}
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskCache=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $taskRoot) '.cache'))
$taskFile=[IO.Path]::GetFullPath($CredentialPath)
$taskDirectory=Split-Path -Parent $taskFile
if ((Split-Path -Leaf $taskFile) -ne 'credentials.dpapi' -or (Split-Path -Parent $taskDirectory) -ne $taskCache -or
    (Split-Path -Leaf $taskDirectory) -notmatch '^runtime-role-credentials-[a-f0-9]{32}$') {throw 'Unexpected private credential path.'}
$taskReceiptPath=Join-Path $taskDirectory 'hyperdrive-receipt.json'
if (Test-Path -LiteralPath $taskReceiptPath) {throw 'Previous attempt exists; inspect it before further action.'}
$taskAccount='7ea8e46d8210bad342fa7595f7935fea'
$taskApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/hyperdrive/configs"
$taskHeaders=@{Authorization='Bearer '+$env:CLOUDFLARE_API_TOKEN}
$taskStage='credential-preflight';$taskFailure=$null;$taskResults=@();$taskAttempted=@();$taskCredentials=$null
try {
    $taskAcl=Get-Acl -LiteralPath $taskDirectory
    $taskAllowedSids=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18')
    if (-not $taskAcl.AreAccessRulesProtected -or @($taskAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) |
        Where-Object {$_.IdentityReference.Value -notin $taskAllowedSids}).Count) {throw 'Private ACL mismatch.'}
    $taskProvision=Get-Content -Raw -LiteralPath (Join-Path $taskDirectory 'receipt.json') | ConvertFrom-Json -Depth 12
    if ($taskProvision.lastStage -ne 'completed' -or $taskProvision.cleanup.controlPlaneMissing -ne $true -or
        $taskProvision.result.created -ne $true -or $taskProvision.result.commissioned -ne $false) {throw 'Role provisioning not confirmed.'}
    $taskPlain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($taskFile),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $taskCredentials=[Text.Encoding]::UTF8.GetString($taskPlain) | ConvertFrom-Json
    $taskPlain=$null
    if ($taskCredentials.appPassword -notmatch '^[a-f0-9]{64}$' -or $taskCredentials.adminPassword -notmatch '^[a-f0-9]{64}$') {throw 'Credential shape mismatch.'}
    $taskStage='source-config-preflight'
    $taskSource=Invoke-RestMethod -Uri "$taskApi/9748c294e21c49a99579c9cef70102e0" -Headers $taskHeaders -TimeoutSec 20
    if ($taskSource.success -ne $true -or $taskSource.result.origin.database -ne 'postgres' -or $taskSource.result.origin.user -ne 'postgres' -or
        $taskSource.result.origin.scheme -ne 'postgresql' -or $taskSource.result.origin.service_id -ne '019fe223-e5a1-7ed1-945a-8993a6f32508') {throw 'Original VPC origin changed.'}
    $taskList=Invoke-RestMethod -Uri $taskApi -Headers $taskHeaders -TimeoutSec 20
    if ($taskList.success -ne $true -or ($taskList.result_info.total_count -and $taskList.result_info.total_count -gt @($taskList.result).Count)) {throw 'Config inventory incomplete.'}
    $taskProfiles=@(@{name='cinashop-runtime-app-v1';role='cinashop_app_v1';passwordKey='appPassword';limit=40},
        @{name='cinashop-runtime-admin-v1';role='cinashop_admin_v1';passwordKey='adminPassword';limit=15})
    if (@($taskList.result | Where-Object {$_.name -in @($taskProfiles.name)}).Count) {throw 'Dedicated config name collision.'}
    foreach ($taskProfile in $taskProfiles) {
        $taskStage='create-'+$taskProfile.name
        $taskPayload=@{name=$taskProfile.name;caching=@{disabled=$true};origin_connection_limit=$taskProfile.limit;
            origin=@{database='postgres';scheme='postgresql';service_id='019fe223-e5a1-7ed1-945a-8993a6f32508';
                user=$taskProfile.role;password=$taskCredentials.($taskProfile.passwordKey)}} | ConvertTo-Json -Depth 5 -Compress
        $taskAttempted+=@($taskProfile.name)
        $taskCreated=Invoke-RestMethod -Uri $taskApi -Method Post -Headers $taskHeaders -ContentType 'application/json' -Body $taskPayload -TimeoutSec 30
        $taskPayload=$null
        if ($taskCreated.success -ne $true -or $taskCreated.result.id -notmatch '^[a-f0-9]{32}$') {throw 'Creation not confirmed.'}
        $taskId=$taskCreated.result.id
        $taskVerified=Invoke-RestMethod -Uri "$taskApi/$taskId" -Headers $taskHeaders -TimeoutSec 20
        $taskConfig=$taskVerified.result
        if ($taskVerified.success -ne $true -or $taskConfig.id -ne $taskId -or $taskConfig.name -ne $taskProfile.name -or
            $taskConfig.origin.user -ne $taskProfile.role -or $taskConfig.origin.database -ne 'postgres' -or
            $taskConfig.origin.service_id -ne '019fe223-e5a1-7ed1-945a-8993a6f32508' -or $taskConfig.origin.scheme -ne 'postgresql' -or
            $taskConfig.caching.disabled -ne $true -or $taskConfig.origin_connection_limit -ne $taskProfile.limit) {throw 'Independent config readback mismatch.'}
        $taskResults+=@(@{id=$taskId;name=$taskProfile.name;role=$taskProfile.role;cacheDisabled=$true;connectionLimit=$taskProfile.limit;verified=$true})
    }
    $taskUnchanged=Invoke-RestMethod -Uri "$taskApi/9748c294e21c49a99579c9cef70102e0" -Headers $taskHeaders -TimeoutSec 20
    if (($taskSource.result | ConvertTo-Json -Depth 10 -Compress) -ne ($taskUnchanged.result | ConvertTo-Json -Depth 10 -Compress)) {throw 'Original configuration changed during provisioning; review required.'}
    $taskStage='completed'
} catch {$taskFailure='Dedicated Hyperdrive creation not fully confirmed; inspect names and receipt, never retry POST blindly.'}
finally {$taskCredentials=$null;$taskPayload=$null;$taskPlain=$null}
$taskReceipt=[ordered]@{generatedAt=[DateTimeOffset]::UtcNow.ToString('o');stage=$taskStage;attempted=$taskAttempted;configs=$taskResults;
    originalUnchanged=($taskStage -eq 'completed');workerBindingsChanged=$false;independentRuntimeLoginVerified=$false;failure=$taskFailure}
$taskStream=[IO.File]::Open($taskReceiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try {$taskStream.Write([Text.Encoding]::UTF8.GetBytes(($taskReceipt | ConvertTo-Json -Depth 8)));$taskStream.Flush($true)} finally {$taskStream.Dispose()}
$taskReceipt | ConvertTo-Json -Depth 8
if ($taskFailure -or $taskStage -ne 'completed') {exit 2}
