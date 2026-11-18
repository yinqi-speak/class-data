/* ============================================================
 * app.js — 班级成长档案 · 界面与交互
 * 依赖：store.js（Store）
 * ============================================================ */
(function () {
  'use strict';

  var S = window.Store;
  var KEY = 'class-growth-v1';
  var SESSION = 'class-growth-session-v1';
  var THEME_KEY = 'class-growth-theme-v1';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n, d) { return Number(n).toFixed(d == null ? 1 : d); }

  /* ---------------- 状态 ---------------- */
  var state = {
    db: null,
    role: 'parent',          // parent | teacher
    studentId: null,         // 家长端当前学生
    teacherTab: 't-home',
    parentTab: 'p-overview',
    filterStudent: '',
    filterExam: '',
    scoresExam: '',
    wrongExam: '',
    photos: [],              // 当前表单里的临时照片
    modalSave: null,
    dirty: false,
    parentCfg: false,      // 是否由「家长专用网址」进入
    cloudError: ''         // 上次上传失败原因（空=无错误）
  };

  /* ---------------- 外观主题 ---------------- */
  function currentTheme() {
    try { return localStorage.getItem(THEME_KEY) === 'fresh' ? 'fresh' : 'paper'; }
    catch (e) { return 'paper'; }
  }
  function applyTheme(t) {
    if (t === 'fresh') document.documentElement.setAttribute('data-theme', 'fresh');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  function themeBlock() {
    var t = currentTheme();
    return '<div class="theme-pick">' +
      '<button class="theme-opt' + (t === 'paper' ? ' on' : '') + '" data-act="theme" data-theme="paper">' +
        '<span class="theme-sw"><i style="background:#F6F1E3"></i><i style="background:#1E4D43"></i><i style="background:#E8B317"></i></span>' +
        '<b>课堂纸感 ✦ 新</b><small>米白方格纸 · 黑板绿 · 中黄铅笔</small></button>' +
      '<button class="theme-opt' + (t === 'fresh' ? ' on' : '') + '" data-act="theme" data-theme="fresh">' +
        '<span class="theme-sw"><i style="background:#F5F7F6"></i><i style="background:#1F6F5C"></i><i style="background:#E8F3EF"></i></span>' +
        '<b>清爽绿</b><small>最初的简洁版本，随时可切回</small></button>' +
      '</div>';
  }

  /* ---------------- 本地存储 / 云同步 ---------------- */
  function loadLocal() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) {
        var initial = S.demoDB();
        // 首次启动就把演示数据落盘，保证「打开即有数据」且不依赖后续是否点过编辑
        try { localStorage.setItem(KEY, JSON.stringify(initial)); } catch (e2) {}
        return initial;
      }
      return S.normalize(JSON.parse(raw));
    } catch (e) { return S.demoDB(); }
  }
  function saveLocal() {
    try { localStorage.setItem(KEY, JSON.stringify(state.db)); return true; }
    catch (e) { toast('本机存储失败：' + e.message); return false; }
  }
  var pushTimer = null;
  function persist(msg) {
    saveLocal();
    state.dirty = true;
    if (msg) toast(msg);
    renderBadge();
    // GitHub 模式用 ghRepo+ghToken，通用模式用 putUrl。
    // 原逻辑只判断 putUrl，导致 GitHub 模式下永远不自动上传。
    var c = state.db.cloud || {};
    var canPush = c.enabled && (
      (c.mode === 'github' && c.ghRepo && c.ghToken) ||
      (c.mode !== 'github' && c.putUrl)
    );
    // 防抖：连续编辑只在停手 1.5 秒后上传一次，避免刷出一堆提交
    if (canPush) {
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(function () { pushTimer = null; pushCloud(); }, 1500);
    }
  }

  function renderBadge() {
    var b = $('#save-badge');
    if (!b) return;
    if (!state.db.cloud.enabled) { b.textContent = '本机演示'; b.style.background = ''; return; }
    if (state.cloudError) {
      b.textContent = '上传失败';
      b.style.background = '#C4623F';
      b.style.color = '#fff';
      return;
    }
    b.style.background = '';
    b.style.color = '';
    b.textContent = state.dirty ? '待上传云端' : '已同步云端';
  }

  /* 云端同步：GET 拉取 / PUT 写入。只读链接时自动降级为本机。
     数据包装成 { _classData: 1, updatedAt: ISO, db: {...} }：
     兼容 ExtendsClass 等「GET 会把对象再包一层」的服务，也便于人工判断新旧。 */
  function cloudCfg() {
    var c = state.db.cloud || {};
    return {
      mode: (c.mode || 'url'),          // 'url' = 通用读/写链接；'github' = GitHub 仓库
      getUrl: (c.getUrl || '').trim(), putUrl: (c.putUrl || '').trim(), token: (c.token || '').trim(),
      ghRepo: (c.ghRepo || '').trim(),          // 形如 yinqi/class-data
      ghPath: (c.ghPath || 'data.json').trim(), // 仓库内路径
      ghBranch: (c.ghBranch || 'main').trim(),
      ghToken: (c.ghToken || '').trim()          // 写入用的 token（只存本机）
    };
  }
  /* Security-key 是 ExtendsClass 等 JSON bin 服务保护读写的请求头；
     Authorization 给通用 Bearer 令牌服务用。两个都带，互不干扰。 */
  function cloudHeaders(token, extra) {
    var h = Object.assign({}, extra || {});
    if (token) { h['Authorization'] = 'Bearer ' + token; h['Security-key'] = token; }
    return h;
  }

  /* ---- GitHub 模式 ---- */
  function ghContentsApi() {
    var c = cloudCfg();
    return 'https://api.github.com/repos/' + c.ghRepo + '/contents/' +
      encodeURIComponent(c.ghPath).replace(/%2F/g, '/');
  }
  /* 家长读数据走 Pages 站点（CDN，无 API 限额），加时间戳绕缓存 */
  function ghReadUrl() {
    var c = cloudCfg();
    if (c.getUrl) return c.getUrl;                       // 用户手填优先
    if (!c.ghRepo) return '';
    var parts = c.ghRepo.split('/');
    if (parts.length !== 2) return '';
    return 'https://' + parts[0] + '.github.io/' + parts[1] + '/' + c.ghPath + '?t=';
  }
  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* 家长配置码：只编码「读取链接」，绝不写入 putUrl / token / 管理密码。
     家长拿到这一个网址，打开就自动连云端，不用任何设置。 */
  function b64encode(str) {
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64decode(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return decodeURIComponent(escape(atob(s)));
  }
  function buildParentURL() {
    var c = cloudCfg();
    // GitHub 模式下用推算出的 Pages 读地址；通用模式用填的读取链接
    var readUrl = (c.mode === 'github') ? (ghReadUrl() || c.getUrl) : c.getUrl;
    if (!readUrl) return '';
    var cfg = b64encode(readUrl);
    var base = location.href.split('#')[0].split('?')[0];
    return base + '?cfg=' + encodeURIComponent(cfg) + '#parent';
  }
  function applyParentCfg() {
    var m = /[?&]cfg=([^&]+)/.exec(location.search || '');
    if (!m) return false;
    try {
      // 容错：某些浏览器/复制链接会把 #parent 一起并进查询串，去掉尾部片段
      var rawCfg = decodeURIComponent(m[1]).split('#')[0];
      var url = b64decode(rawCfg);
      if (!/^https?:\/\//i.test(url)) return false;
      state.db.cloud.enabled = true;
      state.db.cloud.mode = 'url';   // 家长端统一走简单 GET，不需要 token
      state.db.cloud.getUrl = url;
      state.db.cloud.putUrl = '';    // 家长端只读
      state.db.cloud.ghToken = '';   // 绝不把写入令牌带到家长端
      state.role = 'parent';
      saveLocal();
      return true;
    } catch (e) { return false; }
  }
  function unwrap(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var d = raw;
    if (d._classData && d.db) d = d.db;
    else if (d.data && d.data._classData && d.data.db) d = d.data.db;
    return Array.isArray(d.students) ? d : null;
  }
  /* 上传前剔除所有敏感字段。
     ⚠️ 曾经把 cloud.ghToken 一起传上去，导致 GitHub 密钥扫描返回 409，
     而且令牌会公开泄漏在 data.json 里。云端只需要业务数据。 */
  function sanitizeForUpload(db) {
    var out = S.clone(db);
    if (out.cloud) {
      // 云端配置只保留「无需保密」的，其余一律清空
      out.cloud = {
        enabled: !!out.cloud.enabled,
        mode: out.cloud.mode || 'github',
        ghRepo: out.cloud.ghRepo || '',
        ghPath: out.cloud.ghPath || 'data.json',
        ghBranch: out.cloud.ghBranch || 'main',
        getUrl: '',      // 读取地址可从仓库推出，不必上传
        putUrl: '',
        token: '',
        ghToken: ''      // ← 关键：写入令牌绝不外传
      };
    }
    return out;
  }
  function wrap(db) {
    return { _classData: 1, updatedAt: new Date().toISOString(), db: sanitizeForUpload(db) };
  }
  function mergeDB(local, remote) {
    // 规则（按优先级）：
    // 1. 云端有 updatedAt、本机没有 → 用云端（云端是老师上传的权威数据）
    // 2. 两者都有 updatedAt → 取较新的一份
    // 3. 都没有时间戳 → 只在「云端明显是空壳」时保留本机，其余一律用云端
    //    绝不按条数比较：本机演示数据 6 人可能压过真实的 5 人小班。
    var lu = local._updatedAt || '';
    var ru = remote._updatedAt || '';
    if (ru && !lu) return remote.db;
    if (lu && ru) return lu >= ru ? local.db : remote.db;
    var remDb = remote.db || remote;
    var localDb = local.db || local;
    var essential = ['students', 'exams'];
    var remoteEmpty = essential.every(function (k) { return !remDb[k] || remDb[k].length === 0; });
    if (remoteEmpty) {
      var localHas = essential.some(function (k) { return localDb[k] && localDb[k].length > 0; });
      if (localHas) return localDb;          // 云端还没上传过，保留本机
    }
    return remDb;
  }
  function pullCloud(showMsg) {
    var c = cloudCfg();
    var url = (c.mode === 'github') ? ghReadUrl() : c.getUrl;
    if (!state.db.cloud.enabled || !url) {
      if (showMsg) toast('还没填数据读取地址');
      return Promise.resolve(false);
    }
    // 加时间戳破缓存（家长刷新要立刻看到新数据）
    if (url.indexOf('?') < 0) url += '?t=' + Date.now();
    else if (/[?&]t=$/.test(url)) url += Date.now();
    return fetch(url, { headers: cloudHeaders(c.token), cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (raw) {
        var d = unwrap(raw);
        if (!d) throw new Error('返回的数据格式不对（需要含 students 数组）');
        var local = { db: state.db, _updatedAt: state.db._updatedAt || '' };
        var remote = { db: d, _updatedAt: (raw && raw.updatedAt) || '' };
        // 记住本机的云端配置，合并后必须原样恢复：
        // 云端存的是脱敏版本（token 为空），不能让它覆盖本机已填的令牌。
        var keepCloud = S.clone(state.db.cloud || {});
        state.db = S.normalize(mergeDB(local, remote));
        if (keepCloud.ghToken || keepCloud.token || keepCloud.putUrl) {
          state.db.cloud = Object.assign({}, keepCloud, {
            // 仓库/路径/分支允许云端纠正（老师可能换了仓库），但令牌只认本机
            ghToken: keepCloud.ghToken || '',
            token: keepCloud.token || ''
          });
        }
        if (remote._updatedAt) state.db._updatedAt = remote._updatedAt;
        saveLocal(); state.dirty = false; renderBadge();
        if (showMsg) { toast('已从云端取回最新数据'); renderCurrent(); }
        return true;
      })
      .catch(function (e) {
        if (showMsg) toast('拉取失败：' + e.message + '（首次还没上传过数据属正常）');
        return false;
      });
  }

  var pushing = false, pushAgain = false;
  function pushCloud() {
    var c = cloudCfg();
    if (!state.db.cloud.enabled) { toast('云端同步没开启'); return Promise.resolve(false); }
    // 串行化：正在上传时再来一次，就标记「传完再传一次」，避免并发写导致 sha 冲突
    if (pushing) { pushAgain = true; return Promise.resolve(false); }
    pushing = true;
    var payload = wrap(state.db);
    var body = JSON.stringify(payload);

    var task;
    if (c.mode === 'github') {
      task = pushGitHub(c, body, payload);
    } else if (!c.putUrl) {
      pushing = false;
      toast('只有「读取链接」，本机可看；要让家长看到，需配置「写入链接」');
      return Promise.resolve(false);
    } else {
      task = fetch(c.putUrl, {
        method: 'PUT',
        headers: cloudHeaders(c.token, { 'Content-Type': 'application/json' }),
        body: body
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function () { onPushDone(payload); return true; })
        .catch(function (e) { state.cloudError = e.message; renderBadge(); toast('上传失败：' + e.message); return false; });
    }
    return task.then(function (r) {
      pushing = false;
      if (pushAgain) { pushAgain = false; return pushCloud(); }
      return r;
    }, function (e) {
      pushing = false; pushAgain = false;
      throw e;
    });
  }

  function onPushDone(payload) {
    state.dirty = false;
    state.cloudError = '';
    try { state.db._updatedAt = payload.updatedAt; saveLocal(); } catch (e) {}
    renderBadge();
    toast('已同步，家长刷新即可看到');
  }

  /* GitHub 写入：PUT /repos/:owner/:repo/contents/:path
     需要先 GET 拿 sha（更新已有文件必须带），再 PUT base64 内容 */
  function pushGitHub(c, body, payload) {
    if (!c.ghRepo || c.ghRepo.split('/').length !== 2) { toast('仓库要写成 用户名/仓库名'); return Promise.resolve(false); }
    if (!c.ghToken) { toast('GitHub 模式需要填写入令牌（Token）'); return Promise.resolve(false); }
    var api = ghContentsApi();
    var auth = { 'Authorization': 'Bearer ' + c.ghToken, 'Accept': 'application/vnd.github+json' };

    return fetch(api + '?ref=' + encodeURIComponent(c.ghBranch), { headers: auth, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (meta) {
        var req = {
          method: 'PUT',
          headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
          body: JSON.stringify({
            message: '更新班级数据 ' + new Date().toLocaleString('zh-CN'),
            content: utf8ToB64(body),
            branch: c.ghBranch,
            ...(meta && meta.sha ? { sha: meta.sha } : {})
          })
        };
        return fetch(api, req);
      })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            var msg = 'HTTP ' + r.status;
            try { var j = JSON.parse(t); if (j.message) msg += '：' + j.message; } catch (e) {}
            throw new Error(msg);
          });
        }
        return r.json();
      })
      .then(function () { onPushDone(payload); return true; })
      .catch(function (e) { state.cloudError = e.message; renderBadge(); toast('上传失败：' + e.message); return false; });
  }
  function renderCurrent() {
    if (!$('#view-parent').hidden) renderParent();
    else if (!$('#view-teacher').hidden) renderTeacher();
  }

  /* ---------------- 通用 UI ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function openModal(title, bodyHTML, onSave) {
    resetModalButtons();
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHTML;
    state.modalSave = onSave;
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    $('#modal').hidden = true; state.modalSave = null; state.photos = [];
    document.body.style.overflow = '';
  }
  function confirmDel(fn) { if (window.confirm('确定删除？此操作不可撤销。')) fn(); }

  function emptyBox(text, icon) {
    return '<div class="empty"><span class="big">' + (icon || '📭') + '</span>' + esc(text) + '</div>';
  }

  /* ---------------- SVG 折线图 ---------------- */
  function lineChart(series, avgSeries) {
    var pts = series.filter(function (p) { return p.score != null; });
    if (pts.length < 1) return emptyBox('还没有成绩记录', '📈');
    var W = 320, H = 170, L = 34, R = 10, T = 14, B = 30;
    var iw = W - L - R, ih = H - T - B;
    var maxV = 100, minV = 0;
    var xs = pts.map(function (_, i) { return L + (pts.length === 1 ? iw / 2 : i * iw / (pts.length - 1)); });
    var ys = pts.map(function (p) { return T + (maxV - p.score) / (maxV - minV) * ih; });
    var grid = '';
    [0, 25, 50, 75, 100].forEach(function (v) {
      var y = T + (maxV - v) / (maxV - minV) * ih;
      grid += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="#E4EAE7" stroke-width="1"/>';
      grid += '<text x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#93A09C">' + v + '</text>';
    });
    var avgPath = '';
    if (avgSeries && avgSeries.length) {
      var avgMap = {};
      avgSeries.forEach(function (p) { if (p.score != null) avgMap[p.exam.id] = p.score; });
      var ap = [];
      pts.forEach(function (p, i) {
        if (avgMap[p.exam.id] != null) ap.push({ x: xs[i], v: avgMap[p.exam.id] });
      });
      if (ap.length) {
        avgPath = '<polyline fill="none" stroke="#C98A2B" stroke-width="2" stroke-dasharray="5 4" points="' +
          ap.map(function (p) { return p.x + ',' + (T + (maxV - p.v) / (maxV - minV) * ih); }).join(' ') + '"/>';
      }
    }
    var area = 'M ' + xs[0] + ' ' + (T + ih) + ' L ' + xs.map(function (x, i) { return x + ' ' + ys[i]; }).join(' L ') +
      ' L ' + xs[xs.length - 1] + ' ' + (T + ih) + ' Z';
    var dots = pts.map(function (p, i) {
      return '<circle cx="' + xs[i] + '" cy="' + ys[i] + '" r="3.5" fill="#1F6F5C" stroke="#fff" stroke-width="1.5"/>' +
        '<text x="' + xs[i] + '" y="' + (ys[i] - 9) + '" text-anchor="middle" font-size="10" font-weight="600" fill="#1F6F5C">' + p.score + '</text>';
    }).join('');
    var labels = pts.map(function (p, i) {
      var short = p.exam.name.replace(/测验|考试|期中期|单元/g, '').slice(0, 5) || p.exam.date.slice(5);
      return '<text x="' + xs[i] + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#93A09C">' + esc(short) + '</text>';
    }).join('');
    return '<div class="chart-box"><svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="成绩趋势图">' +
      grid + '<path d="' + area + '" fill="#E8F3EF" opacity=".75"/>' + avgPath +
      '<polyline fill="none" stroke="#1F6F5C" stroke-width="2.5" stroke-linejoin="round" points="' +
      xs.map(function (x, i) { return x + ',' + ys[i]; }).join(' ') + '"/>' + dots + labels + '</svg></div>' +
      '<div class="chart-legend"><span><i class="legend-dot" style="background:#1F6F5C"></i>本人得分</span>' +
      (avgPath ? '<span><i class="legend-dot" style="background:#C98A2B"></i>班级平均</span>' : '') +
      '<span>满分 100</span></div>';
  }

  function avgSeriesFor(db) {
    return db.exams.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).map(function (ex) {
      return { exam: ex, score: S.classAverage(db, ex.id) };
    }).filter(function (p) { return p.score != null; });
  }

  /* ---------------- 登录 ---------------- */
  function showView(id) {
    ['view-login', 'view-parent', 'view-teacher'].forEach(function (v) { $('#' + v).hidden = v !== id; });
    window.scrollTo(0, 0);
  }
  function renderLogin() {
    $('#login-parent').hidden = state.role !== 'parent';
    $('#login-teacher').hidden = state.role !== 'teacher';
    $$('#role-segment .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.role === state.role); });
    $('#login-msg').textContent = '';
    var isCfg = !!state.parentCfg;
    $('#cfg-card').hidden = !isCfg;
    if (isCfg) {
      $('#cfg-status').textContent = state.db.cloud.getUrl
        ? '云端地址：' + state.db.cloud.getUrl : '未能读取配置，请向老师要新链接';
    }
    $('#demo-note').innerHTML = isCfg
      ? '这是老师发来的家长专用链接。每位家长用自己的编号和密码登录，只能看到自己孩子。'
      : state.db.cloud.enabled
        ? '数据已从云端同步。家长用「学生编号 + 独立密码」进入，只能看到自己孩子。'
        : '当前为 <b>本机演示数据</b>（全部化名）。老师可在「设置」里清空后录入真实名册。<br>演示家长账号：20260301 / p030126；演示管理密码：admin123';
  }
  function doLogin() {
    if (state.db.cloud.enabled) {
      pullCloud(false).then(function () { doLoginNow(); });
      return;
    }
    doLoginNow();
  }
  function doLoginNow() {
    if (state.role === 'teacher') {
      var pw = $('#login-admin').value;
      if (!S.verifyPwd(pw, state.db.adminHash)) { $('#login-msg').textContent = '管理密码不对'; return; }
      state.studentId = null; state.teacherTab = 't-home';
      writeSession(); showView('view-teacher'); renderTeacher();
    } else {
      var code = $('#login-code').value.trim(), pwd = $('#login-pwd').value.trim();
      var stu = S.studentByCode(state.db, code);
      if (!stu || !pwd || stu.pwd !== pwd) { $('#login-msg').textContent = '编号或密码不对，请找老师核对'; return; }
      state.studentId = stu.id; state.parentTab = 'p-overview';
      writeSession(); showView('view-parent'); renderParent();
    }
  }
  function doLogout() {
    try { sessionStorage.removeItem(SESSION); } catch (e) {}
    state.studentId = null; $('#login-pwd').value = ''; $('#login-admin').value = '';
    if (state.parentCfg) state.role = 'parent';
    showView('view-login'); renderLogin();
  }
  function writeSession() {
    try { sessionStorage.setItem(SESSION, JSON.stringify({ role: state.role, sid: state.studentId })); } catch (e) {}
  }
  function restoreSession() {
    try {
      var raw = sessionStorage.getItem(SESSION); if (!raw) return false;
      var s = JSON.parse(raw);
      if (s.role === 'teacher') { state.role = 'teacher'; state.studentId = null; showView('view-teacher'); renderTeacher(); return true; }
      if (s.role === 'parent' && s.sid && S.studentById(state.db, s.sid)) {
        state.role = 'parent'; state.studentId = s.sid; showView('view-parent'); renderParent(); return true;
      }
    } catch (e) {}
    return false;
  }
  function syncTopbarOffset() {
    var h = $('.topbar') ? $('.topbar').offsetHeight : 56;
    document.documentElement.style.setProperty('--topbar-h', h + 'px');
  }

  /* ============================================================
   *  家长端
   * ============================================================ */
  function renderParent() {
    syncTopbarOffset();
    var stu = S.studentById(state.db, state.studentId);
    if (!stu) { doLogout(); return; }
    $('#parent-title').textContent = stu.alias + '的成长档案';
    $('#child-avatar').textContent = stu.alias.slice(-1);
    $('#child-name').textContent = stu.alias + '（化名）';
    $('#child-sub').textContent = '编号 ' + stu.code + ' · ' + (state.db.className || '');
    var ser = S.scoreSeries(state.db, stu.id);
    var last = ser.filter(function (p) { return p.score != null; }).slice(-1)[0];
    $('#child-latest').innerHTML = last ? '<b>' + last.score + '</b>最近一次' : '<b>—</b>暂无成绩';
    $$('#parent-tabs .tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === state.parentTab); });
    var p = $('#parent-page');
    if (state.parentTab === 'p-overview') p.innerHTML = pOverview(stu);
    else if (state.parentTab === 'p-scores') p.innerHTML = pScores(stu);
    else if (state.parentTab === 'p-growth') p.innerHTML = pGrowth(stu);
    else p.innerHTML = pNotes(stu);
    bindParentPage(stu);
  }

  function pOverview(stu) {
    var ser = S.scoreSeries(state.db, stu.id), ds = S.deltaList(ser);
    var valid = ser.filter(function (p) { return p.score != null; });
    var lastP = valid[valid.length - 1], firstP = valid[0];
    var total = lastP && firstP ? lastP.score - firstP.score : null;
    var growth = S.growthOf(state.db, stu.id), notes = S.notesOf(state.db, stu.id), perf = S.perfOf(state.db, stu.id);
    var h = '';
    h += '<div class="stat-grid">' +
      stat(lastP ? lastP.score : '—', '最近得分') +
      stat(total == null ? '—' : (total > 0 ? '+' : '') + total, '较首次变化') +
      stat(growth.length, '成长记录') + '</div>';

    h += '<div class="section-title">成绩趋势</div><div class="card">' +
      lineChart(ser, avgSeriesFor(state.db)) + '</div>';

    h += '<div class="section-title">最近老师的话</div>';
    if (!notes.length) h += '<div class="card">' + emptyBox('老师还没有写评语', '💬') + '</div>';
    else h += '<div class="note-card"><div class="note-meta">' + esc(notes[0].date) + '</div>' +
      '<div class="note-text">' + esc(notes[0].text) + '</div></div>' +
      (notes.length > 1 ? '<button class="link-btn" data-go="p-notes">查看全部 ' + notes.length + ' 条 →</button>' : '');

    h += '<div class="section-title">最近的成长片段</div>';
    if (!growth.length) h += '<div class="card">' + emptyBox('还没有成长记录', '🌱') + '</div>';
    else h += '<div class="card"><div class="timeline">' + growth.slice(0, 2).map(function (g) {
      return tlItem(g, false);
    }).join('') + '</div>' +
      (growth.length > 2 ? '<button class="link-btn" data-go="p-growth">查看全部 ' + growth.length + ' 条 →</button>' : '') + '</div>';

    if (perf.length) {
      h += '<div class="section-title">课堂小亮点</div><div class="card">';
      perf.slice(0, 3).forEach(function (x) {
        h += '<div class="kv"><span>' + esc(x.date) + ' · ' + esc(x.kind) + '</span><span class="grow" style="text-align:right">' + esc(x.note) + '</span></div>';
      });
      h += '</div>';
    }
    return h;
  }

  function pScores(stu) {
    var ser = S.scoreSeries(state.db, stu.id), ds = S.deltaList(ser);
    var avg = avgSeriesFor(state.db);
    var h = '<div class="card"><div class="card-head"><h3>成绩趋势</h3><span class="sub">共 ' + ser.length + ' 次</span></div>' +
      lineChart(ser, avg) + '</div>';
    h += '<div class="section-title">每次得分</div><div class="card">';
    if (!ser.some(function (p) { return p.score != null; })) h += emptyBox('还没有成绩记录', '📈');
    else ser.forEach(function (p, i) {
      var d = ds[i], cls = d == null ? 'flat' : d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
      var dtxt = d == null ? '—' : (d > 0 ? '↑+' + d : d < 0 ? '↓' + d : '持平');
      var a = avg.filter(function (x) { return x.exam.id === p.exam.id; })[0];
      h += '<div class="score-line"><span class="when">' + esc(p.exam.date.slice(5)) + '</span>' +
        '<span class="grow ellipsis">' + esc(p.exam.name) +
        (a ? '<br><span class="muted">班均 ' + fmt(a.score) + '</span>' : '') + '</span>' +
        '<span class="delta ' + cls + '">' + dtxt + '</span>' +
        '<span class="val">' + (p.score == null ? '—' : p.score) + '</span></div>';
    });
    h += '</div>';
    var wr = S.wrongOf(state.db, stu.id);
    h += '<div class="section-title">错题与知识点</div><div class="card">';
    if (!wr.length) h += emptyBox('暂无错题记录', '✏️');
    else {
      var kpCount = {};
      wr.forEach(function (w) { var k = w.kpId || 'none'; kpCount[k] = (kpCount[k] || 0) + 1; });
      var tops = Object.keys(kpCount).sort(function (a, b) { return kpCount[b] - kpCount[a]; }).slice(0, 3);
      h += '<div class="muted" style="margin-bottom:10px">出现较多的知识点，可以重点巩固：</div>';
      tops.forEach(function (k) {
        var kp = S.kpById(state.db, k);
        h += '<div style="margin-bottom:10px"><div class="row-between"><span>' + esc(kp ? kp.name : '未分类') +
          '</span><span class="chip amber">' + kpCount[k] + ' 次</span></div>' +
          '<div class="bar-track"><div class="bar-fill warn" style="width:' + Math.min(100, kpCount[k] / wr.length * 100) + '%"></div></div></div>';
      });
      h += '<div class="divider"></div>';
      wr.slice(0, 8).forEach(function (w) {
        var ex = S.examById(state.db, w.examId), kp = S.kpById(state.db, w.kpId);
        h += '<div class="kv"><span>' + esc(w.date) + ' · ' + esc(ex ? ex.name : '') + '</span>' +
          '<span class="grow" style="text-align:right">' + esc(kp ? kp.name : '—') + '<br><span class="muted">' + esc(w.note || '') + '</span></span></div>';
      });
    }
    h += '</div>';
    return h;
  }

  function pGrowth(stu) {
    var g = S.growthOf(state.db, stu.id), perf = S.perfOf(state.db, stu.id);
    var h = '<div class="card"><div class="card-head"><h3>成长时间轴</h3><span class="sub">' + g.length + ' 条</span></div>';
    h += g.length ? '<div class="timeline">' + g.map(function (x) { return tlItem(x, true); }).join('') + '</div>'
      : emptyBox('老师还没有添加成长记录', '🌱');
    h += '</div>';
    if (perf.length) {
      h += '<div class="section-title">课堂表现记录</div><div class="card">';
      perf.forEach(function (x) {
        h += '<div class="list-item"><span class="chip ' + perfChip(x.kind) + '">' + esc(x.kind) + '</span>' +
          '<span class="grow">' + esc(x.note) + '<br><span class="muted">' + esc(x.date) + '</span></span></div>';
      });
      h += '</div>';
    }
    return h;
  }
  function perfChip(kind) {
    if (kind === '进步' || kind === '发言' || kind === '互助') return 'green';
    if (kind === '待改进' || kind === '提醒') return 'red';
    return 'blue';
  }
  function tlItem(g, withPhotos) {
    var h = '<div class="tl-item"><div class="tl-date">' + esc(g.date) + '</div>' +
      '<div class="tl-title">' + esc(g.title) + '</div>' +
      '<div class="tl-text">' + esc(g.text || '') + '</div>';
    if (withPhotos && g.photos && g.photos.length) {
      h += '<div class="tl-photos">' + g.photos.map(function (src) {
        return '<img src="' + esc(src) + '" alt="成长照片" data-lightbox="1" loading="lazy">';
      }).join('') + '</div>';
    }
    return h + '</div>';
  }

  function pNotes(stu) {
    var n = S.notesOf(state.db, stu.id);
    var h = '<div class="section-title">老师的话（' + n.length + '）</div>';
    if (!n.length) return h + '<div class="card">' + emptyBox('老师还没有写评语', '💬') + '</div>';
    n.forEach(function (x) {
      h += '<div class="note-card"><div class="note-meta">' + esc(x.date) + '</div>' +
        '<div class="note-text">' + esc(x.text) + '</div></div>';
    });
    return h;
  }

  function bindParentPage() {
    $$('[data-go]').forEach(function (b) {
      b.onclick = function () { state.parentTab = b.dataset.go; renderParent(); };
    });
    $$('[data-lightbox]').forEach(function (img) {
      img.onclick = function () { $('#lightbox-img').src = img.src; $('#lightbox').hidden = false; };
    });
  }

  /* ============================================================
   *  老师端
   * ============================================================ */
  function renderTeacher() {
    syncTopbarOffset();
    $$('#teacher-tabs .tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === state.teacherTab); });
    renderBadge();
    var p = $('#teacher-page');
    var t = state.teacherTab;
    if (t === 't-home') p.innerHTML = tHome();
    else if (t === 't-students') p.innerHTML = tStudents();
    else if (t === 't-scores') p.innerHTML = tScores();
    else if (t === 't-wrong') p.innerHTML = tWrong();
    else if (t === 't-perf') p.innerHTML = tPerf();
    else if (t === 't-growth') p.innerHTML = tGrowth();
    else p.innerHTML = tSettings();
    $('#fab-add').hidden = (t === 't-home' || t === 't-settings');
    bindTeacherPage();
  }
  function stat(num, lbl) {
    return '<div class="stat"><div class="num">' + esc(num) + '</div><div class="lbl">' + esc(lbl) + '</div></div>';
  }

  function tHome() {
    var db = state.db;
    var exams = db.exams.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var last = exams[exams.length - 1];
    var avg = last ? S.classAverage(db, last.id) : null;
    var att = S.attentionStudents(db);
    var weak = S.weakKPs(db, last ? last.id : '');
    var h = '<div class="stat-grid">' +
      stat(db.students.length, '学生') + stat(db.exams.length, '考试') +
      stat(avg == null ? '—' : fmt(avg), '最近班均') + '</div>';

    h += '<div class="section-title">需要关注</div><div class="card">';
    if (!att.length) h += emptyBox('暂无明显退步或低于班均的同学', '✅');
    else att.forEach(function (a) {
      h += '<div class="list-item"><span class="avatar sm">' + esc(a.student.alias.slice(-1)) + '</span>' +
        '<span class="grow"><b>' + esc(a.student.alias) + '</b> <span class="muted">' + esc(a.student.code) + '</span>' +
        '<br><span class="muted">' + esc(a.reasons.join('；')) + '</span></span>' +
        '<span class="chip red">' + a.score + ' 分</span></div>';
    });
    h += '</div>';

    h += '<div class="section-title">班级共性薄弱点' + (last ? '（' + esc(last.name) + '）' : '') + '</div><div class="card">';
    if (!weak.length) h += emptyBox('这次考试还没登记错题', '📊');
    else weak.slice(0, 6).forEach(function (w) {
      var pct = Math.min(100, w.count / Math.max(1, db.wrong.filter(function (x) { return !last || x.examId === last.id; }).length) * 100);
      h += '<div style="margin-bottom:12px"><div class="row-between"><span>' + esc(w.kp.name) +
        '</span><span class="chip ' + (w.count >= 3 ? 'red' : 'amber') + '">' + w.count + ' 人次</span></div>' +
        '<div class="bar-track"><div class="bar-fill ' + (w.count >= 3 ? 'bad' : 'warn') + '" style="width:' + pct + '%"></div></div></div>';
    });
    if (weak.length) h += '<div class="notice">建议：下一节课针对「' + esc(weak[0].kp.name) + '」安排 5 分钟对比练习，再点名 ' +
      esc(att.slice(0, 2).map(function (a) { return a.student.alias; }).join('、') || '相关同学') + ' 上台板演。</div>';
    h += '</div>';

    if (last) {
      h += '<div class="section-title">最近一次成绩分布</div><div class="card">' +
        scoreBars(db, last.id) + '</div>';
    }
    h += '<div class="notice">👆 以上是「改进课堂教学」用的抓手：先看待关注名单，再看共性薄弱知识点。</div>';
    return h;
  }
  function scoreBars(db, examId) {
    var rows = db.students.map(function (s) { return { s: s, v: S.scoreOf(db, examId, s.id) }; })
      .filter(function (r) { return r.v != null; }).sort(function (a, b) { return b.v - a.v; });
    if (!rows.length) return emptyBox('这次考试还没录分', '📝');
    return rows.map(function (r) {
      return '<div style="margin-bottom:9px"><div class="row-between"><span class="grow ellipsis">' + esc(r.s.alias) +
        '</span><b>' + r.v + '</b></div>' +
        '<div class="bar-track"><div class="bar-fill ' + (r.v < 60 ? 'bad' : r.v < 75 ? 'warn' : '') +
        '" style="width:' + r.v + '%"></div></div></div>';
    }).join('');
  }

  /* ---- 名册 ---- */
  function tStudents() {
    var db = state.db, q = state.filterStudent.trim().toLowerCase();
    var list = db.students.filter(function (s) {
      return !q || s.code.indexOf(q) >= 0 || s.alias.toLowerCase().indexOf(q) >= 0;
    });
    var h = '<div class="card"><div class="card-head"><h3>学生名册</h3>' +
      '<button class="btn btn-primary btn-sm" data-act="stu-add">＋ 添加学生</button></div>' +
      '<div class="search-bar"><input id="stu-search" placeholder="搜编号或化名" value="' + esc(state.filterStudent) + '">' +
      '<button class="btn btn-ghost btn-sm" data-act="stu-clear">清除</button></div>' +
      '<div class="notice">隐私约定：名册只填<b>编号 + 化名</b>，不要填真实姓名。家长密码每位学生独立，点学生可复制分发条。</div>';
    if (!list.length) h += emptyBox('还没有学生，点右上角添加', '👧');
    else list.forEach(function (s) {
      h += '<div class="list-item"><span class="avatar">' + esc(s.alias.slice(-1)) + '</span>' +
        '<span class="grow" data-act="stu-detail" data-id="' + esc(s.id) + '"><b>' + esc(s.alias) + '</b>' +
        '<br><span class="muted">' + esc(s.code) + ' · 密码 ' + esc(s.pwd) + '</span></span>' +
        '<button class="link-btn" data-act="stu-detail" data-id="' + esc(s.id) + '">详情</button></div>';
    });
    h += '</div>';
    return h;
  }

  /* ---- 成绩 ---- */
  function tScores() {
    var db = state.db;
    var exams = db.exams.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var validExamIds = exams.map(function (e) { return e.id; });
    var cur = validExamIds.indexOf(state.scoresExam) >= 0 ? state.scoresExam : (exams[0] && exams[0].id) || '';
    state.scoresExam = cur;
    var h = '<div class="card"><div class="card-head"><h3>成绩录入</h3>' +
      '<button class="btn btn-primary btn-sm" data-act="exam-add">＋ 新建考试</button></div>';
    if (!exams.length) h += emptyBox('先新建一次考试，再录分', '📝');
    else {
      h += '<div class="form-row"><label>选择考试</label><select id="scores-exam">' +
        exams.map(function (e) { return '<option value="' + esc(e.id) + '"' + (e.id === cur ? ' selected' : '') + '>' +
          esc(e.name) + '（' + esc(e.date) + '）</option>'; }).join('') + '</select></div>';
      h += '<div class="row-between" style="margin-bottom:8px"><span class="muted">直接改分数，离开输入框即自动保存</span>' +
        '<button class="danger-link" data-act="exam-del" data-id="' + esc(cur) + '">删除本次考试</button></div>';
      h += '<div class="divider"></div>';
      if (!db.students.length) h += emptyBox('名册还是空的', '👧');
      else db.students.forEach(function (s) {
        var v = S.scoreOf(db, cur, s.id);
        h += '<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">' +
          '<span class="avatar sm">' + esc(s.alias.slice(-1)) + '</span>' +
          '<span class="grow ellipsis">' + esc(s.alias) + ' <span class="muted">' + esc(s.code) + '</span></span>' +
          '<input type="number" inputmode="decimal" min="0" max="100" step="0.5" style="width:88px;min-height:38px;text-align:center" ' +
          'data-score-input="1" data-exam="' + esc(cur) + '" data-stu="' + esc(s.id) + '" value="' + (v == null ? '' : v) + '" placeholder="未录">' +
          '</div>';
      });
      var avg = S.classAverage(db, cur);
      h += '<div class="row-between" style="margin-top:12px"><span class="muted">已录 ' +
        db.scores.filter(function (x) { return x.examId === cur && x.score != null; }).length + ' / ' + db.students.length +
        ' 人</span><span class="chip green">班均 ' + (avg == null ? '—' : fmt(avg)) + '</span></div>';
    }
    h += '</div>';
    if (cur) {
      var ser = avgSeriesFor(db);
      h += '<div class="section-title">班级均分走势</div><div class="card">' + lineChart(ser, null) + '</div>';
    }
    return h;
  }

  /* ---- 错题 ---- */
  function tWrong() {
    var db = state.db;
    var exams = db.exams.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var sel = (exams.some(function (e) { return e.id === state.wrongExam; })) ? state.wrongExam : '';
    var list = db.wrong.filter(function (w) { return !sel || w.examId === sel; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var h = '<div class="card"><div class="card-head"><h3>错题登记</h3>' +
      '<button class="btn btn-primary btn-sm" data-act="wrong-add">＋ 登记错题</button></div>';
    h += '<div class="form-row"><label>筛选考试</label><select id="wrong-exam"><option value="">全部</option>' +
      exams.map(function (e) { return '<option value="' + esc(e.id) + '"' + (e.id === sel ? ' selected' : '') + '>' + esc(e.name) + '</option>'; }).join('') +
      '</select></div></div>';
    h += '<div class="section-title">知识点分布（' + (sel ? esc((S.examById(db, sel) || {}).name) : '全部') + '）</div><div class="card">';
    var weak = S.weakKPs(db, sel);
    if (!weak.length) h += emptyBox('还没有错题记录', '✏️');
    else weak.forEach(function (w) {
      h += '<div style="margin-bottom:10px"><div class="row-between"><span>' + esc(w.kp.name) +
        '</span><span class="chip ' + (w.count >= 3 ? 'red' : 'amber') + '">' + w.count + ' 人次</span></div>' +
        '<div class="bar-track"><div class="bar-fill ' + (w.count >= 3 ? 'bad' : 'warn') +
        '" style="width:' + Math.min(100, w.count / list.length * 100) + '%"></div></div></div>';
    });
    h += '</div>';
    h += '<div class="section-title">逐条记录（' + list.length + '）</div><div class="card">';
    if (!list.length) h += emptyBox('暂无记录', '✏️');
    else list.forEach(function (w) {
      var stu = S.studentById(db, w.studentId), ex = S.examById(db, w.examId), kp = S.kpById(db, w.kpId);
      h += '<div class="list-item"><span class="avatar sm">' + esc(stu ? stu.alias.slice(-1) : '?') + '</span>' +
        '<span class="grow"><b>' + esc(stu ? stu.alias : '—') + '</b> · ' + esc(kp ? kp.name : '未分类') +
        '<br><span class="muted">' + esc(ex ? ex.name : '') + ' · ' + esc(w.date) + ' · ' + esc(w.note || '') + '</span></span>' +
        '<button class="danger-link" data-act="wrong-del" data-id="' + esc(w.id) + '">删</button></div>';
    });
    h += '</div>';
    h += '<div class="card"><div class="card-head"><h3>知识点清单</h3>' +
      '<button class="btn btn-ghost btn-sm" data-act="kp-add">＋ 添加</button></div><div class="pill-row">' +
      (db.kps.length ? db.kps.map(function (k) {
        return '<span class="pill on" data-act="kp-del" data-id="' + esc(k.id) + '" title="点击删除">' + esc(k.name) + ' ×</span>';
      }).join('') : '<span class="muted">还没有知识点，先对照人教版目录添加</span>') + '</div></div>';
    return h;
  }

  /* ---- 课堂表现 ---- */
  function tPerf() {
    var db = state.db;
    var list = db.perf.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var h = '<div class="card"><div class="card-head"><h3>课堂表现</h3>' +
      '<button class="btn btn-primary btn-sm" data-act="perf-add">＋ 记一笔</button></div>' +
      '<div class="notice">轻量打点：发言、作业、进步、互助、提醒。写一句具体事实，期末写评语时能用得上。</div>';
    if (!list.length) h += emptyBox('还没有记录', '🌟');
    else list.forEach(function (x) {
      var stu = S.studentById(db, x.studentId);
      h += '<div class="list-item"><span class="chip ' + perfChip(x.kind) + '">' + esc(x.kind) + '</span>' +
        '<span class="grow"><b>' + esc(stu ? stu.alias : '—') + '</b> ' + esc(x.note) +
        '<br><span class="muted">' + esc(x.date) + '</span></span>' +
        '<button class="danger-link" data-act="perf-del" data-id="' + esc(x.id) + '">删</button></div>';
    });
    h += '</div>';
    return h;
  }

  /* ---- 成长档案 ---- */
  function tGrowth() {
    var db = state.db;
    var list = db.growth.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var h = '<div class="card"><div class="card-head"><h3>成长档案</h3>' +
      '<button class="btn btn-primary btn-sm" data-act="growth-add">＋ 添加记录</button></div>' +
      '<div class="notice">按时间排成成长轨迹，家长端按学生过滤后展示。照片会压缩后存本机，建议只放局部作品/手部，不放正脸。</div>';
    if (!list.length) h += emptyBox('还没有成长记录', '🌱');
    else list.forEach(function (g) {
      var stu = S.studentById(db, g.studentId);
      h += '<div class="list-item" style="align-items:flex-start"><span class="avatar sm">' + esc(stu ? stu.alias.slice(-1) : '?') + '</span>' +
        '<span class="grow"><b>' + esc(g.title) + '</b> <span class="muted">' + esc(stu ? stu.alias : '') + ' · ' + esc(g.date) + '</span>' +
        '<div class="muted" style="margin-top:3px">' + esc((g.text || '').slice(0, 60)) + ((g.text || '').length > 60 ? '…' : '') + '</div>' +
        (g.photos && g.photos.length ? '<span class="chip blue">📷 ' + g.photos.length + ' 张</span>' : '') + '</span>' +
        '<button class="link-btn" data-act="growth-view" data-id="' + esc(g.id) + '">看</button> ' +
        '<button class="danger-link" data-act="growth-del" data-id="' + esc(g.id) + '">删</button></div>';
    });
    h += '</div>';
    h += '<div class="section-title">老师评语</div><div class="card"><div class="card-head"><h3>按学生写的话</h3>' +
      '<button class="btn btn-ghost btn-sm" data-act="note-add">＋ 写评语</button></div>';
    if (!db.notes.length) h += emptyBox('还没有评语', '💬');
    else db.notes.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).forEach(function (n) {
      var stu = S.studentById(db, n.studentId);
      h += '<div class="note-card"><div class="note-meta">' + esc(stu ? stu.alias : '—') + ' · ' + esc(n.date) +
        ' <button class="danger-link" style="float:right" data-act="note-del" data-id="' + esc(n.id) + '">删</button></div>' +
        '<div class="note-text">' + esc(n.text) + '</div></div>';
    });
    h += '</div>';
    return h;
  }

  /* ---- 设置 ---- */
  function parentCfgBlock() {
    var url = buildParentURL();
    if (!url) return '<div class="notice">填好「数据读取链接」并保存后，这里会生成一条<b>家长专用网址</b>。</div>';
    return '<div class="notice green"><b>家长专用网址（发这一条就行）</b><br>' +
      '家长用手机打开 → 自动连云端 → 填自己孩子的编号和密码 → 只看到自己孩子，不用做任何设置。</div>' +
      '<div class="code-line" id="parent-url">' + esc(url) + '</div>' +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">' +
      '<button class="btn btn-primary grow" data-act="copy-url">复制家长网址</button>' +
      '<button class="btn btn-ghost grow" data-act="open-url">预览一下</button></div>' +
      '<div class="muted" style="margin-top:8px">⚠️ 网址里含云端读取地址，别发到公开群或朋友圈；' +
      '写入链接与管理密码不在里面，家长只能看、不能改。</div>';
  }

  function tSettings() {
    var db = state.db, c = db.cloud || {};
    var h = '';
    h += '<div class="card"><div class="card-head"><h3>界面外观</h3><span class="sub">只换皮，不动数据</span></div>' +
      themeBlock() + '</div>';

    h += '<div class="card"><div class="card-head"><h3>班级与安全</h3></div>' +
      '<div class="form-row"><label>班级名称</label><input id="set-class" value="' + esc(db.className) + '"></div>' +
      '<div class="form-row"><label>修改老师管理密码（留空表示不改）</label>' +
      '<input id="set-admin" type="password" placeholder="新管理密码"></div>' +
      '<button class="btn btn-primary btn-block" data-act="set-save">保存设置</button></div>';

    h += '<div class="card"><div class="card-head"><h3>名册批量导入</h3>' +
      '<span class="sub">' + db.students.length + ' 人</span></div>' +
      '<div class="notice">一次导入全班。文件里只要「编号、化名、密码、性别」四项，' +
      '<b>不要放真实姓名、身份证号、电话、住址</b>——这些一旦上传到公开仓库就等于公开。</div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-primary grow" data-act="roster-import">⬆ 批量导入名册</button>' +
      '<button class="btn btn-ghost grow" data-act="roster-template">⬇ 下载导入模板</button></div>' +
      '<input type="file" id="roster-file" accept="application/json,.json" hidden>' +
      '<div class="muted" style="margin-top:8px">导入方式可选：<b>追加</b>（保留现有学生）或 <b>替换</b>（清空后重建）。</div></div>';

    h += '<div class="card"><div class="card-head"><h3>数据导入 / 导出</h3></div>' +
      '<div class="notice">换手机、换电脑时：先在旧设备「导出 JSON」，把文件发给自己，再在新设备导入。导入会整体替换当前数据。</div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost grow" data-act="export">⬇ 导出 JSON 备份</button>' +
      '<button class="btn btn-ghost grow" data-act="import">⬆ 导入 JSON</button></div>' +
      '<input type="file" id="import-file" accept="application/json,.json" hidden>' +
      '<div class="divider"></div>' +
      '<button class="btn btn-ghost btn-block" data-act="reset-demo">恢复演示数据（全部化名）</button> ' +
      '<button class="btn btn-danger btn-block" data-act="clear-all" style="margin-top:8px">清空全部数据</button></div>';

    var mode = c.mode || 'github';
    h += '<div class="card"><div class="card-head"><h3>云端同步</h3><span class="chip ' +
      (c.enabled ? 'green' : '') + '">' + (c.enabled ? '已开启' : '未开启') + '</span></div>' +
      '<div class="notice red"><b>先看这里：</b>本系统自带的「家长密码」只是界面隔离，<b>不是安全加密</b>。学生属于未成年人，成绩与评语是敏感信息。' +
      '放到公网前，请务必：① 只用编号+化名，不填真实姓名；② 先征得学校同意；③ 不要把网址发到公开群/朋友圈。</div>' +
      '<label class="pill-row" style="margin-bottom:14px"><span class="pill' + (c.enabled ? ' on' : '') + '" data-act="cloud-toggle">' +
      (c.enabled ? '✓ 已开启云端同步' : '开启云端同步') + '</span></label>' +
      '<div class="theme-pick" style="margin-bottom:14px">' +
        '<button class="theme-opt' + (mode === 'github' ? ' on' : '') + '" data-act="cloud-mode" data-mode="github">' +
          '<b>GitHub 仓库</b><small>国内可通 · 免费 · 推荐</small></button>' +
        '<button class="theme-opt' + (mode !== 'github' ? ' on' : '') + '" data-act="cloud-mode" data-mode="url">' +
          '<b>通用读写链接</b><small>其他 JSON 托管服务</small></button>' +
      '</div>';

    if (mode === 'github') {
      h += '<div class="notice green"><b>GitHub 模式</b>：数据存在你自己仓库里的一个 json 文件，网页和它同一个仓库，家长读走 Pages 站点（快、无次数限制）。</div>' +
        '<div class="form-row"><label>仓库（用户名/仓库名）*</label>' +
        '<input id="set-ghrepo" placeholder="例如 yinqi-speak/class-data" value="' + esc(c.ghRepo || '') + '"></div>' +
        '<div class="form-grid">' +
          '<div class="form-row"><label>文件路径</label>' +
          '<input id="set-ghpath" placeholder="data.json" value="' + esc(c.ghPath || 'data.json') + '"></div>' +
          '<div class="form-row"><label>分支</label>' +
          '<input id="set-ghbranch" placeholder="main" value="' + esc(c.ghBranch || 'main') + '"></div></div>' +
        '<div class="form-row"><label>写入令牌（Fine-grained Token，只给 Contents: Read and write）*</label>' +
        '<input id="set-ghtoken" placeholder="github_pat_… 或 ghp_…" value="' + esc(c.ghToken || '') + '"></div>' +
        '<div class="notice">令牌只保存在这台设备的本机存储里，<b>不会写进家长网址</b>，也不会上传到仓库。</div>' +
        '<div class="form-row"><label>家长读取地址（留空=自动按仓库推算，一般不用填）</label>' +
        '<input id="set-geturl" placeholder="自动：https://用户名.github.io/仓库名/data.json" value="' + esc(c.getUrl || '') + '"></div>' +
        '<div class="row" style="gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-primary grow" data-act="cloud-save">保存设置</button>' +
        '<button class="btn btn-ghost grow" data-act="cloud-push">立即上传</button>' +
        '<button class="btn btn-ghost grow" data-act="cloud-pull">立即拉取</button></div>' +
        '<div class="divider"></div><div class="muted">' +
        (c.ghRepo && c.enabled ? '家长读取地址：<span style="word-break:break-all">' + esc(ghReadUrl() || '(仓库格式不对)') + '</span>' : '填好仓库并上传一次后，家长就能读到数据。') +
        '</div>';
    } else {
      h += '<div class="form-row"><label>数据读取链接（GET，家长端用它拉数据）</label>' +
        '<input id="set-geturl" placeholder="https://…" value="' + esc(c.getUrl || '') + '"></div>' +
        '<div class="form-row"><label>数据写入链接（PUT，老师端用它存数据）</label>' +
        '<input id="set-puturl" placeholder="https://…" value="' + esc(c.putUrl || '') + '"></div>' +
        '<div class="form-row"><label>令牌 Token（可选）</label>' +
        '<input id="set-token" placeholder="可留空" value="' + esc(c.token || '') + '"></div>' +
        '<div class="row" style="gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-primary grow" data-act="cloud-save">保存链接</button>' +
        '<button class="btn btn-ghost grow" data-act="cloud-pull">立即拉取</button>' +
        '<button class="btn btn-ghost grow" data-act="cloud-push">立即上传</button></div>';
    }
    h += '</div>';

    h += '<div class="section-title">发给家长的东西</div><div class="card"><div class="card-head">' +
      '<h3>家长专用网址</h3></div>' + parentCfgBlock() + '</div>';

    h += '<div class="card"><div class="card-head"><h3>家长登录信息</h3></div>' +
      '<p class="muted" style="margin-bottom:10px">把「编号 + 密码」单独发给每位家长，不要整表群发。</p>';
    if (!db.students.length) h += emptyBox('名册为空', '👧');
    else db.students.forEach(function (s) {
      h += '<div class="row" style="padding:6px 0;border-bottom:1px dashed var(--line)">' +
        '<span class="grow">' + esc(s.alias) + ' <span class="muted">' + esc(s.code) + ' / ' + esc(s.pwd) + '</span></span>' +
        '<button class="link-btn" data-act="copy-pwd" data-id="' + esc(s.id) + '">复制</button></div>';
    });
    h += '</div>';
    return h;
  }

  /* ---------------- 老师端事件绑定 ---------------- */
  function bindTeacherPage() {
    var t = state.teacherTab;
    if (t === 't-students') {
      var si = $('#stu-search');
      if (si) si.oninput = function () {
        state.filterStudent = si.value;
        var pos = si.selectionStart;
        $('#teacher-page').innerHTML = tStudents();
        bindTeacherPage();
        var n = $('#stu-search'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} }
      };
    }
    if (t === 't-scores') {
      var se = $('#scores-exam');
      if (se) se.onchange = function () { state.scoresExam = se.value; renderTeacher(); };
      $$('[data-score-input]').forEach(function (inp) {
        inp.onchange = function () {
          var v = inp.value.trim();
          if (v !== '' && (isNaN(Number(v)) || Number(v) < 0 || Number(v) > 100)) { toast('分数要在 0–100 之间'); inp.value = ''; return; }
          state.db = S.upsertScore(state.db, inp.dataset.exam, inp.dataset.stu, v);
          persist('已保存');
          // 只刷新统计区，避免输入框失焦
          var avg = S.classAverage(state.db, state.scoresExam);
          var chip = $('#teacher-page .chip.green');
          if (chip) chip.textContent = '班均 ' + (avg == null ? '—' : fmt(avg));
        };
      });
    }
    if (t === 't-wrong') {
      var we = $('#wrong-exam');
      if (we) we.onchange = function () { state.wrongExam = we.value; renderTeacher(); };
    }
    $$('[data-act]').forEach(function (el) { el.onclick = function () { handleAct(el.dataset.act, el.dataset.id, el); }; });
  }

  function handleAct(act, id, el) {
    var db = state.db;
    switch (act) {
      /* 名册 */
      case 'stu-clear': state.filterStudent = ''; renderTeacher(); break;
      case 'stu-add': modalStudent(); break;
      case 'stu-detail': modalStudentDetail(id); break;
      /* 考试 / 成绩 */
      case 'exam-add': modalExam(); break;
      case 'exam-del': confirmDel(function () {
        db.exams = db.exams.filter(function (e) { return e.id !== id; });
        db.scores = db.scores.filter(function (s) { return s.examId !== id; });
        db.wrong = db.wrong.filter(function (w) { return w.examId !== id; });
        state.scoresExam = ''; persist('已删除考试及其成绩'); renderTeacher();
      }); break;
      /* 错题 */
      case 'wrong-add': modalWrong(); break;
      case 'wrong-del': confirmDel(function () {
        db.wrong = db.wrong.filter(function (w) { return w.id !== id; }); persist('已删除'); renderTeacher();
      }); break;
      case 'kp-add': modalKP(); break;
      case 'kp-del': confirmDel(function () {
        var n = db.wrong.filter(function (w) { return w.kpId === id; }).length;
        if (n && !confirm('这个知识点关联了 ' + n + ' 条错题，删除后这些错题会显示为「未分类」。继续？')) return;
        db.kps = db.kps.filter(function (k) { return k.id !== id; }); persist('已删除'); renderTeacher();
      }); break;
      /* 表现 */
      case 'perf-add': modalPerf(); break;
      case 'perf-del': confirmDel(function () {
        db.perf = db.perf.filter(function (p) { return p.id !== id; }); persist('已删除'); renderTeacher();
      }); break;
      /* 成长 / 评语 */
      case 'growth-add': modalGrowth(); break;
      case 'growth-del': confirmDel(function () {
        db.growth = db.growth.filter(function (g) { return g.id !== id; }); persist('已删除'); renderTeacher();
      }); break;
      case 'growth-view': modalGrowthView(id); break;
      case 'note-add': modalNote(); break;
      case 'note-del': confirmDel(function () {
        db.notes = db.notes.filter(function (n) { return n.id !== id; }); persist('已删除'); renderTeacher();
      }); break;
      /* 设置 */
      case 'theme': applyTheme(el.dataset.theme); renderTeacher(); toast('外观已切换'); break;
      case 'set-save': {
        var cn = $('#set-class').value.trim(), ap = $('#set-admin').value.trim();
        if (cn) db.className = cn;
        if (ap) db.adminHash = S.hashPwd(ap);
        $('#set-admin').value = '';
        persist('设置已保存'); renderTeacher(); break;
      }
      case 'export': doExport(); break;
      case 'import': $('#import-file').click(); break;
      case 'roster-import': $('#roster-file').click(); break;
      case 'roster-template': downloadRosterTemplate(); break;
      case 'reset-demo': confirmDel(function () {
        state.db = S.demoDB(); state.scoresExam = ''; state.wrongExam = '';
        persist('已恢复演示数据'); renderTeacher();
      }); break;
      case 'clear-all': confirmDel(function () {
        if (!confirm('再确认一次：这会删掉全部学生、成绩和成长记录，且无法恢复。')) return;
        var cloud = S.clone(db.cloud);
        state.db = S.emptyDB(); state.db.cloud = cloud;
        state.scoresExam = ''; state.wrongExam = '';
        persist('已清空'); renderTeacher();
      }); break;
      case 'cloud-toggle': {
        db.cloud.enabled = !db.cloud.enabled;
        persist(db.cloud.enabled ? '云端同步已开启，请先填链接' : '云端同步已关闭');
        renderTeacher(); break;
      }
      case 'cloud-mode': {
        db.cloud.mode = el.dataset.mode;
        persist('已切换为' + (db.cloud.mode === 'github' ? 'GitHub 仓库' : '通用读写链接') + '模式');
        renderTeacher(); break;
      }
      case 'cloud-save': {
        if ((db.cloud.mode || 'github') === 'github') {
          db.cloud.ghRepo = ($('#set-ghrepo') || {}).value ? $('#set-ghrepo').value.trim() : '';
          db.cloud.ghPath = ($('#set-ghpath') || {}).value ? ($('#set-ghpath').value.trim() || 'data.json') : 'data.json';
          db.cloud.ghBranch = ($('#set-ghbranch') || {}).value ? ($('#set-ghbranch').value.trim() || 'main') : 'main';
          db.cloud.ghToken = ($('#set-ghtoken') || {}).value ? $('#set-ghtoken').value.trim() : '';
          db.cloud.getUrl = ($('#set-geturl') || {}).value ? $('#set-geturl').value.trim() : '';
          if (db.cloud.ghRepo && db.cloud.ghToken) db.cloud.enabled = true;
          persist('GitHub 设置已保存'); renderTeacher();
          if (!db.cloud.ghRepo) toast('仓库要写成 用户名/仓库名');
          else if (!db.cloud.ghToken) toast('还要填写入令牌');
          else toast('已保存，点「立即上传」试一次');
        } else {
          db.cloud.getUrl = $('#set-geturl').value.trim();
          db.cloud.putUrl = $('#set-puturl').value.trim();
          db.cloud.token = $('#set-token').value.trim();
          if (db.cloud.getUrl || db.cloud.putUrl) db.cloud.enabled = true;
          persist('链接已保存'); renderTeacher();
          toast(db.cloud.getUrl ? '链接已保存，下面已生成家长专用网址' : '保存后建议点「立即上传」试一次');
        }
        break;
      }
      case 'cloud-pull': pullCloud(true); break;
      case 'cloud-push': pushCloud(); break;
      case 'copy-pwd': copyPwd(id); break;
      case 'copy-url': {
        var u = buildParentURL();
        if (!u) { toast('请先填好数据读取链接'); break; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(u).then(function () { toast('家长网址已复制'); }, function () { fallbackCopy(u); });
        } else fallbackCopy(u);
        break;
      }
      case 'open-url': {
        var u2 = buildParentURL();
        if (u2) window.open(u2, '_blank'); else toast('请先填好数据读取链接');
        break;
      }
    }
  }

  function copyPwd(id) {
    var s = S.studentById(state.db, id); if (!s) return;
    var txt = '【' + (state.db.className || '班级') + '】' + s.alias + '（化名）\n学生编号：' + s.code +
      '\n访问密码：' + s.pwd + '\n请单独保管，不要转发。';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('已复制，可粘贴发给家长'); },
        function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea'); ta.value = txt;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请手动记下'); }
    document.body.removeChild(ta);
  }

  function doExport() {
    var blob = new Blob([JSON.stringify(state.db, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '班级档案备份_' + S.today() + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('已导出备份文件');
  }

  /* ---------------- 表单弹层 ---------------- */
  function stuOptions(sel) {
    return state.db.students.map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === sel ? ' selected' : '') + '>' +
        esc(s.alias) + '（' + esc(s.code) + '）</option>';
    }).join('');
  }
  function examOptions(sel, withAll) {
    var ex = state.db.exams.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    return (withAll ? '<option value="">全部 / 不指定</option>' : '') + ex.map(function (e) {
      return '<option value="' + esc(e.id) + '"' + (e.id === sel ? ' selected' : '') + '>' +
        esc(e.name) + '（' + esc(e.date) + '）</option>';
    }).join('');
  }
  function kpOptions(sel) {
    return '<option value="">未分类</option>' + state.db.kps.map(function (k) {
      return '<option value="' + esc(k.id) + '"' + (k.id === sel ? ' selected' : '') + '>' + esc(k.name) + '</option>';
    }).join('');
  }
  function needStudents() { return state.db.students.length > 0; }

  function modalStudent() {
    var pwd = S.genPwd();
    openModal('添加学生', '<div class="form-grid">' +
      '<div class="form-row"><label>学生编号 *</label><input id="f-code" inputmode="numeric" placeholder="如 20260307"></div>' +
      '<div class="form-row"><label>化名 *</label><input id="f-alias" placeholder="如 小松（勿用真实姓名）"></div></div>' +
      '<div class="form-row"><label>家长访问密码 * <span class="muted">（自动生成，可改）</span></label>' +
      '<input id="f-pwd" value="' + esc(pwd) + '"></div>' +
      '<div class="form-grid"><div class="form-row"><label>性别</label><select id="f-gender"><option value="">不填</option><option>男</option><option>女</option></select></div>' +
      '<div class="form-row"><label>入学日期</label><input id="f-joined" type="date" value="' + S.today() + '"></div></div>' +
      '<div class="notice">编号是家长登录账号，化名是给家长看的称呼。真实姓名不要写进系统。</div>',
      function () {
        var code = $('#f-code').value.trim(), alias = $('#f-alias').value.trim(), pwd2 = $('#f-pwd').value.trim();
        if (!code || !alias || !pwd2) { toast('编号、化名、密码都要填'); return false; }
        var r = S.addStudent(state.db, code, alias, pwd2, {
          gender: $('#f-gender').value, joined: $('#f-joined').value || S.today()
        });
        if (r.error) { toast(r.error); return false; }
        state.db = r.db; persist('已添加 ' + alias); renderTeacher(); return true;
      });
  }

  function modalStudentDetail(id) {
    var s = S.studentById(state.db, id); if (!s) return;
    var ser = S.scoreSeries(state.db, id);
    var g = S.growthOf(state.db, id), n = S.notesOf(state.db, id);
    var body = '<div class="notice green">' + esc(s.alias) + ' · 编号 ' + esc(s.code) + ' · 密码 ' + esc(s.pwd) + '</div>' +
      '<div class="kv"><span>最近得分</span><span>' + (ser.filter(function (p) { return p.score != null; }).slice(-1)[0] || {}).score + '</span></div>' +
      '<div class="kv"><span>成长记录</span><span>' + g.length + ' 条</span></div>' +
      '<div class="kv"><span>老师评语</span><span>' + n.length + ' 条</span></div>' +
      '<div class="form-row" style="margin-top:14px"><label>重置家长密码</label><input id="f-newpwd" value="' + esc(s.pwd) + '"></div>' +
      '<button class="btn btn-ghost btn-block" data-act="copy-pwd" data-id="' + esc(s.id) + '">复制家长登录信息</button>';
    openModal('学生详情', body, function () {
      var np = $('#f-newpwd').value.trim(); if (!np) { toast('密码不能为空'); return false; }
      s.pwd = np; persist('密码已更新'); renderTeacher(); return true;
    });
    $$('#modal-body [data-act]').forEach(function (el) { el.onclick = function () { copyPwd(el.dataset.id); }; });
  }

  function modalExam() {
    openModal('新建考试', '<div class="form-row"><label>名称 *</label><input id="f-name" placeholder="如 第四单元测验"></div>' +
      '<div class="form-grid"><div class="form-row"><label>日期 *</label><input id="f-date" type="date" value="' + S.today() + '"></div>' +
      '<div class="form-row"><label>满分</label><input id="f-full" type="number" value="100" min="1"></div></div>',
      function () {
        var name = $('#f-name').value.trim(), date = $('#f-date').value, full = Number($('#f-full').value) || 100;
        if (!name || !date) { toast('名称和日期都要填'); return false; }
        var id = S.uid('ex');
        state.db.exams.push({ id: id, name: name, date: date, full: full });
        state.scoresExam = id; persist('已新建：' + name); renderTeacher(); return true;
      });
  }

  function modalWrong() {
    if (!needStudents()) { toast('先到「名册」添加学生'); return; }
    openModal('登记错题', '<div class="form-row"><label>学生 *</label><select id="f-stu">' + stuOptions() + '</select></div>' +
      '<div class="form-grid"><div class="form-row"><label>关联考试</label><select id="f-exam">' + examOptions('', true) + '</select></div>' +
      '<div class="form-row"><label>日期</label><input id="f-date" type="date" value="' + S.today() + '"></div></div>' +
      '<div class="form-row"><label>知识点 *</label><select id="f-kp">' + kpOptions('') + '</select></div>' +
      '<div class="form-row"><label>错在哪（一句话）</label><textarea id="f-note" placeholder="如：周长与面积公式记混"></textarea></div>',
      function () {
        var kp = $('#f-kp').value;
        if (!kp) { toast('请选一个知识点，可先到下方清单添加'); return false; }
        state.db.wrong.push({
          id: S.uid('wr'), studentId: $('#f-stu').value, examId: $('#f-exam').value,
          kpId: kp, date: $('#f-date').value || S.today(), note: $('#f-note').value.trim()
        });
        persist('已登记'); renderTeacher(); return true;
      });
  }

  function modalKP() {
    openModal('添加知识点', '<div class="form-row"><label>知识点名称 *</label>' +
      '<input id="f-kpname" placeholder="如 两位数乘两位数"></div>' +
      '<div class="notice">建议对照人教版三年级上下册目录，一单元一条，方便统计共性薄弱点。</div>',
      function () {
        var n = $('#f-kpname').value.trim(); if (!n) { toast('名称不能为空'); return false; }
        state.db.kps.push({ id: S.uid('kp'), name: n });
        persist('已添加'); renderTeacher(); return true;
      });
  }

  function modalPerf() {
    if (!needStudents()) { toast('先到「名册」添加学生'); return; }
    var kinds = ['发言', '进步', '作业', '互助', '提醒', '待改进'];
    openModal('记一笔课堂表现', '<div class="form-row"><label>学生 *</label><select id="f-stu">' + stuOptions() + '</select></div>' +
      '<div class="form-row"><label>类型</label><div class="pill-row" id="f-kinds">' +
      kinds.map(function (k, i) { return '<span class="pill' + (i === 0 ? ' on' : '') + '" data-k="' + k + '">' + k + '</span>'; }).join('') +
      '</div></div>' +
      '<div class="form-grid"><div class="form-row"><label>日期</label><input id="f-date" type="date" value="' + S.today() + '"></div></div>' +
      '<div class="form-row"><label>具体事实 *</label><textarea id="f-note" placeholder="如：主动上台讲清了试商过程"></textarea></div>',
      function () {
        var note = $('#f-note').value.trim(); if (!note) { toast('写一句具体事实'); return false; }
        var kind = ($('#f-kinds .pill.on') || {}).dataset ? $('#f-kinds .pill.on').dataset.k : '发言';
        state.db.perf.push({
          id: S.uid('pf'), studentId: $('#f-stu').value, kind: kind,
          date: $('#f-date').value || S.today(), note: note
        });
        persist('已记录'); renderTeacher(); return true;
      });
    $$('#f-kinds .pill').forEach(function (p) {
      p.onclick = function () {
        $$('#f-kinds .pill').forEach(function (x) { x.classList.remove('on'); });
        p.classList.add('on');
      };
    });
  }

  function modalGrowth() {
    if (!needStudents()) { toast('先到「名册」添加学生'); return; }
    state.photos = [];
    openModal('添加成长记录', '<div class="form-row"><label>学生 *</label><select id="f-stu">' + stuOptions() + '</select></div>' +
      '<div class="form-grid"><div class="form-row"><label>日期</label><input id="f-date" type="date" value="' + S.today() + '"></div></div>' +
      '<div class="form-row"><label>标题 *</label><input id="f-title" placeholder="如：第一次当小老师"></div>' +
      '<div class="form-row"><label>记录内容</label><textarea id="f-text" placeholder="写一件具体的事，比‘表现好’更有用"></textarea></div>' +
      '<div class="form-row"><label>照片（可选，自动压缩）</label>' +
      '<div class="photo-pick" id="f-photos"></div>' +
      '<input type="file" id="f-photoinput" accept="image/*" multiple hidden></div>' +
      '<div class="notice">照片存在本机/JSON 里，建议放作业、作品局部，不放清晰正脸。</div>',
      function () {
        var title = $('#f-title').value.trim(); if (!title) { toast('标题不能为空'); return false; }
        state.db.growth.push({
          id: S.uid('gr'), studentId: $('#f-stu').value, date: $('#f-date').value || S.today(),
          title: title, text: $('#f-text').value.trim(), photos: S.clone(state.photos)
        });
        persist('已添加成长记录'); renderTeacher(); return true;
      });
    renderPhotoPicker();
    $('#f-photoinput').onchange = function (e) { handlePhotos(e.target.files); };
  }

  function renderPhotoPicker() {
    var box = $('#f-photos'); if (!box) return;
    box.innerHTML = state.photos.map(function (src, i) {
      return '<div class="ph"><img src="' + esc(src) + '" alt="照片"><span class="rm" data-rm="' + i + '">×</span></div>';
    }).join('') + '<label class="photo-add" for="f-photoinput">＋</label>';
    $$('[data-rm]', box).forEach(function (b) {
      b.onclick = function () { state.photos.splice(Number(b.dataset.rm), 1); renderPhotoPicker(); };
    });
  }

  function handlePhotos(files) {
    Array.prototype.slice.call(files).forEach(function (f) {
      if (!/^image\//.test(f.type)) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        var img = new Image();
        img.onload = function () {
          var max = 900, w = img.width, h = img.height;
          if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
          else if (h > max) { w = Math.round(w * max / h); h = max; }
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          state.photos.push(cv.toDataURL('image/jpeg', 0.72));
          renderPhotoPicker();
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(f);
    });
  }

  function modalGrowthView(id) {
    var g = null;
    state.db.growth.forEach(function (x) { if (x.id === id) g = x; });
    if (!g) return;
    var s = S.studentById(state.db, g.studentId);
    var body = '<div class="muted">' + esc(s ? s.alias : '') + ' · ' + esc(g.date) + '</div>' +
      '<h3 style="margin:6px 0 10px">' + esc(g.title) + '</h3>' +
      '<div class="note-text">' + esc(g.text || '') + '</div>' +
      (g.photos && g.photos.length ? '<div class="tl-photos">' + g.photos.map(function (src) {
        return '<img src="' + esc(src) + '" alt="照片">';
      }).join('') + '</div>' : '');
    openModal('成长记录', body, function () { return true; });
    $('#modal-save').textContent = '关闭';
    $('#modal .btn-ghost').hidden = true;
  }

  function modalNote() {
    if (!needStudents()) { toast('先到「名册」添加学生'); return; }
    openModal('写评语', '<div class="form-row"><label>学生 *</label><select id="f-stu">' + stuOptions() + '</select></div>' +
      '<div class="form-row"><label>日期</label><input id="f-date" type="date" value="' + S.today() + '"></div>' +
      '<div class="form-row"><label>评语内容 *</label><textarea id="f-text" placeholder="写具体进步 + 下一步建议，家长最想看这个"></textarea></div>',
      function () {
        var text = $('#f-text').value.trim(); if (!text) { toast('评语不能为空'); return false; }
        state.db.notes.push({
          id: S.uid('nt'), studentId: $('#f-stu').value,
          date: $('#f-date').value || S.today(), text: text
        });
        persist('评语已保存，家长刷新可见'); renderTeacher(); return true;
      });
  }

  function resetModalButtons() {
    $('#modal-save').textContent = '保存';
    $('#modal .btn-ghost').hidden = false;
  }

  /* ---------------- 全局事件 ---------------- */
  function bindGlobal() {
    $$('#role-segment .seg-btn').forEach(function (b) {
      b.onclick = function () {
        if (state.parentCfg && b.dataset.role === 'teacher') {
          // 家长链接不允许切到老师端；老师请用不带 ?cfg= 的原网址
          toast('这是家长专用链接，老师请从原网址进入');
          return;
        }
        state.role = b.dataset.role; renderLogin();
      };
    });
    $('#btn-login').onclick = doLogin;
    $('#login-pwd').onkeydown = function (e) { if (e.key === 'Enter') doLogin(); };
    $('#login-code').onkeydown = function (e) { if (e.key === 'Enter') $('#login-pwd').focus(); };
    $('#login-admin').onkeydown = function (e) { if (e.key === 'Enter') doLogin(); };
    $('#btn-parent-logout').onclick = doLogout;
    $('#btn-teacher-logout').onclick = doLogout;

    $$('#parent-tabs .tab').forEach(function (b) {
      b.onclick = function () { state.parentTab = b.dataset.tab; renderParent(); };
    });
    $$('#teacher-tabs .tab').forEach(function (b) {
      b.onclick = function () { state.teacherTab = b.dataset.tab; if (state.db.cloud.enabled) pullCloud(false); renderTeacher(); };
    });

    $('#fab-add').onclick = function () {
      var map = {
        't-students': modalStudent, 't-scores': modalExam, 't-wrong': modalWrong,
        't-perf': modalPerf, 't-growth': modalGrowth
      };
      if (map[state.teacherTab]) map[state.teacherTab]();
    };

    $$('[data-close]').forEach(function (el) {
      el.onclick = function () { closeModal(); resetModalButtons(); };
    });
    $('#modal-save').onclick = function () {
      if ($('#modal-save').textContent === '关闭') { closeModal(); resetModalButtons(); return; }
      var r = state.modalSave ? state.modalSave() : undefined;
      if (r === false) return;   // 校验未通过，保留弹层
      closeModal(); resetModalButtons();
    };
    $('#lightbox').onclick = function () { this.hidden = true; $('#lightbox-img').src = ''; };

    // 手机切回页面 / 家长刷新时，自动取一次云端最新数据
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!state.db.cloud.enabled || !state.db.cloud.getUrl) return;
      pullCloud(false).then(function () { renderCurrent(); });
    });

    // #import-file 是「设置」页动态渲染出来的，静态 DOM 里没有。
    // 用 document 级事件委托，避免启动时给 null 绑事件导致整个 boot 中断。
    document.addEventListener('change', function (e) {
      if (!e.target || e.target.id !== 'import-file') return;
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function (ev) {
        try {
          var d = JSON.parse(ev.target.result);
          if (!d || !Array.isArray(d.students)) throw new Error('不是有效的班级档案备份');
          if (!confirm('导入会替换当前全部数据（学生 ' + d.students.length + ' 人），继续？')) return;
          state.db = S.normalize(d); persist('导入成功'); renderTeacher();
        } catch (err) { toast('导入失败：' + err.message); }
      };
      r.readAsText(f);
      e.target.value = '';
    });

    // 名册批量导入：只接受 编号/化名/密码/性别，拒绝任何疑似隐私字段
    document.addEventListener('change', function (e) {
      if (!e.target || e.target.id !== 'roster-file') return;
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function (ev) {
        try { doRosterImport(ev.target.result); }
        catch (err) { toast('导入失败：' + err.message); }
      };
      r.readAsText(f);
      e.target.value = '';
    });
  }

  /* 名册导入核心：校验 → 选择追加/替换 → 写入 */
  function doRosterImport(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('文件不是有效的 JSON'); }
    var list = Array.isArray(data) ? data : (data && data.students);
    if (!Array.isArray(list) || !list.length) throw new Error('文件里没有学生列表');

    // 隐私字段黑名单：出现就拒绝，防止真实姓名/身份证/电话进系统
    var FORBIDDEN = ['name', 'realName', '真实姓名', '姓名', 'idcard', 'idCard', '身份证',
      'idNo', 'phone', 'tel', '电话', '手机', 'address', '住址', '家庭住址', 'guardian', '监护人'];
    var first = list[0] || {};
    var hit = Object.keys(first).filter(function (k) {
      return FORBIDDEN.indexOf(k) >= 0 || FORBIDDEN.indexOf(String(k).trim()) >= 0;
    });
    if (hit.length) throw new Error('文件含隐私字段「' + hit.join('、') + '」，请先删除再导入');

    // 逐条校验
    var clean = [], errs = [], seen = {};
    list.forEach(function (it, i) {
      var code = String((it && it.code) || '').trim();
      var alias = String((it && (it.alias || it['化名'])) || '').trim();
      var pwd = String((it && (it.pwd || it['密码'])) || '').trim();
      var gender = String((it && (it.gender || it['性别'])) || '').trim();
      if (!code) { errs.push('第' + (i + 1) + '条缺编号'); return; }
      if (!alias) { errs.push('第' + (i + 1) + '条缺化名'); return; }
      if (!pwd) { errs.push('第' + (i + 1) + '条缺密码'); return; }
      if (seen[code]) { errs.push('编号重复：' + code); return; }
      seen[code] = 1;
      clean.push({ id: S.uid('stu'), code: code, alias: alias, pwd: pwd, gender: gender, joined: S.today(), active: true });
    });
    if (errs.length) throw new Error(errs.slice(0, 5).join('；') + (errs.length > 5 ? ' 等 ' + errs.length + ' 处' : ''));
    if (!clean.length) throw new Error('没有可导入的学生');

    var replace = confirm(
      '共 ' + clean.length + ' 名学生待导入。\n\n' +
      '【确定】= 替换：清空现有 ' + state.db.students.length + ' 名学生后导入（成绩等也一并清空）\n' +
      '【取消】= 追加：保留现有学生，只补充新的'
    );

    var imported = 0;
    if (replace) {
      // 替换：整体换成新名册，并清空与旧学生绑定的所有记录
      state.db.students = clean;
      state.db.scores = [];
      state.db.wrong = [];
      state.db.perf = [];
      state.db.growth = [];
      state.db.notes = [];
      imported = clean.length;
    } else {
      // 追加：跳过编号已存在的
      var have = {};
      state.db.students.forEach(function (s) { have[s.code] = 1; });
      clean.forEach(function (s) { if (!have[s.code]) { state.db.students.push(s); imported++; } });
    }

    persist('已导入 ' + imported + ' 名学生');
    renderTeacher();
    toast('导入成功：新增 ' + imported + ' 人，共 ' + state.db.students.length + ' 名学生');
  }

  /* 名册导入模板（只有四个字段） */
  function downloadRosterTemplate() {
    var tpl = {
      className: state.db.className || '三年级（2）班',
      students: [
        { code: '2024011', alias: '小阳', pwd: 'AB23CD', gender: '男' },
        { code: '2024022', alias: '小美', pwd: 'XY78ZW', gender: '女' }
      ]
    };
    var blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '名册导入模板.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('模板已下载，按格式填好后导入');
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    applyTheme(currentTheme());
    state.db = loadLocal();
    state.parentCfg = applyParentCfg();
    bindGlobal();
    if (state.parentCfg) {
      // 家长专用链接：强制走家长登录，不恢复老师会话
      try { sessionStorage.removeItem(SESSION); } catch (e) {}
      state.studentId = null;
      state.role = 'parent';
      showView('view-login'); renderLogin();
      pullCloud(false).then(function (okDone) {
        $('#cfg-status').textContent = okDone
          ? '✓ 已连上云端最新数据，填编号和密码即可查看。'
          : '暂时连不上云端，请检查网络；老师本机录的数据要等上传后才看得到。';
      });
      return;
    }
    if (state.db.cloud.enabled && state.db.cloud.getUrl) {
      pullCloud(false).then(function () {
        if (!restoreSession()) { showView('view-login'); renderLogin(); }
      });
    } else {
      if (!restoreSession()) { showView('view-login'); renderLogin(); }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
