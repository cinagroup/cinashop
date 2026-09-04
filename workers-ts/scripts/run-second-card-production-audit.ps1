param(
    [switch]$ReadOnly
)

$ErrorActionPreference = "Stop"

$taskAuditName = "cinashop-second-card-audit-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
$taskConfigPath = "test/integration/second-card-reminder-audit.wrangler.jsonc"

function New-AuditCredential {
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
    return [ordered]@{
        Token = $taskToken
        Hash = [BitConverter]::ToString($taskHashBytes).Replace("-", "").ToLowerInvariant()
    }
}

function Get-HttpStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Method
    )
    try {
        $taskResponse = Invoke-WebRequest -Method $Method -Uri $Uri -TimeoutSec 20
        return [int]$taskResponse.StatusCode
    } catch {
        if ($null -ne $_.Exception.Response) {
            return [int]$_.Exception.Response.StatusCode
        }
        throw
    }
}

$taskReadCredential = New-AuditCredential
$taskWriteCredential = New-AuditCredential
if ($taskReadCredential.Hash -eq $taskWriteCredential.Hash) {
    throw "Audit credentials must be distinct"
}

$taskDeployed = $false
$taskDeleted = $false
$taskUrlMissing = $false
$taskWorkerUrl = ""
$taskReadReport = $null
$taskApplyReport = $null
$taskFinalReport = $null
$taskUnauthorizedStatus = 0
$taskWrongMethodStatus = 0

try {
    $taskDeployOutput = & npx.cmd wrangler deploy `
        --config $taskConfigPath `
        --name $taskAuditName `
        --var "AUDIT_READ_TOKEN_SHA256:$($taskReadCredential.Hash)" `
        --var "AUDIT_WRITE_TOKEN_SHA256:$($taskWriteCredential.Hash)" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Temporary second-card audit Worker deployment failed"
    }
    $taskDeployed = $true
    $taskDeploymentText = $taskDeployOutput -join "`n"
    $taskUrlMatch = [regex]::Match($taskDeploymentText, "https://[A-Za-z0-9.-]+\.workers\.dev")
    if (-not $taskUrlMatch.Success) {
        throw "Temporary second-card audit Worker URL was not reported"
    }
    $taskWorkerUrl = $taskUrlMatch.Value

    $taskLastError = $null
    for ($taskAttempt = 1; $taskAttempt -le 5; $taskAttempt += 1) {
        try {
            $taskReadReport = Invoke-RestMethod -Method Post -Uri "$taskWorkerUrl/read" `
                -Headers @{ "X-Audit-Token" = $taskReadCredential.Token } -TimeoutSec 45
            $taskLastError = $null
            break
        } catch {
            $taskLastError = $_
            if ($taskAttempt -lt 5) { Start-Sleep -Seconds 2 }
        }
    }
    if ($null -ne $taskLastError) { throw $taskLastError }
    $taskUnauthorizedStatus = Get-HttpStatus -Method Post -Uri "$taskWorkerUrl/read"
    $taskWrongMethodStatus = Get-HttpStatus -Method Get -Uri "$taskWorkerUrl/read"

    Write-Output "READ_REPORT_BEGIN"
    $taskReadReport | ConvertTo-Json -Depth 12
    Write-Output "READ_REPORT_END"

    $taskSafeSize = $taskReadReport.relation.cart_rows -le 100000 `
        -and $taskReadReport.relation.cart_total_bytes -le 67108864
    $taskKnownEvents = $taskReadReport.outboxConstraint.unsupportedRows -eq 0
    if (-not $taskSafeSize -or -not $taskKnownEvents) {
        throw "Production preconditions reject the forward DDL"
    }

    if (-not $ReadOnly) {
        $taskDecision = Read-Host "Type APPLY after reviewing the read-only report"
        if ($taskDecision -ne "APPLY") {
            throw "Forward DDL was not approved by the active audit session"
        }

        $taskApplyReport = Invoke-RestMethod -Method Post -Uri "$taskWorkerUrl/apply" `
            -Headers @{ "X-Audit-Token" = $taskWriteCredential.Token } -TimeoutSec 60
        $taskFinalReport = Invoke-RestMethod -Method Post -Uri "$taskWorkerUrl/read" `
            -Headers @{ "X-Audit-Token" = $taskReadCredential.Token } -TimeoutSec 45

        Write-Output "APPLY_REPORT_BEGIN"
        $taskApplyReport | ConvertTo-Json -Depth 12
        Write-Output "APPLY_REPORT_END"
        Write-Output "FINAL_REPORT_BEGIN"
        $taskFinalReport | ConvertTo-Json -Depth 12
        Write-Output "FINAL_REPORT_END"
    }
} finally {
    if ($taskDeployed) {
        $taskDeleteOutput = & npx.cmd wrangler delete $taskAuditName `
            --config $taskConfigPath --force 2>&1
        $taskDeleted = $LASTEXITCODE -eq 0
        if ($taskDeleted -and $taskWorkerUrl) {
            $taskUrlMissing = (Get-HttpStatus -Method Post -Uri "$taskWorkerUrl/read") -eq 404
        }
    }
    [ordered]@{
        worker_name = $taskAuditName
        authorization = [ordered]@{
            no_token_status = $taskUnauthorizedStatus
            wrong_method_status = $taskWrongMethodStatus
        }
        cleanup = [ordered]@{
            delete_succeeded = $taskDeleted
            url_returns_404 = $taskUrlMissing
        }
    } | ConvertTo-Json -Depth 6
}
