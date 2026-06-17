// UIの制御

let parsedData = null;

document.getElementById("input-excel").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    parsedData = await loadExcel(file);
    document.getElementById("upload-status").textContent =
      `読み込み完了：${parsedData.year}年${parsedData.month}月（${parsedData.daysInMonth}日間）`;
    document.getElementById("btn-run").disabled = false;
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
