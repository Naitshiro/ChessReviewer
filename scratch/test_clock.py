import chess.pgn
import io

pgn_text = """[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.06.21"]
[Round "?"]
[White "SH1150"]
[Black "Naitshiro"]
[Result "0-1"]
[WhiteElo "503"]
[BlackElo "536"]
[TimeControl "5|5"]

1. e4 {[%clk 0:05:35]} c6 {[%clk 0:05:34]} 2. Nf3 {[%clk 0:05:33]} d5 {[%clk 0:05:32]} 0-1"""

pgn = chess.pgn.read_game(io.StringIO(pgn_text))
for node in pgn.mainline():
    print(f"Move: {node.san()}, clock(): {node.clock()}, type: {type(node.clock())}")
