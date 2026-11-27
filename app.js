(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');

  /* ---------- i18n: English lives in the HTML, zh-TW in this dictionary ---------- */
  var zh = {
    skip: '跳到主要內容',
    nav_how: '運作方式',
    nav_sec: '安全設計',
    nav_status: '密碼管理器',
    nav_faq: '常見問題',
    h1: '你的 AI 代理人能登入，卻永遠看不到密碼。',
    lead: 'blindfill 把你的密碼管理器（例如 Bitwarden）接上瀏覽器，直接把帳密填進登入欄位。代理人只負責挑選帳號，密碼永遠不會進入模型的上下文。',
    cta_start: '開始使用',
    cta_gh: '在 GitHub 查看',
    hero_fine: '以 MIT 授權開源。目前為 alpha：尚未經過獨立資安審查，也還沒發佈到 npm。',
    term_cap: '依 README 範例改寫的示意輸出。',
    how_h: '密碼從密碼庫直接到表單，不經過模型',
    how_p: '代理人只指定帳號與頁面，其餘由 blindfill 完成，回報的只有結果。',
    diag_cap: 'blindfill 流程圖',
    st1h: '代理人指定項目與網址',
    st1: '它無法決定密碼要填去哪裡，目標來自項目本身的 URI。',
    st2h: 'blindfill 驗證網站',
    st2: '瀏覽器回報的網站來源必須與項目相符。相似網域與跨來源 iframe 會在讀取任何密碼之前就被拒絕。',
    st3h: '填好表單，接著上鎖',
    st3: '表單最多送出一次。之後頁面文字、DOM 與截圖一律拒絕提供，所有輸出都經過遮蔽。',
    feat_h: '密碼不會進入模型的上下文',
    feat_p:
      'blindfill 在你的電腦上執行，透過密碼管理器自己的 CLI 讀取資料。可以用 CLI、走 stdio 的 MCP 伺服器，或在自己的 Playwright 頁面上用 TypeScript 函式庫呼叫。',
    f1h: '機密只能填，不能讀',
    f1: '密碼、隱藏欄位、卡號只能填進欄位；TOTP 種子和私鑰連填都不會填。沒有任何 CLI 指令、MCP 工具或函式庫呼叫會回傳它們。',
    f2h: '綁定正確的網站',
    f2: '密碼填在哪裡，由密碼庫項目與實際觀察到的網站來源決定，不是代理人。網頁無法把它導去別處。',
    f3h: '填完即上鎖',
    f3: '機密一旦填入，頁面文字、DOM 與截圖都會被拒絕，所有輸出都經過遮蔽。',
    f4h: '不確定就停下',
    f4: '欄位不明確、網站來源不符或結果不明時，只回報、不重試。誘餌欄位會被略過。',
    cls_h: '代理人能讀什麼',
    cls_c1: '等級',
    cls_c2: '範例',
    cls_c3: '可讀取',
    cls_c4: '可填入',
    cls_r1: 'Secret（機密）',
    cls_e1: '密碼、隱藏的自訂欄位、卡號與安全碼',
    cls_r5: 'Key（金鑰）',
    cls_e5: 'TOTP 種子、SSH 私鑰、passkey 私鑰',
    cls_sign: '永不（passkey 只用來簽章）',
    cls_never: '永不',
    yes: '可以',
    no: '不行',
    cls_r2: 'Ephemeral（短暫）',
    cls_e2: '目前的 TOTP 驗證碼',
    cls_r3: 'Readable（可讀）',
    cls_e3: '使用者名稱、項目名稱、URI、文字欄位',
    cls_r4: 'Notes（備註）',
    cls_e4: '自由格式備註，可能藏有機密',
    cls_def: '預設關閉，可逐項開啟',
    cls_fine:
      '等級取決於密碼庫中的欄位類型，無法判斷的資料一律視為 Secret。洩漏測試會在所有輸出與狀態檔中搜尋誘餌密碼。<a href="https://github.com/mics8128/blindfill/blob/main/SECURITY.md" rel="noopener">閱讀 SECURITY.md</a>',
    cmp_h: '與常見做法比較',
    cmp_p: '各種做法通常如何處理密碼。實際產品各有差異，請以你使用的為準。',
    cmp_cap: '讓代理人登入的各種做法比較',
    cmp_c1: '做法',
    cmp_c2: '密碼會進入模型的上下文',
    cmp_c3: '由誰決定填在哪裡',
    cmp_c4: '在哪裡執行',
    cmp_a1: '設計上不會：機密只能填入',
    cmp_a2: '密碼庫項目，並與瀏覽器回報的網站來源比對',
    cmp_a3: '你的電腦，使用你的密碼庫 CLI',
    cmp_b0: '把密碼貼進提示詞',
    cmp_b1: '會',
    cmp_model: '模型',
    cmp_b3: '模型執行的地方',
    cmp_c0: '把密碼管理器 CLI 交給代理人',
    cmp_c1x: '通常會：CLI 會把明文回傳給呼叫者',
    cmp_c3x: '你的電腦',
    cmp_d0: '瀏覽器擴充功能自動填入',
    cmp_d1: '填入當下通常不會，要看代理人之後讀到什麼',
    cmp_d2: '擴充功能自己的網站比對',
    cmp_d3: '你的瀏覽器',
    cmp_e0: '雲端瀏覽器服務',
    cmp_e1: '視服務商而定',
    cmp_e2: '不一定',
    cmp_e3: '服務商的基礎設施',
    cmp_fine: '填寫後的上鎖只涵蓋 blindfill 自己的介面。連到同一個瀏覽器的其他工具仍可讀取頁面。',
    sup_h: '密碼管理器與瀏覽器',
    sup_p:
      '<code>main</code> 分支 0.1.0-alpha.0 的狀態，取自 <a href="https://github.com/mics8128/blindfill/blob/main/README.md" rel="noopener">README</a>、<a href="https://github.com/mics8128/blindfill/blob/main/docs/browsers.md" rel="noopener">browsers.md</a> 與測試紀錄 <a href="https://github.com/mics8128/blindfill/blob/main/docs/TESTED.md" rel="noopener">TESTED.md</a>（每次測試，含失敗）。',
    sup_cap: '支援狀態',
    sup_c1: '項目',
    sup_c2: '狀態',
    sup_c3: '說明',
    sup_g1: '瀏覽器與平台',
    sup_g2: '密碼管理器',
    sup_g3: '發佈',
    st_ok: '支援，已測試',
    st_optin: '選用測試',
    st_sep: '僅限獨立實例',
    st_lim: '有限支援',
    st_exp: '實驗性',
    st_no: '不支援',
    st_mock: '模擬環境 + 一次真實密碼庫',
    st_unv: '未驗證',
    st_npm: '未發佈',
    sup_chr: 'Playwright 內建版本、以 <code>--executable</code> 指定的任何 Chromium，或本機 CDP 連線。',
    sup_ff:
      '透過本機 Playwright 伺服器連線。已對 Camoufox 158.0.1-beta.41 與 159.0-beta.43 測試；長時間執行的實例尚未測試。',
    sup_ego: '另外啟動、空白設定檔的獨立實例。不支援連上正在執行的 app。',
    sup_pkh: 'Passkey',
    sup_pk: 'Chromium 網頁登入，只針對假的依賴方測試過。不回寫計數器，不支援註冊。',
    sup_and:
      '輔助 APK：密碼走自動填入服務，passkey 走憑證提供者（簽章在主機端）。已用正式金鑰簽署；以 <code>blindfill android install --serial &lt;s&gt;</code> 安裝，每次填入前主機都會核對手機上 APK 的簽署者。在一支手機上用假 app 測試過；2026-11-27 在同一支手機測真實 app：Threads 登入成功，Instagram 部分完成（未確認登入結果）。',
    sup_bw:
      '<code>bw</code>，以模擬 CLI 與測試資料驗證；2026-11-27 在真實密碼庫上跑過一次端到端測試（拋棄式項目、本機假網頁）。尚未用於真實網站。',
    sup_oth: '只通過錄製資料的契約測試，從未在真實密碼庫上執行。',
    sup_npm: 'npm 上的 <code>latest</code> 只是空的佔位套件，請從原始碼建置。',
    lim_h: '使用前先了解限制',
    lim_ah: '尚未完成',
    lim_a1: 'Android：WebView 登入、儲存新登入。',
    lim_a2: 'Passkey 註冊與計數器回寫。',
    lim_a3: 'WebKit／Safari。',
    lim_a4: 'Shadow DOM、封閉的 iframe 與 canvas 輸入框。遇到時 blindfill 會停止。',
    lim_a5: '任何後端登入真實網站（唯一一次真實密碼庫測試用的是本機假網頁）。',
    lim_a6: 'npm 正式發佈與獨立資安審查。',
    lim_bh: '不在威脅模型內',
    lim_b0: 'blindfill 防的是模型與它的日誌，下列情況不在防護範圍：',
    lim_b1: '惡意或已被入侵的網頁。你綁定的網頁上的指令碼讀得到填入的密碼。',
    lim_b2: '能讀取行程記憶體、瀏覽器設定檔或密碼庫工作階段的被入侵瀏覽器或電腦。',
    lim_b3: '連到同一個瀏覽器的其他工具，它們讀得到已填好的欄位。',
    lim_b4: '會轉換密碼內容的網頁。遮蔽只能盡力而為。',
    lim_link: '在 SECURITY.md 閱讀完整威脅模型',
    faq_h: '常見問題',
    q1: '模型會看到我的密碼嗎？',
    a1: '透過 blindfill 不會：沒有任何指令、工具或函式會回傳 Secret 等級的值。密碼填入後存在於頁面的 DOM，其他瀏覽器工具讀得到。如果你在意這點，同一個工作階段就只給代理人 blindfill，不要再給不受限的瀏覽器工具。',
    q2: '它讀得到我的一次性驗證碼嗎？',
    a2: '可以，目前的驗證碼能像文字一樣讀取與填入，TOTP 種子則絕不回傳。驗證碼的安全性取決於網站來源綁定與它很快失效。',
    q3: '代理人要怎麼呼叫它？',
    a3: '透過 <code>blindfill</code> CLI、走 stdio 的 MCP 伺服器（<code>blindfill mcp</code>），或在自己的 Playwright 頁面上使用 TypeScript 函式庫。',
    q4: '可以用在我的正式帳號上嗎？',
    a4: '它是 alpha 軟體，沒有經過獨立審查。請先用拋棄式或影響不大的帳號試用，並先讀過威脅模型。',
    ins_h: '從原始碼建置',
    ins_p:
      'blindfill 還沒有發佈到 npm，請不要執行 <code>npx blindfill</code>。需要 Node 20 以上；Bitwarden 後端需要 Bitwarden CLI（<code>bw</code>）。',
    copy: '複製指令',
    cta_docs: '閱讀 README',
    foot1: 'blindfill 以 MIT 授權開源。目前為 alpha，尚未經過獨立審查。',
    foot_arch: '架構文件',
    foot_issues: '回報問題',
    aria_primary: '主要導覽',
    aria_lang: '語言',
    aria_theme: '切換深色／淺色主題',
    aria_term: '終端機示範紀錄',
    aria_src: '從原始碼建置的指令',
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

  // mobile tables stack each row; every cell shows its column name above the value
  function labelTables() {
    Array.prototype.forEach.call(document.querySelectorAll('table.stack'), function (t) {
      var heads = t.querySelectorAll('thead th');
      Array.prototype.forEach.call(t.querySelectorAll('tbody tr'), function (tr) {
        if (tr.children.length !== heads.length) return;
        Array.prototype.forEach.call(tr.children, function (c, i) {
          if (c.tagName === 'TD') c.setAttribute('data-label', heads[i].textContent.trim());
        });
      });
    });
  }

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
    labelTables();
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
  else labelTables();

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
