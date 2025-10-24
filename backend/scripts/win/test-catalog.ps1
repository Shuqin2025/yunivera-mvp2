param(
  [Parameter(Mandatory=$true)][string]$Url,
  [int]$Limit = 20,
  [string]$Gw = "https://yunivera-gateway.onrender.com",
  [switch]$Debug
)

# 组装 Query
$qs = "url=$([uri]::EscapeDataString($Url))&limit=$Limit" + ($(if($Debug){ "&debug=1"}) )

$u1 = "$Gw/v1/api/catalog?$qs"
$u2 = "$Gw/v1/catalog?$qs"

function Hit([string]$u) {
  try {
    return Invoke-RestMethod -Method Get -Uri $u -TimeoutSec 60
  } catch {
    return $null
  }
}

Write-Host "GET $u1"
$r = Hit $u1
if (-not $r) {
  Write-Host "fallback => $u2"
  $r = Hit $u2
}

if (-not $r) {
  Write-Error "请求失败（/v1/api/catalog 与 /v1/catalog 均不可用）"
  exit 1
}

# 汇总输出
$j = [pscustomobject]@{
  ok     = $r.ok
  url    = $r.url
  http   = ($r.http, $r.debug.http_status | ? {$_})[0]
  items  = @($r.items, $r.products | ? {$_})[0]
}
$cnt   = ($j.items | Measure-Object).Count
$first = ($j.items | Select-Object -First 3 | ForEach-Object { $_.title })

Write-Host ""
Write-Host ("ok       : {0}" -f $j.ok)
Write-Host ("http     : {0}" -f $j.http)
Write-Host ("items    : {0}" -f $cnt)
Write-Host ("first3   : {0}" -f ($first -join " | "))

if ($Debug) {
  "`n== raw debug =="
  $r.debug | Format-List | Out-String
}
