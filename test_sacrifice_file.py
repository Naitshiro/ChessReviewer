import chess
from backend.analysis import is_sacrifice
from backend.openings import is_book_move
import sys

with open('test_output.txt', 'w') as f:
    board = chess.Board()
    board.push_san("e4")
    board.push_san("e5")
    
    f.write(f"FEN before 2. Nf3: {board.fen()}\n")
    move = board.parse_san("Nf3")
    
    sacrificed = is_sacrifice(board, move)
    book = is_book_move(board, move)
    
    f.write(f"2. Nf3 -> sacrificed: {sacrificed}, book: {book}\n")
    
    board.push(move)
    board.push_san("f6")
    
    f.write(f"FEN before 3. Nxe5: {board.fen()}\n")
    move_nxe5 = board.parse_san("Nxe5")
    f.write(f"3. Nxe5 -> sacrificed: {is_sacrifice(board, move_nxe5)}, book: {is_book_move(board, move_nxe5)}\n")
