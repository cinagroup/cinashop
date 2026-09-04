$ErrorActionPreference = "Stop"

$taskAuditName = "cinashop-virtual-delivery-audit-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
$taskConfigPath = "test/integration/virtual-product-delivery-audit.wrangler.jsonc"
$taskAuditSchema = "codex_virtual_delivery_" + [Guid]::NewGuid().ToString("N").Substring(0, 16)
$taskAuditKey = "vdel-" + [Guid]::NewGuid().ToString("N").Substring(0, 16)
$taskTokenBytes = New-Object byte[] 32
$taskRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $taskRandom.GetBytes($taskTokenBytes) } finally { $taskRandom.Dispose() }
$taskToken = [BitConverter]::ToString($taskTokenBytes).Replace("-", "").ToLowerInvariant()
$taskSha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $taskHashBytes = $taskSha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskToken))
} finally {
    $taskSha256.Dispose()
}
$taskTokenHash = [BitConverter]::ToString($taskHashBytes).Replace("-", "").ToLowerInvariant()
$taskDeployed = $false
$taskDeleted = $false
$taskUrlMissing = $false
$taskWorkerUrl = ""
$taskReport = $null
$taskSchemaCleanup = $null
$taskUnauthorizedStatus = 0
$taskWrongMethodStatus = 0
$taskFailure = $null

function Get-AuditStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Method,
        [hashtable]$Headers = @{}
    )
    try {
        $taskResponse = Invoke-WebRequest -Method $Method -Uri $Uri -Headers $Headers -TimeoutSec 20
        return [int]$taskResponse.StatusCode
    } catch {
        if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        throw
    }
}

try {
    $taskDeployOutput = & npx.cmd wrangler deploy `
        --config $taskConfigPath `
        --name $taskAuditName `
        --var "AUDIT_SCHEMA:$taskAuditSchema" `
        --var "AUDIT_KEY:$taskAuditKey" `
        --var "AUDIT_TOKEN_SHA256:$taskTokenHash" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Temporary virtual-delivery audit Worker deployment failed" }
    $taskDeployed = $true
    $taskDeploymentText = $taskDeployOutput -join "`n"
    $taskUrlMatch = [regex]::Match($taskDeploymentText, "https://[A-Za-z0-9.-]+\.workers\.dev")
    if (-not $taskUrlMatch.Success) { throw "Temporary virtual-delivery audit Worker URL was not reported" }
    $taskWorkerUrl = $taskUrlMatch.Value
    for ($taskAttempt = 1; $taskAttempt -le 5; $taskAttempt += 1) {
        $taskUnauthorizedStatus = Get-AuditStatus -Method Post -Uri "$taskWorkerUrl/audit"
        if ($taskUnauthorizedStatus -eq 403) { break }
        if ($taskAttempt -lt 5) { Start-Sleep -Seconds 2 }
    }
    if ($taskUnauthorizedStatus -ne 403) { throw "Temporary Worker did not enforce token authorization" }
    $taskWrongMethodStatus = Get-AuditStatus -Method Get -Uri "$taskWorkerUrl/audit" `
        -Headers @{ "X-Audit-Token" = $taskToken }
    if ($taskWrongMethodStatus -ne 404) { throw "Temporary Worker accepted an unsupported method" }
    $taskReport = Invoke-RestMethod -Method Post -Uri "$taskWorkerUrl/audit" `
        -Headers @{ "X-Audit-Token" = $taskToken } -TimeoutSec 120
} catch {
    $taskFailure = $_
} finally {
    if ($taskDeployed) {
        if ($taskWorkerUrl) {
            try {
                $taskSchemaCleanup = Invoke-RestMethod -Method Post -Uri "$taskWorkerUrl/cleanup" `
                    -Headers @{ "X-Audit-Token" = $taskToken } -TimeoutSec 60
            } catch {
                $taskSchemaCleanup = [ordered]@{
                    schema_removed = $false
                    error = $_.Exception.Message
                }
            }
        }
        $taskDeleteOutput = & npx.cmd wrangler delete $taskAuditName `
            --config $taskConfigPath --force 2>&1
        $taskDeleted = $LASTEXITCODE -eq 0
        if ($taskDeleted -and $taskWorkerUrl) {
            for ($taskAttempt = 1; $taskAttempt -le 5; $taskAttempt += 1) {
                $taskUrlMissing = (Get-AuditStatus -Method Get -Uri "$taskWorkerUrl/audit") -eq 404
                if ($taskUrlMissing) { break }
                if ($taskAttempt -lt 5) { Start-Sleep -Seconds 2 }
            }
        }
    }
}

[ordered]@{
    worker_name = $taskAuditName
    schema = $taskAuditSchema
    report = $taskReport
    failure = if ($null -ne $taskFailure) { $taskFailure.Exception.Message } else { $null }
    authorization = [ordered]@{
        no_token_status = $taskUnauthorizedStatus
        wrong_method_status = $taskWrongMethodStatus
    }
    cleanup = [ordered]@{
        schema = $taskSchemaCleanup
        delete_succeeded = $taskDeleted
        url_returns_404 = $taskUrlMissing
    }
} | ConvertTo-Json -Depth 16
if ($taskDeployed -and (
    $null -eq $taskSchemaCleanup `
    -or $taskSchemaCleanup.schema_removed -ne $true `
    -or -not $taskDeleted `
    -or -not $taskUrlMissing
)) {
    throw "Temporary virtual-delivery audit Worker cleanup did not converge"
}
if ($null -ne $taskFailure) { throw $taskFailure }
