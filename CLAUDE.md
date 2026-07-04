# Development Environment Guidelines

## Terminal Commands
- Coreutils for Windows is installed, so you can safely use standard Linux-style terminal commands (like `ls`, `grep`, `cat`, `find`, etc.) in the bash tool.
- These commands work with standard Unix path conventions (forward slashes) in the terminal environment.

## File Manipulation Tools (CRITICAL)
- Despite Coreutils availability, INTERNAL file manipulation tools (Read, Write, Edit, etc.) MUST still use absolute Windows backslash paths (e.g., `C:\path\to\file`).
- Using Unix-style paths or relative paths with these tools will cause failures and errors.
- Examples of correct paths: `C:\Users\Christian Leone\Documents\Projects\ChessReviewer\frontend\styles.css`

## Line Endings
- Handle Windows line endings (CRLF, `\r\n`) carefully; preserve existing line endings and avoid introducing lone `\n` or malformed sequences.
- When editing files, match the exact line ending style of the file. Replace sequences with proper `\r\n` for Windows files.
- Avoid literal `\n` characters in replacement strings; use `\r\n` for files that use Windows line endings.

## Path Handling Best Practices
- Use double backslashes (`\\`) in string literals for Windows paths in code, or forward slashes (`/`) which are also supported in most contexts.
- When copying text from external sources, convert line endings to the file's native format before writing.
- Check for mixed line endings in legacy files and normalize them to consistent CRLF (`\r\n`) before making changes.
- Use tools like `dos2unix` or text editors with line ending awareness to inspect and convert line endings if needed.
- When in doubt, verify line endings with `cat -A file.txt` (Linux) or a hex editor; in Windows, view in a plain text editor that shows CR/LF.
- Ensure all generated output respects the file's established line ending convention to prevent diff failures and format inconsistencies.

**Why:** Consistent path handling for internal tools prevents edit failures, while leveraging Coreutils for terminal commands provides a familiar Unix-like experience. Proper line ending management prevents version control noise in cross-platform environments.

## Development & Build Commands
- **Run in Developer Mode**: `npm run tauri dev` (or run `start.bat`)
- **Compile Production Release**: `npm run tauri build` (or run `build_portable.bat`)
- **Check Rust Code**: Run `cargo check` inside `src-tauri` directory