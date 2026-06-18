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

  // STEP3: 遅出割当
  step3AssignLateShifts(assignments, allDates, workDates, violations);

  // STEP4: 医療的ケア児看護師配置
  step4AssignMedicalCareNurse(assignments, allDates, workDates, medicalCareChildren, violations);

  // STEP5: 日勤割当
  step5AssignDayShifts(assignments, allDates, workDates);

  // STEP6: 最終検証
  step6Validate(assignments, allDates, workDates, holidays, violations);

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
    // 他スタッフの公休が少ない日を優先して並べ替え（集中防止）
    const remaining   = needed - assignedSet.size;
    const restCandidates = candidates.filter(d => !assignedSet.has(d));
    const otherNonFixedIds = STAFF_MASTER
      .filter(s => s.isAutoTarget && !s.isFixed && s.id !== staffId)
      .map(s => s.id);
    restCandidates.sort((dateA, dateB) => {
      const countOff = d => otherNonFixedIds.filter(id => {
        const e = assignments[id] && assignments[id][d];
        return e && e.shiftCode && OFF_CODES.includes(e.shiftCode);
      }).length;
      return countOff(dateA) - countOff(dateB);
    });
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
// STEP3: 遅出割当
// ────────────────────────────────────────────────
function step3AssignLateShifts(assignments, allDates, workDates, violations) {
  const fairIds = STAFF_MASTER.filter(s => s.isAutoTarget && s.fairness).map(s => s.id);
  // 遅出調整弁：15番のみ（adjuster === "both"）
  const adjusterIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && (s.adjuster === "late" || s.adjuster === "both"))
    .sort((a, b) => a.adjusterPriority - b.adjusterPriority)
    .map(s => s.id);

  // 月の遅出カウントを固定セル分で初期化
  const lateCounts = {};
  fairIds.forEach(id => { lateCounts[id] = 0; });
  for (const dateStr of workDates) {
    for (const id of fairIds) {
      const e = assignments[id] && assignments[id][dateStr];
      if (e && e.isFixed && e.shiftCode && LATE_CODES.includes(e.shiftCode)) lateCounts[id]++;
    }
  }

  for (const dateStr of workDates) {
    // 既確定の遅出をカウント
    let fixedLateCount = 0;
    const alreadyLateIds = new Set();
    for (const id of [...fairIds, ...adjusterIds]) {
      const e = assignments[id] && assignments[id][dateStr];
      if (e && e.shiftCode && LATE_CODES.includes(e.shiftCode)) {
        fixedLateCount++;
        alreadyLateIds.add(id);
      }
    }

    if (fixedLateCount >= 2) continue;

    const needed   = 2 - fixedLateCount;
    const assigned = [];

    const available = fairIds.filter(id =>
      !alreadyLateIds.has(id) && canAssignShift(assignments[id], id, dateStr, allDates, "late")
    );
    const byCount = (a, b) => lateCounts[a] - lateCounts[b];
    const sorted  = [...available].sort(byCount);

    for (const id of sorted) {
      if (assigned.length >= needed) break;
      doAssign(assignments[id], dateStr, "D");
      lateCounts[id]++;
      alreadyLateIds.add(id);
      assigned.push(id);
    }

    // 公平分配だけでは不足 → 調整弁（15番のみ）
    if (assigned.length < needed) {
      for (const id of adjusterIds) {
        if (assigned.length >= needed) break;
        if (alreadyLateIds.has(id)) continue;
        const days = assignments[id];
        if (!canAssignShift(days, id, dateStr, allDates, "late")) continue;
        doAssign(days, dateStr, "D");
        alreadyLateIds.add(id);
        assigned.push(id);
      }
    }

    const total = fixedLateCount + assigned.length;
    if (total < 2) {
      violations.push({
        date: dateStr,
        type: "late_shortage",
        required: 2,
        actual: total,
        message: `${dateStr}：遅出が ${total} 名（最低2名必要）`
      });
    }
  }
}

// ────────────────────────────────────────────────
// STEP4: 医療的ケア児看護師配置
// ────────────────────────────────────────────────
function step4AssignMedicalCareNurse(assignments, allDates, workDates, medicalCareChildren, violations) {
  if (!medicalCareChildren || medicalCareChildren.length === 0) return;

  const nurseIds = STAFF_MASTER.filter(s => s.type === "nurse" && s.isAutoTarget).map(s => s.id);

  // 曜日ごとに必要時間帯（複数児の包絡）を計算
  const weekdayRanges = {};
  for (const child of medicalCareChildren) {
    for (const wd of (child.weekdays || [])) {
      const newS = child.startH * 60 + child.startM;
      const newE = child.endH   * 60 + child.endM;
      if (!weekdayRanges[wd]) {
        weekdayRanges[wd] = { startH: child.startH, startM: child.startM, endH: child.endH, endM: child.endM };
      } else {
        const cur  = weekdayRanges[wd];
        const curS = cur.startH * 60 + cur.startM;
        const curE = cur.endH   * 60 + cur.endM;
        if (newS < curS) { cur.startH = child.startH; cur.startM = child.startM; }
        if (newE > curE) { cur.endH   = child.endH;   cur.endM   = child.endM;   }
      }
    }
  }

  for (const dateStr of workDates) {
    const weekday = new Date(dateStr).getDay();
    const req = weekdayRanges[weekday];
    if (!req) continue;

    // いずれかの看護師が既に要求範囲をカバーしているか確認
    const alreadyCovered = nurseIds.some(id => {
      const e = assignments[id] && assignments[id][dateStr];
      if (!e || !e.shiftCode || OFF_CODES.includes(e.shiftCode) || e.isAbsent) return false;
      return coversTimeRange(e.shiftCode, req.startH, req.startM, req.endH, req.endM);
    });
    if (alreadyCovered) continue;

    // カバー未達 → 看護師に適切なシフトを割当
    let assigned = false;
    for (const id of nurseIds) {
      const days = assignments[id];
      if (!days) continue;
      const e = days[dateStr];
      if (e && (e.isFixed || e.isAbsent || e.shiftCode)) continue;

      // 要求時間帯をカバーする最適シフト（日勤優先 → 次点でその他）
      const covering =
        SHIFT_TYPES.find(st => !st.halfDay && !st.partOnly && st.category === "day" &&
          coversTimeRange(st.code, req.startH, req.startM, req.endH, req.endM)) ||
        SHIFT_TYPES.find(st => !st.halfDay && !st.partOnly && st.category !== "off" &&
          coversTimeRange(st.code, req.startH, req.startM, req.endH, req.endM));
      if (!covering) continue;

      if (!canAssignShift(days, id, dateStr, allDates, covering.category)) continue;

      doAssign(days, dateStr, covering.code);
      assigned = true;
      break;
    }

    if (!assigned) {
      const pad = n => String(n).padStart(2, "0");
      violations.push({
        date: dateStr,
        type: "medical_care_nurse_missing",
        message: `${dateStr}：医療的ケア児対応の看護師を確保できませんでした（${req.startH}:${pad(req.startM)}〜${req.endH}:${pad(req.endM)}）`
      });
    }
  }
}

// ────────────────────────────────────────────────
// STEP5: 日勤割当
// ────────────────────────────────────────────────
function step5AssignDayShifts(assignments, allDates, workDates) {
  const autoTargetIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && !s.isFixed)
    .map(s => s.id);

  for (const dateStr of workDates) {
    for (const id of autoTargetIds) {
      const days = assignments[id];
      if (!days) continue;
      const e = days[dateStr];
      if (e && (e.isFixed || e.isAbsent || e.shiftCode)) continue;

      const staff = STAFF_MASTER.find(s => s.id === id);
      const code  = staff.type === "part_nursery" ? "P2" : "B";
      doAssign(days, dateStr, code);
    }
  }
}

// ────────────────────────────────────────────────
// STEP6: 最終検証
// ────────────────────────────────────────────────
function step6Validate(assignments, allDates, workDates, holidays, violations) {
  const nurseIds       = STAFF_MASTER.filter(s => s.type === "nurse" && s.isAutoTarget).map(s => s.id);
  const allAutoTargets = STAFF_MASTER.filter(s => s.isAutoTarget).map(s => s.id);

  for (const dateStr of workDates) {
    const isSat = new Date(dateStr).getDay() === 6;

    // 看護師2名同時休チェック
    if (nurseIds.length >= 2) {
      const allNursesOff = nurseIds.every(id => {
        const e = assignments[id] && assignments[id][dateStr];
        return !e || !e.shiftCode || OFF_CODES.includes(e.shiftCode);
      });
      if (allNursesOff) {
        violations.push({
          date: dateStr,
          type: "both_nurses_off",
          message: `${dateStr}：看護師が全員休み（同日休は不可）`
        });
      }
    }

    // 平日：日勤帯（早出＋日勤）の合計最低4名チェック
    if (!isSat) {
      const dayBandCount = allAutoTargets.filter(id => {
        const e = assignments[id] && assignments[id][dateStr];
        if (!e || !e.shiftCode || e.isAbsent) return false;
        if (OFF_CODES.includes(e.shiftCode)) return false;
        if (LATE_CODES.includes(e.shiftCode)) return false;
        return true;
      }).length;
      if (dayBandCount < 4) {
        violations.push({
          date: dateStr,
          type: "day_band_shortage",
          required: 4,
          actual: dayBandCount,
          message: `${dateStr}：日勤帯（早出＋日勤）が ${dayBandCount} 名（最低4名必要）`
        });
      }
    }
  }

  // 6連勤チェック（全自動割当対象職員）
  for (const id of allAutoTargets) {
    const days = assignments[id];
    if (!days) continue;
    let consecutive = 0;
    for (const dateStr of allDates) {
      if (isClosedDay(dateStr, holidays)) { consecutive = 0; continue; }
      const e = days[dateStr];
      const isOff    = e && e.shiftCode && OFF_CODES.includes(e.shiftCode);
      const isAbsent = e && e.isAbsent;
      if (isOff || isAbsent) {
        consecutive = 0;
      } else {
        consecutive++;
        if (consecutive > 5) {
          violations.push({
            date: dateStr,
            type: "consecutive_days_exceeded",
            staffId: id,
            message: `職員${id}番：${dateStr}で6連勤以上（上限5連勤）`
          });
          consecutive = 0;
        }
      }
    }
  }

  // 6番看護師：遅出翌日早出の最終チェック
  const nurse6Days = assignments[6];
  if (nurse6Days) {
    for (let i = 1; i < allDates.length; i++) {
      const prevDate = allDates[i - 1];
      const curDate  = allDates[i];
      const prevE = nurse6Days[prevDate];
      const curE  = nurse6Days[curDate];
      if (
        prevE && prevE.shiftCode && LATE_CODES.includes(prevE.shiftCode) &&
        curE  && curE.shiftCode  && EARLY_CODES.includes(curE.shiftCode)
      ) {
        violations.push({
          date: curDate,
          type: "nurse6_late_early_consecutive",
          message: `${curDate}：6番看護師が遅出翌日に早出（制約違反）`
        });
      }
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

  if (staffId === 6) {
    // 前日が遅出なら当日早出不可
    if (category === "early") {
      const prevDate = getPrevDate(dateStr, allDates);
      const prev = prevDate && days[prevDate];
      if (prev && prev.shiftCode && LATE_CODES.includes(prev.shiftCode)) return false;
    }
    // 翌日が早出確定なら当日遅出不可
    if (category === "late") {
      const nextDate = getNextDate(dateStr, allDates);
      const next = nextDate && days[nextDate];
      if (next && next.shiftCode && EARLY_CODES.includes(next.shiftCode)) return false;
    }
  }
  return true;
}

// allDates 内での前日日付を返す
function getPrevDate(dateStr, allDates) {
  const idx = allDates.indexOf(dateStr);
  return idx > 0 ? allDates[idx - 1] : null;
}

// allDates 内での翌日日付を返す
function getNextDate(dateStr, allDates) {
  const idx = allDates.indexOf(dateStr);
  return (idx >= 0 && idx < allDates.length - 1) ? allDates[idx + 1] : null;
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
