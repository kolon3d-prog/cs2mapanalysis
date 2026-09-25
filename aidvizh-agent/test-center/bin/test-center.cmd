@echo off
rem test-center: сквозная проверка системы AGGG. Двойной щелчок запускает проверку.
rem Нужен PowerShell 5.1+ и node в PATH.
pwsh -NoProfile -File "%~dp0test-center.ps1" %*
if errorlevel 1 (
  echo.
  echo [!] есть сбои — смотри багрепорт.md рядом со станцией
)
pause
