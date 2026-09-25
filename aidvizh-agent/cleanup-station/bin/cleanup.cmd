@echo off
rem cleanup-station: двойной щелчок показывает план сноса (ничего не удаляет).
rem Реальное выполнение: cleanup.cmd clean-all --yes
pwsh -NoProfile -File "%~dp0cleanup.ps1" %*
pause
