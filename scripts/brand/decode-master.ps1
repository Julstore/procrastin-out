# Decodifica el master (JPG del usuario) a RGBA crudo para el pipeline de Node.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/brand/decode-master.ps1
# Salida: scripts/brand/.master.rgba  +  scripts/brand/.master.json  ({w,h})
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'logo-master.jpg'
if (-not (Test-Path $src)) { throw "Falta $src" }

$bmp = [System.Drawing.Bitmap]::new($src)
$w = $bmp.Width; $h = $bmp.Height
$rect = [System.Drawing.Rectangle]::new(0, 0, $w, $h)
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($w * $h * 4)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)
$bmp.Dispose()

[System.IO.File]::WriteAllBytes((Join-Path $here '.master.rgba'), $bytes)
Set-Content -Path (Join-Path $here '.master.json') -Value ('{"w":' + $w + ',"h":' + $h + '}') -Encoding ASCII
Write-Host "master ${w}x${h} -> .master.rgba ($($bytes.Length) bytes)"
