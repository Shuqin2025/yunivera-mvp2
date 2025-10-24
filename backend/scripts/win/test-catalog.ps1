Param(
  [Parameter(Mandatory = $true)]
  [string]$Url,
  [int]$Limit = 20,
  [string]$Gateway = "https://yunivera-gateway.onrender.com",
  [switch]$ShowFirst3,
  [switch]$Debug
)

function Invoke-Catalog {
  param([string]$Endpoint, [string]$Url, [int]$Limit)
  try {
    $resp = curl.exe -sG "$Endpoint" --data-urlencode "url=$Url" --data-urlencode "limit=$Limit"
    if (-not $resp) { return @{ ok=$false; http=0; raw="" } }
    try {
      $j = $resp | ConvertFrom-Json
      return @{
        ok = $true
        http = 200
        json = $j
        items = @($j.items).Count
        first3 = ($j.items | Select -First 3 | % title)
      }
    } catch {
      return @{ ok=$false; http=0; raw=$resp }
    }
  } catch {
    return @{ ok=$false; http=0; error=$_.Exception.Message }
  }
}

$api  = "$Gateway/v1/api/catalog"
$alt  = "$Gateway/v1/catalog"

Write-Host ""
Write-Host "== Detect & Smoke ==" -ForegroundColor Cyan
try {
  $r = curl.exe -s "$Gateway/v1/detect?url=$( [uri]::EscapeDataString($Url) )" | ConvertFrom-Json
  $kind = $r.kind
  $http = $r.http
  $ms   = $r.duration_ms
  "{0,-6}:{1}" -f "ok",$r.ok
  "{0,-6}:{1}" -f "url",$Url
  "{0,-6}:{1}" -f "http",$http
  "{0,-6}:{1}" -f "kind",$kind
  "{0,-6}:{1}" -f "duration",$ms
} catch { "{0,-6}:{1}" -f "ok","-" }

Write-Host ""
Write-Host "== /v1/api/catalog ==" -ForegroundColor Cyan
$a = Invoke-Catalog -Endpoint $api -Url $Url -Limit $Limit
if ($a.ok -and $a.json.ok) {
  "{0,-6}:{1}" -f "ok",$a.json.ok
  "{0,-6}:{1}" -f "http",$a.http
  "{0,-6}:{1}" -f "items",($a.items)
  if ($ShowFirst3) {
    "{0,-6}:{1}" -f "first3",(($a.first3 -join " | "))
  }
  exit 0
} else {
  "{0,-6}:{1}" -f "ok", "false"
  "{0,-6}:{1}" -f "note","fallback to /v1/catalog"
  if ($Debug) { "{0,-6}:{1}" -f "raw", ($a.raw | Out-String) }
}

Write-Host ""
Write-Host "== /v1/catalog (fallback) ==" -ForegroundColor Yellow
$b = Invoke-Catalog -Endpoint $alt -Url $Url -Limit $Limit
if ($b.ok -and $b.json.ok) {
  "{0,-6}:{1}" -f "ok",$b.json.ok
  "{0,-6}:{1}" -f "http",$b.http
  "{0,-6}:{1}" -f "items",($b.items)
  if ($ShowFirst3) {
    "{0,-6}:{1}" -f "first3",(($b.first3 -join " | "))
  }
} else {
  "{0,-6}:{1}" -f "ok","false"
  if ($Debug) { "{0,-6}:{1}" -f "raw", ($b.raw | Out-String) }
}
