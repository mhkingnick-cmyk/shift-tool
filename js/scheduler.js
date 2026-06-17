// 自動割当ロジック（骨格のみ。各STEPは今後実装）

function runScheduler(parsed, params) {
  const { year, month, daysInMonth, staffShifts } = parsed;
  const { holidayCount, medicalCareChildren } = params;

  const holidays = getJapaneseHolidays(year);
  const violations = [];

  // 割当作業用データ（staffShiftsをディープコピーして操作）
  const assignments = deepCopy(staffShifts);

  // 自動割当対象職員のIDリスト
  const targetStaff = STAFF_MASTER.filter(s => s.isAutoTarget && !s.isFixed);

  // 日付リスト（休園日を除く稼働日）
  const workDates = [];
  const allDates  = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = toDateStr(new Date(year, month - 1, d));
    allDates.push(dateStr);
    if (!isClosedDay(dateStr, holidays)) workDates.push(dateStr);
  }

  // STEP0: 前処理（固定セル・3番の全日固定・オレンジセルをマーク）
  // ※ parseScheduleSheet() で isFixed / isAbsent は設定済み
  // 3番は全日固定
  for (const dateStr of allDates) {
    if (assignments[3] && assignments[3][dateStr]) {
      assignments[3][dateStr].isFixed = true;
    }
  }

  // STEP1〜7はこれから実装
  // TODO: STEP1 公休割当
  // TODO: STEP2 早出割当
  // TODO: STEP3 遅出割当
  // TODO: STEP4 医療的ケア児看護師配置
  // TODO: STEP5 日勤割当
  // TODO: STEP6 制約検証
  // TODO: STEP7 出力準備

  return { year, month, assignments, violations };
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}
