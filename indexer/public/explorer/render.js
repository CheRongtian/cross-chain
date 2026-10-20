// Every data-bearing value reaches the DOM as textContent. No protocol data is
// interpreted as markup, a URL, an event handler or a CSS class.
export function renderMessageView(document, target, view) {
  const node = (tag, value, className) => {
    const result = document.createElement(tag);
    if (value != null) result.textContent = String(value);
    if (className) result.className = className;
    return result;
  };
  function fields(values = []) {
    const result = node("dl");
    for (const value of values) {
      const row = node("div", null, "datum");
      row.append(node("dt", value.label), node("dd", value.value, "hash")); result.append(row);
    }
    return result;
  }
  function content(parent, value) {
    parent.append(fields(value.fields));
    for (const record of value.records ?? []) {
      const item = node("article", null, "record"); item.append(node("h3", record.title));
      if (record.status) item.append(node("p", record.status, "badge"));
      content(item, record); parent.append(item);
    }
    for (const detail of value.details ?? []) {
      const item = node("details"); item.append(node("summary", detail.title)); content(item, detail); parent.append(item);
    }
    if (value.note) parent.append(node("p", value.note, "note"));
  }
  const overview = node("section", null, "overview");
  overview.append(node("h2", "Message Overview"), node("code", view.messageId, "message-hash"), node("p", view.status, "badge"),
    node("p", `API observation: ${view.observedAt}`, "hint"), fields(view.summary));
  const timeline = node("nav", null, "timeline"); timeline.setAttribute("aria-label", "Observed message lifecycle");
  const steps = node("ol");
  const states = new Set(["complete", "current", "pending", "historical", "failed", "reorged", "not-reached"]);
  for (const step of view.timeline) {
    const item = node("li", null, states.has(step.state) ? step.state : "pending");
    item.append(node("strong", step.label), node("small", step.status)); steps.append(item);
  }
  timeline.append(steps);
  const grid = node("div", null, "grid");
  for (const value of view.sections) {
    const panel = node("section", null, ["votes", "attempts", "source"].includes(value.id) ? "panel wide" : "panel");
    const head = node("div", null, "section-head"); head.append(node("h2", value.title), node("span", value.status, "badge"));
    panel.append(head); content(panel, value); grid.append(panel);
  }
  target.replaceChildren(overview, timeline, grid);
}
