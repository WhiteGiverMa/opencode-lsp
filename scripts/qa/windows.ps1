param([Parameter(Mandatory=$true)][string]$SourceRoot)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $env:TEMP -PathType Container)) { throw 'Temporary directory is unavailable' }
$Root = Join-Path $env:TEMP ('opencode-lsp-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Root | Out-Null
$Archive = Join-Path $SourceRoot 'opencode-lsp-0.1.0.tgz'
tar -xzf $Archive -C $Root
if ($LASTEXITCODE -ne 0) { throw 'Package extraction failed' }
$Entry = Join-Path $Root 'package\bin\opencode-lsp.js'
$Driver = Join-Path $SourceRoot 'scripts\qa\node-smoke.mjs'
$Receipt = Join-Path $SourceRoot '.omo\evidence\20261002-feature09\windows-node.json'
node $Driver $Entry $Receipt
if ($LASTEXITCODE -ne 0) { throw 'Windows packed Node smoke failed' }
