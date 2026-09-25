@echo off
rem memory-station: центр памяти агента. Двойной щелчок показывает состояние.
rem Нужен PowerShell 5.1+, node и uv (для самой памяти) в PATH.
pwsh -NoProfile -File "%~dp0memory-station.ps1" %*
if errorlevel 1 (
  echo.
  echo [!] команда закончилась ошибкой — читай вывод выше
)
pause
