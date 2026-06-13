import chess
from backend.analysis import is_sacrifice
from backend.openings import is_book_move

board = chess.Board()
board.push_san("e4")
board.push_san("e5")

print("FEN before 2. Nf3:", board.fen())
move = board.parse_san("Nf3")

sacrificed = is_sacrifice(board, move)
book = is_book_move(board, move)

print("2. Nf3 -> sacrificed:", sacrificed, "book:", book)

board.push(move)
board.push_san("f6")

print("FEN before 3. Nxe5:", board.fen())
move_nxe5 = board.parse_san("Nxe5")
print("3. Nxe5 -> sacrificed:", is_sacrifice(board, move_nxe5), "book:", is_book_move(board, move_nxe5))

