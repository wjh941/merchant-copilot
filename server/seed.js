// CLI：生成仿真数据到 data/store.json。
// 数据生成逻辑在 seed-data.js（buildSeed），server 的 /admin/reset 也用它。
'use strict';
const fs = require('fs');
const path = require('path');
const { buildSeed } = require('./seed-data');

const db = buildSeed();
const out = path.join(__dirname, '..', 'data', 'store.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(db, null, 1), 'utf8');

const zeroPrice = db.products.flatMap(p => p.variants).filter(v => v.price <= 0).length;
const lowStock = db.products.filter(p => p.status === 'published').flatMap(p => p.variants).filter(v => v.inventory < 10).length;
const missingDesc = db.products.filter(p => p.status === 'published' && !p.description).length;

console.log(`seed 完成: ${db.products.length} 个商品 / ${db.orders.length} 个订单`);
console.log(`  注入脏数据: 缺描述 ${missingDesc} 个, 零价格变体 ${zeroPrice} 个, 低库存变体 ${lowStock} 个, 同名商品 1 对`);
console.log(`  -> ${out}`);
