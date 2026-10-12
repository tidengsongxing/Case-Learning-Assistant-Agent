'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failed = false;

const jsonFiles = [
  'package.json',
  'data/diseases.json',
  'data/taxonomy.json',
  'data/knowledge.json',
];

jsonFiles.forEach(function (rel) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    console.log('  OK    ' + rel);
  } catch (err) {
    failed = true;
    console.log('  FAIL  ' + rel + '  ->  ' + err.message);
  }
});

/* 交叉校验：考点库里的疾病 id 必须能在疾病卡片库中找到 */
try {
  const diseases = JSON.parse(fs.readFileSync(path.join(root, 'data/diseases.json'), 'utf8'));
  const taxonomy = JSON.parse(fs.readFileSync(path.join(root, 'data/taxonomy.json'), 'utf8'));
  const knowledge = JSON.parse(fs.readFileSync(path.join(root, 'data/knowledge.json'), 'utf8'));

  const ids = diseases.cards.map(function (card) {
    return card.id;
  });

  Object.keys(knowledge.points).forEach(function (id) {
    if (ids.indexOf(id) === -1) {
      failed = true;
      console.log('  FAIL  knowledge.json 中的 "' + id + '" 在 diseases.json 里不存在');
    }
  });

  const noPoints = ids.filter(function (id) {
    return !knowledge.points[id];
  });
  if (noPoints.length) {
    console.log('  NOTE  以下疾病没有考点条目，知识点题将退回从卡片提取：' + noPoints.join('、'));
  }

  /* 每张卡片的易混淆疾病不应指向自己 */
  diseases.cards.forEach(function (card) {
    (card.confusableWith || []).forEach(function (item) {
      if (item.disease === card.name) {
        failed = true;
        console.log('  FAIL  ' + card.name + ' 的易混淆疾病里出现了它自己');
      }
    });
  });

  console.log('  OK    疾病卡片 ' + diseases.cards.length + ' 张，错因标签 ' + taxonomy.tags.length + ' 个');
} catch (err) {
  failed = true;
  console.log('  FAIL  交叉校验无法完成  ->  ' + err.message);
}

process.exit(failed ? 1 : 0);
