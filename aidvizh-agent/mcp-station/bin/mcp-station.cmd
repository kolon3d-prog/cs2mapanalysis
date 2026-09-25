@echo off
rem mcp-station: один клик на Windows — двойной щелчок ставит core-серверы каталога (без ключей).
rem Нужен PowerShell 5.1+ и node в PATH.
pwsh -NoProfile -File "%~dp0mcp-station.ps1" %*
if errorlevel 1 (
  echo.
  echo [!] установка закончилась ошибкой — читай вывод выше
)
pause
