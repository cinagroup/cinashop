# DB-009G: one fixed, read-only current-app city FK metadata audit. This script
# deploys only a random temporary workers.dev Worker; it never changes the
# formal Worker, credentials, PostgreSQL grants, schema, or business rows.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'Cloudflare credentials are required.' }

$taskRoot = Split-Path -Parent $PSScriptRoot
$taskConfig = Join-Path $taskRoot 'test/integration/customer-city-binding-fk-current-audit.wrangler.jsonc'
$taskCli = Join-Path $taskRoot 'node_modules/wrangler/bin/wrangler.js'
$taskAccount = '7ea8e46d8210bad342fa7595f7935fea'
$taskExpectedVersion = 'cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2'
$taskExpectedBindingSha = '85dcd3bd1cc2f2a6a836ed9913c2fb5f7f46dd03540894585b75be399cfe36be'
$taskExpectedApp = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7'
$taskExpectedAdmin = '446e94a4de0143f58c8e5178ec55db8b'
$taskBase = "https://api.cloudflare.com/client/v4/accounts/$taskAccount"
$taskMainApi = "$taskBase/workers/scripts/cinashop-api"
$taskName = 'cinashop-city-binding-fk-current-audit-' + [Guid]::NewGuid().ToString('N').Substring(0, 16)
$taskApi = "$taskBase/workers/scripts/$taskName"
$taskUrl = "https://$taskName.cinagroup.workers.dev"
$taskToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$taskTokenHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskToken))).ToLowerInvariant()
$taskExpiry = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds().ToString()
$taskMarker = 'db009g-city-fk-readonly-' + [Guid]::NewGuid().ToString('N')
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
$taskFormalBefore = $null
$taskFormalAfter = $null
$taskResult = $null
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
    $taskExpected = @( @("HYPERDRIVE:hyperdrive:$taskExpectedApp",'AUDIT_TOKEN_SHA256:plain_text',
        'AUDIT_EXPIRES_AT:plain_text') | Sort-Object -CaseSensitive )
    if ($taskActual.Count -ne $taskExpected.Count -or ($taskActual -join '|') -cne ($taskExpected -join '|')) {
        throw 'Temporary Worker binding projection differs.'
    }
    return $taskVersionId
}
function Test-PublicMissing {
    for ($taskTry = 0; $taskTry -lt 6; $taskTry++) {
        try {
            $taskResponse = Get-Http -Uri "$taskUrl/city-binding-fk" -Headers @{} -TimeoutSec 20
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

try {
    $taskParsed = Get-Content -Raw -LiteralPath $taskConfig | ConvertFrom-Json
    $taskConfigKeys = @($taskParsed.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $taskAllowedKeys = @( @('$schema','compatibility_date','compatibility_flags','hyperdrive',
        'limits','main','name','observability','vars','workers_dev') | Sort-Object -CaseSensitive )
    $taskVarKeys = @($taskParsed.vars.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    if ($taskParsed.main -cne 'CustomerCityBindingFkCurrentAuditWorker.ts' -or
        ($taskConfigKeys -join '|') -cne ($taskAllowedKeys -join '|') -or
        ($taskVarKeys -join '|') -cne 'AUDIT_EXPIRES_AT|AUDIT_TOKEN_SHA256' -or
        $taskParsed.name -cne 'cinashop-city-binding-fk-current-audit-template' -or
        $taskParsed.workers_dev -ne $true -or @($taskParsed.hyperdrive).Count -ne 1 -or
        $taskParsed.hyperdrive[0].binding -cne 'HYPERDRIVE' -or
        $taskParsed.hyperdrive[0].id -cne $taskExpectedApp) {
        throw 'Temporary Worker local configuration differs from reviewed scope.'
    }
    if (-not (Test-Path -LiteralPath $taskCli -PathType Leaf)) { throw 'Wrangler executable unavailable.' }
    $env:CLOUDFLARE_ACCOUNT_ID = $taskAccount
    $env:WRANGLER_SEND_METRICS = 'false'
    $env:WRANGLER_LOG_PATH = Join-Path $taskRoot ".cache/$taskName-wrangler.log"
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot '.cache')

    $taskStage = 'formal-preflight'
    $taskFormalBefore = Get-FormalSnapshot
    if ($taskFormalBefore.versionId -cne $taskExpectedVersion -or
        $taskFormalBefore.bindingSha256 -cne $taskExpectedBindingSha -or
        $taskFormalBefore.versionBindingSha256 -cne $taskExpectedBindingSha) {
        throw 'Formal Worker release differs from reviewed target.'
    }
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
        $taskAccess.anonymous = [int](Get-Http -Uri "$taskUrl/city-binding-fk" -Headers @{}).StatusCode
        $taskAccess.wrongMethod = [int](Get-Http -Uri "$taskUrl/city-binding-fk" -Headers $taskAuth -Method 'POST').StatusCode
        if ($taskAccess.anonymous -eq 403 -and $taskAccess.wrongMethod -eq 405) { break }
        if ($taskAccess.anonymous -notin @(403,404) -or $taskAccess.wrongMethod -notin @(404,405)) { break }
        if ($taskTry -lt 5) { Start-Sleep -Seconds 1 }
    }
    $taskAccess.query = [int](Get-Http -Uri "$taskUrl/city-binding-fk?schema=other" -Headers $taskAuth).StatusCode
    $taskAccess.wrongPath = [int](Get-Http -Uri "$taskUrl/other" -Headers $taskAuth).StatusCode
    if ($taskAccess.anonymous -ne 403 -or $taskAccess.wrongMethod -ne 405 -or
        $taskAccess.query -ne 404 -or $taskAccess.wrongPath -ne 404) {
        throw 'Temporary Worker access boundaries failed.'
    }
    $taskStage = 'single-readonly-audit'
    $taskDiagnostic.outcome = 'transport'
    try {
        $taskReply = Get-Http -Uri "$taskUrl/city-binding-fk" -Headers $taskAuth -TimeoutSec 30
    } catch {
        if (Test-AuditTimeout -ErrorObject $_.Exception) { $taskDiagnostic.outcome = 'timeout' }
        throw 'Single database audit transport failed.'
    }
    $taskHttpStatus = [int]$taskReply.StatusCode
    $taskDiagnostic.httpStatus = if ($taskHttpStatus -in @(200,403,408,429,500,502,503,504)) {
        [string]$taskHttpStatus
    } else { 'other' }
    $taskDiagnostic.cacheControl = if ($taskReply.Headers['Cache-Control'] -contains 'no-store') {
        'present'
    } else { 'absent' }
    $taskDiagnostic.outcome = 'http-status'
    if ($taskHttpStatus -eq 503 -and $taskDiagnostic.cacheControl -ceq 'present') {
        # Accept only fixed Worker diagnostic labels from a fixed failure body.
        # No response text, SQL or arbitrary JSON value enters the receipt.
        try {
            $taskErrorBody = $taskReply.Content | ConvertFrom-Json -Depth 4
            if ($taskErrorBody.error -ceq 'audit failed' -and
                $taskErrorBody.stage -is [string] -and
                @('connect','catalog','close') -ccontains $taskErrorBody.stage -and
                $taskErrorBody.category -is [string] -and
                @('permission','lock','timeout','connection','other') -ccontains $taskErrorBody.category) {
                $taskDiagnostic.workerStage = [string]$taskErrorBody.stage
                $taskDiagnostic.category = [string]$taskErrorBody.category
            }
        } catch { }
    }
    if ($taskHttpStatus -ne 200) {
        throw 'Single database audit did not complete.'
    }
    $taskDiagnostic.outcome = 'cache-control'
    if ($taskDiagnostic.cacheControl -cne 'present') { throw 'Single database audit cache boundary failed.' }
    $taskDiagnostic.outcome = 'json-parse'
    try { $taskRaw = $taskReply.Content | ConvertFrom-Json -Depth 12 }
    catch { throw 'Single database audit JSON parse failed.' }
    $taskDiagnostic.outcome = 'shape'
    if ((@($taskRaw.PSObject.Properties.Name | Sort-Object -CaseSensitive) -join '|') -cne
        'audit|ready|readyForIndexDecision|scope' -or
        $taskRaw.scope -cne 'city-binding-fk-current-app' -or
        $taskRaw.ready -isnot [bool] -or $taskRaw.readyForIndexDecision -isnot [bool] -or
        $taskRaw.readyForIndexDecision -cne $false) {
        throw 'Unexpected city FK result envelope.'
    }
    $taskAudit = $taskRaw.audit
    if ($null -eq $taskAudit -or
        (@($taskAudit.PSObject.Properties.Name | Sort-Object -CaseSensitive) -join '|') -cne
            'catalogMatch|foreignKey|identityMatch|indexes|readyForIndexDecision|scope|tables' -or
        $taskAudit.scope -cne 'city-binding-fk-metadata-only' -or
        $taskAudit.identityMatch -isnot [bool] -or $taskAudit.catalogMatch -isnot [bool] -or
        $taskAudit.readyForIndexDecision -isnot [bool] -or
        $taskAudit.readyForIndexDecision -cne $false -or
        $taskRaw.ready -ne ($taskAudit.identityMatch -and $taskAudit.catalogMatch)) {
        throw 'Unexpected city FK catalog envelope.'
    }
    $taskSafeAudit = [ordered]@{ scope = 'city-binding-fk-metadata-only';
        identityMatch = [bool]$taskAudit.identityMatch; catalogMatch = [bool]$taskAudit.catalogMatch;
        tables = $null; foreignKey = $null; indexes = $null; readyForIndexDecision = $false }
    if ($taskAudit.catalogMatch) {
        if (-not $taskAudit.identityMatch -or $null -eq $taskAudit.tables -or
            $null -eq $taskAudit.foreignKey -or $null -eq $taskAudit.indexes) {
            throw 'Complete city FK catalog lacks required sections.'
        }
        $taskTableNames = @('customer_city_delivery_attempt','customer_city_delivery_binding')
        if ((@($taskAudit.tables.PSObject.Properties.Name | Sort-Object -CaseSensitive) -join '|') -cne
            (@($taskTableNames | Sort-Object -CaseSensitive) -join '|')) {
            throw 'City FK table names differ.'
        }
        $taskNumberFields = @('estimatedRows','liveRowsEstimate','modificationsSinceAnalyze',
            'heapBytes','indexBytes','totalBytes','lastAnalyzeMs','lastAutoanalyzeMs')
        $taskSafeTables = [ordered]@{}
        foreach ($taskTable in $taskTableNames) {
            $taskValues = $taskAudit.tables.$taskTable
            if ($null -eq $taskValues -or
                (@($taskValues.PSObject.Properties.Name | Sort-Object -CaseSensitive) -join '|') -cne
                (@($taskNumberFields | Sort-Object -CaseSensitive) -join '|')) {
                throw 'City FK table field names differ.'
            }
            $taskSafeNumbers = [ordered]@{}
            foreach ($taskField in $taskNumberFields) {
                $taskValue = $taskValues.$taskField
                if ($null -ne $taskValue -and ($taskValue -isnot [string] -or
                    $taskValue -cnotmatch '^\d{1,20}$')) {
                    throw 'City FK table field is not a bounded decimal.'
                }
                if ($taskField -in @('heapBytes','indexBytes','totalBytes') -and $null -eq $taskValue) {
                    throw 'City FK table size is missing.'
                }
                $taskSafeNumbers[$taskField] = $taskValue
            }
            $taskSafeTables[$taskTable] = $taskSafeNumbers
        }
        if ((@($taskAudit.foreignKey.PSObject.Properties.Name | Sort-Object -CaseSensitive) -join '|') -cne
            'exact|name' -or $taskAudit.foreignKey.name -cne 'ccdbinding_attempt_fk' -or
            $taskAudit.foreignKey.exact -isnot [bool] -or
            $taskAudit.foreignKey.exact -cne $true) {
            throw 'City FK definition differs.'
        }
        $taskIndex = $taskAudit.indexes
        if ((@($taskIndex.PSObject.Properties.Name | Sort-Object -CaseSensitive) -join '|') -cne
            'catalogSha256|count|expression|leadingAny|leadingUsableNonpartial|leadingUsablePartial' -or
            $taskIndex.catalogSha256 -isnot [string] -or
            $taskIndex.catalogSha256 -cnotmatch '^[a-f0-9]{64}$') {
            throw 'City FK index catalog differs.'
        }
        foreach ($taskField in @('count','expression','leadingAny','leadingUsableNonpartial','leadingUsablePartial')) {
            $taskValue = $taskIndex.$taskField
            if ($taskValue -isnot [long] -or $taskValue -lt 0 -or $taskValue -gt 32) {
                throw 'City FK index count is invalid.'
            }
        }
        if ($taskIndex.expression -gt $taskIndex.count -or $taskIndex.leadingAny -gt $taskIndex.count -or
            $taskIndex.leadingUsableNonpartial + $taskIndex.leadingUsablePartial -gt $taskIndex.leadingAny) {
            throw 'City FK index counts conflict.'
        }
        $taskSafeAudit.tables = $taskSafeTables
        $taskSafeAudit.foreignKey = [ordered]@{ name = 'ccdbinding_attempt_fk'; exact = $true }
        $taskSafeAudit.indexes = [ordered]@{
            catalogSha256 = $taskIndex.catalogSha256; count = [int]$taskIndex.count;
            leadingAny = [int]$taskIndex.leadingAny;
            leadingUsableNonpartial = [int]$taskIndex.leadingUsableNonpartial;
            leadingUsablePartial = [int]$taskIndex.leadingUsablePartial;
            expression = [int]$taskIndex.expression }
    } elseif ($null -ne $taskAudit.tables -or $null -ne $taskAudit.foreignKey -or
        $null -ne $taskAudit.indexes) {
        throw 'Incomplete city FK catalog exposed sections.'
    }
    # Project only reviewed fields; no raw body, SQL or connection data survives.
    $taskResult = [ordered]@{ scope = 'city-binding-fk-current-app';
        ready = [bool]$taskRaw.ready; readyForIndexDecision = $false; audit = $taskSafeAudit }
    $taskDiagnostic.outcome = 'complete'
    $taskStage = 'audit-completed'
} catch {
    # Do not print raw HTTP, Wrangler or database exceptions: they can contain
    # tokens, connection context or internal SQL. The stage is sufficient.
    $taskFailure = 'Current city-binding FK audit could not be fully confirmed.'
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
                $taskDeleteFailed = $false
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
                $taskFormalAfter.versionBindingSha256 -ceq $taskFormalBefore.versionBindingSha256
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
    if ($taskProcessTreeUncertain) {
        $taskFailure = 'Wrangler process tree needs independent verification; inspect the temporary Worker name.'
    } elseif ($taskCliOutputCleanupFailed -and -not $taskFailure) {
        $taskFailure = 'Wrangler temporary output cleanup needs independent verification.'
    }
}

$taskSuccess = $taskStage -eq 'audit-completed' -and -not $taskFailure -and
    $taskOwnershipVerified -and $taskDeleted -and $taskControlMissing -and $taskPublicMissing -and
    $taskMainUnchanged -and -not $taskProcessTreeUncertain -and -not $taskCliOutputCleanupFailed -and
    $taskResult.audit.identityMatch -eq $true -and $taskResult.ready -eq $true
$taskReceipt = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    scope = 'db009g-city-fk-current-app-readonly'
    workerName = $taskName
    stage = $taskStage
    formalBefore = $taskFormalBefore
    formalAfter = $taskFormalAfter
    formalUnchanged = [bool]$taskMainUnchanged
    ownedVersionId = $taskOwnedVersion
    access = $taskAccess
    diagnostic = $taskDiagnostic
    audit = $taskResult
    cleanup = [ordered]@{ attempted = $taskAttempted; ownershipVerified = $taskOwnershipVerified;
        deleted = $taskDeleted; controlPlane404 = $taskControlMissing; public404 = $taskPublicMissing;
        processTreeConfirmedStopped = (-not $taskProcessTreeUncertain);
        stdoutStderrRemoved = (-not $taskCliOutputCleanupFailed) }
    ready = [bool]$taskSuccess
    failure = $taskFailure
}
$taskReceipt | ConvertTo-Json -Depth 12
if ($taskSuccess) { exit 0 }
if ($taskResult -and $taskResult.ready -eq $false -and -not $taskFailure -and
    $taskDeleted -and $taskControlMissing -and $taskPublicMissing -and $taskMainUnchanged) { exit 1 }
exit 2
