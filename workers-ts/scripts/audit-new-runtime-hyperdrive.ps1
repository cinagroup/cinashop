# Read-only authentication over the two new Hyperdrive paths. Each expiring
# probe uses a zero-business-privilege LOGIN and is removed independently.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
if (-not $env:CLOUDFLARE_API_TOKEN) {throw 'Cloudflare credentials required.'}
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskAccount='7ea8e46d8210bad342fa7595f7935fea'
$taskHeaders=@{Authorization='Bearer '+$env:CLOUDFLARE_API_TOKEN}
$taskCli=Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$env:CLOUDFLARE_ACCOUNT_ID=$taskAccount;$env:WRANGLER_SEND_METRICS='false'
$taskReports=@();$taskFailure=$null
$taskSettingsApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/cinashop-api/settings"
$taskBefore=Invoke-RestMethod -Uri $taskSettingsApi -Headers $taskHeaders -TimeoutSec 20
$taskOriginalBindings=@($taskBefore.result.bindings | Where-Object type -eq 'hyperdrive' | Select-Object name,id)
if ($taskOriginalBindings.Count -ne 1 -or $taskOriginalBindings[0].id -ne '9748c294e21c49a99579c9cef70102e0') {throw 'Unexpected current main Worker binding.'}
foreach ($taskTarget in @(@{id='ba7faa6680cd48d4b3a1d36a7a5fc8f7';role='cinashop_app_v1'},@{id='446e94a4de0143f58c8e5178ec55db8b';role='cinashop_admin_v1'})) {
    $taskName='cinashop-runtime-login-audit-'+[Guid]::NewGuid().ToString('N').Substring(0,12)
    $taskToken=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $taskTokenHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
    $taskApi="https://api.cloudflare.com/client/v4/accounts/$taskAccount/workers/scripts/$taskName"
    $taskDirectory=Join-Path (Split-Path -Parent $taskRoot) ('.cache/'+$taskName)
    $null=New-Item -ItemType Directory -Path $taskDirectory
    $taskConfigPath=Join-Path $taskDirectory 'wrangler.jsonc'
    $taskConfig=Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'test/integration/runtime-role-provision.wrangler.jsonc') | ConvertFrom-Json
    $taskConfig.name=$taskName;$taskConfig.main=Join-Path $taskRoot 'test/integration/RuntimeRoleProvisionWorker.ts'
    $taskConfig.'$schema'=Join-Path $taskRoot 'node_modules/wrangler/config-schema.json'
    $taskConfig.hyperdrive[0].id=$taskTarget.id
    $taskConfig.vars.AUDIT_TOKEN_SHA256=$taskTokenHash
    $taskConfig.vars.AUDIT_EXPIRES_AT=[DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
    # There is no known preimage/body; the mutation path is unusable. The bound
    # role is independently unable to create roles even with valid input.
    $taskConfig.vars.CREDENTIALS_BODY_SHA256=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    [IO.File]::WriteAllText($taskConfigPath,($taskConfig | ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $env:WRANGLER_LOG_PATH=Join-Path $env:TEMP "$taskName.log"
    $taskAttempted=$false;$taskMissing=$false;$taskDeleted=$false;$taskStage='target-absence';$taskResult=$null;$taskUrl=$null
    try {
        if ([int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -ne 404) {throw 'Target already exists.'}
        $taskAttempted=$true;$taskStage='deploy'
        $taskDeploy=& node $taskCli deploy --config $taskConfigPath 2>&1
        if ($LASTEXITCODE -ne 0) {throw 'Probe deployment not confirmed.'}
        $taskMatch=[regex]::Match(($taskDeploy -join "`n"),'https://'+[regex]::Escape($taskName)+'\.[a-z0-9-]+\.workers\.dev')
        if (-not $taskMatch.Success) {throw 'Owned URL not found.'};$taskUrl=$taskMatch.Value
        $taskAuth=@{'X-Audit-Token'=$taskToken};$taskStage='anonymous-boundary'
        for ($taskAttempt=0;$taskAttempt -lt 8;$taskAttempt++) {
            $taskAnonymous=[int](Invoke-WebRequest -Uri "$taskUrl/status" -SkipHttpErrorCheck -TimeoutSec 20).StatusCode
            if ($taskAnonymous -ne 404) {break};if ($taskAttempt -lt 7) {Start-Sleep -Milliseconds 1000}
        }
        if ($taskAnonymous -ne 403) {throw 'Anonymous boundary failed.'}
        $taskStage='independent-login-audit'
        $taskReply=Invoke-WebRequest -Uri "$taskUrl/status" -Headers $taskAuth -SkipHttpErrorCheck -TimeoutSec 30
        if ([int]$taskReply.StatusCode -ne 200 -or $taskReply.Headers['Cache-Control'] -notcontains 'no-store') {
            $taskSafeState=$null
            if ([int]$taskReply.StatusCode -eq 503) {
                $taskErrorReply=$taskReply.Content | ConvertFrom-Json
                if ($taskErrorReply.sqlState -match '^[0-9A-Z]{5}$') {$taskSafeState=$taskErrorReply.sqlState}
            }
            $taskResult=@{httpStatus=[int]$taskReply.StatusCode;sqlState=$taskSafeState}
            throw 'Runtime audit not confirmed.'
        }
        $taskResult=$taskReply.Content | ConvertFrom-Json -Depth 12
        if ($taskResult.identity.database -ne 'postgres' -or $taskResult.identity.role -ne $taskTarget.role -or
            $taskResult.identity.session -ne $taskTarget.role -or $taskResult.identity.backend_role -ne $taskTarget.role -or
            @($taskResult.roles).Count -ne 3) {throw 'Independent runtime identity mismatch.'}
        $taskOwn=@($taskResult.roles | Where-Object name -eq $taskTarget.role)
        if ($taskOwn.Count -ne 1 -or $taskOwn[0].login -ne $true) {throw 'Runtime login missing.'}
        foreach ($taskCheck in @('restricted','no_memberships','no_ownership','no_ddl','no_replication_bypass','no_business_grants','no_sequence_grants')) {
            if ($taskOwn[0].$taskCheck -ne $true) {throw 'Unexpected initial runtime authority.'}
        }
        $taskStage='completed'
    } catch {$taskFailure='Independent Hyperdrive login audit did not fully complete; no grant or cutover was attempted.'}
    finally {
        if ($taskAttempted) {try {
            $taskDelete=& node $taskCli delete $taskName --config $taskConfigPath --force 2>&1;$taskDeleted=$LASTEXITCODE -eq 0
            $taskMissing=[int](Invoke-WebRequest -Uri $taskApi -Headers $taskHeaders -SkipHttpErrorCheck -TimeoutSec 20).StatusCode -eq 404
        } catch {$taskFailure='Probe cleanup requires verification.'}}
        $taskToken=$null;$taskAuth=$null
    }
    $taskReport=@{workerName=$taskName;hyperdrive=$taskTarget.id;expectedRole=$taskTarget.role;result=$taskResult;stage=$taskStage;
        cleanup=@{deleted=$taskDeleted;controlPlaneMissing=$taskMissing};failure=$taskFailure}
    [IO.File]::WriteAllText((Join-Path $taskDirectory 'receipt.json'),($taskReport | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    $taskReports+=@($taskReport)
    if ($taskFailure -or -not $taskMissing) {break}
}
$taskAfter=Invoke-RestMethod -Uri $taskSettingsApi -Headers $taskHeaders -TimeoutSec 20
$taskFinalBindings=@($taskAfter.result.bindings | Where-Object type -eq 'hyperdrive' | Select-Object name,id)
$taskUnchanged=($taskFinalBindings | ConvertTo-Json -Compress) -eq ($taskOriginalBindings | ConvertTo-Json -Compress)
[ordered]@{generatedAt=[DateTimeOffset]::UtcNow.ToString('o');runtimeAudits=$taskReports;mainWorkerBindingsUnchanged=$taskUnchanged;failure=$taskFailure} | ConvertTo-Json -Depth 12
if ($taskFailure -or -not $taskUnchanged -or $taskReports.Count -ne 2) {exit 2}
