@echo off
title ChessReviewer Builder
cd /d "%~dp0"
echo.
echo  =============================================
echo   ChessReviewer - Portable EXE Builder
echo  =============================================
echo.

REM Activate virtualenv
if not exist ".venv" (
    echo  [ERROR] Python virtual environment (.venv) not found. Please run start.bat first to initialize it.
    pause
    exit /b 1
)
call .venv\Scripts\activate.bat

REM Check for PyInstaller
python -c "import PyInstaller" >nul 2>&1
if errorlevel 1 (
    echo  [SETUP] Installing PyInstaller in virtualenv...
    pip install pyinstaller
)

echo  [BUILD] Compiling Python sidecar using PyInstaller...
pyinstaller --onefile --noconsole --name backend_server --add-data "backend/eco_interpolated.json;backend" --add-data "backend/puzzles.json;backend" --add-data "frontend;frontend" backend/main.py

echo.
echo  [BUILD] Installing Node dependencies (including electron-builder)...
call npm install

echo.
echo  [BUILD] Packaging Electron app into a single portable EXE...
call npm run dist

echo.
echo  =============================================
echo   Build finished!
echo   Standalone EXE location: dist\ChessReviewer Portable.exe
echo  =============================================
echo.
pause
