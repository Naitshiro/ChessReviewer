@echo off
cd /d "C:\Users\Christian Leone\Documents\Projects\ChessReviewer\src-tauri"
cargo check --message-format short 2> "C:\Users\Christian Leone\chess_errors.txt" 1>> "C:\Users\Christian Leone\chess_errors.txt"
echo Exit code: %ERRORLEVEL% >> "C:\Users\Christian Leone\chess_errors.txt"
