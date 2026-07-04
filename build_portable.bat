@echo off
title ChessReviewer Builder
cd /d "%~dp0"
echo.
echo  =============================================
echo   ChessReviewer - Standalone Builder (Tauri)
echo  =============================================
echo.

REM Verify Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found. Please install Node.js.
    pause
    exit /b 1
)

REM Verify Rust/Cargo is installed
cargo --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Rust/Cargo not found. Please install Rust from https://rustup.rs/
    pause
    exit /b 1
)

REM Install dependencies if node_modules doesn't exist
if not exist "node_modules" (
    echo  [SETUP] Installing Node.js dependencies...
    call npm install
    echo.
)

echo  [BUILD] Compiling Tauri standalone app...
call npm run tauri build

echo.
echo  =============================================
echo   Build finished!
echo   Standalone EXE location: src-tauri\target\release\ChessReviewer.exe
echo   Installers location:     src-tauri\target\release\bundle\
echo  =============================================
echo.
pause
