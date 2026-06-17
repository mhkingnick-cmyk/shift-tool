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

  // STEP2〜7: 今後実装
  // TODO: STEP2 早出割当
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
// ユーティリティ
// ────────────────────────────────────────────────

// days[dateStr] が存在しない場合にデフォルトエントリを作成
function ensureEntry(days, dateStr) {
  if (!days[dateStr]) {
    days[dateStr] = { shiftCode: null, isFixed: false, isAbsent: false };
  }
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}
