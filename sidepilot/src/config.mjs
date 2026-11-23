// 配置读写：管理端改完要能落盘，重启后仍然有效
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function readConfig(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeConfig(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
}

/** 把 key 打码，只留后 4 位，避免管理端把完整密钥渲染到页面上 */
export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** 判断客户端提交的 key 是不是那一串掩码（说明用户没改） */
export function isMasked(value) {
  return typeof value === 'string' && value.indexOf('****') >= 0;
}
