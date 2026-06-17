// 日本の祝日判定
// ハッピーマンデー・振替休日を含む計算ベース実装

function getJapaneseHolidays(year) {
  const holidays = new Set();

  const add = (m, d) => holidays.add(`${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);

  // 固定祝日
  add(1,  1);  // 元日
  add(2,  11); // 建国記念の日
  add(2,  23); // 天皇誕生日
  add(4,  29); // 昭和の日
  add(5,  3);  // 憲法記念日
  add(5,  4);  // みどりの日
  add(5,  5);  // こどもの日
  add(8,  11); // 山の日
  add(11, 3);  // 文化の日
  add(11, 23); // 勤労感謝の日

  // ハッピーマンデー
  const nthMonday = (m, n) => {
    const d = new Date(year, m - 1, 1);
    let count = 0;
    while (true) {
      if (d.getDay() === 1) { count++; if (count === n) return d.getDate(); }
      d.setDate(d.getDate() + 1);
    }
  };
  add(1,  nthMonday(1, 2));  // 成人の日（1月第2月曜）
  add(7,  nthMonday(7, 3));  // 海の日（7月第3月曜）
  add(9,  nthMonday(9, 3));  // 敬老の日（9月第3月曜）
  add(10, nthMonday(10, 2)); // スポーツの日（10月第2月曜）

  // 春分の日・秋分の日（概算式）
  const shunbun = Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  const shubun  = Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  add(3, shunbun);
  add(9, shubun);

  // 振替休日：祝日が日曜なら翌月曜（祝日が連続する場合は次の平日）
  const sorted = [...holidays].sort();
  for (const dateStr of sorted) {
    const d = new Date(dateStr);
    if (d.getDay() === 0) {
      let next = new Date(d);
      next.setDate(next.getDate() + 1);
      while (holidays.has(toDateStr(next))) next.setDate(next.getDate() + 1);
      holidays.add(toDateStr(next));
    }
  }

  // 国民の休日（祝日に挟まれた平日）
  for (let m = 1; m <= 12; m++) {
    const days = new Date(year, m, 0).getDate();
    for (let day = 2; day < days; day++) {
      const prev = `${year}-${String(m).padStart(2,'0')}-${String(day-1).padStart(2,'0')}`;
      const cur  = `${year}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const next = `${year}-${String(m).padStart(2,'0')}-${String(day+1).padStart(2,'0')}`;
      const d = new Date(cur);
      if (holidays.has(prev) && holidays.has(next) && !holidays.has(cur) && d.getDay() !== 0) {
        holidays.add(cur);
      }
    }
  }

  return holidays;
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 休園日かどうか（日曜 or 祝日 or 12/31〜1/3）
function isClosedDay(dateStr, holidaySet) {
  const d = new Date(dateStr);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (d.getDay() === 0) return true;
  if (holidaySet.has(dateStr)) return true;
  if ((m === 12 && day === 31) || (m === 1 && (day === 1 || day === 2 || day === 3))) return true;
  return false;
}
