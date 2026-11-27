(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');

  /* ---------- i18n: English lives in the HTML, zh-TW in this dictionary ---------- */
  var zh = {
    skip: '跳到主要內容',
    nav_how: '運作方式',
    nav_sec: '為什麼安全',
    nav_sup: '支援',
    nav_start: '開始使用',
    h1: '你的 AI 代理人能登入，卻永遠看不到密碼。',
    lead: 'blindfill 把密碼管理器裡的帳密直接填進網頁。代理人只知道登入成不成功。',
    cta_start: '開始使用',
    cta_gh: '在 GitHub 查看',
    hero_fine: '以 MIT 授權開源。目前為 alpha：尚未經過獨立資安審查。',
    term_cap: '依 README 範例改寫的示意輸出。',
    how_h: '密碼從密碼庫直接到表單，不經過模型',
    how_p: '代理人只指定帳號與頁面，其餘由 blindfill 完成，回報的只有結果。',
    diag_cap: 'blindfill 流程圖',
    feat_h: '密碼不會進入模型的上下文',
    feat_p: '在你的電腦上執行。可以當 CLI、MCP 伺服器或 TypeScript 函式庫使用。',
    f1h: '機密只能填，不能讀',
    f1: '沒有任何指令或工具會回傳密碼、TOTP 種子或私鑰。',
    f2h: '綁定正確的網站',
    f2: '機密能填到哪裡由密碼庫項目決定。仿冒網域在讀取任何東西之前就會被拒絕。',
    f3h: '填完即上鎖',
    f3: '之後頁面文字、DOM 與截圖一律拒絕提供，輸出都經過遮蔽。',
    f4h: '不確定就停下',
    f4: '欄位不明確或結果不明時，只回報、不重試。',
    sup_h: '支援',
    sup_pk: 'Passkey',
    sup_totp: 'TOTP 驗證碼',
    sup_and: 'Android（實驗性）',
    sup_p:
      '其他密碼管理器（1Password、KeePassXC、pass 等）已實作，但尚未驗證。<a href="https://github.com/mics8128/blindfill/blob/main/docs/TESTED.md" rel="noopener">完整支援狀態與測試紀錄</a>',
    ins_h: '開始使用',
    ins_p: '需要 Node 20 以上與 Bitwarden CLI（<code>bw</code>）。三行指令：',
    ins_fine:
      '還沒有 Chromium？先執行一次 <code>npx playwright-core install chromium</code>。給代理人用：<code>npx -y blindfill mcp</code>。天天用：<code>npm i -g blindfill</code>。',
    lim_p:
      'alpha 軟體：請先用不重要的帳號試。<a href="https://github.com/mics8128/blindfill/blob/main/SECURITY.md" rel="noopener">在 SECURITY.md 閱讀限制</a>',
    copy: '複製指令',
    cta_docs: '閱讀文件',
    foot1: 'blindfill 以 MIT 授權開源。目前為 alpha，尚未經過獨立審查。',
    foot_arch: '架構文件',
    foot_issues: '回報問題',
    aria_primary: '主要導覽',
    aria_lang: '語言',
    aria_theme: '切換深色／淺色主題',
    aria_term: '終端機示範紀錄',
    aria_src: '安裝指令',
    aria_try: '試用指令',
    d_title: 'blindfill 登入流程',
    d_desc:
      '代理人請 blindfill 在某個網址上填入某個項目。blindfill 從密碼庫讀出密碼，把項目的網址與瀏覽器回報的網站來源比對，再把密碼填進頁面欄位。代理人只收到結果。',
    d_desc_t:
      '代理人請 blindfill 在某個網址上填入某個項目。blindfill 從密碼庫讀出密碼，檢查網站來源，再把密碼填進頁面欄位。代理人只收到結果。',
    d_agent: '代理人／LLM',
    d_agent2: '只看得到結果',
    d_core1: '檢查網站來源',
    d_core2: '遮蔽輸出、上鎖',
    d_page: '瀏覽器頁面',
    d_page2: '真正的登入表單',
    d_vault: '你的密碼庫',
    d_ok: '只回傳 ok／網址',
    d_typed: '密碼直接填入',
    d_origin: '實際的網站來源',
    d_read: '檢查通過後才讀取密碼',
    d_bad: '✕ 密碼庫與欄位都沒有路徑通回模型',
    d_read1: '檢查通過後',
    d_read2: '才讀取',
    d_typed1: '直接填入',
    d_typed2: '欄位',
    d_bad1: '✕ 密碼庫與欄位都沒有',
    d_bad2: '路徑通回模型',
  };

  var enAria = {};
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-i18n],[data-i18n-html]'));
  var en = {};
  nodes.forEach(function (n) {
    var k = n.getAttribute('data-i18n') || n.getAttribute('data-i18n-html');
    if (!(k in en)) en[k] = n.innerHTML.replace(/\s+/g, ' ').trim();
  });
  var meta = {
    en: {
      title: document.title,
      desc: document.querySelector('meta[name="description"]').getAttribute('content'),
    },
    'zh-TW': {
      title: 'blindfill：讓 AI 代理人登入，卻看不到密碼',
      desc: 'blindfill 把密碼管理器裡的帳密直接填進登入欄位。代理人只挑帳號，密碼不會進入模型的上下文。開源、MIT 授權、alpha 階段。',
    },
  };

  function setLang(lang, persist) {
    var dict = lang === 'zh-TW' ? zh : en;
    nodes.forEach(function (n) {
      var k = n.getAttribute('data-i18n') || n.getAttribute('data-i18n-html');
      if (dict[k] != null) n.innerHTML = dict[k];
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-aria]'), function (n) {
      var k = n.getAttribute('data-i18n-aria');
      if (!(k in enAria)) enAria[k] = n.getAttribute('aria-label');
      n.setAttribute('aria-label', (lang === 'zh-TW' ? zh : enAria)[k]);
    });
    root.lang = lang;
    document.title = meta[lang].title;
    document.querySelector('meta[name="description"]').setAttribute('content', meta[lang].desc);
    Array.prototype.forEach.call(document.querySelectorAll('[data-lang]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang));
    });
    if (persist) {
      try {
        localStorage.setItem('bf-lang', lang);
      } catch (e) {}
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-lang]'), function (b) {
    b.addEventListener('click', function () {
      setLang(b.getAttribute('data-lang'), true);
    });
  });
  var saved = null;
  try {
    saved = localStorage.getItem('bf-lang');
  } catch (e) {}
  var qs = /[?&]lang=(zh-TW|en)/.exec(location.search);
  var initial = qs
    ? qs[1]
    : saved || ((navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh-TW' : 'en');
  if (initial === 'zh-TW') setLang('zh-TW', false);

  /* ---------- theme ---------- */
  document.getElementById('theme').addEventListener('click', function () {
    var cur = root.getAttribute('data-theme');
    if (!cur) cur = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    var next = cur === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('bf-theme', next);
    } catch (e) {}
  });

  /* ---------- terminal demo ---------- */
  var lines = Array.prototype.slice.call(document.querySelectorAll('#demo .ln'));
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    lines.forEach(function (l) {
      l.classList.add('show');
    });
  } else {
    var i = 0;
    (function next() {
      if (i >= lines.length) return;
      var l = lines[i++];
      l.classList.add('show');
      setTimeout(
        next,
        l.classList.contains('c') || l.classList.contains('ok') || l.classList.contains('err') ? 650 : 900,
      );
    })();
  }

  /* ---------- copy ---------- */
  var btn = document.getElementById('copy');
  var status = document.getElementById('copied');
  btn.addEventListener('click', function () {
    var text = document.getElementById('cmd').textContent;
    var done = function (ok) {
      status.textContent = ok ? (root.lang === 'zh-TW' ? '已複製' : 'Copied') : '';
      if (ok) {
        var old = btn.innerHTML;
        btn.textContent = root.lang === 'zh-TW' ? '已複製' : 'Copied';
        setTimeout(function () {
          btn.innerHTML = old;
        }, 1500);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(true);
        },
        function () {
          done(false);
        },
      );
    } else {
      var r = document.createRange();
      r.selectNodeContents(document.getElementById('cmd'));
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      done(false);
    }
  });
})();
