const summary = document.querySelector('#summary');
const items = document.querySelector('#items');

fetch('./demo-report.json')
  .then((response) => {
    if (!response.ok) throw new Error(`report returned ${response.status}`);
    return response.json();
  })
  .then((report) => {
    summary.innerHTML = `<strong>${report.summary.complete}/${report.summary.total}</strong><span>simulated · ${report.summary.externalWrites} external writes</span>`;
    items.innerHTML = report.items.map((item) => `<article><div class="item-head"><span class="platform ${item.platform}">${item.platform}</span><div><h3>${item.id}</h3><p>${item.kind} · ${item.scheduledAt}</p></div><b>${item.status}</b></div><ol>${item.steps.map((step) => `<li><span>${String(step.id).padStart(2, '0')}</span>${step.label}<b>✓</b></li>`).join('')}</ol></article>`).join('');
  })
  .catch((error) => {
    summary.textContent = `Report unavailable: ${error.message}`;
  });
