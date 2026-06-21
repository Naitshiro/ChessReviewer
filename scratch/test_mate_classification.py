import sys
import chess

from backend.analysis import get_mate_moves, classify_move

# Test helper
def test_classification():
    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=10000.0, cp_second=10000.0, cp_played=10000.0,
        mate_best=9, mate_played=8
    ) == "best", "Optimal mate (mate in 8 from mate in 9) should be best"
    
    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=10000.0, cp_second=10000.0, cp_played=10000.0,
        mate_best=9, mate_played=7
    ) == "best", "Even better mate (mate in 7 from mate in 9) should be best"

    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=10000.0, cp_second=10000.0, cp_played=10000.0,
        mate_best=9, mate_played=9
    ) == "excellent", "1 off mate (mate in 9 from mate in 9) should be excellent"

    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=10000.0, cp_second=10000.0, cp_played=10000.0,
        mate_best=9, mate_played=15
    ) == "excellent", "7 off mate (mate in 15 from mate in 9) should be excellent"

    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=10000.0, cp_second=10000.0, cp_played=10000.0,
        mate_best=9, mate_played=16
    ) == "good", "8 off mate (mate in 16 from mate in 9) should be good"

    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=-10000.0, cp_second=-10000.0, cp_played=-10000.0,
        mate_best=-5, mate_played=-4
    ) == "best", "Optimal defense (survive 4 moves from mate-in-5) should be best"

    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=-10000.0, cp_second=-10000.0, cp_played=-10000.0,
        mate_best=-5, mate_played=-5
    ) == "best", "Delayed defense (survive 5 moves from mate-in-5) should be best"

    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=-10000.0, cp_second=-10000.0, cp_played=-10000.0,
        mate_best=-5, mate_played=-3
    ) == "excellent", "1 off defense (mated in 3 from mate-in-5) should be excellent"

    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=-10000.0, cp_second=-10000.0, cp_played=-10000.0,
        mate_best=-20, mate_played=-12
    ) == "excellent", "7 off defense (mated in 12 from mate-in-20) should be excellent"

    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=False, is_book=False,
        cp_best=-10000.0, cp_second=-10000.0, cp_played=-10000.0,
        mate_best=-20, mate_played=-11
    ) == "good", "8 off defense (mated in 11 from mate-in-20) should be good"

    # Test cases for brilliant moves vs continuing mate
    # A sacrifice that initiates a mate is Brilliant
    assert classify_move(
        delta=0.0, p_best=0.99, p_second_best=0.95, p_played=0.99, sacrificed=True, is_book=False,
        cp_best=1000.0, cp_second=800.0, cp_played=1000.0,
        mate_best=None, mate_played=5
    ) == "brilliant", "Sacrifice initiating a mate sequence should be brilliant"

    # A sacrifice that continues a mate is NOT Brilliant (it is Best)
    assert classify_move(
        delta=0.0, p_best=1.0, p_second_best=1.0, p_played=1.0, sacrificed=True, is_book=False,
        cp_best=10000.0, cp_second=10000.0, cp_played=10000.0,
        mate_best=6, mate_played=5
    ) == "best", "Sacrifice continuing a mate sequence should NOT be brilliant (should be best)"

    print("All mate classification assertions passed successfully!")

if __name__ == "__main__":
    test_classification()
