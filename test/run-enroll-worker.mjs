// run-enroll-worker.mjs — 在两种目录布局下定位并运行开通服务测试：
//   · 私有 monorepo：<root>/gateway/test/ → <root>/services/tunnel-enroll/
//   · 公开发布仓（包根=仓库根）：test/ → services/tunnel-enroll/
// publish-plugin 同步会把 services/tunnel-enroll 一并带进公开仓，二者路径不同。
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, '../../services/tunnel-enroll/test/enroll-worker.mjs'), // 私有 monorepo
  path.resolve(here, '../services/tunnel-enroll/test/enroll-worker.mjs'), // 公开发布仓
];
const target = candidates.find((p) => existsSync(p));
if (!target) {
  console.error(`✗ 找不到开通服务测试（尝试：\n  ${candidates.join('\n  ')}）`);
  process.exit(1);
}
await import(pathToFileURL(target).href);
