import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const choice = JSON.parse(await readFile('.work/real-workflow/requested-title-resource.json', 'utf8')).selectedAnimeEpisode;
const directory = resolve('.work/requested-title/animation');
await mkdir(directory, { recursive: true });
const port = 19000 + Math.floor(Math.random() * 1000);
const secret = randomUUID();
const engine = spawn(resolve('src-tauri/resources/aria2c.exe'), ['--enable-rpc=true', '--rpc-listen-all=false', '--rpc-listen-port=' + port, '--rpc-secret=' + secret, '--dir=' + directory, '--seed-time=0', '--auto-save-interval=1', '--continue=true', '--file-allocation=none', '--console-log-level=warn'], { windowsHide: true, stdio: 'ignore' });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function rpc(method, params = []) {
  const response = await fetch('http://127.0.0.1:' + port + '/jsonrpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'requested-title', method, params: ['token:' + secret, ...params] }), signal: AbortSignal.timeout(5000) });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}
let result = { requestedTitle: '脑洞学生会', episode: 1, complete: false, downloadedBytes: 0, expectedBytes: choice.sizeBytes, reason: '', files: [] };
try {
  for (let attempt = 0; attempt < 30; attempt += 1) { try { await rpc('aria2.getVersion'); break; } catch { await sleep(200); } }
  let id = await rpc('aria2.addUri', [[choice.torrentUrl], { dir: directory, 'follow-torrent': 'mem', 'seed-time': '0', 'bt-stop-timeout': '120', 'bt-save-metadata': 'false' }]);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = await rpc('aria2.tellStatus', [id]);
    if (status.followedBy?.length) { id = status.followedBy[0]; continue; }
    result.downloadedBytes = Number(status.completedLength || 0); result.files = status.files?.map((file) => file.path) ?? [];
    result.state = status.status; result.connections = Number(status.connections || 0); result.seeders = Number(status.numSeeders || 0);
    if (attempt % 5 === 0) console.log(JSON.stringify({ state: result.state, completedBytes: result.downloadedBytes, totalBytes: Number(status.totalLength || 0), connections: result.connections, seeders: result.seeders }));
    if (status.status === 'complete') { result.complete = true; break; }
    if (status.status === 'error') { result.reason = status.errorMessage || 'aria2 error ' + status.errorCode; break; }
    await sleep(2000);
  }
  if (!result.complete && !result.reason) result.reason = '未在三分钟验证窗口内完成，不能当作已可用的视频交付';
} catch (cause) { result.reason = cause instanceof Error ? cause.message : String(cause); }
finally { engine.kill(); await writeFile('.work/v03-evidence/requested-episode-download.json', JSON.stringify(result, null, 2)); }
console.log(JSON.stringify(result, null, 2));
