// 自動割当ロジック

function runScheduler(parsed, params) {
  const { year, month, daysInMonth, staffShifts } = parsed;
  const { holidayCount, medicalCareChildren } = params;

  const holidays = getJapaneseHolidays(year);
  const violations = [];
  const notes      = [];
  const assignments = deepCopy(staffShifts);

  const allDates  = [];
  const workDates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = toDateStr(new Date(year, month - 1, d));
    allDates.push(dateStr);
    if (!isClosedDay(dateStr, holidays)) workDates.push(dateStr);
  }

  const closedDaysCount     = allDates.filter(d => isClosedDay(d, holidays)).length;
  const workdayHolidayCount = Math.max(0, holidayCount - closedDaysCount);

  // イベント出勤日：isClosedDay=true だが固定セルが存在する日（例：日曜イベント出勤）
  // 連続勤務カウントでは稼働日として扱い、早出・遅出の人数条件は適用しない。
  const eventWorkDays = getEventWorkDays(assignments, allDates, holidays);

  // ━━━━ STAGE 1: 初期割当 ━━━━
  // step1 には月全体の公休目標数（holidayCount）を渡す。
  // 各職員の休園日「休」を自動検出して差分のみ稼働日に割当てる。
  step1AssignHolidays(assignments, allDates, workDates, holidays, holidayCount, violations, eventWorkDays);
  step1BreakLongRests(assignments, allDates, workDates, holidays, eventWorkDays);
  step2AssignEarlyShifts(assignments, allDates, workDates, violations, notes);
  step3AssignLateShifts(assignments, allDates, workDates, violations, notes);
  step4AssignMedicalCareNurse(assignments, allDates, workDates, medicalCareChildren, violations);
  step5AssignDayShifts(assignments, allDates, workDates);

  // ━━━━ STAGE 2: 微調整 ━━━━
  // 9番・15番が日勤(C)のとき配置基準カウント対象外のため、
  // step7/step8 では早出・遅出コード以外のカウントに9番・15番を含めない。
  step7BalanceHolidays(assignments, allDates, workDates, holidays, holidayCount, notes, eventWorkDays);
  step8BalanceEarlyLate(assignments, allDates, workDates, notes, "[Stage2]", 1);

  // ━━━━ STAGE 3: スワップ最適化 ━━━━
  step9OptimizeBySwap(assignments, allDates, workDates, holidays, holidayCount, eventWorkDays, violations, notes);

  // 最終検証（STEP9後）― structural_shortage を判定してviolationsに記録
  violations.length = 0;
  step6Validate(assignments, allDates, workDates, holidays, violations, eventWorkDays);

  // ━━━━ STEP10: 構造的遅出不足への15番投入（例外処理）━━━━
  // structural_late_shortage 日のみ対象。通常STEP(2/3/9)では15番を遅出に使わない。
  step10UseStaff15ForLate(assignments, allDates, workDates, holidays, holidayCount, eventWorkDays, violations, notes);

  // STEP10後の遅出均等化再実行（threshold=1、max-min≤1で終了）
  // STEP10が追加した遅出シフトによる不均衡を解消する
  step8BalanceEarlyLate(assignments, allDates, workDates, notes, "[STEP10後]", 1);

  // STEP10後の再検証（最終状態）
  violations.length = 0;
  step6Validate(assignments, allDates, workDates, holidays, violations, eventWorkDays);

  // 最終追加チェック: 公休数不一致（「休」のみカウント、「有」は含まない）
  const _finalTargetIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && !s.isFixed && s.type !== "part_nursery")
    .map(s => s.id);
  for (const id of _finalTargetIds) {
    const cnt = allDates.reduce((c, d) => {
      const e = assignments[id]?.[d];
      return c + (e && e.shiftCode === "休" ? 1 : 0);
    }, 0);
    if (Math.abs(cnt - holidayCount) >= 2) {
      violations.push({ date: null, type: "holiday_count_mismatch", staffId: id,
        actualCount: cnt,
        message: `職員${id}番：公休${cnt}日（目標${holidayCount}日）` });
    }
  }
  // 最終追加チェック: フェアメンバー同日2名非固定休
  const _finalFairIds = STAFF_MASTER.filter(s => s.isAutoTarget && s.fairness).map(s => s.id);
  for (const dateStr of workDates) {
    const members = _finalFairIds.filter(id => {
      const e = assignments[id]?.[dateStr];
      return e && e.shiftCode === "休" && !e.isFixed;
    });
    if (members.length >= 2) {
      violations.push({ date: dateStr, type: "fair_double_holiday",
        staffIds: members,
        message: `${dateStr}：フェアメンバー${members.join("・")}番が同日非固定休` });
    }
  }

  return { year, month, assignments, violations, notes };
}

// ────────────────────────────────────────────────
// STEP1: 公休割当
// ────────────────────────────────────────────────
function step1AssignHolidays(assignments, allDates, workDates, holidays, holidayCount, violations, eventWorkDays) {
  const targetIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && !s.isFixed && s.type !== "part_nursery")
    .map(s => s.id);

  const nurseIds    = targetIds.filter(id => STAFF_MASTER.find(m => m.id === id).type === "nurse");
  const nonNurseIds = targetIds.filter(id => !nurseIds.includes(id));
  const fairIds     = STAFF_MASTER.filter(s => s.fairness).map(s => s.id);

  for (const staffId of [...nonNurseIds, ...nurseIds]) {
    const days = assignments[staffId];
    if (!days) continue;

    let fixedOffCount = 0;
    for (const dateStr of allDates) {
      const e = days[dateStr];
      if (!e || !e.shiftCode || e.isAbsent) continue;
      if (isClosedDay(dateStr, holidays)) {
        // 休園日（イベント出勤日含む）：固定・非固定問わずテンプレートの「休」をカウント
        if (HOLIDAY_CODES.includes(e.shiftCode)) fixedOffCount += 1;
      } else {
        // 稼働日：赤文字（固定）セルのみカウント（「有」は公休目標に含まない）
        if (!e.isFixed) continue;
        if (e.shiftCode === "休") {
          fixedOffCount += 1;
        } else {
          const st = getShiftType(e.shiftCode);
          if (st && st.halfDay) fixedOffCount += 0.5;
        }
      }
    }

    const needed = Math.max(0, Math.round(holidayCount - fixedOffCount));
    if (needed === 0) continue;

    let candidates = workDates.filter(dateStr => {
      const e = days[dateStr];
      if (!e) return true;
      if (e.isFixed || e.isAbsent) return false;
      if (e.shiftCode && OFF_CODES.includes(e.shiftCode)) return false;
      return true;
    });

    if (nurseIds.includes(staffId)) {
      const otherId = nurseIds.find(id => id !== staffId);
      if (otherId && assignments[otherId]) {
        const otherDays = assignments[otherId];
        const nonConflict = candidates.filter(dateStr => {
          const oe = otherDays[dateStr];
          return !oe || !oe.shiftCode || !OFF_CODES.includes(oe.shiftCode);
        });
        if (nonConflict.length >= needed) candidates = nonConflict;
      }
    }

    // フェアメンバー（fairness:true）の同日非固定「休」を1名に制限
    if (fairIds.includes(staffId)) {
      const otherFairIds = fairIds.filter(id => id !== staffId);
      const noDoubleOff = candidates.filter(dateStr => {
        const otherHasNonFixedOff = otherFairIds.some(id => {
          const oe = assignments[id] && assignments[id][dateStr];
          return oe && oe.shiftCode === "休" && !oe.isFixed;
        });
        if (!otherHasNonFixedOff) return true;
        // 例外: 4番（part_nursery）が出勤している日は制限緩和
        const s4 = assignments[4] && assignments[4][dateStr];
        return s4 && s4.shiftCode && !OFF_CODES.includes(s4.shiftCode);
      });
      if (noDoubleOff.length >= needed) candidates = noDoubleOff;
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
    const mandatory = findMandatoryHolidayDates(days, allDates, holidays, candidates, eventWorkDays);
    for (const dateStr of mandatory) {
      if (assignedSet.size >= needed) break;
      ensureEntry(days, dateStr);
      days[dateStr].shiftCode = "休";
      assignedSet.add(dateStr);
    }

    const remaining      = needed - assignedSet.size;
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
    // 確定した「休」にロックを掛け、以降のどの処理でも変更されないようにする
    for (const dateStr of assignedSet) {
      if (days[dateStr]) days[dateStr].isLocked = true;
    }
  }
}

function findMandatoryHolidayDates(days, allDates, holidays, candidates, eventWorkDays) {
  const candidateSet = new Set(candidates);
  const mandatory    = [];
  const assignedSet  = new Set();
  let consecutive    = 0;
  let runDates       = [];

  for (const dateStr of allDates) {
    // 通常の休園日はリセット。イベント出勤日（固定セルあり）は稼働日として連勤カウントを継続。
    if (isClosedDay(dateStr, holidays) && (!eventWorkDays || !eventWorkDays.has(dateStr))) {
      consecutive = 0; runDates = []; continue;
    }
    const e     = days[dateStr];
    const isOff = e && e.shiftCode && OFF_CODES.includes(e.shiftCode);
    const absent = e && e.isAbsent;
    if (isOff || absent) { consecutive = 0; runDates = []; continue; }
    consecutive++;
    runDates.push(dateStr);
    if (consecutive === 6) {
      const pick = runDates.find(d => candidateSet.has(d) && !assignedSet.has(d));
      if (pick) { mandatory.push(pick); assignedSet.add(pick); }
      const pickIdx = pick ? runDates.indexOf(pick) : runDates.length - 1;
      consecutive   = runDates.length - pickIdx - 1;
      runDates      = runDates.slice(pickIdx + 1);
    }
  }
  return mandatory;
}

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
// STEP1補助: 連休バランス改善（3日以上の連続休暇を分散）
// 非固定の「休」が休園日と連続して3日以上になる場合、
// 月内の非固定Cの稼働日と「休」をスワップして分散させる。
// ────────────────────────────────────────────────
function step1BreakLongRests(assignments, allDates, workDates, holidays, eventWorkDays) {
  const targetIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && !s.isFixed && s.type !== "part_nursery")
    .map(s => s.id);

  for (const staffId of targetIds) {
    const days = assignments[staffId];
    if (!days) continue;

    for (let iter = 0; iter < 10; iter++) {
      const restToMove = findLongStreakRest(days, allDates, holidays, eventWorkDays);
      if (!restToMove) break;

      // スワップ候補：まだ何も割当てられていない稼働日（restToMove以外）を
      // 閉園日から遠い順に並べる
      const swapCandidates = workDates
        .filter(d => {
          if (d === restToMove) return false;
          const ec = days[d];
          if (ec && ec.isFixed) return false;
          if (ec && ec.isAbsent) return false;
          // 既に休・OFF が割当て済みの日はスキップ
          if (ec && ec.shiftCode && (HOLIDAY_CODES.includes(ec.shiftCode) || OFF_CODES.includes(ec.shiftCode))) return false;
          return true;
        })
        .sort((a, b) =>
          minDistToClosedDay(b, allDates, holidays, eventWorkDays) -
          minDistToClosedDay(a, allDates, holidays, eventWorkDays)
        );

      let swapped = false;
      for (const swapDate of swapCandidates) {
        const backupRest = days[restToMove] ? { ...days[restToMove] } : null;
        const backupSwap = days[swapDate]   ? { ...days[swapDate] }   : null;

        // restToMove の「休」を除去（空にする）、swapDate を「休」に
        if (backupRest) days[restToMove].shiftCode = null;
        else delete days[restToMove];

        ensureEntry(days, swapDate);
        days[swapDate].shiftCode = "休";
        days[swapDate].isLocked  = true;

        // 連勤超過チェック（STEP1時点では空セル＝稼働日として評価）
        if (!checkConsecutiveExceededAtStep1(days, allDates, holidays, eventWorkDays)) {
          swapped = true;
          break;
        }

        // 元に戻す
        if (backupRest) days[restToMove] = { ...backupRest };
        else delete days[restToMove];
        if (backupSwap) days[swapDate] = { ...backupSwap };
        else delete days[swapDate];
      }

      if (!swapped) break;
    }
  }
}

// 3日以上連続するOFF連鎖（休園日＋非固定休）の中にある
// 移動可能な非固定「休」の日付を返す（移動してもく6連勤にならない候補を優先）
function findLongStreakRest(days, allDates, holidays, eventWorkDays) {
  let streakDates = [];
  let hasClosedDay = false;

  const flush = () => {
    if (streakDates.length >= 3 && hasClosedDay) {
      for (const d of streakDates) {
        const isClosed = isClosedDay(d, holidays) && (!eventWorkDays || !eventWorkDays.has(d));
        if (!isClosed) {
          const e = days[d];
          if (e && !e.isFixed && !e.isAbsent && HOLIDAY_CODES.includes(e.shiftCode)) {
            // この日の「休」を除いたら6連勤にならないかチェック
            if (!wouldCreate6ConsecutiveAtStep1(days, d, allDates, holidays, eventWorkDays)) {
              return d;
            }
          }
        }
      }
    }
    return null;
  };

  for (const d of allDates) {
    const isClosed = isClosedDay(d, holidays) && (!eventWorkDays || !eventWorkDays.has(d));
    const e = days[d];
    const isOff    = e && e.shiftCode && OFF_CODES.includes(e.shiftCode);
    const isAbsent = e && e.isAbsent;

    if (isClosed || isOff || isAbsent) {
      streakDates.push(d);
      if (isClosed) hasClosedDay = true;
    } else {
      const result = flush();
      if (result) return result;
      streakDates = [];
      hasClosedDay = false;
    }
  }
  return flush();
}

// dateStr の「休」を除いた場合に6連勤超になるか判定（STEP1時点用）
// 空セル（未割当）は稼働日として扱う
function wouldCreate6ConsecutiveAtStep1(days, dateStr, allDates, holidays, eventWorkDays) {
  const idx = allDates.indexOf(dateStr);
  let before = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const d = allDates[i];
    if (isClosedDay(d, holidays) && (!eventWorkDays || !eventWorkDays.has(d))) break;
    const e = days[d];
    if (e && e.shiftCode && HOLIDAY_CODES.includes(e.shiftCode)) break;
    if (e && e.isAbsent) break;
    before++;
  }
  let after = 0;
  for (let i = idx + 1; i < allDates.length; i++) {
    const d = allDates[i];
    if (isClosedDay(d, holidays) && (!eventWorkDays || !eventWorkDays.has(d))) break;
    const e = days[d];
    if (e && e.shiftCode && HOLIDAY_CODES.includes(e.shiftCode)) break;
    if (e && e.isAbsent) break;
    after++;
  }
  return (before + 1 + after) > 5;
}

// STEP1時点の連勤超過チェック（空セル＝稼働日扱い）
function checkConsecutiveExceededAtStep1(days, allDates, holidays, eventWorkDays) {
  let cons = 0;
  for (const d of allDates) {
    if (isClosedDay(d, holidays) && (!eventWorkDays || !eventWorkDays.has(d))) { cons = 0; continue; }
    const e = days[d];
    const isOff = e && e.shiftCode && (HOLIDAY_CODES.includes(e.shiftCode) || OFF_CODES.includes(e.shiftCode));
    if (isOff || (e && e.isAbsent)) {
      cons = 0;
    } else {
      cons++;
      if (cons > 5) return true;
    }
  }
  return false;
}

// dateStr から最も近い休園日までのインデックス距離を返す
function minDistToClosedDay(dateStr, allDates, holidays, eventWorkDays) {
  const idx = allDates.indexOf(dateStr);
  let minDist = Infinity;
  for (let i = 0; i < allDates.length; i++) {
    if (isClosedDay(allDates[i], holidays) && (!eventWorkDays || !eventWorkDays.has(allDates[i]))) {
      minDist = Math.min(minDist, Math.abs(i - idx));
    }
  }
  return minDist === Infinity ? 0 : minDist;
}

// ────────────────────────────────────────────────
// STEP2: 早出割当
// ────────────────────────────────────────────────
function step2AssignEarlyShifts(assignments, allDates, workDates, violations, notes) {
  const fairIds = STAFF_MASTER.filter(s => s.isAutoTarget && s.fairness).map(s => s.id);
  const adjusterIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && (s.adjuster === "early" || s.adjuster === "both"))
    .sort((a, b) => a.adjusterPriority - b.adjusterPriority)
    .map(s => s.id);

  const earlyCounts = {};
  fairIds.forEach(id => { earlyCounts[id] = 0; });
  for (const dateStr of workDates) {
    for (const id of fairIds) {
      const e = assignments[id] && assignments[id][dateStr];
      if (e && e.isFixed && e.shiftCode && EARLY_CODES.includes(e.shiftCode)) earlyCounts[id]++;
    }
  }

  const satEarlyDone = {};
  fairIds.forEach(id => { satEarlyDone[id] = false; });
  const satWorkDates = workDates.filter(d => new Date(d).getDay() === 6);
  for (const dateStr of satWorkDates) {
    for (const id of fairIds) {
      const e = assignments[id] && assignments[id][dateStr];
      if (e && e.shiftCode && EARLY_CODES.includes(e.shiftCode)) satEarlyDone[id] = true;
    }
  }

  for (const dateStr of workDates) {
    const isSat = new Date(dateStr).getDay() === 6;

    // 既確定の早出をカウント（全職員）
    // 9番・15番が A なら早出カウントに含める（日勤Cの場合は含まない）
    let fixedEarlyCount = 0;
    const alreadyEarlyIds = new Set();
    for (const id of Object.keys(assignments).map(Number)) {
      const e = assignments[id] && assignments[id][dateStr];
      if (e && e.shiftCode && EARLY_CODES.includes(e.shiftCode)) {
        fixedEarlyCount++;
        alreadyEarlyIds.add(id);
      }
    }

    if (fixedEarlyCount >= 2) {
      if (isSat) alreadyEarlyIds.forEach(id => { if (fairIds.includes(id)) satEarlyDone[id] = true; });
      continue;
    }

    const needed   = 2 - fixedEarlyCount;
    const assigned = [];

    const available = fairIds.filter(id =>
      !alreadyEarlyIds.has(id) && canAssignShift(assignments[id], id, dateStr, allDates, "early")
    );

    const satPrio  = isSat ? available.filter(id => !satEarlyDone[id]) : [];
    const restAvail = available.filter(id => !satPrio.includes(id));
    const byCount  = (a, b) => earlyCounts[a] - earlyCounts[b];
    const sorted   = [...satPrio.sort(byCount), ...restAvail.sort(byCount)];

    // 通常職員は1名まで配置し、2枠目は調整弁（9番→15番）を優先して使う
    for (const id of sorted) {
      if (assigned.length >= 1) break;
      doAssign(assignments[id], dateStr, "A");
      earlyCounts[id]++;
      alreadyEarlyIds.add(id);
      if (isSat) satEarlyDone[id] = true;
      assigned.push(id);
    }

    if (assigned.length < needed) {
      for (const id of adjusterIds) {
        if (assigned.length >= needed) break;
        if (alreadyEarlyIds.has(id)) continue;
        const days = assignments[id];
        if (!canAssignShift(days, id, dateStr, allDates, "early")) continue;
        doAssign(days, dateStr, "A");
        alreadyEarlyIds.add(id);
        assigned.push(id);
        if (id === 15 && notes) {
          const coreCount = fixedEarlyCount + assigned.length - 1;
          notes.push({ date: dateStr, type: "adjuster15_early",
            message: `${dateStr}：早出コア${coreCount}名 → 15番が補充` });
        }
      }
    }

    // 調整弁でも不足する場合は通常職員がさらに補充
    if (fixedEarlyCount + assigned.length < 2) {
      for (const id of sorted) {
        if (fixedEarlyCount + assigned.length >= 2) break;
        if (alreadyEarlyIds.has(id)) continue;
        doAssign(assignments[id], dateStr, "A");
        earlyCounts[id]++;
        alreadyEarlyIds.add(id);
        if (isSat) satEarlyDone[id] = true;
        assigned.push(id);
      }
    }

    const total = fixedEarlyCount + assigned.length;
    if (total < 2) {
      violations.push({ date: dateStr, type: "early_shortage", required: 2, actual: total,
        message: `${dateStr}：早出が ${total} 名（最低2名必要）` });
    }
  }

  for (const id of fairIds) {
    if (!STAFF_MASTER.find(s => s.id === id).satEarlyRequired) continue;
    if (satWorkDates.length > 0 && !satEarlyDone[id]) {
      violations.push({ date: null, type: "saturday_early_missing", staffId: id,
        message: `職員${id}番：月内に土曜早出を1回も割当できませんでした` });
    }
  }
}

// ────────────────────────────────────────────────
// STEP3: 遅出割当
// ────────────────────────────────────────────────
function step3AssignLateShifts(assignments, allDates, workDates, violations, notes) {
  const fairIds = STAFF_MASTER.filter(s => s.isAutoTarget && s.fairness).map(s => s.id);
  const adjusterIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && (s.adjuster === "late" || s.adjuster === "both"))
    .sort((a, b) => a.adjusterPriority - b.adjusterPriority)
    .map(s => s.id);

  const lateCounts = {};
  fairIds.forEach(id => { lateCounts[id] = 0; });
  for (const dateStr of workDates) {
    for (const id of fairIds) {
      const e = assignments[id] && assignments[id][dateStr];
      if (e && e.isFixed && e.shiftCode && LATE_CODES.includes(e.shiftCode)) lateCounts[id]++;
    }
  }

  for (const dateStr of workDates) {
    // 9番・15番が D なら遅出カウントに含める（日勤Cの場合は含まない）
    let fixedLateCount = 0;
    const alreadyLateIds = new Set();
    for (const id of Object.keys(assignments).map(Number)) {
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

    if (assigned.length < needed) {
      for (const id of adjusterIds) {
        if (assigned.length >= needed) break;
        if (alreadyLateIds.has(id)) continue;
        const days = assignments[id];
        if (!canAssignShift(days, id, dateStr, allDates, "late")) continue;
        doAssign(days, dateStr, "D");
        alreadyLateIds.add(id);
        assigned.push(id);
        if (id === 15 && notes) {
          const coreCount = fixedLateCount + assigned.length - 1;
          notes.push({ date: dateStr, type: "adjuster15_late",
            message: `${dateStr}：遅出コア${coreCount}名 → 15番が補充` });
        }
      }
    }

    const total = fixedLateCount + assigned.length;
    if (total < 2) {
      violations.push({ date: dateStr, type: "late_shortage", required: 2, actual: total,
        message: `${dateStr}：遅出が ${total} 名（最低2名必要）` });
    }
  }
}

// ────────────────────────────────────────────────
// STEP4: 医療的ケア児看護師配置
// ────────────────────────────────────────────────
function step4AssignMedicalCareNurse(assignments, allDates, workDates, medicalCareChildren, violations) {
  if (!medicalCareChildren || medicalCareChildren.length === 0) return;

  const nurseIds = STAFF_MASTER.filter(s => s.type === "nurse" && s.isAutoTarget).map(s => s.id);

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

    const alreadyCovered = nurseIds.some(id => {
      const e = assignments[id] && assignments[id][dateStr];
      if (!e || !e.shiftCode || OFF_CODES.includes(e.shiftCode) || e.isAbsent) return false;
      return coversTimeRange(e.shiftCode, req.startH, req.startM, req.endH, req.endM);
    });
    if (alreadyCovered) continue;

    let assigned = false;
    for (const id of nurseIds) {
      const days = assignments[id];
      if (!days) continue;
      const e = days[dateStr];
      if (e && (e.isFixed || e.isAbsent || e.shiftCode)) continue;

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
      violations.push({ date: dateStr, type: "medical_care_nurse_missing",
        message: `${dateStr}：医療的ケア児対応の看護師を確保できませんでした（${req.startH}:${pad(req.startM)}〜${req.endH}:${pad(req.endM)}）` });
    }
  }
}

// ────────────────────────────────────────────────
// STEP5: 日勤割当
// ────────────────────────────────────────────────
function step5AssignDayShifts(assignments, allDates, workDates) {
  const autoTargetIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && !s.isFixed && s.type !== "part_nursery")
    .map(s => s.id);

  for (const dateStr of workDates) {
    for (const id of autoTargetIds) {
      const days = assignments[id];
      if (!days) continue;
      const e = days[dateStr];
      if (e && (e.isFixed || e.isAbsent || e.shiftCode)) continue;
      doAssign(days, dateStr, "C");
    }
  }
}

// ────────────────────────────────────────────────
// STEP7: 公休数の均等化（ステージ2）
// ────────────────────────────────────────────────
function step7BalanceHolidays(assignments, allDates, workDates, holidays, holidayCount, notes, eventWorkDays) {
  const targetIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && !s.isFixed && s.type !== "part_nursery")
    .map(s => s.id);
  const nurseIds = STAFF_MASTER.filter(s => s.type === "nurse" && s.isAutoTarget).map(s => s.id);

  // 全日程（休園日含む）で「休」をカウントして目標と比較
  const before = {};
  for (const id of targetIds) {
    before[id] = countHolidays(assignments[id], allDates);
  }

  for (const staffId of targetIds) {
    const days = assignments[staffId];
    if (!days) continue;

    const current = countHolidayEquivalent(days, allDates);
    const diff    = current - holidayCount;

    if (diff < 0) {
      // 公休不足 → 稼働日のC日を休に変換（早出・遅出日は変えない）
      const toAdd = -diff;
      const candidates = workDates.filter(dateStr => {
        const e = days[dateStr];
        if (!e || e.shiftCode !== "C" || e.isFixed || e.isAbsent) return false;
        // 看護師：他方が既に休の日は除外
        if (nurseIds.includes(staffId)) {
          const otherId = nurseIds.find(id => id !== staffId);
          if (otherId) {
            const oe = assignments[otherId]?.[dateStr];
            if (oe && oe.shiftCode && OFF_CODES.includes(oe.shiftCode)) return false;
          }
        }
        return true;
      });
      const assignedSet = new Set();
      distributeEvenly(days, candidates, toAdd, assignedSet);

    } else if (diff > 0) {
      // 公休過剰 → 非固定・非ロックの「休」をCに変換（稼働日のみ、6連勤にならない日）
      let removed = 0;
      for (const dateStr of workDates) {
        if (removed >= diff) break;
        const e = days[dateStr];
        if (!e || !HOLIDAY_CODES.includes(e.shiftCode) || e.isFixed || e.isLocked || e.isAbsent) continue;
        if (!wouldCreateConsecutiveOverLimit(days, allDates, holidays, dateStr, eventWorkDays)) {
          days[dateStr].shiftCode = "C";
          removed++;
        }
      }
    }
  }

  // 変化のあった職員をノートに記録
  const changed = targetIds.filter(id => countHolidays(assignments[id], allDates) !== before[id]);
  if (changed.length > 0) {
    const detail = changed.map(id =>
      `${id}番:${before[id]}→${countHolidays(assignments[id], allDates)}日`
    ).join(", ");
    notes.push({ date: null, type: "stage2_holiday",
      message: `[Stage2] 公休数調整（目標:${holidayCount}日）: ${detail}` });
  }
}

// 指定日リスト（全日程 or 稼働日）の公休「休」日数を数える
function countHolidays(days, dates) {
  if (!days) return 0;
  return dates.reduce((cnt, d) => {
    const e = days[d];
    return cnt + (e && e.shiftCode && HOLIDAY_CODES.includes(e.shiftCode) ? 1 : 0);
  }, 0);
}

// 公休相当数をカウント（「休」=1日、固定の半日シフト=0.5日）
function countHolidayEquivalent(days, dates) {
  if (!days) return 0;
  return dates.reduce((cnt, d) => {
    const e = days[d];
    if (!e || !e.shiftCode) return cnt;
    if (HOLIDAY_CODES.includes(e.shiftCode)) return cnt + 1;
    if (e.isFixed) {
      const st = getShiftType(e.shiftCode);
      if (st && st.halfDay) return cnt + 0.5;
    }
    return cnt;
  }, 0);
}

// 指定日を「休→勤務」に変えたとき5連勤超になるか確認
function wouldCreateConsecutiveOverLimit(days, allDates, holidays, dateStr, eventWorkDays) {
  const idx = allDates.indexOf(dateStr);
  if (idx < 0) return false;

  let back = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const d = allDates[i];
    if (isClosedDay(d, holidays) && (!eventWorkDays || !eventWorkDays.has(d))) break;
    const e = days[d];
    if (!e || !e.shiftCode || OFF_CODES.includes(e.shiftCode) || e.isAbsent) break;
    back++;
  }
  let forward = 0;
  for (let i = idx + 1; i < allDates.length; i++) {
    const d = allDates[i];
    if (isClosedDay(d, holidays) && (!eventWorkDays || !eventWorkDays.has(d))) break;
    const e = days[d];
    if (!e || !e.shiftCode || OFF_CODES.includes(e.shiftCode) || e.isAbsent) break;
    forward++;
  }
  return (back + 1 + forward) > 5;
}

// ────────────────────────────────────────────────
// STEP8: 早出・遅出回数の均等化（ステージ2）
// 対象: fairness=true の職員（1,2,3,6,7番）
// 9番・15番: 日勤(C)は配置基準外のため均等化対象外
// パート4番が日勤に入る日は実質的に常勤の日勤余裕が生まれるが、
// 明示的な最低人数制約がないため均等化ロジックに組み込まず自然に機能する。
// ────────────────────────────────────────────────
// notePrefix: ログ表示用プレフィックス（デフォルト "[Stage2]"）
// threshold: スワップ許容差分の最小値（デフォルト 2。1にすると差1でもスワップ可、max-min≤1で終了）
function step8BalanceEarlyLate(assignments, allDates, workDates, notes, notePrefix = "[Stage2]", threshold = 2) {
  const fairIds = STAFF_MASTER.filter(s => s.isAutoTarget && s.fairness).map(s => s.id);

  const earlyCounts = {};
  const lateCounts  = {};
  fairIds.forEach(id => { earlyCounts[id] = 0; lateCounts[id] = 0; });

  for (const dateStr of workDates) {
    for (const id of fairIds) {
      const e = assignments[id]?.[dateStr];
      if (!e || !e.shiftCode) continue;
      if (EARLY_CODES.includes(e.shiftCode)) earlyCounts[id]++;
      if (LATE_CODES.includes(e.shiftCode))  lateCounts[id]++;
    }
  }

  const beforeEarly = { ...earlyCounts };
  const beforeLate  = { ...lateCounts };

  // 早出均等化：A↔C スワップ（最大30パス）
  for (let pass = 0; pass < 30; pass++) {
    // threshold=1 時は max-min≤1 で均等達成とみなして終了（振動防止）
    if (threshold <= 1) {
      const mx = Math.max(...fairIds.map(id => earlyCounts[id]));
      const mn = Math.min(...fairIds.map(id => earlyCounts[id]));
      if (mx - mn <= 1) break;
    }
    let swapped = false;
    outer:
    for (const dateStr of workDates) {
      // この日にAを持つfairIds職員（非固定）を多い順に
      const donors = fairIds.filter(id => {
        const e = assignments[id]?.[dateStr];
        return e && EARLY_CODES.includes(e.shiftCode) && !e.isFixed;
      }).sort((a, b) => earlyCounts[b] - earlyCounts[a]);

      // この日にCを持つfairIds職員（非固定・早出可能）を少ない順に
      const receivers = fairIds.filter(id => {
        const e = assignments[id]?.[dateStr];
        return e && e.shiftCode === "C" && !e.isFixed &&
          canSwapToShift(assignments, id, dateStr, allDates, "early");
      }).sort((a, b) => earlyCounts[a] - earlyCounts[b]);

      for (const donor of donors) {
        for (const receiver of receivers) {
          if (donor === receiver) continue;
          if (earlyCounts[donor] - earlyCounts[receiver] < threshold) continue;
          doAssign(assignments[donor],   dateStr, "C");
          doAssign(assignments[receiver], dateStr, "A");
          earlyCounts[donor]--;
          earlyCounts[receiver]++;
          swapped = true;
          break outer;
        }
      }
    }
    if (!swapped) break;
  }

  // 遅出均等化：D↔C スワップ（最大30パス）
  for (let pass = 0; pass < 30; pass++) {
    // threshold=1 時は max-min≤1 で均等達成とみなして終了（振動防止）
    if (threshold <= 1) {
      const mx = Math.max(...fairIds.map(id => lateCounts[id]));
      const mn = Math.min(...fairIds.map(id => lateCounts[id]));
      if (mx - mn <= 1) break;
    }
    let swapped = false;
    outer:
    for (const dateStr of workDates) {
      const donors = fairIds.filter(id => {
        const e = assignments[id]?.[dateStr];
        return e && LATE_CODES.includes(e.shiftCode) && !e.isFixed;
      }).sort((a, b) => lateCounts[b] - lateCounts[a]);

      const receivers = fairIds.filter(id => {
        const e = assignments[id]?.[dateStr];
        return e && e.shiftCode === "C" && !e.isFixed &&
          canSwapToShift(assignments, id, dateStr, allDates, "late");
      }).sort((a, b) => lateCounts[a] - lateCounts[b]);

      for (const donor of donors) {
        for (const receiver of receivers) {
          if (donor === receiver) continue;
          if (lateCounts[donor] - lateCounts[receiver] < threshold) continue;
          doAssign(assignments[donor],   dateStr, "C");
          doAssign(assignments[receiver], dateStr, "D");
          lateCounts[donor]--;
          lateCounts[receiver]++;
          swapped = true;
          break outer;
        }
      }
    }
    if (!swapped) break;
  }

  // 変化をノートに記録
  const earlyChangedIds = fairIds.filter(id => earlyCounts[id] !== beforeEarly[id]);
  const lateChangedIds  = fairIds.filter(id => lateCounts[id]  !== beforeLate[id]);

  if (earlyChangedIds.length > 0 || lateChangedIds.length > 0) {
    const earlyDetail = fairIds.map(id =>
      `${id}番:${beforeEarly[id]}→${earlyCounts[id]}`
    ).join(", ");
    const lateDetail = fairIds.map(id =>
      `${id}番:${beforeLate[id]}→${lateCounts[id]}`
    ).join(", ");
    notes.push({ date: null, type: "stage2_balance",
      message: `${notePrefix} 早出均等化: ${earlyDetail}` });
    notes.push({ date: null, type: "stage2_balance",
      message: `${notePrefix} 遅出均等化: ${lateDetail}` });
  }
}

// step8 用: 既存シフトを無視してシフト変更可否を判定（固定セルと6番制約のみチェック）
function canSwapToShift(assignments, id, dateStr, allDates, category) {
  const days = assignments[id];
  const e    = days && days[dateStr];
  if (e && e.isFixed) return false;

  if (id === 6) {
    if (category === "early") {
      const prevDate = getPrevDate(dateStr, allDates);
      const prev = prevDate && days[prevDate];
      if (prev && prev.shiftCode && LATE_CODES.includes(prev.shiftCode)) return false;
    }
    if (category === "late") {
      const nextDate = getNextDate(dateStr, allDates);
      const next = nextDate && days[nextDate];
      if (next && next.shiftCode && EARLY_CODES.includes(next.shiftCode)) return false;
    }
  }
  return true;
}

// ────────────────────────────────────────────────
// STEP9: スワップによる違反解消最適化（最大200パス）
// 対象違反（優先度順）:
//   1. consecutive_days_exceeded (weight 10)
//   2. both_nurses_off (weight 8)
//   3. early_shortage (weight 6)
//   4. late_shortage (weight 4)
//   5. holiday_count_mismatch (weight 3)
//   6. nurse6_late_early_consecutive (weight 2)
// Type A: 同一日・異なる職員間スワップ（休系コード除外で公休数不変）
// Type B: 同一職員・稼働日間スワップ（休の位置移動含む）
// ────────────────────────────────────────────────
function step9OptimizeBySwap(assignments, allDates, workDates, holidays, holidayCount, eventWorkDays, violations, notes) {
  const targetIds = STAFF_MASTER
    .filter(s => s.isAutoTarget && !s.isFixed && s.type !== "part_nursery")
    .map(s => s.id);
  const fairIds = STAFF_MASTER.filter(s => s.fairness).map(s => s.id);

  const WEIGHTS = {
    consecutive_days_exceeded:    10,
    both_nurses_off:               8,
    early_shortage:                6,
    early_excess:                  6,
    late_shortage:                 4,
    late_excess:                   4,
    holiday_count_mismatch:        3,
    nurse6_late_early_consecutive: 2,
  };

  function detectViols() {
    return step9CollectViolations(assignments, allDates, workDates, holidays, holidayCount, eventWorkDays);
  }
  function scoreOf(vs) {
    return vs.reduce((s, v) => s + (WEIGHTS[v.type] || 1), 0);
  }
  function getCode(id, d) {
    const e = assignments[id]?.[d]; return e ? (e.shiftCode || null) : null;
  }
  function setCode(id, d, code) {
    if (!assignments[id]) return;
    ensureEntry(assignments[id], d);
    assignments[id][d].shiftCode = code;
  }
  function swappable(id, d) {
    const e = assignments[id]?.[d]; return !e || (!e.isFixed && !e.isAbsent);
  }

  let curScore = scoreOf(detectViols());
  const initialScore = curScore;
  let totalSwaps = 0;

  if (curScore === 0) {
    notes.push({ date: null, type: "step9_result",
      message: `[STEP9] 違反なし。スワップ不要。` });
    return;
  }

  for (let pass = 0; pass < 200 && curScore > 0; pass++) {
    let improved = false;

    // ─ Type A: 同一日・2職員間スワップ（公休数不変のため休系コードは除外）─
    outerA:
    for (const d of workDates) {
      for (let i = 0; i < targetIds.length; i++) {
        for (let j = i + 1; j < targetIds.length; j++) {
          const idA = targetIds[i], idB = targetIds[j];
          if (!swappable(idA, d) || !swappable(idB, d)) continue;
          const cA = getCode(idA, d), cB = getCode(idB, d);
          if (cA === cB) continue;
          if ((cA && HOLIDAY_CODES.includes(cA)) || (cB && HOLIDAY_CODES.includes(cB))) continue;

          setCode(idA, d, cB); setCode(idB, d, cA);
          const ns = scoreOf(detectViols());
          if (ns < curScore) { curScore = ns; totalSwaps++; improved = true; break outerA; }
          setCode(idA, d, cA); setCode(idB, d, cB);
        }
      }
    }

    if (improved) continue;

    // ─ Type C: 早出不足日のフェアメンバー非固定「休」を別日Cとスワップ後「A」化 ─
    outerC:
    for (const d of workDates) {
      let ecD = 0;
      for (const aid of Object.keys(assignments).map(Number)) {
        const e = assignments[aid]?.[d];
        if (e?.shiftCode && EARLY_CODES.includes(e.shiftCode)) ecD++;
      }
      if (ecD >= 2) continue;
      for (const id of fairIds) {
        if (!swappable(id, d)) continue;
        if (getCode(id, d) !== "休") continue;
        for (const d2 of workDates) {
          if (d2 === d) continue;
          if (!swappable(id, d2)) continue;
          if (getCode(id, d2) !== "C") continue;
          setCode(id, d, "A");
          setCode(id, d2, "休");
          const ns = scoreOf(detectViols());
          if (ns < curScore) { curScore = ns; totalSwaps++; improved = true; break outerC; }
          setCode(id, d, "休");
          setCode(id, d2, "C");
        }
      }
    }

    if (improved) continue;

    // ─ Type B: 同一職員・稼働日間スワップ（公休の位置変更含む）─
    outerB:
    for (const id of targetIds) {
      for (let i = 0; i < workDates.length; i++) {
        const dA = workDates[i];
        if (!swappable(id, dA)) continue;
        for (let j = i + 1; j < workDates.length; j++) {
          const dB = workDates[j];
          if (!swappable(id, dB)) continue;
          const cA = getCode(id, dA), cB = getCode(id, dB);
          if (cA === cB) continue;

          setCode(id, dA, cB); setCode(id, dB, cA);
          const ns = scoreOf(detectViols());
          if (ns < curScore) { curScore = ns; totalSwaps++; improved = true; break outerB; }
          setCode(id, dA, cA); setCode(id, dB, cB);
        }
      }
    }

    if (!improved) break;
  }

  const finalViols = detectViols();
  violations.length = 0;
  for (const v of finalViols) violations.push(v);

  notes.push({ date: null, type: "step9_result",
    message: `[STEP9] スワップ最適化: スコア ${initialScore} → ${curScore}（スワップ ${totalSwaps} 回）` });
  if (curScore > 0) {
    const byType = {};
    for (const v of finalViols) byType[v.type] = (byType[v.type] || 0) + 1;
    const detail = Object.entries(byType).map(([t, c]) => `${t}×${c}`).join(", ");
    notes.push({ date: null, type: "step9_unresolved",
      message: `[STEP9] 構造的問題（スワップ解消不可）: ${detail}` });
  }
}

// step9 専用の違反検出（副作用なし・step6Validate と同等）
function step9CollectViolations(assignments, allDates, workDates, holidays, holidayCount, eventWorkDays) {
  const viols = [];
  const nurseIds       = STAFF_MASTER.filter(s => s.type === "nurse" && s.isAutoTarget).map(s => s.id);
  const allAutoTargets = STAFF_MASTER.filter(s => s.isAutoTarget).map(s => s.id);
  const targetIds      = STAFF_MASTER
    .filter(s => s.isAutoTarget && !s.isFixed && s.type !== "part_nursery")
    .map(s => s.id);
  const allIds = Object.keys(assignments).map(Number);

  // 早出・遅出不足
  for (const d of workDates) {
    const isEvt = isClosedDay(d, holidays) &&
      Object.values(assignments).some(days => { const e = days?.[d]; return e && e.isFixed; });
    if (isEvt) continue;
    let ec = 0, lc = 0;
    for (const id of allIds) {
      const e = assignments[id]?.[d]; if (!e || !e.shiftCode) continue;
      if (EARLY_CODES.includes(e.shiftCode)) ec++;
      if (LATE_CODES.includes(e.shiftCode)) lc++;
    }
    if (ec < 2) viols.push({ date: d, type: "early_shortage", message: `${d}：早出${ec}名` });
    if (ec > 2) viols.push({ date: d, type: "early_excess",  excessCount: ec, message: `${d}：早出${ec}名（超過）` });
    if (lc < 2) viols.push({ date: d, type: "late_shortage", message: `${d}：遅出${lc}名` });
    if (lc > 2) viols.push({ date: d, type: "late_excess",   excessCount: lc, message: `${d}：遅出${lc}名（超過）` });
  }

  // 看護師同日休
  if (nurseIds.length >= 2) {
    for (const d of workDates) {
      const allOff = nurseIds.every(id => {
        const e = assignments[id]?.[d]; return !e || !e.shiftCode || OFF_CODES.includes(e.shiftCode);
      });
      if (allOff) {
        const allFixed = nurseIds.every(id => { const e = assignments[id]?.[d]; return e && e.isFixed; });
        if (!allFixed) viols.push({ date: d, type: "both_nurses_off", message: `${d}：看護師全員休み` });
      }
    }
  }

  // 6連勤超過
  for (const id of allAutoTargets) {
    const days = assignments[id]; if (!days) continue;
    let cons = 0;
    for (const d of allDates) {
      if (isClosedDay(d, holidays) && (!eventWorkDays || !eventWorkDays.has(d))) { cons = 0; continue; }
      const e = days[d];
      if ((e && e.shiftCode && OFF_CODES.includes(e.shiftCode)) || (e && e.isAbsent) || !e || !e.shiftCode) {
        cons = 0;
      } else {
        cons++;
        if (cons > 5) {
          viols.push({ date: d, type: "consecutive_days_exceeded", staffId: id,
            message: `職員${id}番:${d}で6連勤` });
          cons = 0;
        }
      }
    }
  }

  // 6番：遅出翌日早出
  const n6 = assignments[6];
  if (n6) {
    for (let i = 1; i < allDates.length; i++) {
      const pE = n6[allDates[i - 1]], cE = n6[allDates[i]];
      if (pE?.shiftCode && LATE_CODES.includes(pE.shiftCode) &&
          cE?.shiftCode && EARLY_CODES.includes(cE.shiftCode))
        viols.push({ date: allDates[i], type: "nurse6_late_early_consecutive",
          message: `${allDates[i]}：6番遅出翌日早出` });
    }
  }

  // 公休数ずれ
  for (const id of targetIds) {
    const cnt = countHolidays(assignments[id], allDates);
    if (Math.abs(cnt - holidayCount) >= 1)
      viols.push({ date: null, type: "holiday_count_mismatch", staffId: id,
        message: `職員${id}番：公休${cnt}日（目標${holidayCount}日）` });
  }

  return viols;
}

// ────────────────────────────────────────────────
// STEP6: 最終検証
// 9番・15番が日勤(C)の場合は配置基準カウントに含めない。
// 早出/遅出カウントは EARLY_CODES/LATE_CODES のみで判定するため自動的に除外される。
// ────────────────────────────────────────────────
function step6Validate(assignments, allDates, workDates, holidays, violations, eventWorkDays) {
  const nurseIds       = STAFF_MASTER.filter(s => s.type === "nurse" && s.isAutoTarget).map(s => s.id);
  const allAutoTargets = STAFF_MASTER.filter(s => s.isAutoTarget).map(s => s.id);
  // フェアメンバー: structural_shortage 判定に使用（1・2・6・7番）
  const fairIds        = STAFF_MASTER.filter(s => s.isAutoTarget && s.fairness).map(s => s.id);

  for (const dateStr of workDates) {
    // 早出不足チェック（全職員対象 — 9番・15番がAなら含む）
    let earlyCount = 0;
    for (const id of Object.keys(assignments).map(Number)) {
      const e = assignments[id]?.[dateStr];
      if (e && e.shiftCode && EARLY_CODES.includes(e.shiftCode)) earlyCount++;
    }
    // イベント出勤日（isClosedDay=true かつ固定セルが1件以上）は早出・遅出不足をカウントしない
    const isEventDay = isClosedDay(dateStr, holidays) &&
      Object.values(assignments).some(days => {
        const e = days && days[dateStr];
        return e && e.isFixed;
      });

    if (!isEventDay && earlyCount < 2) {
      // フェアメンバー中に「非固定・非休・非不在かつ早出変更可能」な職員が1名でもいるか判定
      // 遅出中の職員を早出に変えると遅出不足が発生するため除外する
      const canResolveEarlyBySwap = fairIds.some(id => {
        const e = assignments[id]?.[dateStr];
        if (!e || e.isFixed || e.isAbsent) return false;
        if (!e.shiftCode || HOLIDAY_CODES.includes(e.shiftCode) || OFF_CODES.includes(e.shiftCode)) return false;
        if (EARLY_CODES.includes(e.shiftCode)) return false; // 既に早出
        if (LATE_CODES.includes(e.shiftCode)) return false;  // 遅出→早出変換は遅出不足を招く
        return canSwapToShift(assignments, id, dateStr, allDates, "early");
      });
      violations.push({ date: dateStr,
        type: canResolveEarlyBySwap ? "early_shortage" : "structural_early_shortage",
        earlyCount,
        message: canResolveEarlyBySwap
          ? `${dateStr}：早出が ${earlyCount} 名（最低2名必要）`
          : `${dateStr}：早出が ${earlyCount} 名（最低2名必要）【テンプレート要見直し】`
      });
    }
    if (!isEventDay && earlyCount > 2) {
      violations.push({ date: dateStr, type: "early_excess", excessCount: earlyCount,
        message: `${dateStr}：早出が ${earlyCount} 名（2名超過）` });
    }

    // 遅出不足チェック（全職員対象 — 9番・15番がDなら含む）
    let lateCount = 0;
    for (const id of Object.keys(assignments).map(Number)) {
      const e = assignments[id]?.[dateStr];
      if (e && e.shiftCode && LATE_CODES.includes(e.shiftCode)) lateCount++;
    }
    if (!isEventDay && lateCount < 2) {
      // フェアメンバー中に「非固定・非休・非不在かつ遅出変更可能」な職員が1名でもいるか判定
      // 早出中の職員を遅出に変えると早出不足が発生するため除外する
      const canResolveLatBySwap = fairIds.some(id => {
        const e = assignments[id]?.[dateStr];
        if (!e || e.isFixed || e.isAbsent) return false;
        if (!e.shiftCode || HOLIDAY_CODES.includes(e.shiftCode) || OFF_CODES.includes(e.shiftCode)) return false;
        if (LATE_CODES.includes(e.shiftCode)) return false;  // 既に遅出
        if (EARLY_CODES.includes(e.shiftCode)) return false; // 早出→遅出変換は早出不足を招く
        return canSwapToShift(assignments, id, dateStr, allDates, "late");
      });
      violations.push({ date: dateStr,
        type: canResolveLatBySwap ? "late_shortage" : "structural_late_shortage",
        message: canResolveLatBySwap
          ? `${dateStr}：遅出が ${lateCount} 名（最低2名必要）`
          : `${dateStr}：遅出が ${lateCount} 名（最低2名必要）【テンプレート要見直し】`,
        lateCount
      });
    }
    if (!isEventDay && lateCount > 2) {
      violations.push({ date: dateStr, type: "late_excess", excessCount: lateCount,
        message: `${dateStr}：遅出が ${lateCount} 名（2名超過）` });
    }

    // 看護師2名同時休チェック
    // ただし全員の「休」が赤文字固定（isFixed=true）の場合は変更不可のため違反報告から除外する
    if (nurseIds.length >= 2) {
      const allNursesOff = nurseIds.every(id => {
        const e = assignments[id] && assignments[id][dateStr];
        return !e || !e.shiftCode || OFF_CODES.includes(e.shiftCode);
      });
      if (allNursesOff) {
        const allFixed = nurseIds.every(id => {
          const e = assignments[id] && assignments[id][dateStr];
          return e && e.isFixed;
        });
        if (!allFixed) {
          violations.push({ date: dateStr, type: "both_nurses_off",
            message: `${dateStr}：看護師が全員休み（同日休は不可）` });
        }
      }
    }
  }

  // 6連勤チェック
  for (const id of allAutoTargets) {
    const days = assignments[id];
    if (!days) continue;
    let consecutive = 0;
    let runStart = null;
    for (const dateStr of allDates) {
      // 通常の休園日はリセット。イベント出勤日は稼働日として連勤カウントを継続。
      if (isClosedDay(dateStr, holidays) && (!eventWorkDays || !eventWorkDays.has(dateStr))) {
        consecutive = 0; runStart = null; continue;
      }
      const e = days[dateStr];
      const isOff     = e && e.shiftCode && OFF_CODES.includes(e.shiftCode);
      const isAbsent  = e && e.isAbsent;
      const isNoShift = !e || !e.shiftCode;
      if (isOff || isAbsent || isNoShift) { consecutive = 0; runStart = null; }
      else {
        if (consecutive === 0) runStart = dateStr;
        consecutive++;
        if (consecutive > 5) {
          violations.push({ date: dateStr, type: "consecutive_days_exceeded", staffId: id,
            runStart,
            message: `職員${id}番：${dateStr}で6連勤以上（上限5連勤）` });
          consecutive = 0; runStart = null;
        }
      }
    }
  }

  // 6番看護師：遅出翌日早出チェック
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
        violations.push({ date: curDate, type: "nurse6_late_early_consecutive",
          prevDate,
          message: `${curDate}：6番看護師が遅出翌日に早出（制約違反）` });
      }
    }
  }
}

// ────────────────────────────────────────────────
// STEP10: 構造的遅出不足への15番投入（例外処理）
// structural_late_shortage 日のみ対象。STEP2/3/9では15番を遅出に使わない。
// staffMaster.js の15番定義は変更しない。
// ────────────────────────────────────────────────
function step10UseStaff15ForLate(assignments, allDates, workDates, holidays, holidayCount, eventWorkDays, violations, notes) {
  const structuralLateDates = violations
    .filter(v => v.type === "structural_late_shortage")
    .map(v => v.date).filter(d => d !== null);
  if (structuralLateDates.length === 0) return;

  const fairIds = STAFF_MASTER.filter(s => s.isAutoTarget && s.fairness).map(s => s.id);
  const recruitOrder = [15, ...fairIds]; // 15番を最優先、次にフェアメンバー

  for (const dateStr of structuralLateDates) {
    // changedCells エントリ：{ sid, d, oldVal, swapDate?, swapOldVal?, suppId?, suppDate?, suppOldVal? }
    const changedCells = [];

    for (const staffId of recruitOrder) {
      if (countLateOnDate(assignments, dateStr) >= 2) break;

      const staffDays = assignments[staffId];
      if (!staffDays) continue;

      const e = staffDays[dateStr];
      if (e && (e.isFixed || e.isAbsent)) continue;

      // 15番のみ：前日が遅出の場合は遅出不可（連続遅出制約）
      if (staffId === 15) {
        const prevDate = getPrevDate(dateStr, allDates);
        const prev = prevDate && staffDays[prevDate];
        if (prev && prev.shiftCode && LATE_CODES.includes(prev.shiftCode)) continue;
      }

      // 6番制約：翌日が早出の場合は遅出不可
      if (staffId === 6) {
        const nextDate = getNextDate(dateStr, allDates);
        const next = nextDate && staffDays[nextDate];
        if (next && next.shiftCode && EARLY_CODES.includes(next.shiftCode)) continue;
      }

      const currentShift = e ? e.shiftCode : null;

      if (!currentShift || currentShift === "C") {
        // ── Case A: C/空 → D ──
        changedCells.push({ sid: staffId, d: dateStr, oldVal: e ? { ...e } : null }); // push前にeはまだ未変更
        doAssign(staffDays, dateStr, "D");

      } else if (HOLIDAY_CODES.includes(currentShift)) {
        // ── Case B: 休 → 別日非固定CとスワップしてD ──
        const eOrig = e ? { ...e } : null;
        const swapCandidates = workDates
          .filter(d => {
            if (d === dateStr) return false;
            const ec = staffDays[d];
            return ec && ec.shiftCode === "C" && !ec.isFixed && !ec.isAbsent;
          })
          .sort((a, b) =>
            minDistToClosedDay(b, allDates, holidays, eventWorkDays) -
            minDistToClosedDay(a, allDates, holidays, eventWorkDays)
          );

        for (const swapDate of swapCandidates) {
          const eSw = staffDays[swapDate] ? { ...staffDays[swapDate] } : null;
          doAssign(staffDays, dateStr,  "D");
          doAssign(staffDays, swapDate, "休");

          if (!checkConsecutiveExceeded(staffDays, allDates, holidays, eventWorkDays)) {
            changedCells.push({ sid: staffId, d: dateStr, oldVal: eOrig, swapDate, swapOldVal: eSw });
            break;
          }

          // 連勤超過 → 元に戻して次の候補へ
          if (eOrig) staffDays[dateStr]  = { ...eOrig };
          else       delete staffDays[dateStr];
          if (eSw)   staffDays[swapDate] = { ...eSw };
          else       delete staffDays[swapDate];
        }

      } else if (EARLY_CODES.includes(currentShift)) {
        // ── Case C: A → D（早出減→遅出増）早出不足は9番/15番で補充 ──
        // 補充パターン1: suppId[dateStr]=C → そのままA割当
        // 補充パターン2: suppId[dateStr]=非固定休 → 別日Cへ休移動してA割当（休シャッフル補充）
        const eOrig       = e ? { ...e } : null; // doAssign前に確保
        const earlyBefore = countEarlyOnDate(assignments, dateStr);
        const earlyAfter  = earlyBefore - 1;

        if (earlyAfter >= 2) {
          // 早出が余裕あり：補充不要でA→D
          changedCells.push({ sid: staffId, d: dateStr, oldVal: eOrig });
          doAssign(staffDays, dateStr, "D");
        } else {
          // 早出が不足（earlyAfter=1）→ 補充者を探す（9番→15番の順）
          let caseCSolved = false;
          for (const suppId of [9, 15]) {
            if (caseCSolved) break;
            const suppDays = assignments[suppId];
            if (!suppDays) continue;
            const suppE = suppDays[dateStr];
            if (!suppE || suppE.isFixed || suppE.isAbsent) continue;
            const sc = suppE.shiftCode;

            if (!sc || sc === "C") {
              // パターン1: C/空 → 直接A補充
              changedCells.push({ sid: staffId, d: dateStr, oldVal: eOrig,
                                   suppId, suppDate: dateStr, suppOldVal: { ...suppE } });
              doAssign(staffDays, dateStr, "D");
              doAssign(suppDays,  dateStr, "A");
              caseCSolved = true;

            } else if (HOLIDAY_CODES.includes(sc)) {
              // パターン2: 休シャッフル → suppId[dateStr]=休→A + suppId[swapDay]=C→休
              const suppSwapCandidates = workDates.filter(d => {
                if (d === dateStr) return false;
                const ec = suppDays[d];
                return ec && ec.shiftCode === "C" && !ec.isFixed && !ec.isAbsent;
              });

              const suppOldVal = { ...suppE }; // doAssign前に確保

              for (const suppSwapDate of suppSwapCandidates) {
                const suppSwapOldVal = suppDays[suppSwapDate] ? { ...suppDays[suppSwapDate] } : null;

                doAssign(suppDays,  dateStr,      "A");
                doAssign(suppDays,  suppSwapDate, "休");
                doAssign(staffDays, dateStr,      "D");

                if (!checkConsecutiveExceeded(suppDays, allDates, holidays, eventWorkDays)) {
                  changedCells.push({ sid: staffId, d: dateStr, oldVal: eOrig,
                                       suppId, suppDate: dateStr, suppOldVal,
                                       suppSwapDate, suppSwapOldVal });
                  caseCSolved = true;
                  break;
                }

                // 連勤超過 → 全変更を元に戻す
                suppDays[dateStr] = { ...suppOldVal };
                if (suppSwapOldVal) suppDays[suppSwapDate] = { ...suppSwapOldVal };
                else delete suppDays[suppSwapDate];
                if (eOrig) staffDays[dateStr] = { ...eOrig };
                else delete staffDays[dateStr];
              }
            }
          }
          // caseCSolved=false → 補充者なし → 変更せず
        }
      }
      // D/その他はスキップ
    }

    const finalLateCount = countLateOnDate(assignments, dateStr);
    if (finalLateCount >= 2 && changedCells.length > 0) {
      // 解消成功：変更内容をnotesに記録
      const parts = changedCells.map(c => {
        const from = c.oldVal ? (c.oldVal.shiftCode || "空") : "空";
        if (c.suppId && c.suppSwapDate) {
          return `${c.sid}番(${from}→D、${c.suppId}番が早出補充＋休→${c.suppSwapDate}移動)`;
        } else if (c.suppId) {
          return `${c.sid}番(${from}→D、${c.suppId}番が早出補充)`;
        } else if (c.swapDate) {
          return `${c.sid}番(${from}→D、${c.swapDate}に休移動)`;
        } else {
          return `${c.sid}番(${from}→D)`;
        }
      });
      notes.push({ date: dateStr, type: "step10_late_resolved",
        message: `${dateStr}：[STEP10] ${parts.join('、')} で遅出不足を解消` });
    } else {
      // 解消できず → changedCellsの変更をすべて元に戻す（逆順）
      for (const c of changedCells.slice().reverse()) {
        const { sid, d, oldVal, swapDate, swapOldVal, suppId, suppDate, suppOldVal, suppSwapDate, suppSwapOldVal } = c;
        if (oldVal) assignments[sid][d] = { ...oldVal };
        else        delete assignments[sid][d];
        if (swapDate) {
          if (swapOldVal) assignments[sid][swapDate] = { ...swapOldVal };
          else            delete assignments[sid][swapDate];
        }
        if (suppId && suppDate) {
          if (suppSwapDate) {
            if (suppSwapOldVal) assignments[suppId][suppSwapDate] = { ...suppSwapOldVal };
            else                delete assignments[suppId][suppSwapDate];
          }
          if (suppOldVal) assignments[suppId][suppDate] = { ...suppOldVal };
          else            delete assignments[suppId][suppDate];
        }
      }
    }
  }
  // violations の最終更新は runScheduler での step6Validate 再実行で行う
}

// 指定日の遅出人数を全職員分カウント
function countLateOnDate(assignments, dateStr) {
  let count = 0;
  for (const id of Object.keys(assignments).map(Number)) {
    const e = assignments[id]?.[dateStr];
    if (e && e.shiftCode && LATE_CODES.includes(e.shiftCode)) count++;
  }
  return count;
}

// 指定日の早出人数を全職員分カウント
function countEarlyOnDate(assignments, dateStr) {
  let count = 0;
  for (const id of Object.keys(assignments).map(Number)) {
    const e = assignments[id]?.[dateStr];
    if (e && e.shiftCode && EARLY_CODES.includes(e.shiftCode)) count++;
  }
  return count;
}

// 職員の連勤が5日超になるか確認（5超=true）
function checkConsecutiveExceeded(days, allDates, holidays, eventWorkDays) {
  let cons = 0;
  for (const d of allDates) {
    if (isClosedDay(d, holidays) && (!eventWorkDays || !eventWorkDays.has(d))) { cons = 0; continue; }
    const e = days[d];
    if ((e && e.shiftCode && OFF_CODES.includes(e.shiftCode)) || (e && e.isAbsent) || !e || !e.shiftCode) {
      cons = 0;
    } else {
      cons++;
      if (cons > 5) return true;
    }
  }
  return false;
}

// ────────────────────────────────────────────────
// ユーティリティ
// ────────────────────────────────────────────────

function canAssignShift(days, staffId, dateStr, allDates, category) {
  if (!days) return false;
  const e = days[dateStr];
  if (e && (e.isFixed || e.isAbsent || e.shiftCode)) return false;

  if (staffId === 6) {
    if (category === "early") {
      const prevDate = getPrevDate(dateStr, allDates);
      const prev = prevDate && days[prevDate];
      if (prev && prev.shiftCode && LATE_CODES.includes(prev.shiftCode)) return false;
    }
    if (category === "late") {
      const nextDate = getNextDate(dateStr, allDates);
      const next = nextDate && days[nextDate];
      if (next && next.shiftCode && EARLY_CODES.includes(next.shiftCode)) return false;
    }
  }
  return true;
}

function getPrevDate(dateStr, allDates) {
  const idx = allDates.indexOf(dateStr);
  return idx > 0 ? allDates[idx - 1] : null;
}

function getNextDate(dateStr, allDates) {
  const idx = allDates.indexOf(dateStr);
  return (idx >= 0 && idx < allDates.length - 1) ? allDates[idx + 1] : null;
}

function doAssign(days, dateStr, shiftCode) {
  ensureEntry(days, dateStr);
  days[dateStr].shiftCode = shiftCode;
}

function ensureEntry(days, dateStr) {
  if (!days[dateStr]) {
    days[dateStr] = { shiftCode: null, isFixed: false, isAbsent: false };
  }
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// イベント出勤日を検出する：isClosedDay=true かつ固定セル（赤文字）が1件以上ある日
function getEventWorkDays(assignments, allDates, holidays) {
  return new Set(allDates.filter(dateStr => {
    if (!isClosedDay(dateStr, holidays)) return false;
    return Object.values(assignments).some(days => {
      const e = days && days[dateStr];
      return e && e.isFixed;
    });
  }));
}
