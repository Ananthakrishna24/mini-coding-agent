// The interactive Ink UI: a claude-code-style chat. Scrollback (banner, your lines, tool calls,
// results) lives in <Static> so it commits once and scrolls naturally; the live region below holds
// the plan/status footer and the input with its "/" command menu. State comes from store.ts.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import { store, submit, COMMANDS, closePicker, pickerMove, pickerFilter, pickerSelect, closeColorPicker, colorPickerMove, colorPickerSelect, finishSetup, type Item, type Picker } from "./store";
import { c, describeModel, toolEntry, resultBody, iconize, getPrimaryColor, COLOR_PRESETS, paintHex, subHeader, rail } from "./format";
import { Onboarding } from "./onboarding";

const indent = (s: string) => `  ${s}`;

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
            <Text key={i}>{`    ${r}${c.dim(i === 0 ? "⎿" : " ")} ${row}`}</Text>
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
function Spinner({ label }: { label: string }) {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((n) => n + 1), 80);
    return () => clearInterval(t);
  }, []);
  return <Text>{`${c.primary(SPIN[f % SPIN.length])} ${c.dim(`${label}…`)}`}</Text>;
}

// Live status under the scrollback: spinner while working, the plan checklist, and the model · ctx line.
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
      {s.modelLabel && <Text>{indent(c.dim(`${s.modelLabel}${s.ctxPct != null ? ` · ctx ${s.ctxPct}%` : ""}`))}</Text>}
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
        const name = active ? c.bold(nameStr) : nameStr;
        return (
          <Text key={p.hex}>{`  ${marker} ${dot} ${name} ${c.dim(p.hex)}`}</Text>
        );
      })}
      <Text>{c.dim("  custom: /colors #rrggbb")}</Text>
    </Box>
  );
}

function Prompt() {
  const { exit } = useApp();
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const busy = s.busy;
  const [buf, setBuf] = useState("");
  const [sel, setSel] = useState(0);

  // "/" menu: filter commands by the first token while it has no space yet.
  const firstTok = buf.split(/\s+/)[0];
  const menu = buf.startsWith("/") && !buf.includes(" ") ? COMMANDS.filter((cmd) => cmd.name.startsWith(firstTok)) : [];

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
    // Color picker: arrows to move, enter to apply, esc to cancel (no typing — presets are few).
    if (s.colorPicker) {
      if (key.escape) return closeColorPicker();
      if (key.return) return void colorPickerSelect();
      if (key.upArrow) return colorPickerMove(-1);
      if (key.downArrow) return colorPickerMove(1);
      return;
    }
    if (busy) return; // one run at a time — ignore typing while the agent works
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

  if (s.picker) return <PickerView picker={s.picker} />;
  if (s.colorPicker) return <ColorPickerView sel={s.colorPicker.sel} />;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={busy ? "yellow" : getPrimaryColor()} paddingX={1} width="100%">
        <Text>{c.primary("›")} </Text>
        <Text>{busy ? c.dim(buf || "working…") : buf}</Text>
        {!busy && <Text>{c.dim("▏")}</Text>}
      </Box>
      {menu.length > 0 && (
        <Box flexDirection="column" paddingLeft={1}>
          {menu.map((m, i) => (
            <Text key={m.name} color={i === Math.min(sel, menu.length - 1) ? getPrimaryColor() : undefined}>
              {`${i === Math.min(sel, menu.length - 1) ? "›" : " "} ${m.name.padEnd(10)} ${c.dim(m.desc)}`}
            </Text>
          ))}
        </Box>
      )}
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
