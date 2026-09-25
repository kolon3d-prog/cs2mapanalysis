@echo off
rem junk-report-station: отчёт по мусору на диске данных (ничего не удаляет).
pwsh -NoProfile -File "%~dp0junk-report.ps1" %*
pause
