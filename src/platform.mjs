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
    return startDetached(executable, ["tunnel", "--config", configPath, "run", options.name ?? "all-api"], {
      statePath: exposureStatePath(options.dataDirectory),
      provider,
    });
  }
  if (provider === "tailscale") {
    const executable = await commandPath("tailscale");
    if (!executable) throw new Error("Tailscale is not installed");
    return runChecked(executable, [
      "funnel", "--bg", "--yes", `http://127.0.0.1:${options.localPort}`,
    ], { inherit: true });
  }
  if (provider === "relay") {
    const executable = await commandPath("ssh");
    if (!executable) throw new Error("OpenSSH is not installed");
    if (!options.host || !Number.isInteger(options.remotePort)) {
      throw new Error("Relay exposure requires host and remotePort");
    }
    return startDetached(executable, [
      "-N", "-o", "ExitOnForwardFailure=yes",
      "-R", `127.0.0.1:${options.remotePort}:127.0.0.1:${options.localPort}`,
      options.host,
    ], {
      statePath: exposureStatePath(options.dataDirectory),
      provider,
    });
  }
  throw new Error(`Unknown exposure provider: ${provider}`);
}

export async function stopExposure(provider, options) {
  if (provider === "tailscale") {
    const executable = await commandPath("tailscale");
    if (!executable) throw new Error("Tailscale is not installed");
    return runChecked(executable, ["funnel", "--https=443", "off"], { inherit: true });
  }
  const statePath = exposureStatePath(options.dataDirectory);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.provider !== provider) throw new Error(`Active exposure is ${state.provider}, not ${provider}`);
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await rm(statePath, { force: true });
  return { stopped: provider };
}

export async function setAutostart({ enabled, dataDirectory, cliPath }) {
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

async function startDetached(command, args, { statePath, provider }) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  await writeFile(statePath, JSON.stringify({
    provider,
    pid: child.pid,
    startedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return { provider, pid: child.pid };
}

async function macAutostart(enabled, dataDirectory, cliPath) {
  const label = "dev.all-api.server";
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
  const unit = path.join(directory, "all-api.service");
  if (!enabled) {
    await runCommand("systemctl", ["--user", "disable", "--now", "all-api.service"]);
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
  await runChecked("systemctl", ["--user", "enable", "--now", "all-api.service"]);
  return { enabled: true, provider: "systemd-user", file: unit };
}

async function windowsAutostart(enabled, dataDirectory, cliPath) {
  const name = "All API";
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
