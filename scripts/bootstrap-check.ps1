$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT

$TMP = Join-Path $env:TEMP "yoyo-bootstrap"
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

Write-Host "[1/4] Generate yoyo.ty (first)"
RunNode @("src/yoyo-gen.js")
Copy-Item projects/yoyo.ty (Join-Path $TMP "yoyo-1.ty")

Write-Host "[2/4] Generate yoyo.ty (second)"
RunNode @("src/yoyo-gen.js")
Copy-Item projects/yoyo.ty (Join-Path $TMP "yoyo-2.ty")

Write-Host "[3/4] Compile same source twice"
RunNode @("src/yoyo.js", "projects/yoyo.ty", (Join-Path $TMP "yoyo-a.exe"))
RunNode @("src/yoyo.js", "projects/yoyo.ty", (Join-Path $TMP "yoyo-b.exe"))

Write-Host "[4/4] Determinism check"
$SRC_CMP = (Get-FileHash (Join-Path $TMP "yoyo-1.ty") -Algorithm SHA256).Hash -eq `
           (Get-FileHash (Join-Path $TMP "yoyo-2.ty") -Algorithm SHA256).Hash
$EXE_CMP = (Get-FileHash (Join-Path $TMP "yoyo-a.exe") -Algorithm SHA256).Hash -eq `
           (Get-FileHash (Join-Path $TMP "yoyo-b.exe") -Algorithm SHA256).Hash

$SRC_SHA_1 = (Get-FileHash (Join-Path $TMP "yoyo-1.ty") -Algorithm SHA256).Hash
$SRC_SHA_2 = (Get-FileHash (Join-Path $TMP "yoyo-2.ty") -Algorithm SHA256).Hash
$EXE_SHA_A = (Get-FileHash (Join-Path $TMP "yoyo-a.exe") -Algorithm SHA256).Hash
$EXE_SHA_B = (Get-FileHash (Join-Path $TMP "yoyo-b.exe") -Algorithm SHA256).Hash

Write-Host ""
Write-Host "=== bootstrap-check report ==="
Write-Host "yoyo.ty #1 sha256: $SRC_SHA_1"
Write-Host "yoyo.ty #2 sha256: $SRC_SHA_2"
Write-Host "yoyo.ty deterministic: $(if ($SRC_CMP) {'PASS'} else {'FAIL'})"
Write-Host ""
Write-Host "yoyo-a.exe sha256: $EXE_SHA_A"
Write-Host "yoyo-b.exe sha256: $EXE_SHA_B"
Write-Host "product deterministic: $(if ($EXE_CMP) {'PASS'} else {'FAIL'})"

$REPORT_FILE = Join-Path $ROOT "bootstrap-report.txt"
$DIFF_FILE = Join-Path $ROOT "bootstrap-report-diff.txt"
$BASELINE_FILE = Join-Path $ROOT "bootstrap-baseline.txt"

$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
@"
timestamp: $timestamp
yoyo.ty.sha256: $SRC_SHA_1
yoyo.exe.sha256: $EXE_SHA_A
yoyo.ty.cmp: $(if ($SRC_CMP) {'0'} else {'1'})
yoyo.exe.cmp: $(if ($EXE_CMP) {'0'} else {'1'})
"@ | Set-Content $REPORT_FILE -NoNewline

$keys = @("yoyo.ty.sha256","yoyo.exe.sha256","yoyo.ty.cmp","yoyo.exe.cmp")
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
        "yoyo.ty.sha256: $SRC_SHA_1"
        "yoyo.exe.sha256: $EXE_SHA_A"
        "yoyo.ty.cmp: $(if ($SRC_CMP) {'0'} else {'1'})"
        "yoyo.exe.cmp: $(if ($EXE_CMP) {'0'} else {'1'})"
    ) | Set-Content $BASELINE_FILE
    Write-Host "baseline updated: $BASELINE_FILE"
}

if (-not $SRC_CMP -or -not $EXE_CMP) {
    Write-Host ""
    Write-Host "bootstrap-check: FAIL"
    exit 1
}

Write-Host ""
Write-Host "bootstrap-check: PASS"
