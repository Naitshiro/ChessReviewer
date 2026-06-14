@echo off
title ChessReviewer
cd /d "%~dp0"
echo.
echo  =============================================
echo   ChessReviewer - Local Chess Analysis Tool
echo  =============================================
echo.

REM Check for Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found. Please install Python 3.11+.
    pause
    exit /b 1
)

REM Install dependencies if needed
if not exist ".venv" (
    echo  [SETUP] Creating virtual environment...
    python -m venv .venv
    echo  [SETUP] Installing dependencies...
    .venv\Scripts\pip install -r requirements.txt --quiet
    echo  [SETUP] Done!
    echo.
)

REM Download missing piece assets (chess.com alpha pieces) if they don't exist
if not exist "frontend\assets\pieces\alpha_scaled.flag" (
    echo  [SETUP] Downloading Alpha piece set and extensions...
    python download_pieces.py
)

REM Activate venv and start server
call .venv\Scripts\activate.bat

echo  [INFO] Starting server at http://127.0.0.1:8000
echo  [INFO] Open your browser to: http://127.0.0.1:8000
echo  [INFO] Press Ctrl+C to stop.
echo.

python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

pause
