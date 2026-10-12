'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadEnv } = require('./lib/env');
const { chatJSON, ModelError } = require('./lib/model');
const {
  buildGenerationMessages,
  buildKnowledgeGenerationMessages,
  buildAttributionMessages,
} = require('./lib/prompts');
const store = require('./lib/store');

loadEnv();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;

const COURSES = ['诊断学', '病理学', '内科学'];
const DIFFICULTIES = ['基础', '进阶', '挑战'];
const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function fatal(lines) {
  console.error('');
  lines.forEach(function (line) {
    console.error('  ' + line);
  });
  console.error('');
  process.exit(1);
}

function readJSONFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fatal([
      '启动失败：找不到数据文件 ' + file,
      '请确认 data 目录下的 json 文件完整、没有被移动或改名。',
    ]);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    fatal([
      '启动失败：数据文件格式错误 —— ' + path.basename(file),
      err.message,
      '这通常是逗号多余或缺失导致的，请按上面的行列位置检查该文件。',
    ]);
  }
}

const diseaseData = readJSONFile(path.join(DATA_DIR, 'diseases.json'));
const taxonomy = readJSONFile(path.join(DATA_DIR, 'taxonomy.json'));

if (!Array.isArray(diseaseData.cards) || !diseaseData.cards.length) {
  fatal(['启动失败：diseases.json 里没有找到 cards 数组，或者数组为空。']);
}
if (!Array.isArray(taxonomy.tags) || !taxonomy.tags.length) {
  fatal(['启动失败：taxonomy.json 里没有找到 tags 数组，或者数组为空。']);
}

const CARDS = diseaseData.cards;

/* 考点库是可选的：没有它时知识点题会退回从疾病卡片提取考点 */
let knowledgePoints = {};
try {
  const knowledgeData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'knowledge.json'), 'utf8'));
  if (knowledgeData && typeof knowledgeData.points === 'object' && knowledgeData.points !== null) {
    knowledgePoints = knowledgeData.points;
  }
} catch (err) {
  console.warn('  提示：未能读取 data/knowledge.json，知识点题将从疾病卡片中提取考点。');
}

CARDS.forEach(function (card) {
  card.knowledgePoints = Array.isArray(knowledgePoints[card.id]) ? knowledgePoints[card.id] : [];
});

/** 本次服务进程内生成的题目，学生提交答案时从这里取回完整数据（含答案） */
const CASES = new Map();

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let raw = '';
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', function () {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tagName(id) {
  const found = taxonomy.tags.filter(function (t) {
    return t.id === id;
  })[0];
  return found ? found.name : id;
}

function optionText(caseData, key) {
  const found = (caseData.options || []).filter(function (o) {
    return o.key === key;
  })[0];
  return found ? found.text : '';
}

function findCard(diseaseId) {
  return CARDS.filter(function (c) {
    return c.id === diseaseId;
  })[0];
}

/** 随机抽卡。allowConcept 为 false 时排除纯概念卡片（它们无法命制病例题） */
function pickRandomCard(course, allowConcept) {
  const pool = CARDS.filter(function (c) {
    if (c.courses.indexOf(course) === -1) return false;
    if (!allowConcept && c.type === 'concept') return false;
    return true;
  });
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ------------------------------------------------------------------ */
/* 模型返回内容的校验与规整                                             */
/* ------------------------------------------------------------------ */

function normalizeCase(raw, questionType, answerType) {
  const isKnowledge = questionType === 'knowledge';

  if (!raw || typeof raw !== 'object') {
    throw new ModelError('模型没有返回题目内容', 'BAD_CASE');
  }

  const vignette = raw.vignette && typeof raw.vignette === 'object' ? raw.vignette : {};
  const options = Array.isArray(raw.options) ? raw.options : [];

  if (isKnowledge) {
    if (options.length < 4 || options.length > 5) {
      throw new ModelError('知识点题的选项数量必须是 4 到 5 个', 'BAD_CASE');
    }
  } else if (options.length !== 4) {
    throw new ModelError('病例题的选项数量不是 4 个', 'BAD_CASE');
  }

  const cleaned = options.map(function (o, index) {
    const key = String((o && o.key) || OPTION_KEYS[index]).trim().toUpperCase();
    const text = String((o && o.text) || '').trim();
    return { key: key, text: text };
  });

  const keys = cleaned.map(function (o) {
    return o.key;
  });
  if (new Set(keys).size !== keys.length) {
    throw new ModelError('模型生成的选项字母出现重复', 'BAD_CASE');
  }
  if (
    keys.some(function (key) {
      return OPTION_KEYS.indexOf(key) === -1;
    })
  ) {
    throw new ModelError('模型生成的选项字母不在 A 到 F 之间', 'BAD_CASE');
  }
  if (
    cleaned.some(function (o) {
      return !o.text;
    })
  ) {
    throw new ModelError('模型生成了内容为空的选项', 'BAD_CASE');
  }

  const rawCorrect = Array.isArray(raw.correctKeys)
    ? raw.correctKeys
    : raw.correctKey
      ? [raw.correctKey]
      : [];

  const correctKeys = [];
  rawCorrect.forEach(function (key) {
    const normalized = String(key || '').trim().toUpperCase();
    if (keys.indexOf(normalized) !== -1 && correctKeys.indexOf(normalized) === -1) {
      correctKeys.push(normalized);
    }
  });

  if (answerType === 'multiple') {
    if (correctKeys.length < 2) {
      throw new ModelError('多选题没有给出至少两个正确选项', 'BAD_CASE');
    }
  } else if (correctKeys.length !== 1) {
    throw new ModelError('单选题给出的正确选项数量不是 1 个', 'BAD_CASE');
  }

  const truthLayer = raw.truthLayer && typeof raw.truthLayer === 'object' ? raw.truthLayer : {};
  const diagnosis = String(truthLayer.diagnosis || truthLayer.topic || '').trim();
  if (!diagnosis) {
    throw new ModelError('模型没有给出考点或诊断', 'BAD_CASE');
  }

  const rawFindings = Array.isArray(truthLayer.keyFindings)
    ? truthLayer.keyFindings
    : Array.isArray(truthLayer.keyFacts)
      ? truthLayer.keyFacts
      : [];

  const rawMap = raw.distractorMap && typeof raw.distractorMap === 'object' ? raw.distractorMap : {};
  const distractorMap = {};
  keys.forEach(function (key) {
    if (correctKeys.indexOf(key) !== -1) return;
    const entry = rawMap[key] && typeof rawMap[key] === 'object' ? rawMap[key] : {};
    const tags = Array.isArray(entry.errorTags)
      ? entry.errorTags.filter(function (id) {
          return taxonomy.tags.some(function (t) {
            return t.id === id;
          });
        })
      : [];
    distractorMap[key] = {
      disease: String(entry.disease || '').trim(),
      errorTags: tags,
      whyWrong: String(entry.whyWrong || '').trim(),
    };
  });

  return {
    title: String(raw.title || vignette.title || '').trim(),
    questionType: isKnowledge ? 'knowledge' : 'case',
    answerType: answerType === 'multiple' ? 'multiple' : 'single',
    vignette: isKnowledge
      ? null
      : {
          chiefComplaint: String(vignette.chiefComplaint || '').trim(),
          history: String(vignette.history || '').trim(),
          exam: String(vignette.exam || '').trim(),
          tests: String(vignette.tests || '').trim(),
        },
    question: String(raw.question || '').trim(),
    options: cleaned,
    correctKeys: correctKeys,
    truthLayer: {
      diagnosis: diagnosis,
      keyFindings: rawFindings.map(function (s) {
        return String(s);
      }),
      reasoning: String(truthLayer.reasoning || '').trim(),
    },
    distractorMap: distractorMap,
  };
}

/* ------------------------------------------------------------------ */
/* 归因：优先用模型，失败则退回确定性结果                                */
/* ------------------------------------------------------------------ */

function joinOptionTexts(caseData, keys) {
  return keys
    .map(function (key) {
      return key + '（' + optionText(caseData, key) + '）';
    })
    .join('、');
}

function deterministicAttribution(caseData, selectedKeys, outcome, missed, extra, focusKey) {
  const isKnowledge = caseData.questionType === 'knowledge';
  const correctLabel = caseData.correctKeys.join('、');

  if (outcome === 'correct') {
    return {
      primaryTagId: 'none',
      secondaryTagIds: [],
      confusedWith: '',
      evidence: '你选择了 ' + correctLabel + '，与全部正确选项一致。',
      analysis:
        (isKnowledge ? '回答完全正确。本题的考点是：' : '诊断正确。本题的关键鉴别证据是：') +
        (caseData.truthLayer.keyFindings || []).slice(0, 2).join('；') +
        '。请确认你是依据这些证据作出判断，而不是靠印象。',
      knowledgePoint: caseData.truthLayer.diagnosis,
      remedy: isKnowledge
        ? '把这个考点向同学复述一遍，重点讲清最容易记混的那一条。'
        : '尝试向同学复述本题从症状到诊断的完整推理链，检验自己是否真的掌握了鉴别点。',
      historyNote: '',
      enriched: false,
    };
  }

  /* 多选题：全部选对但没选全 */
  if (outcome === 'partial' && !extra.length) {
    return {
      primaryTagId: 'omission',
      secondaryTagIds: [],
      confusedWith: '',
      evidence: '你选择了 ' + selectedKeys.join('、') + '，但漏选了正确选项 ' + missed.join('、') + '。',
      analysis:
        '你选中的选项都是正确的，说明基本概念没有问题，但掌握不完整，遗漏了「' +
        missed
          .map(function (key) {
            return optionText(caseData, key);
          })
          .join('」「') +
        '」这一条。',
      knowledgePoint: caseData.truthLayer.diagnosis,
      remedy: '把这个考点按条目逐条默写一遍，重点补上被漏掉的那一条，而不是整段重读。',
      historyNote: '',
      enriched: false,
    };
  }

  const base = caseData.distractorMap[focusKey] || {};
  const tags = Array.isArray(base.errorTags) ? base.errorTags : [];

  return {
    primaryTagId: tags[0] || (outcome === 'partial' ? 'confusion' : 'knowledge_gap'),
    secondaryTagIds: tags.slice(1),
    confusedWith: base.disease || '',
    evidence: extra.length
      ? '你多选了 ' + joinOptionTexts(caseData, extra) + '，这是错误选项。'
      : '你选择了 ' + joinOptionTexts(caseData, selectedKeys) + '。',
    analysis: base.whyWrong || '所选项与题目中的关键信息不符。',
    knowledgePoint: base.disease
      ? '需要区分「' + base.disease + '」与「' + caseData.truthLayer.diagnosis + '」'
      : caseData.truthLayer.diagnosis,
    remedy: '把这一对概念或疾病的差别整理成一张对照表，重点标出题目中出现的那条关键线索。',
    historyNote: '',
    enriched: false,
  };
}

async function buildAttribution(caseData, selectedKeys, outcome, missed, extra, focusKey, profileBefore) {
  const messages = buildAttributionMessages({
    caseData: caseData,
    chosenKeys: selectedKeys,
    base: caseData.distractorMap[focusKey] || null,
    taxonomy: taxonomy,
    profile: profileBefore,
    outcome: outcome,
    missed: missed,
    extra: extra,
    focusKey: focusKey,
  });

  const raw = await chatJSON({
    system: messages.system,
    user: messages.user,
    temperature: 0.4,
    maxTokens: 2000,
  });

  const validIds = taxonomy.tags.map(function (t) {
    return t.id;
  });
  const primary =
    validIds.indexOf(raw.primaryTagId) !== -1
      ? raw.primaryTagId
      : outcome === 'correct'
        ? 'none'
        : 'knowledge_gap';
  const secondary = Array.isArray(raw.secondaryTagIds)
    ? raw.secondaryTagIds.filter(function (id) {
        return validIds.indexOf(id) !== -1;
      })
    : [];

  return {
    primaryTagId: primary,
    secondaryTagIds: secondary,
    confusedWith: String(raw.confusedWith || '').trim(),
    evidence: String(raw.evidence || '').trim(),
    analysis: String(raw.analysis || '').trim(),
    knowledgePoint: String(raw.knowledgePoint || '').trim(),
    remedy: String(raw.remedy || '').trim(),
    historyNote: String(raw.historyNote || '').trim(),
    enriched: true,
  };
}

/* ------------------------------------------------------------------ */
/* 接口实现                                                            */
/* ------------------------------------------------------------------ */

function handleConfig(res) {
  const key = (process.env.API_KEY || '').trim();
  sendJSON(res, 200, {
    ok: true,
    courses: COURSES,
    difficulties: DIFFICULTIES,
    model: process.env.MODEL || 'deepseek-chat',
    modelReady: Boolean(key) && !key.includes('在这里填入'),
    diseases: CARDS.map(function (c) {
      return {
        id: c.id,
        name: c.name,
        courses: c.courses,
        chapter: c.chapter,
        type: c.type === 'concept' ? 'concept' : 'disease',
      };
    }),
    taxonomy: taxonomy.tags.map(function (t) {
      return { id: t.id, name: t.name, description: t.description };
    }),
    stats: store.summary(),
  });
}

async function handleGenerate(res, body) {
  const course = String(body.course || '').trim();
  const difficulty = String(body.difficulty || '进阶').trim();
  const mode = body.mode === 'random' ? 'random' : 'targeted';
  const questionType = body.questionType === 'knowledge' ? 'knowledge' : 'case';
  const answerType =
    questionType === 'knowledge' && body.answerType === 'multiple' ? 'multiple' : 'single';

  if (COURSES.indexOf(course) === -1) {
    return sendJSON(res, 400, { ok: false, error: '课程参数不合法：' + course });
  }
  if (DIFFICULTIES.indexOf(difficulty) === -1) {
    return sendJSON(res, 400, { ok: false, error: '难度参数不合法：' + difficulty });
  }

  let card = null;
  if (mode === 'random') {
    card = pickRandomCard(course, questionType === 'knowledge');
    if (!card) return sendJSON(res, 400, { ok: false, error: '该课程下暂时没有可用的疾病卡片。' });
  } else {
    card = findCard(String(body.diseaseId || ''));
    if (!card) return sendJSON(res, 400, { ok: false, error: '没有找到对应的疾病卡片。' });
    if (card.courses.indexOf(course) === -1) {
      return sendJSON(res, 400, {
        ok: false,
        error: '疾病「' + card.name + '」不属于课程「' + course + '」，请重新选择。',
      });
    }
    if (questionType === 'case' && card.type === 'concept') {
      return sendJSON(res, 400, {
        ok: false,
        error:
          '「' + card.name + '」是一个病理学概念而非具体疾病，无法命制病例题。请把题型切换为「知识点题」。',
      });
    }
  }

  const profileBefore = store.summary();
  const messages =
    questionType === 'knowledge'
      ? buildKnowledgeGenerationMessages({
          card: card,
          course: course,
          difficulty: difficulty,
          answerType: answerType,
          taxonomy: taxonomy,
          profile: profileBefore,
          knowledgePoints: card.knowledgePoints,
        })
      : buildGenerationMessages({
          card: card,
          course: course,
          difficulty: difficulty,
          taxonomy: taxonomy,
          profile: profileBefore,
        });

  const raw = await chatJSON({
    system: messages.system,
    user: messages.user,
    temperature: questionType === 'knowledge' ? 0.7 : 0.9,
    maxTokens: 4000,
  });

  const caseData = normalizeCase(raw, questionType, answerType);

  const caseId = crypto.randomUUID();
  caseData.caseId = caseId;
  caseData.course = course;
  caseData.difficulty = difficulty;
  caseData.mode = mode;
  caseData.diseaseId = card.id;
  caseData.diseaseName = card.name;
  caseData.card = card;

  CASES.set(caseId, caseData);
  if (CASES.size > 100) {
    const oldest = CASES.keys().next().value;
    CASES.delete(oldest);
  }

  // 发给前端的内容刻意不含正确答案、真相层和干扰项映射，避免答案泄露
  sendJSON(res, 200, {
    ok: true,
    caseId: caseId,
    course: course,
    difficulty: difficulty,
    mode: mode,
    questionType: questionType,
    answerType: answerType,
    // 定向练习时学生本来就知道自己在练什么；随机测验时先不揭晓
    diseaseName: mode === 'targeted' ? card.name : null,
    title: caseData.title,
    vignette: caseData.vignette,
    question: caseData.question,
    options: caseData.options,
  });
}

async function handleGrade(res, body) {
  const caseId = String(body.caseId || '').trim();

  const caseData = CASES.get(caseId);
  if (!caseData) {
    return sendJSON(res, 400, {
      ok: false,
      code: 'CASE_EXPIRED',
      error: '这道题的数据已经失效（可能是服务重启过），请重新生成一道题。',
    });
  }

  const rawSelected = Array.isArray(body.selectedKeys)
    ? body.selectedKeys
    : body.chosenKey
      ? [body.chosenKey]
      : [];

  const selectedKeys = [];
  rawSelected.forEach(function (key) {
    const normalized = String(key || '').trim().toUpperCase();
    if (OPTION_KEYS.indexOf(normalized) !== -1 && selectedKeys.indexOf(normalized) === -1) {
      selectedKeys.push(normalized);
    }
  });

  if (!selectedKeys.length) {
    return sendJSON(res, 400, { ok: false, error: '请先选择一个选项。' });
  }
  if (caseData.answerType === 'single' && selectedKeys.length > 1) {
    return sendJSON(res, 400, { ok: false, error: '本题是单选题，只能选择一个选项。' });
  }

  const missed = caseData.correctKeys.filter(function (key) {
    return selectedKeys.indexOf(key) === -1;
  });
  const extra = selectedKeys.filter(function (key) {
    return caseData.correctKeys.indexOf(key) === -1;
  });
  const isCorrect = missed.length === 0 && extra.length === 0;
  const partialHit =
    !isCorrect &&
    selectedKeys.some(function (key) {
      return caseData.correctKeys.indexOf(key) !== -1;
    });
  const outcome = isCorrect ? 'correct' : partialHit ? 'partial' : 'wrong';
  const focusKey = extra.length ? extra[0] : missed.length ? missed[0] : selectedKeys[0];

  const profileBefore = store.summary();

  let attribution;
  try {
    attribution = await buildAttribution(
      caseData,
      selectedKeys,
      outcome,
      missed,
      extra,
      focusKey,
      profileBefore
    );
  } catch (err) {
    console.error('[grade] 模型归因失败，使用确定性归因兜底：' + err.message);
    attribution = deterministicAttribution(caseData, selectedKeys, outcome, missed, extra, focusKey);
  }

  const tags = isCorrect
    ? []
    : [attribution.primaryTagId]
        .concat(attribution.secondaryTagIds)
        .filter(function (id) {
          return id && id !== 'none';
        });

  store.record({
    diseaseId: caseData.diseaseId,
    diseaseName: caseData.diseaseName,
    course: caseData.course,
    difficulty: caseData.difficulty,
    correct: isCorrect,
    chosenKey: selectedKeys.join(''),
    correctKey: caseData.correctKeys.join(''),
    confusedWith: attribution.confusedWith,
    tags: tags,
  });

  const stats = store.summary();

  sendJSON(res, 200, {
    ok: true,
    outcome: outcome,
    isCorrect: isCorrect,
    selectedKeys: selectedKeys,
    correctKeys: caseData.correctKeys,
    missed: missed,
    extra: extra,
    questionType: caseData.questionType,
    answerType: caseData.answerType,
    correctLabel: caseData.correctKeys.join('、'),
    diagnosis: caseData.truthLayer.diagnosis,
    diseaseName: caseData.diseaseName,
    course: caseData.course,
    difficulty: caseData.difficulty,
    attribution: {
      enriched: attribution.enriched,
      primaryTag: attribution.primaryTagId === 'none'
        ? null
        : { id: attribution.primaryTagId, name: tagName(attribution.primaryTagId) },
      secondaryTags: attribution.secondaryTagIds.map(function (id) {
        return { id: id, name: tagName(id) };
      }),
      confusedWith: attribution.confusedWith,
      evidence: attribution.evidence,
      analysis: attribution.analysis,
      knowledgePoint: attribution.knowledgePoint,
      remedy: attribution.remedy,
      historyNote: attribution.historyNote,
    },
    teaching: {
      keyFindings: caseData.truthLayer.keyFindings,
      reasoning: caseData.truthLayer.reasoning,
      discriminators: (caseData.card.confusableWith || []).map(function (c) {
        return { disease: c.disease, discriminator: c.discriminator };
      }),
      pathology: caseData.card.pathology || null,
    },
    stats: stats,
  });
}

function handleProfile(res) {
  const state = store.load();
  sendJSON(res, 200, {
    ok: true,
    stats: store.summary(),
    recent: state.attempts.slice(-10).reverse(),
    taxonomy: taxonomy.tags.map(function (t) {
      return { id: t.id, name: t.name };
    }),
  });
}

function handleProfileReset(res) {
  store.reset();
  sendJSON(res, 200, { ok: true, stats: store.summary() });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  const base = path.resolve(PUBLIC_DIR);
  const target = path.resolve(path.join(PUBLIC_DIR, rel));

  if (target !== base && !target.startsWith(base + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(target, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 主服务                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(function (req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { ok: false, error: '不支持的请求方法' });
    }
    return serveStatic(req, res, pathname);
  }

  const route = pathname.replace(/^\/api\//, '');

  if (req.method === 'GET' && route === 'config') return handleConfig(res);
  if (req.method === 'GET' && route === 'profile') return handleProfile(res);
  if (req.method === 'POST' && route === 'profile/reset') return handleProfileReset(res);

  if (req.method === 'POST' && (route === 'generate' || route === 'grade')) {
    return readBody(req)
      .then(function (body) {
        return route === 'generate' ? handleGenerate(res, body) : handleGrade(res, body);
      })
      .catch(function (err) {
        const code = err && err.code ? err.code : 'ERROR';
        const message = err && err.message ? err.message : '服务端发生未知错误';
        console.error('[' + route + '] ' + code + ' ' + message);
        if (!res.headersSent) {
          sendJSON(res, code === 'CASE_EXPIRED' ? 400 : 502, { ok: false, code: code, error: message });
        }
      });
  }

  return sendJSON(res, 404, { ok: false, error: '接口不存在：' + pathname });
});

server.listen(PORT, function () {
  const key = (process.env.API_KEY || '').trim();
  const ready = Boolean(key) && !key.includes('在这里填入');

  console.log('');
  console.log('  病例学习智能体已启动');
  console.log('  ----------------------------------------');
  console.log('  地址：http://localhost:' + PORT);
  console.log('  模型：' + (process.env.MODEL || 'deepseek-chat'));
  const withPoints = CARDS.filter(function (c) {
    return c.knowledgePoints && c.knowledgePoints.length;
  }).length;
  console.log('  疾病卡片：' + CARDS.length + ' 张（其中 ' + withPoints + ' 张带考点）');
  console.log('  错因标签：' + taxonomy.tags.length + ' 个');
  console.log('  API Key：' + (ready ? '已配置' : '未配置（页面上会给出提示）'));
  console.log('');
  console.log('  按 Ctrl + C 停止服务');
  console.log('');
});
