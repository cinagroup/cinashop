$ErrorActionPreference = "Stop"

$taskAuditName = "cinashop-second-card-product-audit-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
$taskConfigPath = "test/integration/second-card-product-audit.wrangler.jsonc"
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
        --var "AUDIT_TOKEN_SHA256:$taskTokenHash" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Temporary second-card product audit Worker deployment failed" }
    $taskDeployed = $true
    $taskDeploymentText = $taskDeployOutput -join "`n"
    $taskUrlMatch = [regex]::Match($taskDeploymentText, "https://[A-Za-z0-9.-]+\.workers\.dev")
    if (-not $taskUrlMatch.Success) { throw "Temporary second-card product audit Worker URL was not reported" }
    $taskWorkerUrl = $taskUrlMatch.Value
    for ($taskAttempt = 1; $taskAttempt -le 12; $taskAttempt += 1) {
        $taskUnauthorizedStatus = Get-AuditStatus -Method Post -Uri "$taskWorkerUrl/run"
        if ($taskUnauthorizedStatus -eq 403) { break }
        if ($taskAttempt -lt 12) { Start-Sleep -Seconds 3 }
    }
    if ($taskUnauthorizedStatus -ne 403) { throw "Temporary Worker did not enforce token authorization" }
    $taskWrongMethodStatus = Get-AuditStatus -Method Get -Uri "$taskWorkerUrl/run" `
        -Headers @{ "X-Audit-Token" = $taskToken }
    if ($taskWrongMethodStatus -ne 404) { throw "Temporary Worker accepted an unsupported method" }
    $taskReport = Invoke-RestMethod -Method Post -Uri "$taskWorkerUrl/run" `
        -Headers @{ "X-Audit-Token" = $taskToken } -TimeoutSec 180
} catch {
    $taskFailure = $_
} finally {
    if ($taskDeployed) {
        $taskDeleteOutput = & npx.cmd wrangler delete $taskAuditName `
            --config $taskConfigPath --force 2>&1
        $taskDeleted = $LASTEXITCODE -eq 0
        if ($taskDeleted -and $taskWorkerUrl) {
            for ($taskAttempt = 1; $taskAttempt -le 5; $taskAttempt += 1) {
                $taskUrlMissing = (Get-AuditStatus -Method Get -Uri "$taskWorkerUrl/run") -eq 404
                if ($taskUrlMissing) { break }
                if ($taskAttempt -lt 5) { Start-Sleep -Seconds 2 }
            }
        }
    }
}

[ordered]@{
    worker_name = $taskAuditName
    report = $taskReport
    failure = if ($null -ne $taskFailure) { $taskFailure.Exception.Message } else { $null }
    authorization = [ordered]@{
        no_token_status = $taskUnauthorizedStatus
        wrong_method_status = $taskWrongMethodStatus
    }
    cleanup = [ordered]@{
        delete_succeeded = $taskDeleted
        url_returns_404 = $taskUrlMissing
    }
} | ConvertTo-Json -Depth 16
if ($taskDeployed -and (-not $taskDeleted -or -not $taskUrlMissing)) {
    throw "Temporary second-card product audit Worker cleanup did not converge"
}
if ($null -ne $taskFailure) { throw $taskFailure }
