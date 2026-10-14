import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const windows = new Map();
const script = fileURLToPath(new URL("./scripts/progress-window.ps1", import.meta.url));
async function awaitReady(entry) {
  let timer;
  await Promise.race([entry.ready, new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
  clearTimeout(timer);
}

export function windowStatus(taskId) {
  const value = windows.get(taskId);
  return value ? { status: value.status, ...(value.error ? { error: value.error } : {}) } : { status: "closed" };
}

export async function openProgressWindow(taskId, taskPath, { waitForReady = true } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(taskId) || path.basename(taskPath).toLowerCase() !== `${taskId}.json`.toLowerCase()) {
    throw new Error("Invalid progress-window task path.");
  }
  const existing = windows.get(taskId);
  if (existing && ["opening", "open"].includes(existing.status)) {
    if (waitForReady && existing.status === "opening") await awaitReady(existing);
    return windowStatus(taskId);
  }
  if (process.platform !== "win32") return { status: "unavailable", error: "The local progress window requires Windows." };
  // The display process gets Windows runtime variables, never the tunnel or CLI credentials.
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH", "USERDOMAIN", "USERNAME"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const entry = { status: "opening", error: null };
  windows.set(taskId, entry);
  let settle;
  const ready = new Promise((resolve) => { settle = resolve; });
  entry.ready = ready;
  try {
    const child = spawn(powershell, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script,
      "-TaskId", taskId, "-TaskPath", path.resolve(taskPath)], {
      // PowerShell WinForms exits without showing a form with detached:true.
      // Unref the process/streams instead; closing a viewer never touches the CLI.
      detached: false, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.unref();
    let stdout = "";
    let stderr = "";
    let visible = false;
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-1000);
      if (/\bREADY\b/.test(stdout)) { visible = true; entry.status = "open"; settle(); }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1500); });
    child.on("error", (error) => { entry.status = "unavailable"; entry.error = error.message; settle(); });
    child.on("exit", (code) => {
      entry.status = code === 0 && visible ? "closed" : "unavailable";
      if (entry.status === "unavailable") entry.error = stderr.trim() || `Progress window exited before becoming visible (code ${code}).`;
      settle();
    });
    // An open viewer must not keep the MCP process alive after its transport closes.
    child.stdout.unref?.();
    child.stderr.unref?.();
    if (waitForReady) await awaitReady(entry);
    return windowStatus(taskId);
  } catch (error) {
    entry.status = "unavailable";
    entry.error = error.message;
    return windowStatus(taskId);
  }
}
