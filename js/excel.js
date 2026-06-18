// Excel読み書き（SheetJS使用）
// 元ファイルを保持し、確定したセル値のみ上書きする

// Excelの列番号と日付の対応
// 列4(D列) = 1日目、列34(AH列) = 31日目
const COL_DAY_OFFSET = 4; // 1日目が何列目か
const ROW_STAFF_OFFSET = 5; // 1番職員が何行目か（行5）
const COL_STAFF_ID = 1; // 職員番号の列

let _workbook = null; // 読み込んだワークブックを保持

function loadExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        _workbook = XLSX.read(e.target.result, {
          type: "array",
          cellStyles: true,
          cellNF: true,
        });
        const parsed = parseScheduleSheet(_workbook);
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function parseScheduleSheet(wb) {
  const ws = wb.Sheets["Sheet1"];
  if (!ws) throw new Error("Sheet1が見つかりません");

  const range = XLSX.utils.decode_range(ws["!ref"]);
  const maxRow = range.e.r + 1;
  const maxCol = range.e.c + 1;

  // 年月の取得（B1セル）
  const yearMonthCell = ws[XLSX.utils.encode_cell({ r: 0, c: 1 })];
  let year = null, month = null;
  if (yearMonthCell && yearMonthCell.v instanceof Date) {
    year  = yearMonthCell.v.getFullYear();
    month = yearMonthCell.v.getMonth() + 1;
  } else if (yearMonthCell) {
    const d = XLSX.SSF.parse_date_code(yearMonthCell.v);
    if (d) { year = d.y; month = d.m; }
  }

  // 月の日数
  const daysInMonth = new Date(year, month, 0).getDate();

  // 職員ごとのシフトデータを取得
  const staffShifts = {};

  for (let r = ROW_STAFF_OFFSET - 1; r < maxRow; r++) {
    const idCell = ws[XLSX.utils.encode_cell({ r, c: COL_STAFF_ID - 1 })];
    if (!idCell || typeof idCell.v !== "number") continue;

    const staffId = idCell.v;
    staffShifts[staffId] = {};

    for (let d = 1; d <= daysInMonth; d++) {
      const col = COL_DAY_OFFSET - 1 + (d - 1);
      const cell = ws[XLSX.utils.encode_cell({ r, c: col })];
      const dateStr = toDateStr(new Date(year, month - 1, d));

      let shiftCode = null;
      let isFixed = false;
      let isAbsent = false;

      if (cell) {
        shiftCode = cell.v !== undefined ? String(cell.v) : null;

        // 赤文字セル判定（固定）
        if (cell.s && cell.s.font && cell.s.font.color) {
          const rgb = cell.s.font.color.rgb || "";
          if (rgb === "FFFF0000") isFixed = true;
        }

        // オレンジ背景セル判定（9番の他拠点勤務日→空白のまま残す）
        if (staffId === 9 && cell.s && cell.s.fill) {
          const fgColor = (cell.s.fill.fgColor || {}).rgb || "";
          // オレンジ系色（FFA500付近）を判定
          if (/^FF[A-F0-9]{2}[3-8][0-9A-F]00$/i.test(fgColor) || fgColor === "FFFFA500") {
            isAbsent = true;
            shiftCode = null;
          }
        }
      }

      // 赤文字以外のシフト値はすべてクリア（全職員共通：赤文字のみ固定）
      if (!isFixed) shiftCode = null;

      staffShifts[staffId][dateStr] = { shiftCode, isFixed, isAbsent };
    }
  }

  return { year, month, daysInMonth, staffShifts };
}

function writeExcel(scheduleResult) {
  if (!_workbook) throw new Error("Excelが読み込まれていません");

  const ws = _workbook.Sheets["Sheet1"];
  const { year, month, assignments } = scheduleResult;
  const daysInMonth = new Date(year, month, 0).getDate();

  // 行3（日付ヘッダ）の29〜31日目が誤った値になるテンプレートバグを修正
  // 列D〜AH（index 3〜33）に対して正しいExcelシリアル日付を書き込む
  const ROW_DATE_IDX = 2; // 0-indexed（Excel行3）
  const day1Addr = XLSX.utils.encode_cell({ r: ROW_DATE_IDX, c: COL_DAY_OFFSET - 1 });
  const zFmt = ws[day1Addr] && ws[day1Addr].z ? ws[day1Addr].z : null;
  const epochUTC = Date.UTC(1899, 11, 30); // Excelシリアル起点
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
    const col    = COL_DAY_OFFSET - 1 + (dayNum - 1);
    const addr   = XLSX.utils.encode_cell({ r: ROW_DATE_IDX, c: col });
    const serial = (Date.UTC(year, month - 1, dayNum) - epochUTC) / 86400000;
    if (!ws[addr]) ws[addr] = {};
    ws[addr].v = serial;
    ws[addr].t = "n";
    if (zFmt) ws[addr].z = zFmt;
    delete ws[addr].w;
  }

  // 職員行番号のマップを構築
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const staffRowMap = {};
  for (let r = ROW_STAFF_OFFSET - 1; r <= range.e.r; r++) {
    const idCell = ws[XLSX.utils.encode_cell({ r, c: COL_STAFF_ID - 1 })];
    if (idCell && typeof idCell.v === "number") {
      staffRowMap[idCell.v] = r;
    }
  }

  // 確定シフトをセルに書き込み（固定・不在セルは触らない）
  for (const [staffId, days] of Object.entries(assignments)) {
    const r = staffRowMap[Number(staffId)];
    if (r === undefined) continue;

    for (const [dateStr, entry] of Object.entries(days)) {
      if (entry.isFixed || entry.isAbsent) continue; // 固定セルは変更しない
      if (!entry.shiftCode) continue;

      const d = parseInt(dateStr.split("-")[2], 10);
      const col = COL_DAY_OFFSET - 1 + (d - 1);
      const cellAddr = XLSX.utils.encode_cell({ r, c: col });

      if (!ws[cellAddr]) ws[cellAddr] = {};
      ws[cellAddr].v = entry.shiftCode;
      ws[cellAddr].t = "s";
    }
  }

  const wbout = XLSX.write(_workbook, { bookType: "xlsx", type: "array", cellStyles: true });
  return wbout;
}

function downloadExcel(wbout, year, month) {
  const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `勤務表_${year}${String(month).padStart(2,'0')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
