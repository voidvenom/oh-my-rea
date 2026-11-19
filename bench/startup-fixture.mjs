import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Synthetic session store shaped like a real ~/.rea/sessions directory:
 * `history.json` with user / assistant(tool_calls) / tool messages, `omr.json`,
 * `journal.jsonl`. Content is deterministic so runs are comparable.
 */
const pad = (n, width = 2) => String(n).padStart(width, "0");

const message = (index) => {
  const kind = index % 4;
  if (index === 0) return { role: "user", content: "Investigate the license check in the target and explain how requests are signed." };
  if (kind === 1) {
    return {
      role: "assistant",
      content: `Step ${index}: inspecting the next function before drawing conclusions.`,
      tool_calls: [{ id: `call_${index}`, type: "function", function: { name: "omr_run", arguments: JSON.stringify({ command: `ls -la /tmp/${index}` }) } }],
    };
  }
  if (kind === 2) {
    return { role: "tool", tool_call_id: `call_${index - 1}`, content: `${JSON.stringify({ index, rows: Array.from({ length: 24 }, (_, row) => ({ row, name: `symbol_${index}_${row}`, address: `0x${(index * 4096 + row).toString(16)}` })) })}\n${"disassembly line mov rax, [rbp-0x18]\n".repeat(40)}` };
  }
  if (kind === 3) return { role: "assistant", content: `Finding ${index}: the routine at 0x${(index * 16).toString(16)} derives the signing key.` };
  return { role: "user", content: `follow-up ${index}: keep going` };
};

/** @param {number} count */
export const buildHistory = (count, id, target = null) => ({
  version: "0.5.1",
  session_id: id,
  updated_at: new Date(Date.UTC(2026, 10, 10, 12, 0, 0)).toISOString(),
  target,
  model: "bench/fixture-model",
  title: `bench session ${id}`,
  messages: Array.from({ length: count }, (_, index) => message(index)),
});

/**
 * @param {string} root sessions directory
 * @param {{ sessions?: number, messages?: number, largeMessages?: number }} options
 * @returns {Promise<{ largeId: string, ids: string[] }>}
 */
export const writeSessionStore = async (root, { sessions = 60, messages = 280, largeMessages = 2400 } = {}) => {
  await mkdir(root, { recursive: true });
  const ids = [];
  const write = async (id, count, day, minute) => {
    const dir = join(root, id);
    await mkdir(join(dir, "checkpoints"), { recursive: true });
    await mkdir(join(dir, "scripts"), { recursive: true });
    const history = buildHistory(count, id);
    history.updated_at = new Date(Date.UTC(2026, 10, day, 12, minute, 0)).toISOString();
    await writeFile(join(dir, "history.json"), `${JSON.stringify(history, null, 2)}\n`);
    await writeFile(join(dir, "omr.json"), `${JSON.stringify({ version: "0.5.1", target: null, model: "bench/fixture-model", updated_at: history.updated_at, history: join(dir, "history.json") })}\n`);
    await writeFile(join(dir, "session.json"), `${JSON.stringify({ id })}\n`);
    ids.push(id);
  };
  for (let index = 0; index < sessions; index += 1) {
    await write(`2026-11-${pad(1 + Math.floor(index / 24))}T${pad(index % 24)}-00-00-000Z-session`, messages + (index % 7) * 3, 1, index % 60);
  }
  // Newest id sorts last-descending first: this is what `--resume` / `/resume last` loads.
  const largeId = "2026-11-18T23-59-59-000Z-large-session";
  await write(largeId, largeMessages, 18, 59);
  return { largeId, ids };
};
