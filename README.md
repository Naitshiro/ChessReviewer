# ♟ ChessReviewer

A free, local chess game review and real-time analysis tool. An open alternative to chess.com's premium review features, powered by Stockfish.

## Features

- **Game Review** — Paste any PGN and get full move-by-move Stockfish analysis
- **Move Classification** — Brilliant (!!) · Great (!) · Best · Excellent · Good · Inaccuracy · Mistake · Blunder · Book
- **Accuracy Score** — CAPS2-style accuracy percentage for White and Black
- **Live Analysis** — Drag a piece to deviate from the game and get real-time 3-line engine analysis (MultiPV)
- **Evaluation Bar** — Visual win probability indicator
- **Win Probability Chart** — Move-by-move graph of game trajectory

## Requirements

- Python 3.11 or newer
- Stockfish chess engine binary (free download)

## Setup

### 1. Download Stockfish

Download from [stockfishchess.org/download](https://stockfishchess.org/download/) and extract the zip.

### 2. Configure Stockfish Path

Edit `config.json` in the project root and set the path to your Stockfish executable:

```json
{
  "stockfish_path": "C:/ChessEngines/stockfish/stockfish-windows-x86-64-avx2.exe",
  "engine_threads": 2,
  "engine_hash_mb": 128,
  "analysis_depth": 18
}
```

> **Tip:** The app will also read a `STOCKFISH_PATH` environment variable, or fall back to `stockfish/stockfish.exe` relative to the project root.

### 3. Start the Application

Simply double-click **`start.bat`**.

On first run, it will automatically:
1. Create a Python virtual environment
2. Install dependencies from `requirements.txt`
3. Start the server

Then open your browser to: **http://127.0.0.1:8000**

## Manual Start (without start.bat)

```bash
# Create and activate venv
python -m venv .venv
.venv\Scripts\activate

# Install deps
pip install -r requirements.txt

# Start server
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

## Usage

1. **Analyze a Game**: Paste a PGN into the text area and click **Analyze**.
   - Supports full PGN with headers, or just a bare move list like `1. e4 e5 2. Nf3 Nc6`
2. **Review Moves**: Use the ◀▶ buttons or arrow keys to step through the game
3. **Live Analysis**: While reviewing, drag a piece to a *different* square than the game move to fork into Live Analysis Mode. Engine arrows show the top 3 candidate moves in real time.
4. **Return to Review**: Click **"Back to Game Review"** to exit live analysis.

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

## Configuration Options

| Key | Default | Description |
|---|---|---|
| `stockfish_path` | `""` | Absolute path to Stockfish executable |
| `engine_threads` | `2` | CPU threads for Stockfish |
| `engine_hash_mb` | `128` | Hash table size in MB |
| `analysis_depth` | `18` | Search depth for batch analysis |
| `server_host` | `127.0.0.1` | Bind address |
| `server_port` | `8000` | HTTP/WS port |

## Tech Stack

- **Backend**: Python 3.11 · FastAPI · python-chess · uvicorn
- **Engine**: Stockfish (local binary via UCI protocol)
- **Frontend**: Vanilla HTML5/JS · Tailwind CSS v3 CDN · cm-chessboard v8 · chess.js v1 · Chart.js v4