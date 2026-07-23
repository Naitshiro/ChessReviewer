[![Language: Rust](https://img.shields.io/badge/Language-Rust-orange?logo=rust)](https://www.rust-lang.org/)
[![Platform: Cross-platform](https://img.shields.io/badge/Platform-Cross--Platform-0078D4)](https://tauri.app/)
[![Architecture: Multi-Arch](https://img.shields.io/badge/Architecture-Multi--Arch-0078D4)](https://github.com/rust-lang/rust)
[![Status: Active Development](https://img.shields.io/badge/Status-Active-brightgreen)](README.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)


# ♟ ChessReviewer

A free, local chess game review and real-time analysis desktop application powered by Stockfish. Built with Rust, Tauri, and HTML/JS.

## Features

- **Game Review** — Move-by-move Stockfish analysis for PGN files.
- **Move Classification** — Brilliant, Great, Best, Excellent, Good, Inaccuracy, Mistake, Blunder, Book.
- **Accuracy Score** — CAPS2-style move accuracy calculation.
- **Live Analysis** — Interactive board for exploring variations with real-time multi-PV engine output.
- **Evaluation Bar & Chart** — Visual win probability bar and move-by-move evaluation graph.
- **Training Mode** — Play vs Stockfish (customizable ELO), tactics puzzles, and opening rehearsal.

## Requirements

- **Node.js** (LTS)
- **Rust and Cargo** ([rustup.rs](https://rustup.rs/))
- **Stockfish engine binary** ([stockfishchess.org](https://stockfishchess.org/download/))

## Setup

1. Download and extract Stockfish from [stockfishchess.org](https://stockfishchess.org/download/).
2. Run the application (`npm run tauri dev`).
3. Open **Settings (⚙)** in the sidebar and set your Stockfish executable path, CPU thread count, and RAM hash size.

## Development & Building

### Run in Dev Mode
```bash
npm install
npm run tauri dev
```

### Build Executable
```bash
npm run tauri build
```
Built binaries are output to `src-tauri/target/release/`.

## Move Classification Math

| Metric | Formula |
|---|---|
| Win Probability | `P = 1 / (1 + exp(-0.004 * cp))` |
| Win Probability Loss | `Delta = P_best - P_played` |
| Accuracy | `Accuracy = 100 × (1 - tanh(2.5 × avg(Delta)))` |

| Classification | Condition |
|---|---|
| Brilliant | `Delta < 0.02`, material sacrifice, remains winning |
| Great | `Delta < 0.02`, single winning move |
| Best | `Delta = 0` |
| Excellent | `Delta < 0.02` |
| Good | `Delta < 0.05` |
| Inaccuracy | `Delta < 0.10` |
| Mistake | `Delta < 0.20` |
| Blunder | `Delta ≥ 0.20` |

## Tech Stack

- **Desktop Framework**: Tauri
- **Backend**: Rust (Axum, Tokio, Shakmaty)
- **Engine Protocol**: Stockfish UCI
- **Frontend**: HTML5/JS, `cm-chessboard`, `chess.js`, `Chart.js`
