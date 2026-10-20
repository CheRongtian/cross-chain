import { createSearchController, queryErrorText } from "./client.js";
import { messageIdFromURL, messageURL, normalizeMessageId } from "./view-model.js";
import { renderMessageView } from "./render.js";

const input = document.getElementById("message-id");
const target = document.getElementById("message-view");
const status = document.getElementById("search-status");
const controller = createSearchController({ onState(value) {
  target.setAttribute("aria-busy", value.state === "loading" ? "true" : "false");
  input.setAttribute("aria-invalid", value.state === "invalid" ? "true" : "false");
  if (value.state === "ready") {
    renderMessageView(document, target, value.view);
    status.textContent = `Message loaded. Current observation: ${value.view.status}.`;
  } else { target.replaceChildren(); status.textContent = value.message; }
} });
function search() {
  try {
    const id = normalizeMessageId(input.value); input.value = id;
    history.pushState(null, "", messageURL(location.href, id));
  } catch { /* The controller reports a fixed, accessible validation error. */ }
  return controller.search(input.value);
}
function loadURL() {
  controller.cancel();
  try {
    const id = messageIdFromURL(location.href);
    if (id) { input.value = id; void controller.search(id); }
    else { input.value = ""; input.setAttribute("aria-invalid", "false"); target.removeAttribute("aria-busy"); target.replaceChildren();
      status.textContent = "Enter a canonical cross-chain message ID to inspect its lifecycle."; }
  } catch {
    input.value = new URL(location.href).searchParams.get("messageId") ?? "";
    input.setAttribute("aria-invalid", "true"); target.removeAttribute("aria-busy"); target.replaceChildren(); status.textContent = queryErrorText(400);
  }
}
document.getElementById("message-search").addEventListener("submit", event => { event.preventDefault(); void search(); });
document.getElementById("refresh").addEventListener("click", () => { void search(); });
window.addEventListener("popstate", loadURL);
window.addEventListener("pagehide", () => controller.cancel());
loadURL();
