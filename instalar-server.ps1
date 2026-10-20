#Requires -Version 5.1
<#
.SYNOPSIS
  Hace que el server de procrastin-out arranque solo al iniciar sesion en Windows.

.DESCRIPTION
  Crea un acceso directo en la carpeta Inicio del usuario actual
  (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup). No pide
  administrador, no registra tareas y no escribe en el registro: borrar el
  acceso directo (o correr quitar-server.ps1) lo deshace por completo.

  Si el server ya esta corriendo en 4321 solo avisa: ese proceso sigue siendo
  el que responde hasta que se cierre, y en el proximo inicio de sesion toma
  el puesto el del acceso directo. Es idempotente: correrlo dos veces deja un
  solo acceso directo.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\instalar-server.ps1
#>
[CmdletBinding()]
param(
  [string]$Node = ""
)

$ErrorActionPreference = "Stop"

function Fallo([string]$mensaje) {
  Write-Host "  x $mensaje" -ForegroundColor Red
  exit 1
}

function Info([string]$etiqueta, [string]$valor) {
  Write-Host ("  {0}  {1}" -f $etiqueta.PadRight(18), $valor)
}

Write-Host ""
Write-Host "procrastin-out - el server arranca solo" -ForegroundColor White

# El script vive en la carpeta de la app misma (no en scripts\), así que
# la raíz es este directorio.
$root = $PSScriptRoot
$entry = Join-Path $root "server.js"

if (-not (Test-Path -LiteralPath $entry)) {
  Fallo "no encuentro server.js en $entry"
}

# --- node -------------------------------------------------------------------
if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Fallo "no hay 'node' en el PATH. Instala Node.js o pasa -Node <ruta a node.exe>."
  }
  $Node = $cmd.Source
}
if (-not (Test-Path -LiteralPath $Node)) {
  Fallo "no existe $Node"
}
$version = (& $Node -v).Trim()

# --- estado del puerto (solo informativo: no mata a nadie) -------------------
$escuchando = $false
try {
  $conexiones = Get-NetTCPConnection -LocalPort 4321 -State Listen -ErrorAction SilentlyContinue
  if ($conexiones) { $escuchando = $true }
} catch { }

if ($escuchando) {
  Write-Host "  i  el server ya esta corriendo ahora: sigue vivo hasta que se cierre" -ForegroundColor DarkCyan
  Write-Host "     (al proximo inicio de sesion arranca el del acceso directo)" -ForegroundColor DarkCyan
}

# --- carpeta Inicio ---------------------------------------------------------
$appData = $env:APPDATA
if (-not $appData) { $appData = [Environment]::GetFolderPath("ApplicationData") }
if (-not $appData) { Fallo "no pude resolver %APPDATA%" }

$inicio = Join-Path $appData "Microsoft\Windows\Start Menu\Programs\Startup"
if (-not (Test-Path -LiteralPath $inicio)) {
  New-Item -ItemType Directory -Path $inicio -Force | Out-Null
}

$nombre = "procrastin-out - servidor.lnk"
$destino = Join-Path $inicio $nombre
$existia = Test-Path -LiteralPath $destino

# --- el acceso directo ------------------------------------------------------
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($destino)
$lnk.TargetPath = $Node
$lnk.Arguments = "server.js"
$lnk.WorkingDirectory = $root
# 7 = minimizada: el server vive a la vista, sin robar el foco; cerrar esa
# ventana es una forma de pararlo.
$lnk.WindowStyle = 7
$lnk.Description = "procrastin-out: server local en 4321 (datos en .\data)"
$lnk.IconLocation = "$Node,0"
$lnk.Save()

if (-not (Test-Path -LiteralPath $destino)) {
  Fallo "no pude crear el acceso directo en $destino"
}

Info "acceso directo" $destino
Info "estado" $(if ($existia) { "reemplazado (ya estaba instalado)" } else { "creado" })
Info "node" "$Node ($version)"
Info "server" $entry
Info "al iniciar" "ventana minimizada; interfiere con nada: la agenda ya estaba"

Write-Host ""
Write-Host "Listo. Para probarlo ahora sin cerrar sesion: " -NoNewline
Write-Host "node server.js" -ForegroundColor Green
Write-Host "Para deshacerlo: " -NoNewline
Write-Host ".\quitar-server.ps1" -ForegroundColor DarkGray
Write-Host ""
exit 0
