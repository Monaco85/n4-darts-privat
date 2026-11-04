@echo off
rem Einmalig: Python-Umgebung fuer HeimDarts anlegen (braucht dafuer einmal Internet).
rem Die Umgebung liegt unter %USERPROFILE%\Tools\heimdarts-venv (kurzer Pfad, wegen der Windows-Pfadlaenge).
title HeimDarts - Installation
cd /d "%~dp0"
set "VENV=%USERPROFILE%\Tools\heimdarts-venv"
where python >nul 2>nul || (
  echo Python fehlt. Bitte Python 3.11 oder neuer installieren, z. B. aus dem Microsoft Store.
  pause
  exit /b 1
)
if not exist "%VENV%\Scripts\python.exe" python -m venv "%VENV%"
"%VENV%\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
echo.
echo Fertig. Starten mit start-heimdarts.cmd
pause
