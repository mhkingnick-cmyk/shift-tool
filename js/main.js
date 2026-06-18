// UIの制御

let parsedData = null;

document.getElementById("input-excel").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    parsedData = await loadExcel(file);
    const { year, month, daysInMonth } = parsedData;
    document.getElementById("upload-status").textContent =
      `読み込み完了：${year}年${month}月（${daysInMonth}日間）`;
    document.getElementById("btn-run").disabled = false;
    updateHolidayHint(year, month, daysInMonth);

  } catch (err) {
    document.getElementById("upload-status").textContent = "エラー：" + err.message;
  }
});

document.getElementById("btn-run").addEventListener("click", () => {
  if (!parsedData) return;

  const params = {
    holidayCount: parseInt(document.getElementById("param-holiday-count").value, 10),
    medicalCareChildren: getMedicalCareParams(),
  };

  const result = runScheduler(parsedData, params);

  // エラー表示
  const errSection = document.getElementById("section-errors");
  const errList    = document.getElementById("error-list");
  errList.innerHTML = "";
  if (result.violations.length > 0) {
    result.violations.forEach(v => {
      const li = document.createElement("li");
      li.textContent = v.message;
      errList.appendChild(li);
    });
    errSection.style.display = "block";
  } else {
    errSection.style.display = "none";
  }

  // ダウンロードボタン表示
  document.getElementById("section-download").style.display = "block";
  document.getElementById("btn-download").onclick = () => {
    const wbout = writeExcel(result);
    downloadExcel(wbout, result.year, result.month);
  };
});

// 「稼働日に割り当てる公休 = 総公休 − 休園日数」をリアルタイム表示
function updateHolidayHint(year, month, daysInMonth) {
  const holidays = getJapaneseHolidays(year);
  let closedCount = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (isClosedDay(ds, holidays)) closedCount++;
  }
  const total = parseInt(document.getElementById("param-holiday-count").value, 10) || 0;
  const workday = Math.max(0, total - closedCount);
  document.getElementById("holiday-calc-hint").textContent =
    `（休園日 ${closedCount} 日 → 稼働日に割当: ${workday} 日）`;
}

// 公休日数欄を変更したときもヒントを更新
document.getElementById("param-holiday-count").addEventListener("input", () => {
  if (parsedData) {
    const { year, month, daysInMonth } = parsedData;
    updateHolidayHint(year, month, daysInMonth);
  }
});

// ────────────────────────────────────────────────
// 医療的ケア児UI
// ────────────────────────────────────────────────
let _medicalCareCount = 0;

document.getElementById("btn-add-medical-care").addEventListener("click", () => {
  _medicalCareCount++;
  const id  = _medicalCareCount;
  const list = document.getElementById("medical-care-list");
  const row  = document.createElement("div");
  row.className   = "medical-care-row";
  row.dataset.mcId = id;

  const weekdays = [["月", 1], ["火", 2], ["水", 3], ["木", 4], ["金", 5], ["土", 6]];
  const cbHtml = weekdays.map(([label, val]) =>
    `<label><input type="checkbox" name="mc-wd-${id}" value="${val}"> ${label}</label>`
  ).join(" ");

  row.innerHTML = `
    <span class="mc-label">曜日：</span>${cbHtml}
    <span class="mc-label">時間：</span>
    <input type="time" class="mc-start" value="10:00">
    〜
    <input type="time" class="mc-end" value="14:00">
    <button class="mc-remove" onclick="this.closest('.medical-care-row').remove()">削除</button>
  `;
  list.appendChild(row);
});

function getMedicalCareParams() {
  const rows   = document.querySelectorAll(".medical-care-row");
  const result = [];
  for (const row of rows) {
    const weekdays = [...row.querySelectorAll("input[type=checkbox]:checked")]
      .map(cb => Number(cb.value));
    if (weekdays.length === 0) continue;
    const startVal = row.querySelector(".mc-start").value;
    const endVal   = row.querySelector(".mc-end").value;
    if (!startVal || !endVal) continue;
    const [startH, startM] = startVal.split(":").map(Number);
    const [endH,   endM  ] = endVal.split(":").map(Number);
    result.push({ weekdays, startH, startM, endH, endM });
  }
  return result;
}
