import { sendEmail, mailConfigured } from './mailer.js';
import { esc } from '../lib/htmlEscape.js';

// Warm welcome sent by US (not Supabase) once an invited staff member has confirmed +
// set their password — see the first-load trigger in GET /api/baker/profile. Best-effort
// (the send is fire-and-forget; the DB flag is already claimed before we get here).
export async function sendStaffWelcomeEmail({ staff, baker }) {
  if (!mailConfigured()) return;
  if (!staff?.email) return;

  const name = esc(staff.first_name || 'there');
  const bakery = esc(baker?.name || 'your bakery');
  await sendEmail({
    to:      staff.email,
    subject: `Welcome to ${baker?.name || 'your bakery'} on Spattoo 🎂`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Welcome, ${name}!</h2>
        <p>You've been added to the team at <b>${bakery}</b> on Spattoo.</p>
        <p>Sign in any time using the <b>Staff</b> tab with your email — you can help manage
           orders, customers and cake designs.</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>
    `,
  });
}
