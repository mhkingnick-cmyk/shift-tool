// シフトマスタ
const SHIFT_TYPES = [
  { code: "A",   startH: 7,  startM: 0,  endH: 16, endM: 0,  category: "early", halfDay: false, partOnly: false },
  { code: "A1",  startH: 7,  startM: 0,  endH: 11, endM: 0,  category: "early", halfDay: true,  partOnly: false },
  { code: "A2",  startH: 12, startM: 0,  endH: 16, endM: 0,  category: "day",   halfDay: true,  partOnly: false },
  { code: "B",   startH: 8,  startM: 0,  endH: 17, endM: 0,  category: "day",   halfDay: false, partOnly: false },
  { code: "B1",  startH: 8,  startM: 0,  endH: 12, endM: 0,  category: "day",   halfDay: true,  partOnly: false },
  { code: "C",   startH: 8,  startM: 30, endH: 17, endM: 30, category: "day",   halfDay: false, partOnly: false },
  { code: "C1",  startH: 8,  startM: 30, endH: 12, endM: 30, category: "day",   halfDay: true,  partOnly: false },
  { code: "C2",  startH: 13, startM: 30, endH: 17, endM: 30, category: "day",   halfDay: true,  partOnly: false },
  { code: "D",   startH: 9,  startM: 0,  endH: 18, endM: 0,  category: "late",  halfDay: false, partOnly: false },
  { code: "D1",  startH: 14, startM: 0,  endH: 18, endM: 0,  category: "late",  halfDay: true,  partOnly: false },
  { code: "E",   startH: 9,  startM: 30, endH: 18, endM: 30, category: "late",  halfDay: false, partOnly: false },
  { code: "E1",  startH: 14, startM: 30, endH: 18, endM: 30, category: "late",  halfDay: true,  partOnly: false },
  { code: "F",   startH: 10, startM: 0,  endH: 19, endM: 0,  category: "late",  halfDay: false, partOnly: false },
  { code: "P1",  startH: 8,  startM: 0,  endH: 13, endM: 0,  category: "day",   halfDay: false, partOnly: true  },
  { code: "P2",  startH: 8,  startM: 0,  endH: 16, endM: 0,  category: "day",   halfDay: false, partOnly: true  },
  { code: "P3",  startH: 9,  startM: 0,  endH: 15, endM: 0,  category: "day",   halfDay: false, partOnly: true  },
  { code: "休",  startH: null, startM: null, endH: null, endM: null, category: "off", halfDay: false, partOnly: false },
  { code: "有",  startH: null, startM: null, endH: null, endM: null, category: "off", halfDay: false, partOnly: false },
];

// 早出帯（7:00〜8:30）をカバーするシフトコード
const EARLY_CODES = ["A", "A1"];

// 遅出帯（17:30〜18:00）をカバーするシフトコード
const LATE_CODES = ["D", "D1", "E", "E1", "F"];

// 公休扱いコード
const OFF_CODES = ["休", "有"];

// 公休カウント・スワップ保護対象コード（OFF_CODES と同義）
const HOLIDAY_CODES = ["休", "有"];

function getShiftType(code) {
  return SHIFT_TYPES.find(s => s.code === code) || null;
}

// 指定した時間帯（startH:startM〜endH:endM）をカバーするシフトかどうか
function coversTimeRange(shiftCode, rangeStartH, rangeStartM, rangeEndH, rangeEndM) {
  const s = getShiftType(shiftCode);
  if (!s || s.startH === null) return false;
  const shiftStart = s.startH * 60 + s.startM;
  const shiftEnd   = s.endH   * 60 + s.endM;
  const rangeStart = rangeStartH * 60 + rangeStartM;
  const rangeEnd   = rangeEndH   * 60 + rangeEndM;
  return shiftStart <= rangeStart && shiftEnd >= rangeEnd;
}
