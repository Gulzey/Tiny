param([Parameter(Mandatory=$true)][string]$ReleaseFolder)
$ErrorActionPreference = 'Stop'
$hostFolder = Join-Path $ReleaseFolder 'host'
$hostFiles = @(Get-ChildItem -LiteralPath $hostFolder -File | Select-Object -ExpandProperty FullName)
Compress-Archive -LiteralPath $hostFiles -DestinationPath (Join-Path $ReleaseFolder 'Tiny-Host.zip') -Force
