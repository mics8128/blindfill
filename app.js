(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');

  /* ---------- i18n: English lives in the HTML, zh-TW in this dictionary ---------- */
  var zh = {
    skip: '跳到主要內容',
    nav_how: '運作方式',
    nav_compare: '比較',
    nav_limits: '限制',
    nav_faq: '常見問題',
    gh: 'GitHub',
    badge: 'Alpha · 0.1.0-alpha.0 · MIT',
    h1: '讓代理人登入，<br /><em>但絕不讓它看到密碼。</em>',
    lead: 'blindfill 從你的密碼管理員取出憑證，確認它確實屬於瀏覽器目前所在的網站，再直接填進真正的表單。模型拿到的只有頁面結構與執行結果，永遠不會拿到密碼本身。',
    cta_install: '安裝',
    cta_gh: '在 GitHub 查看',
    hero_fine:
      '目前是 alpha 軟體，尚未經過獨立的資安審查，而且只支援網頁。請先讀完下方的限制，再決定要不要用在你輸不起的帳號上。',
    term_cap: '示意用的終端機紀錄，依 README 的範例改寫。實際欄位名稱與訊息可能不同。',
    s1b: '只寫不讀',
    s1: 'Secret 等級的值沒有任何讀取途徑',
    s2b: '綁定網站來源',
    s2: '綁定資訊來自密碼庫的項目',
    s3b: '只送出一次',
    s3: '填寫與送出各一次，不自動重試',
    s4b: '填完即上鎖',
    s4: '不再提供頁面文字、DOM 或截圖',
    prob_h: '現在讓代理人登入的做法，每一種都有點彆扭',
    prob_p:
      '想讓代理人通過登入頁，常見做法是把密碼貼進提示詞，或是把密碼管理員的 CLI 交給它，而這些指令會直接回傳明文。不論哪種，密碼都會進入模型的上下文，接著就可能出現在對話紀錄、日誌與工具輸出裡。blindfill 的做法不同：代理人只決定「用哪個帳號、在哪個頁面」，永遠拿不到密碼的值。',
    how_h: '運作方式',
    how_p: '密碼走的是一條完全繞過模型的短路徑，回到模型手上的只有結果。',
    diag_cap: 'blindfill 流程圖',
    st1h: '代理人提出請求',
    st1: '它只指定密碼庫中的某個項目與登入網址，不能決定密碼要填去哪裡：綁定的網站來自項目本身的 URI。',
    st2h: 'blindfill 檢查頁面',
    st2: '把瀏覽器實際回報的網站來源與項目的綁定比對。相似網域或跨來源的 iframe，會在讀取任何密碼之前就被拒絕。',
    st3h: '填入密碼，然後封住',
    st3: '值從密碼庫直接進入欄位，表單最多送出一次。之後整個工作階段不再提供頁面文字、DOM 與截圖，輸出也會經過遮蔽處理。',
    feat_h: '難處理的部分，從設計上就處理好',
    f1h: '密碼只能填，不能讀',
    f1: '密碼、TOTP 種子、隱藏欄位、卡號與私鑰，只能被寫進欄位，不會被回傳。沒有任何 CLI 指令、MCP 工具或函式庫函式會把它們交還給呼叫者。',
    f2h: '該讀的就讓它讀',
    f2: '使用者名稱、項目名稱、URI、文字欄位與目前的一次性驗證碼都是可讀的，代理人才能判斷下一步。TOTP 種子本身則留在後端。',
    f3h: '抵擋釣魚與提示詞注入',
    f3: '網頁沒辦法誘使代理人把密碼填到別處：目標由密碼庫項目與實際觀察到的網站來源決定，不是由呼叫者決定。',
    f4h: '出狀況就停下來',
    f4: '誘餌欄位會被略過。欄位不明確、網站來源不符，或結果不明時：blindfill 會停止並回報，不亂猜，也不重試。',
    feat_src:
      '來源：<a href="https://github.com/mics8128/blindfill/blob/main/SECURITY.md" rel="noopener">SECURITY.md</a> 與 <a href="https://github.com/mics8128/blindfill/blob/main/README.md" rel="noopener">README</a>。',
    f5h: 'CLI、MCP 與函式庫',
    f5: '可以用 <code>blindfill</code> CLI、走 stdio 的 MCP 伺服器，或在自己的 Playwright 頁面上使用 TypeScript 函式庫。',
    f6h: '用誘餌密碼做洩漏測試',
    f6: '洩漏測試會填入一組誘餌密碼，再搜尋所有輸出與狀態檔案有沒有它。這是一道安全網，不是證明。',
    cls_h: '代理人能讀什麼、只能填什麼',
    cls_cap: '欄位等級',
    cls_c1: '等級',
    cls_c2: '範例',
    cls_c3: '代理人可讀取',
    cls_c4: '代理人可填寫',
    cls_r1: 'Secret（機密）',
    cls_e1: '密碼、TOTP 種子、隱藏的自訂欄位、卡號與安全碼、私鑰',
    cls_never: '永不',
    yes: '可以',
    no: '不行',
    cls_r2: 'Ephemeral（短暫）',
    cls_e2: '目前的 TOTP 驗證碼（很快失效）',
    cls_r3: 'Readable（可讀）',
    cls_e3: '使用者名稱、項目名稱、URI、文字欄位',
    cls_r4: 'Notes（備註）',
    cls_e4: '自由格式備註（可能藏有機密）',
    cls_def: '預設不行，可逐項目開啟',
    cls_fine:
      '等級取決於密碼庫本身的欄位類型，所以你可以在平常的密碼庫介面裡控制。無法判斷的資料一律當作 Secret。<a href="https://github.com/mics8128/blindfill/blob/main/docs/ARCHITECTURE.md" rel="noopener">來源</a>。',
    cmp_h: '和常見做法有什麼不同',
    cmp_p: '以下是對各種做法一般運作方式的描述，不是效能測試。實際產品各有差異，請以你使用的那一個為準。',
    cmp_cap: '讓代理人登入的各種做法比較',
    cmp_c2: '把密碼貼進提示詞',
    cmp_c3: '把密碼管理員 CLI 交給代理人',
    cmp_c4: '瀏覽器擴充功能自動填入',
    cmp_c5: '雲端瀏覽器服務',
    cmp_r1: '密碼會進入模型的上下文嗎？',
    cmp_a1: '設計上不會：Secret 等級的值只能填入',
    cmp_b1: '會，這就是做法本身',
    cmp_c1x: '通常會：CLI 會把明文回傳給呼叫它的一方',
    cmp_d1: '填入當下通常不會，但要看代理人之後能讀到什麼',
    cmp_e1: '視服務商與憑證提供方式而定',
    cmp_r2: '由誰決定密碼填在哪裡？',
    cmp_a2: '密碼庫項目的 URI，對照瀏覽器回報的網站來源',
    cmp_b2: '模型',
    cmp_c2x: '模型',
    cmp_d2: '擴充功能自己的網站比對規則',
    cmp_e2: '不一定',
    cmp_r3: '出現在日誌或對話紀錄的風險',
    cmp_a3: '輸出會遮蔽，填寫後工作階段上鎖（盡力而為）',
    cmp_b3: '高：它本身就是對話的一部分',
    cmp_c3x: '只要工具輸出有被記錄，就有風險',
    cmp_d3: '較低，除非代理人去讀已填好的欄位',
    cmp_e3: '不一定',
    cmp_r4: '惡意網頁讀取該欄位',
    cmp_a4: '無法防護。防線是綁定正確的網站來源',
    cmp_b4: '無法防護',
    cmp_c4x: '無法防護',
    cmp_d4: '依擴充功能而異',
    cmp_e4: '不一定',
    cmp_r5: '在哪裡執行',
    cmp_a5: '在你的電腦上，使用你自己的密碼庫 CLI',
    cmp_b5: '模型運行的地方',
    cmp_c5x: '在你的電腦上',
    cmp_d5: '在你的瀏覽器裡',
    cmp_e5: '在服務商的基礎設施上',
    cmp_r6: '成熟度',
    cmp_a6: 'Alpha，未經獨立審查，僅支援網頁',
    cmp_b6: '不適用',
    cmp_c6x: '不適用',
    cmp_d6: '依產品而異',
    cmp_e6: '依產品而異',
    cmp_fine:
      '這些做法也可以搭配使用。要注意的是，填寫後的上鎖只涵蓋 blindfill 自己的介面：如果代理人另外有工具連到同一個瀏覽器，它仍可透過那個工具讀取 DOM。',
    sup_h: '目前支援什麼',
    sup_p:
      '以下是 main 分支（commit fa64962，0.1.0-alpha.0）的狀態，取自專案文件：<a href="https://github.com/mics8128/blindfill/blob/main/README.md" rel="noopener">README</a>、<a href="https://github.com/mics8128/blindfill/blob/main/docs/browsers.md" rel="noopener">browsers.md</a>。',
    sup_bh: '密碼管理員',
    p_mock: '模擬環境驗證',
    sup_bw:
      '<b>Bitwarden / Vaultwarden</b>（<code>bw</code>）：以模擬 CLI 與測試資料驗證過，尚未在真實密碼庫上做完整的端到端測試。',
    p_blind: '依文件撰寫，未驗證',
    sup_oth:
      '<b>1Password</b>（<code>op</code>）、<b>rbw</b>、<b>pass</b>、<b>gopass</b>、<b>KeePassXC</b>、<b>Secret Service</b>：只通過錄製資料的契約測試，從未接觸過真實密碼庫。',
    sup_th: '瀏覽器與平台',
    p_ok: '支援，已測試',
    sup_chr:
      '<b>Chromium</b>：Playwright 內建版本、以 <code>--executable</code> 指定的任何 Chromium 版本，或本機 CDP 連線。',
    p_optin: '需手動啟用',
    sup_ff:
      '<b>Firefox / Camoufox</b>：透過本機 Playwright 伺服器連線，在選用測試中對 Camoufox 158.0.1-beta.41 與 159.0-beta.43 測試過。你自己長時間運行的實例則尚未測試。',
    p_sep: '獨立實例',
    sup_ego: '<b>Ego Lite</b>：只能以另外啟動、空白設定檔的獨立實例使用，無法連上你正在執行的那一個。',
    p_pk: '有限支援',
    sup_pk:
      '<b>Passkey</b>：僅限網頁登入，僅限 Chromium（CDP 虛擬驗證器），只針對模擬的依賴方測試過。不回寫計數器，也不支援註冊。',
    p_plan: '尚未支援',
    sup_plan: '<b>WebKit／Safari</b>：尚未支援。<b>Android</b>：尚未實作（只是空殼）。',
    lim_h: '它（目前）做不到的事',
    lim_ah: '還沒做',
    lim_a1: '只支援網頁。Android 還沒有實作（只是一個會丟出錯誤的空殼）。',
    lim_a2: 'Passkey：僅限 Chromium 上的網頁登入。不回寫計數器，也不支援註冊。',
    lim_a3: '不支援 WebKit／Safari。Firefox／Camoufox 需手動啟用。',
    lim_a4: '沒有任何後端在真實密碼庫上做過完整端到端驗證。',
    lim_a5: '偵測不到 Shadow DOM、封閉的 iframe 與 canvas 輸入框，遇到時會直接停止。',
    lim_a6: '尚未發佈到 npm，也沒有獨立的資安審查。',
    lim_bh: '威脅模型，用白話說',
    lim_b0: 'blindfill 防的是模型與它的日誌，下列情況它防不了：',
    lim_b1: '<b>惡意或已被入侵的網頁。</b>密碼會被輸入到頁面的 DOM 裡，你綁定的那個網頁上的指令碼就讀得到。',
    lim_b2: '<b>被入侵的瀏覽器或電腦。</b>能讀取行程記憶體、瀏覽器設定檔或密碼庫工作階段的人，就能拿到密碼。',
    lim_b3: '<b>同一個瀏覽器上的其他工具。</b>另一個連到該瀏覽器的工具，可以讀到已填好的欄位。',
    lim_b4: '<b>遮蔽只能盡力而為。</b>會轉換密碼內容的網頁可以繞過它。',
    lim_link: '閱讀 SECURITY.md',
    faq_h: '常見問題',
    q1: '模型會看到我的密碼嗎？',
    a1: '透過 blindfill 不會：沒有任何指令、工具或函式會回傳 Secret 等級的值。不過密碼填入後確實存在於頁面的 DOM 中，連到同一個瀏覽器的其他工具也讀得到它。如果你在意這點，就不要在同一個工作階段另外給代理人不受限的瀏覽器工具。',
    q2: '它讀得到我的一次性驗證碼嗎？',
    a2: '目前的 6 位數驗證碼可以像文字一樣讀取與填寫，TOTP 種子則絕不回傳。它的安全性取決於網站來源綁定，以及驗證碼本身很快失效。',
    q3: '支援哪些密碼管理員？',
    a3: 'Bitwarden／Vaultwarden（透過 <code>bw</code>）是唯一以模擬環境驗證過的後端。1Password、rbw、pass、gopass、KeePassXC 與 Secret Service 都是依文件撰寫、尚未驗證。<code>blindfill backend selftest &lt;id&gt;</code> 會用假項目跑一次完整流程，歡迎回報結果。',
    q4: '支援哪些瀏覽器？',
    a4: 'Chromium 受支援且已測試。Firefox／Camoufox 需手動啟用：透過本機 Playwright 伺服器，在 Camoufox 158.0.1-beta.41 與 159.0-beta.43 上測試過。Ego Lite 只能以另外啟動、空白設定檔的實例使用。不支援 WebKit。',
    q5: '手機和 passkey 呢？',
    a5: 'Android 尚未實作（只是空殼）。Passkey 僅限 Chromium 上的網頁登入，只針對模擬的依賴方測試過：不回寫計數器，也不支援註冊。',
    q6: '可以直接用在我的正式帳號上嗎？',
    a6: '它是 alpha 軟體，沒有經過獨立審查。建議先用拋棄式或影響不大的帳號試用，並讀過上面的威脅模型。',
    q7: '要付費嗎？授權是什麼？',
    a7: '免費，以 MIT 授權開源。',
    ins_h: '給你的代理人一個漏不出去的登入',
    ins_p:
      '套件還沒有發佈到 npm（那邊的 <code>latest</code> 只是空的佔位套件），所以請不要執行 <code>npx blindfill</code>。請從原始碼建置。',
    copy: '複製',
    ins_note:
      '需要 Node 20 以上；目前唯一以模擬環境驗證過的後端需要 Bitwarden CLI（<code>bw</code>）。步驟依照 README 的「Try it」。',
    aria_primary: '主要導覽',
    aria_lang: '語言',
    aria_theme: '切換深色／淺色主題',
    aria_term: '終端機示範紀錄',
    aria_src: '從原始碼建置的指令',
    aria_facts: '重點摘要',
    d_title: 'blindfill 登入流程',
    d_desc:
      '代理人請 blindfill 在某個網址上填入某個項目。blindfill 從密碼庫讀出密碼，把項目的網址與瀏覽器回報的網站來源比對，再把密碼填進頁面欄位。代理人只收到結果。',
    d_desc_t:
      '代理人請 blindfill 在某個網址上填入某個項目。blindfill 從密碼庫讀出密碼，檢查網站來源，再把密碼填進頁面欄位。代理人只收到結果。',
    d_agent: '代理人／LLM',
    d_agent2: '只看得到結果',
    d_core1: '檢查網站來源',
    d_core2: '遮蔽輸出・上鎖',
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
    cta_gh2: '到 GitHub 加星或 fork',
    cta_docs: '閱讀 README',
    foot1: 'blindfill 是開源（MIT）的 alpha 專案，尚未經過獨立的資安審查。',
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
      title: 'blindfill：讓 AI 代理人登入網站，卻看不到密碼',
      desc: 'blindfill 把密碼從你的密碼庫直接填進瀏覽器欄位，模型完全拿不到。開源、MIT 授權、alpha 階段。',
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
