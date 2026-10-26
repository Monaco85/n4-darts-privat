@echo off
rem n4-darts mit dem simulierten Board starten (Doppelklick genuegt).
title n4-darts - Simulator
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1"
echo.
pause
