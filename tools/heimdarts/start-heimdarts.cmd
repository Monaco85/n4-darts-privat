@echo off
rem HeimDarts starten: eigene Darterkennung fuer n4-darts (Doppelklick genuegt).
rem Danach in n4-darts "start-echtes-board.cmd" starten und bei der Adresse einfach Enter druecken.
title HeimDarts - Darterkennung
cd /d "%~dp0"
set "PY=%USERPROFILE%\Tools\heimdarts-venv\Scripts\python.exe"
if not exist "%PY%" (
  echo Python-Umgebung fehlt. Bitte einmal install-heimdarts.cmd ausfuehren.
  pause
  exit /b 1
)
"%PY%" -m heimdarts --open %*
echo.
pause
