'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'profile.json');
const MAX_ATTEMPTS = 300;

function empty() {
  return { attempts: [], tagCounts: {}, total: 0, correct: 0 };
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      attempts: Array.isArray(data.attempts) ? data.attempts : [],
      tagCounts: data.tagCounts && typeof data.tagCounts === 'object' && !Array.isArray(data.tagCounts)
        ? data.tagCounts
        : {},
      total: Number(data.total) || 0,
      correct: Number(data.correct) || 0,
    };
  } catch (err) {
    return empty();
  }
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    // 写不进去不应影响本次答题，只记录日志
    console.error('[store] 学习画像写入失败：' + err.message);
  }
}

/** 读取当前画像摘要（在归因之前调用，因此不包含本次答题） */
function summary() {
  const state = load();
  return {
    total: state.total,
    correct: state.correct,
    tagCounts: state.tagCounts,
  };
}

/** 记录一次作答 */
function record(entry) {
  const state = load();
  const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];

  state.attempts.push({
    ts: new Date().toISOString(),
    diseaseId: entry.diseaseId || '',
    diseaseName: entry.diseaseName || '',
    course: entry.course || '',
    difficulty: entry.difficulty || '',
    correct: Boolean(entry.correct),
    chosenKey: entry.chosenKey || '',
    correctKey: entry.correctKey || '',
    confusedWith: entry.confusedWith || '',
    tags,
  });

  if (state.attempts.length > MAX_ATTEMPTS) {
    state.attempts = state.attempts.slice(-MAX_ATTEMPTS);
  }

  state.total += 1;
  if (entry.correct) state.correct += 1;

  for (const tag of tags) {
    state.tagCounts[tag] = (state.tagCounts[tag] || 0) + 1;
  }

  save(state);
  return state;
}

function reset() {
  const state = empty();
  save(state);
  return state;
}

module.exports = { summary, record, reset, load };
