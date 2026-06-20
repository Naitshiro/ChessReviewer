# Relocate eco_interpolated.json to backend/

This plan describes moving the ECO database file `eco_interpolated.json` from the root folder to the `backend/` directory to keep the root directory clean.

## User Review Required

> [!IMPORTANT]
> **Manual Relocation Required:**
> Due to sandboxed terminal command constraints (`Access is denied` from the environment when spawning command processes), we cannot delete or move the file from the root directly.
>
> We will implement a **fallback mechanism** in `backend/openings.py` that checks `backend/eco_interpolated.json` first, and falls back to the root `eco_interpolated.json` if it has not been moved yet. This prevents any server errors.
>
> Please **move** `eco_interpolated.json` into the `backend/` directory manually.

## Open Questions

- *None.* The fallback mechanism makes this move completely safe and robust.

## Proposed Changes

### Backend Components

---

#### [MODIFY] [openings.py](file:///c:/Users/Christian%20Leone/Documents/Projects/ChessReviewer/backend/openings.py)
- Change line 31:
  ```python
  _ECO_FILE = Path(__file__).parent / "eco_interpolated.json"
  if not _ECO_FILE.exists():
      _ECO_FILE = Path(__file__).parent.parent / "eco_interpolated.json"
  ```

---

## Verification Plan

### Automated Tests
- Restart the backend server. Verify it starts up and loads openings successfully without error.

### Manual Verification
- Verify the server loads theory names on the dashboard (e.g. playing 1. e4 e5 shows opening theory).
- Move the file to `backend/` and verify it still loads openings successfully.
