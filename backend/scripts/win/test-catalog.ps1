param(
  [string]$Gateway = "https://yunivera-gateway.onrender.com",
  [string]$Url     = "https://www.s-impuls-shop.de/catalog/mobile",
  [int]   $Limit   = 20
)

function Invoke-Detect {
  param([string]$Gateway,[string]$Url)
  $enc = [Uri]::EscapeDataString($Url)
  $t0 = Get-Date
  try {
    $det = Invoke-RestMethod -Uri "$Gateway/v1/detect?url=$enc" -ErrorAction Stop
    $ms  = [math]::Round((Get-Date) .Subtract($t0).TotalMilliseconds)
    Write-Host "== DETECT ($ms ms) ==" -ForegroundColor Cyan
    $det | ConvertTo-Json -Depth 10
  } catch {
    Write-Host "DETECT error: $($_.Exception.Message)" -ForegroundColor Red
  }
}

function Invoke-Catalog {
  param([string]$Gateway,[string]$Url,[int]$Limit)
  $enc = [Uri]::EscapeDataString($Url)
  $t0 = Get-Date
  try {
    $cat = Invoke-RestMethod -Uri "$Gateway/v1/api/catalog?url=$enc&limit=$Limit" -Method GET -ErrorAction Stop
    $ms  = [math]::Round((Get-Date) .Subtract($t0).TotalMilliseconds)
    $n   = @($cat.items).Count
    Write-Host "`n== CATALOG ($ms ms) items:$n ==" -ForegroundColor Cyan
    if ($n -gt 0) {
      $cat.items[0..([Math]::Min(2,$n-1))] | ConvertTo-Json -Depth 10
    } else {
      Write-Host "(no items returned)"
    }
  } catch {
    Write-Host "CATALOG error: $($_.Exception.Message)" -ForegroundColor Red
  }
}

Invoke-Detect  -Gateway $Gateway -Url $Url
Invoke-Catalog -Gateway $Gateway -Url $Url -Limit $Limit
