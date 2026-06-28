$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT

$TMP = Join-Path $env:TEMP "mini-kyc-bootstrap"
if (-not (Test-Path $TMP)) { New-Item -ItemType Directory -Path $TMP | Out-Null }
Get-ChildItem $TMP -File | Remove-Item -Force

function RunNode {
    param([string[]]$cmdArgs)
    $errFile = Join-Path $PSScriptRoot "node-err.txt"
    & node @cmdArgs 1>$null 2>$errFile
    $ec = $LASTEXITCODE
    if ($ec -ne 0) {
        $err = Get-Content $errFile -Raw
        Write-Host "Node stderr: $err"
        throw "node $($cmdArgs -join ' ') exited with $ec"
    }
}

Write-Host "[1/4] Generate mini-kyc.ky (first)"
RunNode @("create-mini-kyc3.js")
Copy-Item projects/mini-kyc.ky (Join-Path $TMP "mini-kyc-1.ky")

Write-Host "[2/4] Generate mini-kyc.ky (second)"
RunNode @("create-mini-kyc3.js")
Copy-Item projects/mini-kyc.ky (Join-Path $TMP "mini-kyc-2.ky")

Write-Host "[3/4] Compile same source twice"
RunNode @("ky-compiler.js", "projects/mini-kyc.ky", (Join-Path $TMP "mini-kyc-a.exe"))
RunNode @("ky-compiler.js", "projects/mini-kyc.ky", (Join-Path $TMP "mini-kyc-b.exe"))

Write-Host "[4/4] Determinism check"
$KY_CMP = (Get-FileHash (Join-Path $TMP "mini-kyc-1.ky") -Algorithm SHA256).Hash -eq `
          (Get-FileHash (Join-Path $TMP "mini-kyc-2.ky") -Algorithm SHA256).Hash
$EXE_CMP = (Get-FileHash (Join-Path $TMP "mini-kyc-a.exe") -Algorithm SHA256).Hash -eq `
           (Get-FileHash (Join-Path $TMP "mini-kyc-b.exe") -Algorithm SHA256).Hash

$KY_SHA_1 = (Get-FileHash (Join-Path $TMP "mini-kyc-1.ky") -Algorithm SHA256).Hash
$KY_SHA_2 = (Get-FileHash (Join-Path $TMP "mini-kyc-2.ky") -Algorithm SHA256).Hash
$EXE_SHA_A = (Get-FileHash (Join-Path $TMP "mini-kyc-a.exe") -Algorithm SHA256).Hash
$EXE_SHA_B = (Get-FileHash (Join-Path $TMP "mini-kyc-b.exe") -Algorithm SHA256).Hash

Write-Host ""
Write-Host "=== bootstrap-check report ==="
Write-Host "mini-kyc.ky #1 sha256: $KY_SHA_1"
Write-Host "mini-kyc.ky #2 sha256: $KY_SHA_2"
Write-Host "mini-kyc.ky deterministic: $(if ($KY_CMP) {'PASS'} else {'FAIL'})"
Write-Host ""
Write-Host "mini-kyc-a.exe sha256: $EXE_SHA_A"
Write-Host "mini-kyc-b.exe sha256: $EXE_SHA_B"
Write-Host "product deterministic: $(if ($EXE_CMP) {'PASS'} else {'FAIL'})"

$REPORT_FILE = Join-Path $ROOT "bootstrap-report.txt"
$DIFF_FILE = Join-Path $ROOT "bootstrap-report-diff.txt"
$BASELINE_FILE = Join-Path $ROOT "bootstrap-baseline.txt"

$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
@"
timestamp: $timestamp
mini-kyc.ky.sha256: $KY_SHA_1
mini-kyc.exe.sha256: $EXE_SHA_A
mini-kyc.ky.cmp: $(if ($KY_CMP) {'0'} else {'1'})
mini-kyc.exe.cmp: $(if ($EXE_CMP) {'0'} else {'1'})
"@ | Set-Content $REPORT_FILE -NoNewline

$keys = @("mini-kyc.ky.sha256","mini-kyc.exe.sha256","mini-kyc.ky.cmp","mini-kyc.exe.cmp")
$diff = @()
$diff += "=== bootstrap-report diff ==="
$diff += "generated_at: $timestamp"
$changed = $false
if (-not (Test-Path $BASELINE_FILE)) {
    $diff += "baseline: missing"
    $diff += "status: no-baseline"
} else {
    $diff += "baseline: $BASELINE_FILE"
    foreach ($key in $keys) {
        $prevLine = (Select-String "^${key}: " $BASELINE_FILE | Select-Object -First 1 -ExpandProperty Line)
        $currLine = (Select-String "^${key}: " $REPORT_FILE | Select-Object -First 1 -ExpandProperty Line)
        $prev = if ($prevLine) { ($prevLine -replace "^${key}: ", "").Trim() } else { "" }
        $curr = if ($currLine) { ($currLine -replace "^${key}: ", "").Trim() } else { "" }
        if ($prev -eq $curr) {
            $diff += "${key}: same"
        } else {
            $changed = $true
            $diff += "${key}: changed"
            $diff += "  prev: $prev"
            $diff += "  curr: $curr"
        }
    }
    if ($changed) {
        $diff += "status: changed"
    } else {
        $diff += "status: identical-to-baseline"
    }
}
$diff | Set-Content $DIFF_FILE

Write-Host ""
Write-Host "strict report written: $REPORT_FILE"
Write-Host "strict diff written: $DIFF_FILE"

# --lock mode
$LOCK_MODE = $args -contains "--lock"
$UPDATE_BASELINE = $args -contains "--update-baseline"

if ($LOCK_MODE) {
    if (-not (Test-Path $BASELINE_FILE)) {
        Write-Host "lock mode FAIL: baseline $BASELINE_FILE not found"
        exit 3
    }
    if ($changed) {
        Write-Host "lock mode FAIL: drift from baseline"
        exit 4
    }
    Write-Host "lock mode: PASS (matches baseline)"
}

if ($UPDATE_BASELINE) {
    @(
        "mini-kyc.ky.sha256: $KY_SHA_1"
        "mini-kyc.exe.sha256: $EXE_SHA_A"
        "mini-kyc.ky.cmp: $(if ($KY_CMP) {'0'} else {'1'})"
        "mini-kyc.exe.cmp: $(if ($EXE_CMP) {'0'} else {'1'})"
    ) | Set-Content $BASELINE_FILE
    Write-Host "baseline updated: $BASELINE_FILE"
}

if (-not $KY_CMP -or -not $EXE_CMP) {
    Write-Host ""
    Write-Host "bootstrap-check: FAIL"
    exit 1
}

Write-Host ""
Write-Host "bootstrap-check: PASS"
