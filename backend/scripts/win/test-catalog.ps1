param(
  [Parameter(Mandatory = $true)]
  [string]$Url,

  [int]$Limit = 20,

  # 网关根地址，可按需覆盖
  [string]$Gw = "https://yunivera-gateway.onrender.com",

  # 同时展示 /v1/detect 的识别信息
  [switch]$ShowDetect
)

function Invoke-Json {
  param([string]$Uri, [int]$TimeoutSec = 60)
  try {
    $resp = Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSec
    if ($null -ne $resp) { return $resp }
  } catch {
    Write-Host ("{0} ← {1}" -f $Uri, $_.Exception.Message) -ForegroundColor DarkGray
  }
  return $null
}

# ---- 组装两个候选端点，自动回退 ----
$enc = [uri]::EscapeDataString($Url)
$tryEndpoints = @(
  "$Gw/v1/catalog?url=$enc&limit=$Limit",
  "$Gw/v1/api/catalog?url=$enc&limit=$Limit"
)

$result = $null
$hit    = ""

foreach ($ep in $tryEndpoints) {
  $hit = $ep
  $result = Invoke-Json -Uri $ep
  if ($result) { break }
}

# 可选：顺带看一下 /v1/detect 的元信息（不影响主流程）
if ($ShowDetect -or -not $result) {
  $det = Invoke-Json -Uri "$Gw/v1/detect?url=$([uri]::EscapeDataString($Url))"
  if ($det) {
    Write-Host "`n[detect]" -ForegroundColor Cyan
    $det | Format-List
  }
}

if (-not $result) {
  Write-Host "`nBoth endpoints failed." -ForegroundColor Red
  exit 2
}

# ---- 摘要输出 ----
Write-Host "`nendpoint: $hit" -ForegroundColor Cyan
$adapter = $result.adapter
$count   = if ($result.PSObject.Properties.Name -contains 'count') { $result.count } else { ($result.items | Measure-Object).Count }
$urlOut  = if ($result.PSObject.Properties.Name -contains 'url') { $result.url } else { $Url }
$http    = if ($result.PSObject.Properties.Name -contains 'http') { $result.http } else { 200 }
$okFlag  = if ($result.PSObject.Properties.Name -contains 'ok') { $result.ok } else { $true }

Write-Host ("ok: {0}  http: {1}  adapter: {2}  count: {3}  url: {4}" -f $okFlag,$http,($adapter??'-'),$count,$urlOut) -ForegroundColor Green

# 兼容字段：products / items
$items = if ($result.PSObject.Properties.Name -contains 'products') { $result.products } else { $result.items }
if ($items) {
  $items | Select-Object -First 3 title, link, price | Format-Table -AutoSize
}

return $result
