// CLI：生成仿真数据到 data/store.json。
// 数据生成逻辑在 seed-data.js（buildSeed），server 的 /admin/reset 也用它。
'use strict';
const fs = require('fs');
const path = require('path');
const { buildSeed } = require('./seed-data');
const { banner, style, kv } = require('../cli/ui');

const db = buildSeed();
const out = path.join(__dirname, '..', 'data', 'store.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(db, null, 1), 'utf8');

const zeroPrice = db.products.flatMap(p => p.variants).filter(v => v.price <= 0).length;
const lowStock = db.products.filter(p => p.status === 'published').flatMap(p => p.variants).filter(v => v.inventory < 10).length;
const missingDesc = db.products.filter(p => p.status === 'published' && !p.description).length;

console.log(banner('仿真数据已就绪', '确定性种子 · 可复现'));
console.log('');
console.log(kv('商品', style.white(String(db.products.length)) + style.gray(' 个')));
console.log(kv('订单', style.white(String(db.orders.length)) + style.gray(' 笔（近 30 天）')));
console.log(kv('脏数据', style.amber(`缺描述 ${missingDesc}`) + style.gray(' · ') + style.amber(`零价格 ${zeroPrice}`) + style.gray(' · ') + style.amber(`低库存 ${lowStock}`) + style.gray(' · 同名商品 1 对')));
console.log(kv('文件', style.gray(out.replace(/^D:\\/, 'D:\\'))));
console.log('');
