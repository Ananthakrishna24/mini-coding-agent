// A pinned bottom footer: reserve the last rows of the terminal, let everything else scroll above it.
// Native ANSI only — uses the terminal scroll region (DECSTBM) so normal console.log keeps scrolling
// inside rows 1..(bottom) while the footer stays put. No TUI library, no raw mode (readline owns the
// keyboard between runs; the footer only lives during a run), so the two never fight.
//
// Mechanics: set the scroll region to exclude the bottom `h` rows, park the cursor inside it, then
// redraw the footer rows on demand with save/restore-cursor around the writes so logging is unaffected.
// Degrades to nothing off a TTY (piped/CI) — callers print the same content inline instead.

const out = process.stdout;
const isTTY = () => out.isTTY === true && !process.env.NO_COLOR;
const rows = () => out.rows || 24;
const cols = () => out.columns || 80;

const ESC = "\x1b";
const SAVE = `${ESC}7`; // DECSC — save cursor + attrs
const RESTORE = `${ESC}8`; // DECRC
const RESET_REGION = `${ESC}[r`; // scroll region back to the full screen

let footer: string[] = []; // current footer rows (already styled + clipped by the caller)
let active = false;
let regionBottom = 0; // last row the scroll region ends at

function clipVisible(s: string, width: number): string {
  // Trim to `width` visible columns, ignoring ANSI; a footer row must never wrap or it desyncs the area.
  let vis = 0;
  let i = 0;
  while (i < s.length && vis < width) {
    if (s[i] === ESC) {
      const m = /\x1b\[[0-9;]*m/y;
      m.lastIndex = i;
      const hit = m.exec(s);
      if (hit) {
        i += hit[0].length;
        continue;
      }
    }
    vis++;
    i++;
  }
  return s.slice(0, i) + (vis >= width ? `${ESC}[0m` : "");
}

function draw() {
  if (!active) return;
  let buf = SAVE;
  for (let r = 0; r < footer.length; r++) {
    buf += `${ESC}[${regionBottom + 1 + r};1H`; // move to footer row r
    buf += `${ESC}[2K`; // clear it
    buf += clipVisible(footer[r], cols());
    // never emit a newline on the very last screen row — it would scroll the whole screen
  }
  buf += RESTORE;
  out.write(buf);
}

// Reserve `lines.length` rows at the bottom and draw them. Recomputes the region each call so a plan
// that grows/shrinks just works. Returns false off a TTY so the caller can fall back to inline output.
export function setFooter(lines: string[]): boolean {
  if (!isTTY()) return false;
  const h = lines.length;
  if (h === 0 || h >= rows() - 2) {
    clearFooter(); // too tall to pin safely — give the space back
    return false;
  }
  footer = lines;
  const newBottom = rows() - h;

  if (!active || newBottom !== regionBottom) {
    if (!active) out.write("\n".repeat(h)); // scroll existing content up to make room (once)
    regionBottom = newBottom;
    out.write(`${ESC}[1;${regionBottom}r`); // set scroll region to rows 1..regionBottom
    out.write(`${ESC}[${regionBottom};1H`); // park the cursor at the bottom of the region
    active = true;
  }
  draw();
  return true;
}

export function clearFooter() {
  if (!active) return;
  let buf = SAVE;
  for (let r = 0; r < footer.length; r++) buf += `${ESC}[${regionBottom + 1 + r};1H${ESC}[2K`; // wipe footer rows
  buf += RESET_REGION + RESTORE;
  out.write(buf);
  active = false;
  footer = [];
}

// Reset the scroll region no matter what — call on exit so Ctrl-C never leaves the terminal with a
// stuck region. Safe to call when inactive.
export function cleanup() {
  if (out.isTTY) out.write(RESET_REGION);
  active = false;
}

// A late resize means the old region math is stale; re-pin the same footer at the new size.
if (out.isTTY) out.on("resize", () => active && setFooter(footer));
