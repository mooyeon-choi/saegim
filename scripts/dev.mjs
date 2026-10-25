import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) {
  console.error('분석 환경이 없습니다. 먼저 npm run setup을 실행해 주세요.');
  process.exit(1);
}
const api = spawn(python, ['-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', '8000'], { cwd: root, stdio: 'inherit' });
const web = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit' });
let closing = false;
const close = code => {
  if (closing) return;
  closing = true;
  api.kill('SIGTERM'); web.kill('SIGTERM');
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
};
api.on('error', error => { console.error(error.message); close(1); });
web.on('error', error => { console.error(error.message); close(1); });
api.on('exit', code => close(code ?? 0));
web.on('exit', code => close(code ?? 0));
process.on('SIGINT', () => close(0));
process.on('SIGTERM', () => close(0));
