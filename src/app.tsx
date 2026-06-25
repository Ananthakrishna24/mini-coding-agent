// The interactive Ink UI: a chat interface. Scrollback (banner, your lines, tool calls, results)
// lives in <Static> so it commits once and scrolls naturally; the live region below holds the
// plan/status footer and the input with its "/" command menu. State comes from store.ts.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, Static, useApp, useInput, useStdout } from "ink";
import { store, submit, COMMANDS, closePicker, pickerMove, pickerFilter, pickerSelect, closeResumePicker, resumePickerMove, resumePickerSelect, policyPickerMove, policyPickerSelect, policyPickerCancel, POLICY_OPTIONS, closeColorPicker, colorPickerMove, colorPickerSelect, closeEffortPicker, effortPickerMove, effortPickerSelect, finishSetup, EFFORT_LEVELS, toggleExpandLast, type Item, type Picker, type ResumePicker } from "./store";
import { c, describeModel, toolEntry, resultBody, iconize, getPrimaryColor, getShimmerColor, COLOR_PRESETS, paintHex, subHeader, rail, shimmerSweep, treeStart } from "./format";
import { clipboardImageToTemp } from "./images";
import { matchFiles } from "./tools/workspace";
import { Onboarding } from "./onboarding";

const indent = (s: string) => `  ${s}`;

const FILE_MENU = 8; // rows shown in the @-file picker
const EXPANDED_ROWS = 32; // max rows when a tool item is expanded via Ctrl+O

function ItemView({ item }: { item: Item }) {
  const r = rail(item.depth ?? 0); // left gutter that nests a subagent's items one level in
  const ind = (s: string) => `  ${r}${s}`;
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text>{`${c.primary("›")} ${c.bold(item.text)}`}</Text>
        </Box>
      );
    case "warn":
      return <Text>{ind(c.yellow(`! ${item.text}`))}</Text>;
    case "info":
      return (
        <Box flexDirection="column" marginTop={1}>
          {item.lines.map((l, i) => (
            <Text key={i}>{ind(l)}</Text>
          ))}
        </Box>
      );
    case "subagent":
      return (
        <Box marginTop={1}>
          <Text>{`  ${r}${treeStart(true)} ${subHeader(item.goal)}`}</Text>
        </Box>
      );
    case "tool": {
      const { header, rows } = toolEntry(item.name, item.args, item.result);
      const maxRows = item.expanded ? EXPANDED_ROWS : rows.length;
      const shown = rows.slice(0, maxRows);
      const hidden = rows.length - maxRows;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>{ind(header)}</Text>
          {shown.map((row, i) => (
            <Text key={i}>{`    ${r}${c.dim(i === 0 ? "⎿" : " ")} ${row}`}</Text>
          ))}
          {hidden > 0 && <Text>{`    ${r}${c.dim(`  … +${hidden} lines (Ctrl+O to expand)`)}`}</Text>}
        </Box>
      );
    }
    case "result": {
      const mark = item.success ? c.green("✓") : c.red("✗");
      const took = c.dim(`(${(item.ms / 1000).toFixed(1)}s)`);
      const body = resultBody(item.summary);
      return (
        <Box flexDirection="column" marginTop={1}>
          {body.length === 1 ? (
            <Text>{ind(`${mark} ${body[0]}  ${took}`)}</Text>
          ) : (
            <>
              <Text>{ind(`${mark} ${took}`)}</Text>
              {body.map((l, i) => (
                <Text key={i}>{ind(l)}</Text>
              ))}
            </>
          )}
        </Box>
      );
    }
  }
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function Spinner({ label }: { label: string }) {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((n) => n + 1), 80);
    return () => clearInterval(t);
  }, []);
  const shimmer = Math.floor(f / 4) % 2 === 0;
  const paint = shimmer ? (s: string) => paintHex(getShimmerColor(), s) : c.primary;
  return <Text>{`${paint(SPIN[f % SPIN.length])} ${c.dim(`${label}…`)}`}</Text>;
}

// Live status under the scrollback: spinner while working and the plan checklist.
function Footer() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const planRows = s.plan.slice(0, 8);
  return (
    <Box flexDirection="column" marginTop={1}>
      {s.spinner && (
        <Box>
          <Text>{"  "}</Text>
          <Spinner label={s.spinner} />
        </Box>
      )}
      {s.plan.length > 0 && (
        <>
          <Text>{indent(c.dim(`Plan ▸ ${s.planDone}/${s.planTotal}`))}</Text>
          {planRows.map((l, i) => (
            <Text key={i}>{indent(iconize(l))}</Text>
          ))}
          {s.plan.length > 8 && <Text>{indent(c.dim(`… +${s.plan.length - 8} more`))}</Text>}
        </>
      )}
      {s.modelLabel && <Text>{indent(c.dim(s.modelLabel))}</Text>}
    </Box>
  );
}

// The /model picker: a filter line plus a scrolling, highlighted list (a viewport around the cursor).
const VIEW = 8;
function PickerView({ picker }: { picker: Picker }) {
  const { items, sel, query, loading } = picker;
  const start = Math.max(0, Math.min(sel - Math.floor(VIEW / 2), Math.max(0, items.length - VIEW)));
  const view = items.slice(start, start + VIEW);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{`${c.primary("◉ pick a model")}  ${c.dim("↑↓ choose · type to filter · ⏎ select · esc cancel")}`}</Text>
      <Text>{`  ${c.dim("filter:")} ${query || c.dim("(all tool-capable)")}`}</Text>
      {loading ? (
        <Text>{c.dim("  loading catalog…")}</Text>
      ) : items.length === 0 ? (
        <Text>{c.yellow("  no matching tool-capable models")}</Text>
      ) : (
        view.map((m, i) => {
          const active = start + i === sel;
          return (
            <Text key={m.id} color={active ? getPrimaryColor() : undefined}>
              {`  ${active ? "›" : " "} ${describeModel(m, m.id)}`}
            </Text>
          );
        })
      )}
      {items.length > VIEW && <Text>{`  ${c.dim(`${sel + 1}/${items.length}`)}`}</Text>}
    </Box>
  );
}

// The /resume picker: a scrolling list of past chat sessions (most recent first). Same keys as /model.
function ResumePickerView({ picker }: { picker: ResumePicker }) {
  const { items, sel } = picker;
  const start = Math.max(0, Math.min(sel - Math.floor(VIEW / 2), Math.max(0, items.length - VIEW)));
  const view = items.slice(start, start + VIEW);
  const ago = (t: number) => {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{`${c.primary("◉ resume a chat")}  ${c.dim("↑↓ choose · ⏎ resume · esc cancel")}`}</Text>
      {view.map((s, i) => {
        const active = start + i === sel;
        const title = (s.title || "(untitled)").slice(0, 56);
        return (
          <Text key={s.id} color={active ? getPrimaryColor() : undefined}>
            {`  ${active ? "›" : " "} ${title}  ${c.dim(`${ago(s.updated)} · ${s.cwd.replace(process.env.HOME ?? "~", "~")}`)}`}
          </Text>
        );
      })}
      {items.length > VIEW && <Text>{`  ${c.dim(`${sel + 1}/${items.length}`)}`}</Text>}
    </Box>
  );
}

// The /colors picker: each preset swatched in its own color, the active one marked. Same keys as /model.
function ColorPickerView({ sel }: { sel: number }) {
  const cur = getPrimaryColor();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{`${c.primary("◉ pick a color")}  ${c.dim("↑↓ choose · ⏎ select · esc cancel")}`}</Text>
      {COLOR_PRESETS.map((p, i) => {
        const active = i === sel;
        const nameStr = p.name.padEnd(8);
        const marker = active ? c.primary("›") : " ";
        const dot = paintHex(p.hex, p.hex === cur ? "●" : "○");
        const shimmerDot = paintHex(p.shimmer, "○");
        const name = active ? c.bold(nameStr) : nameStr;
        return (
          <Text key={p.hex}>{`  ${marker} ${dot}${shimmerDot} ${name} ${c.dim(p.hex)}`}</Text>
        );
      })}
      <Text>{c.dim("  custom: /colors #rrggbb")}</Text>
    </Box>
  );
}

// The model-policy overlay, shown once on the first delegation. Same keys as /colors.
function PolicyPickerView({ sel }: { sel: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{`${c.primary("◉ model policy for subagents")}  ${c.dim("↑↓ choose · ⏎ set · esc = current model")}`}</Text>
      <Text>{c.dim("  asked once this session — how should delegated subagents pick a model?")}</Text>
      {POLICY_OPTIONS.map((opt, i) => {
        const active = i === sel;
        const marker = active ? c.primary("›") : " ";
        const label = active ? c.bold(opt.label) : opt.label;
        return <Text key={opt.value}>{`  ${marker} ${label}`}</Text>;
      })}
    </Box>
  );
}

// The reasoning-effort picker, shown right after a reasoning model is chosen. Same keys as /colors.
function EffortPickerView({ sel }: { sel: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{`${c.primary("◉ reasoning effort")}  ${c.dim("↑↓ choose · ⏎ select · esc keep default")}`}</Text>
      {EFFORT_LEVELS.map((level, i) => {
        const active = i === sel;
        const marker = active ? c.primary("›") : " ";
        const name = active ? c.bold(level) : level;
        return <Text key={level}>{`  ${marker} ${name}`}</Text>;
      })}
    </Box>
  );
}

// Animated prompt border: left-to-right shimmer sweep on top/bottom lines while busy.
// No left/right borders — matching the reference's open-side layout.
function useShimmerBorder(width: number, busy: boolean) {
  const [pos, setPos] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setPos((n) => (n + 1) % (width + 20)), 50);
    return () => clearInterval(t);
  }, [busy, width]);

  const bar = "─".repeat(width);
  if (!busy) {
    const line = c.primary(bar);
    return { top: line, bot: line };
  }
  const base = getPrimaryColor();
  const glow = getShimmerColor();
  const sweepPos = pos - 10;
  return {
    top: shimmerSweep(bar, sweepPos, base, glow),
    bot: shimmerSweep(bar, sweepPos, base, glow),
  };
}


function Prompt() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const busy = s.busy;
  const [buf, setBuf] = useState("");
  const [sel, setSel] = useState(0);
  const [fileSel, setFileSel] = useState(0);

  const termW = stdout?.columns ?? 80;

  // "/" menu: filter commands by the first token while it has no space yet.
  const firstTok = buf.split(/\s+/)[0];
  const menu = buf.startsWith("/") && !buf.includes(" ") ? COMMANDS.filter((cmd) => cmd.name.startsWith(firstTok)) : [];

  // "@" file picker: trigger on a trailing @token (start of line or after a space). The capture is the
  // query typed after @. Empty list (no @ / no matches) = picker closed.
  const atMatch = !busy ? buf.match(/(?:^|\s)@([^\s@]*)$/) : null;
  const fileMenu = atMatch ? matchFiles(atMatch[1]) : [];
  const fileIdx = Math.min(fileSel, Math.max(0, fileMenu.length - 1));

  useInput((input, key) => {
    // Picker mode owns the keyboard: type to filter, arrows to move, enter to pick, esc to cancel.
    if (s.picker) {
      if (key.escape) return closePicker();
      if (key.return) return void pickerSelect();
      if (key.upArrow) return pickerMove(-1);
      if (key.downArrow) return pickerMove(1);
      if (key.backspace || key.delete) return void pickerFilter(s.picker.query.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return void pickerFilter(s.picker.query + input);
      return;
    }
    // Resume picker: arrows to move, enter to reopen the chosen session, esc to cancel.
    if (s.resumePicker) {
      if (key.escape) return closeResumePicker();
      if (key.return) return void resumePickerSelect();
      if (key.upArrow) return resumePickerMove(-1);
      if (key.downArrow) return resumePickerMove(1);
      return;
    }
    // Model-policy overlay: the run is paused waiting on this; enter sets it, esc defaults to parent.
    if (s.policyPicker) {
      if (key.escape) return policyPickerCancel();
      if (key.return) return policyPickerSelect();
      if (key.upArrow) return policyPickerMove(-1);
      if (key.downArrow) return policyPickerMove(1);
      return;
    }
    // Color picker: arrows to move, enter to apply, esc to cancel (no typing — presets are few).
    if (s.colorPicker) {
      if (key.escape) return closeColorPicker();
      if (key.return) return void colorPickerSelect();
      if (key.upArrow) return colorPickerMove(-1);
      if (key.downArrow) return colorPickerMove(1);
      return;
    }
    // Effort picker: arrows to move, enter to apply, esc to keep the default (no typing — few levels).
    if (s.effortPicker) {
      if (key.escape) return closeEffortPicker();
      if (key.return) return void effortPickerSelect();
      if (key.upArrow) return effortPickerMove(-1);
      if (key.downArrow) return effortPickerMove(1);
      return;
    }
    // Ctrl+O: expand/collapse last tool output
    if (key.ctrl && input === "o") return toggleExpandLast();
    if (busy) return; // one run at a time — ignore typing while the agent works
    if (key.ctrl && (input === "v" || input === "\x16")) {
      void clipboardImageToTemp().then((p) => {
        if (p) setBuf((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}${p} `);
      });
      return;
    }
    // "@" file picker owns Enter/Tab/arrows while open: ⏎ or Tab inserts the highlighted path in place
    // of the @token, arrows move. Typing/backspace fall through to edit the query (and reposition the
    // menu). It closes on its own when the trailing @token breaks (space) or stops matching.
    if (fileMenu.length && atMatch) {
      if (key.return || key.tab) {
        const chosen = fileMenu[fileIdx];
        setBuf(buf.slice(0, buf.length - atMatch[1].length - 1) + chosen + " ");
        setFileSel(0);
        return;
      }
      if (key.upArrow) return setFileSel((n) => (n - 1 + fileMenu.length) % fileMenu.length);
      if (key.downArrow) return setFileSel((n) => (n + 1) % fileMenu.length);
    }
    if (key.return) {
      // With the "/" menu open, Enter runs the highlighted command (so "/mo"+⏎ → /model), not the
      // half-typed text. Otherwise submit what's typed.
      const line = menu.length ? menu[Math.min(sel, menu.length - 1)].name : buf;
      setBuf("");
      setSel(0);
      void submit(line, exit);
      return;
    }
    if (key.tab && menu.length) {
      setBuf(`${menu[Math.min(sel, menu.length - 1)].name} `); // Tab completes, leaving room for args
      setSel(0);
      return;
    }
    if (key.upArrow && menu.length) return setSel((n) => (n - 1 + menu.length) % menu.length);
    if (key.downArrow && menu.length) return setSel((n) => (n + 1) % menu.length);
    if (key.backspace || key.delete) return setBuf((b) => b.slice(0, -1));
    if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
  });

  // Hook must be called unconditionally (before any early return) to satisfy React's rules of hooks.
  const border = useShimmerBorder(termW, busy);

  if (s.picker) return <PickerView picker={s.picker} />;
  if (s.resumePicker) return <ResumePickerView picker={s.resumePicker} />;
  if (s.policyPicker) return <PolicyPickerView sel={s.policyPicker.sel} />;
  if (s.colorPicker) return <ColorPickerView sel={s.colorPicker.sel} />;
  if (s.effortPicker) return <EffortPickerView sel={s.effortPicker.sel} />;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{border.top}</Text>
      <Text>{`${busy ? paintHex(getShimmerColor(), "◆") : c.primary("❯")} ${busy ? c.dim(buf || "working…") : buf}${!busy ? c.dim("▏") : ""}`}</Text>
      <Text>{border.bot}</Text>
      {menu.length > 0 && (
        <Box flexDirection="column" paddingLeft={1}>
          {menu.map((m, i) => (
            <Text key={m.name} color={i === Math.min(sel, menu.length - 1) ? getPrimaryColor() : undefined}>
              {`${i === Math.min(sel, menu.length - 1) ? "›" : " "} ${m.name.padEnd(10)} ${c.dim(m.desc)}`}
            </Text>
          ))}
        </Box>
      )}
      {fileMenu.length > 0 && (() => {
        // Scroll a FILE_MENU-row window around the highlighted file (same viewport trick as the model picker).
        const start = Math.max(0, Math.min(fileIdx - Math.floor(FILE_MENU / 2), Math.max(0, fileMenu.length - FILE_MENU)));
        return (
          <Box flexDirection="column" paddingLeft={1}>
            {fileMenu.slice(start, start + FILE_MENU).map((f, i) => {
              const active = start + i === fileIdx;
              return (
                <Text key={f} color={active ? getPrimaryColor() : undefined}>
                  {`${active ? "›" : " "} ${f}`}
                </Text>
              );
            })}
            {fileMenu.length > FILE_MENU && <Text>{`  ${c.dim(`${fileIdx + 1}/${fileMenu.length}`)}`}</Text>}
          </Box>
        );
      })()}
    </Box>
  );
}

export function App() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <Box flexDirection="column">
      {/* key=gen: /clear bumps it so Static remounts (its internal counter resets) and reprints fresh */}
      <Static key={s.gen} items={s.items}>
        {(item) => <ItemView key={item.id} item={item} />}
      </Static>
      <Footer />
      {/* /setup swaps the prompt for the onboarding overlay; rendering it in place of Prompt means only
          one useInput is active, so the two don't fight over the keyboard. */}
      {s.setup ? <Onboarding inApp onExit={finishSetup} /> : <Prompt />}
    </Box>
  );
}
