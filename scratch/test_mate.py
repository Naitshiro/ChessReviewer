import chess
import chess.engine

score_m1 = chess.engine.Mate(1)
score_m10 = chess.engine.Mate(10)

print("M1 score():", score_m1.score(mate_score=10000))
print("M10 score():", score_m10.score(mate_score=10000))
