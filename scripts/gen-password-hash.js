#!/usr/bin/env node
/**
 * 密码 hash 生成工具
 *
 * 用途：为生产环境生成自定义密码的 bcrypt hash
 *
 * 使用：
 *   node scripts/gen-password-hash.js
 *   （会交互式提示输入明文密码）
 *
 * 或直接传参：
 *   node scripts/gen-password-hash.js "你的密码"
 */

import bcrypt from 'bcryptjs';
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';

async function main() {
  let password = process.argv[2];

  if (!password) {
    const rl = createInterface({ input: stdin, output: stdout });
    password = await rl.question('请输入密码（输入时可见）: ');
    rl.close();
  }

  if (!password || password.length < 4) {
    console.error('❌ 密码至少 4 位');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 10);
  console.log('\n✅ 生成成功，复制下面这一整行到 Render 环境变量：\n');
  console.log(hash);
  console.log('\n对应明文：', password);
}

main();
