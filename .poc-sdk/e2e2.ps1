$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$base = 'http://127.0.0.1:3082'
$token = '5zNGI4UF8az54hKTdyw3NgRh3OcSqsFDcpUhJ5NnK2g'
$jar = Join-Path $env:TEMP 'dsh-qoder-e2e2.txt'
$utf8 = New-Object System.Text.UTF8Encoding($false)

Remove-Item $jar -Force -ErrorAction SilentlyContinue
& curl.exe -s -c $jar "$base/?token=$token" --output NUL

function PostJson($path, $obj) {
  $file = Join-Path $env:TEMP 'dsh-qoder-body2.json'
  [System.IO.File]::WriteAllText($file, ($obj | ConvertTo-Json -Compress), $utf8)
  return & curl.exe -s -b $jar -X POST "$base$path" -H 'content-type: application/json; charset=utf-8' --data-binary "@$file"
}

function StreamWindow($sid, $from, $seconds) {
  return & curl.exe -s -N --max-time $seconds -b $jar "$base/api/qoder.stream?sessionId=$sid&from=$from"
}

function MaxSeq($lines) {
  $max = 0
  foreach ($line in $lines) {
    if ($line -match '^data: (.*)$') {
      try { $ev = $Matches[1] | ConvertFrom-Json; if ($ev.seq -gt $max) { $max = $ev.seq } } catch {}
    }
  }
  return $max
}

function TextOf($lines) {
  $texts = @()
  foreach ($line in $lines) {
    if ($line -match '^data: (.*)$') {
      try { $ev = $Matches[1] | ConvertFrom-Json; if ($ev.type -eq 'assistant_text') { $texts += $ev.text } } catch {}
    }
  }
  return ($texts -join ' | ')
}

$created = PostJson '/api/qoder.session' @{ title = 'multi-turn' }
$sid = ($created | ConvertFrom-Json).session.id
Write-Output "session = $sid"

Write-Output ''
Write-Output '=== turn 1: remember code word ==='
$r1 = PostJson '/api/qoder.send' @{ sessionId = $sid; prompt = 'Remember this code word: VIOLET-7734. Reply with exactly: noted'; force = $true }
Write-Output $r1
$stream1 = StreamWindow $sid 0 50
$seq1 = MaxSeq $stream1
$turnEnds1 = ($stream1 | Select-String 'turn_end').Count
Write-Output "turn_end count = $turnEnds1 | lastSeq = $seq1"
Write-Output ("reply: " + (TextOf $stream1))

Write-Output ''
Write-Output '=== turn 2: recall (same session, no resume) ==='
$r2 = PostJson '/api/qoder.send' @{ sessionId = $sid; prompt = 'What was the code word? Reply with the word only.'; force = $true }
Write-Output $r2
$stream2 = StreamWindow $sid $seq1 50
$seq2 = MaxSeq $stream2
$turnEnds2 = ($stream2 | Select-String 'turn_end').Count
Write-Output "turn_end count = $turnEnds2 | lastSeq = $seq2"
$reply2 = TextOf $stream2
Write-Output ("reply: " + $reply2)
if ($reply2 -match 'VIOLET|7734') { Write-Output 'CONTEXT KEPT: YES' } else { Write-Output 'CONTEXT KEPT: NO' }

Write-Output ''
Write-Output '=== turn 3: long task then abort ==='
$r3 = PostJson '/api/qoder.send' @{ sessionId = $sid; prompt = 'Count slowly from 1 to 200, one number per line, no other text.'; force = $true }
Write-Output $r3
Start-Sleep -Seconds 8
$abort = PostJson '/api/qoder.abort' @{ sessionId = $sid }
Write-Output ("abort -> " + $abort)
$stream3 = StreamWindow $sid $seq2 25
Write-Output ("status events: " + (($stream3 | Select-String 'status').Count))
$stream3 | Select-String 'status|error|turn_end' | Select-Object -First 6

Write-Output ''
Write-Output '=== final state ==='
& curl.exe -s -b $jar "$base/api/qoder.state" | Select-Object -First 1
Write-Output '=== DONE ==='
