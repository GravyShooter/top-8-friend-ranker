@echo off
title Spud Kart Server - One-Click Setup
setlocal
set "DIR=%USERPROFILE%\SpudKart"
set "SERVER_URL=https://gravyshooter.github.io/top-8-friend-ranker/assets/spud-kart-server.js"

echo ==============================================
echo   Spud Kart basement server - one-click setup
echo ==============================================
echo.
echo This sets everything up by itself:
echo   1. Installs Node.js if it is missing
echo   2. Downloads the Spud Kart server
echo   3. Sets the server to start itself every time this PC turns on
echo   4. Starts the server right now
echo.
if not exist "%DIR%" mkdir "%DIR%"
cd /d "%DIR%"

REM ---------- 1. Node.js ----------
where node >nul 2>nul
if %errorlevel%==0 goto have_node
echo Node.js not found - installing it for you...
where winget >nul 2>nul
if %errorlevel%==0 winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
where node >nul 2>nul
if %errorlevel%==0 goto have_node
echo.
echo The automatic install did not finish. Opening the Node.js
echo download page - install it (the big LTS button), then run
echo this setup file one more time.
start https://nodejs.org/en/download
pause
exit /b 1

:have_node
for /f "tokens=*" %%v in ('node --version') do echo Node.js %%v is ready.
echo.

REM ---------- 2. Server file ----------
if exist "%~dp0spud-kart-server.js" copy /y "%~dp0spud-kart-server.js" "%DIR%\spud-kart-server.js" >nul
if not exist "%DIR%\spud-kart-server.js" (
  echo Downloading the Spud Kart server...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%SERVER_URL%' -OutFile '%DIR%\spud-kart-server.js'"
)
if not exist "%DIR%\spud-kart-server.js" (
  echo.
  echo Could not download the server file. Check the internet
  echo connection on this PC, then run this setup again.
  pause
  exit /b 1
)
echo Server file ready in %DIR%.
echo.

REM ---------- 3. Auto-start at boot ----------
> "%DIR%\run-spud-kart.cmd" echo @echo off
>>"%DIR%\run-spud-kart.cmd" echo cd /d "%%~dp0"
>>"%DIR%\run-spud-kart.cmd" echo :loop
>>"%DIR%\run-spud-kart.cmd" echo node spud-kart-server.js
>>"%DIR%\run-spud-kart.cmd" echo timeout /t 5 /nobreak ^>nul
>>"%DIR%\run-spud-kart.cmd" echo goto loop
> "%DIR%\run-hidden.vbs" echo CreateObject("WScript.Shell").Run Chr(34) ^& "%DIR%\run-spud-kart.cmd" ^& Chr(34), 0, False
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'SpudKartServer' -Value ('wscript.exe ' + [char]34 + '%DIR%\run-hidden.vbs' + [char]34)"
echo Auto-start is on: the server now starts itself at every boot.
echo.

REM ---------- 4. Start it now ----------
echo Starting the server now. A window will open showing the
echo addresses - the first time only, type the 100.x one into the
echo Spud Kart panel under "Server setup" (your phone remembers it
echo after that, and it rides inside race invite links for friends).
echo.
echo If Windows Firewall asks, click "Allow access" - that is the
echo phones reaching the server.
echo.
start "Spud Kart Server" /D "%DIR%" cmd /k node spud-kart-server.js
echo Setup is done. You can close this window - and you never
echo have to open it again.
pause
exit /b 0
