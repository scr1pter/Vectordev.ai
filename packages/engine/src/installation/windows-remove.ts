// PowerShell 5.1 treats smart quotes as delimiters and reads BOM-less scripts as ANSI.
// Decode string data at runtime so generated source stays ASCII regardless of path characters.
const literal = (value: string) =>
  `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}')))`

// PowerShell reads a process's StartTime as $null once it is exiting, or when it cannot be read, so every identity check
// tests for $null before calling a method on it; otherwise the worker fails with "cannot call a method on a null-valued
// expression" instead of the reason it stopped.
export function script(input: {
  pid: number
  startTicks: string
  executable: string
  metadata: string
  lock: string
  statusFile: string
  temporaryDirectory: string
  binarySha256: string
  files: string[]
}) {
  return `$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$status = ${literal(input.statusFile)}
$created = $false
$committed = $false
$lock = $null
try {
  $file = [IO.File]::Open($status, [IO.FileMode]::CreateNew)
  $file.Dispose()
  $created = $true
  [IO.File]::WriteAllText($status, '{"state":"preparing"}', $utf8)
  $parent = Get-Process -Id ${input.pid} -ErrorAction Stop
  if ($null -eq $parent.StartTime -or $parent.StartTime.ToUniversalTime().Ticks.ToString() -ne ${literal(input.startTicks)}) { throw 'Process identity changed' }
  $lock = [IO.File]::Open(${literal(input.lock)}, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  if ((Get-FileHash -LiteralPath ${literal(input.executable)} -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${literal(input.binarySha256)}) { throw 'Executable changed; removal canceled' }
  [IO.File]::WriteAllText($status, '{"state":"prepared"}', $utf8)
  $acknowledgement = "$status.ready"
  $ackDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [IO.File]::Exists($acknowledgement)) {
    $parent = Get-Process -Id ${input.pid} -ErrorAction SilentlyContinue
    if ($null -eq $parent -or $null -eq $parent.StartTime -or $parent.StartTime.ToUniversalTime().Ticks.ToString() -ne ${literal(input.startTicks)} -or [DateTime]::UtcNow -gt $ackDeadline) { throw 'Vector did not acknowledge the prepared removal; installation remains unchanged' }
    Start-Sleep -Milliseconds 50
  }
  if (([IO.File]::GetAttributes($acknowledgement) -band [IO.FileAttributes]::ReparsePoint) -or [IO.File]::ReadAllText($acknowledgement) -cne "ready\`n") { throw 'Invalid prepared-removal acknowledgement' }
  $deadline = [DateTime]::UtcNow.AddMinutes(15)
  while ($null -ne ($parent = Get-Process -Id ${input.pid} -ErrorAction SilentlyContinue)) {
    # Exiting: no start time to compare, so it waits for the process to be gone.
    $started = $parent.StartTime
    if (($null -ne $started -and $started.ToUniversalTime().Ticks.ToString() -ne ${literal(input.startTicks)}) -or [DateTime]::UtcNow -gt $deadline) { throw 'Process identity changed or exit timed out' }
    Start-Sleep -Milliseconds 200
  }
  if (([IO.File]::GetAttributes(${literal(input.metadata)}) -band [IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath ${literal(input.executable)} -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${literal(input.binarySha256)}) { throw 'Installation changed; removal canceled' }
  ${input.files.map((file) => `[IO.File]::Delete(${literal(file)})`).join("\n  ")}
  if ([IO.Directory]::GetFileSystemEntries(${literal(input.metadata)}).Length -eq 0) { [IO.Directory]::Delete(${literal(input.metadata)}) }
  $committed = $true
  try { [IO.File]::WriteAllText($status, '{"state":"complete"}', $utf8) } catch { Write-Warning 'Vector was removed, but its completion status could not be written.' }
} catch {
  if ($created -and -not $committed) { [IO.File]::WriteAllText($status, (@{state='failed';message=$_.Exception.Message} | ConvertTo-Json -Compress), $utf8) }
  Write-Error $_ -ErrorAction Continue
  exit 1
} finally {
  if ($null -ne $lock) { $lock.Dispose(); [IO.File]::Delete(${literal(input.lock)}) }
  if ($created) { Remove-Item -LiteralPath "$status.ready" -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath ${literal(input.temporaryDirectory)} -Recurse -Force -ErrorAction SilentlyContinue
}

`
}

export * as WindowsRemoval from "./windows-remove"
