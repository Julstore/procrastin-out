# Genera public/icon.ico (formato ICO con imágenes PNG incrustadas, soportado desde Windows Vista)
# a partir del icono real 512 ya extraído del master del logo.
# Entradas: 256, 128, 64, 48, 32, 16 px — Windows elige la mejor para cada contexto.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/brand/make-ico.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$src  = Join-Path $repo 'public\icon-512.png'
$out  = Join-Path $repo 'public\icon.ico'

$srcBmp = [System.Drawing.Bitmap]::FromFile($src)
if ($srcBmp.Width -ne 512 -or $srcBmp.Height -ne 512) { throw "Esperaba 512x512, llegó $($srcBmp.Width)x$($srcBmp.Height)" }

function Save-ResampledPng([System.Drawing.Bitmap]$src, [int]$size, [string]$path) {
  $b = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.DrawImage($src, [System.Drawing.Rectangle]::new(0, 0, $size, $size),
    [System.Drawing.Rectangle]::new(0, 0, $src.Width, $src.Height), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $ms = [System.IO.MemoryStream]::new()
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
  [System.IO.File]::WriteAllBytes($path + ".tmp.png", $ms.ToArray())
}

# 1) Generar los PNG de cada tamaño en archivos temporales
$sizes = @(256, 128, 64, 48, 32, 16)
$tmps = @()
foreach ($s in $sizes) {
  $p = Join-Path $env:TEMP ("ico-" + $s)
  Save-ResampledPng $srcBmp $s $p
  $tmps += ,@($s, ($p + ".tmp.png"))
}
$srcBmp.Dispose()

# 2) Ensamblar el ICO: cabecera ICONDIR + entradas ICONDIRENTRY + datos PNG
$fs = [System.IO.File]::Create($out)
$bw = [System.IO.BinaryWriter]::new($fs)
# ICONDIR: reserved=0, type=1 (icon), count
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
# ICONDIRENTRY: hay que conocer los offsets; primero calculo tamaños
$dataLens = @()
foreach ($t in $tmps) { $dataLens += ([System.IO.FileInfo]::new($t[1])).Length }
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $tmps[$i][0]
  $bw.Write([Byte]($(if ($s -ge 256) { 0 } else { $s })))         # width (0 = 256)
  $bw.Write([Byte]($(if ($s -ge 256) { 0 } else { $s })))         # height
  $bw.Write([Byte]0)                                              # palette
  $bw.Write([Byte]0)                                              # reserved
  $bw.Write([UInt16]1)                                            # planes
  $bw.Write([UInt16]32)                                           # bpp
  $bw.Write([UInt32]$dataLens[$i])                                # tamaño datos
  $bw.Write([UInt32]$offset)                                      # offset
  $offset += $dataLens[$i]
}
foreach ($t in $tmps) {
  $bw.Write([System.IO.File]::ReadAllBytes($t[1]))
  Remove-Item $t[1] -Force
}
$bw.Dispose(); $fs.Close()

# 3) Validación: cabecera y carga con GDI+
$bytes = [System.IO.File]::ReadAllBytes($out)
$reserved = [BitConverter]::ToUInt16($bytes, 0)
$type = [BitConverter]::ToUInt16($bytes, 2)
$count = [BitConverter]::ToUInt16($bytes, 4)
if ($reserved -ne 0 -or $type -ne 1) { throw "Cabecera ICO inválida" }
$firstPng = [BitConverter]::ToUInt32($bytes, 6 + 16 + 12)  # offset de la primera entrada
if ($bytes[$firstPng] -ne 0x89 -or $bytes[$firstPng+1] -ne 0x50) { throw "Primera entrada no es PNG" }
$ico = [System.Drawing.Icon]::new($out)
Write-Host ("GDI load OK: " + $ico.Width + "x" + $ico.Height)
$ico.Dispose()
Write-Host ("SAVED " + $out + " (" + $bytes.Length + " bytes, " + $count + " entradas)")
