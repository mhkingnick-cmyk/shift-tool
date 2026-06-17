// 自動割当ロジック

function runScheduler(parsed, params) {
  const { year, month, daysInMonth, staffShifts } = parsed;
  const { holidayCount, medicalCareChildren } = params;

  const holidays = getJapaneseHolidays(year);
  const violations = [];
  const assignments = deepCopy(staffShifts);

  // 全日付リストと稼働日リストを構築
  const allDates  = [];
  const workDates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = toDateStr(new Date(year, month - 1, d));
    allDates.push(dateStr);
    if (!isClosedDay(dateStr, holidays)) workDates.push(dateStr);
  }

  // STEP0: 職員3番を全日固定としてマーク
  if (assignments[3]) {
    for (const dateStr of allDates) {
      if (assignments[3][dateStr]) assignments[3][dateStr].isFixed = true;
    }
  }

  // STEP1: 公休割当
  step1AssignHolidays(assignments, allDates, workDates, holidays, holidayCount, violations);

  // STEP2: 早出割当
  step2AssignEarlyShifts(assignments, allDates, workDates, violations);

  // STEP3〜7: 今後実装
  // TODO: STEP3 遅出割当
  // TODO: STEP4 医療的ケア児看護師配置
  // TODO: STEP5 日勤割当
  // TODO: STEP6 制約検証
  // TODO: STEP7 出力準備

  return { year, month, assignments, violations };
}

// ────────────────────────────────────────────────
// STEP1: 公休割当
// ────────────────────────────────────────────────
function step1AssignHolidays(assignments, allDates, workDates, holidays, holidayCount, violations) {
  const targetIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && !s.isFixed)
    .map(s => s.id);

  // 看護師は最後に処理（お互いの公休状況を考慮するため）
  const nurseIds    = targetIds.filter(id => STAFF_MASTER.find(m => m.id === id).type === "nurse");
  const nonNurseIds = targetIds.filter(id => !nurseIds.includes(id));

  for (const staffId of [...nonNurseIds, ...nurseIds]) {
    const days = assignments[staffId];
    if (!days) continue;

    // 固定済みの公休・有給・半日シフトを集計
    let fixedOffCount = 0;
    for (const dateStr of workDates) {
      const e = days[dateStr];
      if (!e || !e.isFixed || !e.shiftCode) continue;
      if (OFF_CODES.includes(e.shiftCode)) {
        fixedOffCount += 1;
      } else {
        const st = getShiftType(e.shiftCode);
        if (st && st.halfDay) fixedOffCount += 0.5;
      }
    }

    const needed = Math.max(0, Math.round(holidayCount - fixedOffCount));
    if (needed === 0) continue;

    // 割当候補日：稼働日のうち、固定・不在・既に公休でないもの
    let candidates = workDates.filter(dateStr => {
      const e = days[dateStr];
      if (!e) return true;
      if (e.isFixed || e.isAbsent) return false;
      if (e.shiftCode && OFF_CODES.includes(e.shiftCode)) return false;
      return true;
    });

    // 看護師の場合：もう一方の看護師が既に休んでいない日を優先
    if (nurseIds.includes(staffId)) {
      const otherId = nurseIds.find(id => id !== staffId);
      if (otherId && assignments[otherId]) {
        const otherDays = assignments[otherId];
        const nonConflict = candidates.filter(dateStr => {
          const oe = otherDays[dateStr];
          return !oe || !oe.shiftCode || !OFF_CODES.includes(oe.shiftCode);
        });
        // 非衝突候補が必要数を満たすなら優先使用
        if (nonConflict.length >= needed) candidates = nonConflict;
      }
    }

    if (candidates.length < needed) {
      violations.push({
        date: null,
        type: "holiday_shortage",
        staffId,
        message: `職員${staffId}番：公休の割当候補日が不足（必要 ${needed} 日、候補 ${candidates.length} 日）`
      });
    }

    const assignedSet = new Set();

    // 6連勤防止のために必須となる公休日を先に確定
    const mandatory = findMandatoryHolidayDates(days, allDates, holidays, candidates);
    for (const dateStr of mandatory) {
      if (assignedSet.size >= needed) break;
      ensureEntry(days, dateStr);
      days[dateStr].shiftCode = "休";
      assignedSet.add(dateStr);
    }

    // 残りを候補日全体に均等分散して割当
    const remaining   = needed - assignedSet.size;
    const restCandidates = candidates.filter(d => !assignedSet.has(d));
    distributeEvenly(days, restCandidates, remaining, assignedSet);
  }
}

// 6連勤にならないために最低限必要な公休日を特定する
// 候補日の中から最も早い日を選んで連勤カウントをリセットする
function findMandatoryHolidayDates(days, allDates, holidays, candidates) {
  const candidateSet = new Set(candidates);
  const mandatory    = [];
  const assignedSet  = new Set();
  let consecutive    = 0;
  let runDates       = [];

  for (const dateStr of allDates) {
    if (isClosedDay(dateStr, holidays)) {
      consecutive = 0;
      runDates    = [];
      continue;
    }

    const e      = days[dateStr];
    const isOff  = e && e.shiftCode && OFF_CODES.includes(e.shiftCode);
    const absent = e && e.isAbsent;

    if (isOff || absent) {
      consecutive = 0;
      runDates    = [];
      continue;
    }

    // 勤務または未割当：連勤カウント加算
    consecutive++;
    runDates.push(dateStr);

    if (consecutive === 6) {
      // この連勤区間内の最初の候補日を公休にする
      const pick = runDates.find(d => candidateSet.has(d) && !assignedSet.has(d));
      if (pick) {
        mandatory.push(pick);
        assignedSet.add(pick);
      }
      // 選んだ日以降から連勤カウントをリセット
      const pickIdx = pick ? runDates.indexOf(pick) : runDates.length - 1;
      consecutive   = runDates.length - pickIdx - 1;
      runDates      = runDates.slice(pickIdx + 1);
    }
  }

  return mandatory;
}

// 残り必要数を候補日に均等分散して割当
function distributeEvenly(days, candidates, count, assignedSet) {
  if (count <= 0 || candidates.length === 0) return;
  const toAssign = Math.min(count, candidates.length);
  const segSize  = candidates.length / toAssign;

  for (let i = 0; i < toAssign; i++) {
    const idx     = Math.min(Math.floor(i * segSize + segSize / 2), candidates.length - 1);
    const dateStr = candidates[idx];
    if (!assignedSet.has(dateStr)) {
      ensureEntry(days, dateStr);
      days[dateStr].shiftCode = "休";
      assignedSet.add(dateStr);
    }
  }
}

// ────────────────────────────────────────────────
// STEP2: 早出割当
// ────────────────────────────────────────────────
function step2AssignEarlyShifts(assignments, allDates, workDates, violations) {
  // 公平分配対象（1,2,6,7番）
  const fairIds = STAFF_MASTER.filter(s => s.isAutoTarget && s.fairness).map(s => s.id);
  // 早出調整弁（優先度順：9番→15番）
  const adjusterIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && (s.adjuster === "early" || s.adjuster === "both"))
    .sort((a, b) => a.adjusterPriority - b.adjusterPriority)
    .map(s => s.id);

  // 月の早出カウントを固定セル分で初期化
  const earlyCounts = {};
  fairIds.forEach(id => { earlyCounts[id] = 0; });
  for (const dateStr of workDates) {
    for (const id of fairIds) {
      const e = assignments[id] && assignments[id][dateStr];
      if (e && e.isFixed && e.shiftCode && EARLY_CODES.includes(e.shiftCode)) {
        earlyCounts[id]++;
      }
    }
  }

  // 土曜早出の達成状況を固定セル分で初期化
  const satEarlyDone = {};
  fairIds.forEach(id => { satEarlyDone[id] = false; });
  const satWorkDates = workDates.filter(d => new Date(d).getDay() === 6);
  for (const dateStr of satWorkDates) {
    for (const id of fairIds) {
      const e = assignments[id] && assignments[id][dateStr];
      if (e && e.shiftCode && EARLY_CODES.includes(e.shiftCode)) {
        satEarlyDone[id] = true;
      }
    }
  }

  // 日ごとに早出を割当
  for (const dateStr of workDates) {
    const isSat = new Date(dateStr).getDay() === 6;

    // 既確定の早出をカウント（固定 or STEP1以前に割当済み）
    let fixedEarlyCount = 0;
    const alreadyEarlyIds = new Set();
    for (const id of [...fairIds, ...adjusterIds]) {
      const e = assignments[id] && assignments[id][dateStr];
      if (e && e.shiftCode && EARLY_CODES.includes(e.shiftCode)) {
        fixedEarlyCount++;
        alreadyEarlyIds.add(id);
      }
    }

    if (fixedEarlyCount >= 2) {
      // 充足済み：土曜早出の達成だけ更新
      if (isSat) alreadyEarlyIds.forEach(id => { if (fairIds.includes(id)) satEarlyDone[id] = true; });
      continue;
    }

    const needed  = 2 - fixedEarlyCount;
    const assigned = [];

    // 公平分配グループから候補を絞る
    const available = fairIds.filter(id =>
      !alreadyEarlyIds.has(id) && canAssignShift(assignments[id], id, dateStr, allDates, "early")
    );

    // 土曜：まだ土曜早出未達の人を優先グループとする
    const satPrio = isSat ? available.filter(id => !satEarlyDone[id]) : [];
    const restAvail = available.filter(id => !satPrio.includes(id));

    // 各グループ内は早出カウントが少ない順に並べる
    const byCount = (a, b) => earlyCounts[a] - earlyCounts[b];
    const sorted  = [...satPrio.sort(byCount), ...restAvail.sort(byCount)];

    for (const id of sorted) {
      if (assigned.length >= needed) break;
      doAssign(assignments[id], dateStr, "A");
      earlyCounts[id]++;
      alreadyEarlyIds.add(id);
      if (isSat) satEarlyDone[id] = true;
      assigned.push(id);
    }

    // 公平分配だけでは不足 → 調整弁（9番→15番）を使用
    if (assigned.length < needed) {
      for (const id of adjusterIds) {
        if (assigned.length >= needed) break;
        if (alreadyEarlyIds.has(id)) continue;
        const days = assignments[id];
        if (!canAssignShift(days, id, dateStr, allDates, "early")) continue;
        doAssign(days, dateStr, "A");
        alreadyEarlyIds.add(id);
        assigned.push(id);
      }
    }

    const total = fixedEarlyCount + assigned.length;
    if (total < 2) {
      violations.push({
        date: dateStr,
        type: "early_shortage",
        required: 2,
        actual: total,
        message: `${dateStr}：早出が ${total} 名（最低2名必要）`
      });
    }
  }

  // 土曜早出の最低1回チェック
  for (const id of fairIds) {
    if (!STAFF_MASTER.find(s => s.id === id).satEarlyRequired) continue;
    if (satWorkDates.length > 0 && !satEarlyDone[id]) {
      violations.push({
        date: null,
        type: "saturday_early_missing",
        staffId: id,
        message: `職員${id}番：月内に土曜早出を1回も割当できませんでした`
      });
    }
  }
}

// ────────────────────────────────────────────────
// ユーティリティ
// ────────────────────────────────────────────────

// スタッフが指定日に早出または遅出を受け取れるか判定
// category: "early" | "late"
function canAssignShift(days, staffId, dateStr, allDates, category) {
  if (!days) return false;
  const e = days[dateStr];
  // 固定・不在・既に割当済みなら不可
  if (e && (e.isFixed || e.isAbsent || e.shiftCode)) return false;

  // 6番看護師ルール：前日が遅出なら翌日早出不可
  if (category === "early" && staffId === 6) {
    const prev = days[getPrevDate(dateStr, allDates)];
    if (prev && prev.shiftCode && LATE_CODES.includes(prev.shiftCode)) return false;
  }
  return true;
}

// allDates 内での前日日付を返す
function getPrevDate(dateStr, allDates) {
  const idx = allDates.indexOf(dateStr);
  return idx > 0 ? allDates[idx - 1] : null;
}

// 指定セルにシフトコードを書き込む
function doAssign(days, dateStr, shiftCode) {
  ensureEntry(days, dateStr);
  days[dateStr].shiftCode = shiftCode;
}

// days[dateStr] が存在しない場合にデフォルトエントリを作成
function ensureEntry(days, dateStr) {
  if (!days[dateStr]) {
    days[dateStr] = { shiftCode: null, isFixed: false, isAbsent: false };
  }
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}
