@echo off
title ChessReviewer
cd /d "%~dp0"
echo.
echo  =============================================
echo   ChessReviewer - Local Chess Analysis Tool
echo  =============================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found. Please install Node.js ^(LTS recommended^).
    pause
    exit /b 1
)

REM Check if Cargo is installed (required for Tauri builds)
cargo --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Rust/Cargo not found. Please install Rust from https://rustup.rs/
    pause
    exit /b 1
)

REM Install node dependencies if node_modules doesn't exist
if not exist "node_modules" (
    echo  [SETUP] Installing Node.js dependencies...
    call npm install
    echo.
)

echo  [INFO] Starting ChessReviewer in Tauri Developer Mode...
echo  [INFO] Press Ctrl+C to stop.
echo.

call npm run tauri dev

pause
