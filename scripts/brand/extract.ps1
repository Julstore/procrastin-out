# Extrae el logo REAL del master JPG del usuario (pixel-perfect, sin redibujar).
# 1) Detecta el bounding box del tile verde por densidad de píxeles verdosos.
# 2) Mide el radio de esquina escaneando la primera fila verde de la esquina sup-izq.
# 3) Genera:
#    public/icon-real-512.png      crop redondeado con fondo transparente
#    public/icon-maskable-512.png  cuadrado completo (crop sin esquinas) 512x512
#    public/mark.png               la marca sola (infinito+flechas) con alfa
#    public/mark-green.png         la marca sola con el fondo verde recortado (paravergleich con mockup)
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/brand/extract.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$src  = Join-Path $repo 'scripts\brand\logo-master.jpg'
$pub  = Join-Path $repo 'public'

$bmp = [System.Drawing.Bitmap]::new($src)
$w = $bmp.Width; $h = $bmp.Height
Write-Host ("SRC " + $w + "x" + $h)

# -------- 1) bounding box del tile verde (ICONO, no el teléfono) --------
# verde del mockup: g claramente mayor que r y b
function Is-Green([System.Drawing.Color]$c) {
  return ($c.G -gt $c.R + 6 -and $c.G -gt $c.B + 6 -and $c.G -gt 20)
}

# por-columna y por-fila: cuenta de verdes;水体 los runs contiguos y el PRIMER run (el ícono está a la izquierda)
$colCount = [int[]]::new($w)
for ($y = 0; $y -lt $h; $y += 2) {
  for ($x = 0; $x -lt $w; $x += 2) {
    if (Is-Green $bmp.GetPixel($x, $y)) { $colCount[$x]++ }
  }
}

function Find-First-Run([int[]]$counts, [int]$thresh, [int]$gapAllow) {
  # devuelve (start, end) del primer run de índices con count>=thresh, tolerando huecos < gapAllow
  $start = -1; $lastHit = -1
  for ($i = 0; $i -lt $counts.Length; $i++) {
    if ($counts[$i] -ge $thresh) {
      if ($start -lt 0) { $start = $i }
      elseif ($i - $lastHit -gt $gapAllow) { break }
      $lastHit = $i
    }
  }
  return @($start, $lastHit)
}

($cx1, $cx2) = Find-First-Run $colCount 20 25
if ($cx1 -lt 0) { throw 'No encontre columnas verdes del icono' }

# filas: contar verdes SOLO dentro del rango de columnas del icono (excluye el teléfono)
$rowCount = [int[]]::new($h)
for ($y = 0; $y -lt $h; $y += 2) {
  for ($x = $cx1; $x -le $cx2; $x += 2) {
    if (Is-Green $bmp.GetPixel($x, $y)) { $rowCount[$y]++ }
  }
}
($ry1, $ry2) = Find-First-Run $rowCount 20 25
if ($ry1 -lt 0) { throw 'No encontre filas verdes del icono' }
$minX = $cx1; $maxX = $cx2; $minY = $ry1; $maxY = $ry2
Write-Host ("TILE bbox x=" + $minX + " y=" + $minY + " w=" + ($maxX - $minX + 1) + " h=" + ($maxY - $minY + 1))

# inset para evitar el sangrado JPEG/sombra del master en los bordes
$minX += 3; $minY += 3; $maxX -= 3; $maxY -= 3
$tw = $maxX - $minX + 1
$th = $maxY - $minY + 1
# -------- 2) radio de esquina --------
# escanea la esquina sup-izq: por cada ToDo fila verde desde minY, busca el primer x verde;
# el radio ≈ max(offset dentro del tile)
$radius = 0
for ($yy = 0; $yy -lt [Math]::Min(160, $th); $yy++) {
  $y = $minY + $yy
  $foundX = -1
  for ($xx = 0; $xx -lt [Math]::Min(220, $tw); $xx++) {
    if (Is-Green $bmp.GetPixel($minX + $xx, $y)) { $foundX = $xx; break }
  }
  if ($foundX -gt $radius) { $radius = $foundX }
}
Write-Host ("CORNER radius ~ " + $radius)

# -------- 3) copia el tile a un bitmap cuadrado --------
# el tile del mockup puede no ser cuadrado por el sombreado; escalamos al lado mayor
$side = [Math]::Max($tw, $th)
$tiledBmp = [System.Drawing.Bitmap]::new($side, $side)
$g = [System.Drawing.Graphics]::FromImage($tiledBmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($bmp, [System.Drawing.Rectangle]::new(0, 0, $side, $side),
  [System.Drawing.Rectangle]::new($minX, $minY, $tw, $th), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()

# -------- 4) generaa) crop redondeado 512, b) maskable 512, c) marca con alfa --------

# helper: aplica máscara redondeada con antialias de 2 px a un bitmap y devuelve un nuevo bitmap
function Round-Crop([System.Drawing.Bitmap]$srcBmp, [int]$size, [int]$rad) {
  $out = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $scale = $size / $srcBmp.Width
  $r = [Math]::Max(2, [int]($rad * $scale))
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = 2 * $r
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.SetClip($path)
  $g.DrawImage($srcBmp, [System.Drawing.Rectangle]::new(0, 0, $size, $size),
    [System.Drawing.Rectangle]::new(0, 0, $srcBmp.Width, $srcBmp.Height), [System.Drawing.GraphicsUnit]::Pixel)
  $g.ResetClip()
  $g.Dispose()
  $path.Dispose()
  return $out
}

# guardador con control de calidad
function Save-Png([System.Drawing.Bitmap]$b, [string]$p) {
  $b.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
  Write-Host ("SAVED " + $p)
}

# a) icono redondeado 512 - redimensiona el tile escogio a 512 y aplica radio acorde
$icon512 = Round-Crop $tiledBmp 512 ([int](118.0 / 512.0 * 512)) # radio real del mockup: ~118/512
Save-Png $icon512 (Join-Path $pub 'icon-real-512.png')

# 192 y 180 (favicon/apple-touch) resample del tile cuadrado
foreach ($s in @(192, 180)) {
  $srcS = [System.Drawing.Bitmap]::new($tiledBmp, $s, $s)
  $port = Round-Crop $srcS $s ([Math]::Max(4, [int]($s * 0.23)))
  $srcS.Dispose()
  Save-Png $port (Join-Path $pub ("icon-real-" + $s + ".png"))
}

# maskable: cuadrado verde centrado en la MARCA (sin rótulo, sin rim); el sistema aplica su máscara
# la marca en el canvas 512 de markBmp ocupa y=71..328 -> en coords del tile:
$Ht = $tiledBmp.Height
$markTopT = 71 * $Ht / 512.0
$markBotT = 328 * $Ht / 512.0
$cyT = ($markTopT + $markBotT) / 2
$markHT = $markBotT - $markTopT
# cuadrado de lado 2.35x la marca, centrado en ella, con margen para la zona segura
$sideT = 2.35 * $markHT
$halfT = $sideT / 2
$sx = [Math]::Max(8, [int]((($tiledBmp.Width) / 2) - $halfT))
$sy = [Math]::Max(8, [int]($cyT - $halfT))
$sw = [Math]::Min($tiledBmp.Width - 2 * $sx, [int]$sideT)
$sh = [Math]::Min($Ht - 2 * $sy, [int]$sideT)
$maskFull = [System.Drawing.Bitmap]::new(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gm = [System.Drawing.Graphics]::FromImage($maskFull)
$gm.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
# fondo: tile a sangre (bleed) para textura de fondo sin bordes
$bleed = 40
$gm.DrawImage($tiledBmp, [System.Drawing.Rectangle]::new(-$bleed, -$bleed, 512 + 2*$bleed, 512 + 2*$bleed),
  [System.Drawing.Rectangle]::new($sx, $sy, $sw, $sh), [System.Drawing.GraphicsUnit]::Pixel)
# contenido: la composición completa (marca + rótulo) al 78% centrada ->/todo dentro de la zona segura del circulo
$go = 512 * 0.11   # (1-0.78)/2 ≈ 56 px
$side = 512 * 0.78
$gm.DrawImage($tiledBmp, [System.Drawing.Rectangle]::new([int]$go, [int]$go, [int]$side, [int]$side),
  [System.Drawing.Rectangle]::new(0, 0, $tiledBmp.Width, $tiledBmp.Height), [System.Drawing.GraphicsUnit]::Pixel)
$gm.Dispose()
Save-Png $maskFull (Join-Path $pub 'icon-maskable-512.png')

# -------- 5) marca sola con alfa: fondo verde del tile → transparente --------
# la marca son los píxeles BLANCOS (infinito) y NARANJAS (flechas) dentro del tile
$markBmp = [System.Drawing.Bitmap]::new(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gpx = [System.Drawing.Graphics]::FromImage($markBmp)
$gpx.DrawImage($tiledBmp, [System.Drawing.Rectangle]::new(0, 0, 512, 512),
  [System.Drawing.Rectangle]::new(0, 0, $tiledBmp.Width, $tiledBmp.Height), [System.Drawing.GraphicsUnit]::Pixel)
$gpx.Dispose()

# recorre los píxeles: los verdes y sombras se vuelven transparentes; lo demás queda
for ($y = 0; $y -lt 512; $y++) {
  for ($x = 0; $x -lt 512; $x++) {
    $c = $markBmp.GetPixel($x, $y)
    if (-not (Is-Green $c)) {
      # la marca SOLO es blanca o naranja; todo lo demas (rim, sombras, verdes-grisaceos) -> transparente
      $alpha = 0
      $mx = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
      $mn = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
      $sat = $mx - $mn
      $lum = ($c.R + $c.G + $c.B) / 3
      if ($lum -ge 150 -and $sat -le 60) { $alpha = 255 }                                  # blanco del infinito
      elseif ($c.R -ge 120 -and $c.R -gt $c.G + 20 -and $c.G -ge $c.B - 10) { $alpha = 255 } # naranja/cobre de las flechas
      $markBmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $c.R, $c.G, $c.B))
    } else {
      $markBmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    }
  }
}
# la marca para el splash SOLO es el infinito+flechas: apaga el rótulo del ícono (franja inferior)
$cutoff = [int](512 * 0.68)
for ($y = $cutoff; $y -lt 512; $y++) {
  for ($x = 0; $x -lt 512; $x++) {
    if ($markBmp.GetPixel($x, $y).A -gt 0) { $markBmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0)) }
  }
}

# banda de borde: cero alfa en los 30 px del borde del canvas (rim/arco fantasma del tile)
$edgeBand = 30
for ($y = 0; $y -lt 512; $y++) {
  for ($x = 0; $x -lt 512; $x++) {
    if ($x -lt $edgeBand -or $x -ge (512 - $edgeBand) -or $y -lt $edgeBand -or $y -ge (512 - $edgeBand)) {
      if ($markBmp.GetPixel($x, $y).A -gt 0) { $markBmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0)) }
    }
  }
}

# bounding box de la marca (pixeles con alfa>0) ANTES de guardar/disponer
$mbminX = 512; $mbminY = 512; $mbmaxX = -1; $mbmaxY = -1
for ($y = 0; $y -lt 512; $y++) {
  for ($x = 0; $x -lt 512; $x++) {
    if ($markBmp.GetPixel($x, $y).A -gt 0) {
      if ($x -lt $mbminX) { $mbminX = $x }
      if ($y -lt $mbminY) { $mbminY = $y }
      if ($x -gt $mbmaxX) { $mbmaxX = $x }
      if ($y -gt $mbmaxY) { $mbmaxY = $y }
    }
  }
}
Write-Host ("MARK bbox x=" + $mbminX + " y=" + $mbminY + " w=" + ($mbmaxX-$mbminX+1) + " h=" + ($mbmaxY-$mbminY+1))

# tight crop de la marca centrado en un lienzo cuadrado (padding 30) ANTES de disponer markBmp
$mkw = $mbmaxX - $mbminX + 1
$mkh = $mbmaxY - $mbminY + 1
$mkSide = [Math]::Max($mkw, $mkh) + 60
$markTight = [System.Drawing.Bitmap]::new($mkSide, $mkSide, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gt = [System.Drawing.Graphics]::FromImage($markTight)
$gt.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gt.DrawImage($markBmp, [System.Drawing.Rectangle]::new(30, 30, $mkw, $mkh),
  [System.Drawing.Rectangle]::new($mbminX, $mbminY, $mkw, $mkh), [System.Drawing.GraphicsUnit]::Pixel)
$gt.Dispose()
$markBmp.Dispose()
Save-Png $markTight (Join-Path $pub 'mark-real.png')

# -------- 6) rótulo: letras blancas de la franja inferior del tile --------
$labSrc = [System.Drawing.Bitmap]::new($tiledBmp.Width, $tiledBmp.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gl = [System.Drawing.Graphics]::FromImage($labSrc)
$gl.DrawImage($tiledBmp, [System.Drawing.Rectangle]::new(0, 0, $tiledBmp.Width, $tiledBmp.Height),
  [System.Drawing.Rectangle]::new(0, 0, $tiledBmp.Width, $tiledBmp.Height), [System.Drawing.GraphicsUnit]::Pixel)
$gl.Dispose()
$bandStart = [int]($labSrc.Height * 0.70)
for ($y = 0; $y -lt $labSrc.Height; $y++) {
  for ($x = 0; $x -lt $labSrc.Width; $x++) {
    if ($y -lt $bandStart) { $labSrc.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0,0,0,0)); continue }
    $c = $labSrc.GetPixel($x, $y)
    $lum = ($c.R + $c.G + $c.B) / 3
    $mx = [Math]::Max($c.R, [Math]::Max($c.G, $c.B)); $mn = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
    if ($lum -ge 150 -and ($mx - $mn) -le 60) {
      $labSrc.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $c.R, $c.G, $c.B))
    } else {
      $labSrc.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0,0,0,0))
    }
  }
}
# bbox del rótulo
$lbminX = $labSrc.Width; $lbminY = $labSrc.Height; $lbmaxX = -1; $lbmaxY = -1
for ($y = 0; $y -lt $labSrc.Height; $y++) {
  for ($x = 0; $x -lt $labSrc.Width; $x++) {
    if ($labSrc.GetPixel($x, $y).A -gt 0) {
      if ($x -lt $lbminX) { $lbminX = $x }
      if ($y -lt $lbminY) { $lbminY = $y }
      if ($x -gt $lbmaxX) { $lbmaxX = $x }
      if ($y -gt $lbmaxY) { $lbmaxY = $y }
    }
  }
}
Write-Host ("LABEL bbox x=" + $lbminX + " y=" + $lbminY + " w=" + ($lbmaxX-$lbminX+1) + " h=" + ($lbmaxY-$lbminY+1))
$lbw = $lbmaxX - $lbminX + 1
$lbh = $lbmaxY - $lbminY + 1
$labReal = [System.Drawing.Bitmap]::new($lbw, $lbh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$glc = [System.Drawing.Graphics]::FromImage($labReal)
$glc.DrawImage($labSrc, [System.Drawing.Rectangle]::new(0, 0, $lbw, $lbh),
  [System.Drawing.Rectangle]::new($lbminX, $lbminY, $lbw, $lbh), [System.Drawing.GraphicsUnit]::Pixel)
$glc.Dispose()
$labSrc.Dispose()
Save-Png $labReal (Join-Path $pub 'label-real.png')

# -------- 7) splash-real.png 1080x1920: píxeles reales sobre el fondo de la marca --------
$sp = [System.Drawing.Bitmap]::new(1080, 1920, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gs = [System.Drawing.Graphics]::FromImage($sp)
$gs.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
# fondo degradado #0D251C -> #163A2B
$bgRect = [System.Drawing.Rectangle]::new(0, 0, 1080, 1920)
$bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($bgRect,
  [System.Drawing.Color]::FromArgb(255, 13, 37, 28),
  [System.Drawing.Color]::FromArgb(255, 22, 58, 43), 90.0)
$gs.FillRectangle($bgBrush, $bgRect)
$bgBrush.Dispose()
# halos naranjas 25% (alpha 64) con caída radial suave: esquinas y centro
function Draw-Halo([System.Drawing.Graphics]$g, [int]$cx, [int]$cy, [int]$rx, [int]$ry) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddEllipse($cx-$rx, $cy-$ry, 2*$rx, 2*$ry)
  $pgb = [System.Drawing.Drawing2D.PathGradientBrush]::new($path)
  $pgb.CenterColor = [System.Drawing.Color]::FromArgb(64, 230, 126, 34)
  $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 230, 126, 34))
  $g.FillPath($pgb, $path)
  $pgb.Dispose()
  $path.Dispose()
}
Draw-Halo $gs 70 70 640 640
Draw-Halo $gs 1010 70 640 640
Draw-Halo $gs 70 1850 640 640
Draw-Halo $gs 1010 1850 640 640
Draw-Halo $gs 540 880 660 540
# marca real centrada ( yeast 46% de alto) a 1.38x del crop 512
$markSize = 560
$gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
# mark-real.png contiene la marca centrada en su lienzo cuadrado: dibujo el lienzo completo
$mDims = $null; $mkW = 405; $mkH = 405
try { $mi = [System.Drawing.Image]::FromFile((Join-Path $pub 'mark-real.png')); $mkW = $mi.Width; $mkH = $mi.Height; $mi.Dispose() } catch {}
$gs.DrawImage([System.Drawing.Image]::FromFile((Join-Path $pub 'mark-real.png')),
  [System.Drawing.Rectangle]::new([int]((1080-$markSize)/2), [int](880 - $markSize/2), $markSize, $markSize))
# rótulo real debajo ( ancho ~ 540 px)
$lbW2 = 540; $lbH2 = [int]($lbH * $lbW2 / $lbw)
$gs.DrawImage([System.Drawing.Image]::FromFile((Join-Path $pub 'label-real.png')),
  [System.Drawing.Rectangle]::new([int]((1080-$lbW2)/2), 1210, $lbW2, $lbH2))
$gs.Dispose()
$sp.Save((Join-Path $pub 'splash-real.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$sp.Dispose()
Write-Host 'SAVED splash-real.png 1080x1920'

$bmp.Dispose()
$tiledBmp.Dispose()

# -------- 8) publica en los nombres finales que consume la app --------
Copy-Item (Join-Path $pub 'icon-real-512.png')  (Join-Path $pub 'icon-512.png')  -Force
Copy-Item (Join-Path $pub 'icon-real-192.png')  (Join-Path $pub 'icon-192.png')  -Force
Copy-Item (Join-Path $pub 'icon-real-180.png')  (Join-Path $pub 'icon-180.png')  -Force
Write-Host 'PUBLISHED icon-512/192/180.png'
Write-Host 'DONE'
