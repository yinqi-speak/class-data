/* ============================================================
 * store.js — 数据层（纯逻辑，可在 Node 里直接单测）
 * 说明：本文件不依赖 DOM / localStorage，便于自动化验证。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Store = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;

  /* ---------- 基础工具 ---------- */
  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }
  function today() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* 简单散列：仅用于「别把管理密码明文摆在那」，不是加密，不具备安全强度。
     真实敏感数据请勿依赖它。FNV-1a 变体，浏览器与 Node 结果一致。 */
  function hashPwd(s) {
    var str = 'cjda|' + String(s == null ? '' : s) + '|v1';
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + c * (i + 7)) >>> 0;
      h2 = Math.imul(h2 ^ (h2 >>> 7), 0x01000193) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }
  function verifyPwd(s, hash) { return hashPwd(s) === hash; }

  /* ---------- 默认演示数据（全部化名，可直接清空） ---------- */
  function demoDB() {
    var S = [
      { code: '20260301', alias: '小宇' },
      { code: '20260302', alias: '小禾' },
      { code: '20260303', alias: '小舟' },
      { code: '20260304', alias: '小柠' },
      { code: '20260305', alias: '小远' },
      { code: '20260306', alias: '小满' }
    ];
    var db = emptyDB();
    db.className = '三年级（1）班';
    db.adminHash = hashPwd('admin123');
    S.forEach(function (s, i) {
      var pwd = 'p' + s.code.slice(-4) + '26';
      db.students.push({
        id: 'stu_' + (i + 1), code: s.code, alias: s.alias,
        pwd: pwd, gender: i % 2 ? '女' : '男', joined: '2026-09-01', active: true
      });
    });

    db.kps = [
      { id: 'kp1', name: '万以内加减法' }, { id: 'kp2', name: '多位数乘一位数' },
      { id: 'kp3', name: '除数是一位数的除法' }, { id: 'kp4', name: '长方形正方形周长' },
      { id: 'kp5', name: '分数的初步认识' }, { id: 'kp6', name: '时分秒 / 年月日' },
      { id: 'kp7', name: '面积与面积单位' }, { id: 'kp8', name: '解决问题（应用题）' }
    ];

    var exams = [
      { id: 'ex1', name: '第一单元测验', date: '2026-09-18', full: 100 },
      { id: 'ex2', name: '第二单元测验', date: '2026-10-16', full: 100 },
      { id: 'ex3', name: '期中考试', date: '2026-11-06', full: 100 },
      { id: 'ex4', name: '第三单元测验', date: '2026-11-27', full: 100 }
    ];
    db.exams = exams;
    var base = [88, 72, 95, 61, 80, 91];
    var drift = [
      [0, 3, -2, -12], [-4, 6, 9, 12], [2, -1, 3, 1],
      [6, 12, 15, 20], [-3, 1, -5, -14], [1, 4, 2, 6]
    ];
    db.students.forEach(function (stu, i) {
      exams.forEach(function (ex, j) {
        var v = base[i] + drift[i][j];
        db.scores.push({ id: uid('sc'), examId: ex.id, studentId: stu.id, score: Math.max(0, Math.min(100, v)) });
      });
    });

    db.wrong = [
      { id: uid('wr'), studentId: 'stu_4', examId: 'ex1', kpId: 'kp2', date: '2026-09-19', note: '进位乘法漏加进位' },
      { id: uid('wr'), studentId: 'stu_4', examId: 'ex2', kpId: 'kp2', date: '2026-10-17', note: '连续进位仍出错' },
      { id: uid('wr'), studentId: 'stu_2', examId: 'ex2', kpId: 'kp3', date: '2026-10-17', note: '试商偏大' },
      { id: uid('wr'), studentId: 'stu_4', examId: 'ex3', kpId: 'kp4', date: '2026-11-07', note: '周长与面积混淆' },
      { id: uid('wr'), studentId: 'stu_5', examId: 'ex3', kpId: 'kp4', date: '2026-11-07', note: '周长公式记成面积' },
      { id: uid('wr'), studentId: 'stu_1', examId: 'ex3', kpId: 'kp8', date: '2026-11-07', note: '两步应用题漏第一步' },
      { id: uid('wr'), studentId: 'stu_6', examId: 'ex3', kpId: 'kp5', date: '2026-11-07', note: '同分母分数比较大小' }
    ];

    db.perf = [
      { id: uid('pf'), studentId: 'stu_4', date: '2026-11-10', kind: '进步', note: '主动订正了整页错题' },
      { id: uid('pf'), studentId: 'stu_2', date: '2026-11-10', kind: '发言', note: '上台讲清了试商过程' },
      { id: uid('pf'), studentId: 'stu_4', date: '2026-11-12', kind: '作业', note: '连续三天全对' },
      { id: uid('pf'), studentId: 'stu_1', date: '2026-11-12', kind: '互助', note: '帮同桌讲应用题' }
    ];

    db.growth = [
      { id: uid('gr'), studentId: 'stu_1', date: '2026-09-20', title: '第一次当小老师', text: '上台给全班讲了一道两步应用题，声音比开学时响亮多了。', photos: [] },
      { id: uid('gr'), studentId: 'stu_4', date: '2026-10-18', title: '乘法竖式终于全对', text: '连续两周每天练五道进位乘法，这次单元测验这一块没再丢分。', photos: [] },
      { id: uid('gr'), studentId: 'stu_2', date: '2026-11-08', title: '期中后的小约定', text: '自己定了「每天一道除法」的小目标，写在课本扉页上。', photos: [] },
      { id: uid('gr'), studentId: 'stu_1', date: '2026-11-13', title: '数学日记', text: '用乘法算出了全家一周的牛奶盒数，第一次自己发现生活里的数学。', photos: [] }
    ];

    db.notes = [
      { id: uid('nt'), studentId: 'stu_4', date: '2026-11-13', text: '这两周进步很明显，尤其是肯主动订正。下一步重点是把「周长」和「面积」分清楚，我会单独带他做一组对比练习。' },
      { id: uid('nt'), studentId: 'stu_1', date: '2026-11-13', text: '思维很活，喜欢讲题给同学听。可以开始挑战一点需要两步转换的题目，别只停在会算。' },
      { id: uid('nt'), studentId: 'stu_2', date: '2026-11-10', text: '除法试商已经稳了，遇到余数要记得和除数比一比。' }
    ];
    return db;
  }

  function emptyDB() {
    return {
      version: VERSION, className: '我的班级', adminHash: hashPwd('admin123'),
      // 当前学期（影响默认筛选；历史记录保留）
      term: '2026-秋',
      /* 科目 = 老师账号。每科一条记录：
         { id, name, pwd, admin }
         - pwd：该科老师的登录密码（换老师就改这里，账号不变）
         - admin：true 表示是管理账号（可改名册、加科目、改密码）
         数学默认就是管理账号，所以现有用户不用学新东西。 */
      subjects: [
        { id: 'sub_math', name: '数学', pwd: 'admin123', admin: true }
      ],
      activeSubject: 'sub_math',
      students: [], exams: [], scores: [], kps: [], wrong: [], perf: [], growth: [], notes: [],
      cloud: {
        enabled: false, mode: 'github',
        getUrl: '', putUrl: '', token: '',
        ghRepo: '', ghPath: 'data.json', ghBranch: 'main', ghToken: ''
      }
    };
  }

  /* ---------- 科目账号 ---------- */
  /* 用密码找对应的科目账号。返回科目对象或 null。
     兼容旧数据：没有 pwd 的科目，用 adminHash 对应的密码（即原管理密码）登录数学。 */
  function findBySubjectPwd(db, pwd) {
    if (!pwd) return null;
    var subs = db.subjects || [];
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      if (s.pwd && s.pwd === pwd) return s;
    }
    // 旧数据兜底：没设 pwd 的科目，用管理密码认作它的密码
    for (var j = 0; j < subs.length; j++) {
      if (!subs[j].pwd && verifyPwd(pwd, db.adminHash)) return subs[j];
    }
    return null;
  }
  function subjectById(db, id) {
    var subs = db.subjects || [];
    for (var i = 0; i < subs.length; i++) if (subs[i].id === id) return subs[i];
    return null;
  }
  function isAdminSubject(db, subjectId) {
    var s = subjectById(db, subjectId);
    return !!(s && s.admin);
  }
  /* 把某条记录归到某科目：老数据没有 subjectId 的一律算数学 */
  function subjectOf(rec) {
    return (rec && rec.subjectId) || 'sub_math';
  }
  /* 按科目筛选任意记录数组 */
  function filterBySubject(list, subjectId) {
    if (!subjectId) return list.slice();
    return list.filter(function (r) { return subjectOf(r) === subjectId; });
  }

  /* ---------- 查询 / 统计（纯函数，单测目标） ---------- */
  function studentByCode(db, code) {
    var c = String(code || '').trim();
    for (var i = 0; i < db.students.length; i++) if (db.students[i].code === c) return db.students[i];
    return null;
  }
  function studentById(db, id) {
    for (var i = 0; i < db.students.length; i++) if (db.students[i].id === id) return db.students[i];
    return null;
  }
  function examById(db, id) {
    for (var i = 0; i < db.exams.length; i++) if (db.exams[i].id === id) return db.exams[i];
    return null;
  }
  function kpById(db, id) {
    for (var i = 0; i < db.kps.length; i++) if (db.kps[i].id === id) return db.kps[i];
    return null;
  }

  /* 返回按考试日期排序的某个学生成绩序列 */
  /* 取某学生的成绩序列。subjectId 为空时返回全部科目（家长总览用）；
     传了 subjectId 就只取该科目（单科趋势用）。老数据无 subjectId 视为数学。 */
  function scoreSeries(db, studentId, subjectId) {
    return db.exams.filter(function (ex) {
      if (!subjectId) return true;
      return (ex.subjectId || 'sub_math') === subjectId;
    })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
      .map(function (ex) {
        var rec = null;
        for (var i = 0; i < db.scores.length; i++) {
          var s = db.scores[i];
          if (s.examId === ex.id && s.studentId === studentId) { rec = s; break; }
        }
        return { exam: ex, score: rec ? Number(rec.score) : null };
      });
  }

  function deltaList(series) {
    var out = [], prev = null;
    series.forEach(function (p) {
      if (p.score == null) { out.push(null); return; }
      out.push(prev == null ? null : p.score - prev);
      prev = p.score;
    });
    return out;
  }

  function classAverage(db, examId) {
    var arr = db.scores.filter(function (s) { return s.examId === examId && s.score !== null && s.score !== ''; })
      .map(function (s) { return Number(s.score); });
    if (!arr.length) return null;
    return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
  }

  /* 班级共性薄弱知识点：按错题次数降序 */
  function weakKPs(db, examId) {
    var map = {};
    db.wrong.forEach(function (w) {
      if (examId && w.examId !== examId) return;
      if (!w.kpId) return;
      map[w.kpId] = (map[w.kpId] || 0) + 1;
    });
    return Object.keys(map).map(function (k) {
      return { kp: kpById(db, k) || { id: k, name: '未分类' }, count: map[k] };
    }).sort(function (a, b) { return b.count - a.count || a.kp.name.localeCompare(b.kp.name, 'zh'); });
  }

  /* 需要关注的学生：最近一次相对前一次退步，或分数低于班级平均 10 分以上 */
  function attentionStudents(db) {
    var exams = db.exams.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (exams.length < 2) return [];
    var last = exams[exams.length - 1], prev = exams[exams.length - 2];
    var avg = classAverage(db, last.id);
    var out = [];
    db.students.forEach(function (stu) {
      var cur = scoreOf(db, last.id, stu.id), before = scoreOf(db, prev.id, stu.id);
      if (cur == null) return;
      var reasons = [];
      if (before != null && cur - before <= -8) reasons.push('较上次退步 ' + (before - cur) + ' 分');
      if (avg != null && cur < avg - 10) reasons.push('低于班均 ' + Math.round(avg - cur) + ' 分');
      if (reasons.length) out.push({ student: stu, score: cur, reasons: reasons });
    });
    return out.sort(function (a, b) { return a.score - b.score; });
  }

  function scoreOf(db, examId, studentId) {
    for (var i = 0; i < db.scores.length; i++) {
      var s = db.scores[i];
      if (s.examId === examId && s.studentId === studentId) {
        if (s.score === '' || s.score == null) return null;
        return Number(s.score);
      }
    }
    return null;
  }

  function growthOf(db, studentId) {
    return db.growth.filter(function (g) { return g.studentId === studentId; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }
  function notesOf(db, studentId) {
    return db.notes.filter(function (n) { return n.studentId === studentId; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }
  function perfOf(db, studentId) {
    return db.perf.filter(function (p) { return p.studentId === studentId; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }
  function wrongOf(db, studentId) {
    return db.wrong.filter(function (w) { return w.studentId === studentId; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }

  /* ---------- 增删改（返回新 db，便于测试） ---------- */
  function upsertScore(db, examId, studentId, score) {
    var out = clone(db);
    var val = (score === '' || score == null) ? null : Number(score);
    for (var i = 0; i < out.scores.length; i++) {
      if (out.scores[i].examId === examId && out.scores[i].studentId === studentId) {
        if (val == null) out.scores.splice(i, 1); else out.scores[i].score = val;
        return out;
      }
    }
    if (val != null) out.scores.push({ id: uid('sc'), examId: examId, studentId: studentId, score: val });
    return out;
  }

  function addStudent(db, code, alias, pwd, extra) {
    var out = clone(db);
    if (studentByCode(out, code)) return { error: '该编号已存在' };
    out.students.push(Object.assign({
      id: uid('stu'), code: String(code).trim(), alias: String(alias).trim(),
      pwd: String(pwd), gender: '', joined: today(), active: true
    }, extra || {}));
    return { db: out };
  }

  /* 生成随机 6 位家长密码（去掉易混淆字符） */
  function genPwd() {
    var chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    var s = '';
    for (var i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  }

  function normalize(db) {
    var out = clone(emptyDB());
    if (!db || typeof db !== 'object') return out;
    ['version', 'className', 'adminHash', '_updatedAt', 'term', 'activeSubject'].forEach(function (k) { if (db[k] != null) out[k] = db[k]; });
    ['students', 'exams', 'scores', 'kps', 'wrong', 'perf', 'growth', 'notes', 'subjects'].forEach(function (k) {
      if (Array.isArray(db[k])) out[k] = db[k];
    });
    // 兼容旧数据：没有科目就补一个数学
    if (!out.subjects.length) out.subjects = [{ id: 'sub_math', name: '数学' }];
    if (!out.activeSubject) out.activeSubject = out.subjects[0].id;
    if (db.cloud && typeof db.cloud === 'object') {
      out.cloud = Object.assign(out.cloud, db.cloud);
    }
    return out;
  }

  return {
    VERSION: VERSION, uid: uid, today: today, clone: clone,
    hashPwd: hashPwd, verifyPwd: verifyPwd, genPwd: genPwd,
    demoDB: demoDB, emptyDB: emptyDB, normalize: normalize,
    studentByCode: studentByCode, studentById: studentById, examById: examById, kpById: kpById,
    scoreSeries: scoreSeries, deltaList: deltaList, classAverage: classAverage,
    weakKPs: weakKPs, attentionStudents: attentionStudents, scoreOf: scoreOf,
    growthOf: growthOf, notesOf: notesOf, perfOf: perfOf, wrongOf: wrongOf,
    upsertScore: upsertScore, addStudent: addStudent,
    /* 科目账号 */
    findBySubjectPwd: findBySubjectPwd, subjectById: subjectById,
    isAdminSubject: isAdminSubject, subjectOf: subjectOf, filterBySubject: filterBySubject
  };
});
