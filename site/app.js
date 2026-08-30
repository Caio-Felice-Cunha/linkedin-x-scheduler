const summary = document.querySelector('#summary');
const items = document.querySelector('#items');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

fetch('./demo-report.json')
  .then((response) => {
    if (!response.ok) throw new Error('report returned ' + response.status);
    return response.json();
  })
  .then((report) => {
    summary.replaceChildren(
      element('strong', '', report.summary.complete + '/' + report.summary.total),
      element('span', '', 'simulated · ' + report.summary.externalWrites + ' external writes'),
    );
    items.replaceChildren();
    report.items.forEach((item) => {
      const article = element('article');
      const head = element('div', 'item-head');
      const platform = element('span', 'platform ' + String(item.platform).replace(/[^a-z-]/gi, ''), item.platform);
      const titleGroup = element('div');
      titleGroup.append(element('h3', '', item.id), element('p', '', item.kind + ' · ' + item.scheduledAt));
      head.append(platform, titleGroup, element('b', '', item.status));
      const steps = element('ol');
      item.steps.forEach((step) => {
        const row = element('li');
        row.append(element('span', '', String(step.id).padStart(2, '0')), document.createTextNode(String(step.label)), element('b', '', '✓'));
        steps.append(row);
      });
      article.append(head, steps);
      items.append(article);
    });
  })
  .catch((error) => {
    summary.textContent = 'Report unavailable: ' + error.message;
  });
