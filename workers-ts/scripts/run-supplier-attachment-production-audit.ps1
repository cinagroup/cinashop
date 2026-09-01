$ErrorActionPreference = "Stop"

$auditName = "cinashop-supplier-attachment-audit-" + [Guid]::NewGuid().ToString("N").Substring(0, 12)
$configPath = "test/integration/supplier-attachment-audit.wrangler.toml"
$tokenBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
$token = [BitConverter]::ToString($tokenBytes).Replace("-", "").ToLowerInvariant()
$hashBytes = [System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($token))
$tokenHash = [BitConverter]::ToString($hashBytes).Replace("-", "").ToLowerInvariant()
$deployed = $false
$deleted = $false
$urlMissing = $false
$report = $null
$workerUrl = ""

try {
    $deployOutput = & npx.cmd wrangler deploy --config $configPath --name $auditName --var "AUDIT_TOKEN_SHA256:$tokenHash" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Temporary audit Worker deployment failed"
    }
    $deployed = $true
    $deploymentText = $deployOutput -join "`n"
    $urlMatch = [regex]::Match($deploymentText, "https://[A-Za-z0-9.-]+\.workers\.dev")
    if (-not $urlMatch.Success) {
        throw "Temporary audit Worker URL was not reported"
    }
    $workerUrl = $urlMatch.Value
    $lastError = $null
    for ($attempt = 1; $attempt -le 5; $attempt += 1) {
        try {
            $report = Invoke-RestMethod -Method Get -Uri "$workerUrl/supplier-attachments" -Headers @{ "X-Audit-Token" = $token } -TimeoutSec 30
            $lastError = $null
            break
        } catch {
            $lastError = $_
            if ($attempt -lt 5) { Start-Sleep -Seconds 2 }
        }
    }
    if ($null -ne $lastError) { throw $lastError }
} finally {
    if ($deployed) {
        $deleteOutput = & npx.cmd wrangler delete $auditName --config $configPath --force 2>&1
        $deleted = $LASTEXITCODE -eq 0
        if ($deleted -and $workerUrl) {
            try {
                $null = Invoke-WebRequest -Method Get -Uri "$workerUrl/supplier-attachments" -TimeoutSec 20
            } catch {
                $status = [int]$_.Exception.Response.StatusCode
                $urlMissing = $status -eq 404
            }
        }
    }
}

[ordered]@{
    worker_name = $auditName
    report = $report
    cleanup = [ordered]@{
        delete_succeeded = $deleted
        url_returns_404 = $urlMissing
    }
} | ConvertTo-Json -Depth 10
