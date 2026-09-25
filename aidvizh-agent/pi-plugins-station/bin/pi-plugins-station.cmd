@echo off
rem pi-plugins-station: двойной щелчок показывает каталог плагинов; установка — с аргументами.
rem Нужен PowerShell 5.1+ и node в PATH.
pwsh -NoProfile -File "%~dp0pi-plugins-station.ps1" %*
pause
