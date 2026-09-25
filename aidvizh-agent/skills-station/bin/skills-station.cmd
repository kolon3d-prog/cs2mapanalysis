@echo off
rem skills-station: двойной щелчок показывает коллекцию; установка — с аргументами.
rem Нужен PowerShell 5.1+ и node в PATH.
pwsh -NoProfile -File "%~dp0skills-station.ps1" %*
pause
