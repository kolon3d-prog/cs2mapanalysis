@echo off
rem prompt-station: двойной щелчок показывает, что прошито; прошить — с аргументом.
rem Нужен PowerShell 5.1+ и node в PATH.
pwsh -NoProfile -File "%~dp0prompt-station.ps1" %*
if errorlevel 1 echo [!] что-то не так — смотри вывод выше
pause
