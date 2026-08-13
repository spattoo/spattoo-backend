// SEC-3: escape user/tenant-controlled values before interpolating into email HTML, so a
// name/note/url can't inject markup (phishing links, tracking pixels, layout hijack) into the
// recipient's inbox. Shared by every email builder (sendNotification.js, services/email.js) —
// one copy, previously duplicated per file.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// URL-safe escaping for href/src attributes: escapes AND allowlists the scheme — only absolute
// http(s) URLs pass, so an injected `javascript:`/`data:` value can never reach an attribute
// (anything else yields '' → the attribute renders empty instead of executing).
export function escUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  return esc(s);
}
