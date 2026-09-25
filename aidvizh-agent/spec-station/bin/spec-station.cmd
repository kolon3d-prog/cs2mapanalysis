@echo off
rem spec-station: двойной щелчок показывает состав станции; установка — с аргументами.
rem Нужен PowerShell 5.1+ и node в PATH.
pwsh -NoProfile -File "%~dp0spec-station.ps1" %*
pause
