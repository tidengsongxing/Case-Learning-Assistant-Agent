'use strict';

(function () {

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  const state = {
    config: null,
    mode: 'targeted',
    questionType: 'case',
    answerType: 'single',
    course: '',
    difficulty: '进阶',
    currentCase: null,
    selectedKeys: [],
    busy: false,
  };

  const $ = function (sel) {
    return document.querySelector(sel);
  };

  /* 所有插入 DOM 的文本都经过转义 */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function toast(message, isError) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('is-error', Boolean(isError));
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, isError ? 6000 : 2600);
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error('服务端返回了无法解析的内容（HTTP ' + res.status + '）');
    }
    if (!data || !data.ok) {
      throw new Error((data && data.error) || '请求失败（HTTP ' + res.status + '）');
    }
    return data;
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  function setStatus(kind, text) {
    const el = $('#modelStatus');
    el.classList.remove('is-ready', 'is-error');
    if (kind) el.classList.add(kind);
    el.innerHTML = '<span class="dot"></span><span>' + esc(text) + '</span>';
  }

  function fillCourseSelect() {
    const sel = $('#courseSelect');
    sel.innerHTML = state.config.courses
      .map(function (c) {
        return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
      })
      .join('');
    sel.value = state.course;
    sel.addEventListener('change', function () {
      state.course = sel.value;
      fillDiseaseSelect();
    });
  }

  function fillDiseaseSelect() {
    const sel = $('#diseaseSelect');
    const allowConcept = state.questionType === 'knowledge';

    const pool = state.config.diseases.filter(function (d) {
      if (d.courses.indexOf(state.course) === -1) return false;
      if (!allowConcept && d.type === 'concept') return false;
      return true;
    });

    if (!pool.length) {
      sel.innerHTML = '<option value="">该课程暂无可用条目</option>';
      sel.disabled = true;
      return;
    }

    sel.disabled = false;
    sel.innerHTML = pool
      .map(function (d) {
        const chapter = d.chapter && d.chapter[state.course] ? d.chapter[state.course] : '';
        const tags = [];
        if (d.type === 'concept') tags.push('概念');
        if (chapter) tags.push(chapter);
        const label = tags.length ? d.name + '　（' + tags.join(' · ') + '）' : d.name;
        return '<option value="' + esc(d.id) + '">' + esc(label) + '</option>';
      })
      .join('');
  }

  function fillDifficultySelect() {
    const sel = $('#difficultySelect');
    sel.innerHTML = state.config.difficulties
      .map(function (d) {
        return '<option value="' + esc(d) + '">' + esc(d) + '</option>';
      })
      .join('');
    sel.value = state.difficulty;
    sel.addEventListener('change', function () {
      state.difficulty = sel.value;
    });
  }

  /** 给一组分段按钮绑定点击 */
  function bindSegmented(containerId, attrName, onPick) {
    const wrap = $('#' + containerId);
    if (!wrap) return;
    wrap.addEventListener('click', function (event) {
      const btn = event.target.closest('.seg-item');
      if (!btn || state.busy) return;
      Array.prototype.forEach.call(wrap.children, function (child) {
        child.classList.toggle('is-active', child === btn);
      });
      onPick(btn.getAttribute(attrName));
    });
  }

  function selectSegmented(containerId, attrName, value) {
    const wrap = $('#' + containerId);
    if (!wrap) return;
    Array.prototype.forEach.call(wrap.children, function (child) {
      child.classList.toggle('is-active', child.getAttribute(attrName) === value);
    });
  }

  function bindModeToggle() {
    bindSegmented('modeSelect', 'data-mode', function (value) {
      state.mode = value;
      const isRandom = value === 'random';
      $('#diseaseField').style.display = isRandom ? 'none' : '';
      $('#modeHint').textContent = isRandom
        ? '只选课程，由系统随机抽题，作答前不告诉你考的是哪个病。'
        : '选择一个病种，针对性地反复练习。';
    });
  }

  function bindTypeToggle() {
    bindSegmented('typeSelect', 'data-type', function (value) {
      state.questionType = value;
      const isKnowledge = value === 'knowledge';

      $('#answerTypeField').style.display = isKnowledge ? '' : 'none';
      if (!isKnowledge) {
        state.answerType = 'single';
        selectSegmented('answerTypeSelect', 'data-answer', 'single');
      }

      $('#typeHint').textContent = isKnowledge
        ? '不设病例，直接考查知识点的掌握情况，可以选择多选。'
        : '给出完整的病例，选出最可能的诊断。';

      /* 概念类条目不能命制病例题，切换题型时需要重填病种列表 */
      if (state.config) fillDiseaseSelect();
    });
  }

  function bindAnswerTypeToggle() {
    bindSegmented('answerTypeSelect', 'data-answer', function (value) {
      state.answerType = value;
    });
  }

  function renderEmpty() {
    $('#stage').innerHTML = [
      '<div class="empty-state">',
      '  <div class="glyph">＋</div>',
      '  <h3>还没有题目</h3>',
      '  <p>在左侧选择课程、题型、模式和难度，点击「生成题目」开始。',
      '     系统会依据本地疾病卡片命题，作答后给出针对性的错因分析。</p>',
      '</div>',
    ].join('');
  }

  function renderLoading(title, sub) {
    $('#stage').innerHTML = [
      '<div class="loading-state">',
      '  <div class="spinner"></div>',
      '  <p>' + esc(title || '正在命制病例题…') + '</p>',
      '  <p class="sub">' + esc(sub || '模型正在依据疾病卡片构造病例与干扰项，通常需要 10 到 30 秒') + '</p>',
      '</div>',
    ].join('');
  }

  function renderError(message) {
    $('#stage').innerHTML = [
      '<div class="empty-state">',
      '  <div class="glyph" style="background:var(--bad-soft);color:var(--bad)">!</div>',
      '  <h3>出错了</h3>',
      '  <p>' + esc(message) + '</p>',
      '</div>',
    ].join('');
  }

  /* ------------------------------------------------------------------ */
  /* 渲染题目                                                            */
  /* ------------------------------------------------------------------ */

  function sectionBlock(label, body) {
    if (!body) return '';
    return [
      '<div class="section-block">',
      '  <div class="section-label">' + esc(label) + '</div>',
      '  <p class="section-body">' + esc(body) + '</p>',
      '</div>',
    ].join('');
  }

  function renderCase(caseData) {
    const v = caseData.vignette;
    const isMultiple = caseData.answerType === 'multiple';
    const isKnowledge = caseData.questionType === 'knowledge';

    const chips = [
      '<span class="chip">' + esc(caseData.course) + '</span>',
      '<span class="chip muted">' + esc(caseData.difficulty) + '</span>',
      '<span class="chip">' + (isKnowledge ? '知识点题' : '病例题') + '</span>',
    ];
    if (isMultiple) chips.push('<span class="chip">多选题</span>');
    if (caseData.diseaseName) {
      chips.push('<span class="chip">' + esc(caseData.diseaseName) + '</span>');
    } else if (caseData.mode === 'random') {
      chips.push('<span class="chip muted">随机测验 · 暂不揭晓</span>');
    }

    const optionsHtml = (caseData.options || [])
      .map(function (o) {
        const selected = state.selectedKeys.indexOf(o.key) !== -1;
        return [
          '<button type="button" class="option' + (selected ? ' is-selected' : '') + '"',
          '        data-key="' + esc(o.key) + '">',
          '  <span class="option-key">' + esc(o.key) + '</span>',
          '  <span class="option-text">' + esc(o.text) + '</span>',
          '</button>',
        ].join('');
      })
      .join('');

    $('#stage').innerHTML = [
      '<div class="case-head">',
      '  <div>',
      '    <h2 class="case-title">' + esc(caseData.title || '题目') + '</h2>',
      '    <div class="chips">' + chips.join('') + '</div>',
      '  </div>',
      '</div>',
      v ? sectionBlock('主诉', v.chiefComplaint) : '',
      v ? sectionBlock('现病史', v.history) : '',
      v ? sectionBlock('体格检查', v.exam) : '',
      v ? sectionBlock('辅助检查', v.tests) : '',
      '<div class="question-block">' + esc(caseData.question) + '</div>',
      isMultiple ? '<p class="field-hint" style="margin:-8px 0 14px">本题为多选题，请选出所有正确选项。</p>' : '',
      '<div class="options" id="optionList">' + optionsHtml + '</div>',
      '<div class="actions">',
      '  <button type="button" class="btn btn-primary" id="submitBtn">提交作答</button>',
      '  <button type="button" class="btn btn-ghost" id="skipBtn">换一题</button>',
      '</div>',
    ].join('');

    $('#optionList').addEventListener('click', function (event) {
      if (state.busy) return;
      const btn = event.target.closest('.option');
      if (!btn) return;

      const key = btn.getAttribute('data-key');
      if (isMultiple) {
        const existing = state.selectedKeys.indexOf(key);
        if (existing === -1) {
          state.selectedKeys.push(key);
        } else {
          state.selectedKeys.splice(existing, 1);
        }
      } else {
        state.selectedKeys = [key];
      }

      Array.prototype.forEach.call($('#optionList').children, function (child) {
        child.classList.toggle('is-selected', state.selectedKeys.indexOf(child.getAttribute('data-key')) !== -1);
      });
    });

    $('#submitBtn').addEventListener('click', submit);
    $('#skipBtn').addEventListener('click', generate);
  }

  /* ------------------------------------------------------------------ */
  /* 渲染结果                                                            */
  /* ------------------------------------------------------------------ */

  function optionReviewHtml(data) {
    const correct = data.correctKeys || [];
    const selected = data.selectedKeys || [];

    return (state.currentCase.options || [])
      .map(function (o) {
        const isRight = correct.indexOf(o.key) !== -1;
        const isPicked = selected.indexOf(o.key) !== -1;

        let cls = 'option';
        if (isRight) cls += ' is-correct';
        if (isPicked && !isRight) cls += ' is-wrong';

        const notes = [];
        if (isRight) notes.push('正确答案');
        if (isPicked) notes.push(isRight ? '你的选择 · 正确' : '你的选择 · 错误');
        if (!isPicked && isRight) notes.push('漏选');

        return [
          '<div class="' + cls + '">',
          '  <span class="option-key">' + esc(o.key) + '</span>',
          '  <span class="option-text">' + esc(o.text) +
            (notes.length ? '<span class="option-tag">' + esc(notes.join('　·　')) + '</span>' : '') +
            '</span>',
          '</div>',
        ].join('');
      })
      .join('');
  }

  function renderResult(data) {
    const a = data.attribution || {};
    const t = data.teaching || {};
    const isKnowledge = data.questionType === 'knowledge';
    const v = state.currentCase.vignette;

    const tagChips = [];
    if (a.primaryTag) {
      tagChips.push('<span class="tag is-primary">' + esc(a.primaryTag.name) + '</span>');
    }
    (a.secondaryTags || []).forEach(function (tag) {
      tagChips.push('<span class="tag">' + esc(tag.name) + '</span>');
    });

    const findingList = (t.keyFindings || []).length
      ? '<ul class="bullet-list">' + t.keyFindings.map(function (f) {
          return '<li>' + esc(f) + '</li>';
        }).join('') + '</ul>'
      : '';

    const discList = (t.discriminators || []).length
      ? t.discriminators.map(function (d) {
          return '<div class="discriminator"><span class="dx">' + esc(d.disease) + '</span>' + esc(d.discriminator) + '</div>';
        }).join('')
      : '<p class="empty-note">暂无鉴别要点。</p>';

    const pathoHtml = t.pathology
      ? [
          '<div class="card">',
          '  <div class="card-head"><h4>病理改变</h4></div>',
          t.pathology.gross ? '<p class="kv"><b>大体：</b>' + esc(t.pathology.gross) + '</p>' : '',
          t.pathology.microscopic ? '<p class="kv"><b>镜下：</b>' + esc(t.pathology.microscopic) + '</p>' : '',
          '</div>',
        ].join('')
      : '';

    const attributionCard = data.outcome === 'correct'
      ? [
          '<div class="card card-accent">',
          '  <div class="card-head"><h4>本题点评</h4></div>',
          a.analysis ? '<p class="kv">' + esc(a.analysis) + '</p>' : '',
          a.knowledgePoint ? '<p class="kv"><b>核心知识点：</b>' + esc(a.knowledgePoint) + '</p>' : '',
          a.remedy ? '<p class="kv"><b>巩固建议：</b>' + esc(a.remedy) + '</p>' : '',
          '</div>',
        ].join('')
      : [
          '<div class="card card-accent">',
          '  <div class="card-head"><h4>错因归因</h4>' + (tagChips.length ? '<div class="tag-row">' + tagChips.join('') + '</div>' : '') + '</div>',
          a.confusedWith ? '<p class="kv"><b>你混淆成的诊断：</b>' + esc(a.confusedWith) + '</p>' : '',
          a.evidence ? '<p class="kv"><b>判断依据：</b>' + esc(a.evidence) + '</p>' : '',
          a.analysis ? '<p class="kv"><b>问题出在哪：</b>' + esc(a.analysis) + '</p>' : '',
          a.knowledgePoint ? '<p class="kv"><b>需要复习的知识点：</b>' + esc(a.knowledgePoint) + '</p>' : '',
          a.remedy ? '<p class="kv"><b>补救建议：</b>' + esc(a.remedy) + '</p>' : '',
          a.historyNote ? '<div class="note-line">' + esc(a.historyNote) + '</div>' : '',
          a.enriched === false ? '<p class="fallback-note">（本次由本地规则直接给出归因，未调用模型做深度分析）</p>' : '',
          '</div>',
        ].join('');

    const verdictClass =
      data.outcome === 'correct' ? 'is-correct' : data.outcome === 'partial' ? 'is-partial' : 'is-wrong';
    const verdictIcon = data.outcome === 'correct' ? '✓' : data.outcome === 'partial' ? '±' : '✕';
    const verdictText =
      data.outcome === 'correct' ? '回答正确' : data.outcome === 'partial' ? '部分正确' : '回答错误';
    const verdictDetail =
      data.outcome === 'partial'
        ? (data.extra.length ? '多选了错误选项，' : '漏选了正确选项，') + '正确答案是 ' + data.correctLabel
        : '正确答案是 ' + data.correctLabel + '　·　' + (isKnowledge ? '考点：' : '诊断：') + data.diagnosis;

    $('#stage').innerHTML = [
      '<div class="verdict ' + verdictClass + '">',
      '  <div class="verdict-icon">' + verdictIcon + '</div>',
      '  <div class="verdict-text">',
      '    <strong>' + verdictText + '</strong>',
      '    <span>' + esc(verdictDetail) + '</span>',
      '  </div>',
      '</div>',

      '<div class="card">',
      '  <div class="card-head"><h4>题目回顾</h4></div>',
      isKnowledge ? '' : '  <p class="kv"><b>主诉：</b>' + esc(v ? v.chiefComplaint : '') + '</p>',
      '  <p class="kv"><b>提问：</b>' + esc(state.currentCase.question) + '</p>',
      '  <div class="options">' + optionReviewHtml(data) + '</div>',
      '</div>',

      attributionCard,

      '<div class="card">',
      '  <div class="card-head"><h4>' + (isKnowledge ? '考点解析' : '答案解析') + '</h4></div>',
      t.reasoning ? '<p class="kv">' + esc(t.reasoning) + '</p>' : '',
      findingList ? '<p class="kv"><b>' + (isKnowledge ? '关键事实：' : '支持该诊断的关键发现：') + '</b></p>' + findingList : '',
      '</div>',

      isKnowledge ? '' : [
        '<div class="card">',
        '  <div class="card-head"><h4>鉴别要点</h4></div>',
        discList,
        '</div>',
      ].join(''),

      pathoHtml,

      '<div class="actions">',
      '  <button type="button" class="btn btn-primary" id="againBtn">再来一题</button>',
      '</div>',
    ].join('');

    $('#againBtn').addEventListener('click', generate);
  }

  /* ------------------------------------------------------------------ */
  /* 学习画像                                                            */
  /* ------------------------------------------------------------------ */

  function renderProfile(stats) {
    const s = stats || { total: 0, correct: 0, tagCounts: {} };
    const rate = s.total ? Math.round((s.correct / s.total) * 100) : 0;

    $('#profileStats').innerHTML = [
      '<div class="stat"><span class="value">' + esc(s.total) + '</span><span class="label">累计答题</span></div>',
      '<div class="stat"><span class="value">' + esc(rate) + '%</span><span class="label">正确率</span></div>',
    ].join('');

    const counts = s.tagCounts || {};
    const tags = (state.config && state.config.taxonomy) || [];
    const max = Math.max.apply(
      null,
      [1].concat(tags.map(function (t) { return counts[t.id] || 0; }))
    );

    if (!tags.length) {
      $('#tagBars').innerHTML = '<p class="empty-note">暂无数据。</p>';
      return;
    }

    $('#tagBars').innerHTML = tags
      .map(function (t) {
        const count = counts[t.id] || 0;
        const width = Math.round((count / max) * 100);
        return [
          '<div class="tag-bar' + (count ? '' : ' is-zero') + '">',
          '  <div class="tag-bar-head"><span>' + esc(t.name) + '</span><span>' + esc(count) + '</span></div>',
          '  <div class="tag-bar-track"><div class="tag-bar-fill" style="width:' + width + '%"></div></div>',
          '</div>',
        ].join('');
      })
      .join('');
  }

  /* ------------------------------------------------------------------ */
  /* 动作                                                                */
  /* ------------------------------------------------------------------ */

  function setBusy(busy) {
    state.busy = busy;
    const btn = $('#generateBtn');
    btn.disabled = busy;
    btn.textContent = busy ? '生成中…' : '生成题目';
  }

  async function generate() {
    if (state.busy) return;

    if (!state.config) {
      toast('配置尚未加载完成', true);
      return;
    }

    const body = {
      course: state.course,
      difficulty: state.difficulty,
      mode: state.mode,
      questionType: state.questionType,
      answerType: state.answerType,
    };

    if (state.mode === 'targeted') {
      const diseaseId = $('#diseaseSelect').value;
      if (!diseaseId) {
        toast('请先选择一个病种', true);
        return;
      }
      body.diseaseId = diseaseId;
    }

    state.selectedKeys = [];
    setBusy(true);
    renderLoading(
      state.questionType === 'knowledge' ? '正在命制知识点题…' : '正在命制病例题…'
    );

    try {
      const data = await postJSON('/api/generate', body);
      state.currentCase = data;
      renderCase(data);
    } catch (err) {
      renderError(err.message);
      toast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (state.busy) return;
    if (!state.selectedKeys.length) {
      toast('请先选择一个选项', true);
      return;
    }
    if (!state.currentCase) return;

    setBusy(true);
    const submitBtn = $('#submitBtn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '正在分析…';
    }
    Array.prototype.forEach.call(document.querySelectorAll('.option'), function (el) {
      el.disabled = true;
    });

    try {
      const data = await postJSON('/api/grade', {
        caseId: state.currentCase.caseId,
        selectedKeys: state.selectedKeys,
      });
      renderResult(data);
      renderProfile(data.stats);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      // 判分失败时退回题面，保留学生已选的答案
      renderCase(state.currentCase);
      toast(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function resetProfile() {
    if (!window.confirm('确定要清空所有答题记录和错因统计吗？此操作不可撤销。')) return;
    try {
      const res = await fetch('/api/profile/reset', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '清空失败');
      renderProfile(data.stats);
      toast('学习记录已清空');
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function init() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '配置加载失败');

      state.config = data;
      state.course = data.courses.indexOf('内科学') !== -1 ? '内科学' : data.courses[0];
      state.difficulty = data.difficulties.indexOf('进阶') !== -1 ? '进阶' : data.difficulties[0];

      fillCourseSelect();
      fillDiseaseSelect();
      fillDifficultySelect();

      if (data.modelReady) {
        setStatus('is-ready', '模型已连接 · ' + data.model);
      } else {
        setStatus('is-error', '未检测到 API Key');
        toast('还没有配置 API_KEY。请把 .env.example 复制成 .env 并填入你的 Key，然后重启服务。', true);
      }

      renderProfile(data.stats);
      renderEmpty();
    } catch (err) {
      setStatus('is-error', '本地服务连接失败');
      renderError('无法连接到本地服务：' + err.message + '　请确认 server.js 正在运行。');
    }

    bindModeToggle();
    bindTypeToggle();
    bindAnswerTypeToggle();
    $('#generateBtn').addEventListener('click', generate);
    $('#resetProfileBtn').addEventListener('click', resetProfile);
  }

  document.addEventListener('DOMContentLoaded', init);

})();
