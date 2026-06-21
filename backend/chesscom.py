import urllib.request
import urllib.error
import json
import logging

logger = logging.getLogger(__name__)

def fetch_chesscom_games(username: str):
    headers = {
        "User-Agent": "ChessReviewer/1.0 (https://github.com/Naitshiro/ChessReviewer; contact@example.com)"
    }
    
    # 1. Fetch monthly archives
    url_archives = f"https://api.chess.com/pub/player/{username}/games/archives"
    req = urllib.request.Request(url_archives, headers=headers)
    try:
        with urllib.request.urlopen(req) as res:
            data = json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise ValueError(f"Chess.com user '{username}' not found.")
        raise ValueError(f"Failed to fetch archives: HTTP {e.code}")
    except Exception as e:
        raise ValueError(f"Failed to fetch archives: {str(e)}")
        
    archives = data.get("archives", [])
    if not archives:
        return []
        
    # Get the latest archive
    latest_archive_url = archives[-1]
    
    # 2. Fetch games from the latest archive
    req_games = urllib.request.Request(latest_archive_url, headers=headers)
    try:
        with urllib.request.urlopen(req_games) as res:
            games_data = json.loads(res.read().decode())
    except Exception as e:
        raise ValueError(f"Failed to fetch games from archive: {str(e)}")
        
    games = games_data.get("games", [])
    
    # Format and reverse to get the most recent first
    recent_games = []
    for g in reversed(games):
        if len(recent_games) >= 15:
            break
            
        white = g.get("white", {})
        black = g.get("black", {})
        
        recent_games.append({
            "url": g.get("url"),
            "pgn": g.get("pgn"),
            "time_class": g.get("time_class"),
            "time_control": g.get("time_control"),
            "rated": g.get("rated"),
            "end_time": g.get("end_time"),
            "white": {
                "username": white.get("username"),
                "rating": white.get("rating"),
                "result": white.get("result")
            },
            "black": {
                "username": black.get("username"),
                "rating": black.get("rating"),
                "result": black.get("result")
            }
        })
        
    return recent_games
