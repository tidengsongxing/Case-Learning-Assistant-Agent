'use strict';

/**
 * 提示词构造。
 * 设计原则：
 *  1. 把疾病卡片作为唯一知识来源塞进上下文，限制模型自由发挥；
 *  2. 要求每个干扰项绑定一个易混淆疾病 + 错因标签，让归因几乎成为确定性映射；
 *  3. 强制 JSON 输出，方便后端校验与前端渲染。
 */

function courseAngle(course) {
  if (course === '诊断学') {
    return [
      '本题属于《诊断学》课程，考查重点是症状学、体格检查与辅助检查判读。',
      '题干应保留较完整的体征细节（如叩诊音、语音震颤、呼吸音、触诊发现）和关键检验数值，',
      '要求学生依据这些体征线索作出判断或解释其临床意义。避免考查治疗方案的细节。',
    ].join('');
  }
  if (course === '病理学') {
    return [
      '本题属于《病理学》课程，考查重点是大体病理改变与镜下病理改变、病变分期与转归。',
      '题干应以病变的形态学描述为主（如大体外观、切面特点、镜下细胞与组织结构变化），',
      '提问应指向病理诊断、病变分期或形态学特征，而不是临床治疗方案。',
    ].join('');
  }
  return [
    '本题属于《内科学》课程，考查重点是诊断与鉴别诊断、以及诊断路径中检查项目的选择。',
    '题干应呈现较完整的病史、体征与辅助检查结果，提问应指向最可能的诊断、',
    '首选的诊断性检查或关键的鉴别依据。避免考查具体药物剂量与疗程。',
  ].join('');
}

function difficultyGuide(difficulty) {
  if (difficulty === '基础') {
    return [
      '难度：基础。病例应呈现该疾病最典型的表现，线索清晰直白。',
      '三个干扰项与正确选项之间的鉴别点应当明显，适合刚学完该章节的学生巩固基础。',
    ].join('');
  }
  if (difficulty === '挑战') {
    return [
      '难度：挑战。应加入一到两条不典型或容易误导的信息，使干扰项与正确选项在多数线索上高度重叠。',
      '学生必须抓住卡片中记载的关键鉴别点才能选对。但要注意：无论信息多么复杂，',
      '正确答案必须是唯一的，绝不能出现两个选项都说得通的情况。',
    ].join('');
  }
  return [
    '难度：进阶。应以典型表现为基础，加入一到两条需要多想一想的信息。',
    '每个干扰项都应与正确选项存在部分相似线索，迫使学生做鉴别而不是凭印象。',
  ].join('');
}

function tagList(taxonomy) {
  return taxonomy.tags
    .map(function (t) {
      return '- ' + t.id + '（' + t.name + '）：' + t.description;
    })
    .join('\n');
}

/** 生成病例题的提示词 */
function buildGenerationMessages(options) {
  const card = options.card;
  const course = options.course;
  const difficulty = options.difficulty || '进阶';
  const taxonomy = options.taxonomy;
  const profile = options.profile || { tagCounts: {} };

  const weakTags = Object.keys(profile.tagCounts || {})
    .sort(function (a, b) {
      return profile.tagCounts[b] - profile.tagCounts[a];
    })
    .slice(0, 2)
    .filter(function (id) {
      return profile.tagCounts[id] > 0;
    });

  const weakHint = weakTags.length
    ? [
        '',
        '【学生的历史薄弱项】',
        '这位学生过去在以下错因上反复出错：' +
          weakTags
            .map(function (id) {
              const found = taxonomy.tags.filter(function (t) {
                return t.id === id;
              })[0];
              return (found ? found.name : id) + '（' + profile.tagCounts[id] + ' 次）';
            })
            .join('、') +
          '。',
        '请在保证医学严谨的前提下，把这类陷阱自然地设计进干扰项里。',
      ].join('\n')
    : '';

  const system = [
    '你是一位资深的医学教育命题专家，长期为临床医学本科二年级学生编写病例题。',
    '你出的题严谨、贴近教材、答案唯一，且每一个干扰项都有明确的教学目的。',
    '',
    '你必须只输出一个 JSON 对象，不要输出任何解释性文字，不要使用 Markdown 代码块，',
    '不要添加 JSON 结构之外的任何字段。',
    '（回答必须是一个合法的 json 对象。）',
    '',
    '【必须遵守的规则】',
    '1. 你的全部医学内容只能来自下方提供的疾病卡片。不得引入卡片之外的检查项目、诊断标准或疾病名称。',
    '2. 病例题干中绝对不能出现最终诊断的名称，也不能出现足以直接指认该诊断的同义表述。',
    '3. 四个选项中只有一个正确；另外三个错误选项，必须分别对应疾病卡片「易混淆疾病」列表中的疾病。',
    '4. 每个错误选项都要绑定 1 到 2 个错因标签，标签只能取自下方给出的错因标签 id 列表。',
    '5. 病例必须自洽：每一条体征和检查结果都要与正确诊断的卡片内容一致，不得前后矛盾。',
    '6. 不得为了增加难度而制造信息不足的情况；正确答案必须是唯一且可被病例信息支持的。',
    '7. 所有内容使用简体中文书写，使用规范的医学术语。',
  ].join('\n');

  const user = [
    '请依据下面的疾病卡片，命制一道单选题。',
    '',
    '【课程与考查角度】',
    courseAngle(course),
    difficultyGuide(difficulty),
    '',
    '【疾病卡片（唯一知识来源）】',
    JSON.stringify(card, null, 2),
    '',
    '【允许使用的错因标签 id】',
    tagList(taxonomy),
    '',
    '【本次命题指定课程】' + course,
    '题干中出现的信息，必须能在上面这张卡片里找到依据。',
    weakHint,
    '',
    '【输出 JSON 结构】',
    '请严格按下面的结构输出，字段名一字不差：',
    '',
    '{',
    '  "vignette": {',
    '    "title": "一句话标题，例如：突发胸痛的青年男性",',
    '    "chiefComplaint": "主诉，一句话，含主要症状与持续时间",',
    '    "history": "现病史，3 到 5 句，交代起病经过、诱因、伴随症状，但不得点明诊断",',
    '    "exam": "体格检查要点，列出与鉴别相关的阳性与阴性体征",',
    '    "tests": "辅助检查结果，列出关键检查及其结果"',
    '  },',
    '  "question": "提问，明确指向单一考点",',
    '  "options": [',
    '    { "key": "A", "text": "选项内容" },',
    '    { "key": "B", "text": "选项内容" },',
    '    { "key": "C", "text": "选项内容" },',
    '    { "key": "D", "text": "选项内容" }',
    '  ],',
    '  "correctKey": "正确选项的字母，只能是 A、B、C、D 之一",',
    '  "truthLayer": {',
    '    "diagnosis": "正确诊断名称",',
    '    "keyFindings": ["支持该诊断的关键发现，2 到 4 条"],',
    '    "reasoning": "2 到 4 句推理说明，讲清从病例信息到诊断的链条"',
    '  },',
    '  "distractorMap": {',
    '    "B": {',
    '      "disease": "该错误选项对应的疾病名称",',
    '      "errorTags": ["错因标签 id，1 到 2 个"],',
    '      "whyWrong": "一句话说明选它错在哪里，指出被误读的那个线索"',
    '    }',
    '  }',
    '}',
    '',
    '注意：distractorMap 的键必须恰好是三个错误选项的字母，不要包含正确选项。',
    '请直接输出 JSON。',
  ].join('\n');

  return { system, user };
}

/** 生成知识点题的提示词（无病例，直接考查知识的掌握） */
function buildKnowledgeGenerationMessages(options) {
  const card = options.card;
  const course = options.course;
  const difficulty = options.difficulty || '进阶';
  const answerType = options.answerType === 'multiple' ? 'multiple' : 'single';
  const taxonomy = options.taxonomy;
  const points = Array.isArray(options.knowledgePoints) ? options.knowledgePoints : [];

  const system = [
    '你是一位资深的医学教育命题专家，长期为临床医学本科二年级学生编写考试题。',
    '这次你命制的是「知识点题」：不设病例，直接考查学生对某个具体知识点的掌握情况。',
    '',
    '你必须只输出一个 JSON 对象，不要输出任何解释性文字，不要使用 Markdown 代码块。',
    '（回答必须是一个合法的 json 对象。）',
    '',
    '【必须遵守的规则】',
    '1. 你的全部内容只能来自下方提供的疾病卡片与考点列表，不得引入列表之外的医学事实。',
    '2. 正确选项必须取自考点列表的 correct 项；可以改写措辞，但语义不得改变，也不得弱化。',
    '3. 错误选项必须取自考点列表的 wrong 项，或是对 correct 项的常见误改。',
    '   错误选项必须是能够明确判定为错误的陈述，不能是模棱两可、存在争议或部分正确的表述。',
    '4. 选项数量为 4 到 5 个，选项之间不得语义重复。',
    '5. 每个错误选项都要绑定 1 到 2 个错因标签，标签只能取自下方给出的错因标签 id 列表。',
    '6. 一道题只考一个考点，不要把多个考点的内容混在一起。',
    '7. 所有内容使用简体中文，使用规范的医学术语。',
  ].join('\n');

  const answerRule =
    answerType === 'multiple'
      ? '本题为多选题：必须正好有 2 到 3 个正确选项，其余为错误选项。'
      : '本题为单选题：必须有且只有 1 个正确选项。';

  const difficultyLine =
    difficulty === '基础'
      ? '难度：基础。正确答案应直接对应考点原文，错误选项与正确选项差异明显。'
      : difficulty === '挑战'
        ? '难度：挑战。错误选项应当具有较强的迷惑性，例如只改动一个关键词、把两个概念对调、或加上一个看似合理的限定词。'
        : '难度：进阶。错误选项应针对学生常见的错误认知设计，不能一眼看出对错。';

  const pointsBlock = points.length
    ? JSON.stringify(points, null, 2)
    : '（本疾病暂无专门整理的考点，请从下方疾病卡片的 pathology、diagnosticCriteria、keyTests、confusableWith、commonMistakes 等字段中提取考点。）';

  const user = [
    '请依据下面的资料，命制一道知识点题。',
    '',
    '【本次题型】知识点题（无病例）',
    '【考查课程】' + course,
    '【作答方式】' + (answerType === 'multiple' ? '多选' : '单选'),
    '【命题规则】' + answerRule,
    difficultyLine,
    '',
    '【疾病卡片】',
    JSON.stringify(card, null, 2),
    '',
    '【可供考查的考点】',
    pointsBlock,
    '',
    '【允许使用的错因标签 id】',
    tagList(taxonomy),
    '',
    '【输出 JSON 结构】',
    '请严格按下面的结构输出，字段名一字不差：',
    '',
    '{',
    '  "title": "考点的简短标题",',
    '  "question": "提问，例如：关于甲状旁腺腺瘤，下列说法正确的是",',
    '  "options": [',
    '    { "key": "A", "text": "选项内容" }',
    '  ],',
    '  "correctKeys": ["正确选项的字母，至少一个；多选题为 2 到 3 个"],',
    '  "truthLayer": {',
    '    "topic": "该题考查的考点名称",',
    '    "keyFacts": ["该考点的关键事实，2 到 4 条"],',
    '    "reasoning": "2 到 4 句说明，讲清每个选项为什么对或错"',
    '  },',
    '  "distractorMap": {',
    '    "B": {',
    '      "disease": "该错误说法所混淆的概念或疾病",',
    '      "errorTags": ["错因标签 id，1 到 2 个"],',
    '      "whyWrong": "一句话说明这句话错在哪里"',
    '    }',
    '  }',
    '}',
    '',
    '注意：distractorMap 的键只能是错误选项的字母，不要包含任何正确选项。',
    '提问中不要自己标注「单选」或「多选」，界面会另行提示。',
    '请直接输出 JSON。',
  ].join('\n');

  return { system, user };
}

/** 错因归因 + 解析的提示词 */
function buildAttributionMessages(options) {
  const caseData = options.caseData;
  const chosenKeys = Array.isArray(options.chosenKeys) ? options.chosenKeys : [];
  const base = options.base;
  const taxonomy = options.taxonomy;
  const profile = options.profile || { tagCounts: {} };
  const outcome = options.outcome || 'wrong';
  const missed = Array.isArray(options.missed) ? options.missed : [];
  const extra = Array.isArray(options.extra) ? options.extra : [];
  const focusKey = options.focusKey || chosenKeys[0] || '';
  const isKnowledge = caseData.questionType === 'knowledge';
  const isCorrect = outcome === 'correct';

  const chosenText = chosenKeys
    .map(function (key) {
      return key + '（' + textOfOption(caseData, key) + '）';
    })
    .join('、');

  const system = [
    '你是一位临床带教老师，专门为二年级医学生讲评医学题目，既有病例题也有知识点题。',
    '你的讲评风格务实、具体，最大的特点是从不满足于揭晓答案，',
    '而是精准指出学生思维在哪一步偏离了，并给出可执行的补救方向。',
    '',
    '你必须只输出一个 JSON 对象，不要输出任何解释性文字，不要使用 Markdown 代码块。',
    '所有文字使用简体中文，语气客观、尊重学生，不嘲讽、不空洞说教。',
    '（回答必须是一个合法的 json 对象。）',
  ].join('\n');

  const historyLine = Object.keys(profile.tagCounts || {})
    .filter(function (id) {
      return profile.tagCounts[id] > 0;
    })
    .map(function (id) {
      return id + '（累计 ' + profile.tagCounts[id] + ' 次）';
    })
    .join('、');

  const task = isCorrect
    ? isKnowledge
      ? [
          '这位学生答对了。请写一份强化型讲评：确认他掌握了什么，',
          '并点出这个考点里最容易记混的那一条，防止他下次在这里出错。',
        ].join('')
      : [
          '这位学生答对了。请写一份强化型讲评：确认他做对了什么，',
          '点明本题中最有价值的那条鉴别证据，防止他以后靠运气答对。',
        ].join('')
    : outcome === 'partial'
      ? [
          '这位学生是部分正确：要么有正确选项没有选全，要么多选了错误的选项。请写一份归因型讲评，要求：',
          '第一，区分清楚他是「漏选」还是「多选」——漏选说明掌握不完整，多选说明概念混淆；',
          '第二，必须引用选项中的具体内容作为依据，指出他漏掉或被误导的那一条；',
          '第三，给出具体的补漏动作，不要泛泛而谈。',
        ].join('')
      : [
          '这位学生答错了。请写一份归因型讲评，要求：',
          '第一，明确他的思维在哪一步偏离，是知识点没掌握，还是被某条线索误导；',
          '第二，必须引用题干或选项中的具体内容作为依据，而不是泛泛地说「你没有掌握」；',
          '第三，绝对不能只写「正确答案是 X」，那样没有教学价值。',
        ].join('');

  const stemLines = [
    '【题目】',
    '标题：' + ((caseData.vignette && caseData.vignette.title) || caseData.title || ''),
  ];
  if (!isKnowledge && caseData.vignette) {
    if (caseData.vignette.chiefComplaint) stemLines.push('主诉：' + caseData.vignette.chiefComplaint);
    if (caseData.vignette.history) stemLines.push('现病史：' + caseData.vignette.history);
    if (caseData.vignette.exam) stemLines.push('体格检查：' + caseData.vignette.exam);
    if (caseData.vignette.tests) stemLines.push('辅助检查：' + caseData.vignette.tests);
  }
  stemLines.push('提问：' + (caseData.question || ''));

  const answerLines = [
    '【学生的作答】',
    '学生选择：' + (chosenText || '未选择'),
    '作答结果：' + (isCorrect ? '完全正确' : outcome === 'partial' ? '部分正确' : '错误'),
  ];
  if (missed.length) answerLines.push('漏选的正确选项：' + missed.join('、'));
  if (extra.length) answerLines.push('多选的错误选项：' + extra.join('、'));

  const user = stemLines
    .concat([
      '',
      '【选项】',
      (caseData.options || [])
        .map(function (o) {
          return o.key + '. ' + o.text + (caseData.correctKeys.indexOf(o.key) !== -1 ? '　（正确选项）' : '');
        })
        .join('\n'),
      '',
      '【答案与考点】',
      '正确答案：' + caseData.correctKeys.join('、'),
      (isKnowledge ? '考查考点：' : '正确诊断：') + (caseData.truthLayer ? caseData.truthLayer.diagnosis : ''),
      '关键事实：' + ((caseData.truthLayer && caseData.truthLayer.keyFindings) || []).join('；'),
      '推理说明：' + (caseData.truthLayer ? caseData.truthLayer.reasoning : ''),
      '',
    ])
    .concat(answerLines)
    .concat([
      '',
      '【系统预置的干扰项映射（权威，请以此为归因基础）】',
      JSON.stringify(
        (caseData.distractorMap && caseData.distractorMap[focusKey]) || base || {},
        null,
        2
      ),
      '',
      '【允许使用的错因标签】',
      tagList(taxonomy),
      '',
      '【该学生的历史错因统计】',
      historyLine ? historyLine : '暂无历史记录。',
      '',
      '【本次任务】',
      task,
      '',
      '【输出 JSON 结构】',
      '请严格按下面的结构输出，字段名一字不差：',
      '',
      '{',
      '  "primaryTagId": "最主要的错因标签 id，必须来自上方标签列表；完全答对填 \"none\"，多选题漏选填 \"omission\"",',
      '  "secondaryTagIds": ["次要错因标签 id，可为空数组"],',
      '  "confusedWith": "学生实际上混淆成的疾病或概念名称；若不存在则填空字符串",',
      '  "evidence": "引用题干或选项中的具体内容，说明学生为什么会做出这个选择，2 到 3 句",',
      '  "analysis": "针对性分析，3 到 5 句，讲清楚偏离发生在哪一步；若答对则改为强化型分析",',
      '  "knowledgePoint": "需要复习的具体知识点，一句话",',
      '  "remedy": "一条可执行的补救建议，一句话，要具体到动作",',
      '  "historyNote": "如果该错因在历史统计中反复出现，用一句话指出；否则填空字符串"',
      '}',
      '',
      '请直接输出 JSON。',
    ])
    .join('\n');

  return { system, user };
}

function textOfOption(caseData, key) {
  if (!caseData || !Array.isArray(caseData.options)) return '';
  const found = caseData.options.filter(function (o) {
    return o && o.key === key;
  })[0];
  return found ? found.text : '';
}

module.exports = {
  buildGenerationMessages,
  buildKnowledgeGenerationMessages,
  buildAttributionMessages,
  courseAngle,
};
