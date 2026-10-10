# Offline simulation of the temporary Worker runner. All Cloudflare HTTP and
# Wrangler calls are replaced before the runner is dot-sourced. No network or DB.
[CmdletBinding()]
param(
    [ValidateSet('all','success','deploy-failed','request-failed','request-timeout',
        'header-missing','malformed-json','malformed-shape','worker-catalog-503','temporary-version-drift',
        'formal-postflight-drift','foreign-target','owned-version-transient',
        'cleanup-presence-transient','ownership-read-unavailable',
        'control-404-transient','control-404-unavailable','marker-drift','binding-drift',
        'catalog-identity-drift','catalog-definition-drift','catalog-malformed-number',
        'catalog-malformed-index','formal-settings-binding-drift','formal-version-binding-drift')]
    [string]$Scenario = 'all',
    [string]$TracePath
)
$ErrorActionPreference = 'Stop'
$taskRunner = Join-Path $PSScriptRoot 'run-customer-city-binding-fk-current-production-audit.ps1'

if ($Scenario -eq 'all') {
    $taskCases = @('success','deploy-failed','request-failed','request-timeout',
        'header-missing','malformed-json','malformed-shape','worker-catalog-503','temporary-version-drift',
        'formal-postflight-drift','foreign-target','owned-version-transient',
        'cleanup-presence-transient','ownership-read-unavailable',
        'control-404-transient','control-404-unavailable','marker-drift','binding-drift',
        'catalog-identity-drift','catalog-definition-drift','catalog-malformed-number',
        'catalog-malformed-index','formal-settings-binding-drift','formal-version-binding-drift')
    foreach ($taskCase in $taskCases) {
        $taskTrace = Join-Path $env:TEMP ('db009g-city-fk-runner-' + [Guid]::NewGuid().ToString('N') + '.txt')
        try {
            $taskOutput = & pwsh -NoProfile -File $PSCommandPath -Scenario $taskCase -TracePath $taskTrace 2>&1
            $taskExit = $LASTEXITCODE
            $taskReceipt = ($taskOutput -join "`n") | ConvertFrom-Json -Depth 20
            $taskCalls = if (Test-Path -LiteralPath $taskTrace) {
                @(Get-Content -LiteralPath $taskTrace)
            } else { @() }
            $taskDeletes = @($taskCalls | Where-Object { $_ -ceq 'delete-owned' }).Count
            $taskDeploys = @($taskCalls | Where-Object { $_ -ceq 'deploy-owned' }).Count
            if ($taskCase -in @('success','owned-version-transient','cleanup-presence-transient',
                'control-404-transient')) {
                if ($taskExit -ne 0 -or $taskReceipt.ready -ne $true -or
                    $taskReceipt.diagnostic.outcome -cne 'complete' -or
                    $taskReceipt.cleanup.controlPlane404 -ne $true -or
                    $taskReceipt.cleanup.public404 -ne $true -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1) {
                    throw 'Success simulation failed.'
                }
            } elseif ($taskCase -in @('deploy-failed','request-failed','request-timeout',
                'header-missing','malformed-json','malformed-shape','worker-catalog-503',
                'formal-postflight-drift')) {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1 -or
                    $taskReceipt.cleanup.controlPlane404 -ne $true -or
                    $taskReceipt.cleanup.public404 -ne $true) {
                    throw "$taskCase did not clean up its owned Worker."
                }
                $taskExpectedDiagnostic = switch ($taskCase) {
                    'request-failed' { @('http-status','503','present','unobserved','unobserved') }
                    'request-timeout' { @('timeout','unobserved','unobserved','unobserved','unobserved') }
                    'header-missing' { @('cache-control','200','absent','unobserved','unobserved') }
                    'malformed-json' { @('json-parse','200','present','unobserved','unobserved') }
                    'malformed-shape' { @('shape','200','present','unobserved','unobserved') }
                    'worker-catalog-503' { @('http-status','503','present','catalog','timeout') }
                }
                if ($taskExpectedDiagnostic -and
                    (@($taskReceipt.diagnostic.outcome,$taskReceipt.diagnostic.httpStatus,
                        $taskReceipt.diagnostic.cacheControl,$taskReceipt.diagnostic.workerStage,
                        $taskReceipt.diagnostic.category) -join '|') -cne
                    ($taskExpectedDiagnostic -join '|')) {
                    throw "$taskCase diagnostic classification differs."
                }
                if (($taskOutput -join "`n") -match 'private-connection-or-sql') {
                    throw "$taskCase leaked a synthetic private marker."
                }
                if ($taskCase -eq 'formal-postflight-drift' -and $taskReceipt.formalUnchanged -ne $false) {
                    throw 'Formal Worker drift was not detected.'
                }
            } elseif ($taskCase -in @('temporary-version-drift','ownership-read-unavailable',
                'marker-drift','binding-drift')) {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 0 -or
                    $taskReceipt.cleanup.deleted -ne $false -or
                    $taskReceipt.failure -cne 'Temporary Worker cleanup needs independent verification.') {
                    throw 'Unverified temporary Worker was deleted or accepted.'
                }
            } elseif ($taskCase -in @('formal-settings-binding-drift','formal-version-binding-drift')) {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 0 -or $taskDeletes -ne 0 -or
                    $taskReceipt.cleanup.attempted -ne $false) {
                    throw 'Formal binding drift passed preflight or deployed a temporary Worker.'
                }
            } elseif ($taskCase -eq 'foreign-target') {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 0 -or $taskDeletes -ne 0 -or
                    $taskReceipt.cleanup.attempted -ne $false) {
                    throw 'Pre-existing target was deployed to or deleted.'
                }
            } elseif ($taskCase -eq 'control-404-unavailable') {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1 -or
                    $taskReceipt.cleanup.controlPlane404 -ne $false -or
                    $taskReceipt.failure -cne 'Temporary Worker cleanup needs independent verification.') {
                    throw 'Unconfirmed control-plane deletion was accepted.'
                }
            } elseif ($taskCase -in @('catalog-identity-drift','catalog-definition-drift')) {
                if ($taskExit -ne 1 -or $taskReceipt.ready -ne $false -or
                    $taskReceipt.audit.audit.catalogMatch -ne $false -or
                    $taskDeploys -ne 1 -or $taskDeletes -ne 1 -or
                    $taskReceipt.cleanup.public404 -ne $true) {
                    throw 'Incomplete city FK evidence was accepted or not cleaned up.'
                }
            } elseif ($taskCase -in @('catalog-malformed-number','catalog-malformed-index')) {
                if ($taskExit -ne 2 -or $taskReceipt.ready -ne $false -or
                    $taskDeletes -ne 1 -or $taskReceipt.audit -ne $null -or
                    $taskReceipt.cleanup.public404 -ne $true) {
                    throw 'Malformed city FK evidence escaped validation or cleanup.'
                }
            }
            "$taskCase`: pass"
        } finally {
            if (Test-Path -LiteralPath $taskTrace) { Remove-Item -LiteralPath $taskTrace -Force }
        }
    }
    exit 0
}

if (-not $TracePath) { throw 'A local trace path is required for one scenario.' }
$env:CLOUDFLARE_API_TOKEN = 'synthetic-local-test-token'
$script:deployed = $false
$script:workerName = $null
$script:marker = $null
$script:formalReadCount = 0
$script:temporaryReadCount = 0
$script:versionReadCount = 0
$script:presenceReadCount = 0
$script:absenceReadCount = 0
$script:mainVersion = 'cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2'
$script:ownedVersion = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$script:changedVersion = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$script:bindings = @(
    @{ name = 'HYPERDRIVE'; type = 'hyperdrive'; id = 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' },
    @{ name = 'HYPERDRIVE_ADMIN'; type = 'hyperdrive'; id = '446e94a4de0143f58c8e5178ec55db8b' }
)
for ($taskIndex = 1; $taskIndex -le 29; $taskIndex++) {
    $script:bindings += @{ name = ('SAFE_{0:D2}' -f $taskIndex); type = 'plain_text' }
}
function New-Response {
    param([int]$Status,[object]$Body=$null,[bool]$NoStore=$true)
    [pscustomobject]@{
        StatusCode = $Status
        Content = if ($null -eq $Body) { '' } else { $Body | ConvertTo-Json -Depth 20 -Compress }
        Headers = if ($NoStore) { @{ 'Cache-Control' = @('no-store') } } else { @{} }
    }
}
function New-ApiResponse {
    param([object]$Result)
    New-Response -Status 200 -Body @{ success = $true; result = $Result }
}
function Start-Sleep { param([int]$Seconds) }
function Invoke-WebRequest {
    param([string]$Uri,[string]$Method='GET',[hashtable]$Headers,
        [switch]$SkipHttpErrorCheck,[int]$TimeoutSec)
    if ($Method -cne 'GET' -and $Method -cne 'POST') { throw 'Unexpected mock HTTP method.' }
    if ($Uri -match '/workers/scripts/cinashop-api/deployments$') {
        $script:formalReadCount++
        $taskVersion = if ($Scenario -eq 'formal-postflight-drift' -and $script:formalReadCount -ge 2) {
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        } else { $script:mainVersion }
        return New-ApiResponse @{ deployments = @(@{ id = 'main-deployment';
            created_on = '2026-10-09T00:00:00Z'; versions = @(@{ percentage = 100; version_id = $taskVersion }) }) }
    }
    if ($Uri -match '/workers/scripts/cinashop-api/settings$') {
        $taskFormalBindings = @($script:bindings)
        if ($Scenario -eq 'formal-settings-binding-drift') {
            $taskFormalBindings = @($script:bindings | ForEach-Object {
                if ($_.name -ceq 'SAFE_01') { @{ name = 'DRIFT_01'; type = 'plain_text' } }
                else { $_ }
            })
        }
        return New-ApiResponse @{ bindings = $taskFormalBindings }
    }
    if ($Uri -match '/workers/scripts/cinashop-api/versions/cd10e9cb-b3ad-49b0-8d31-e6b52e69d5e2$') {
        $taskFormalBindings = @($script:bindings)
        if ($Scenario -eq 'formal-version-binding-drift') {
            $taskFormalBindings = @($script:bindings | ForEach-Object {
                if ($_.name -ceq 'SAFE_01') { @{ name = 'DRIFT_01'; type = 'plain_text' } }
                else { $_ }
            })
        }
        return New-ApiResponse @{ resources = @{ bindings = $taskFormalBindings } }
    }
    if ($Uri -match '/workers/scripts/(?<name>cinashop-city-binding-fk-current-audit-[0-9a-f]{16})(?<suffix>/.*)?$') {
        $taskSuffix = $Matches.suffix
        if (-not $taskSuffix) {
            if (-not $script:deployed -and $script:workerName -and
                $Scenario -in @('control-404-transient','control-404-unavailable')) {
                $script:absenceReadCount++
                if ($Scenario -eq 'control-404-unavailable') { return New-Response -Status 503 }
                if ($script:absenceReadCount -eq 1) { return New-Response -Status 200 }
                if ($script:absenceReadCount -eq 2) { return New-Response -Status 429 }
                if ($script:absenceReadCount -eq 3) { return New-Response -Status 503 }
                if ($script:absenceReadCount -eq 4) { throw 'Synthetic transport interruption.' }
            }
            if ($script:deployed -and $Scenario -eq 'cleanup-presence-transient') {
                $script:presenceReadCount++
                if ($script:presenceReadCount -eq 1) { return New-Response -Status 404 }
                if ($script:presenceReadCount -eq 2) { return New-Response -Status 429 }
                if ($script:presenceReadCount -eq 3) { return New-Response -Status 503 }
                if ($script:presenceReadCount -eq 4) { throw 'Synthetic transport interruption.' }
            }
            if ($Scenario -eq 'foreign-target' -or $script:deployed) { return New-Response -Status 200 }
            return New-Response -Status 404
        }
        if (-not $script:deployed) { throw 'Mock queried an absent temporary Worker.' }
        if ($taskSuffix -eq '/deployments') {
            $script:temporaryReadCount++
            $taskVersion = if ($Scenario -eq 'temporary-version-drift' -and $script:temporaryReadCount -ge 2) {
                $script:changedVersion
            } else { $script:ownedVersion }
            return New-ApiResponse @{ deployments = @(@{ id = 'temporary-deployment';
                created_on = '2026-10-09T00:00:00Z'; versions = @(@{ percentage = 100; version_id = $taskVersion }) }) }
        }
        if ($taskSuffix -match '^/versions/(?<version>[0-9a-f-]{36})$') {
            if ($Scenario -in @('owned-version-transient','ownership-read-unavailable')) {
                $script:versionReadCount++
                if ($Scenario -eq 'ownership-read-unavailable') { return New-Response -Status 503 }
                if ($script:versionReadCount -eq 1) { return New-Response -Status 404 }
                if ($script:versionReadCount -eq 2) { return New-Response -Status 429 }
                if ($script:versionReadCount -eq 3) { return New-Response -Status 503 }
                if ($script:versionReadCount -eq 4) { throw 'Synthetic transport interruption.' }
            }
            $taskMarker = if ($Scenario -eq 'marker-drift' -and $script:temporaryReadCount -ge 2) {
                'foreign-marker'
            } else { $script:marker }
            $taskBindingId = if ($Scenario -eq 'binding-drift' -and $script:temporaryReadCount -ge 2) {
                '00000000000000000000000000000000'
            } else { 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' }
            return New-ApiResponse @{ annotations = @{ 'workers/message' = $taskMarker };
                resources = @{ bindings = @(
                    @{ name = 'HYPERDRIVE'; type = 'hyperdrive'; id = $taskBindingId },
                    @{ name = 'AUDIT_TOKEN_SHA256'; type = 'plain_text' },
                    @{ name = 'AUDIT_EXPIRES_AT'; type = 'plain_text' }
                ) } }
        }
        throw 'Unexpected temporary control-plane endpoint.'
    }
    if ($Uri -match '^https://cinashop-city-binding-fk-current-audit-[0-9a-f]{16}\.cinagroup\.workers\.dev(?<path>.*)$') {
        if (-not $script:deployed) { return New-Response -Status 404 }
        $taskPath = $Matches.path
        if (-not $Headers.ContainsKey('X-Audit-Token')) { return New-Response -Status 403 }
        if ($taskPath -cne '/city-binding-fk') { return New-Response -Status 404 }
        if ($Method -cne 'GET') { return New-Response -Status 405 }
        if ($Scenario -eq 'request-timeout') { throw [System.TimeoutException]::new('private-connection-or-sql') }
        if ($Scenario -eq 'request-failed') { return New-Response -Status 503 }
        if ($Scenario -eq 'worker-catalog-503') {
            return New-Response -Status 503 -Body @{ error = 'audit failed'; stage = 'catalog';
                category = 'timeout'; unrelated = 'private-connection-or-sql' }
        }
        if ($Scenario -eq 'header-missing') { return New-Response -Status 200 -NoStore $false }
        if ($Scenario -eq 'malformed-json') {
            $taskInvalid = New-Response -Status 200
            $taskInvalid.Content = '{private-connection-or-sql'
            return $taskInvalid
        }
        if ($Scenario -eq 'malformed-shape') {
            return New-Response -Status 200 -Body @{ scope = 'unexpected';
                identityMatch = $true; ready = $true; unrelated = 'private-connection-or-sql' }
        }
        $taskTable = [ordered]@{
            estimatedRows = '30'; liveRowsEstimate = '30'; modificationsSinceAnalyze = '0';
            heapBytes = '8192'; indexBytes = '8192'; totalBytes = '16384';
            lastAnalyzeMs = $null; lastAutoanalyzeMs = $null
        }
        if ($Scenario -eq 'catalog-malformed-number') {
            $taskTable.estimatedRows = '30 private-records'
        }
        $taskAudit = [ordered]@{
            scope = 'city-binding-fk-metadata-only'; identityMatch = $true;
            catalogMatch = $true; readyForIndexDecision = $false;
            tables = [ordered]@{
                customer_city_delivery_attempt = $taskTable;
                customer_city_delivery_binding = $taskTable
            };
            foreignKey = [ordered]@{ name = 'ccdbinding_attempt_fk'; exact = $true };
            indexes = [ordered]@{
                catalogSha256 = 'a' * 64; count = 4; leadingAny = 0;
                leadingUsableNonpartial = 0; leadingUsablePartial = 0; expression = 0
            }
        }
        if ($Scenario -eq 'catalog-malformed-index') { $taskAudit.indexes.catalogSha256 = 'invalid' }
        if ($Scenario -in @('catalog-identity-drift','catalog-definition-drift')) {
            $taskAudit.catalogMatch = $false
            $taskAudit.tables = $null
            $taskAudit.foreignKey = $null
            $taskAudit.indexes = $null
            if ($Scenario -eq 'catalog-identity-drift') { $taskAudit.identityMatch = $false }
        }
        $taskReady = $Scenario -notin @('catalog-identity-drift','catalog-definition-drift')
        return New-Response -Status 200 -Body @{ scope = 'city-binding-fk-current-app';
            ready = $taskReady; readyForIndexDecision = $false; audit = $taskAudit }
    }
    throw 'Unexpected mock URL.'
}
function node {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
    if ($CommandArgs.Count -lt 2 -or $CommandArgs[0] -notmatch 'wrangler\.js$') {
        throw 'Unexpected mock Wrangler invocation.'
    }
    if ($CommandArgs[1] -ceq 'deploy') {
        $taskNameIndex = [Array]::IndexOf($CommandArgs, '--name')
        $taskMarkerIndex = [Array]::IndexOf($CommandArgs, '--message')
        if ($taskNameIndex -lt 0 -or $taskMarkerIndex -lt 0) { throw 'Missing deploy ownership arguments.' }
        $script:workerName = $CommandArgs[$taskNameIndex + 1]
        $script:marker = $CommandArgs[$taskMarkerIndex + 1]
        $script:deployed = $true
        Add-Content -LiteralPath $TracePath -Value 'deploy-owned'
        if ($Scenario -eq 'deploy-failed') { $global:LASTEXITCODE = 1; return 'simulated deployment error' }
        $global:LASTEXITCODE = 0
        return "https://$script:workerName.cinagroup.workers.dev"
    }
    if ($CommandArgs[1] -ceq 'delete') {
        if (-not $script:deployed -or $CommandArgs[2] -cne $script:workerName) {
            throw 'Deletion was not limited to the owned temporary Worker.'
        }
        $script:deployed = $false
        Add-Content -LiteralPath $TracePath -Value 'delete-owned'
        $global:LASTEXITCODE = 0
        return
    }
    throw 'Unexpected mock Wrangler command.'
}

# The production runner pins a real release fingerprint. Substitute only the
# synthetic binding digest in this in-memory offline execution; assert that
# the reviewed production pin and path expression are present first.
$taskSource = Get-Content -Raw -LiteralPath $taskRunner
$taskProductionSha = '85dcd3bd1cc2f2a6a836ed9913c2fb5f7f46dd03540894585b75be399cfe36be'
$taskRootExpression = '$taskRoot = Split-Path -Parent $PSScriptRoot'
if ([regex]::Matches($taskSource,[regex]::Escape($taskProductionSha)).Count -ne 1 -or
    [regex]::Matches($taskSource,[regex]::Escape($taskRootExpression)).Count -ne 1) {
    throw 'Reviewed production fingerprint or runner path expression changed.'
}
$taskProjection = @($script:bindings | ForEach-Object {
    "{0}:{1}:{2}:{3}:{4}" -f $_.name,$_.type,$_.id,$_.namespace_id,$_.class_name
} | Sort-Object -CaseSensitive)
$taskMockSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes(($taskProjection -join "`n")))).ToLowerInvariant()
$taskSource = $taskSource.Replace($taskProductionSha,$taskMockSha).Replace(
    $taskRootExpression,'$taskRoot = Split-Path -Parent $taskRunnerDir')
$taskRunnerDir = $PSScriptRoot
. ([ScriptBlock]::Create($taskSource))
exit $LASTEXITCODE
