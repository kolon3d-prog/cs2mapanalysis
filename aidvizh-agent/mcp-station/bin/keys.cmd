@echo off
rem keys: двойной щелчок открывает меню управления ключами станции.
rem Нужен PowerShell 5.1+ и node в PATH.
pwsh -NoProfile -File "%~dp0keys.ps1" %*
pause
