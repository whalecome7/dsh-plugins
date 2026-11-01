$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$base = 'http://127.0.0.1:3082'
$token = '5zNGI4UF8az54hKTdyw3NgRh3OcSqsFDcpUhJ5NnK2g'
$jar = Join-Path $env:TEMP 'dsh-qoder-e2e.txt'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$repo = 'D:/code/dsh-plugins/.poc-sdk/fake-repo'

Remove-Item $jar -Force -ErrorAction SilentlyContinue
& curl.exe -s -c $jar "$base/?token=$token" --output NUL

function PostJson($path, $obj) {
  $file = Join-Path $env:TEMP 'dsh-qoder-body.json'
  [System.IO.File]::WriteAllText($file, ($obj | ConvertTo-Json -Compress), $utf8)
  return & curl.exe -s -b $jar -X POST "$base$path" -H 'content-type: application/json; charset=utf-8' --data-binary "@$file"
}

Write-Output '=== 1) state (expect isRepo=true, clean=false) ==='
(Invoke-WebRequest -Uri "$base/api/qoder.state" -WebSession (New-Object Microsoft.PowerShell.Commands.WebRequestSession) -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue).StatusCode
& curl.exe -s -b $jar "$base/api/qoder.state"

Write-Output ''
Write-Output '=== 2) create session ==='
$created = PostJson '/api/qoder.session' @{}
Write-Output $created
$sid = ($created | ConvertFrom-Json).session.id

Write-Output ''
Write-Output '=== 3) send WITHOUT force (expect needsConfirm) ==='
$r3 = PostJson '/api/qoder.send' @{ sessionId = $sid; prompt = 'Create a file named panel-test.txt containing exactly: hello from qoder panel' }
Write-Output $r3

Write-Output ''
Write-Output '=== 4) send WITH force ==='
$r4 = PostJson '/api/qoder.send' @{ sessionId = $sid; prompt = 'Create a file named panel-test.txt containing exactly: hello from qoder panel'; force = $true }
Write-Output $r4

Write-Output ''
Write-Output '=== 5) stream window A (35s) ==='
$streamA = & curl.exe -s -N --max-time 35 -b $jar "$base/api/qoder.stream?sessionId=$sid&from=0"
$streamA

$lastSeq = 0
foreach ($line in $streamA) {
  if ($line -match '^data: (.*)$') {
    try { $ev = $Matches[1] | ConvertFrom-Json; if ($ev.seq -gt $lastSeq) { $lastSeq = $ev.seq } } catch {}
  }
}
Write-Output "lastSeq = $lastSeq"

$approvalId = $null
foreach ($line in $streamA) {
  if ($line -match '^data: (.*)$') {
    try { $ev = $Matches[1] | ConvertFrom-Json; if ($ev.type -eq 'approval_request') { $approvalId = $ev.approvalId } } catch {}
  }
}
Write-Output "approvalId = $approvalId"

if ($approvalId) {
  Write-Output ''
  Write-Output '=== 6) approve ==='
  $r6 = PostJson '/api/qoder.approve' @{ sessionId = $sid; approvalId = $approvalId; behavior = 'allow' }
  Write-Output $r6

  Write-Output ''
  Write-Output '=== 7) stream window B (45s) ==='
  & curl.exe -s -N --max-time 45 -b $jar "$base/api/qoder.stream?sessionId=$sid&from=$lastSeq"
}

Write-Output ''
Write-Output '=== 8) file created? ==='
if (Test-Path (Join-Path $repo 'panel-test.txt')) {
  Write-Output 'YES'
  Get-Content (Join-Path $repo 'panel-test.txt')
} else {
  Write-Output 'NO'
}

Write-Output ''
Write-Output '=== 9) diff endpoint ==='
& curl.exe -s -b $jar "$base/api/qoder.diff?sessionId=$sid" | Select-Object -First 1

Write-Output ''
Write-Output '=== 10) summary files on disk ==='
Get-ChildItem (Join-Path $repo '.dsh/qoder/summaries') -ErrorAction SilentlyContinue | Select-Object Name, Length

Write-Output '=== DONE ==='
