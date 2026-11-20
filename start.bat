@echo off
rem Startet die Spanisch-App: lokaler Webserver + Browser. Beenden: dieses Fenster schliessen.
cd /d "%~dp0"
echo Spanisch-App laeuft unter http://localhost:8000
echo Dieses Fenster offen lassen. Zum Beenden einfach schliessen.
echo.
rem Browser erst nach 2 Sekunden oeffnen, damit der Server schon bereit ist
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8000"
python -m http.server 8000
echo.
echo Der Server konnte nicht starten oder wurde beendet (laeuft die App vielleicht schon in einem anderen Fenster?).
pause
