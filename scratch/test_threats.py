import asyncio
import chess
from backend.analysis import generate_null_move_fen
from backend.engine import EngineManager

async def main():
    print("Testing generate_null_move_fen...")
    # Test FEN flipping and en passant removal
    start_fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
    flipped = generate_null_move_fen(start_fen)
    print(f"Original: {start_fen}")
    print(f"Flipped:  {flipped}")
    
    # Assert turn flipped and en passant cleared
    assert " w KQkq - " in flipped, "Turn should be 'w' and en passant should be '-' in flipped FEN"
    print("FEN-flipping test passed!")
    
    print("\nInitializing EngineManager...")
    manager = await EngineManager.get_instance()
    
    # Position with a clear threat: Black has a mating threat or a piece capture
    # Let's test a position: Scholar's mate threat.
    # 1. e4 e5 2. Qh5 Nc6 3. Bc4
    # White threatens 4. Qxf7#
    board = chess.Board()
    board.push_san("e4")
    board.push_san("e5")
    board.push_san("Qh5")
    board.push_san("Nc6")
    board.push_san("Bc4")
    # It is Black's turn. FEN: rnbqkbnr/pppp1ppp/8/2b1p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3
    # Wait, let's play Nf6 (ignoring the threat).
    # White is threatening Qxf7# (mate).
    # White's evaluation is very high if White delivers mate.
    # Let's play Nf6.
    board.push_san("Nf6")
    # Now it is White's turn to move. White can play Qxf7# (mate).
    # FEN: r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4
    # Current eval from White's perspective (since it's White's turn) is high because White has a forced mate.
    # If White passes (Null Move FEN), Black can play Nxe4 or similar, and White has no mate.
    # So evaluation will drop drastically from +10000 (mate) or high value to near equal.
    # fen = board.fen()
    print(f"Testing threats on FEN: {board.fen()}")
    
    # Assume current evaluation is +800 cp (White is winning/mating)
    threats = await manager.calculate_threats(board.fen(), 800.0)
    print(f"Calculated threats: {threats}")
    
    # We expect Qxf7 to be one of the threat moves (multipv 1, 2, or 3)
    # Wait! Black's best move in the Null Move position is the threat, which is Qxf7 from Black's side?
    # No! Flipped FEN turn makes it Black's turn to move. So Black is moving in the null move FEN.
    # What does Black threaten? If White skips, Black moves. Black's best moves are threats against White.
    # Let's see: in this FEN, Black to move can capture on e4 (Nxe4) or play Bc5 etc.
    # Wait! Let's check who is threatening whom.
    # On FEN: r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4
    # It is White's turn. White threatens Qxf7# (mate).
    # Wait! The "threat assessment" calculates *opponent's* threats!
    # That means: if White passes (turns it into Black's turn), what can Black do?
    # Black can play Nxe4 etc.
    # Is Black threatening anything? Not really, White is the one threatening.
    # Let's test a position where Black is threatening White.
    # E.g. White just played a move and left a piece hanging or allowed a mate.
    # 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7 Kxf7 7. Qf3+ Ke6
    # Or simpler: Black threatens White's Queen.
    # 1. e4 d5 2. exd5 Qxd5 3. Nc3 Qd8
    # Let's check a simple hanging queen:
    # White plays Qd1-d5, Black's knight can capture it.
    board2 = chess.Board()
    board2.push_san("e4")
    board2.push_san("d5")
    board2.push_san("Qd4") # White puts queen in center
    # Now it is Black's turn. Black's knight or pawn can attack it, or Nc6 threatens the queen.
    # Let's play Nc6.
    board2.push_san("Nc6") # Black threatens White's queen on d4
    # Now it is White's turn. FEN: r1bqkbnr/ppp1pppp/2n5/3p4/3QP3/8/PPPP1PPP/RNB1KBNR w KQkq - 1 3
    # If White makes a normal move, White's queen is safe. But if White passes (Null Move), Black can play Nxd4 (capturing the queen!).
    # So Nxd4 should be a major threat!
    fen2 = board2.fen()
    print(f"Testing threats on FEN2 (hanging queen): {fen2}")
    
    # White's queen is on d4, Nc6 is threatening it.
    # Let's say White's current evaluation is +50 cp.
    threats2 = await manager.calculate_threats(fen2, 50.0)
    print(f"Threats found: {threats2}")
    
    assert len(threats2) > 0, "Threats list should not be empty"
    # The top threat should be c6d4 (Nxd4)
    found_nxd4 = any(t["from"] == "c6" and t["to"] == "d4" for t in threats2)
    assert found_nxd4, "Black's Nxe4/Nxd4 capturing the queen should be flagged as a threat!"
    print("Threat assessment test passed successfully!")
    
    await manager.shutdown()

if __name__ == "__main__":
    asyncio.run(main())
