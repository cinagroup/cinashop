# Fixed Manager supply workflow. Default Plan performs no network/DDL and creates
# no credential. Apply/Resume never modify an existing role, reset its password,
# edit application bindings, install missing catalogs, or touch business data.
[CmdletBinding()]
param(
    [ValidateSet('Plan','Apply','Resume','Cleanup')][string]$Mode='Plan',
    [string]$PrivateRoot,
    [string]$ResumeDirectory
)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskAccount='7ea8e46d8210bad342fa7595f7935fea'
$taskRole='cinashop_manager_v1'
$taskProfile='cinashop-runtime-manager-v1'
$taskSourceId='9748c294e21c49a99579c9cef70102e0'
$taskService='019fe223-e5a1-7ed1-945a-8993a6f32508'
$taskOperation='provision-manager-runtime-v1'
$taskConnectionLimit=15
$taskApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/hyperdrive/configs"
$taskTemplate=Join-Path $taskRoot 'test/integration/manager-role-provision.wrangler.jsonc'
$taskCli=Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
if($Mode -eq 'Plan') {
    [ordered]@{mode='Plan';role=$taskRole;database='postgres';maintenanceRole='postgres';hyperdriveName=$taskProfile;
        sourceHyperdrive=$taskSourceId;service=$taskService;connectionLimit=$taskConnectionLimit;
        prerequisite='Exact fixed core/capability/pricing/refund catalogs and role-independent source presence; collector selects one of two fixed minimal profiles';
        stages=@('private DPAPI retention + durable journal','read-only preflight','single atomic NOLOGIN/grants/audit/LOGIN transaction',
            'independent read-only postflight','single Hyperdrive JSON POST + readback','actual independent Manager LOGIN audit','temporary Worker deletion + control-plane 404');
        recovery='Resume retains original encrypted credential, reconciles attempted stages read-only, and continues only stages never attempted';
        writesPerformed=$false;applicationBindingsChanged=$false;credentialsCreated=$false} | ConvertTo-Json -Depth 5
    exit 0
}
if(-not $env:CLOUDFLARE_API_TOKEN) {throw 'Cloudflare credentials required.'}
$taskHeaders=@{Authorization='Bearer '+$env:CLOUDFLARE_API_TOKEN}
$taskUserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$taskAllowedSids=@($taskUserSid.Value,'S-1-5-18')
$taskDirectory=$null;$taskJournal=$null;$taskSecrets=$null;$taskFailure=$null;$taskStage='private-retention';$taskWorkers=@()
$env:CLOUDFLARE_ACCOUNT_ID=$taskAccount;$env:WRANGLER_SEND_METRICS='false'
function New-PrivateHex { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
function Get-TextDigest([string]$Value) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant() }
function Assert-PrivateAcl([string]$Path) {
    $taskAcl=Get-Acl -LiteralPath $Path
    if(-not $taskAcl.AreAccessRulesProtected -or @($taskAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) |
        Where-Object {$_.IdentityReference.Value -notin $taskAllowedSids -or $_.AccessControlType -ne 'Allow'}).Count) {throw 'Private credential ACL verification failed.'}
}
function Set-PrivateAcl([string]$Path) {
    $taskAcl=Get-Acl -LiteralPath $Path;$taskAcl.SetAccessRuleProtection($true,$false)
    foreach($taskSid in @($taskUserSid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $taskAcl;Assert-PrivateAcl $Path
}
function Write-Durable([string]$Path,[byte[]]$Bytes,[bool]$Replace=$false) {
    $taskDestination=[IO.Path]::GetFullPath($Path)
    if((Split-Path -Parent $taskDestination) -ne $taskDirectory) {throw 'Durable output escaped its private directory.'}
    $taskTemporary=Join-Path $taskDirectory ('write-'+[Guid]::NewGuid().ToString('N')+'.tmp')
    $taskFile=[IO.File]::Open($taskTemporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$taskFile.Write($Bytes);$taskFile.Flush($true)} finally {$taskFile.Dispose()}
    [IO.File]::Move($taskTemporary,$taskDestination,$Replace)
}
function Save-Journal {
    $taskJournal.updatedAt=[DateTimeOffset]::UtcNow.ToString('o');$taskJournal.stage=$taskStage
    Write-Durable (Join-Path $taskDirectory 'journal.json') ([Text.Encoding]::UTF8.GetBytes(($taskJournal | ConvertTo-Json -Depth 18))) $true
}
function Get-Control([string]$Uri) {
    $taskReply=Invoke-WebRequest -Uri $Uri -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 30
    if([int]$taskReply.StatusCode -ne 200) {throw 'Cloudflare control-plane read not confirmed.'}
    $taskData=$taskReply.Content | ConvertFrom-Json -Depth 30
    if($taskData.success -ne $true) {throw 'Cloudflare control-plane result not confirmed.'};return $taskData
}
function Safe-Origin($Value) {
    [ordered]@{id=$Value.id;name=$Value.name;database=$Value.origin.database;user=$Value.origin.user;scheme=$Value.origin.scheme;
        service_id=$Value.origin.service_id;cacheDisabled=$Value.caching.disabled;connectionLimit=$Value.origin_connection_limit}
}
function Assert-Source {
    $taskSource=(Get-Control "$taskApi/$taskSourceId").result
    if($taskSource.id -ne $taskSourceId -or $taskSource.origin.database -ne 'postgres' -or $taskSource.origin.user -ne 'postgres' -or
        $taskSource.origin.scheme -ne 'postgresql' -or $taskSource.origin.service_id -ne $taskService) {throw 'Fixed source VPC origin changed.'}
    return (Safe-Origin $taskSource)
}
function Get-ManagerConfig {
    $taskList=Get-Control $taskApi
    if($taskList.result_info.total_count -and $taskList.result_info.total_count -gt @($taskList.result).Count) {throw 'Hyperdrive inventory is incomplete.'}
    $taskMatching=@($taskList.result | Where-Object name -eq $taskProfile)
    if($taskMatching.Count -gt 1) {throw 'Fixed Manager Hyperdrive name is ambiguous.'}
    if($taskMatching.Count -eq 0) {return $null}
    $taskValue=$taskMatching[0]
    if($taskValue.id -notmatch '^[a-f0-9]{32}$') {throw 'Invalid Manager Hyperdrive identity.'}
    return (Get-Control "$taskApi/$($taskValue.id)").result
}
function Assert-ManagerConfig($Value) {
    if(-not $Value -or $Value.id -notmatch '^[a-f0-9]{32}$' -or $Value.name -ne $taskProfile -or $Value.origin.user -ne $taskRole -or
        $Value.origin.database -ne 'postgres' -or $Value.origin.scheme -ne 'postgresql' -or $Value.origin.service_id -ne $taskService -or
        $Value.caching.disabled -ne $true -or $Value.origin_connection_limit -ne $taskConnectionLimit) {throw 'Manager Hyperdrive readback differs from the fixed profile.'}
}
function Get-MainBindings {
    $taskSettings=Get-Control "https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/cinashop-api/settings"
    return @($taskSettings.result.bindings | Where-Object type -eq 'hyperdrive' | Select-Object name,id | Sort-Object name)
}
function Remove-OwnedWorker($Worker) {
    if($Worker.name -notmatch '^cinashop-manager-(provision|audit)-[a-f0-9]{12}$') {throw 'Owned temporary Worker identity invalid.'}
    if([IO.Path]::GetFullPath($Worker.config) -ne (Join-Path $taskDirectory ($Worker.name+'.jsonc'))) {throw 'Owned Worker configuration path escaped the private attempt.'}
    $taskCleanupConfig=Get-Content -Raw -LiteralPath $Worker.config | ConvertFrom-Json -Depth 20
    if($taskCleanupConfig.name -ne $Worker.name -or $taskCleanupConfig.account_id -ne $taskAccount) {throw 'Owned Worker configuration identity changed.'}
    $taskWorkerApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$($Worker.name)"
    $taskPresent=[int](Invoke-WebRequest -Uri $taskWorkerApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    if($taskPresent -ne 404) {
        $taskDelete=& node $taskCli delete $Worker.name --config $Worker.config --force 2>&1
        if($LASTEXITCODE -ne 0) {throw 'Temporary Worker deletion not confirmed.'}
    }
    $Worker.controlPlaneMissing=[int](Invoke-WebRequest -Uri $taskWorkerApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -eq 404
    if(-not $Worker.controlPlaneMissing) {throw 'Temporary Worker absence not confirmed.'}
}
function New-MaintenanceWorker([string]$ManagerId,[bool]$CanProvision) {
    $taskName='cinashop-manager-'+$(if($ManagerId){'audit'}else{'provision'})+'-'+[Guid]::NewGuid().ToString('N').Substring(0,12)
    $taskWorkerApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$taskName"
    if([int](Invoke-WebRequest -Uri $taskWorkerApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -ne 404) {throw 'Fresh temporary Worker absence not proved.'}
    $taskAuthToken=New-PrivateHex
    $taskConfig=Get-Content -Raw -LiteralPath $taskTemplate | ConvertFrom-Json -Depth 20
    $taskConfig.name=$taskName;$taskConfig.main=Join-Path $taskRoot 'test/integration/ManagerRoleProvisionWorker.ts'
    $taskConfig | Add-Member -NotePropertyName account_id -NotePropertyValue $taskAccount
    $taskConfig.'$schema'=Join-Path $taskRoot 'node_modules/wrangler/config-schema.json'
    $taskConfig.vars.AUDIT_TOKEN_SHA256=Get-TextDigest $taskAuthToken
    $taskConfig.vars.AUDIT_EXPIRES_AT=[DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
    $taskConfig.vars.CREDENTIALS_BODY_SHA256=Get-TextDigest $taskSecrets.body
    $taskConfig.vars.PROVISION_DISABLED=$(if($CanProvision){'false'}else{'true'})
    if($ManagerId) {$taskConfig.hyperdrive+=@(@{binding='HYPERDRIVE_MANAGER';id=$ManagerId})}
    $taskConfigPath=Join-Path $taskDirectory ($taskName+'.jsonc')
    Write-Durable $taskConfigPath ([Text.Encoding]::UTF8.GetBytes(($taskConfig | ConvertTo-Json -Depth 12)))
    $taskWorker=[ordered]@{name=$taskName;config=$taskConfigPath;attempted=$true;controlPlaneMissing=$false;url=$null}
    $taskJournal.workers+=@($taskWorker);Save-Journal
    $env:WRANGLER_LOG_PATH=Join-Path $taskDirectory ($taskName+'.log')
    $taskDeploy=& node $taskCli deploy --config $taskConfigPath 2>&1
    if($LASTEXITCODE -ne 0) {throw 'Temporary maintenance deployment not confirmed.'}
    $taskMatch=[regex]::Match(($taskDeploy -join "`n"),'https://'+[regex]::Escape($taskName)+'\.[a-z0-9-]+\.workers\.dev')
    if(-not $taskMatch.Success) {throw 'Owned maintenance URL unavailable.'}
    $taskWorker.url=$taskMatch.Value;Save-Journal
    $taskAuth=@{'X-Audit-Token'=$taskAuthToken}
    for($taskProbe=0;$taskProbe -lt 8;$taskProbe++) {
        $taskAnonymous=[int](Invoke-WebRequest -Uri "$($taskWorker.url)/status" -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
        if($taskAnonymous -eq 403) {break};if($taskAnonymous -ne 404) {throw 'Maintenance anonymous boundary differs.'}
        if($taskProbe -lt 7) {Start-Sleep -Milliseconds 1000}
    }
    if($taskAnonymous -ne 403) {throw 'Maintenance anonymous boundary not confirmed.'}
    $taskQuery=[int](Invoke-WebRequest -Uri ($taskWorker.url.TrimEnd('/')+'/inspect?role=postgres') -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskWrongMethod=[int](Invoke-WebRequest -Uri ($taskWorker.url.TrimEnd('/')+'/status') -Method Post -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
    $taskWorker.boundaries=@{anonymous=$taskAnonymous;query=$taskQuery;method=$taskWrongMethod};Save-Journal
    if($taskQuery -ne 404 -or $taskWrongMethod -ne 405) {throw 'Maintenance route boundary differs.'}
    return @{worker=$taskWorker;headers=$taskAuth}
}
function Get-Maintenance($Worker,[string]$Path) {
    if($Path -notin @('/inspect','/runtime-inspect')) {throw 'Fixed readonly maintenance route required.'}
    $taskReadHeaders=@{'X-Audit-Token'=$Worker.headers['X-Audit-Token'];'X-Maintenance-Operation'=$(if($Path -eq '/inspect'){'inspect-manager-runtime-role-v1'}else{'inspect-manager-runtime-login-v1'})}
    $taskReply=Invoke-WebRequest -Uri ($Worker.worker.url.TrimEnd('/')+$Path) -Method Post -Headers $taskReadHeaders -SkipHttpErrorCheck -TimeoutSec 30
    $Worker.worker.readonlyProbe=@{route=$Path;method='POST';status=[int]$taskReply.StatusCode};Save-Journal
    if([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Read-only maintenance result not confirmed.'}
    return ($taskReply.Content | ConvertFrom-Json -Depth 20)
}
try {
    if($Mode -eq 'Apply') {
        if(-not $PrivateRoot -or -not [IO.Path]::IsPathFullyQualified($PrivateRoot) -or $ResumeDirectory) {throw 'Apply requires an explicit authorized local absolute PrivateRoot and no previous attempt.'}
        $taskPrivateRoot=[IO.Path]::GetFullPath($PrivateRoot)
        if($taskPrivateRoot.StartsWith('\\') -or -not [IO.Path]::IsPathFullyQualified($taskPrivateRoot)) {throw 'DPAPI retention requires a local absolute private root.'}
        if(-not (Test-Path -LiteralPath $taskPrivateRoot)) {$null=New-Item -ItemType Directory -Path $taskPrivateRoot}
        $taskDirectory=Join-Path $taskPrivateRoot ('manager-runtime-credentials-'+[Guid]::NewGuid().ToString('N'))
        $null=New-Item -ItemType Directory -Path $taskDirectory;Set-PrivateAcl $taskDirectory
        $taskPassword=New-PrivateHex
        $taskSecrets=[ordered]@{version='manager-runtime-credentials-v1';operationId=[Guid]::NewGuid().ToString('N');
            body=([ordered]@{managerPassword=$taskPassword} | ConvertTo-Json -Compress);managerPassword=$taskPassword}
        $taskBytes=[Text.Encoding]::UTF8.GetBytes(($taskSecrets | ConvertTo-Json -Compress))
        $taskEncrypted=[Security.Cryptography.ProtectedData]::Protect($taskBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        Write-Durable (Join-Path $taskDirectory 'credentials.dpapi') $taskEncrypted
        $taskReadback=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $taskDirectory 'credentials.dpapi')),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        if(-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($taskBytes,$taskReadback)) {throw 'Encrypted credential retention verification failed.'}
        $taskPassword=$null;$taskBytes=$null;$taskReadback=$null;$taskEncrypted=$null
        $taskJournal=[ordered]@{version='manager-runtime-supply-v1';operationId=$taskSecrets.operationId;stage=$taskStage;updatedAt=$null;
            role=$taskRole;profile=$taskProfile;catalogProfile=$null;bodySha256=(Get-TextDigest $taskSecrets.body);roleAttempted=$false;roleConfirmed=$false;
            hyperdriveAttempted=$false;hyperdriveId=$null;managerVerified=$false;workers=@();failure=$null}
        Save-Journal
    } else {
        if(-not $ResumeDirectory -or -not [IO.Path]::IsPathFullyQualified($ResumeDirectory) -or $PrivateRoot) {throw 'Resume/Cleanup requires the original absolute private ResumeDirectory.'}
        $taskDirectory=[IO.Path]::GetFullPath($ResumeDirectory)
        if($taskDirectory.StartsWith('\\') -or (Split-Path -Leaf $taskDirectory) -notmatch '^manager-runtime-credentials-[a-f0-9]{32}$') {throw 'Unexpected private recovery directory.'}
        Assert-PrivateAcl $taskDirectory
        $taskJournal=Get-Content -Raw -LiteralPath (Join-Path $taskDirectory 'journal.json') | ConvertFrom-Json -AsHashtable -Depth 20
        if($taskJournal.version -ne 'manager-runtime-supply-v1' -or $taskJournal.role -ne $taskRole -or $taskJournal.profile -ne $taskProfile) {throw 'Recovery journal profile mismatch.'}
        foreach($taskOldWorker in $taskJournal.workers) {Remove-OwnedWorker $taskOldWorker};Save-Journal
        if($Mode -eq 'Cleanup') {$taskStage='cleanup-completed';Save-Journal}
        else {
            $taskPlain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $taskDirectory 'credentials.dpapi')),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
            $taskSecrets=[Text.Encoding]::UTF8.GetString($taskPlain) | ConvertFrom-Json -AsHashtable;$taskPlain=$null
            if($taskSecrets.version -ne 'manager-runtime-credentials-v1' -or $taskSecrets.operationId -ne $taskJournal.operationId -or
                $taskSecrets.managerPassword -notmatch '^[a-f0-9]{64}$' -or (Get-TextDigest $taskSecrets.body) -ne $taskJournal.bodySha256 -or
                (($taskSecrets.body | ConvertFrom-Json).managerPassword) -ne $taskSecrets.managerPassword) {throw 'Original encrypted credential identity mismatch.'}
        }
    }
    if($Mode -ne 'Cleanup') {
        $taskSourceBefore=Assert-Source;$taskBindingsBefore=Get-MainBindings
        $taskStage='read-only-preflight';Save-Journal
        $taskMaintenance=New-MaintenanceWorker '' (-not $taskJournal.roleAttempted)
        $taskBefore=Get-Maintenance $taskMaintenance '/inspect'
        if($taskBefore.identity.supported -ne $true -or $taskBefore.prerequisites.ready -ne $true) {throw 'Fixed target or exact prerequisite catalogs are not commissioned; no installation attempted.'}
        if($taskBefore.prerequisites.profile -notin @('current','legacy-without-promotion-gift-receipt') -or
            $taskJournal.catalogProfile -and $taskJournal.catalogProfile -ne $taskBefore.prerequisites.profile) {throw 'Fixed source catalog profile changed during supply.'}
        $taskJournal.catalogProfile=$taskBefore.prerequisites.profile;Save-Journal
        if($taskJournal.roleAttempted) {
            if($taskBefore.ready -ne $true -or $taskBefore.role.name -ne $taskRole) {throw 'Prior role outcome remains unknown; no retry or password change.'}
        } else {
            if($taskBefore.role) {throw 'Existing fixed Manager role requires independent reviewed recovery; never modify it.'}
            if(Get-ManagerConfig) {throw 'Manager Hyperdrive exists before the owned attempt.'}
            $taskStage='single-role-provision';$taskJournal.roleAttempted=$true;Save-Journal
            $taskWriteHeaders=@{'X-Audit-Token'=$taskMaintenance.headers['X-Audit-Token'];'X-Maintenance-Operation'=$taskOperation}
            $taskReply=Invoke-WebRequest -Uri "$($taskMaintenance.worker.url)/provision" -Method Post -Headers $taskWriteHeaders -ContentType 'application/json' -Body $taskSecrets.body -SkipHttpErrorCheck -TimeoutSec 30
            if([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {throw 'Role outcome unknown; preserve the attempt and credential.'}
            $taskResult=$taskReply.Content | ConvertFrom-Json -Depth 20
            if($taskResult.created -ne $true -or $taskResult.commissioned -ne $true -or $taskResult.role.name -ne $taskRole -or $taskResult.privileges.ready -ne $true -or
                $taskResult.privileges.profile -ne $taskJournal.catalogProfile) {throw 'Unexpected role commissioning result.'}
        }
        $taskStage='independent-role-postflight';$taskPostflight=Get-Maintenance $taskMaintenance '/inspect'
        if($taskPostflight.ready -ne $true -or $taskPostflight.role.name -ne $taskRole -or $taskPostflight.prerequisites.profile -ne $taskJournal.catalogProfile) {throw 'Role commissioning postflight not confirmed.'}
        $taskJournal.roleConfirmed=$true;Save-Journal;Remove-OwnedWorker $taskMaintenance.worker;Save-Journal
        $taskManager=Get-ManagerConfig
        if($taskJournal.hyperdriveAttempted) {
            Assert-ManagerConfig $taskManager
            if($taskJournal.hyperdriveId -and $taskJournal.hyperdriveId -ne $taskManager.id) {throw 'Recovered Hyperdrive identity differs.'}
        } else {
            if($taskManager) {throw 'Unexpected fixed Hyperdrive name collision.'}
            $taskStage='single-hyperdrive-create';$taskJournal.hyperdriveAttempted=$true;Save-Journal
            # Secrets remain JSON body fields, never URI/query strings or CLI args.
            $taskPayload=@{name=$taskProfile;caching=@{disabled=$true};origin_connection_limit=$taskConnectionLimit;
                origin=@{database='postgres';scheme='postgresql';service_id=$taskService;user=$taskRole;password=$taskSecrets.managerPassword}} | ConvertTo-Json -Depth 5 -Compress
            $taskReply=Invoke-WebRequest -Uri $taskApi -Method Post -Headers $taskHeaders -ContentType 'application/json' -Body $taskPayload -SkipHttpErrorCheck -TimeoutSec 30
            $taskPayload=$null
            if([int]$taskReply.StatusCode -notin @(200,201)) {throw 'Hyperdrive creation outcome unknown; inspect the same fixed name.'}
            $taskCreated=$taskReply.Content | ConvertFrom-Json -Depth 20
            if($taskCreated.success -ne $true -or $taskCreated.result.id -notmatch '^[a-f0-9]{32}$') {throw 'Hyperdrive creation not confirmed.'}
            $taskJournal.hyperdriveId=$taskCreated.result.id;Save-Journal
            $taskManager=(Get-Control "$taskApi/$($taskJournal.hyperdriveId)").result;Assert-ManagerConfig $taskManager
        }
        $taskJournal.hyperdriveId=$taskManager.id;Save-Journal
        $taskStage='independent-manager-login';$taskRuntime=New-MaintenanceWorker $taskManager.id $false
        $taskAudit=Get-Maintenance $taskRuntime '/runtime-inspect'
        if($taskAudit.ready -ne $true -or $taskAudit.profile -ne $taskJournal.catalogProfile -or $taskAudit.identity.database -ne 'postgres' -or $taskAudit.identity.role -ne $taskRole -or
            $taskAudit.identity.session -ne $taskRole -or $taskAudit.identity.backend_role -ne $taskRole) {throw 'Independent Manager LOGIN/ACL audit not confirmed.'}
        $taskJournal.managerVerified=$true;Remove-OwnedWorker $taskRuntime.worker;Save-Journal
        if(($taskSourceBefore | ConvertTo-Json -Compress) -ne ((Assert-Source) | ConvertTo-Json -Compress) -or
            ($taskBindingsBefore | ConvertTo-Json -Compress) -ne ((Get-MainBindings) | ConvertTo-Json -Compress)) {throw 'Source Hyperdrive or application bindings changed during supply.'}
        $taskStage='completed';Save-Journal
    }
} catch {$taskFailure='Manager supply is not fully confirmed. Preserve this encrypted attempt and journal; inspect before any retry.'}
finally {
    if($taskJournal) {
        foreach($taskOwnedWorker in $taskJournal.workers) {try {Remove-OwnedWorker $taskOwnedWorker} catch {$taskFailure='Temporary Manager Worker cleanup needs control-plane verification.'}}
        $taskJournal.failure=$taskFailure;try {Save-Journal} catch {$taskFailure='Private durable journal update could not be confirmed.'}
    }
    $taskSecrets=$null;$taskPayload=$null;$taskPlain=$null;$taskWriteHeaders=$null;$taskMaintenance=$null;$taskRuntime=$null
}
[ordered]@{privateDirectory=$taskDirectory;stage=$taskStage;role=$taskRole;roleConfirmed=($taskJournal.roleConfirmed -eq $true);
    hyperdriveId=$taskJournal.hyperdriveId;catalogProfile=$taskJournal.catalogProfile;independentManagerVerified=($taskJournal.managerVerified -eq $true);
    workersCleaned=($taskJournal -and @($taskJournal.workers | Where-Object {$_.controlPlaneMissing -ne $true}).Count -eq 0);
    applicationBindingsChanged=$false;failure=$taskFailure} | ConvertTo-Json -Depth 5
if($taskFailure -or $taskStage -notin @('completed','cleanup-completed')) {exit 2}
