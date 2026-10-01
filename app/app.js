// タスクアプリの Web 試作版：画面。
// iPhone アプリで書き出したファイルを読み込み、このブラウザの localStorage に保存して編集する。
(function () {
  "use strict";
  const M = window.TaskModel;
  const tr = (key, ...args) => window.I18n.t(key, ...args);
  const STORAGE_KEY = "taskweb.data";
  const DIRTY_KEY = "taskweb.dirty";
  const FILTER_KEY = "taskweb.filter";
  const PREFS_KEY = "taskweb.prefs";
  // iPhone アプリの AppTheme と同じ 5 種類
  const THEMES = [
    { id: "pop", name: "ポップ", summary: "紫からピンクへの元気なグラデーション", colors: ["#7354FF", "#FF5EA3"] },
    { id: "navy", name: "ネイビー", summary: "紺色を基調にした落ち着いた配色", colors: ["#14254A", "#2F5BA8"] },
    { id: "mint", name: "ミント", summary: "青緑からミントへのさわやかな配色", colors: ["#0F8F84", "#3CC795"] },
    { id: "sunset", name: "サンセット", summary: "オレンジからピンクへの夕焼け色", colors: ["#F26A2E", "#F0386B"] },
    { id: "monotone", name: "モノトーン", summary: "黒とグレーのシンプルな配色", colors: ["#1F1F22", "#6B6B73"] },
  ];
  const TAG_COLOR_NAMES = {
    red: "赤", orange: "オレンジ", yellow: "黄", green: "緑", teal: "青緑", blue: "青",
    indigo: "藍", purple: "紫", pink: "ピンク", brown: "茶", gray: "グレー",
  };

  const state = {
    data: null,
    view: { name: "calendar" },
    month: firstOfMonth(Date.now()),
    selectedDay: M.startOfDay(Date.now()),
    hiddenTags: new Set(),
    showsUntagged: true,
    sideFilter: null,
    addingTask: false,
    addingOnDay: false,
    dirty: false,
    // 表示の設定（このブラウザだけ）
    prefs: { theme: "pop", showsAchievement: true },
    // 書いている途中の日記（テンプレートのままなら保存しないので、画面側で持っておく）
    diaryDraft: null,
    diarySearch: "",
    // 最後に保存したときのタスク（変更日時を付けるため、次の保存で比べる）
    snapshot: [],
    // ファイルで同期（File System Access API）
    syncHandle: null,
    sync: { kind: "off", at: null, message: "" },
    pendingRender: false,
  };

  const main = document.getElementById("main");
  const sidebar = document.getElementById("sidebar");

  // ---- 保存 ----

  function load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        state.data = M.parseBackup(saved);
        state.data.tagColors = M.assigningColors(
          state.data.tagColors,
          M.allTags(state.data.tasks),
        );
        state.snapshot = M.cloneTasks(state.data.tasks);
      }
      state.dirty = localStorage.getItem(DIRTY_KEY) === "1";
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
      if (prefs) state.prefs = { ...state.prefs, ...prefs };
      const filter = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
      if (filter) {
        state.hiddenTags = new Set(filter.hiddenTags || []);
        state.showsUntagged = filter.showsUntagged !== false;
      }
    } catch (error) {
      console.error("保存したデータを読み込めませんでした", error);
    }
  }

  /// 変更のたびに保存する（書き出すまでは「未書き出し」の印を付ける）
  function commit({ rerender = true } = {}) {
    // この画面で変えたタスク・やることに変更日時を付け、消したものの印を残す（合わせるときに新しい方を選ぶため）
    const deleted = M.stampChanges(state.snapshot, state.data.tasks);
    if (deleted.length) state.data.deleted = M.mergeTombstones(state.data.deleted, deleted);
    state.snapshot = M.cloneTasks(state.data.tasks);
    state.dirty = true;
    try {
      localStorage.setItem(STORAGE_KEY, M.serializeBackup(state.data));
      localStorage.setItem(DIRTY_KEY, "1");
    } catch (error) {
      toast(tr("ブラウザに保存できませんでした。書き出して保存してください"));
    }
    if (rerender) render();
    else updateDirtyDot();
    scheduleFileSync();
  }

  function saveFilter() {
    try {
      localStorage.setItem(
        FILTER_KEY,
        JSON.stringify({
          hiddenTags: [...state.hiddenTags],
          showsUntagged: state.showsUntagged,
        }),
      );
    } catch (_) {
      /* 絞り込みは保存できなくても困らない */
    }
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let data;
      try {
        data = M.parseBackup(String(reader.result));
      } catch (error) {
        toast(tr("読み込めませんでした。iPhone のアプリで書き出したファイルを選んでください"));
        return;
      }
      // iPhone アプリと同じく、100% のまま残っている繰り返しのやることは次の回へ進める
      data.tasks.forEach((t) => t.checklist.forEach((i) => M.settleRepeatingCompletion(i)));
      let mode = "replace";
      if (state.data && (state.data.tasks.length || state.data.diary)) {
        mode = await askImportMode(data);
        if (!mode) return;
      }
      if (mode === "merge") {
        mergeImported(data);
      } else {
        // 置き換えるときは、今あって読み込むデータにないタスク・やることを「削除した」と記録する
        const removed = state.data ? M.stampChanges(state.data.tasks, M.cloneTasks(data.tasks)) : [];
        data.deleted = M.mergeTombstones(M.mergeTombstones(data.deleted, state.data?.deleted), removed);
        // 置き換えても、受け取った完全版の印は残す
        if (isPro()) data.proUnlocked = true;
        state.data = data;
      }
      state.data.tagColors = M.assigningColors(state.data.tagColors, M.allTags(state.data.tasks));
      // 読み込んだ内容には変更日時を付け直さない（ファイルに入っている日時のまま比べる）
      state.snapshot = M.cloneTasks(state.data.tasks);
      state.view = { name: "calendar" };
      commit();
      if (mode === "replace") {
        state.dirty = false;
        try {
          localStorage.setItem(DIRTY_KEY, "0");
        } catch (_) {
          /* 印だけなので無視 */
        }
        updateDirtyDot();
      }
      const items = state.data.tasks.reduce((n, t) => n + t.checklist.length, 0);
      toast(tr(mode === "merge" ? "合わせました（タスク {0} 件・やること {1} 件）" : "読み込みました（タスク {0} 件・やること {1} 件）", state.data.tasks.length, items));
    };
    reader.readAsText(file);
  }

  /// 読み込み方を選ぶ。"merge" / "replace" / null（キャンセル）
  function askImportMode(data) {
    const dialog = document.getElementById("import-dialog");
    const items = data.tasks.reduce((n, t) => n + t.checklist.length, 0);
    dialog.querySelector("[data-summary]").textContent =
      tr("タスク {0} 件・やること {1} 件・日記 {2} 日分が入っています。", data.tasks.length, items, data.diary?.entries?.length ?? 0);
    dialog.querySelector("[data-dirty-note]").hidden = !state.dirty;
    return new Promise((resolve) => {
      dialog.onclose = () => resolve(dialog.returnValue === "merge" || dialog.returnValue === "replace" ? dialog.returnValue : null);
      dialog.returnValue = "";
      dialog.showModal();
    });
  }

  /// 今のデータと合わせる（iPhone アプリの「今のデータと合わせる」と同じ）
  /// 今のデータと合わせる（iPhone アプリの「今のデータと合わせる」と同じ）
  function mergeImported(data) {
    state.data = M.mergeData(state.data, data);
  }

  function exportFile() {
    if (!state.data) {
      toast(tr("まだデータがありません"));
      return;
    }
    const blob = new Blob([M.serializeBackup(state.data)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tr("タスクのバックアップ {0}", dayKey(Date.now()))}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    state.dirty = false;
    try {
      localStorage.setItem(DIRTY_KEY, "0");
    } catch (_) {
      /* 印だけなので無視 */
    }
    updateDirtyDot();
    toast(
      tr("書き出しました。iPhone で「データを読み込む」→「今のデータと合わせる」を選んでください"),
    );
  }

  // ---- 共通 ----

  function esc(text) {
    return String(text ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function firstOfMonth(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }

  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function time(ms) {
    return new Date(ms).toLocaleTimeString(I18n.locale(), {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function dateTime(ms) {
    const d = new Date(ms);
    return `${d.toLocaleDateString(I18n.locale(), { month: "numeric", day: "numeric" })} ${time(ms)}`;
  }

  function dayTitle(ms) {
    return new Date(ms).toLocaleDateString(I18n.locale(), {
      month: "long",
      day: "numeric",
      weekday: "long",
    });
  }

  function toLocalInput(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /// 日曜はじまりの曜日名（言語に合わせる）。style は "narrow"（日・M）や "short"
  function weekdayNames(style) {
    // 2026-01-04 は日曜日
    return Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + i).toLocaleDateString(I18n.locale(), { weekday: style }));
  }

  /// 繰り返しの表示（毎日・毎週 月・木・毎月）
  function ruleLabel(rule) {
    switch (M.ruleKind(rule)) {
      case "daily":
        return tr("毎日");
      case "monthly":
        return tr("毎月");
      case "weekly": {
        // 中国語は「每周二、四」のように短い形の方が自然（short だと「周二」になり「每周周二」と重なる）
        const names = weekdayNames(I18n.lang === "zh-Hans" ? "narrow" : "short");
        const days = [...(rule.weekly.weekdays || [])].sort((a, b) => a - b).map((w) => names[w - 1]).filter(Boolean);
        return days.length ? tr("毎週 {0}", days.join(tr("weekdaySeparator"))) : tr("毎週");
      }
      default:
        return "";
    }
  }

  /// 日記の既定の項目（選んでいる言語で作る）
  function defaultDiary() {
    return M.defaultDiary(["仕事", "開発", "プライベート", "気づき・明日やること"].map((title) => tr(title)));
  }

  function colorValue(name) {
    // 色のないタスクはテーマの色
    return name ? M.TAG_COLOR_VALUES[name] : "var(--accent)";
  }

  function findTask(id) {
    return state.data.tasks.find((t) => t.id === id);
  }

  function findItem(taskID, itemID) {
    const task = findTask(taskID);
    return task ? task.checklist.find((i) => i.id === itemID) : undefined;
  }

  function visible(task) {
    return M.isVisible(task, state.hiddenTags, state.showsUntagged);
  }

  // ---- 完全版 ----

  /// 完全版の iPhone から印を受け取っているか（同期ファイルか、書き出したファイルを読み込んだとき）
  function isPro() {
    return M.isProUnlocked(state.data);
  }

  /// 完全版の機能なら true。無料版なら完全版の案内を開いて false
  function requirePro() {
    if (isPro()) return true;
    open({ name: "pro" });
    return false;
  }

  function proView() {
    const features = [
      ["♾️", "タスクを無制限に", "無料版はタスク 3 つまでです"],
      ["📖", "日記", "その日にやったことを、テンプレートの項目ごとに書けます"],
      ["🔄", "ファイルで同期", "iPhone のアプリと同じ同期ファイルで、自動でデータを合わせます"],
      ["🎨", "カラーテーマ", "ポップのほかに 4 つのテーマを選べます"],
    ];
    return `
      <button class="back" data-action="go-calendar">‹ ${tr("カレンダー")}</button>
      <h2 class="page-title">${tr("完全版")}</h2>
      <div class="card">
        <p><strong>${tr(isPro() ? "完全版の機能を使えます" : "完全版でできること")}</strong></p>
        ${features
          .map(
            ([icon, title, detail]) => `
          <div class="setting-row" style="cursor:default;justify-content:flex-start;gap:12px">
            <span>${icon}</span>
            <span><div>${tr(title)}</div><div class="muted small-text">${tr(detail)}</div></span>
          </div>`,
          )
          .join("")}
      </div>
      ${
        isPro()
          ? ""
          : `
      <div class="section-title"><span>${tr("使えるようにするには")}</span></div>
      <div class="card">
        <p class="small-text">${tr("完全版は iPhone のアプリの「設定」→「完全版」で購入できます。購入した iPhone とファイルで同期するか、購入した iPhone で書き出したファイルを「読み込む」で読み込むと、このブラウザでも完全版の機能を使えるようになります。")}</p>
        <p class="muted small-text">${tr("購入しなくても、タスク 3 つまでとカレンダー・締め切りは無料で使えます。")}</p>
      </div>`
      }`;
  }

  function toast(message) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function updateDirtyDot() {
    document.getElementById("dirty-dot").hidden = !state.dirty;
  }

  function open(view) {
    state.view = view;
    document.body.classList.remove("sidebar-open");
    render();
    window.scrollTo(0, 0);
  }

  // ---- 描画 ----

  function render() {
    updateDirtyDot();
    // 完全版の印を受け取ったり失ったりしたら、テーマを切り替える
    applyTheme();
    renderSidebar();
    if (!state.data) {
      main.innerHTML = welcome();
      return;
    }
    if (state.view.name === "task" && findTask(state.view.taskID)) {
      main.innerHTML = taskView(findTask(state.view.taskID));
    } else if (
      state.view.name === "item" &&
      findItem(state.view.taskID, state.view.itemID)
    ) {
      main.innerHTML = itemView(
        findTask(state.view.taskID),
        findItem(state.view.taskID, state.view.itemID),
      );
    } else if (state.view.name === "settings") {
      main.innerHTML = settingsView();
    } else if (state.view.name === "pro" || (!isPro() && (state.view.name === "diary" || state.view.name === "diaryList"))) {
      state.view = { name: "pro" };
      main.innerHTML = proView();
    } else if (state.view.name === "diary") {
      main.innerHTML = diaryView(state.view.day);
    } else if (state.view.name === "diaryList") {
      main.innerHTML = diaryListView();
    } else {
      state.view = { name: "calendar" };
      main.innerHTML = calendarView();
    }
    main.querySelectorAll("textarea.autogrow").forEach(autogrow);
  }

  function welcome() {
    return `
      <div class="welcome card">
        <h2>${tr("iPhone のデータを読み込んで始めましょう")}</h2>
        <ol>
          <li>${tr("iPhone のアプリで「設定」→「データを書き出す」")}</li>
          <li>${tr("できたファイルをこのパソコンに送る（AirDrop・メール・iCloud Drive など）")}</li>
          <li>${tr("右上の「読み込む」でファイルを選ぶ")}</li>
        </ol>
        <p class="muted small-text">${tr("データはこのブラウザの中だけに保存され、どこにも送られません。")}</p>
        <button class="button" data-action="start-empty">${tr("空のデータで試す")}</button>
      </div>`;
  }

  /// 無料版で作れるタスクの残り（完全版なら出さない）
  function freeTaskNote() {
    const remaining = M.remainingFreeTasks(state.data);
    if (remaining == null) return "";
    const text = remaining === 0
      ? tr("無料版はタスク {0} つまでです。完全版で無制限に", M.FREE_TASK_LIMIT)
      : tr("無料版はタスク {0} つまで（あと {1} つ）", M.FREE_TASK_LIMIT, remaining);
    return `<button class="free-note small-text" data-action="open-pro">⭐️ ${esc(text)}</button>`;
  }

  function renderSidebar() {
    if (!state.data) {
      sidebar.innerHTML = `<p class="muted small-text">${tr("データを読み込むと、ここにタスクが並びます。")}</p>`;
      return;
    }
    const tags = M.allTags(state.data.tasks);
    const tasks = state.data.tasks.filter(
      (t) => !state.sideFilter || t.tags.includes(state.sideFilter),
    );
    const selectedID = state.view.taskID;
    sidebar.innerHTML = `
      <div class="side-nav">
        <button class="side-item ${state.view.name === "calendar" ? "selected" : ""}" data-action="go-calendar">📅 <span class="title">${tr("カレンダー")}</span></button>
        <button class="side-item ${state.view.name === "diary" || state.view.name === "diaryList" ? "selected" : ""}" data-action="open-diary-list">📖 <span class="title">${tr("日記")}</span></button>
        <button class="side-item ${state.view.name === "settings" ? "selected" : ""}" data-action="open-settings">⚙️ <span class="title">${tr("設定")}</span></button>
      </div>
      <div class="section-title">
        <span>${tr("タスク")}</span>
        <button class="icon-button" data-action="add-task" aria-label="${tr("タスクを追加")}">＋</button>
      </div>
      ${freeTaskNote()}
      ${
        state.addingTask
          ? `
        <form class="inline-form" data-form="add-task">
          <input type="text" name="title" placeholder="${tr("新しいタスクの名前")}" autofocus>
          <button class="button small primary">${tr("追加")}</button>
        </form>`
          : ""
      }
      ${
        tags.length
          ? `
        <div class="chips">
          <button class="chip ${state.sideFilter ? "off" : ""}" data-action="side-filter" data-tag="">${tr("すべて")}</button>
          ${tags.map((tag) => `<button class="chip ${state.sideFilter === tag ? "" : "off"}" style="--chip:${colorValue(M.colorForTag(state.data.tagColors, tag))}" data-action="side-filter" data-tag="${esc(tag)}">#${esc(tag)}</button>`).join("")}
        </div>`
          : ""
      }
      <div class="side-nav">
        ${
          tasks
            .map((task) => {
              const done = task.checklist.filter(M.isDone).length;
              const sub =
                task.checklist.length === 0
                  ? tr("やることなし")
                  : done === task.checklist.length
                    ? tr("全部完了 🎉")
                    : tr("{0} / {1} 完了", done, task.checklist.length);
              return `
            <button class="side-item ${task.id === selectedID ? "selected" : ""}" data-action="open-task" data-task="${task.id}">
              <span class="dot" style="background:${colorValue(M.taskColor(task, state.data.tagColors))}"></span>
              <span style="min-width:0">
                <div class="title">${esc(task.title)}</div>
                <div class="sub">${esc(sub)}${task.tags.length ? " · " + task.tags.map((t) => "#" + esc(t)).join(" ") : ""}</div>
              </span>
            </button>`;
            })
            .join("") || `<p class="muted small-text">${tr("タスクはありません")}</p>`
        }
      </div>`;
    const input = sidebar.querySelector("[data-form=add-task] input");
    if (input) input.focus();
  }

  // ---- カレンダー ----

  function calendarView() {
    const tags = M.allTags(state.data.tasks);
    return `
      <div class="card memo">
        <span class="memo-icon" aria-hidden="true">📝</span>
        <textarea class="autogrow" data-input="memo" rows="1" placeholder="${tr("メモを入力")}">${esc(state.data.memo)}</textarea>
      </div>
      ${
        tags.length
          ? `
        <div class="chips" aria-label="${tr("表示するタグ")}">
          ${tags.map((tag) => `<button class="chip ${state.hiddenTags.has(tag) ? "off" : ""}" style="--chip:${colorValue(M.colorForTag(state.data.tagColors, tag))}" data-action="toggle-tag" data-tag="${esc(tag)}">#${esc(tag)}</button>`).join("")}
          <button class="chip ${state.showsUntagged ? "" : "off"}" data-action="toggle-untagged">${tr("タグなし")}</button>
        </div>`
          : ""
      }
      ${monthCard()}
      ${dayList()}
      ${overdueList()}`;
  }

  function monthCard() {
    const month = new Date(state.month);
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = M.addDays(first.getTime(), -first.getDay());
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const gridEnd = M.addDays(last.getTime(), 7 - last.getDay());
    const entries = M.calendarEntries(
      state.data.tasks,
      gridStart,
      gridEnd,
      state.data.tagColors,
      visible,
    );
    const byDay = new Map();
    for (const e of entries) {
      const key = M.startOfDay(e.date);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    const today = M.startOfDay(Date.now());
    const cells = [];
    for (let day = gridStart; day < gridEnd; day = M.addDays(day, 1)) {
      const d = new Date(day);
      const dayEntries = (byDay.get(day) || [])
        .sort((a, b) => Number(a.isDone) - Number(b.isDone))
        .slice(0, 3);
      const classes = [
        "day",
        d.getMonth() !== month.getMonth() && "out",
        day === today && "today",
        day === state.selectedDay && "selected",
      ]
        .filter(Boolean)
        .join(" ");
      const weekdayClass =
        d.getDay() === 0 ? "sun" : d.getDay() === 6 ? "sat" : "";
      cells.push(`
        <button class="${classes}" data-action="select-day" data-day="${day}" aria-label="${esc(dayTitle(day))}">
          <span class="num ${weekdayClass}">${d.getDate()}</span>
          <span class="dots">${dayEntries.map((e) => `<span style="background:${e.isDone ? "var(--tertiary)" : colorValue(e.color)}"></span>`).join("")}</span>
        </button>`);
    }
    return `
      <div class="card">
        <div class="month-header">
          <h2>${month.toLocaleDateString(I18n.locale(), { year: "numeric", month: "long" })}</h2>
          <button class="button small" data-action="today">${tr("今日")}</button>
          <button class="icon-button" data-action="month" data-step="-1" aria-label="${tr("前の月")}">‹</button>
          <button class="icon-button" data-action="month" data-step="1" aria-label="${tr("次の月")}">›</button>
        </div>
        <div class="grid">
          ${weekdayNames("narrow").map((w, i) => `<div class="weekday ${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</div>`).join("")}
          ${cells.join("")}
        </div>
      </div>`;
  }

  function dayList() {
    const start = state.selectedDay;
    const entries = M.calendarEntries(
      state.data.tasks,
      start,
      M.addDays(start, 1),
      state.data.tagColors,
      visible,
    );
    const hidden = state.hiddenTags;
    const achievement = M.achievement(state.data.tasks, start, visible, (tag) =>
      tag == null ? state.showsUntagged : !hidden.has(tag),
    );
    return `
      <div class="section-title">
        <span>${esc(dayTitle(start))}</span>
        <button class="button small" data-action="add-on-day">＋ ${tr("この日に追加")}</button>
      </div>
      ${state.addingOnDay ? addOnDayForm() : ""}
      ${entries.length && state.prefs.showsAchievement ? achievementCard(achievement) : ""}
      ${entries.length ? entries.map((e) => entryRow(e, false)).join("") : `<div class="card empty">☀️ ${tr("この日の締め切りはありません")}</div>`}
      ${diaryCard(start)}`;
  }

  function addOnDayForm() {
    const tasks = state.data.tasks;
    const canCreateTask = M.remainingFreeTasks(state.data) !== 0;
    return `
      <form class="card" data-form="add-on-day">
        <div class="field"><label>${tr("やること")}</label><input type="text" name="title" required placeholder="${tr("やること")}" style="flex:1"></div>
        <div class="field"><label>${tr("追加先")}</label>
          <select name="task" style="flex:1">
            ${tasks.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("")}
            ${canCreateTask ? `<option value="">${tr("新しいタスク…")}</option>` : ""}
          </select>
        </div>
        ${
          canCreateTask
            ? `<div class="field"><label>${tr("新しいタスクの名前")}</label><input type="text" name="newTask" placeholder="${tr("（新しいタスクのとき）")}" style="flex:1"></div>`
            : `<p class="muted small-text">${tr("無料版はタスク {0} つまでです。今あるタスクに追加してください。", M.FREE_TASK_LIMIT)}</p>`
        }
        <div class="field"><label>${tr("時刻")}</label><input type="time" name="time" value="12:00"></div>
        <div class="field"><label><input type="checkbox" name="done"> ${tr("完了済みにする")}</label></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
          <button type="button" class="button small" data-action="cancel-add-on-day">${tr("キャンセル")}</button>
          <button class="button small primary">${tr("追加")}</button>
        </div>
      </form>`;
  }

  function overdueList() {
    const entries = M.overdueEntries(
      state.data.tasks,
      Date.now(),
      state.data.tagColors,
      visible,
    );
    if (!entries.length) return "";
    return `
      <div class="section-title overdue-title"><span>⚠️ ${tr("締め切りを過ぎたやること")}</span><span class="muted small-text">${tr("{0} 件", entries.length)}</span></div>
      ${entries.map((e) => entryRow(e, true)).join("")}`;
  }

  /// 達成度を変えられる回か。繰り返しは、次に迎える回と、それより後で今日までの回
  function canEdit(entry) {
    if (!M.isRepeating(entry.item) || entry.isCurrent) return true;
    const current = M.nextDue(entry.item);
    return (
      current != null &&
      entry.date > current &&
      entry.date < M.addDays(M.startOfDay(Date.now()), 1)
    );
  }

  function entryRow(entry, showsDate) {
    const tint = colorValue(entry.color);
    const editable = canEdit(entry);
    const progress = M.entryProgress(entry);
    const repeating = M.isRepeating(entry.item);
    const attrs = `data-task="${entry.taskID}" data-item="${entry.item.id}" data-date="${entry.date}"`;
    let check;
    if (editable) {
      check = `<button class="check ${entry.isDone ? "on" : ""}" data-action="toggle-entry" ${attrs} aria-label="${tr(entry.isDone ? "未完了に戻す" : "完了にする")}">${entry.isDone ? "✓" : ""}</button>`;
    } else if (entry.isDone) {
      check = `<span class="check on" aria-label="${tr("完了")}">✓</span>`;
    } else {
      check = `<span class="check dotted" aria-hidden="true"></span>`;
    }
    const overdue = entry.isCurrent && M.isOverdue(entry.item);
    return `
      <div class="entry ${entry.isDone ? "done" : ""}" style="--tint:${tint}" data-action="open-item" ${attrs}>
        <span class="bar"></span>
        ${check}
        <div class="body">
          <div class="title">${esc(entry.item.title || tr("名称未設定"))}</div>
          <div class="meta ${overdue ? "overdue" : ""}">
            <span>${showsDate ? dateTime(entry.date) : time(entry.date)}</span>
            ${repeating ? `<span>🔁 ${esc(ruleLabel(entry.item.repeatRule))}</span>` : ""}
            <span>${esc(entry.taskTitle)}</span>
          </div>
          ${editable && !entry.isDone && progress > 0 ? `<div class="progress-line"><div style="width:${progress}%"></div></div>` : ""}
        </div>
        ${editable ? progressSelect(progress, `data-action-change="entry-progress" ${attrs}`, entry.item.title) : ""}
        <span class="chev">›</span>
      </div>`;
  }

  function progressSelect(value, attrs, title) {
    const options = [];
    for (let v = 0; v <= 100; v += 10)
      options.push(
        `<option value="${v}" ${v === value ? "selected" : ""}>${v}%</option>`,
      );
    // 以前の 5% 刻みの値（45% など）もそのまま表示する
    if (value % 10 !== 0)
      options.push(`<option value="${value}" selected>${value}%</option>`);
    return `<select class="progress-select" ${attrs} aria-label="${esc(tr("{0}の達成度", title))}">${options.join("")}</select>`;
  }

  // ---- タスクの詳細 ----

  function taskView(task) {
    const tint = colorValue(M.taskColor(task, state.data.tagColors));
    const existing = M.allTags(state.data.tasks).filter(
      (t) => !task.tags.includes(t),
    );
    return `
      <button class="back" data-action="go-calendar">‹ ${tr("カレンダー")}</button>
      <div class="card" style="--tint:${tint}">
        <input class="title-input" data-input="task-title" data-task="${task.id}" value="${esc(task.title)}" aria-label="${tr("タスク名")}">
        <div class="chips" style="margin:8px 0 0">
          ${task.tags.map((tag) => `<span class="chip tag-chip" style="--chip:${colorValue(M.colorForTag(state.data.tagColors, tag))}">#${esc(tag)}<button data-action="remove-tag" data-task="${task.id}" data-tag="${esc(tag)}" aria-label="${esc(tr("タグ「{0}」を外す", tag))}">✕</button></span>`).join("")}
          <form class="inline-form" data-form="add-tag" data-task="${task.id}" style="margin:0">
            <input type="text" name="tag" list="tag-list" placeholder="${tr("タグを追加")}" style="width:130px">
            <datalist id="tag-list">${existing.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
          </form>
        </div>
      </div>
      <div class="section-title"><span>${tr("メモ")}</span></div>
      <div class="card"><textarea class="autogrow" data-input="task-memo" data-task="${task.id}" rows="2" placeholder="${tr("タップしてメモを入力")}">${esc(task.memo)}</textarea></div>
      <div class="section-title"><span>${tr("やることリスト")}</span><span class="muted small-text">${tr("上ほど優先度が高くなります")}</span></div>
      <div class="card" style="--tint:${tint}">
        ${task.checklist.map((item, index) => checklistRow(task, item, index)).join("") || `<p class="muted small-text">${tr("やることはまだありません")}</p>`}
        <form class="inline-form" data-form="add-item" data-task="${task.id}">
          <input type="text" name="title" placeholder="${tr("やることを追加")}">
          <button class="button small primary">${tr("追加")}</button>
        </form>
      </div>
      <button class="button danger" data-action="delete-task" data-task="${task.id}">${tr("タスクを削除")}</button>`;
  }

  function checklistRow(task, item, index) {
    const due = M.nextDue(item);
    const attrs = `data-task="${task.id}" data-item="${item.id}"`;
    return `
      <div class="checklist-row">
        <span class="muted small-text" style="width:18px;text-align:center">${index + 1}</span>
        <button class="check ${M.isDone(item) ? "on" : ""}" data-action="toggle-item" ${attrs} aria-label="${tr(M.isDone(item) ? "未完了に戻す" : "完了にする")}">${M.isDone(item) ? "✓" : ""}</button>
        <input class="name" data-input="item-title" ${attrs} value="${esc(item.title)}" placeholder="${tr("やること")}" style="${M.isDone(item) ? "text-decoration:line-through;opacity:.55" : ""}">
        ${due != null ? `<span class="when ${M.isOverdue(item) ? "overdue" : ""}">${M.isRepeating(item) ? "🔁 " : ""}${dateTime(due)}</span>` : ""}
        ${progressSelect(item.progress, `data-action-change="item-progress" ${attrs}`, item.title)}
        <span class="row-buttons">
          <button data-action="move-item" data-step="-1" ${attrs} aria-label="${tr("上へ")}" ${index === 0 ? "disabled" : ""}>↑</button>
          <button data-action="move-item" data-step="1" ${attrs} aria-label="${tr("下へ")}" ${index === task.checklist.length - 1 ? "disabled" : ""}>↓</button>
          <button data-action="open-item" ${attrs} aria-label="${tr("達成度・締め切り・メモを編集")}">›</button>
        </span>
      </div>`;
  }

  // ---- やることの詳細 ----

  function itemView(task, item) {
    const tint = colorValue(M.taskColor(task, state.data.tagColors));
    const attrs = `data-task="${task.id}" data-item="${item.id}"`;
    const kind = M.ruleKind(item.repeatRule);
    const next = M.nextDue(item);
    const weekdays =
      kind === "weekly" ? item.repeatRule.weekly.weekdays || [] : [];
    const backTarget =
      state.view.from === "task"
        ? `data-action="open-task" data-task="${task.id}"`
        : `data-action="go-calendar"`;
    return `
      <button class="back" ${backTarget}>‹ ${state.view.from === "task" ? esc(task.title) : tr("カレンダー")}</button>
      <div class="card" style="--accent:${tint}">
        <input class="title-input" data-input="item-title" ${attrs} value="${esc(item.title)}" placeholder="${tr("やること")}" aria-label="${tr("やること")}">
        <div class="muted small-text">${esc(task.title)}</div>
      </div>
      <div class="section-title"><span>${tr("達成度")}</span>${M.isRepeating(item) ? `<span class="muted small-text">${tr("100% で今回分を完了")}</span>` : ""}</div>
      <div class="card" style="--accent:${tint}">
        <div class="big-percent" id="percent-label">${item.progress}%</div>
        <input type="range" min="0" max="100" step="10" value="${item.progress}" data-range="item-progress" ${attrs} aria-label="${tr("達成度")}">
        <div class="ticks">${[0, 20, 40, 60, 80, 100].map((v) => `<span>${v}</span>`).join("")}</div>
      </div>
      <div class="section-title"><span>${tr("締め切り")}</span></div>
      <div class="card" style="--accent:${tint}">
        <div class="field"><label><input type="checkbox" data-action-change="toggle-deadline" ${attrs} ${item.deadline != null ? "checked" : ""}> ${tr("締め切りを設定")}</label></div>
        ${
          item.deadline != null
            ? `
          <div class="field"><label>${tr("日時")}</label><input type="datetime-local" data-action-change="deadline" ${attrs} value="${toLocalInput(item.deadline)}"></div>
          <div class="field"><label>${tr("繰り返し")}</label>
            <select data-action-change="repeat" ${attrs}>
              ${[
                ["", tr("しない")],
                ["daily", tr("毎日")],
                ["weekly", tr("毎週")],
                ["monthly", tr("毎月")],
              ]
                .map(
                  ([v, l]) =>
                    `<option value="${v}" ${v === (kind || "") ? "selected" : ""}>${l}</option>`,
                )
                .join("")}
            </select>
          </div>
          ${kind === "weekly" ? `<div class="field"><div class="weekdays">${weekdayNames("narrow").map((w, i) => `<button class="${weekdays.includes(i + 1) ? "on" : ""}" data-action="weekday" data-weekday="${i + 1}" ${attrs}>${w}</button>`).join("")}</div></div>` : ""}
          ${kind && next != null ? `<div class="field muted small-text">🔁 ${tr("次回: {0}（{1}）", dateTime(next), esc(ruleLabel(item.repeatRule)))}</div>` : ""}
          ${M.isOverdue(item) ? `<div class="field" style="color:var(--red)">${tr("締め切りを過ぎています")}</div>` : ""}`
            : ""
        }
        <p class="muted small-text">${tr("過去の日時も選べます。")}</p>
      </div>
      <div class="section-title"><span>${tr("メモ")}</span></div>
      <div class="card"><textarea class="autogrow" data-input="item-memo" ${attrs} rows="4" placeholder="${tr("タップしてメモを入力")}">${esc(item.memo)}</textarea></div>
      <button class="button danger" data-action="delete-item" ${attrs}>${tr("このやることを削除")}</button>`;
  }

  function autogrow(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + 2 + "px";
  }

  // ---- 達成度・日記のカード ----

  function achievementCard(a) {
    return `
      <div class="card achievement">
        <div class="ring" style="--p:${a.percent}" role="img" aria-label="${tr("この日の達成度")} ${a.percent}%"><span>${a.percent}%</span></div>
        <div class="achievement-body">
          <div class="achievement-title">${tr("この日の達成度")}</div>
          <div class="muted small-text">${tr("{0} / {1} 完了", a.done, a.total)}</div>
          ${a.byTag
            .map((t) => {
              const color = t.tag == null ? "var(--tertiary)" : colorValue(M.colorForTag(state.data.tagColors, t.tag));
              return `
              <div class="tag-bar">
                <span class="tag-name" style="color:${color}">${t.tag == null ? tr("タグなし") : "#" + esc(t.tag)}</span>
                <span class="bar-track"><span style="width:${t.percent}%;background:${color}"></span></span>
                <span class="tag-percent">${t.percent}%</span>
                <span class="muted small-text">${t.done}/${t.total}</span>
              </div>`;
            })
            .join("")}
        </div>
      </div>`;
  }

  function diaryCard(day) {
    const entry = M.diaryEntry(state.data.diary, M.dayKey(day));
    const preview = !isPro()
      ? tr("日記は完全版で書けます")
      : entry ? M.diaryPreview(entry) : tr("その日にやったことを、テンプレートの項目ごとに書けます");
    return `
      <button class="card diary-card" data-action="open-diary" data-day="${M.dayKey(day)}">
        <span class="memo-icon">${!isPro() ? "🔒" : entry ? "📖" : "✏️"}</span>
        <span style="flex:1;min-width:0;text-align:left">
          <div class="achievement-title">${tr(entry ? "日記" : "日記を書く")}</div>
          <div class="muted small-text preview">${esc(preview)}</div>
        </span>
        <span class="chev">›</span>
      </button>`;
  }

  // ---- 日記 ----

  function diaryView(day) {
    if (!state.diaryDraft || state.diaryDraft.day !== day) {
      state.diaryDraft = M.diaryEntryOrNew(state.data.diary || defaultDiary(), day);
    }
    const entry = state.diaryDraft;
    const date = M.dateForDayKey(day);
    const completed = M.completedItems(state.data.tasks, date);
    return `
      <button class="back" data-action="open-diary-list">‹ ${tr("日記の一覧")}</button>
      <div class="day-nav">
        <button class="icon-button" data-action="diary-day" data-step="-1" aria-label="${tr("前の日")}">‹</button>
        <h2>${esc(tr("{0}の日記", dayTitle(date)))}</h2>
        <button class="icon-button" data-action="diary-day" data-step="1" aria-label="${tr("次の日")}">›</button>
      </div>
      ${entry.sections
        .map(
          (section) => `
        <div class="section-title"><span>${esc(section.title)}</span></div>
        <div class="card"><textarea class="autogrow" data-input="diary-text" data-section="${section.id}" rows="3" placeholder="${esc(tr("タップして{0}のことを書く", section.title))}">${esc(section.text)}</textarea></div>`,
        )
        .join("")}
      ${
        completed.length
          ? `
        <div class="section-title"><span>${tr("この日に完了したやること")}</span></div>
        <div class="card">
          ${completed.map((c) => `<div class="small-text" style="padding:3px 0">✅ ${esc(c.itemTitle)} <span class="muted">（${esc(c.taskTitle)}）</span></div>`).join("")}
          <div class="muted small-text" style="margin-top:10px">${tr("完了したやることを日記に追記")}</div>
          <div class="chips" style="margin:6px 0 0">
            ${entry.sections.map((s) => `<button class="button small" data-action="diary-append" data-section="${s.id}">${esc(tr("「{0}」に追記", s.title))}</button>`).join("")}
          </div>
        </div>`
          : ""
      }`;
  }

  function diaryListView() {
    const query = state.diarySearch.trim();
    const entries = [...(state.data.diary?.entries || [])]
      .reverse()
      .filter((e) => !query || e.sections.some((s) => (s.text || "").includes(query) || s.title.includes(query)));
    return `
      <button class="back" data-action="go-calendar">‹ ${tr("カレンダー")}</button>
      <div class="section-title"><span style="font-size:22px">${tr("日記")}</span>
        <button class="button small primary" data-action="open-diary" data-day="${M.dayKey(Date.now())}">${tr("今日の日記を書く")}</button>
      </div>
      <input type="search" class="search" data-input="diary-search" value="${esc(state.diarySearch)}" placeholder="${tr("日記を検索")}">
      ${
        entries.length
          ? entries
              .map(
                (e) => `
        <button class="card diary-card" data-action="open-diary" data-day="${e.day}">
          <span style="flex:1;min-width:0;text-align:left">
            <div class="achievement-title">${esc(dayTitle(M.dateForDayKey(e.day)))}</div>
            <div class="muted small-text preview">${esc(M.diaryPreview(e))}</div>
          </span>
          <span class="chev">›</span>
        </button>`,
              )
              .join("")
          : `<div class="card empty">${tr(query ? "見つかりません" : "日記はまだありません。カレンダーで日付を選んで書くこともできます。")}</div>`
      }`;
  }

  function saveDiaryDraft() {
    if (!state.data.diary) state.data.diary = defaultDiary();
    M.updateDiary(state.data, state.diaryDraft);
    commit({ rerender: false });
  }

  // ---- 設定 ----

  /// 言語を決め、index.html の固定の文言（data-i18n）を訳す。元の日本語はキーとして覚えておく
  function applyLanguage() {
    I18n.setLang(state.prefs.lang || "auto");
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      if (!el.dataset.i18nKey) el.dataset.i18nKey = el.textContent.trim();
      el.textContent = tr(el.dataset.i18nKey);
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      const attr = el.dataset.i18nAttr;
      if (!el.dataset.i18nAttrKey) el.dataset.i18nAttrKey = el.getAttribute(attr);
      el.setAttribute(attr, tr(el.dataset.i18nAttrKey));
    });
  }

  function applyTheme() {
    // 無料版はポップだけ（選んだテーマは覚えておき、完全版になったら使う）
    document.documentElement.dataset.theme = isPro() ? state.prefs.theme : "pop";
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    } catch (_) {
      /* 表示の設定は保存できなくても困らない */
    }
    applyTheme();
  }

  function settingsView() {
    const tags = M.allTags(state.data.tasks);
    const template = state.data.diary?.template || defaultDiary().template;
    const currentTheme = isPro() ? state.prefs.theme : "pop";
    return `
      <button class="back" data-action="go-calendar">‹ ${tr("カレンダー")}</button>
      <h2 class="page-title">${tr("設定")}</h2>

      <div class="card">
        <button class="setting-row" data-action="help"><span>❓ ${tr("使い方・ヘルプ")}</span><span class="chev">›</span></button>
        <button class="setting-row" data-action="open-pro"><span>⭐️ ${tr("完全版")}</span><span class="muted">${tr(isPro() ? "使えます" : "未購入")} ›</span></button>
      </div>

      <div class="section-title"><span>${tr("言語")}</span></div>
      <div class="card">
        <label class="setting-row"><span>🌐 ${tr("言語")}</span>
          <select data-setting="lang">
            ${[["auto", tr("ブラウザに合わせる")], ...I18n.LANGUAGES.map((l) => [l.id, l.name])]
              .map(([id, name]) => `<option value="${id}" ${(state.prefs.lang || "auto") === id ? "selected" : ""}>${esc(name)}</option>`)
              .join("")}
          </select>
        </label>
      </div>

      <div class="section-title"><span>${tr("表示")}</span></div>
      <div class="card">
        <label class="setting-row"><span>${tr("カレンダーに達成度を表示")}</span>
          <input type="checkbox" class="switch" data-setting="showsAchievement" ${state.prefs.showsAchievement ? "checked" : ""}>
        </label>
        <p class="muted small-text">${tr("選んだ日の締め切りについて、全体とタグごとの達成度を表示します。")}</p>
      </div>

      ${
        tags.length
          ? `
        <div class="section-title"><span>${tr("タグの色")}</span></div>
        <div class="card">
          ${tags
            .map((tag) => {
              const current = state.data.tagColors[tag];
              return `
            <div class="tag-color-row">
              <span class="tag-name" style="color:${colorValue(M.colorForTag(state.data.tagColors, tag))}">#${esc(tag)}</span>
              <span class="swatches">
                ${M.TAG_COLORS.map((c) => `<button class="swatch ${current === c ? "on" : ""}" style="background:${M.TAG_COLOR_VALUES[c]}" data-action="tag-color" data-tag="${esc(tag)}" data-color="${c}" aria-label="${tr(TAG_COLOR_NAMES[c])}" title="${tr(TAG_COLOR_NAMES[c])}"></button>`).join("")}
              </span>
            </div>`;
            })
            .join("")}
        </div>`
          : ""
      }

      ${isPro() ? diaryTemplateSettings(template) : `
      <div class="section-title"><span>${tr("日記のテンプレート")}</span></div>
      <div class="card">
        <button class="setting-row" data-action="open-pro"><span>🔒 ${tr("日記は完全版で書けます")}</span><span class="chev">›</span></button>
      </div>`}

      <div class="section-title"><span>${tr("ファイルで同期（iPhone と共有）")}</span></div>

      <div class="card">
        ${fileSyncSettings()}
      </div>

      <div class="section-title"><span>${tr("データ")}</span></div>
      <div class="card">
        <button class="setting-row" data-action="import"><span>📥 ${tr("データを読み込む")}</span><span class="chev">›</span></button>
        <button class="setting-row" data-action="export"><span>📤 ${tr("データを書き出す")}</span><span class="chev">›</span></button>
        <button class="setting-row danger-text" data-action="reset-data"><span>🗑 ${tr("このブラウザのデータを消す")}</span><span class="chev">›</span></button>
        <p class="muted small-text">${tr("データはこのブラウザの中だけに保存されています。iPhone に反映するには「書き出す」でファイルに保存し、iPhone のアプリで「データを読み込む」→「今のデータと合わせる」を選んでください。")}</p>
      </div>

      <div class="section-title"><span>${tr("カラーテーマ")}</span></div>
      <div class="card">
        ${THEMES.map(
          (t) => `
          <button class="theme-row ${currentTheme === t.id ? "on" : ""}" data-action="set-theme" data-theme="${t.id}">
            <span class="theme-sample" style="background:linear-gradient(135deg, ${t.colors[0]}, ${t.colors[1]})">✨</span>
            <span style="flex:1;text-align:left">
              <div class="theme-name" style="color:${t.colors[0]}">${tr(t.name)}</div>
              <div class="muted small-text">${tr(t.summary)}</div>
            </span>
            <span class="theme-check">${!isPro() && t.id !== "pop" ? "🔒" : currentTheme === t.id ? "✓" : ""}</span>
          </button>`,
        ).join("")}
        <p class="muted small-text">${tr("色を付けていないタスクや、画面全体の色が変わります（このブラウザだけの設定です）。")}${isPro() ? "" : " " + tr("ポップ以外のテーマは完全版で選べます。")}</p>
      </div>`;
  }

  function diaryTemplateSettings(template) {
    return `
      <div class="section-title"><span>${tr("日記のテンプレート")}</span>
        <button class="button small" data-action="template-add">＋ ${tr("項目を追加")}</button>
      </div>
      <div class="card">
        ${template
          .map(
            (t, i) => `
          <div class="template-row">
            <div style="display:flex;gap:6px;align-items:center">
              <input type="text" data-input="template-title" data-index="${i}" value="${esc(t.title)}" placeholder="${tr("項目名（例: 仕事）")}" style="flex:1;font-weight:600">
              <span class="row-buttons">
                <button data-action="template-move" data-index="${i}" data-step="-1" aria-label="${tr("上へ")}" ${i === 0 ? "disabled" : ""}>↑</button>
                <button data-action="template-move" data-index="${i}" data-step="1" aria-label="${tr("下へ")}" ${i === template.length - 1 ? "disabled" : ""}>↓</button>
                <button data-action="template-remove" data-index="${i}" aria-label="${tr("この項目を削除")}">✕</button>
              </span>
            </div>
            <textarea class="autogrow" data-input="template-text" data-index="${i}" rows="1" placeholder="${tr("最初から書いておく文（任意）")}">${esc(t.text || "")}</textarea>
          </div>`,
          )
          .join("")}
        <p class="muted small-text">${tr("新しく書く日の日記に、この項目が並びます。すでに書いた日記は変わりません。")}</p>
      </div>`;
  }

  function fileSyncSettings() {
    if (!canSyncFile) {
      return `<p class="small-text">${tr("このブラウザでは使えません。Chrome か Edge で開いてください（Safari・Firefox では「読み込む」「書き出す」で受け渡しできます）。")}</p>`;
    }
    const { kind, at, message } = state.sync;
    const proNote = isPro() ? "" : `<p class="small-text">🔒 ${tr("同期は完全版の機能です。完全版を購入した iPhone のアプリで「フォルダで同期」を使い、そのファイルを選んでください")}</p>`;
    if (!state.syncHandle) {
      return `${proNote}
        <button class="setting-row" data-action="choose-sync-file"><span>📂 ${tr("同期するファイルを選ぶ")}</span><span class="chev">›</span></button>
        <button class="setting-row" data-action="create-sync-file"><span>🆕 ${tr("同期ファイルを新しく作る")}</span><span class="chev">›</span></button>
        <p class="muted small-text">${tr("iPhone のアプリの「設定」→「フォルダで同期」で選んだフォルダ（iCloud Drive・Google ドライブ・OneDrive）を、パソコンでも各サービスのアプリで同期しておき、その中の「{0}」を選んでください。以後は、開いたとき・編集したとき・30 秒ごとに自動で合わせます。まだファイルがなければ「新しく作る」で、同期フォルダの中に作ってください。", SYNC_FILE_NAME)}</p>`;
    }
    const statusText =
      kind === "syncing" ? tr("同期しています…")
        : kind === "synced" ? tr("同期済み（{0}）", time(at))
          : kind === "needsPermission" ? tr("ファイルへのアクセスの許可が必要です")
            : kind === "failed" ? message : tr("まだ同期していません");
    return `
      <div class="setting-row" style="cursor:default"><span>${tr("ファイル")}</span><span class="muted">${esc(state.syncHandle.name)}</span></div>
      <p class="small-text ${kind === "failed" ? "danger-text" : "muted"}">${esc(statusText)}</p>
      ${kind === "needsPermission" || kind === "failed"
        ? `<button class="setting-row" data-action="resume-sync"><span>🔓 ${tr("アクセスを許可して同期を再開")}</span><span class="chev">›</span></button>`
        : `<button class="setting-row" data-action="sync-now"><span>🔄 ${tr("今すぐ同期")}</span><span class="chev">›</span></button>`}
      <button class="setting-row" data-action="choose-sync-file"><span>📂 ${tr("別のファイルを選ぶ")}</span><span class="chev">›</span></button>
      <button class="setting-row danger-text" data-action="stop-sync"><span>${tr("ファイルでの同期をやめる")}</span><span class="chev">›</span></button>`;
  }

  /// 日記のテンプレートを書き換える（日記がまだなければ作る）
  function editTemplate(change, { rerender = true } = {}) {
    if (!state.data.diary) state.data.diary = defaultDiary();
    change(state.data.diary.template);
    commit({ rerender });
  }

  // ---- 操作 ----

  function datasetItem(el) {
    return findItem(el.dataset.task, el.dataset.item);
  }

  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    if (!el) return;
    // 行の中の選択肢（達成度）を押したときに、行を開かないようにする
    if (
      event.target.closest("select, input, textarea") &&
      el.dataset.action === "open-item"
    )
      return;
    const action = el.dataset.action;
    switch (action) {
      case "toggle-sidebar":
        document.body.classList.toggle("sidebar-open");
        break;
      case "go-calendar":
        open({ name: "calendar" });
        break;
      case "help":
        document.getElementById("help-dialog").showModal();
        break;
      case "export":
        exportFile();
        break;
      case "start-empty":
        state.data = M.emptyData();
        commit();
        break;
      case "add-task":
        if (!state.addingTask && M.remainingFreeTasks(state.data) === 0) {
          open({ name: "pro" });
          break;
        }
        state.addingTask = !state.addingTask;
        renderSidebar();
        break;
      case "side-filter":
        state.sideFilter = el.dataset.tag || null;
        renderSidebar();
        break;
      case "open-task":
        open({ name: "task", taskID: el.dataset.task });
        break;
      case "open-item":
        event.stopPropagation();
        open({
          name: "item",
          taskID: el.dataset.task,
          itemID: el.dataset.item,
          from: state.view.name === "task" ? "task" : "calendar",
        });
        break;
      case "toggle-tag":
        if (state.hiddenTags.has(el.dataset.tag))
          state.hiddenTags.delete(el.dataset.tag);
        else state.hiddenTags.add(el.dataset.tag);
        saveFilter();
        render();
        break;
      case "toggle-untagged":
        state.showsUntagged = !state.showsUntagged;
        saveFilter();
        render();
        break;
      case "select-day":
        state.selectedDay = Number(el.dataset.day);
        if (firstOfMonth(state.selectedDay) !== state.month)
          state.month = firstOfMonth(state.selectedDay);
        render();
        break;
      case "today":
        state.month = firstOfMonth(Date.now());
        state.selectedDay = M.startOfDay(Date.now());
        render();
        break;
      case "month": {
        const d = new Date(state.month);
        state.month = new Date(
          d.getFullYear(),
          d.getMonth() + Number(el.dataset.step),
          1,
        ).getTime();
        render();
        break;
      }
      case "add-on-day":
        state.addingOnDay = !state.addingOnDay;
        render();
        if (state.addingOnDay)
          main
            .querySelector("[data-form=add-on-day] input[name=title]")
            .focus();
        break;
      case "cancel-add-on-day":
        state.addingOnDay = false;
        render();
        break;
      case "toggle-entry": {
        event.stopPropagation();
        const item = datasetItem(el);
        if (!item) break;
        const date = Number(el.dataset.date);
        // 繰り返しは、その回だけを完了・未完了にする（今の回を完了にすると次の回へ進む）
        if (M.isRepeating(item))
          M.setProgressForOccurrence(
            item,
            M.isOccurrenceDone(item, date) ? 0 : 100,
            date,
          );
        else M.setDone(item, !M.isDone(item));
        commit();
        break;
      }
      case "toggle-item": {
        const item = datasetItem(el);
        if (!item) break;
        M.setDone(item, !M.isDone(item));
        commit();
        break;
      }
      case "move-item": {
        const task = findTask(el.dataset.task);
        const index = task.checklist.findIndex((i) => i.id === el.dataset.item);
        const target = index + Number(el.dataset.step);
        if (index < 0 || target < 0 || target >= task.checklist.length) break;
        const [item] = task.checklist.splice(index, 1);
        task.checklist.splice(target, 0, item);
        commit();
        break;
      }
      case "remove-tag": {
        const task = findTask(el.dataset.task);
        task.tags = task.tags.filter((t) => t !== el.dataset.tag);
        commit();
        break;
      }
      case "weekday": {
        const item = datasetItem(el);
        const weekday = Number(el.dataset.weekday);
        const days = new Set(item.repeatRule.weekly.weekdays || []);
        if (days.has(weekday)) days.delete(weekday);
        else days.add(weekday);
        item.repeatRule = M.makeRule("weekly", [...days].sort());
        commit();
        break;
      }
      case "delete-task": {
        const task = findTask(el.dataset.task);
        if (
          !confirm(
            tr("「{0}」を削除しますか？この操作は取り消せません。", task.title),
          )
        )
          break;
        state.data.tasks = state.data.tasks.filter((t) => t.id !== task.id);
        state.view = { name: "calendar" };
        commit();
        break;
      }
      case "delete-item": {
        const task = findTask(el.dataset.task);
        const item = datasetItem(el);
        if (!confirm(tr("「{0}」を削除しますか？", item.title || tr("名称未設定"))))
          break;
        task.checklist = task.checklist.filter((i) => i.id !== item.id);
        state.view = { name: "task", taskID: task.id };
        commit();
        break;
      }
    }
  });

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (el.id === "file-input") {
      if (el.files[0]) importFile(el.files[0]);
      el.value = "";
      return;
    }
    const action = el.dataset.actionChange;
    if (el.dataset.range === "item-progress") {
      // 指を離したとき：繰り返しのやることは 100% で今回分を完了にする
      const item = datasetItem(el);
      if (M.isRepeating(item) && item.progress === 100) M.setDone(item, true);
      commit();
      return;
    }
    if (!action) return;
    const item = datasetItem(el);
    switch (action) {
      case "entry-progress":
        M.setProgressForOccurrence(
          item,
          Number(el.value),
          Number(el.dataset.date),
        );
        break;
      case "item-progress":
        M.setProgressForOccurrence(
          item,
          Number(el.value),
          M.nextDue(item) ?? 0,
        );
        break;
      case "toggle-deadline":
        if (el.checked) {
          const d = new Date(state.selectedDay);
          d.setHours(12, 0, 0, 0);
          item.deadline = d.getTime();
        } else {
          delete item.deadline;
          delete item.repeatRule;
        }
        break;
      case "deadline": {
        const ms = new Date(el.value).getTime();
        if (!Number.isNaN(ms)) item.deadline = ms;
        M.settleRepeatingCompletion(item);
        break;
      }
      case "repeat":
        item.repeatRule = M.makeRule(
          el.value,
          el.value === "weekly"
            ? [new Date(item.deadline).getDay() + 1]
            : undefined,
        );
        if (!item.repeatRule) delete item.repeatRule;
        // 100% のやることに繰り返しを付けたら、今回分を完了にして 0% に戻す
        M.settleRepeatingCompletion(item);
        break;
    }
    commit();
  });

  document.addEventListener("input", (event) => {
    const el = event.target;
    if (el.dataset.range === "item-progress") {
      const item = datasetItem(el);
      M.updateProgress(item, Number(el.value));
      document.getElementById("percent-label").textContent =
        `${item.progress}%`;
      return;
    }
    const kind = el.dataset.input;
    if (!kind) return;
    if (el.tagName === "TEXTAREA") autogrow(el);
    // 入力中は画面を描き直さない（カーソルが飛ばないように）
    switch (kind) {
      case "memo":
        state.data.memo = el.value;
        // 書き換えた日時も残す（同期で新しい方を選ぶため）
        state.data.memoUpdatedAt = Date.now();
        break;
      case "task-title":
        findTask(el.dataset.task).title = el.value;
        break;
      case "task-memo":
        findTask(el.dataset.task).memo = el.value;
        break;
      case "item-title":
        datasetItem(el).title = el.value;
        break;
      case "item-memo":
        datasetItem(el).memo = el.value;
        break;
    }
    commit({ rerender: false });
    if (kind === "task-title") renderSidebar();
  });

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-form]");
    if (!form) return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    switch (form.dataset.form) {
      case "add-task": {
        const title = (values.title || "").trim();
        if (!title) return;
        if (M.remainingFreeTasks(state.data) === 0) {
          state.addingTask = false;
          open({ name: "pro" });
          return;
        }
        const task = M.newTask(title);
        state.data.tasks.push(task);
        state.addingTask = false;
        state.view = { name: "task", taskID: task.id };
        break;
      }
      case "add-item": {
        const title = (values.title || "").trim();
        if (!title) return;
        findTask(form.dataset.task).checklist.push(M.newItem(title));
        break;
      }
      case "add-tag": {
        const tag = M.normalizedTag(values.tag || "");
        const task = findTask(form.dataset.task);
        if (!tag || task.tags.includes(tag)) return;
        task.tags.push(tag);
        state.data.tagColors = M.assigningColors(
          state.data.tagColors,
          M.allTags(state.data.tasks),
        );
        break;
      }
      case "add-on-day": {
        const title = (values.title || "").trim();
        if (!title) return;
        const [h, m] = (values.time || "12:00").split(":").map(Number);
        const deadline = new Date(state.selectedDay);
        deadline.setHours(h || 0, m || 0, 0, 0);
        const item = M.newItem(title, deadline.getTime());
        if (values.done) {
          M.updateProgress(item, 100);
          // 後から記録するときは、締め切りの日時に完了したことにする
          if (deadline.getTime() < Date.now())
            item.completions[item.completions.length - 1].completedAt =
              deadline.getTime();
        }
        let task = values.task ? findTask(values.task) : null;
        if (!task && M.remainingFreeTasks(state.data) === 0) {
          open({ name: "pro" });
          return;
        }
        if (!task) {
          task = M.newTask((values.newTask || "").trim() || tr("新しいタスク"));
          state.data.tasks.push(task);
        }
        task.checklist.push(item);
        state.addingOnDay = false;
        break;
      }
    }
    commit();
  });

  // ---- 設定・日記の操作 ----

  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    if (!el) return;
    switch (el.dataset.action) {
      case "open-settings":
        open({ name: "settings" });
        break;
      case "open-pro":
        open({ name: "pro" });
        break;
      case "open-diary-list":
        if (!requirePro()) break;
        open({ name: "diaryList" });
        break;
      case "open-diary":
        if (!requirePro()) break;
        state.diaryDraft = null;
        open({ name: "diary", day: el.dataset.day });
        break;
      case "diary-day": {
        const next = M.addDays(M.dateForDayKey(state.view.day), Number(el.dataset.step));
        state.diaryDraft = null;
        open({ name: "diary", day: M.dayKey(next) });
        break;
      }
      case "diary-append": {
        const section = state.diaryDraft.sections.find((s) => s.id === el.dataset.section);
        const completed = M.completedItems(state.data.tasks, M.dateForDayKey(state.view.day));
        for (const c of completed) M.appendLine(section, `・${c.itemTitle}（${c.taskTitle}）`);
        M.updateDiary(state.data, state.diaryDraft);
        commit();
        toast(tr("「{0}」に追記しました", section.title));
        break;
      }
      case "set-theme":
        if (el.dataset.theme !== "pop" && !requirePro()) break;
        state.prefs.theme = el.dataset.theme;
        savePrefs();
        render();
        break;
      case "tag-color": {
        const { tag, color } = el.dataset;
        state.data.tagColors = { ...state.data.tagColors, [tag]: color };
        commit();
        break;
      }
      case "template-add":
        editTemplate((t) => t.push({ id: M.uuid(), title: tr("新しい項目"), text: "" }));
        break;
      case "template-remove": {
        const index = Number(el.dataset.index);
        const title = state.data.diary?.template?.[index]?.title ?? "";
        if (!confirm(tr("「{0}」を削除しますか？", title))) break;
        editTemplate((t) => t.splice(index, 1));
        break;
      }
      case "template-move": {
        const index = Number(el.dataset.index);
        const target = index + Number(el.dataset.step);
        editTemplate((t) => {
          if (target < 0 || target >= t.length) return;
          const [section] = t.splice(index, 1);
          t.splice(target, 0, section);
        });
        break;
      }
      case "import":
        document.getElementById("file-input").click();
        break;
      case "reset-data": {
        const message = state.dirty
          ? tr("書き出していない変更があります。このブラウザのデータを消すと元に戻せません。消しますか？")
          : tr("このブラウザに保存したデータを消します（iPhone のデータは消えません）。消しますか？");
        if (!confirm(message)) break;
        try {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(DIRTY_KEY);
        } catch (_) {
          /* 消せなくても画面は空にする */
        }
        state.data = null;
        state.dirty = false;
        open({ name: "calendar" });
        break;
      }
    }
  });

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (el.dataset.setting === "lang") {
      state.prefs.lang = el.value;
      savePrefs();
      applyLanguage();
      render();
    }
    if (el.dataset.setting === "showsAchievement") {
      state.prefs.showsAchievement = el.checked;
      savePrefs();
    }
  });

  document.addEventListener("input", (event) => {
    const el = event.target;
    switch (el.dataset.input) {
      case "diary-text": {
        const section = state.diaryDraft.sections.find((s) => s.id === el.dataset.section);
        section.text = el.value;
        saveDiaryDraft();
        break;
      }
      case "diary-search": {
        state.diarySearch = el.value;
        const position = el.selectionStart;
        render();
        const input = main.querySelector("[data-input=diary-search]");
        input.focus();
        input.setSelectionRange(position, position);
        break;
      }
      case "template-title":
        editTemplate((t) => (t[Number(el.dataset.index)].title = el.value), { rerender: false });
        break;
      case "template-text":
        editTemplate((t) => (t[Number(el.dataset.index)].text = el.value), { rerender: false });
        break;
    }
  });

  // ---- ファイルで同期 ----
  // iPhone アプリが同期フォルダに置く task-app-sync.json を、File System Access API（Chrome・Edge）で読み書きする。
  // 選んだファイルは IndexedDB に覚えておき、次に開いたときも使う

  const SYNC_FILE_NAME = "task-app-sync.json";
  const canSyncFile = typeof window.showOpenFilePicker === "function";
  let syncTimer = null;

  function idb(mode, action) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("taskweb", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction("kv", mode);
        const result = action(tx.objectStore("kv"));
        tx.oncomplete = () => resolve(result.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  function setSyncStatus(kind, message) {
    state.sync = { ...state.sync, kind, message, at: kind === "synced" ? Date.now() : state.sync.at };
    renderSyncStatus();
    if (state.view.name === "settings" && !isEditing()) render();
  }

  function isEditing() {
    const el = document.activeElement;
    return !!el && main.contains(el) && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type !== "checkbox" && el.type !== "range"));
  }

  function renderSyncStatus() {
    const el = document.getElementById("sync-status");
    if (!el) return;
    const { kind, at, message } = state.sync;
    el.hidden = kind === "off";
    el.className = `sync-status ${kind}`;
    el.dataset.action = kind === "needsPermission" || kind === "failed" ? "resume-sync" : "sync-now";
    el.title = message || "";
    el.textContent =
      kind === "syncing" ? `☁︎ ${tr("同期中…")}`
        : kind === "synced" ? `☁︎ ${tr("{0} 同期済み", time(at))}`
          : kind === "needsPermission" ? `☁︎ ${tr("同期を再開")}`
            : kind === "failed" ? `⚠︎ ${tr("同期できません")}` : "";
  }

  async function restoreSyncFile() {
    if (!canSyncFile) return;
    try {
      const handle = await idb("readonly", (store) => store.get("syncFile"));
      if (!handle || typeof handle.getFile !== "function") return;
      const permission = await handle.queryPermission({ mode: "readwrite" });
      state.syncHandle = handle;
      if (permission === "granted") await syncNow();
      else setSyncStatus("needsPermission", tr("ボタンを押すと、ファイルへのアクセスを許可して同期を再開します"));
    } catch (error) {
      console.error("同期ファイルを復元できませんでした", error);
    }
  }

  async function useSyncFile(handle) {
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      toast(tr("ファイルへの書き込みが許可されませんでした"));
      return;
    }
    state.syncHandle = handle;
    try {
      await idb("readwrite", (store) => store.put(handle, "syncFile"));
    } catch (error) {
      // 覚えられなくても、今の画面では同期できる（次に開いたときにもう一度選ぶ）
      console.warn("同期ファイルを覚えられませんでした", error);
    }
    await syncNow();
  }

  const jsonTypes = () => [{ description: tr("同期ファイル（JSON）"), accept: { "application/json": [".json"] } }];

  async function chooseSyncFile() {
    try {
      const [handle] = await window.showOpenFilePicker({ types: jsonTypes() });
      await useSyncFile(handle);
    } catch (error) {
      if (error.name !== "AbortError") toast(tr("ファイルを選べませんでした（{0}）", error.message));
    }
  }

  async function createSyncFile() {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: SYNC_FILE_NAME, types: jsonTypes() });
      await useSyncFile(handle);
    } catch (error) {
      if (error.name !== "AbortError") toast(tr("ファイルを作れませんでした（{0}）", error.message));
    }
  }

  async function stopFileSync() {
    state.syncHandle = null;
    try {
      await idb("readwrite", (store) => store.delete("syncFile"));
    } catch (_) {
      /* 覚えたファイルを消せなくても、今の画面では同期しない */
    }
    setSyncStatus("off");
    render();
  }

  function scheduleFileSync() {
    if (!state.syncHandle || state.sync.kind === "needsPermission") return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 2000);
  }

  /// ファイルを読み、今のデータと合わせ、変わっていれば書き戻す
  async function syncNow() {
    const handle = state.syncHandle;
    if (!handle) return;
    if (state.sync.kind === "syncing") {
      // 同期中に頼まれた分は、終わってからもう一度同期する
      state.syncAgain = true;
      return;
    }
    state.syncAgain = false;
    setSyncStatus("syncing");
    try {
      const text = await (await handle.getFile()).text();
      let remote = null;
      if (text.trim()) {
        try {
          remote = M.parseBackup(text);
        } catch (_) {
          // 読めないファイルは上書きしない（ほかのファイルを選んだときに消さないため）
          setSyncStatus("failed", tr("選んだファイルの中身を読めません。iPhone のアプリが作った task-app-sync.json を選んでください"));
          return;
        }
        remote.tasks.forEach((t) => t.checklist.forEach((i) => M.settleRepeatingCompletion(i)));
      }
      // 同期は完全版の機能。完全版の iPhone が書いた印のあるファイルなら、このブラウザでも使えるようになる
      if (!isPro() && !M.isProUnlocked(remote)) {
        setSyncStatus("failed", tr("同期は完全版の機能です。完全版を購入した iPhone のアプリで「フォルダで同期」を使い、そのファイルを選んでください"));
        return;
      }
      // ファイルを読んでいる間の編集も含めて合わせる（ここから書き込むまで、ほかの処理は割り込まない）
      const previous = state.data;
      const merged = state.data ? (remote ? M.mergeData(state.data, remote) : state.data) : remote || M.emptyData();
      merged.tagColors = M.assigningColors(merged.tagColors, M.allTags(merged.tasks));
      state.data = merged;
      // 合わせた内容には変更日時を付け直さない
      state.snapshot = M.cloneTasks(merged.tasks);
      try {
        localStorage.setItem(STORAGE_KEY, M.serializeBackup(merged));
      } catch (_) {
        /* ファイルには書くので続ける */
      }
      if (!remote || !M.sameContent(merged, remote)) {
        const writable = await handle.createWritable();
        await writable.write(M.serializeBackup(merged));
        await writable.close();
      }
      state.dirty = false;
      try {
        localStorage.setItem(DIRTY_KEY, "0");
      } catch (_) {
        /* 印だけなので無視 */
      }
      setSyncStatus("synced");
      if (!previous || !M.sameContent(previous, merged)) {
        // 入力中は描き直さない（カーソルが飛ばないように）。入力欄を離れたときに描き直す
        if (isEditing()) state.pendingRender = true;
        else render();
      }
    } catch (error) {
      if (error.name === "NotAllowedError") setSyncStatus("needsPermission", tr("ボタンを押すと、ファイルへのアクセスを許可して同期を再開します"));
      else setSyncStatus("failed", tr("同期できませんでした（{0}）", error.message));
    }
    if (state.syncAgain || state.syncHandle !== handle) {
      state.syncAgain = false;
      if (state.syncHandle) setTimeout(syncNow, 0);
    }
  }

  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (state.pendingRender && !isEditing()) {
        state.pendingRender = false;
        render();
      }
    }, 0);
  });

  // 画面に戻ったとき・30 秒ごとに、パソコンの同期アプリが更新したファイルを読みにいく
  window.addEventListener("focus", () => state.syncHandle && state.sync.kind !== "needsPermission" && syncNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.syncHandle && state.sync.kind !== "needsPermission") syncNow();
  });
  setInterval(() => {
    if (document.visibilityState === "visible" && state.syncHandle && state.sync.kind === "synced") syncNow();
  }, 30000);

  document.addEventListener("click", async (event) => {
    const el = event.target.closest("[data-action]");
    if (!el) return;
    switch (el.dataset.action) {
      case "choose-sync-file":
        await chooseSyncFile();
        break;
      case "create-sync-file":
        await createSyncFile();
        break;
      case "resume-sync":
        if (state.syncHandle) await useSyncFile(state.syncHandle);
        break;
      case "sync-now":
        await syncNow();
        break;
      case "stop-sync":
        if (confirm(tr("ファイルでの同期をやめますか？（ファイルとこのブラウザのデータは消えません）"))) await stopFileSync();
        break;
    }
  });

  // 別のタブで編集したときは、そちらの内容を取り込む
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    load();
    render();
  });

  load();
  applyLanguage();
  applyTheme();
  render();
  restoreSyncFile();
})();
