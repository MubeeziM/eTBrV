# =============================================================================
# deploy.ps1 — One-click deploy for ART Patient Register
#
# Usage:  .\deploy.ps1
#         .\deploy.ps1 -Target pwa      (PWA only)
#         .\deploy.ps1 -Target api      (API only)
# =============================================================================
param(
  [ValidateSet('all','pwa','api')]
  [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'

# ── Credentials (loaded from gitignored secrets file) ─────────────────────────
$secretsFile = Join-Path $PSScriptRoot "deploy-secrets.ps1"
if (-not (Test-Path $secretsFile)) {
  Write-Error "deploy-secrets.ps1 not found. Copy the template and fill in credentials."
  exit 1
}
. $secretsFile

# ── Paths ─────────────────────────────────────────────────────────────────────
$root      = $PSScriptRoot
$pwaLocal  = "$root\pwa-publish"
$apiLocal  = "$root\PatientSyncApi\bin\Release\net8.0\publish"
$msdeploy  = "C:\Program Files\IIS\Microsoft Web Deploy V3\msdeploy.exe"

# ─────────────────────────────────────────────────────────────────────────────
#  DEPLOY PWA  →  art.etbr.org  (Web Deploy)
# ─────────────────────────────────────────────────────────────────────────────
function Deploy-PWA {
  Write-Host "`n── Deploying PWA to art.etbr.org ──"

  # Sync local source → pwa-publish first
  foreach ($f in @('app.js','db.js','index.html','style.css','service-worker.js','manifest.json')) {
    Copy-Item "$root\$f" "$pwaLocal\$f" -Force
  }
  Copy-Item "$root\icons\*" "$pwaLocal\icons\" -Force -Recurse
  # Deploy web.config (controls Cache-Control headers so Cloudflare doesn't over-cache)
  Copy-Item "$root\pwa-web.config" "$pwaLocal\web.config" -Force

  # Stamp build version (vDDMMYYYYHHMM) into pwa-publish/app.js and service-worker.js
  $buildVersion = 'v' + (Get-Date -Format 'ddMMyyyyHHmm')
  (Get-Content "$pwaLocal\app.js") -replace "v__BUILD__", $buildVersion |
    Set-Content "$pwaLocal\app.js"
  (Get-Content "$pwaLocal\service-worker.js") -replace "v__BUILD__", $buildVersion |
    Set-Content "$pwaLocal\service-worker.js"
  Write-Host "  Version: $buildVersion"

  # Web Deploy sync
  $wdUrl  = "https://win8062.site4now.net:8172/msdeploy.axd?site=micahm-001-subsite6"
  $wdSite = "micahm-001-subsite6"
  & $msdeploy `
    -verb:sync `
    "-source:contentPath=$pwaLocal" `
    "-dest:contentPath=$wdSite,computerName=$wdUrl,userName=$wdUser,password=$wdPass,authType=Basic,includeAcls=False" `
    -allowUntrusted `
    -retryAttempts:3 2>&1 | Select-String "^(Total|Error)" | ForEach-Object { Write-Host "  $_" }
  Write-Host "  PWA deployed OK"
}

# ─────────────────────────────────────────────────────────────────────────────
#  DEPLOY API  →  api.etbr.org  (Web Deploy)
# ─────────────────────────────────────────────────────────────────────────────
function Deploy-API {
  Write-Host "`n── Building & deploying API to api.etbr.org ──"

  # Rebuild
  Push-Location "$root\PatientSyncApi"
  dotnet publish -c Release -o bin\Release\net8.0\publish --nologo
  Pop-Location

  # Web Deploy
  $wdUrl  = "https://win8062.site4now.net:8172/msdeploy.axd?site=micahm-001-subsite5"
  $wdSite = "micahm-001-subsite5"
  & $msdeploy `
    -verb:sync `
    "-source:contentPath=$apiLocal" `
    "-dest:contentPath=$wdSite,computerName=$wdUrl,userName=$wdUser,password=$wdPass,authType=Basic,includeAcls=False" `
    -allowUntrusted `
    -enableRule:AppOffline `
    -retryAttempts:3 2>&1 | Select-String "^(Total|Error)" | ForEach-Object { Write-Host "  $_" }
  Write-Host "  API deployed OK"
}

# ─────────────────────────────────────────────────────────────────────────────
#  RUN
# ─────────────────────────────────────────────────────────────────────────────
if ($Target -in 'all','pwa') { Deploy-PWA }
if ($Target -in 'all','api') { Deploy-API }
Write-Host "`nDeploy complete."
