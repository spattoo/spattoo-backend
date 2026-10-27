/* ── Handing a question to a person ──────────────────────────────────────────────────────────────
 *
 * Sandeep: *"lets build that escalation. should we just send email to the person? thats a good
 * starting point … for now, email."*
 *
 * ⚠️ NOTHING HERE FIRES ON ITS OWN. The baker presses a button, every time. We already LOG every
 * question and whether it landed (migration 143) — that is us, silently, deciding what to write
 * next. This is the baker asking a person, and it expects a reply. Auto-emailing on a miss would
 * mail somebody about questions the baker went on to answer themselves, and an inbox of requests
 * nobody is waiting on is one that stops being read — including the day a real one arrives.
 *
 * ⚠️ THE REPLY GOES TO THE BAKER, NOT TO US. The mail is FROM Spattoo's own address, because SPF
 * means it has to be, but Reply-To is the baker. Whoever picks it up presses reply and is talking
 * to them. Without that, answering means copying an address out of the body by hand, and a hand-off
 * that costs a manual step is one that happens late.
 */

import { config } from '../config.js';
import { supabase } from './supabase.js';
import { sendEmail } from './mailer.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* What the assistant put in front of them, in the order it showed them. Whoever replies needs this
   more than anything else in the mail: "we showed you the Tiers article" changes the answer from
   scratch into a correction. */
function shownBlock(q) {
  if (!q?.top_doc_slug) return '<p><em>The assistant found nothing above its answer floor.</em></p>';
  const score = q.top_score == null ? '' : ` (${Number(q.top_score).toFixed(3)})`;
  return `<p><strong>What the assistant showed:</strong><br />`
       + `${esc(q.top_doc_slug)}${q.top_heading ? ` &rsaquo; ${esc(q.top_heading)}` : ''}${score}<br />`
       + `<span style="color:#777">${q.result_count} result(s); `
       + `${q.helpful === false ? 'the baker said it did not answer them' : 'no verdict given'}</span></p>`;
}

/**
 * Emails the team about one question, and records that it happened.
 *
 * Returns `{ ok, alreadySent }`. Never throws: the baker pressed a button, and an error over that
 * press teaches them not to press it again — the row is written either way so the request is not
 * lost when SMTP is.
 */
export async function escalateQuestion({ id, userId, note = '', baker = null, bakerEmail = null }) {
  try {
    if (!id || !userId) return { ok: false, alreadySent: false };

    /* Scoped to the asker, like the verdict is: the id travels to the browser and back, so without
       this anybody holding one could raise a ticket in somebody else's name. */
    const { data: q } = await supabase
      .from('help_questions')
      .select('id, question, result_count, top_score, top_doc_slug, top_heading, helpful, escalated_at')
      .eq('id', id).eq('user_id', userId).maybeSingle();
    if (!q) return { ok: false, alreadySent: false };

    /* One per question. Asking again is a new row and can be escalated on its own, so a baker can
       chase without the same question arriving twice. */
    if (q.escalated_at) return { ok: true, alreadySent: true };

    const trimmed = String(note ?? '').slice(0, 2000).trim();
    const to = config.smtp.helpEscalationTo;
    let delivery = null;

    if (to?.length) {
      const html = [
        `<p style="font-size:15px"><strong>A baker asked for a person.</strong></p>`,
        `<p style="font-size:17px;margin:14px 0"><strong>&ldquo;${esc(q.question)}&rdquo;</strong></p>`,
        trimmed ? `<p><strong>They added:</strong><br />${esc(trimmed).replace(/\n/g, '<br />')}</p>` : '',
        shownBlock(q),
        `<p><strong>Who:</strong> ${esc(baker?.bakery_name ?? baker?.name ?? 'a baker')}`
          + `${bakerEmail ? ` &lt;${esc(bakerEmail)}&gt;` : ''}</p>`,
        bakerEmail
          ? `<p style="color:#777;font-size:13px">Reply to this email and it goes straight to them.</p>`
          : `<p style="color:#b45309;font-size:13px">No email on file for this baker — reply-to is not set.</p>`,
      ].filter(Boolean).join('\n');

      try {
        await sendEmail({
          to: to.join(', '),
          subject: `Help: "${String(q.question).slice(0, 80)}"`,
          html,
          /* ⚠️ Only when we have one. An invalid Reply-To is worse than none: the reply bounces
             instead of landing somewhere a person can act on it. */
          ...(bakerEmail ? { replyTo: bakerEmail } : {}),
        });
        delivery = 'sent';
      } catch (err) {
        console.error('[help] escalation email failed:', err.message);
        delivery = 'failed';
      }
    }

    /* ⚠️ RECORDED EVEN WHEN THE SEND FAILED, and that is the point of keeping the two columns
       apart. The baker asked the moment they pressed; whether our SMTP accepted it is our problem,
       and writing only on success would lose the request precisely when it needs chasing. */
    await supabase.from('help_questions')
      .update({ escalated_at: new Date().toISOString(), escalation_note: trimmed || null, escalation_delivery: delivery })
      .eq('id', id).eq('user_id', userId);

    return { ok: true, alreadySent: false };
  } catch (err) {
    console.error('[help] escalation failed:', err.message);
    return { ok: false, alreadySent: false };
  }
}
