param(
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$Limit = 20,
  [string]$Gateway = "https://yunivera-gateway.onrender.com",
  [switch]$Debug
)

function Invoke-Catalog([string]$ep) {
  $enc = [uri]::EscapeDataString($Url)
  $uri = "$Gateway$ep?url=$enc&limit=$Limit"
  try {
    if ($Debug) { Write-Host "[try] $uri" -ForegroundColor DarkGray }
    # Invoke-RestMethod 会自动 JSON 反序列化，别再 ConvertFrom-Json 了
    $r = Invoke-RestMethod -Uri $uri -TimeoutSec 60

    # 兼容老字段 items / 新字段 products
    $items = if ($r.products) { $r.products } else { $r.items }

    if ($r.ok -and $items -and $items.Count -gt 0) {
      # 打印前三条
      $items | Select-Object @{n='adapter';e={$r.adapter}}, title, link, price -First 3 | Format-Table -AutoSize
      Write-Host "count: $($items.Count)  endpoint: $ep" -ForegroundColor Green
      return @{ ok = $true; endpoint = $ep; count = $items.Count }
    } else {
      if ($r.error) { Write-Host "[$ep] ok:$($r.ok) error: $($r.error)" -ForegroundColor Yellow }
      else { Write-Host "[$ep] ok:$($r.ok) items: $($items.Count)" -ForegroundColor Yellow }
      return @{ ok = $false; endpoint = $ep }
    }
  }
  catch {
    Write-Host "[$ep] $_" -ForegroundColor Red
    return @{ ok = $false; endpoint = $ep }
  }
}

# 顺序尝试：先 /v1/catalog 再 /v1/api/catalog
$tryEndpoints = @("/v1/catalog", "/v1/api/catalog")
foreach ($ep in $tryEndpoints) {
  $res = Invoke-Catalog $ep
  if ($res.ok) { return }
}

Write-Host "Both endpoints failed." -ForegroundColor Red
