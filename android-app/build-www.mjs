// 把网页运行所需的文件收集到 android-app/www/（Capacitor 的 webDir）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, 'www');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const FILES = ['index.html', 'style.css', 'manifest.webmanifest'];
const DIRS = ['src', 'icons'];
for (const f of FILES) fs.copyFileSync(path.join(root, f), path.join(out, f));
for (const d of DIRS) fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });

// 把构建号写进包里：APP 启动时拿它和 Release 里的 version.json 比，判断有没有新版
const build = Number(process.env.BUILD_NUMBER || 0);
const version = process.env.BUILD_VERSION || 'dev';
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({ build, version }));

const count = fs.readdirSync(out, { recursive: true }).length;
if (!fs.existsSync(path.join(out, 'src', 'app.js'))) throw new Error('www/src/app.js 不存在，收集失败');
console.log(`www/ 已生成，共 ${count} 项`);
