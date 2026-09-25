@echo off
rem cli-station: один клик на Windows — ставит omp, pi и opencode (opencode2).
rem Нужен PowerShell 5.1+ и node в PATH.
pwsh -NoProfile -File "%~dp0cli-station.ps1" %*
if errorlevel 1 echo [!] установка закончилась ошибкой — смотри вывод выше
pause
