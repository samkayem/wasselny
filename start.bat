@echo off
title Wasselny Server
echo ============================================
echo   Wasselny - Local Setup
echo ============================================
echo.

set ADMIN_USER=admin
set ADMIN_PASS=admin123
set JWT_SECRET=change-this-to-a-long-random-text

echo Installing dependencies (first run only, this may take a minute)...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo Something went wrong during "npm install".
  echo Copy the message above and send it for help.
  echo.
  pause
  exit /b
)

echo.
echo Starting Wasselny...
echo Open your browser and go to: http://localhost:3000
echo Press Ctrl+C here to stop the server.
echo.
call npm start

echo.
echo The server has stopped.
pause
