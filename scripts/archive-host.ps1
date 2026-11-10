param([Parameter(Mandatory=$true)][string]$ReleaseFolder)
$ErrorActionPreference = 'Stop'
$hostFolder = Join-Path $ReleaseFolder 'host'
$hostFileNames = @('Tiny-Server.exe', 'THIRD-PARTY-NOTICES.txt', 'tiny-server.env.example', 'HOSTING.md')
$hostFiles = @($hostFileNames | ForEach-Object {
  $candidate = Join-Path $hostFolder $_
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Missing host release file: $_" }
  $candidate
})
Compress-Archive -LiteralPath $hostFiles -DestinationPath (Join-Path $ReleaseFolder 'Tiny-Host.zip') -Force
