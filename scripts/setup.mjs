import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) { console.error(result.error?.message || '환경 준비에 실패했습니다.'); process.exit(result.status || 1); }
};
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) {
  const candidates = [process.env.FRAMEFORM_PYTHON, 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].filter(Boolean);
  const interpreter = candidates.find(candidate => {
    const result = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore' });
    return !result.error && result.status === 0;
  });
  if (!interpreter) {
    console.error('Python 3.10 이상이 필요합니다. 설치 후 다시 실행하거나 FRAMEFORM_PYTHON에 Python 실행 경로를 지정해 주세요.');
    process.exit(1);
  }
  run(interpreter, ['-m', 'venv', '.venv']);
}
run(python, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
console.log('\n준비되었습니다. npm run dev로 Saegim을 시작하세요.');
