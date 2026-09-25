@echo off
rem command-center: двойной щелчок показывает состояние всех проектов.
rem Нужен PowerShell (7 или встроенный 5.1) и node в PATH.
rem
rem Запускалку выбираем ОДИН раз: раньше здесь стояло «where pwsh && (pwsh ...) || (powershell ...)»,
rem и любой ненулевой код движка cmd понимал как «pwsh не сработал» — команда выполнялась второй раз
rem (уже через встроенный powershell). Код возврата движка отдаём как есть.
setlocal
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File"
where pwsh >nul 2>nul && set "PS=pwsh -NoProfile -File"
%PS% "%~dp0center.ps1" %*
set "RC=%ERRORLEVEL%"
pause
exit /b %RC%
