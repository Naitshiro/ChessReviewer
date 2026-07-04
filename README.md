# ♟ ChessReviewer

A free, local chess game review and real-time analysis tool. An open alternative to chess.com's premium review features, powered by Stockfish.

This version is built entirely with **Rust + Tauri**, eliminating any Python dependencies.

## Features

- **Game Review** — Paste any PGN and get full move-by-move Stockfish analysis
- **Move Classification** — Brilliant (!!) · Great (!) · Best · Excellent · Good · Inaccuracy · Mistake · Blunder · Book
- **Accuracy Score** — CAPS2-style accuracy percentage for White and Black
- **Live Analysis** — Drag a piece to deviate from the game and get real-time 3-line engine analysis (MultiPV)
- **Evaluation Bar** — Visual win probability indicator
- **Win Probability Chart** — Move-by-move graph of game trajectory

## Requirements

- **Node.js** (LTS version recommended)
- **Rust and Cargo** (from [rustup.rs](https://rustup.rs/))
- **Stockfish chess engine binary** (free download)

## Setup

### 1. Download Stockfish

Download from [stockfishchess.org/download](https://stockfishchess.org/download/) and extract the zip.

### 2. Configure Stockfish Path

Edit `config.json` in the project root and set the path to your Stockfish executable (use double backslashes `\\` or forward slashes `/`):

```json
{
  "stockfish_path": "C:\\ChessEngines\\stockfish\\stockfish-windows-x86-64-avx2.exe",
  "engine_threads": 4,
  "engine_hash_mb": 2048,
  "analysis_depth": 12,
  "server_host": "127.0.0.1",
  "server_port": 8000
}
```

### 3. Start the Application

Simply double-click **`start.bat`**.

On first run, it will automatically:
1. Detect Node.js and Rust environments
2. Install npm dependencies
3. Launch the application in Tauri Developer Mode

---

## Manual Start (without start.bat)

```bash
# Install npm dependencies
npm install

# Run the Tauri application in developer mode
npm run tauri dev
```

## Compilation / Building (Standalone App)

Double-click **`build_portable.bat`** or run:

```bash
npm run tauri build
```

The resulting standalone executable will be located in:
`src-tauri\target\release\ChessReviewer.exe`

---

## Move Classification Formulas

| Formula | Description |
|---|---|
| `P = 1 / (1 + exp(-0.004 * cp))` | Win probability from centipawns |
| `Delta = P_best - P_played` | Probability loss for the move |
| `Accuracy = 100 × (1 - tanh(2.5 × avg(Delta)))` | CAPS2 game accuracy |

| Class | Delta Threshold |
|---|---|
| Brilliant (!!) | Delta < 0.02, only obvious best move, sacrifices material, remains winning |
| Great (!) | Delta < 0.02, only obvious best move |
| Best | Delta = 0 |
| Excellent | Delta < 0.02 |
| Good | Delta < 0.05 |
| Inaccuracy | Delta < 0.10 |
| Mistake | Delta < 0.20 |
| Blunder | Delta ≥ 0.20 |

---

## Tech Stack

- **Tauri Core**: Rust · Axum · tokio · shakmaty (chess logic)
- **Engine**: Stockfish (local binary via UCI protocol over stdin/stdout)
- **Frontend**: Vanilla HTML5/JS · cm-chessboard v8 · chess.js v1 · Chart.js v4