@echo off
rem Double-click to start InvestorView and open it in your browser.
cd /d "%~dp0"
start "" http://localhost:5178
node server.js
pause
