#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProjectRoot(dir: string): string {
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "../..");
}

const PROJECT_ROOT = findProjectRoot(__dirname);
const PID_FILE = path.join(os.tmpdir(), "promptbus.pid");
const LOG_FILE = path.join(os.tmpdir(), "promptbus.log");
const GLOBAL_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const PROXY_PORT = parseInt(process.env.PROMPTBUS_PORT ?? "4701", 10);
const DASHBOARD_PORT = parseInt(process.env.PROMPTBUS_DASHBOARD_PORT ?? "4702", 10);

// Detect project-level .claude/settings.json for the cwd
function getProjectSettings(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, ".claude", "settings.json");
    if (fs.existsSync(path.join(dir, ".claude"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {}
  return {};
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
}

function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = filePath + ".bak." + Date.now();
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const onSigint = () => {
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
      console.log("\nCancelled.");
      process.exit(0);
    };
    process.once("SIGINT", onSigint);
    process.stdout.write(question);
    process.stdin.once("data", (data) => {
      process.removeListener("SIGINT", onSigint);
      process.stdin.pause();
      resolve(data.toString().trim().toLowerCase());
    });
    process.stdin.resume();
  });
}

function readPid(): number | null {
  try {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(PID_FILE);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(PID_FILE);
      return null;
    }
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) {
      fs.unlinkSync(PID_FILE);
      return null;
    }
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      fs.unlinkSync(PID_FILE);
      return null;
    }
  } catch {
    return null;
  }
}

function writePidFile(pid: number): void {
  try {
    const stat = fs.lstatSync(PID_FILE);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(pid));
}

function resolveEntryPoint(): string {
  const compiled = path.resolve(PROJECT_ROOT, "dist", "index.js");
  if (fs.existsSync(compiled)) return compiled;
  const tsx = path.resolve(PROJECT_ROOT, "node_modules", ".bin", "tsx");
  if (fs.existsSync(tsx)) {
    const src = path.resolve(PROJECT_ROOT, "src", "index.ts");
    if (fs.existsSync(src)) return `${tsx} ${src}`;
  }
  return compiled;
}

async function cmdInstall(autoYes = false, useProject = false): Promise<void> {
  const newUrl = `http://127.0.0.1:${PROXY_PORT}`;

  // Determine target settings file
  let targetFile = GLOBAL_SETTINGS;
  if (useProject) {
    const projectFile = getProjectSettings();
    if (!projectFile) {
      // If no .claude dir found, create in cwd
      targetFile = path.join(process.cwd(), ".claude", "settings.json");
    } else {
      targetFile = projectFile;
    }
    console.log(`Using project-level settings: ${targetFile}`);
  }

  const settings = readJson(targetFile);
  const env = (settings.env as Record<string, string>) ?? {};
  const currentUrl = env.ANTHROPIC_BASE_URL;

  if (currentUrl === newUrl) {
    console.log("PromptBus is already configured. No changes needed.");
    return;
  }

  const label = useProject ? path.relative(os.homedir(), targetFile) : "~/.claude/settings.json";
  console.log(`PromptBus will modify ${label}:`);
  console.log(`  env.ANTHROPIC_BASE_URL: "${currentUrl ?? "(not set)"}" -> "${newUrl}"`);

  if (!autoYes) {
    const answer = await ask("Apply this change? [y/N] ");
    if (answer !== "y" && answer !== "yes") {
      console.log("Cancelled.");
      return;
    }
  } else {
    console.log("Auto-confirmed (--yes flag).");
  }

  const backup = backupFile(targetFile);
  const newEnv = { ...env, ANTHROPIC_BASE_URL: newUrl };
  writeJson(targetFile, { ...settings, env: newEnv });

  console.log("Done.");
  console.log("");
  console.log("IMPORTANT: Fully quit and restart any open Claude Code session for the change to take effect.");
  if (backup) {
    console.log(`Backup saved to: ${backup}`);
  }
}

async function cmdRestart(): Promise<void> {
  cmdStop();
  // Brief wait for the process to fully terminate
  await new Promise((r) => setTimeout(r, 1000));
  await cmdStart();
}

async function cmdUninstall(autoYes = false, useProject = false): Promise<void> {
  cmdStop();
  await new Promise((r) => setTimeout(r, 500));

  // Check both global and project settings
  const filesToCheck: string[] = [GLOBAL_SETTINGS];
  if (useProject) {
    const proj = getProjectSettings();
    if (proj) filesToCheck.unshift(proj);
  }

  let targetFile = "";
  let settings: Record<string, unknown> = {};
  let env: Record<string, string> = {};
  for (const f of filesToCheck) {
    const s = readJson(f);
    const e = (s.env as Record<string, string>) ?? {};
    if (e.ANTHROPIC_BASE_URL) {
      targetFile = f;
      settings = s;
      env = e;
      break;
    }
  }

  if (!targetFile) {
    console.log("PromptBus is not configured. No changes needed.");
    return;
  }

  const label = targetFile === GLOBAL_SETTINGS ? "~/.claude/settings.json" : path.relative(os.homedir(), targetFile);
  console.log(`PromptBus will revert ${label}:`);
  console.log(`  env.ANTHROPIC_BASE_URL: "${env.ANTHROPIC_BASE_URL}" -> (removed)`);

  if (!autoYes) {
    const answer = await ask("Revert this change? [y/N] ");
    if (answer !== "y" && answer !== "yes") {
      console.log("Cancelled.");
      return;
    }
  } else {
    console.log("Auto-confirmed (--yes flag).");
  }

  const backup = backupFile(targetFile);
  const { ANTHROPIC_BASE_URL: _removed, ...restEnv } = env;
  const newSettings: Record<string, unknown> = { ...settings };
  if (Object.keys(restEnv).length > 0) {
    newSettings.env = restEnv;
  } else {
    delete newSettings.env;
  }
  writeJson(targetFile, newSettings);

  console.log("Done.");
  console.log("");
  console.log("IMPORTANT: Fully quit and restart any open Claude Code session for the change to take effect.");
  if (backup) {
    console.log(`Backup saved to: ${backup}`);
  }
}

async function cmdStart(): Promise<void> {
  const existingPid = readPid();
  if (existingPid) {
    console.log(`PromptBus is already running (PID ${existingPid}).`);
    console.log(`Dashboard: http://127.0.0.1:${DASHBOARD_PORT}`);
    return;
  }

  console.log("Starting PromptBus...");

  const entryPoint = resolveEntryPoint();
  const logFd = fs.openSync(LOG_FILE, "a");

  let child;
  if (entryPoint.includes("tsx")) {
    const parts = entryPoint.split(" ");
    child = spawn(parts[0], parts.slice(1), {
      env: { ...process.env },
      stdio: ["ignore", logFd, logFd],
      detached: true,
      windowsHide: true,
      cwd: PROJECT_ROOT,
    });
  } else {
    child = spawn(process.execPath, [entryPoint], {
      env: { ...process.env },
      stdio: ["ignore", logFd, logFd],
      detached: true,
      windowsHide: true,
    });
  }

  fs.closeSync(logFd);
  child.unref();

  // Wait briefly to catch immediate crashes
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve();
    }, 500);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      console.error(`Child process exited immediately (code ${code}). Check ${LOG_FILE} for details.`);
      resolve();
    };
    child.once("exit", onExit);
  });

  if (child.exitCode === null && !child.killed) {
    writePidFile(child.pid!);
    console.log(`PromptBus started (PID ${child.pid}).`);
    console.log(`Proxy:     http://127.0.0.1:${PROXY_PORT}`);
    console.log(`Dashboard: http://127.0.0.1:${DASHBOARD_PORT}`);
  }
}

function cmdStop(): void {
  const pid = readPid();
  if (!pid) {
    console.log("PromptBus is not running.");
    return;
  }

  console.log(`Stopping PromptBus (PID ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  console.log("Stopped.");
}

function cmdStatus(): void {
  const pid = readPid();
  const settings = readJson(GLOBAL_SETTINGS);
  const configured = (settings.env as Record<string, string>)?.ANTHROPIC_BASE_URL === `http://127.0.0.1:${PROXY_PORT}`;

  console.log(`PromptBus proxy: ${pid ? `running (PID ${pid})` : "stopped"}`);
  console.log(`  Port: ${PROXY_PORT}`);
  console.log(`  Dashboard: http://127.0.0.1:${DASHBOARD_PORT}`);
  console.log(`Claude Code configured: ${configured ? "yes" : "no"}`);
  if (configured) {
    console.log(`  ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}`);
  }
}

function cmdLogs(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      console.log("No log file found.");
      return;
    }
    const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    const tail = lines.slice(-20);
    if (tail.length === 0 || (tail.length === 1 && tail[0] === "")) {
      console.log("Log file is empty.");
      return;
    }
    console.log(tail.join("\n"));
  } catch (err) {
    console.error(`Failed to read log: ${err}`);
  }
}

function printUsage(): void {
  console.log("Usage: promptbus <command> [flags]");
  console.log("");
  console.log("Commands:");
  console.log("  install     - Configure Claude Code to route through PromptBus");
  console.log("  uninstall   - Revert the configuration");
  console.log("  start       - Start the proxy and dashboard (background daemon)");
  console.log("  stop        - Stop the proxy and dashboard");
  console.log("  restart     - Restart the proxy and dashboard");
  console.log("  status      - Show running status and configuration");
  console.log("  logs        - Show recent daemon log lines");
  console.log("");
  console.log("Flags:");
  console.log("  --yes, -y      Auto-confirm prompts (non-interactive mode)");
  console.log("  --project, -p  Apply install/uninstall to project-level .claude/settings.json");
  console.log("  --version, -v  Show version number");
  console.log("  --help, -h     Show this help message");
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log("promptbus v0.1.0");
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help" || !cmd) {
    printUsage();
    return;
  }
  const args = process.argv.slice(3);
  const autoYes = hasFlag(args, "--yes", "-y");
  const useProject = hasFlag(args, "--project", "-p");

  switch (cmd) {
    case "install": await cmdInstall(autoYes, useProject); break;
    case "uninstall": await cmdUninstall(autoYes, useProject); break;
    case "start": await cmdStart(); break;
    case "stop": cmdStop(); break;
    case "restart": await cmdRestart(); break;
    case "status": cmdStatus(); break;
    case "logs": cmdLogs(); break;
    default:
      console.log(`Unknown command: "${cmd}"`);
      console.log("");
      printUsage();
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
