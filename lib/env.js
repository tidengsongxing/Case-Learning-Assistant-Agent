'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 极简 .env 读取器。
 * 项目刻意不依赖任何第三方包，所以这里手写一个：
 * 逐行解析 KEY=VALUE，忽略空行与以 # 开头的注释，
 * 自动去掉值两端成对的引号，并且不覆盖已经存在的环境变量。
 */
function loadEnv(file) {
  const target = file || path.join(__dirname, '..', '.env');

  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    // 没有 .env 文件是正常情况，不报错，由调用方检查 key 是否缺失
    return false;
  }

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    }

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }

  return true;
}

module.exports = { loadEnv };
