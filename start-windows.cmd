@echo off
rem n4-darts mit zwei simulierten Boards starten (Doppelklick genuegt).
title n4-darts - Simulator
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1"
echo.
pause
