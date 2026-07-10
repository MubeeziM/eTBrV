# =============================================================================
# deploy.ps1 — One-click deploy for ART Patient Register
#
# Usage:  .\deploy.ps1
#         .\deploy.ps1 -Target pwa      (PWA only)
#         .\deploy.ps1 -Target api      (API only)
#
# ── API DEPLOYMENT — REQUIRED STEPS TO AVOID ERROR_FILE_IN_USE ─────────────
#
#  PatientSyncApi.exe runs as a child process outside w3wp.exe (outofprocess
#  hosting).  Windows locks the EXE while it is running, so msdeploy cannot
#  overwrite it while the app is alive. 
#
#  CORRECT PROCEDURE EVERY TIME:
#    1. Open SmarterASP.NET control panel → Hosting → IIS Manager
#    2. Application Pools → find the API pool → click STOP  (NOT Recycle)
#    3. Wait ~30 seconds for PatientSyncApi.exe to terminate
#    4. Run:  .\deploy.ps1 -Target api
#    5. When deploy succeeds, click START on the same app pool
#       (or leave it — IIS will auto-start it on the first request)
#
#  If you get ERROR_INSUFFICIENT_ACCESS_TO_SITE_FOLDER:
#    • The app pool was stopped AND the deploy user lost access.
#    • Start the pool first, wait 10 s, then Stop it again and redeploy.
#
#  Architecture:  PatientSyncApi.exe is win-x64 (64-bit).
#                 The IIS app pool does NOT need to be 64-bit — w3wp.exe only
#                 proxies HTTP; our EXE runs independently.
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
#  PURGE CLOUDFLARE  —  clears CDN cache for the PWA shell files
#  Called automatically after every PWA deploy.
# ─────────────────────────────────────────────────────────────────────────────
function Invoke-CloudflarePurge {
  if ([string]::IsNullOrWhiteSpace($cfZoneId) -or $cfZoneId -eq 'YOUR_CLOUDFLARE_ZONE_ID') {
    Write-Host "  [skip] Cloudflare credentials not set in deploy-secrets.ps1"
    return
  }

  $files = @(
    'https://art.etbr.org/app.js',
    'https://art.etbr.org/db.js',
    'https://art.etbr.org/service-worker.js',
    'https://art.etbr.org/index.html',
    'https://art.etbr.org/style.css',
    'https://art.etbr.org/manifest.json'
  )

  $body    = @{ files = $files } | ConvertTo-Json
  $headers = @{
    'Authorization' = "Bearer $cfApiToken"
    'Content-Type'  = 'application/json'
  }

  try {
    $resp = Invoke-RestMethod `
      -Uri     "https://api.cloudflare.com/client/v4/zones/$cfZoneId/purge_cache" `
      -Method  Delete `
      -Headers $headers `
      -Body    $body

    if ($resp.success) {
      Write-Host "  Cloudflare cache purged OK"
    } else {
      Write-Host "  Cloudflare purge returned errors: $($resp.errors | ConvertTo-Json -Compress)"
    }
  } catch {
    Write-Host "  Cloudflare purge failed: $_"
  }
}

# ─────────────────────────────────────────────────────────────────────────────
#  DEPLOY PWA  →  art.etbr.org  (Web Deploy)
# ─────────────────────────────────────────────────────────────────────────────
function Deploy-PWA {
  Write-Host "`n── Deploying PWA to art.etbr.org ──"

  # Ensure staging folder exists (created on first run or after a clean)
  New-Item -ItemType Directory -Force -Path "$pwaLocal\icons" | Out-Null

  # Sync local source → pwa-publish first
  foreach ($f in @('app.js','db.js','index.html','style.css','service-worker.js','manifest.json')) {
    Copy-Item "$root\$f" "$pwaLocal\$f" -Force
  }
  Copy-Item "$root\icons\*" "$pwaLocal\icons\" -Force -Recurse
  # Copy Excel report templates for offline PWA generation
  New-Item -ItemType Directory -Force -Path "$pwaLocal\templates" | Out-Null
  Copy-Item "$root\PatientSyncApi\Templates\Template_DSTB_NTP_Report.xlsx" "$pwaLocal\templates\Template_DSTB_NTP_Report.xlsx" -Force
  Copy-Item "$root\PatientSyncApi\Templates\Template_LFA_Verification_Report.xlsx" "$pwaLocal\templates\Template_LFA_Verification_Report.xlsx" -Force
  Copy-Item "$root\PatientSyncApi\Templates\ART_Monthly_Report_Form_Rev.xlsx" "$pwaLocal\templates\ART_Monthly_Report_Form_Rev.xlsx" -Force
  Copy-Item "$root\PatientSyncApi\Templates\Template_ExportedData.xlsx" "$pwaLocal\templates\Template_ExportedData.xlsx" -Force
  # Deploy web.config (controls Cache-Control headers so Cloudflare doesn't over-cache)
  Copy-Item "$root\pwa-web.config" "$pwaLocal\web.config" -Force

  # Stamp build version (vDDMMYYYYHHMM) into pwa-publish/app.js and service-worker.js
  $buildVersion = 'v' + (Get-Date -Format 'ddMMyyyyHHmm')
  (Get-Content "$pwaLocal\app.js" -Encoding UTF8) -replace "v__BUILD__", $buildVersion |
    Set-Content "$pwaLocal\app.js" -Encoding UTF8
  (Get-Content "$pwaLocal\service-worker.js" -Encoding UTF8) -replace "v__BUILD__", $buildVersion |
    Set-Content "$pwaLocal\service-worker.js" -Encoding UTF8
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

  # Purge Cloudflare CDN cache so browsers immediately receive the new version.
  Invoke-CloudflarePurge
}

# ─────────────────────────────────────────────────────────────────────────────
#  DEPLOY API  →  api.etbr.org  (Web Deploy)
# ─────────────────────────────────────────────────────────────────────────────
function Deploy-API {
  Write-Host "`n── Building & deploying API to api.etbr.org ──"

  # Clean + rebuild — wipe bin and obj entirely so every source change is
  # guaranteed to make it into the deployed binary. Removing only the publish
  # subfolder (or relying on `dotnet clean` alone) can leave incremental obj
  # artefacts that cause dotnet to skip recompilation and silently deploy a
  # stale DLL.
  Remove-Item -Recurse -Force "$root\PatientSyncApi\bin" -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force "$root\PatientSyncApi\obj" -ErrorAction SilentlyContinue
  Push-Location "$root\PatientSyncApi"
  dotnet publish -c Release -r win-x64 --self-contained true -o bin\Release\net8.0\publish --nologo
  Pop-Location

  # Overwrite the auto-generated web.config.
  # Self-contained OUTOFPROCESS: IIS starts PatientSyncApi.exe as a child process
  # and proxies requests to it. This avoids the DLL file-lock issue that inprocess
  # causes on SmarterASP.NET (inprocess embeds the DLL in w3wp.exe and prevents
  # msdeploy from overwriting it during subsequent deployments).
  # The original 524-timeout was caused by a 32-bit DLL (32BITREQ flag set) being
  # loaded by a 64-bit self-contained host — not by the outofprocess model itself.
  # With a correct AnyCPU DLL (PlatformTarget=AnyCPU in csproj), outofprocess works.
  # Stdout logging is enabled so startup exceptions appear in .\logs\stdout_*.log.
  # Stamp a build version into the web.config comment so the file hash always
  # changes, which guarantees msdeploy deploys it, which triggers ANCM to
  # restart PatientSyncApi.exe and pick up the new DLL.
  $buildVersion = 'v' + (Get-Date -Format 'ddMMyyyyHHmm')
  @"
<?xml version="1.0" encoding="utf-8"?>
<!-- build: $buildVersion -->
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath=".\PatientSyncApi.exe" stdoutLogEnabled="true" stdoutLogFile=".\logs\stdout" hostingModel="outofprocess" />
      <httpErrors existingResponse="PassThrough" />
    </system.webServer>
  </location>
</configuration>
"@ | Set-Content "$root\PatientSyncApi\bin\Release\net8.0\publish\web.config" -Encoding UTF8

  # Ensure the logs folder exists in the publish output so IIS can write stdout.
  $logsDir = "$root\PatientSyncApi\bin\Release\net8.0\publish\logs"
  if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

  $wdUrl  = "https://win8062.site4now.net:8172/msdeploy.axd?site=micahm-001-subsite5"
  $wdSite = "micahm-001-subsite5"

  & $msdeploy `
    -verb:sync `
    "-source:contentPath=$apiLocal" `
    "-dest:contentPath=$wdSite,computerName=$wdUrl,userName=$wdUser,password=$wdPass,authType=Basic,includeAcls=False" `
    -allowUntrusted `
    "-skip:objectName=dirPath,absolutePath=logs" `
    "-skip:objectName=filePath,absolutePath=PatientSyncApiDD.exe" `
    -retryAttempts:3 2>&1 | Select-String "^(Total|Error)" | ForEach-Object { Write-Host "  $_" }
  Write-Host "  API deployed OK"
  Write-Host "  *** Start the app pool in SmarterASP.NET if it is stopped ***"
}

# ─────────────────────────────────────────────────────────────────────────────
#  RUN
# ─────────────────────────────────────────────────────────────────────────────
if ($Target -in 'all','pwa') { Deploy-PWA }
if ($Target -in 'all','api') { Deploy-API }
Write-Host "`nDeploy complete."
