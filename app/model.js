// タスクアプリの Web 試作版：データの読み書きと、締め切り・繰り返しの計算。
// iPhone アプリの Shared/TaskItem.swift・Schedule.swift・Achievement.swift と同じ動きにしている。
// 日時は内部ではミリ秒（epoch）で持ち、書き出すときに iPhone アプリが読める ISO 8601 に戻す。
(function (root) {
  "use strict";

  // Swift の Date(timeIntervalSinceReferenceDate:) の基準（2001-01-01）
  const REFERENCE_DATE_OFFSET = 978307200;
  const DAY = 86400000;

  // ---- 読み込み・書き出し ----

  /// 書き出したファイル（AppBackup）か、アプリの保存ファイル（tasks.json）を読み込む
  function parseBackup(text) {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      // tasks.json は日時を 2001 年からの秒数で保存している
      return {
        version: 1,
        tasks: json.map((t) => importTask(t, fromReferenceSeconds)),
        diary: null,
        tagColors: {},
        memo: "",
        deleted: [],
      };
    }
    if (!json || !Array.isArray(json.tasks)) {
      throw new Error("タスクのデータが見つかりません");
    }
    return {
      ...json,
      tasks: json.tasks.map((t) => importTask(t, fromISO)),
      diary: json.diary ?? null,
      tagColors: json.tagColors ?? {},
      memo: json.memo ?? "",
      memoUpdatedAt: fromISO(json.memoUpdatedAt),
      deleted: (json.deleted ?? [])
        .map((t) => ({ id: t.id, deletedAt: fromISO(t.deletedAt) }))
        .filter((t) => t.deletedAt != null),
    };
  }

  /// iPhone アプリの「データを読み込む」で読める JSON にする
  function serializeBackup(data, now = Date.now()) {
    const out = {
      ...data,
      version: data.version ?? 1,
      exportedAt: toISO(now),
      tasks: data.tasks.map(exportTask),
      tagColors: data.tagColors ?? {},
      memo: data.memo ?? "",
      deleted: (data.deleted ?? []).map((t) => ({ id: t.id, deletedAt: toISO(t.deletedAt) })),
      memoUpdatedAt: data.memoUpdatedAt == null ? undefined : toISO(data.memoUpdatedAt),
    };
    if (out.diary == null) delete out.diary;
    return JSON.stringify(out, null, 2);
  }

  function fromReferenceSeconds(value) {
    return typeof value === "number"
      ? Math.round((value + REFERENCE_DATE_OFFSET) * 1000)
      : undefined;
  }

  function fromISO(value) {
    if (typeof value === "number") return fromReferenceSeconds(value);
    if (typeof value !== "string") return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }

  /// Swift の JSONDecoder（.iso8601）は小数の秒を読めないので、秒までにする
  function toISO(ms) {
    return new Date(Math.floor(ms / 1000) * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  }

  // 知らない項目もそのまま残して書き出す（iPhone アプリで増えた項目を消さないため）
  function importTask(task, date) {
    return {
      ...task,
      createdAt: date(task.createdAt) ?? Date.now(),
      memo: task.memo ?? "",
      tags: task.tags ?? [],
      checklist: (task.checklist ?? []).map((item) => importItem(item, date)),
      updatedAt: date(task.updatedAt),
    };
  }

  function importItem(item, date) {
    const result = {
      ...item,
      progress: item.progress ?? (item.isDone ? 100 : 0),
      memo: item.memo ?? "",
      completions: (item.completions ?? []).map((c) => ({
        ...c,
        completedAt: date(c.completedAt),
        due: date(c.due),
      })),
      occurrenceProgress: (item.occurrenceProgress ?? []).map((p) => ({
        ...p,
        due: date(p.due),
      })),
    };
    delete result.isDone;
    result.updatedAt = date(item.updatedAt);
    const deadline = date(item.deadline);
    if (deadline == null) delete result.deadline;
    else result.deadline = deadline;
    return result;
  }

  function exportTask(task) {
    return {
      ...task,
      createdAt: toISO(task.createdAt),
      checklist: task.checklist.map(exportItem),
      updatedAt: task.updatedAt == null ? undefined : toISO(task.updatedAt),
    };
  }

  function exportItem(item) {
    const result = {
      ...item,
      completions: item.completions.map((c) => {
        const record = { ...c, completedAt: toISO(c.completedAt) };
        if (c.due == null) delete record.due;
        else record.due = toISO(c.due);
        return record;
      }),
    };
    if (item.deadline == null) delete result.deadline;
    else result.deadline = toISO(item.deadline);
    if (!item.repeatRule) delete result.repeatRule;
    if (item.updatedAt == null) delete result.updatedAt;
    else result.updatedAt = toISO(item.updatedAt);
    if (item.occurrenceProgress && item.occurrenceProgress.length) {
      result.occurrenceProgress = item.occurrenceProgress.map((p) => ({
        ...p,
        due: toISO(p.due),
      }));
    } else {
      delete result.occurrenceProgress;
    }
    return result;
  }

  // ---- 新しいデータ ----

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === "function")
      return root.crypto.randomUUID().toUpperCase();
    const bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
  }

  function newTask(title) {
    return {
      id: uuid(),
      title,
      createdAt: Date.now(),
      memo: "",
      checklist: [],
      tags: [],
    };
  }

  function newItem(title, deadline) {
    const item = {
      id: uuid(),
      title,
      progress: 0,
      memo: "",
      completions: [],
      occurrenceProgress: [],
    };
    if (deadline != null) item.deadline = deadline;
    return item;
  }

  function emptyData() {
    return { version: 1, tasks: [], diary: null, tagColors: {}, memo: "", deleted: [] };
  }

  // ---- 繰り返し ----

  /// {"daily":{}} / {"weekly":{"weekdays":[2,5]}} / {"monthly":{}}（Swift の RepeatRule の JSON）
  function ruleKind(rule) {
    if (!rule) return null;
    if (rule.daily) return "daily";
    if (rule.weekly) return "weekly";
    if (rule.monthly) return "monthly";
    return null;
  }

  function makeRule(kind, weekdays) {
    switch (kind) {
      case "daily":
        return { daily: {} };
      case "weekly":
        return { weekly: { weekdays: weekdays ?? [] } };
      case "monthly":
        return { monthly: {} };
      default:
        return null;
    }
  }

  function addDays(ms, days) {
    const d = new Date(ms);
    d.setDate(d.getDate() + days);
    return d.getTime();
  }

  /// Calendar.date(byAdding: .month) と同じく、月末を超える日は月末に丸める（1/31 → 2/28）
  function addMonths(ms, months) {
    const d = new Date(ms);
    const day = d.getDate();
    const target = new Date(
      d.getFullYear(),
      d.getMonth() + months,
      1,
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
      d.getMilliseconds(),
    );
    const lastDay = new Date(
      target.getFullYear(),
      target.getMonth() + 1,
      0,
    ).getDate();
    target.setDate(Math.min(day, lastDay));
    return target.getTime();
  }

  /// 曜日は Calendar の weekday（1 = 日曜 … 7 = 土曜）
  function weekday(ms) {
    return new Date(ms).getDay() + 1;
  }

  function ruleDate(rule, step, anchor) {
    switch (ruleKind(rule)) {
      case "daily":
        return addDays(anchor, step);
      case "monthly":
        return addMonths(anchor, step);
      case "weekly": {
        const date = addDays(anchor, step);
        const days = rule.weekly.weekdays ?? [];
        const targets = days.length ? days : [weekday(anchor)];
        return targets.includes(weekday(date)) ? date : null;
      }
      default:
        return null;
    }
  }

  /// `start` 以降、`end` より前の発生日時
  function occurrences(rule, anchor, start, end) {
    const result = [];
    for (let step = 0; step < 4000; step++) {
      const date = ruleDate(rule, step, anchor);
      if (date == null) continue;
      if (date >= end) break;
      if (date >= start) result.push(date);
    }
    return result;
  }

  function nextOccurrence(rule, after, anchor) {
    for (let step = 0; step < 4000; step++) {
      const date = ruleDate(rule, step, anchor);
      if (date != null && date > after) return date;
    }
    return null;
  }

  const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

  function ruleLabel(rule) {
    switch (ruleKind(rule)) {
      case "daily":
        return "毎日";
      case "monthly":
        return "毎月";
      case "weekly": {
        const names = [...(rule.weekly.weekdays ?? [])]
          .sort((a, b) => a - b)
          .map((w) => WEEKDAY_NAMES[w - 1])
          .filter(Boolean);
        return names.length ? `毎週 ${names.join("・")}` : "毎週";
      }
      default:
        return "";
    }
  }

  // ---- やること ----

  function isRepeating(item) {
    return !!ruleKind(item.repeatRule) && item.deadline != null;
  }

  function isDone(item) {
    return item.progress === 100;
  }

  /// 次に迎える締め切り。繰り返しなら、締め切り以降で最初の発生日時
  function nextDue(item) {
    if (item.deadline == null) return null;
    if (!ruleKind(item.repeatRule)) return item.deadline;
    // Infinity まで数えると 4000 回分を作ってしまうので、最初の 1 回だけ探す
    const first = nextOccurrence(
      item.repeatRule,
      item.deadline - 1,
      item.deadline,
    );
    return first ?? item.deadline;
  }

  function isOverdue(item, now = Date.now()) {
    const due = nextDue(item);
    return due != null && !isDone(item) && due < now;
  }

  /// 達成度を変え、完了した・完了を取り消したときは記録を更新する（繰り返しは記録しない）
  function updateProgress(item, value, now = Date.now()) {
    const wasDone = isDone(item);
    item.progress = value;
    if (isRepeating(item)) return;
    if (!wasDone && isDone(item)) {
      item.completions.push({ completedAt: now, due: item.deadline });
    } else if (wasDone && !isDone(item) && item.completions.length) {
      item.completions.pop();
    }
  }

  /// isDone の setter と同じ。繰り返しは完了にすると次の回へ進む
  function setDone(item, done, now = Date.now()) {
    if (done) {
      if (isRepeating(item)) advanceToNextOccurrence(item, now);
      else updateProgress(item, 100, now);
    } else if (item.progress === 100) {
      updateProgress(item, 0, now);
    }
  }

  function advanceToNextOccurrence(item, now = Date.now()) {
    const due = nextDue(item);
    if (!ruleKind(item.repeatRule) || item.deadline == null || due == null)
      return;
    const anchor = item.deadline;
    item.completions.push({ completedAt: now, due });
    // 先に完了にしておいた回（今日の回など）は飛ばす
    const completed = new Set(
      item.completions.map((c) => c.due).filter((d) => d != null),
    );
    let next = nextOccurrence(item.repeatRule, due, anchor);
    while (next != null && completed.has(next)) {
      next = nextOccurrence(item.repeatRule, next, anchor);
    }
    if (next != null) item.deadline = next;
    const carried = (item.occurrenceProgress ?? []).find(
      (p) => p.due === item.deadline,
    );
    item.progress = carried ? carried.progress : 0;
    item.occurrenceProgress = (item.occurrenceProgress ?? []).filter(
      (p) => p.due > item.deadline,
    );
  }

  function settleRepeatingCompletion(item, now = Date.now()) {
    if (isRepeating(item) && item.progress >= 100)
      advanceToNextOccurrence(item, now);
  }

  function isOccurrenceDone(item, due) {
    return item.completions.some((c) => c.due === due);
  }

  function progressForOccurrence(item, due) {
    if (!isRepeating(item) || due === nextDue(item)) return item.progress;
    if (isOccurrenceDone(item, due)) return 100;
    const partial = (item.occurrenceProgress ?? []).find((p) => p.due === due);
    return partial ? partial.progress : 0;
  }

  /// 今の回なら今までどおり（100% で次の回へ）。それより後の回は、その回だけを記録する
  function setProgressForOccurrence(item, value, due, now = Date.now()) {
    if (!isRepeating(item) || due === nextDue(item)) {
      updateProgress(item, value, now);
      if (isRepeating(item) && value >= 100) setDone(item, true, now);
      return;
    }
    item.occurrenceProgress = (item.occurrenceProgress ?? []).filter(
      (p) => p.due !== due,
    );
    if (value >= 100) {
      if (!isOccurrenceDone(item, due))
        item.completions.push({ completedAt: now, due });
    } else {
      item.completions = item.completions.filter((c) => c.due !== due);
      if (value > 0) item.occurrenceProgress.push({ due, progress: value });
    }
  }

  // ---- カレンダー ----

  /// 期間内の締め切り（日時順）。繰り返しは期間内のすべての回と、完了済みの回を含む
  function calendarEntries(
    tasks,
    start,
    end,
    tagColors = {},
    isIncluded = () => true,
  ) {
    const entries = [];
    for (const task of tasks) {
      if (!isIncluded(task)) continue;
      const color = taskColor(task, tagColors);
      for (const item of task.checklist) {
        if (item.deadline == null) continue;
        const current = nextDue(item);
        const entry = (date, done) => ({
          taskID: task.id,
          taskTitle: task.title,
          color,
          item,
          date,
          isCurrent: !done && date === current,
          isDone: done,
        });
        if (!ruleKind(item.repeatRule) || current == null) {
          if (item.deadline >= start && item.deadline < end)
            entries.push(entry(item.deadline, isDone(item)));
          continue;
        }
        const done = item.completions
          .map((c) => c.due)
          .filter((d) => d != null && d >= start && d < end);
        const doneSet = new Set(done);
        for (const d of done) entries.push(entry(d, true));
        for (const d of occurrences(
          item.repeatRule,
          item.deadline,
          Math.max(start, current),
          end,
        )) {
          if (!doneSet.has(d)) entries.push(entry(d, false));
        }
      }
    }
    return entries.sort((a, b) => a.date - b.date);
  }

  /// 締め切りを過ぎた未完了のやること（古い順）。繰り返しは 1 番古い回だけ
  function overdueEntries(
    tasks,
    now = Date.now(),
    tagColors = {},
    isIncluded = () => true,
  ) {
    const entries = [];
    for (const task of tasks) {
      if (!isIncluded(task)) continue;
      for (const item of task.checklist) {
        const due = nextDue(item);
        if (isDone(item) || due == null || due >= now) continue;
        entries.push({
          taskID: task.id,
          taskTitle: task.title,
          color: taskColor(task, tagColors),
          item,
          date: due,
          isCurrent: true,
          isDone: false,
        });
      }
    }
    return entries.sort((a, b) => a.date - b.date);
  }

  function entryProgress(entry) {
    return entry.isDone ? 100 : progressForOccurrence(entry.item, entry.date);
  }

  /// その日の達成度（全体）
  /// その日の達成度。全体と、タグごと（タグ名順、タグなしは最後）。
  /// `includesTag` で表示しないタグを除く（null はタグなし）。タグを複数付けたタスクは、それぞれのタグに数える
  function achievement(tasks, day, isIncluded = () => true, includesTag = () => true) {
    const start = startOfDay(day);
    const entries = calendarEntries(tasks, start, addDays(start, 1), {}, isIncluded);
    const tagsByTask = new Map(tasks.map((t) => [t.id, t.tags]));
    const make = () => ({ total: 0, done: 0, sum: 0 });
    const add = (a, e) => {
      a.total += 1;
      if (e.isDone) a.done += 1;
      a.sum += entryProgress(e);
    };
    const overall = make();
    const byTag = new Map();
    const untagged = make();
    for (const e of entries) {
      add(overall, e);
      const tags = tagsByTask.get(e.taskID) || [];
      if (tags.length === 0) {
        if (includesTag(null)) add(untagged, e);
      } else {
        for (const tag of tags) {
          if (!includesTag(tag)) continue;
          if (!byTag.has(tag)) byTag.set(tag, make());
          add(byTag.get(tag), e);
        }
      }
    }
    const finish = (a) => ({ total: a.total, done: a.done, percent: a.total ? Math.round(a.sum / a.total) : 0 });
    const tagResults = [...byTag.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "ja", { numeric: true }))
      .map(([tag, a]) => ({ tag, ...finish(a) }));
    if (untagged.total > 0) tagResults.push({ tag: null, ...finish(untagged) });
    return { ...finish(overall), byTag: tagResults };
  }

  // ---- 同期・読み込みでデータを合わせる（SyncMerge.swift と同じ） ----

  const TOMBSTONE_RETENTION_DAYS = 180;

  /// キーの順番に左右されない比較用の文字列（変更日時は除く）
  function contentKey(value) {
    const normalize = (v) => {
      if (Array.isArray(v)) return v.map(normalize);
      if (v && typeof v === "object") {
        const out = {};
        for (const key of Object.keys(v).sort()) {
          if (key === "updatedAt" || v[key] === undefined) continue;
          out[key] = normalize(v[key]);
        }
        return out;
      }
      return v;
    };
    return JSON.stringify(normalize(value));
  }

  function taskFieldsKey(task) {
    return contentKey({ ...task, checklist: task.checklist.map((i) => i.id) });
  }

  function cloneTasks(tasks) {
    return JSON.parse(JSON.stringify(tasks));
  }

  /// 画面で変えた部分に変更日時を付け（tasks を書き換える）、消したタスク・やることの印を返す
  function stampChanges(oldTasks, tasks, now = Date.now()) {
    const before = new Map(oldTasks.map((t) => [t.id, t]));
    const deleted = [];
    const ids = new Set(tasks.map((t) => t.id));
    for (const t of oldTasks) if (!ids.has(t.id)) deleted.push({ id: t.id, deletedAt: now });
    for (const task of tasks) {
      const previous = before.get(task.id);
      if (!previous) {
        if (task.updatedAt == null) task.updatedAt = now;
        for (const item of task.checklist) if (item.updatedAt == null) item.updatedAt = now;
        continue;
      }
      if (task.updatedAt === previous.updatedAt && taskFieldsKey(task) !== taskFieldsKey(previous)) task.updatedAt = now;
      const oldItems = new Map(previous.checklist.map((i) => [i.id, i]));
      const itemIDs = new Set(task.checklist.map((i) => i.id));
      for (const i of previous.checklist) if (!itemIDs.has(i.id)) deleted.push({ id: i.id, deletedAt: now });
      for (const item of task.checklist) {
        const old = oldItems.get(item.id);
        if (old) {
          if (item.updatedAt === old.updatedAt && contentKey(item) !== contentKey(old)) item.updatedAt = now;
        } else if (item.updatedAt == null) {
          item.updatedAt = now;
        }
      }
    }
    return deleted;
  }

  function mergeTombstones(a, b, now = Date.now()) {
    const limit = now - TOMBSTONE_RETENTION_DAYS * DAY;
    const dates = new Map();
    for (const t of [...(a || []), ...(b || [])]) {
      if (!dates.has(t.id) || dates.get(t.id) < t.deletedAt) dates.set(t.id, t.deletedAt);
    }
    return [...dates.entries()]
      .filter(([, d]) => d >= limit)
      .map(([id, deletedAt]) => ({ id, deletedAt }))
      .sort((x, y) => x.deletedAt - y.deletedAt);
  }

  function latestChange(task) {
    const dates = [task.updatedAt, ...task.checklist.map((i) => i.updatedAt)].filter((d) => d != null);
    return dates.length ? Math.max(...dates) : null;
  }

  /// 同じタスク・やることは変更日時が新しい方（同じなら自分）。片方にしかないものは残すが、あとで消した印があれば消す
  function syncMerged(local, remote, tombstones) {
    const deletedAt = new Map();
    for (const t of tombstones || []) if (!deletedAt.has(t.id) || deletedAt.get(t.id) < t.deletedAt) deletedAt.set(t.id, t.deletedAt);
    const isDeleted = (id, updatedAt) => deletedAt.has(id) && deletedAt.get(id) >= (updatedAt ?? -Infinity);
    const newer = (a, b) => (b.updatedAt ?? -Infinity) > (a.updatedAt ?? -Infinity);
    const remoteTasks = new Map(remote.map((t) => [t.id, t]));
    const result = [];
    for (const l of local) {
      const r = remoteTasks.get(l.id);
      if (!r) {
        if (!isDeleted(l.id, latestChange(l))) result.push(l);
        continue;
      }
      const remoteIsNewer = newer(l, r);
      const base = remoteIsNewer ? r : l;
      const other = remoteIsNewer ? l : r;
      const localItems = new Map(l.checklist.map((i) => [i.id, i]));
      const remoteItems = new Map(r.checklist.map((i) => [i.id, i]));
      const pick = (id) => {
        const a = localItems.get(id);
        const b = remoteItems.get(id);
        if (a && b) return newer(a, b) ? b : a;
        const only = a || b;
        return only && !isDeleted(id, only.updatedAt) ? only : null;
      };
      const baseIDs = base.checklist.map((i) => i.id);
      const order = [...baseIDs, ...other.checklist.map((i) => i.id).filter((id) => !baseIDs.includes(id))];
      result.push({ ...base, checklist: order.map(pick).filter(Boolean) });
    }
    const localIDs = new Set(local.map((t) => t.id));
    for (const t of remote) {
      if (localIDs.has(t.id) || isDeleted(t.id, latestChange(t))) continue;
      result.push({ ...t, checklist: t.checklist.filter((i) => !isDeleted(i.id, i.updatedAt)) });
    }
    return result;
  }

  /// メモを合わせる。どちらにも日時があれば新しい方、なければ両方の文章を残す（MainMemo.merged と同じ）
  function mergeMemo(mine, mineAt, theirs, theirsAt) {
    if (mineAt != null && theirsAt != null) return theirsAt > mineAt ? [theirs, theirsAt] : [mine, mineAt];
    const a = (mine || "").trim();
    const b = (theirs || "").trim();
    const at = [mineAt, theirsAt].filter((d) => d != null);
    const date = at.length ? Math.max(...at) : undefined;
    if (!b || a.includes(b)) return [mine || "", date];
    if (!a || b.includes(a)) return [theirs, date];
    return [`${mine}\n${theirs}`, date];
  }

  /// データ全体を合わせる（AppBackup.merged と同じ）。タスクは新しい方、日記は同じ日なら新しく書いた方、
  /// タグの色は自分を優先、メモは新しい方
  function mergeData(local, remote) {
    const deleted = mergeTombstones(local.deleted, remote.deleted);
    const [memo, memoUpdatedAt] = mergeMemo(local.memo, local.memoUpdatedAt, remote.memo, remote.memoUpdatedAt);
    let diary = local.diary;
    if (remote.diary) {
      if (!diary) diary = remote.diary;
      else {
        const byDay = new Map((diary.entries || []).map((e) => [e.day, e]));
        for (const entry of remote.diary.entries || []) {
          const mine = byDay.get(entry.day);
          if (!mine || Date.parse(entry.updatedAt || 0) > Date.parse(mine.updatedAt || 0)) byDay.set(entry.day, entry);
        }
        diary = { ...diary, entries: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)) };
      }
    }
    return {
      ...local,
      tasks: syncMerged(local.tasks, remote.tasks, deleted),
      deleted,
      tagColors: { ...(remote.tagColors || {}), ...(local.tagColors || {}) },
      memo,
      memoUpdatedAt,
      diary,
      // どちらかに完全版の印があれば残す（AppBackup.merged と同じ）
      proUnlocked: local.proUnlocked === true || remote.proUnlocked === true ? true : undefined,
    };
  }

  // ---- 完全版（iPhone アプリの ProAccess と同じ） ----

  /// 無料版で作れるタスクの数
  const FREE_TASK_LIMIT = 3;

  /// 完全版の iPhone が同期ファイルや書き出したファイルに書いた印があるか
  function isProUnlocked(data) {
    return !!data && data.proUnlocked === true;
  }

  /// 無料版で、あといくつタスクを作れるか（完全版なら null）
  function remainingFreeTasks(data) {
    if (isProUnlocked(data)) return null;
    return Math.max(0, FREE_TASK_LIMIT - (data?.tasks?.length ?? 0));
  }

  /// 書き出したときに同じ中身になるか（書き出した日時は比べない）
  function sameContent(a, b) {
    const strip = (text) => {
      const json = JSON.parse(text);
      delete json.exportedAt;
      return contentKeyWithDates(json);
    };
    return strip(serializeBackup(a)) === strip(serializeBackup(b));
  }

  function contentKeyWithDates(value) {
    const normalize = (v) => {
      if (Array.isArray(v)) return v.map(normalize);
      if (v && typeof v === "object") {
        const out = {};
        for (const key of Object.keys(v).sort()) if (v[key] !== undefined) out[key] = normalize(v[key]);
        return out;
      }
      return v;
    };
    return JSON.stringify(normalize(value));
  }

  // ---- 日記（Diary.swift と同じ） ----

  const DEFAULT_DIARY_SECTIONS = ["仕事", "開発", "プライベート", "気づき・明日やること"];

  function defaultDiary(titles = DEFAULT_DIARY_SECTIONS) {
    return { template: titles.map((title) => ({ id: uuid(), title, text: "" })), entries: [] };
  }

  /// yyyy-MM-dd（ローカルの日付）
  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function dateForDayKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  }

  function diaryEntry(diary, day) {
    return (diary?.entries || []).find((e) => e.day === day);
  }

  /// その日の日記。まだ書いていなければテンプレートから作る（保存はしない）
  function diaryEntryOrNew(diary, day) {
    const existing = diaryEntry(diary, day);
    if (existing) return JSON.parse(JSON.stringify(existing));
    const template = diary?.template || defaultDiary().template;
    return { id: uuid(), day, sections: template.map((t) => ({ id: uuid(), title: t.title, text: t.text || "" })) };
  }

  /// テンプレートのままで、何も書き足していないか
  function isDiaryBlank(entry, template) {
    const presets = new Map();
    for (const t of template) if (!presets.has(t.title)) presets.set(t.title, (t.text || "").trim());
    return entry.sections.every((s) => {
      const text = (s.text || "").trim();
      return text === "" || text === presets.get(s.title);
    });
  }

  /// 日記を書き換える。何も書かれていなければ残さない（日記がまだなければ作る）
  function updateDiary(data, entry, now = Date.now()) {
    if (!data.diary) data.diary = defaultDiary();
    const diary = data.diary;
    diary.entries = diary.entries || [];
    const index = diary.entries.findIndex((e) => e.day === entry.day);
    if (isDiaryBlank(entry, diary.template || [])) {
      if (index >= 0) diary.entries.splice(index, 1);
      return;
    }
    const saved = { ...entry, updatedAt: toISO(now) };
    if (index >= 0) diary.entries[index] = saved;
    else {
      diary.entries.push(saved);
      diary.entries.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    }
  }

  function diaryPreview(entry) {
    return entry.sections.map((s) => (s.text || "").trim()).find((t) => t) || "";
  }

  /// 末尾に 1 行追記する
  function appendLine(section, line) {
    if (section.text && !section.text.endsWith("\n")) section.text += "\n";
    section.text = (section.text || "") + line;
  }

  /// その日に完了したやること（完了の記録から。繰り返しは回ごと）
  function completedItems(tasks, day) {
    const start = startOfDay(day);
    const end = addDays(start, 1);
    const result = [];
    for (const task of tasks) {
      for (const item of task.checklist) {
        item.completions
          .filter((c) => c.completedAt >= start && c.completedAt < end)
          .sort((a, b) => a.completedAt - b.completedAt)
          .forEach(() => result.push({ taskTitle: task.title, itemTitle: item.title }));
      }
    }
    return result;
  }

  function isVisible(task, hiddenTags, showsUntagged) {
    return task.tags.length === 0
      ? showsUntagged
      : task.tags.some((t) => !hiddenTags.has(t));
  }

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // ---- タグと色 ----

  const TAG_COLORS = [
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "indigo",
    "purple",
    "pink",
    "brown",
    "gray",
  ];
  // iOS のシステムカラーに近い色
  const TAG_COLOR_VALUES = {
    red: "#FF3B30",
    orange: "#FF9500",
    yellow: "#FFCC00",
    green: "#34C759",
    teal: "#30B0C7",
    blue: "#007AFF",
    indigo: "#5856D6",
    purple: "#AF52DE",
    pink: "#FF2D55",
    brown: "#A2845E",
    gray: "#8E8E93",
  };

  /// 色を選んでいないタグの色（TagColor.automatic(for:) と同じ計算）
  function automaticColor(tag) {
    const palette = TAG_COLORS.filter((c) => c !== "gray");
    let hash = 0;
    for (const ch of tag) hash = (hash * 31 + ch.codePointAt(0)) & 0xffff;
    return palette[hash % palette.length];
  }

  function colorForTag(tagColors, tag) {
    return tagColors[tag] ?? automaticColor(tag);
  }

  function taskColor(task, tagColors) {
    return task.tags.length ? colorForTag(tagColors, task.tags[0]) : null;
  }

  /// 色が決まっていないタグに、まだ使っていない色を割り当てる
  function assigningColors(tagColors, tags) {
    const result = { ...tagColors };
    const palette = TAG_COLORS.filter((c) => c !== "gray");
    for (const tag of tags) {
      if (result[tag]) continue;
      const counts = {};
      for (const c of Object.values(result)) counts[c] = (counts[c] ?? 0) + 1;
      result[tag] = palette.reduce(
        (best, c) => ((counts[c] ?? 0) < (counts[best] ?? 0) ? c : best),
        palette[0],
      );
    }
    return result;
  }

  function allTags(tasks) {
    return [...new Set(tasks.flatMap((t) => t.tags))].sort((a, b) =>
      a.localeCompare(b, "ja", { numeric: true }),
    );
  }

  function normalizedTag(text) {
    const tag = text
      .trim()
      .replace(/^[#＃]+|[#＃]+$/g, "")
      .trim();
    return tag || null;
  }

  const api = {
    mergeMemo,
    mergeData,
    sameContent,
    contentKey,
    cloneTasks,
    stampChanges,
    mergeTombstones,
    syncMerged,
    defaultDiary,
    dayKey,
    dateForDayKey,
    diaryEntry,
    diaryEntryOrNew,
    isDiaryBlank,
    updateDiary,
    diaryPreview,
    appendLine,
    completedItems,
    parseBackup,
    serializeBackup,
    toISO,
    fromReferenceSeconds,
    emptyData,
    newTask,
    FREE_TASK_LIMIT,
    isProUnlocked,
    remainingFreeTasks,
    newItem,
    uuid,
    ruleKind,
    makeRule,
    ruleLabel,
    occurrences,
    nextOccurrence,
    addMonths,
    WEEKDAY_NAMES,
    isRepeating,
    isDone,
    nextDue,
    isOverdue,
    updateProgress,
    setDone,
    advanceToNextOccurrence,
    settleRepeatingCompletion,
    progressForOccurrence,
    setProgressForOccurrence,
    isOccurrenceDone,
    calendarEntries,
    overdueEntries,
    entryProgress,
    achievement,
    isVisible,
    startOfDay,
    addDays,
    DAY,
    TAG_COLORS,
    TAG_COLOR_VALUES,
    automaticColor,
    colorForTag,
    taskColor,
    assigningColors,
    allTags,
    normalizedTag,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TaskModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
