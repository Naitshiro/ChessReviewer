import json
import requests

pgn = """[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.06.14"]
[Round "-"]
[White "Natisfaction"]
[Black "muneer_qureshi7_786"]
[Result "0-1"]
[CurrentPosition "4k1nr/5ppp/1p4r1/p1p1p3/2PnP3/3BRPPP/P5K1/R3Q3 w k - 3 29"]
[Timezone "UTC"]
[ECO "C40"]
[ECOUrl "https://www.chess.com/openings/Kings-Pawn-Opening-Kings-Knight-Variation"]
[UTCDate "2026.06.14"]
[UTCTime "08:00:35"]
[WhiteElo "100"]
[BlackElo "194"]
[TimeControl "180"]
[Termination "muneer_qureshi7_786 won on time"]
[StartTime "08:00:35"]
[EndDate "2026.06.14"]
[EndTime "08:06:43"]
[Link "https://www.chess.com/game/live/170171258796"]

1. e4 {[%clk 0:02:59.9]} 1... e5 {[%clk 0:02:57.7]} 2. Nf3 {[%clk 0:02:58.1]} 2... Bc5 {[%clk 0:02:57.2]} 3. Qe2 {[%clk 0:02:49.7]} 3... d5 {[%clk 0:02:54.7]} 4. d3 {[%clk 0:02:40.3]} 4... Bg4 {[%clk 0:02:51.3]} 5. h3 {[%clk 0:02:35.8]} 5... Bxf3 {[%clk 0:02:47.4]} 6. Qxf3 {[%clk 0:02:32.5]} 6... dxe4 {[%clk 0:02:42.9]} 7. dxe4 {[%clk 0:02:31.3]} 7... Qd7 {[%clk 0:02:34.1]} 8. Bd3 {[%clk 0:02:22.2]} 8... Bb4+ {[%clk 0:02:32.5]} 9. Bd2 {[%clk 0:02:19.8]} 9... a5 {[%clk 0:02:29.8]} 10. O-O {[%clk 0:02:18]} 10... Qd4 {[%clk 0:02:21]} 11. c3 {[%clk 0:02:11.4]} 11... Qd7 {[%clk 0:02:03]} 12. c4 {[%clk 0:02:01]} 12... Bxd2 {[%clk 0:02:00.7]} 13. Nxd2 {[%clk 0:01:59.4]} 13... Qd4 {[%clk 0:01:55.2]} 14. Nb3 {[%clk 0:01:50.6]} 14... Qxb2 {[%clk 0:01:50.7]} 15. g3 {[%clk 0:01:33.2]} 15... Nc6 {[%clk 0:01:41.3]} 16. Nc5 {[%clk 0:01:23.5]} 16... Nd4 {[%clk 0:01:39.4]} 17. Qd1 {[%clk 0:00:57.1]} 17... b6 {[%clk 0:01:31.4]} 18. Qb1 {[%clk 0:00:43.6]} 18... Qc3 {[%clk 0:01:16]} 19. Rc1 {[%clk 0:00:22.7]} 19... Qd2 {[%clk 0:01:03.6]} 20. Rd1 {[%clk 0:00:19.4]} 20... Qh6 {[%clk 0:00:50.1]} 21. Nb7 {[%clk 0:00:14.6]} 21... Rb8 {[%clk 0:00:35]} 22. f3 {[%clk 0:00:08.5]} 22... Qe3+ {[%clk 0:00:28.1]} 23. Kg2 {[%clk 0:00:06.9]} 23... Rxb7 {[%clk 0:00:20.7]} 24. Qc2 {[%clk 0:00:04.4]} 24... Rb8 {[%clk 0:00:16.1]} 25. Qc3 {[%clk 0:00:01.5]} 25... Rd8 {[%clk 0:00:13.4]} 26. Re1 {[%clk 0:00:01.1]} 26... c5 {[%clk 0:00:12.1]} 27. Rxe3 {[%clk 0:00:00.6]} 27... Rd6 {[%clk 0:00:10.3]} 28. Qe1 {[%clk 0:00:00.2]} 28... Rg6 {[%clk 0:00:09]} 0-1"""

response = requests.post("http://127.0.0.1:8000/api/analyze", json={"pgn": pgn, "depth": 10})
# Wait, this is streaming NDJSON.
for line in response.iter_lines():
    if line:
        data = json.loads(line)
        if data["type"] == "result":
            print(data["data"]["accuracy"])
