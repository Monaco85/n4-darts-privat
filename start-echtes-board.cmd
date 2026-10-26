@echo off
rem n4-darts mit dem echten Autodarts-Board starten (ohne Simulator).
rem Autodarts muss laufen; sein Board Manager antwortet auf Port 3180.
title n4-darts - echtes Board
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" -EchtesBoard
echo.
pause
