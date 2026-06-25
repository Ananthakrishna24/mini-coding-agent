// The interactive Ink UI: a chat interface. Scrollback (banner, your lines, tool calls, results)
// lives in <Static> so it commits once and scrolls naturally; the live region below holds the
// plan/status footer and the input with its "/" command menu. State comes from store.ts.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, Static, useApp, useInput, useStdout } from "ink";
import { store, submit, COMMANDS, closePicker, pickerMove, pickerFilter, pickerSelect, closeResumePicker, resumePickerMove, resumePickerSelect, policyPickerMove, policyPickerSelect, policyPickerCancel, POLICY_OPTIONS, closeColorPicker, colorPickerMove, colorPickerSelect, closeEffortPicker, effortPickerMove, effortPickerSelect, finishSetup, EFFORT_LEVELS, openModelPicker, openColorPicker, openResumePicker, openSetup, interrupt, type Item, type Picker, type ResumePicker } from "./store";
import { c, describeModel, toolEntry, resultBody, iconize, getPrimaryColor, COLOR_PRESETS, paintHex, subHeader, rail, termWidth, fmtPrice } from "./format";
import { clipboardImageToTemp } from "./images";
import { matchFiles } from "./tools/workspace";
import { Onboarding } from "./onboarding";

const indent = (s: string) => `  ${s}`;

const FILE_MENU = 8; // rows shown in the @-file picker

function ItemView({ item }: { item: Item }) {
  const r = rail(item.depth ?? 0); // left gutter that nests a subagent's items one level in
  const ind = (s: string) => `  ${r}${s}`;
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text>{ind(`${c.primary("›")} ${c.bold(item.text)}`)}</Text>
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
    case "subagent": // delegation header: the AGENT badge + the subagent's goal, opening the nested block
      return (
        <Box marginTop={1}>
          <Text>{ind(subHeader(item.goal))}</Text>
        </Box>
      );
    case "tool": {
      const { header, rows } = toolEntry(item.name, item.args, item.result);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>{ind(header)}</Text>
          {rows.map((row, i) => (
            <Text key={i}>{`  ${r}${c.dim(i === 0 ? "⎿  " : "   ")}${row}`}</Text>
          ))}
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

function ShimmerText({ label, f }: { label: string; f: number }) {
  const message = `${label}…`;
  const cycleLength = message.length + 15;
  const glimmerIndex = f % cycleLength;

  return (
    <Box flexDirection="row">
      {[...message].map((char, index) => {
        const isHighlighted = index === glimmerIndex;
        const isNearHighlight = Math.abs(index - glimmerIndex) === 1;
        const shouldUseShimmer = isHighlighted || isNearHighlight;

        return (
          <Text
            key={index}
            color={getPrimaryColor()}
            dimColor={!shouldUseShimmer}
            bold={shouldUseShimmer}
          >
            {char}
          </Text>
        );
      })}
    </Box>
  );
}

function Spinner({ label }: { label: string }) {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((n) => n + 1), 80);
    return () => clearInterval(t);
  }, []);

  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const subagents = s.subagents || [];

  if (subagents.length === 0) {
    return (
      <Box flexDirection="row">
        <Text color={getPrimaryColor()}>{SPIN[f % SPIN.length]} </Text>
        <ShimmerText label={label} f={f} />
      </Box>
    );
  }

  const formatGoal = (goal: string, limit = 40) => {
    const clean = goal.replace(/\s+/g, " ").trim();
    if (clean.length <= limit) return clean;
    return `${clean.slice(0, limit - 3)}...`;
  };

  return (
    <Box flexDirection="column">
      {/* Top level leader */}
      <Box flexDirection="row">
        <Text color="gray">┌─ team-lead</Text>
        <Text color="gray" dimColor> (waiting)</Text>
      </Box>

      {/* Nested parent subagents */}
      {subagents.slice(0, -1).map((goal, i) => (
        <Box flexDirection="row" key={i}>
          <Text color="gray">{"│  ".repeat(i + 1)}├─ </Text>
          <Text color="gray" dimColor>{formatGoal(goal)} (waiting)</Text>
        </Box>
      ))}

      {/* Deepest/active subagent */}
      <Box flexDirection="row">
        <Text color="gray">{"│  ".repeat(subagents.length - 1)}└─ </Text>
        <Text color={getPrimaryColor()}>{SPIN[f % SPIN.length]} </Text>
        <Text color="magenta" bold>subagent-{subagents.length}: </Text>
        <Text color="gray" dimColor>{formatGoal(subagents[subagents.length - 1])} </Text>
        <Text color="gray" dimColor>(</Text>
        <ShimmerText label={label} f={f} />
        <Text color="gray" dimColor>)</Text>
      </Box>
    </Box>
  );
}

// Live status under the scrollback: the plan checklist in a styled cyan card.
function Footer() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const planRows = s.plan.slice(0, 8);
  if (s.plan.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1} width="100%">
      <Box justifyContent="space-between">
        <Text color="cyan" bold>{`📋 Agent Execution Plan (${s.planDone}/${s.planTotal})`}</Text>
        {s.spinner && <Spinner label={s.spinner} />}
      </Box>
      <Text>{c.dim("─".repeat(termWidth() - 6))}</Text>
      <Box flexDirection="column" marginTop={1}>
        {planRows.map((l, i) => (
          <Text key={i}>{iconize(l)}</Text>
        ))}
        {s.plan.length > 8 && <Text>{c.dim(`  … +${s.plan.length - 8} more`)}</Text>}
      </Box>
    </Box>
  );
}

// The /model picker: a filterable, arrow-key list of models inside a styled card.
const VIEW = 8;
function PickerView({ picker }: { picker: Picker }) {
  const { items, sel, query, loading } = picker;
  const start = Math.max(0, Math.min(sel - Math.floor(VIEW / 2), Math.max(0, items.length - VIEW)));
  const view = items.slice(start, start + VIEW);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1} width="100%">
      <Box justifyContent="space-between">
        <Text color="cyan" bold>◉ Select Model</Text>
        <Text>{c.dim("↑↓ navigate · ⏎ choose · Esc back")}</Text>
      </Box>
      <Text>{c.dim("─".repeat(termWidth() - 6))}</Text>
      <Text>{`🔍 ${c.bold("Filter:")} ${query || c.dim("(type to search...)")}`}</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {loading ? (
          <Text>{c.dim("  loading catalog…")}</Text>
        ) : items.length === 0 ? (
          <Text>{c.yellow("  no matching tool-capable models")}</Text>
        ) : (
          view.map((m, i) => {
            const active = start + i === sel;
            return (
              <Text key={m.id} color={active ? getPrimaryColor() : undefined}>
                {`  ${active ? "▶" : " "} ${describeModel(m, m.id)}`}
              </Text>
            );
          })
        )}
      </Box>
      {items.length > VIEW && (
        <Text>{`  ${c.dim(`Showing ${sel + 1} of ${items.length} models`)}`}</Text>
      )}
    </Box>
  );
}

// The /resume picker: a scrolling list of past chat sessions inside a styled card.
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
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1} width="100%">
      <Box justifyContent="space-between">
        <Text color="magenta" bold>◉ Resume Chat Session</Text>
        <Text>{c.dim("↑↓ navigate · ⏎ resume · Esc back")}</Text>
      </Box>
      <Text>{c.dim("─".repeat(termWidth() - 6))}</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {view.map((s, i) => {
          const active = start + i === sel;
          const title = (s.title || "(untitled)").slice(0, 56);
          return (
            <Text key={s.id} color={active ? getPrimaryColor() : undefined}>
              {`  ${active ? "▶" : " "} ${title.padEnd(45)} ${c.dim(`${ago(s.updated)} · ${s.cwd.replace(process.env.HOME ?? "~", "~")}`)}`}
            </Text>
          );
        })}
      </Box>
      {items.length > VIEW && (
        <Text>{`  ${c.dim(`Showing ${sel + 1} of ${items.length} sessions`)}`}</Text>
      )}
    </Box>
  );
}

// The /colors picker: each preset swatched in its own color, inside a styled card.
function ColorPickerView({ sel }: { sel: number }) {
  const cur = getPrimaryColor();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1} width="100%">
      <Box justifyContent="space-between">
        <Text>{c.bold(c.yellow("◉ Choose UI Accent Color Preset"))}</Text>
        <Text>{c.dim("↑↓ choose · ⏎ apply · Esc back")}</Text>
      </Box>
      <Text>{c.dim("─".repeat(termWidth() - 6))}</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {COLOR_PRESETS.map((p, i) => {
          const active = i === sel;
          const nameStr = p.name.padEnd(8);
          const marker = active ? "▶" : " ";
          const dot = paintHex(p.hex, p.hex === cur ? "●" : "○");
          const name = active ? c.bold(nameStr) : nameStr;
          return (
            <Text key={p.hex} color={active ? getPrimaryColor() : undefined}>
              {`  ${marker} ${dot} ${name} ${c.dim(p.hex)}`}
            </Text>
          );
        })}
      </Box>
      <Text>{c.dim("  Tip: Type '/colors #rrggbb' directly for any custom hex code")}</Text>
    </Box>
  );
}

// The model-policy overlay, shown once on the first delegation, inside a styled card.
function PolicyPickerView({ sel }: { sel: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1} width="100%">
      <Box justifyContent="space-between">
        <Text color="magenta" bold>◉ Subagent Model Delegation Policy</Text>
        <Text>{c.dim("↑↓ choose · ⏎ set · Esc default")}</Text>
      </Box>
      <Text>{c.dim("─".repeat(termWidth() - 6))}</Text>
      <Text>{c.dim("  How should delegated subagents choose which model to run on?")}</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {POLICY_OPTIONS.map((opt, i) => {
          const active = i === sel;
          const marker = active ? "▶" : " ";
          const label = active ? c.bold(opt.label) : opt.label;
          return (
            <Text key={opt.value} color={active ? getPrimaryColor() : undefined}>
              {`  ${marker} ${label}`}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

// The reasoning-effort picker, shown right after a reasoning model is chosen, inside a styled card.
function EffortPickerView({ sel }: { sel: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1} width="100%">
      <Box justifyContent="space-between">
        <Text>{c.bold(c.yellow("◉ Choose Reasoning Effort Level"))}</Text>
        <Text>{c.dim("↑↓ choose · ⏎ select · Esc default")}</Text>
      </Box>
      <Text>{c.dim("─".repeat(termWidth() - 6))}</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {EFFORT_LEVELS.map((level, i) => {
          const active = i === sel;
          const marker = active ? "▶" : " ";
          const name = active ? c.bold(level) : level;
          return (
            <Text key={level} color={active ? getPrimaryColor() : undefined}>
              {`  ${marker} ${name}`}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

function Prompt() {
  const { exit } = useApp();
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const busy = s.busy;
  const [buf, setBuf] = useState("");
  const [sel, setSel] = useState(0);
  const [fileSel, setFileSel] = useState(0);

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
    if (busy) {
      if (key.escape) {
        interrupt();
      }
      return; // one run at a time — ignore typing while the agent works
    }
    if (input === "?" && !buf) {
      setBuf("");
      void submit("/help", exit);
      return;
    }
    if (key.ctrl && (input === "v" || input === "\x16")) {
      void clipboardImageToTemp().then((p) => {
        if (p) setBuf((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}${p} `);
      });
      return;
    }
    if (key.ctrl) {
      if (input === "o") {
        void openModelPicker("");
        return;
      }
      if (input === "k") {
        openColorPicker();
        return;
      }
      if (input === "r") {
        openResumePicker();
        return;
      }
      if (input === "u") {
        setBuf("");
        void submit("/usage", exit);
        return;
      }
      if (input === "t") {
        setBuf("");
        void submit("/status", exit);
        return;
      }
      if (input === "s") {
        openSetup();
        return;
      }
      if (input === "l") {
        setBuf("");
        void submit("/clear", exit);
        return;
      }
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

  let inputText = buf;
  let isDimPrompt = !buf;
  if (s.picker) {
    inputText = `/model ${s.picker.query}`;
    isDimPrompt = false;
  } else if (s.resumePicker) {
    inputText = "/resume";
    isDimPrompt = false;
  } else if (s.colorPicker) {
    inputText = "/colors";
    isDimPrompt = false;
  } else if (s.effortPicker) {
    inputText = "/model";
    isDimPrompt = false;
  } else if (s.policyPicker) {
    inputText = "Subagent delegation policy...";
    isDimPrompt = true;
  }

  const parts = [s.modelName];
  if (s.modelEffort) parts.push(s.modelEffort);
  if (s.modelProvider) parts.push(s.modelProvider);
  const rightText = parts.filter(Boolean).join(" · ");

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Thinking spinner on top of the text input box when busy */}
      {busy && (
        <Box paddingX={1} marginBottom={0} width="100%">
          <Spinner label={s.spinner || "Working"} />
        </Box>
      )}

      {/* Input row */}
      <Box borderStyle="single" borderLeft={false} borderRight={false} borderColor={getPrimaryColor()} paddingX={1} width="100%">
        <Text>{c.primary("› ")}</Text>
        {busy ? (
          <Box flexGrow={1} justifyContent="space-between">
            <Text>{c.dim("")}</Text>
            <Text>{c.dim("press esc to interrupt")}</Text>
          </Box>
        ) : (
          <Text>{isDimPrompt ? c.dim(inputText || "Type a goal or command...") : inputText}</Text>
        )}
        {!busy && <Text>{c.dim("▏")}</Text>}
      </Box>

      {/* Autocomplete command menu if active */}
      {menu.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor={getPrimaryColor()} paddingX={1} marginTop={1} marginBottom={0} width="100%">
          <Text color="cyan" bold>Command Menu</Text>
          <Text>{c.dim("─".repeat(termWidth() - 6))}</Text>
          {menu.map((m, i) => (
            <Text key={m.name} color={i === Math.min(sel, menu.length - 1) ? getPrimaryColor() : undefined}>
              {`  ${i === Math.min(sel, menu.length - 1) ? "▶" : " "} ${m.name.padEnd(10)} ${c.dim(m.desc)}`}
            </Text>
          ))}
        </Box>
      )}

      {/* File autocomplete menu if active */}
      {fileMenu.length > 0 && (() => {
        const start = Math.max(0, Math.min(fileIdx - Math.floor(FILE_MENU / 2), Math.max(0, fileMenu.length - FILE_MENU)));
        return (
          <Box flexDirection="column" borderStyle="round" borderColor={getPrimaryColor()} paddingX={1} marginTop={1} marginBottom={0} width="100%">
            <Text color="cyan" bold>Matching Files</Text>
            <Text>{c.dim("─".repeat(termWidth() - 6))}</Text>
            {fileMenu.slice(start, start + FILE_MENU).map((f, i) => {
              const active = start + i === fileIdx;
              return (
                <Text key={f} color={active ? getPrimaryColor() : undefined}>
                  {`  ${active ? "▶" : " "} ${f}`}
                </Text>
              );
            })}
            {fileMenu.length > FILE_MENU && <Text>{`  ${c.dim(`${fileIdx + 1}/${fileMenu.length}`)}`}</Text>}
          </Box>
        );
      })()}

      {/* Pickers/overlays if active */}
      {s.picker && <PickerView picker={s.picker} />}
      {s.resumePicker && <ResumePickerView picker={s.resumePicker} />}
      {s.policyPicker && <PolicyPickerView sel={s.policyPicker.sel} />}
      {s.colorPicker && <ColorPickerView sel={s.colorPicker.sel} />}
      {s.effortPicker && <EffortPickerView sel={s.effortPicker.sel} />}

      {/* Status Line & Shortcuts */}
      <Box paddingX={1} justifyContent="space-between" width="100%" marginTop={1}>
        <Text dimColor={true}>
          ? for shortcuts
        </Text>
        <Text dimColor={true}>
          {rightText}
        </Text>
      </Box>
    </Box>
  );
}

export function App() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { stdout } = useStdout();
  const [resizeGen, setResizeGen] = useState(0);
  useEffect(() => {
    // On resize, width-dependent output (── rules, diff columns) drawn at the old width goes stale, and
    // Ink's frame bookkeeping leaves a ghost of the previous live region. Debounce the SIGWINCH storm of
    // a drag, then clear the screen and bump resizeGen — that remounts <Static> so the whole tree (scroll-
    // back + live region) reprints at the new width with no ghosts.
    let t: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        // Clear visible screen AND scrollback (\x1b[3J), cursor home. Scrollback must go too: the Static
        // remount below reprints every item, so leaving the old copy in scrollback stacks duplicates on
        // each resize. Wiping it first means the remount leaves exactly one fresh copy at the new width.
        stdout.write("\x1b[2J\x1b[3J\x1b[H");
        setResizeGen((n) => n + 1);
      }, 100);
    };
    stdout.on("resize", handleResize);
    return () => {
      clearTimeout(t);
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  return (
    <Box flexDirection="column">
      {/* key: /clear bumps s.gen; resize bumps resizeGen — either remounts <Static> so it reprints fresh */}
      <Static key={`${s.gen}:${resizeGen}`} items={s.items}>
        {(item) => <ItemView key={item.id} item={item} />}
      </Static>
      <Footer />
      {/* /setup swaps the prompt for the onboarding overlay; rendering it in place of Prompt means only
          one useInput is active, so the two don't fight over the keyboard. */}
      {s.setup ? <Onboarding inApp onExit={finishSetup} /> : <Prompt />}
    </Box>
  );
}
