import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export async function commandPath(command) {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

export async function detectAgents() {
  return Promise.all(["codex", "claude"].map(async (name) => {
    const executable = await commandPath(name);
    if (!executable) return { name, installed: false };
    const version = await runCommand(executable, ["--version"]);
    const authArgs = name === "codex" ? ["login", "status"] : ["auth", "status"];
    const auth = await runCommand(executable, authArgs);
    return {
      name,
      installed: true,
      executable,
      version: firstLine(version.stdout || version.stderr),
      authenticated: auth.ok,
      authStatus: firstLine(auth.stdout || auth.stderr),
    };
  }));
}

export async function installAgent(name) {
  if (!["codex", "claude"].includes(name)) throw new Error(`Unsupported built-in agent: ${name}`);
  const npm = await commandPath(process.platform === "win32" ? "npm.cmd" : "npm");
  if (!npm) throw new Error("Node.js npm is required to install built-in agents");
  const packageName = name === "codex" ? "@openai/codex@latest" : "@anthropic-ai/claude-code@latest";
  return runChecked(npm, ["install", "-g", packageName], { inherit: true });
}

export async function updateAgent(name) {
  const executable = await commandPath(name);
  if (!executable) return installAgent(name);
  if (name === "claude") {
    const updated = await runCommand(executable, ["update"], { inherit: true });
    if (updated.ok) return updated;
  }
  return installAgent(name);
}

export async function ensureCloudflared() {
  let executable = await commandPath("cloudflared");
  if (executable) return executable;
  if (process.platform === "darwin") {
    const brew = await commandPath("brew");
    if (!brew) throw new Error("Install Homebrew or cloudflared from Cloudflare before setup");
    await runChecked(brew, ["install", "cloudflared"], { inherit: true });
  } else if (process.platform === "win32") {
    const winget = await commandPath("winget");
    if (!winget) throw new Error("Install cloudflared from Cloudflare before setup");
    await runChecked(winget, [
      "install", "--id", "Cloudflare.cloudflared", "--exact",
      "--accept-package-agreements", "--accept-source-agreements",
    ], { inherit: true });
  } else {
    throw new Error("Install cloudflared from Cloudflare's signed package repository, then retry");
  }
  executable = await commandPath("cloudflared");
  if (!executable) throw new Error("cloudflared installation completed but the executable is not on PATH");
  return executable;
}

export async function configureCloudflare({
  dataDirectory,
  name = "all-api",
  hostname,
  localPort,
}) {
  if (!hostname) throw new Error("A Cloudflare-managed hostname is required");
  const cloudflared = await ensureCloudflared();
  await runChecked(cloudflared, ["tunnel", "login"], { inherit: true });
  const existing = await cloudflareTunnels(cloudflared);
  if (!existing.find((tunnel) => tunnel.name === name)) {
    await runChecked(cloudflared, ["tunnel", "create", name], { inherit: true });
  }
  const tunnel = (await cloudflareTunnels(cloudflared)).find((item) => item.name === name);
  if (!tunnel?.id) throw new Error(`Cloudflare tunnel "${name}" was not found after creation`);
  await runChecked(cloudflared, ["tunnel", "route", "dns", name, hostname], { inherit: true });

  const credentials = path.join(homedir(), ".cloudflared", `${tunnel.id}.json`);
  const configPath = path.join(dataDirectory, "cloudflare.yml");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(configPath, [
    `tunnel: ${JSON.stringify(tunnel.id)}`,
    `credentials-file: ${JSON.stringify(credentials)}`,
    "ingress:",
    `  - hostname: ${JSON.stringify(hostname)}`,
    `    service: ${JSON.stringify(`http://127.0.0.1:${localPort}`)}`,
    "  - service: http_status:404",
    "",
  ].join("\n"), { mode: 0o600 });
  return { provider: "cloudflare", name, id: tunnel.id, hostname, configPath };
}

export async function startExposure(provider, options) {
  if (provider === "cloudflare") {
    const executable = await ensureCloudflared();
    const configPath = options.configPath ?? path.join(options.dataDirectory, "cloudflare.yml");
    await access(configPath, fsConstants.R_OK);
    return startManagedProcess(executable, [
      "tunnel", "--config", configPath, "run", options.name ?? "all-api",
    ], {
      statePath: exposureStatePath(options.dataDirectory),
      provider,
      restore: {
        name: options.name ?? "all-api",
        configPath,
      },
    });
  }
  if (provider === "tailscale") {
    await ensureExposureSlot(exposureStatePath(options.dataDirectory));
    const executable = await commandPath("tailscale");
    if (!executable) throw new Error("Tailscale is not installed");
    const result = await runChecked(executable, [
      "funnel", "--bg", "--yes", `http://127.0.0.1:${options.localPort}`,
    ], { inherit: true });
    await saveExposureState(options.dataDirectory, {
      provider,
      restore: {},
      startedAt: new Date().toISOString(),
    });
    return result;
  }
  if (provider === "relay") {
    const executable = await commandPath("ssh");
    if (!executable) throw new Error("OpenSSH is not installed");
    if (!options.host || !Number.isInteger(options.remotePort)) {
      throw new Error("Relay exposure requires host and remotePort");
    }
    return startManagedProcess(executable, [
      "-N", "-o", "ExitOnForwardFailure=yes",
      "-R", `127.0.0.1:${options.remotePort}:127.0.0.1:${options.localPort}`,
      options.host,
    ], {
      statePath: exposureStatePath(options.dataDirectory),
      provider,
      restore: {
        host: options.host,
        remotePort: options.remotePort,
      },
    });
  }
  throw new Error(`Unknown exposure provider: ${provider}`);
}

export async function stopExposure(provider, options) {
  const statePath = exposureStatePath(options.dataDirectory);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.provider !== provider) throw new Error(`Active exposure is ${state.provider}, not ${provider}`);
  if (provider === "tailscale") {
    const executable = await commandPath("tailscale");
    if (!executable) throw new Error("Tailscale is not installed");
    const result = await runChecked(executable, ["funnel", "--https=443", "off"], { inherit: true });
    await rm(statePath, { force: true });
    return result;
  }
  const stopped = await processMatchesState(state);
  if (stopped) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  await rm(statePath, { force: true });
  return { stopped: provider, processFound: stopped };
}

export async function restoreExposure({ dataDirectory, localPort }) {
  let state;
  try {
    state = JSON.parse(await readFile(exposureStatePath(dataDirectory), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { restored: false };
    throw error;
  }
  if (state.pid && await processMatchesState(state)) {
    return { restored: false, alreadyRunning: true, provider: state.provider };
  }
  await rm(exposureStatePath(dataDirectory), { force: true });
  return {
    restored: true,
    ...(await startExposure(state.provider, {
      ...state.restore,
      dataDirectory,
      localPort,
    })),
  };
}

export async function setAutostart({ enabled, dataDirectory, cliPath }) {
  const launcher = path.join(dataDirectory, 'autostart.mjs');
  if (enabled) {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await writeFile(launcher, autostartLauncher(dataDirectory, cliPath), { mode: 0o600 });
  }
  cliPath = launcher;
  if (process.platform === "darwin") {
    return macAutostart(enabled, dataDirectory, cliPath);
  }
  if (process.platform === "linux") {
    return linuxAutostart(enabled, dataDirectory, cliPath);
  }
  if (process.platform === "win32") {
    return windowsAutostart(enabled, dataDirectory, cliPath);
  }
  throw new Error(`Autostart is unsupported on ${process.platform}`);
}

export async function runCommand(command, args, {
  inherit = false,
  timeoutMs = 30_000,
  cwd,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref();
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, signal, stdout, stderr });
    });
  });
}

async function runChecked(command, args, options) {
  const result = await runCommand(command, args, { timeoutMs: 10 * 60_000, ...options });
  if (!result.ok) {
    throw new Error(`${path.basename(command)} failed (${result.signal ?? result.code}): ${result.stderr.trim()}`);
  }
  return result;
}

async function cloudflareTunnels(executable) {
  const result = await runChecked(executable, ["tunnel", "list", "--output", "json"]);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("cloudflared returned invalid tunnel list JSON");
  }
}

export async function startManagedProcess(command, args, {
  statePath,
  provider,
  restore = {},
  startupTimeoutMs = 750,
}) {
  await ensureExposureSlot(statePath);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("error", fail);
      child.off("exit", exited);
      resolve();
    }, startupTimeoutMs);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    const exited = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${path.basename(command)} exited during startup (${signal ?? code})`));
    };
    child.once("error", fail);
    child.once("exit", exited);
  });
  if (!child.pid || !isProcessRunning(child.pid)) {
    throw new Error(`${path.basename(command)} did not remain running`);
  }
  child.unref();
  try {
    await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    await writeFile(statePath, JSON.stringify({
      provider,
      pid: child.pid,
      command,
      restore,
      startedAt: new Date().toISOString(),
    }), { mode: 0o600 });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return { provider, pid: child.pid };
}

async function saveExposureState(dataDirectory, state) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(exposureStatePath(dataDirectory), JSON.stringify(state), { mode: 0o600 });
}

async function ensureExposureSlot(statePath) {
  try {
    const existing = JSON.parse(await readFile(statePath, "utf8"));
    if (existing.provider === "tailscale" || await processMatchesState(existing)) {
      throw new Error(`Exposure ${existing.provider} is already running`);
    }
    await rm(statePath, { force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function processMatchesState(state) {
  if (!Number.isInteger(state?.pid) || !state.command || !isProcessRunning(state.pid)) return false;
  if (process.platform === "win32") {
    const result = await runCommand("tasklist.exe", [
      "/FI", `PID eq ${state.pid}`, "/FO", "CSV", "/NH",
    ]);
    return result.ok && result.stdout.toLowerCase().includes(
      path.basename(state.command).toLowerCase(),
    );
  }
  const result = await runCommand("ps", ["-p", String(state.pid), "-o", "comm="]);
  return result.ok && path.basename(result.stdout.trim()) === path.basename(state.command);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function macAutostart(enabled, dataDirectory, cliPath) {
  const label = `dev.all-api.server.${serviceId(dataDirectory)}`;
  const launchAgents = path.join(homedir(), "Library", "LaunchAgents");
  const plist = path.join(launchAgents, `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  if (!enabled) {
    await runCommand("launchctl", ["bootout", domain, plist]);
    await rm(plist, { force: true });
    return { enabled: false, provider: "launchd" };
  }
  await mkdir(launchAgents, { recursive: true });
  const logPath = path.join(dataDirectory, "server.log");
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>
<string>${xml(process.execPath)}</string><string>${xml(cliPath)}</string><string>serve</string>
</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(logPath)}</string>
<key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`, { mode: 0o600 });
  await runCommand("launchctl", ["bootout", domain, plist]);
  await runChecked("launchctl", ["bootstrap", domain, plist]);
  return { enabled: true, provider: "launchd", file: plist };
}

async function linuxAutostart(enabled, dataDirectory, cliPath) {
  const directory = path.join(homedir(), ".config", "systemd", "user");
  const unitName = `all-api-${serviceId(dataDirectory)}.service`;
  const unit = path.join(directory, unitName);
  if (!enabled) {
    await runCommand("systemctl", ["--user", "disable", "--now", unitName]);
    await rm(unit, { force: true });
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    return { enabled: false, provider: "systemd-user" };
  }
  await mkdir(directory, { recursive: true });
  await writeFile(unit, `[Unit]
Description=All API local agent bridge
After=network.target

[Service]
ExecStart=${systemdEscape(process.execPath)} ${systemdEscape(cliPath)} serve
Restart=on-failure
WorkingDirectory=${systemdEscape(dataDirectory)}

[Install]
WantedBy=default.target
`, { mode: 0o600 });
  await runChecked("systemctl", ["--user", "daemon-reload"]);
  await runChecked("systemctl", ["--user", "enable", "--now", unitName]);
  return { enabled: true, provider: "systemd-user", file: unit };
}

async function windowsAutostart(enabled, dataDirectory, cliPath) {
  const name = `All API ${serviceId(dataDirectory)}`;
  if (!enabled) {
    await runCommand("schtasks.exe", ["/Delete", "/TN", name, "/F"]);
    return { enabled: false, provider: "task-scheduler" };
  }
  const command = `"${process.execPath}" "${cliPath}" serve`;
  await runChecked("schtasks.exe", [
    "/Create", "/TN", name, "/SC", "ONLOGON", "/TR", command, "/F",
  ]);
  return { enabled: true, provider: "task-scheduler" };
}

function exposureStatePath(dataDirectory) {
  return path.join(dataDirectory, "exposure.json");
}

function firstLine(value) {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdEscape(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

function serviceId(directory) { return createHash('sha256').update(directory).digest('hex').slice(0, 12); }
export function autostartLauncher(directory, cliPath, environment = process.env) {
  const env = { ALL_API_HOME: directory };
  for (const name of ['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) if (environment[name]) env[name] = environment[name];
  return `Object.assign(process.env, ${JSON.stringify(env)});\nconst { main } = await import(${JSON.stringify(pathToFileURL(cliPath).href)});\nawait main(['serve']);\n`;
}
