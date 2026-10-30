import { spawn, execFileSync } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const executable = resolve("src-tauri/target/release/acgn-hub.exe");
const profile = resolve(".work/v03-profile");
const app = spawn(executable, [], { cwd: resolve('.'), env: { ...process.env, ACGN_HUB_DATA_DIR: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
await writeFile('.work/v03-evidence/app.pid', String(app.pid));
app.stdout.on('data', (bytes) => { void appendFile('.work/v03-evidence/native-stdout.log', bytes); });
app.stderr.on('data', (bytes) => { process.stderr.write(bytes); void appendFile('.work/v03-evidence/native-stderr.log', bytes); });
app.on('exit', (code, signal) => { console.log('APP_EXIT', JSON.stringify({ code, signal, hex: code === null ? null : '0x' + (code >>> 0).toString(16) })); void writeFile('.work/v03-evidence/native-exit.json', JSON.stringify({ code, signal })); });
for (let attempt = 0; attempt < 40; attempt += 1) {
  try { const response = await fetch('http://127.0.0.1:9223/json/list'); const pages = await response.json(); if (pages.some((page) => page.url.includes('tauri.localhost'))) break; } catch { /* Starting. */ }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class ACGNHidden { [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n); }'; $p=Get-Process -Id ${app.pid}; [ACGNHidden]::ShowWindow($p.MainWindowHandle,0) | Out-Null`], { windowsHide: true, stdio: 'pipe' });
const script = process.argv[2] || 'scripts/verify-real-chapter.mjs';
const verifier = spawn(process.execPath, [script], { env: process.env, stdio: 'inherit', windowsHide: true });
const code = await new Promise((done) => verifier.on('exit', done));
if (app.exitCode === null) app.kill();
process.exitCode = code || 0;
