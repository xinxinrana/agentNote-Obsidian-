param(
  [string]$VaultPath
)

if ([string]::IsNullOrWhiteSpace($VaultPath)) {
  $VaultPath = Join-Path $env:USERPROFILE ("Documents\" + [char]0x6D4B + [char]0x8BD5)
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$pluginPath = Join-Path $VaultPath ".obsidian\plugins\agentnote"
$artifacts = @("main.js", "manifest.json", "styles.css")

foreach ($artifact in $artifacts) {
  $source = Join-Path $projectRoot $artifact
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "未找到构建产物：$source"
  }
}

New-Item -ItemType Directory -Path $pluginPath -Force | Out-Null
foreach ($artifact in $artifacts) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $artifact) -Destination (Join-Path $pluginPath $artifact) -Force
}

Write-Host "agentNote installed to: $pluginPath"
