@echo off
rem n4-darts mit dem echten Autodarts-Board starten (ohne Simulator).
rem Autodarts muss laufen; sein Board Manager antwortet auf Port 3180.
title n4-darts - echtes Board
set "N4_BOARD=http://localhost:3180"
echo.
echo Adresse des PCs, auf dem Autodarts laeuft.
echo Einfach Enter druecken, wenn es dieser PC ist (http://localhost:3180).
echo Sonst z. B. http://192.168.178.50:3180 eingeben.
set /p "N4_BOARD=Adresse: "
call "%~dp0start-windows.cmd"
