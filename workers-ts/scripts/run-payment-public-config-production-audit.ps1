$ErrorActionPreference = "Stop"

$taskAuditName = "cinashop-payment-config-audit-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
$taskConfigPath = "test/integration/payment-public-config-audit.wrangler.jsonc"
$taskTokenBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($taskTokenBytes)
$taskToken = [BitConverter]::ToString($taskTokenBytes).Replace("-", "").ToLowerInvariant()
$taskHashBytes = [System.Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($taskToken)
)
$taskTokenHash = [BitConverter]::ToString($taskHashBytes).Replace("-", "").ToLowerInvariant()
$taskDeployed = $false
$taskDeleted = $false
$taskUrlMissing = $false
$taskWorkerUrl = ""
$taskReport = $null
$taskUnauthorizedStatus = 0
$taskWrongMethodStatus = 0

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
        if ($null -ne $_.Exception.Response) {
            return [int]$_.Exception.Response.StatusCode
        }
        throw
    }
}

try {
    $taskDeployOutput = & npx.cmd wrangler deploy `
        --config $taskConfigPath `
        --name $taskAuditName `
        --var "AUDIT_TOKEN_SHA256:$taskTokenHash" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Temporary payment config audit Worker deployment failed"
    }
    $taskDeployed = $true
    $taskDeploymentText = $taskDeployOutput -join "`n"
    $taskUrlMatch = [regex]::Match($taskDeploymentText, "https://[A-Za-z0-9.-]+\.workers\.dev")
    if (-not $taskUrlMatch.Success) {
        throw "Temporary payment config audit Worker URL was not reported"
    }
    $taskWorkerUrl = $taskUrlMatch.Value

    $taskLastError = $null
    for ($taskAttempt = 1; $taskAttempt -le 5; $taskAttempt += 1) {
        try {
            $taskReport = Invoke-RestMethod -Method Get -Uri "$taskWorkerUrl/audit" `
                -Headers @{ "X-Audit-Token" = $taskToken } -TimeoutSec 45
            $taskLastError = $null
            break
        } catch {
            $taskLastError = $_
            if ($taskAttempt -lt 5) { Start-Sleep -Seconds 2 }
        }
    }
    if ($null -ne $taskLastError) { throw $taskLastError }
    $taskUnauthorizedStatus = Get-AuditStatus -Method Get -Uri "$taskWorkerUrl/audit"
    $taskWrongMethodStatus = Get-AuditStatus -Method Post -Uri "$taskWorkerUrl/audit" `
        -Headers @{ "X-Audit-Token" = $taskToken }
} finally {
    if ($taskDeployed) {
        $taskDeleteOutput = & npx.cmd wrangler delete $taskAuditName `
            --config $taskConfigPath --force 2>&1
        $taskDeleted = $LASTEXITCODE -eq 0
        if ($taskDeleted -and $taskWorkerUrl) {
            $taskUrlMissing = (Get-AuditStatus -Method Get -Uri "$taskWorkerUrl/audit") -eq 404
        }
    }
}

[ordered]@{
    worker_name = $taskAuditName
    report = $taskReport
    authorization = [ordered]@{
        no_token_status = $taskUnauthorizedStatus
        wrong_method_status = $taskWrongMethodStatus
    }
    cleanup = [ordered]@{
        delete_succeeded = $taskDeleted
        url_returns_404 = $taskUrlMissing
    }
} | ConvertTo-Json -Depth 12
