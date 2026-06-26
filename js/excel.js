// Excel読み書き（SheetJS + 直接ZIP操作）
// SheetJS 0.20.x は cellStyles:true でのフォント色書き込みが機能しないため、
// 元ファイルの sheet1.xml を DOMParser で直接編集して ZIP を再構築する。

const COL_DAY_OFFSET  = 4; // 1日目の列インデックス（1-based）
const ROW_STAFF_OFFSET = 5; // 最初の職員の行インデックス（1-based）
const COL_STAFF_ID    = 1; // 職員番号の列

let _workbook       = null; // SheetJS ワークブック（値の読み取りに使用）
let _buffer         = null; // 元ファイルの ArrayBuffer（ZIP 再構築のベースに使用）
let _originalSheetXml = null; // 元 sheet1.xml の文字列
let _cellStyleMap   = null; // セルアドレス → CellXf インデックス
let _orangeXfSet    = null; // オレンジ系背景の CellXf インデックス集合（structural_shortage マーキング用）

// ────────────────────────────────────────────────
// 公開 API
// ────────────────────────────────────────────────

function loadExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      (async () => {
        try {
          _buffer = e.target.result;
          _workbook = XLSX.read(new Uint8Array(_buffer), {
            type: "array",
            cellStyles: true,
            cellNF: true,
          });

          // xlsxをZIPとして直接パースし sheet1.xml とスタイル情報を取得する。
          // SheetJS は cellStyles:true でもフォント色を cell.s に含まないため直接取得が必要。
          _originalSheetXml = await extractFileFromXlsx(_buffer, "xl/worksheets/sheet1.xml");
          const { redXfSet, orangeXfSet, cellStyleMap } = buildStyleInfo(_workbook, _originalSheetXml);
          _cellStyleMap = cellStyleMap;
          _orangeXfSet  = orangeXfSet;

          const parsed = parseScheduleSheet(_workbook, redXfSet, orangeXfSet, cellStyleMap);
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      })();
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function writeExcel(scheduleResult) {
  if (!_workbook || !_buffer || !_originalSheetXml) {
    throw new Error("Excelが読み込まれていません");
  }

  const { year, month, assignments } = scheduleResult;
  const daysInMonth = new Date(year, month, 0).getDate();

  // ① 職員番号 → Excel 行インデックス（0-based）のマップを SheetJS から構築
  const ws = _workbook.Sheets["Sheet1"];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const staffRowMap = {}; // staffId → 0-based row index
  for (let r = ROW_STAFF_OFFSET - 1; r <= range.e.r; r++) {
    const idCell = ws[XLSX.utils.encode_cell({ r, c: COL_STAFF_ID - 1 })];
    if (idCell && typeof idCell.v === "number") staffRowMap[idCell.v] = r;
  }

  // ② 元の sheet1.xml を DOM で編集
  const parser = new DOMParser();
  const doc    = parser.parseFromString(_originalSheetXml, "application/xml");

  // 日付ヘッダ行（行3、0-based=2）の 29〜31 日目をテンプレートバグ修正のため再書き込み
  const EPOCH_UTC = Date.UTC(1899, 11, 30);
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
    const col     = COL_DAY_OFFSET - 1 + (dayNum - 1); // 0-based
    const serial  = (Date.UTC(year, month - 1, dayNum) - EPOCH_UTC) / 86400000;
    const addr    = XLSX.utils.encode_cell({ r: 2, c: col }); // 行3（0-based 2）
    const cellEl  = findOrCreateCell(doc, 3, col + 1, addr); // 1-based row/col
    setNumericCell(doc, cellEl, serial);
  }

  // 割当済みシフトを書き込む（固定・不在セルはスキップ）
  for (const [staffId, days] of Object.entries(assignments)) {
    const rowIdx = staffRowMap[Number(staffId)]; // 0-based
    if (rowIdx === undefined) continue;
    const rowNum = rowIdx + 1; // 1-based（XML の r 属性）

    for (const [dateStr, entry] of Object.entries(days)) {
      if (entry.isFixed || entry.isAbsent) continue;
      if (!entry.shiftCode) continue;

      const d   = parseInt(dateStr.split("-")[2], 10);
      const col = COL_DAY_OFFSET - 1 + (d - 1); // 0-based
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c: col });

      const cellEl = findOrCreateCell(doc, rowNum, col + 1, addr);
      setStringCell(doc, cellEl, entry.shiftCode);
    }
  }

  // structural_shortage 日の曜日行（行4）に「曜日★」マーカーを書き込む
  // test_report.py は行3の日付シリアルから曜日を計算するため、行4への書き込みは解析に影響しない
  const DOW_LABELS = ["日","月","火","水","木","金","土"];
  const structuralDates = new Set(
    (scheduleResult.violations || [])
      .filter(v => v.type === "structural_late_shortage" || v.type === "structural_early_shortage")
      .map(v => v.date)
      .filter(d => d !== null)
  );
  for (const dateStr of structuralDates) {
    const dayNum = parseInt(dateStr.split("-")[2], 10);
    if (dayNum < 1 || dayNum > daysInMonth) continue;
    const col  = COL_DAY_OFFSET - 1 + (dayNum - 1); // 0-based
    const addr = XLSX.utils.encode_cell({ r: 3, c: col }); // 曜日行（行4、0-based=3）
    const cellEl = findOrCreateCell(doc, 4, col + 1, addr);
    const dow = DOW_LABELS[new Date(year, month - 1, dayNum).getDay()];
    setStringCell(doc, cellEl, dow + "★");
  }

  // 修正3: 構造的遅出不足が残った日をAM列（row4）に記入
  {
    const structuralLateViolations = (scheduleResult.violations || [])
      .filter(v => v.type === "structural_late_shortage" && v.date);
    if (structuralLateViolations.length > 0) {
      const parts = structuralLateViolations.map(v => {
        const dayNum  = parseInt(v.date.split("-")[2], 10);
        const shortage = 2 - (v.lateCount !== undefined ? v.lateCount : 0);
        return `${dayNum}日(${shortage}名不足)`;
      });
      const text    = `遅出不足：${parts.join("、")}`;
      const amCol0  = 38; // AM = 1-based col 39 → 0-based 38
      const amRow0  = 3;  // row 4 (1-based) → 0-based 3
      const amAddr  = XLSX.utils.encode_cell({ r: amRow0, c: amCol0 });
      const amCellEl = findOrCreateCell(doc, amRow0 + 1, amCol0 + 1, amAddr);
      setStringCell(doc, amCellEl, text);
    }
  }

  // ③ 変更した DOM を文字列にシリアライズ
  const serializer     = new XMLSerializer();
  const modifiedXml    = serializer.serializeToString(doc);

  // ④ 元の ZIP ファイルを直接パースしてエントリを取得し、sheet1.xml だけ差し替えて再構築
  return await buildOutputXlsx(_buffer, modifiedXml);
}

function downloadExcel(wbout, year, month) {
  const blob = new Blob([wbout], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = `勤務表_${year}${String(month).padStart(2, "0")}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ────────────────────────────────────────────────
// ZIP ユーティリティ
// ────────────────────────────────────────────────

// xlsxファイル（ZIP）から指定パスのファイルを展開して文字列で返す
async function extractFileFromXlsx(buffer, targetPath) {
  const entry = await extractZipEntry(buffer, targetPath);
  if (!entry) return null;
  return new TextDecoder().decode(entry);
}

// ZIP から全エントリを返す（key=パス, value={compData, method, crc, uncompSize}）
// 生の圧縮データを保持することで再圧縮コストを避ける
async function extractZipEntriesRaw(buffer) {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);
  const entries = new Map(); // name → {method, compData, crc, compSize, uncompSize}

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return entries;

  const cdCount  = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method     = view.getUint16(pos + 10, true);
    const crc        = view.getUint32(pos + 16, true);
    const compSize   = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen    = view.getUint16(pos + 28, true);
    const exLen      = view.getUint16(pos + 30, true);
    const cmtLen     = view.getUint16(pos + 32, true);
    const lhOff      = view.getUint32(pos + 42, true);
    const name       = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + exLen + cmtLen;

    const lhNameLen  = view.getUint16(lhOff + 26, true);
    const lhExtraLen = view.getUint16(lhOff + 28, true);
    const dataOff    = lhOff + 30 + lhNameLen + lhExtraLen;
    const compData   = new Uint8Array(bytes.buffer, dataOff, compSize);

    entries.set(name, { method, crc, compSize, uncompSize, compData: new Uint8Array(compData) });
  }
  return entries;
}

// 指定パスのエントリを展開して Uint8Array で返す（単ファイル取得用）
async function extractZipEntry(buffer, targetPath) {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const cdCount  = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method   = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen  = view.getUint16(pos + 28, true);
    const exLen    = view.getUint16(pos + 30, true);
    const cmtLen   = view.getUint16(pos + 32, true);
    const lhOff    = view.getUint32(pos + 42, true);
    const name     = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + exLen + cmtLen;

    if (name !== targetPath) continue;

    const lhNameLen  = view.getUint16(lhOff + 26, true);
    const lhExtraLen = view.getUint16(lhOff + 28, true);
    const dataOff    = lhOff + 30 + lhNameLen + lhExtraLen;
    const comp       = bytes.subarray(dataOff, dataOff + compSize);

    if (method === 0) return new Uint8Array(comp);
    if (method === 8) return await decompressDeflate(comp);
    return null;
  }
  return null;
}

async function decompressDeflate(comp) {
  const ds     = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const rdReader = ds.readable.getReader();
  const chunks = [];
  const pump = (async () => {
    for (;;) { const { done, value } = await rdReader.read(); if (done) break; chunks.push(value); }
  })();
  await writer.write(new Uint8Array(comp));
  await writer.close();
  await pump;
  return concatUint8Arrays(chunks);
}

async function compressDeflate(data) {
  const cs     = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  const rdReader = cs.readable.getReader();
  const chunks = [];
  const pump = (async () => {
    for (;;) { const { done, value } = await rdReader.read(); if (done) break; chunks.push(value); }
  })();
  await writer.write(data);
  await writer.close();
  await pump;
  return concatUint8Arrays(chunks);
}

function concatUint8Arrays(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out   = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// CRC32（ZIP用）
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ZIP を再構築して ArrayBuffer で返す
// entries: Map<name, {method, compData, crc, compSize, uncompSize}>
// overrides: Map<name, Uint8Array> （書き換えたいファイルの生バイト列、再圧縮される）
async function buildZip(entries, overrides) {
  const enc = new TextEncoder();
  const localParts = [];    // [Uint8Array, Uint8Array, ...]
  const cdEntries  = [];
  let   offset     = 0;

  for (const [name, orig] of entries) {
    const nameBytes = enc.encode(name);
    let method, compData, fileCrc, compSize, uncompSize;

    if (overrides && overrides.has(name)) {
      // 差し替えファイルを再圧縮
      const rawData  = overrides.get(name);
      const deflated = await compressDeflate(rawData);
      method     = 8;
      compData   = deflated.length < rawData.length ? deflated : rawData;
      method     = deflated.length < rawData.length ? 8 : 0;
      fileCrc    = crc32(rawData);
      compSize   = compData.length;
      uncompSize = rawData.length;
    } else {
      // 元の圧縮データをそのまま使用（再圧縮不要）
      method     = orig.method;
      compData   = orig.compData;
      fileCrc    = orig.crc;
      compSize   = orig.compSize;
      uncompSize = orig.uncompSize;
    }

    // Local File Header
    const lh  = new Uint8Array(30 + nameBytes.length);
    const lhv = new DataView(lh.buffer);
    lhv.setUint32(0, 0x04034b50, true); // signature
    lhv.setUint16(4, 20, true);          // version needed
    lhv.setUint16(6, 0, true);           // flags
    lhv.setUint16(8, method, true);      // compression method
    lhv.setUint16(10, 0, true);          // mod time
    lhv.setUint16(12, 0, true);          // mod date
    lhv.setUint32(14, fileCrc, true);    // CRC-32
    lhv.setUint32(18, compSize, true);   // compressed size
    lhv.setUint32(22, uncompSize, true); // uncompressed size
    lhv.setUint16(26, nameBytes.length, true);
    lhv.setUint16(28, 0, true);          // extra length
    lh.set(nameBytes, 30);
    localParts.push(lh, compData);

    // Central Directory record
    const cd  = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, fileCrc, true);
    cdv.setUint32(20, compSize, true);
    cdv.setUint32(24, uncompSize, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra
    cdv.setUint16(32, 0, true); // comment
    cdv.setUint16(34, 0, true); // disk number start
    cdv.setUint16(36, 0, true); // internal attributes
    cdv.setUint32(38, 0, true); // external attributes
    cdv.setUint32(42, offset, true); // local header offset
    cd.set(nameBytes, 46);
    cdEntries.push(cd);

    offset += lh.length + compData.length;
  }

  // End of Central Directory
  const cdOffset = offset;
  const cdTotal  = cdEntries.reduce((s, c) => s + c.length, 0);
  const eocd     = new Uint8Array(22);
  const eocdv    = new DataView(eocd.buffer);
  eocdv.setUint32(0, 0x06054b50, true);
  eocdv.setUint16(4, 0, true);
  eocdv.setUint16(6, 0, true);
  eocdv.setUint16(8, entries.size, true);
  eocdv.setUint16(10, entries.size, true);
  eocdv.setUint32(12, cdTotal, true);
  eocdv.setUint32(16, cdOffset, true);
  eocdv.setUint16(20, 0, true);

  const all = [...localParts, ...cdEntries, eocd];
  return concatUint8Arrays(all).buffer;
}

// 元の ZIP から全エントリを読み、sheet1.xml だけ置き換えて新しい ZIP を返す
async function buildOutputXlsx(originalBuffer, modifiedSheetXml) {
  const entries   = await extractZipEntriesRaw(originalBuffer);
  // calcChain.xml はキャッシュされた計算結果。シートを編集すると古い値のまま残るため削除し、
  // Excel起動時に全セルを自動再計算させる。
  entries.delete("xl/calcChain.xml");
  const overrides = new Map();
  overrides.set("xl/worksheets/sheet1.xml", new TextEncoder().encode(modifiedSheetXml));

  // workbook.xml に fullCalcOnLoad="1" を追加して開いた時に全数式を強制再計算させる。
  // calcChain.xml を削除しただけでは <v> のキャッシュ値が残り Excel が古い値を表示するケースがあるため。
  const wbXml = await extractFileFromXlsx(originalBuffer, "xl/workbook.xml");
  if (wbXml) {
    const modifiedWb = wbXml.replace(/<calcPr\b([^>]*?)\s*\/?>/, (_m, attrs) => {
      if (/fullCalcOnLoad/.test(attrs)) return _m;
      return `<calcPr${attrs} fullCalcOnLoad="1"/>`;
    });
    overrides.set("xl/workbook.xml", new TextEncoder().encode(modifiedWb));
  }

  return buildZip(entries, overrides);
}

// ────────────────────────────────────────────────
// XML セル操作ユーティリティ
// ────────────────────────────────────────────────

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

// 指定行・列のセル要素を返す。存在しなければ行を探してセルを挿入する。
// rowNum, colNum: 1-based
// addr: "A1" 形式のセルアドレス
function findOrCreateCell(doc, rowNum, colNum, addr) {
  // 行要素を探す
  const rows = doc.getElementsByTagName("row");
  let rowEl  = null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute("r") === String(rowNum)) { rowEl = rows[i]; break; }
  }
  if (!rowEl) {
    // 行が存在しない場合は新規作成して挿入
    rowEl = doc.createElementNS(SHEET_NS, "row");
    rowEl.setAttribute("r", String(rowNum));
    const sheetData = doc.getElementsByTagName("sheetData")[0];
    // rowNum より大きい行の前に挿入
    let inserted = false;
    for (let i = 0; i < rows.length; i++) {
      if (parseInt(rows[i].getAttribute("r"), 10) > rowNum) {
        sheetData.insertBefore(rowEl, rows[i]);
        inserted = true;
        break;
      }
    }
    if (!inserted) sheetData.appendChild(rowEl);
  }

  // セル要素を探す
  const cells = rowEl.getElementsByTagName("c");
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].getAttribute("r") === addr) return cells[i];
  }

  // セルが存在しない → 列順で挿入
  const newCell = doc.createElementNS(SHEET_NS, "c");
  newCell.setAttribute("r", addr);
  let insertBefore = null;
  for (let i = 0; i < cells.length; i++) {
    if (colOrder(cells[i].getAttribute("r")) > colOrder(addr)) {
      insertBefore = cells[i];
      break;
    }
  }
  if (insertBefore) rowEl.insertBefore(newCell, insertBefore);
  else               rowEl.appendChild(newCell);
  return newCell;
}

// セルアドレスの列番号（数値）を返す（挿入位置ソート用）
function colOrder(addr) {
  const m = addr.match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// セルに数値を設定する
function setNumericCell(doc, cellEl, value) {
  cellEl.removeAttribute("t"); // numeric は t なし
  // <f>（数式）があれば削除 — 残存すると data_only=False 読み込み時に値が取れない
  const fEls = cellEl.getElementsByTagName("f");
  while (fEls.length > 0) cellEl.removeChild(fEls[0]);
  // 既存の <v> を探すか新規作成
  let v = cellEl.getElementsByTagName("v")[0];
  if (!v) { v = doc.createElementNS(SHEET_NS, "v"); cellEl.appendChild(v); }
  // inline string 用の <is> があれば削除
  const isEls = cellEl.getElementsByTagName("is");
  while (isEls.length > 0) cellEl.removeChild(isEls[0]);
  v.textContent = String(value);
}

// セルに文字列（inline string）を設定する
function setStringCell(doc, cellEl, value) {
  cellEl.setAttribute("t", "str");
  // <f>（数式）があれば削除
  const fEls = cellEl.getElementsByTagName("f");
  while (fEls.length > 0) cellEl.removeChild(fEls[0]);
  // <is> 要素があれば削除
  const isEls = cellEl.getElementsByTagName("is");
  while (isEls.length > 0) cellEl.removeChild(isEls[0]);
  // <v> を探すか新規作成
  let v = cellEl.getElementsByTagName("v")[0];
  if (!v) { v = doc.createElementNS(SHEET_NS, "v"); cellEl.appendChild(v); }
  v.textContent = value;
}

// ────────────────────────────────────────────────
// スタイル情報の構築
// ────────────────────────────────────────────────

function buildStyleInfo(wb, sheetXml) {
  const redXfSet     = new Set();
  const orangeXfSet  = new Set();
  const cellStyleMap = new Map();

  if (wb.Styles && wb.Styles.CellXf) {
    const fonts = wb.Styles.Fonts || [];
    const fills = wb.Styles.Fills || [];

    // 赤フォントのFontインデックスを特定
    const redFontIds = new Set();
    fonts.forEach((f, i) => {
      if (!f || !f.color) return;
      const rgb = (f.color.rgb || "").toUpperCase().replace(/^FF(?=[0-9A-F]{6}$)/, "");
      if (rgb === "FF0000") redFontIds.add(i);
    });

    // オレンジ系背景フィルのFillインデックスを特定
    const orangeFillIds = new Set();
    fills.forEach((fill, i) => {
      if (!fill || !fill.fgColor) return;
      const rgb = (fill.fgColor.rgb || "").toUpperCase();
      if (/^FF[A-F0-9]{2}[3-8][0-9A-F]00$/i.test(rgb) || rgb === "FFFFA500") {
        orangeFillIds.add(i);
      }
    });

    wb.Styles.CellXf.forEach((xf, i) => {
      if (!xf) return;
      if (redFontIds.has(xf.fontId))    redXfSet.add(i);
      if (orangeFillIds.has(xf.fillId)) orangeXfSet.add(i);
    });
  }

  // シートXMLをパースしてセルアドレス→スタイルインデックスのMapを構築
  if (sheetXml) {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(sheetXml, "application/xml");
    const cells  = doc.getElementsByTagName("c");
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const addr = cell.getAttribute("r");
      const s    = cell.getAttribute("s");
      if (addr && s !== null) cellStyleMap.set(addr, parseInt(s, 10));
    }
  }

  return { redXfSet, orangeXfSet, cellStyleMap };
}

// ────────────────────────────────────────────────
// シートのパース
// ────────────────────────────────────────────────

function parseScheduleSheet(wb, redXfSet, orangeXfSet, cellStyleMap) {
  const ws = wb.Sheets["Sheet1"];
  if (!ws) throw new Error("Sheet1が見つかりません");

  const range   = XLSX.utils.decode_range(ws["!ref"]);
  const maxRow  = range.e.r + 1;

  const yearMonthCell = ws[XLSX.utils.encode_cell({ r: 0, c: 1 })];
  let year = null, month = null;
  if (yearMonthCell && yearMonthCell.v instanceof Date) {
    year  = yearMonthCell.v.getFullYear();
    month = yearMonthCell.v.getMonth() + 1;
  } else if (yearMonthCell) {
    const d = XLSX.SSF.parse_date_code(yearMonthCell.v);
    if (d) { year = d.y; month = d.m; }
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const holidays    = getJapaneseHolidays(year); // 休園日判定用
  const staffShifts = {};

  for (let r = ROW_STAFF_OFFSET - 1; r < maxRow; r++) {
    const idCell = ws[XLSX.utils.encode_cell({ r, c: COL_STAFF_ID - 1 })];
    if (!idCell || typeof idCell.v !== "number") continue;

    const staffId = idCell.v;
    staffShifts[staffId] = {};

    for (let d = 1; d <= daysInMonth; d++) {
      const col      = COL_DAY_OFFSET - 1 + (d - 1);
      const cellAddr = XLSX.utils.encode_cell({ r, c: col });
      const cell     = ws[cellAddr];
      const dateStr  = toDateStr(new Date(year, month - 1, d));
      const isClosed = isClosedDay(dateStr, holidays);

      let shiftCode = null;
      let isFixed   = false;
      let isAbsent  = false;

      if (cell) {
        shiftCode = cell.v !== undefined ? String(cell.v) : null;

        // cellStyleMapから生の CellXf インデックスを取得して判定
        const sIdx = cellStyleMap ? (cellStyleMap.get(cellAddr) ?? -1) : -1;

        // 赤フォントでも値がないセルは「固定」扱いにしない（空欄＝未確定として自動割当対象にする）
        if (sIdx >= 0 && redXfSet && redXfSet.has(sIdx) && shiftCode !== null) isFixed = true;
        if (staffId === 9 && sIdx >= 0 && orangeXfSet && orangeXfSet.has(sIdx)) {
          isAbsent  = true;
          shiftCode = null;
        }
      }

      // 稼働日の非固定セルはクリア（スケジューラが再割当）
      // 休園日は非固定でも値を保持（公休数カウントに必要 + 出力でも保持される）
      if (!isFixed && !isClosed) shiftCode = null;

      staffShifts[staffId][dateStr] = { shiftCode, isFixed, isAbsent };
    }
  }

  return { year, month, daysInMonth, staffShifts };
}
