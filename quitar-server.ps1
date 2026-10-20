#Requires -Version 5.1
<#
.SYNOPSIS
  Deshace el arranque automatico del server de procrastin-out.

.DESCRIPTION
  Borra el acceso directo que crea instalar-server.ps1. No detiene un server
  que ya este corriendo (sigue hasta que cierres su ventana) y no toca los
  datos de data\. Es seguro correrlo sin nada instalado: avisa y termina bien.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\quitar-server.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "procrastin-out - quitar el arranque automatico" -ForegroundColor White

$appData = $env:APPDATA
if (-not $appData) { $appData = [Environment]::GetFolderPath("ApplicationData") }
if (-not $appData) {
  Write-Host "  x no pude resolver %APPDATA%" -ForegroundColor Red
  exit 1
}

$inicio = Join-Path $appData "Microsoft\Windows\Start Menu\Programs\Startup"
$destino = Join-Path $inicio "procrastin-out - servidor.lnk"

if (Test-Path -LiteralPath $destino) {
  Remove-Item -LiteralPath $destino -Force
  if (Test-Path -LiteralPath $destino) {
    Write-Host "  x no pude borrar $destino" -ForegroundColor Red
    exit 1
  }
  Write-Host "  ok   quitado: $destino" -ForegroundColor Green
} else {
  Write-Host "  ok   no estaba instalado, no habia nada que quitar"
}

Write-Host "  info los datos de data\ quedaron como estaban"
Write-Host "  info si el server esta corriendo ahora, sigue hasta que cierres su ventana"
Write-Host ""
exit 0
