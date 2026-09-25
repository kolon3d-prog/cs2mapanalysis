@echo off
rem wiki-station: центр вики. Двойной щелчок показывает список вики.
rem Нужен PowerShell 5.1+ и node в PATH.
pwsh -NoProfile -File "%~dp0wiki-station.ps1" %*
if errorlevel 1 (
  echo.
  echo [!] команда закончилась ошибкой — читай вывод выше
)
pause
