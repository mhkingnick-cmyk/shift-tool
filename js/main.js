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

function getMedicalCareParams() {
  // TODO: UIから医療的ケア児パラメータを収集
  return [];
}
