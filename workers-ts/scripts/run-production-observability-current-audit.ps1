# TEST-003B: one fixed, read-only current-app observability aggregate. This script
# deploys only a random temporary workers.dev Worker; it never changes the
# formal Worker, credentials, PostgreSQL grants, schema, or business rows.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'Cloudflare credentials are required.' }

$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCli = Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskMain = Join-Path $taskRoot 'test/integration/ProductionObservabilityAuditWorker.ts'
$taskAccount = '7ea8e46d8210bad342fa7595f7935fea'
$taskExpectedVersion = 'cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2'
$taskExpectedBindingSha = '85dcd3bd1cc2f2a6a836ed9913c2fb5f7f46dd03540894585b75be399cfe36be'
$taskExpectedApp = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7'
$taskExpectedAdmin = '446e94a4de0143f58c8e5178ec55db8b'
$taskBase = "https://api.cloudflare.com/client/v4/accounts/$taskAccount"
$taskMainApi = "$taskBase/workers/scripts/cinashop-api"
$taskName = 'cinashop-observability-current-audit-' + [Guid]::NewGuid().ToString('N').Substring(0, 16)
$taskConfig = Join-Path $taskRoot ".cache/$taskName.wrangler.jsonc"
$taskLogPath = Join-Path $taskRoot ".cache/$taskName-wrangler.log"
$taskApi = "$taskBase/workers/scripts/$taskName"
$taskUrl = "https://$taskName.cinagroup.workers.dev"
$taskToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskTokenHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskExpiry = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$taskMarker = 'test003b-observability-readonly-' + [Guid]::NewGuid().ToString('N')
$taskApiHeaders = @{ Authorization = 'Bearer ' + $env:CLOUDFLARE_API_TOKEN }
$taskAuth = @{ 'X-Audit-Token' = $taskToken }
$taskOriginalAccount = $env:CLOUDFLARE_ACCOUNT_ID
$taskOriginalMetrics = $env:WRANGLER_SEND_METRICS
$taskOriginalLog = $env:WRANGLER_LOG_PATH
$taskStage = 'local-preflight'
$taskFailure = $null
$taskAttempted = $false
$taskOwnedVersion = $null
$taskOwnershipVerified = $false
$taskDeleted = $false
$taskControlMissing = $false
$taskPublicMissing = $false
$taskMainUnchanged = $false
$taskProcessTreeUncertain = $false
$taskCliOutputCleanupFailed = $false
$taskLocalPathsOwned = $false
$taskDeleteFailed = $false
$taskWranglerLogInspectionFailed = $false
$taskWranglerLogOversize = $false
$taskWranglerLogBytes = $null
$taskWranglerLogSha256 = $null
$taskWranglerLogCleanupFailed = $false
$taskConfigCleanupFailed = $false
$taskConfigRetainedForRecovery = $false
$taskRetainedLocalFiles = @()
$taskFormalBefore = $null
$taskFormalAfter = $null
$taskResult = $null
$taskSampleRequestCount = 0
$taskAccess = [ordered]@{ anonymous = 0; wrongMethod = 0; query = 0; wrongPath = 0 }
$taskDiagnostic = [ordered]@{ outcome = 'not-started'; httpStatus = 'unobserved';
    cacheControl = 'unobserved'; workerStage = 'unobserved'; category = 'unobserved' }

function Test-AuditTimeout {
    param([System.Exception]$ErrorObject)
    for ($taskErrorDepth = 0; $taskErrorDepth -lt 4 -and $ErrorObject; $taskErrorDepth++) {
        if ($ErrorObject -is [System.TimeoutException] -or
            $ErrorObject -is [System.Threading.Tasks.TaskCanceledException] -or
            ($ErrorObject -is [System.Net.WebException] -and
             $ErrorObject.Status -eq [System.Net.WebExceptionStatus]::Timeout)) { return $true }
        $ErrorObject = $ErrorObject.InnerException
    }
    return $false
}

function Get-Http {
    param([string]$Uri,[hashtable]$Headers=@{},[string]$Method='GET',[int]$TimeoutSec=20)
    return Invoke-WebRequest -Uri $Uri -Method $Method -Headers $Headers -SkipHttpErrorCheck -TimeoutSec $TimeoutSec
}
function Test-NoStore {
    param([object]$Response)
    $taskCacheHeader = @($Response.Headers['Cache-Control']) -join ','
    return @($taskCacheHeader.Split(',') | ForEach-Object { $_.Trim().ToLowerInvariant() }) -contains 'no-store'
}
function Get-Json200 {
    param([string]$Uri,[hashtable]$Headers,[int]$TimeoutSec=20)
    $taskResponse = Get-Http -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec
    if ([int]$taskResponse.StatusCode -ne 200) { throw 'Fixed control-plane read failed.' }
    $taskValue = $taskResponse.Content | ConvertFrom-Json -Depth 20
    if ($taskValue.success -ne $true) { throw 'Fixed control-plane response was not successful.' }
    return $taskValue
}
function Get-TemporaryControl {
    param([string]$Uri,[bool]$AllowAbsent=$false)
    # Only fixed GETs are retried. A transient 404 can follow a successful
    # upload, and 429/5xx/transport errors must not bypass owned cleanup.
    for ($taskTry = 0; $taskTry -lt 6; $taskTry++) {
        try {
            $taskResponse = Get-Http -Uri $Uri -Headers $taskApiHeaders
        } catch {
            if ($taskTry -eq 5) { throw 'Temporary Worker control-plane read remained unavailable.' }
            Start-Sleep -Seconds 1
            continue
        }
        $taskStatus = [int]$taskResponse.StatusCode
        if ($taskStatus -eq 200 -or ($AllowAbsent -and $taskStatus -eq 404 -and $taskTry -eq 5)) {
            return $taskResponse
        }
        if ($taskStatus -notin @(404,408,429,500,502,503,504)) {
            throw 'Temporary Worker control-plane status was unexpected.'
        }
        if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
    }
    throw 'Temporary Worker control-plane read remained unavailable.'
}
function Get-OwnedJson200 {
    param([string]$Uri)
    $taskResponse = Get-TemporaryControl -Uri $Uri
    $taskValue = $taskResponse.Content | ConvertFrom-Json -Depth 20
    if ($taskValue.success -ne $true) { throw 'Temporary Worker control-plane response failed.' }
    return $taskValue
}
function Get-FormalSnapshot {
    $taskDeployments = Get-Json200 -Uri "$taskMainApi/deployments" -Headers $taskApiHeaders
    $taskRows = if ($taskDeployments.result -is [array]) {
        @($taskDeployments.result)
    } else { @($taskDeployments.result.deployments) }
    $taskLatest = $taskRows | Sort-Object created_on -Descending | Select-Object -First 1
    if (-not $taskLatest -or @($taskLatest.versions).Count -ne 1 -or $taskLatest.versions[0].percentage -ne 100) {
        throw 'Formal Worker has no single 100-percent version.'
    }
    if ($taskLatest.versions[0].version_id -cne $taskExpectedVersion) {
        throw 'Formal Worker version differs from reviewed release.'
    }
    $taskSettings = Get-Json200 -Uri "$taskMainApi/settings" -Headers $taskApiHeaders
    $taskBindings = @($taskSettings.result.bindings)
    $taskHyperdrive = @($taskBindings | Where-Object type -eq 'hyperdrive' | ForEach-Object { "{0}:{1}" -f $_.name,$_.id } | Sort-Object -CaseSensitive)
    $taskExpected = @( @("HYPERDRIVE:$taskExpectedApp","HYPERDRIVE_ADMIN:$taskExpectedAdmin") | Sort-Object -CaseSensitive )
    if ($taskBindings.Count -ne 31 -or $taskHyperdrive.Count -ne 2 -or
        ($taskHyperdrive -join '|') -cne ($taskExpected -join '|')) {
        throw 'Formal Worker binding inventory changed.'
    }
    # Project metadata only. Plain-text and secret binding values are omitted.
    $taskProjection = @($taskBindings | ForEach-Object {
        "{0}:{1}:{2}:{3}:{4}" -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name
    } | Sort-Object -CaseSensitive)
    $taskBytes = [Text.Encoding]::UTF8.GetBytes(($taskProjection -join "`n"))
    $taskFingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskBytes)).ToLowerInvariant()
    if ($taskFingerprint -cne $taskExpectedBindingSha) {
        throw 'Formal Worker settings bindings differ from reviewed release.'
    }
    # The immutable version resources must agree with the mutable settings
    # projection. Compare names/types/IDs only; never read binding values.
    $taskVersion = Get-Json200 -Uri "$taskMainApi/versions/$taskExpectedVersion" -Headers $taskApiHeaders
    $taskVersionBindings = @($taskVersion.result.resources.bindings)
    $taskVersionProjection = @($taskVersionBindings | ForEach-Object {
        "{0}:{1}:{2}:{3}:{4}" -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name
    } | Sort-Object -CaseSensitive)
    $taskVersionBytes = [Text.Encoding]::UTF8.GetBytes(($taskVersionProjection -join "`n"))
    $taskVersionFingerprint = [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($taskVersionBytes)).ToLowerInvariant()
    if ($taskVersionBindings.Count -ne 31 -or $taskVersionFingerprint -cne $taskExpectedBindingSha) {
        throw 'Formal Worker version bindings differ from reviewed release.'
    }
    return [ordered]@{
        deploymentId = [string]$taskLatest.id
        versionId = [string]$taskLatest.versions[0].version_id
        traffic = 100
        bindingCount = $taskBindings.Count
        bindingSha256 = $taskFingerprint
        versionBindingSha256 = $taskVersionFingerprint
        appHyperdriveId = [string](@($taskBindings | Where-Object name -eq 'HYPERDRIVE')[0].id)
    }
}
function Get-OwnedVersion {
    $taskDeployments = Get-OwnedJson200 -Uri "$taskApi/deployments"
    $taskRows = if ($taskDeployments.result -is [array]) {
        @($taskDeployments.result)
    } else { @($taskDeployments.result.deployments) }
    $taskLatest = $taskRows | Sort-Object created_on -Descending | Select-Object -First 1
    if (-not $taskLatest -or @($taskLatest.versions).Count -ne 1 -or $taskLatest.versions[0].percentage -ne 100) {
        throw 'Temporary Worker version is not singular.'
    }
    $taskVersionId = [string]$taskLatest.versions[0].version_id
    if ($taskVersionId -notmatch '^[0-9a-f-]{36}$') { throw 'Temporary Worker version ID invalid.' }
    $taskVersion = Get-OwnedJson200 -Uri "$taskApi/versions/$taskVersionId"
    if ($taskVersion.result.annotations.'workers/message' -cne $taskMarker) {
        throw 'Temporary Worker ownership marker differs.'
    }
    $taskActual = @($taskVersion.result.resources.bindings | ForEach-Object {
        if ($_.type -eq 'hyperdrive') { "{0}:{1}:{2}" -f $_.name,$_.type,$_.id }
        else { "{0}:{1}" -f $_.name,$_.type }
    } | Sort-Object -CaseSensitive)
    $taskExpected = @( @("HYPERDRIVE:hyperdrive:$($taskFormalBefore.appHyperdriveId)",'AUDIT_TOKEN_SHA256:plain_text',
        'AUDIT_EXPIRES_AT:plain_text') | Sort-Object -CaseSensitive )
    if ($taskActual.Count -ne $taskExpected.Count -or ($taskActual -join '|') -cne ($taskExpected -join '|')) {
        throw 'Temporary Worker binding projection differs.'
    }
    return $taskVersionId
}
function Test-PublicMissing {
    for ($taskTry = 0; $taskTry -lt 6; $taskTry++) {
        try {
            $taskResponse = Get-Http -Uri "$taskUrl/observability" -Headers @{} -TimeoutSec 20
            if ([int]$taskResponse.StatusCode -eq 404) { return $true }
        } catch { }
        if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
    }
    return $false
}

function Invoke-BoundedWrangler {
    param([ValidateSet('deploy','delete')][string]$Operation,[string[]]$Arguments,
        [int]$TimeoutMs = 0)
    $taskDeadline = if ($TimeoutMs -gt 0) { $TimeoutMs } elseif ($Operation -ceq 'deploy') { 90000 } else { 45000 }
    if ($taskDeadline -lt 100 -or $taskDeadline -gt 90000) { throw 'Invalid Wrangler deadline.' }
    $taskNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    if (-not $taskNode -or -not (Test-Path -LiteralPath $taskNode -PathType Leaf)) {
        throw 'Trusted Node executable unavailable.'
    }
    $taskOutputId = [Guid]::NewGuid().ToString('N')
    $taskStdout = Join-Path $taskRoot ".cache/$taskName-$Operation-$taskOutputId.stdout"
    $taskStderr = Join-Path $taskRoot ".cache/$taskName-$Operation-$taskOutputId.stderr"
    $taskProcess = $null
    try {
        # Start-Process redirects to owned files, avoiding pipe-buffer deadlock.
        # Argument values are fixed config paths, random hex, or fixed flags.
        $taskProcessArguments = @(('"' + $taskCli + '"'),$Operation) + $Arguments
        $taskProcess = Start-Process -FilePath $taskNode -ArgumentList $taskProcessArguments `
            -WorkingDirectory $taskRoot -RedirectStandardOutput $taskStdout `
            -RedirectStandardError $taskStderr -WindowStyle Hidden -PassThru
        if (-not $taskProcess.WaitForExit($taskDeadline)) {
            # WaitForExit after Kill(true) confirms only the root process. A
            # descendant may still run, so every timeout needs manual review.
            $script:taskProcessTreeUncertain = $true
            $taskTreeStopped = $false
            try {
                $taskProcess.Kill($true)
                $taskTreeStopped = $taskProcess.WaitForExit(5000)
            } catch { }
            if (-not $taskTreeStopped) {
                throw 'Wrangler process tree could not be terminated within the deadline.'
            }
            throw [TimeoutException]::new('Wrangler process exceeded its wall-clock deadline.')
        }
        if ($taskProcess.ExitCode -ne 0) { throw 'Wrangler operation did not complete successfully.' }
        if ($Operation -ceq 'deploy') {
            if ((Get-Item -LiteralPath $taskStdout).Length -gt 65536) {
                throw 'Wrangler deployment output exceeded reviewed bounds.'
            }
            return Get-Content -Raw -LiteralPath $taskStdout
        }
        return $true
    } finally {
        if ($taskProcess) { $taskProcess.Dispose() }
        foreach ($taskFile in @($taskStdout,$taskStderr)) {
            if (Test-Path -LiteralPath $taskFile) {
                try { Remove-Item -LiteralPath $taskFile -Force }
                catch { $script:taskCliOutputCleanupFailed = $true }
            }
        }
    }
}

$taskValidator = Join-Path (Join-Path $taskRoot 'scripts') 'validate-production-observability-current-audit.ps1'
if (-not (Test-Path -LiteralPath $taskValidator -PathType Leaf)) {
    throw 'Reviewed aggregate validator unavailable.'
}
. $taskValidator

try {
    if (-not (Test-Path -LiteralPath $taskMain -PathType Leaf)) { throw 'Reviewed audit Worker unavailable.' }
    if (-not (Test-Path -LiteralPath $taskCli -PathType Leaf)) { throw 'Wrangler executable unavailable.' }
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot '.cache')
    if ((Test-Path -LiteralPath $taskLogPath) -or (Test-Path -LiteralPath $taskConfig)) {
        throw 'Random local audit paths were not absent.'
    }
    $taskLocalPathsOwned = $true
    $env:CLOUDFLARE_ACCOUNT_ID = $taskAccount
    $env:WRANGLER_SEND_METRICS = 'false'
    $env:WRANGLER_LOG_PATH = $taskLogPath

    $taskStage = 'formal-preflight'
    $taskFormalBefore = Get-FormalSnapshot
    if ($taskFormalBefore.versionId -cne $taskExpectedVersion -or
        $taskFormalBefore.bindingSha256 -cne $taskExpectedBindingSha -or
        $taskFormalBefore.versionBindingSha256 -cne $taskExpectedBindingSha -or
        $taskFormalBefore.appHyperdriveId -cne $taskExpectedApp) {
        throw 'Formal Worker release differs from reviewed target.'
    }
    # Generate the temporary binding from the just-read formal settings. The
    # historical checked-in TOML has a stale Hyperdrive ID and workers_dev=false.
    $taskConfigBody = [ordered]@{
        name = $taskName
        main = '../test/integration/ProductionObservabilityAuditWorker.ts'
        compatibility_date = '2026-08-31'
        compatibility_flags = @('nodejs_compat','global_fetch_strictly_public')
        workers_dev = $true
        limits = @{ cpu_ms = 10000 }
        observability = @{ enabled = $true; logs = @{ invocation_logs = $false } }
        vars = @{ AUDIT_TOKEN_SHA256 = ''; AUDIT_EXPIRES_AT = '' }
        hyperdrive = @(@{ binding = 'HYPERDRIVE'; id = $taskFormalBefore.appHyperdriveId })
    }
    $taskConfigBody | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskConfig -Encoding utf8NoBOM
    $taskStage = 'target-absence'
    if ([int](Get-Http -Uri $taskApi -Headers $taskApiHeaders).StatusCode -ne 404) {
        throw 'Random temporary target was not absent.'
    }
    $taskStage = 'deploy'
    $taskAttempted = $true
    $taskDeploy = Invoke-BoundedWrangler -Operation deploy -Arguments @(
        '--config',('"' + $taskConfig + '"'),'--name',$taskName,
        '--var',"AUDIT_TOKEN_SHA256:$taskTokenHash",'--var',"AUDIT_EXPIRES_AT:$taskExpiry",
        '--message',$taskMarker)
    if ($taskDeploy -cnotmatch [regex]::Escape($taskUrl)) { throw 'Expected temporary URL not returned.' }
    $taskStage = 'owned-version'
    $taskOwnedVersion = Get-OwnedVersion
    $taskOwnershipVerified = $true

    $taskStage = 'access-boundaries'
    # Newly deployed workers.dev endpoints can briefly return 404. Retry only
    # these SQL-free checks; the authenticated database audit is never retried.
    for ($taskTry = 0; $taskTry -lt 6; $taskTry++) {
        $taskAnonymous = Get-Http -Uri "$taskUrl/observability" -Headers @{}
        $taskWrongMethod = Get-Http -Uri "$taskUrl/observability" -Headers $taskAuth -Method 'POST'
        $taskAccess.anonymous = [int]$taskAnonymous.StatusCode
        $taskAccess.wrongMethod = [int]$taskWrongMethod.StatusCode
        if ($taskAccess.anonymous -eq 403 -and $taskAccess.wrongMethod -eq 405) { break }
        if ($taskAccess.anonymous -notin @(403,404) -or $taskAccess.wrongMethod -notin @(404,405)) { break }
        if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
    }
    $taskWrongQuery = Get-Http -Uri "$taskUrl/observability?sql=select" -Headers $taskAuth
    $taskWrongPath = Get-Http -Uri "$taskUrl/other" -Headers $taskAuth
    $taskAccess.query = [int]$taskWrongQuery.StatusCode
    $taskAccess.wrongPath = [int]$taskWrongPath.StatusCode
    if ($taskAccess.anonymous -ne 403 -or $taskAccess.wrongMethod -ne 405 -or
        $taskAccess.query -ne 404 -or $taskAccess.wrongPath -ne 404) {
        throw 'Temporary Worker access boundaries failed.'
    }
    foreach ($taskBoundary in @($taskAnonymous,$taskWrongMethod,$taskWrongQuery,$taskWrongPath)) {
        if (-not (Test-NoStore $taskBoundary)) { throw 'Temporary Worker cache boundary failed.' }
    }
    $taskStage = 'single-readonly-audit'
    $taskDiagnostic.outcome = 'transport'
    $taskSampleRequestCount++
    try {
        $taskReply = Get-Http -Uri "$taskUrl/observability" -Headers $taskAuth -TimeoutSec 30
    } catch {
        if (Test-AuditTimeout -ErrorObject $_.Exception) { $taskDiagnostic.outcome = 'timeout' }
        throw 'Single observability sample transport failed.'
    }
    $taskHttpStatus = [int]$taskReply.StatusCode
    $taskDiagnostic.httpStatus = if ($taskHttpStatus -in @(200,403,408,429,500,502,503,504)) {
        [string]$taskHttpStatus
    } else { 'other' }
    $taskDiagnostic.cacheControl = if (Test-NoStore $taskReply) {
        'present'
    } else { 'absent' }
    $taskDiagnostic.outcome = 'http-status'
    if ($taskHttpStatus -eq 503 -and $taskDiagnostic.cacheControl -ceq 'present' -and
        $taskReply.Content -is [string] -and $taskReply.Content.Length -le 4096) {
        # Accept only fixed Worker diagnostic labels from a fixed failure body.
        # No response text, SQL or arbitrary JSON value enters the receipt.
        try {
            $taskErrorBody = $taskReply.Content | ConvertFrom-Json -Depth 4
            if ($taskErrorBody.error -ceq 'audit failed' -and
                $taskErrorBody.stage -is [string] -and
                @('connect','sample','close') -ccontains $taskErrorBody.stage -and
                $taskErrorBody.category -is [string] -and
                @('permission','lock','timeout','connection','other') -ccontains $taskErrorBody.category) {
                $taskDiagnostic.workerStage = [string]$taskErrorBody.stage
                $taskDiagnostic.category = [string]$taskErrorBody.category
            }
        } catch { }
    }
    if ($taskHttpStatus -ne 200) {
        throw 'Single observability sample did not complete.'
    }
    $taskDiagnostic.outcome = 'cache-control'
    if ($taskDiagnostic.cacheControl -cne 'present') { throw 'Single observability sample cache boundary failed.' }
    $taskDiagnostic.outcome = 'json-parse'
    if ($taskReply.Content -isnot [string] -or $taskReply.Content.Length -gt 131072) {
        throw 'Single observability response exceeded reviewed bounds.'
    }
    try { $taskRaw = $taskReply.Content | ConvertFrom-Json -Depth 12 -DateKind String }
    catch { throw 'Single observability JSON parse failed.' }
    $taskDiagnostic.outcome = 'shape'
    $taskResult = Convert-ObservabilityAggregate $taskRaw
    $taskDiagnostic.outcome = 'complete'
    $taskStage = 'audit-completed'
} catch {
    # Do not print raw HTTP, Wrangler or database exceptions: they can contain
    # tokens, connection context or internal SQL. The stage is sufficient.
    $taskFailure = 'Current observability sample could not be fully confirmed.'
} finally {
    if ($taskAttempted) {
        try {
            $taskStageBeforeCleanup = $taskStage
            $taskStage = 'cleanup-ownership'
            $taskPresent = Get-TemporaryControl -Uri $taskApi -AllowAbsent $true
            if ([int]$taskPresent.StatusCode -eq 200) {
                $taskBeforeDeleteVersion = Get-OwnedVersion
                if ($taskOwnedVersion -and $taskBeforeDeleteVersion -cne $taskOwnedVersion) {
                    throw 'Temporary Worker version changed before deletion.'
                }
                $taskOwnershipVerified = $true
                $taskStage = 'cleanup-delete'
                try {
                    $null = Invoke-BoundedWrangler -Operation delete -Arguments @(
                        $taskName,'--config',('"' + $taskConfig + '"'),'--force')
                    $taskDeleted = $true
                } catch { $taskDeleteFailed = $true }
            } elseif ([int]$taskPresent.StatusCode -ne 404 -or $taskOwnedVersion) {
                throw 'Temporary Worker control-plane state changed.'
            }
            $taskStage = 'cleanup-control-404'
            for ($taskTry = 0; $taskTry -lt 6; $taskTry++) {
                try {
                    $taskStatus = [int](Get-Http -Uri $taskApi -Headers $taskApiHeaders).StatusCode
                } catch {
                    $taskControlMissing = $false
                    if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
                    continue
                }
                $taskControlMissing = $taskStatus -eq 404
                if (-not $taskControlMissing -and $taskStatus -notin @(200,408,429,500,502,503,504)) {
                    throw 'Temporary Worker cleanup status was unexpected.'
                }
                if ($taskControlMissing) { break }
                if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
            }
            $taskStage = 'cleanup-public-404'
            $taskPublicMissing = Test-PublicMissing
            if (-not $taskControlMissing) { throw 'Temporary Worker control-plane absence not confirmed.' }
            if (-not $taskPublicMissing) { throw 'Temporary Worker public absence not confirmed.' }
            if ($taskDeleteFailed) { throw 'Bounded Wrangler deletion did not finish successfully.' }
            $taskStage = $taskStageBeforeCleanup
        } catch {
            $taskFailure = 'Temporary Worker cleanup needs independent verification.'
        }
    }
    if ($taskFormalBefore) {
        try {
            $taskFormalAfter = Get-FormalSnapshot
            $taskMainUnchanged = $taskFormalAfter.deploymentId -ceq $taskFormalBefore.deploymentId -and
                $taskFormalAfter.versionId -ceq $taskFormalBefore.versionId -and
                $taskFormalAfter.bindingSha256 -ceq $taskFormalBefore.bindingSha256 -and
                $taskFormalAfter.versionBindingSha256 -ceq $taskFormalBefore.versionBindingSha256 -and
                $taskFormalAfter.appHyperdriveId -ceq $taskFormalBefore.appHyperdriveId
            if (-not $taskMainUnchanged) { throw 'Formal Worker changed during audit.' }
        } catch {
            $taskFailure = 'Formal Worker postflight needs independent verification.'
        }
    }
    $taskToken = $null
    $taskAuth = $null
    $env:CLOUDFLARE_ACCOUNT_ID = $taskOriginalAccount
    $env:WRANGLER_SEND_METRICS = $taskOriginalMetrics
    $env:WRANGLER_LOG_PATH = $taskOriginalLog
    if ($taskLocalPathsOwned) {
        # Inspect only metadata. The Wrangler log may contain sensitive CLI or
        # connection context, so never read or publish its contents. Keep the
        # digest only when its size is within the reviewed one-MiB ceiling.
        if (Test-Path -LiteralPath $taskLogPath) {
            try {
                $taskLogItem = Get-Item -LiteralPath $taskLogPath -ErrorAction Stop
                if ($taskLogItem -isnot [IO.FileInfo]) { throw 'Owned log is not a file.' }
                $taskWranglerLogBytes = [long]$taskLogItem.Length
                if ($taskWranglerLogBytes -gt 1048576) { $taskWranglerLogOversize = $true }
                else { $taskWranglerLogSha256 = (Get-FileHash -LiteralPath $taskLogPath -Algorithm SHA256).Hash.ToLowerInvariant() }
            } catch { $taskWranglerLogInspectionFailed = $true }
            try { Remove-Item -LiteralPath $taskLogPath -Force }
            catch { $taskWranglerLogCleanupFailed = $true }
        }
        if (Test-Path -LiteralPath $taskLogPath) { $taskWranglerLogCleanupFailed = $true }

        # A surviving temporary Worker still needs this generated, token-free
        # config for a controlled, ownership-checked recovery. A timed-out
        # Wrangler child can reappear even after both 404 observations.
        $taskRemoteCleanupConfirmed = (-not $taskAttempted) -or
            ($taskDeleted -and $taskControlMissing -and $taskPublicMissing -and
             -not $taskDeleteFailed -and -not $taskProcessTreeUncertain)
        if ($taskRemoteCleanupConfirmed -and (Test-Path -LiteralPath $taskConfig)) {
            try { Remove-Item -LiteralPath $taskConfig -Force }
            catch { $taskConfigCleanupFailed = $true }
        } elseif (-not $taskRemoteCleanupConfirmed -and (Test-Path -LiteralPath $taskConfig)) {
            $taskConfigRetainedForRecovery = $true
        }
        if ($taskRemoteCleanupConfirmed -and (Test-Path -LiteralPath $taskConfig)) {
            $taskConfigCleanupFailed = $true
        }
        if (Test-Path -LiteralPath $taskLogPath) {
            $taskRetainedLocalFiles += [ordered]@{ kind = 'wrangler_log'; path = $taskLogPath }
        }
        if (Test-Path -LiteralPath $taskConfig) {
            $taskRetainedLocalFiles += [ordered]@{ kind = 'generated_config'; path = $taskConfig }
        }
    }
    if ($taskProcessTreeUncertain) {
        $taskFailure = 'Wrangler process tree needs independent verification; inspect the temporary Worker name.'
    } elseif (($taskWranglerLogInspectionFailed -or $taskWranglerLogOversize) -and -not $taskFailure) {
        $taskFailure = 'Owned Wrangler log inspection exceeded reviewed bounds or failed.'
    } elseif ($taskCliOutputCleanupFailed -and -not $taskFailure) {
        $taskFailure = 'Wrangler temporary output cleanup needs independent verification.'
    } elseif (($taskWranglerLogCleanupFailed -or $taskConfigCleanupFailed) -and -not $taskFailure) {
        $taskFailure = 'Owned Wrangler log or generated config cleanup needs independent verification.'
    }
}

$taskSuccess = $taskStage -eq 'audit-completed' -and -not $taskFailure -and
    $taskLocalPathsOwned -and $taskOwnershipVerified -and $taskDeleted -and
    $taskControlMissing -and $taskPublicMissing -and
    $taskMainUnchanged -and -not $taskProcessTreeUncertain -and -not $taskCliOutputCleanupFailed -and
    -not $taskWranglerLogInspectionFailed -and -not $taskWranglerLogOversize -and
    -not $taskWranglerLogCleanupFailed -and -not $taskConfigCleanupFailed -and
    -not $taskConfigRetainedForRecovery -and
    $taskSampleRequestCount -eq 1 -and $taskResult.ready -eq $true
$taskReceipt = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    scope = 'test003b-observability-current-app-readonly'
    workerName = $taskName
    stage = $taskStage
    formalBefore = $taskFormalBefore
    formalAfter = $taskFormalAfter
    formalUnchanged = [bool]$taskMainUnchanged
    ownedVersionId = $taskOwnedVersion
    access = $taskAccess
    diagnostic = $taskDiagnostic
    sampleRequestCount = $taskSampleRequestCount
    aggregate = $taskResult
    cleanup = [ordered]@{ attempted = $taskAttempted; localPathsOwned = $taskLocalPathsOwned;
        ownershipVerified = $taskOwnershipVerified;
        deleted = $taskDeleted; controlPlane404 = $taskControlMissing; public404 = $taskPublicMissing;
        processTreeConfirmedStopped = (-not $taskProcessTreeUncertain);
        stdoutStderrRemoved = (-not $taskCliOutputCleanupFailed);
        wranglerLogBytes = $taskWranglerLogBytes;
        wranglerLogSha256 = $taskWranglerLogSha256;
        wranglerLogSizeBounded = (-not $taskWranglerLogOversize);
        wranglerLogInspected = (-not $taskWranglerLogInspectionFailed);
        wranglerLogRemoved = ($taskLocalPathsOwned -and -not $taskWranglerLogCleanupFailed);
        generatedConfigRemoved = ($taskLocalPathsOwned -and -not $taskConfigCleanupFailed -and
            -not $taskConfigRetainedForRecovery);
        generatedConfigRetainedForRecovery = $taskConfigRetainedForRecovery;
        retainedLocalFiles = $taskRetainedLocalFiles }
    ready = [bool]$taskSuccess
    checklistItemComplete = $false
    remainingEvidence = @('workers_logs_signal_evidence')
    failure = $taskFailure
}
$taskReceipt | ConvertTo-Json -Depth 12
if ($taskSuccess) { exit 0 }
if ($taskResult -and $taskResult.ready -eq $false -and -not $taskFailure -and
    $taskSampleRequestCount -eq 1 -and $taskLocalPathsOwned -and $taskOwnershipVerified -and
    $taskDeleted -and $taskControlMissing -and $taskPublicMissing -and $taskMainUnchanged -and
    -not $taskProcessTreeUncertain -and -not $taskCliOutputCleanupFailed -and
    -not $taskWranglerLogInspectionFailed -and -not $taskWranglerLogOversize -and
    -not $taskWranglerLogCleanupFailed -and -not $taskConfigCleanupFailed -and
    -not $taskConfigRetainedForRecovery) { exit 1 }
exit 2
