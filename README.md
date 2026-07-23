[![Language: Rust](https://img.shields.io/badge/Language-Rust-orange?logo=rust)](https://www.rust-lang.org/)
[![Platform: Cross-platform](https://img.shields.io/badge/Platform-Cross--Platform-0078D4)](https://tauri.app/)
[![Architecture: Multi-Arch](https://img.shields.io/badge/Architecture-Multi--Arch-0078D4)](https://github.com/rust-lang/rust)
[![Status: Active Development](https://img.shields.io/badge/Status-Active-brightgreen)](README.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)


# ♟ ChessReviewer

A free, local chess game review and real-time analysis tool. An open alternative to chess.com's premium review features, powered by Stockfish.

Built entirely with **Rust + Tauri** and **HTML5/JS**, eliminating Python dependencies for fast execution and a small memory footprint.

## Features

- **Game Review** — Paste any PGN and get full move-by-move Stockfish analysis
- **Move Classification** — Brilliant · Great · Best · Excellent · Good · Inaccuracy · Mistake · Blunder · Book
- **Accuracy Score** — CAPS2-style accuracy percentage for White and Black
- **Live Analysis** — Drag a piece to deviate from the game and get real-time 3-line engine analysis (MultiPV)
- **Evaluation Bar** — Visual win probability indicator
- **Win Probability Chart** — Move-by-move graph of game trajectory

---

## Requirements

- **Node.js** (LTS version recommended)
- **Rust and Cargo** (from [rustup.rs](https://rustup.rs/))
- **Stockfish chess engine binary** (free download from [stockfishchess.org](https://stockfishchess.org/download/))

---

## Quick Setup

### 1. Download Stockfish
Download from [stockfishchess.org/download](https://stockfishchess.org/download/) and extract the zip.

### 2. Configure Stockfish & Engine Settings
Open the application and click the **Settings (⚙)** button in the sidebar. Enter your Stockfish executable path (e.g. `C:\stockfish\stockfish.exe`), CPU Threads, and Hash Table Size. Settings are saved automatically!

### 3. Start the Application
Simply double-click **`start_dev.bat`**.

On first run, it will automatically:
1. Detect Node.js and Rust environments
2. Install npm dependencies
3. Launch the application in Tauri Developer Mode

---

## Manual Start & Building

### Manual Development Launch
```bash
# Install npm dependencies
npm install

# Run the Tauri application in developer mode
npm run tauri dev
```

### Compilation / Building (Standalone App)
Double-click **`build_portable.bat`** or run:

```bash
npm run tauri build
```

The resulting executable will be generated at:
`src-tauri/target/release/ChessReviewer.exe`

---

## Move Classification & Evaluation Math

| Formula | Description |
|---|---|
| `P = 1 / (1 + exp(-0.004 * cp))` | Win probability from centipawns |
| `Delta = P_best - P_played` | Probability loss for the move |
| `Accuracy = 100 × (1 - tanh(2.5 × avg(Delta)))` | CAPS2 game accuracy |

| Class | Delta Threshold |
|---|---|
| Brilliant | Delta < 0.02, only obvious best move, sacrifices material, remains winning |
| Great | Delta < 0.02, only obvious best move |
| Best | Delta = 0 |
| Excellent | Delta < 0.02 |
| Good | Delta < 0.05 |
| Inaccuracy | Delta < 0.10 |
| Mistake | Delta < 0.20 |
| Blunder | Delta ≥ 0.20 |

---

## Tech Stack

- **Desktop Framework**: Tauri 1.6
- **Backend / Core Logic**: Rust · Axum · Tokio · Shakmaty (chess engine/PGN handling)
- **Engine Protocol**: Stockfish UCI over standard I/O
- **Frontend**: Vanilla HTML5/JS · `cm-chessboard` v8 · `chess.js` v1 · `Chart.js` v4
